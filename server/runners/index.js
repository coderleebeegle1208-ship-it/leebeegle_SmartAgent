// Runner manager: one live process per agent, status bookkeeping, push on completion,
// and the automatic "triage → plan (Fable) → execute (Sonnet)" pipeline.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';
import { AgentSessions, Agents, Messages, Workspaces } from '../db.js';
import { emit } from '../bus.js';
import { sendPush } from '../push.js';
import { expireApprovals } from '../approvals.js';
import { runClaude, runClaudeOnce, runClaudeOnceText } from './claude.js';
import { findCodexEntry, runCodex } from './codex.js';
import { planPhase } from '../state.js';
import { modelLabel } from '../models.js';
import { gitSummary } from '../git.js';
import { buildReviewPrompt, buildRevisionPrompt, compactConversation, formatGitManifest, otherProvider } from '../collaboration.js';
import { normalizeCodexUsage, summarizeRun, usageHeadline } from '../tokens.js';

const live = new Map(); // agentId -> { child, cancelled }
const usageAcc = new Map(); // agentId -> stage usage rows for the run in progress
const KIND_LABEL = { claude: 'Claude', codex: 'Codex' };
const STAGE_LABEL = { implement: '구현', review: '교차 리뷰', revise: '최종 수정' };
const EFFORT_LABEL = { low: '낮음', medium: '중간', high: '높음', xhigh: '매우 높음', max: '최대' };

// Per-stage effort: the plan stage always gets at least 'high'; execution follows the CLI default unless set.
export function stageEfforts(agent) {
  return { plan: agent.plan_effort || 'high', exec: agent.exec_effort || null };
}
function withEffort(model, effort) {
  const name = modelLabel(model);
  return effort ? `${name} (강도 ${EFFORT_LABEL[effort] || effort})` : name;
}

/** Remembers the concrete model id the CLI reported, so the UI can show what an alias resolved to. */
function recordResolvedModel(agentId, stage, modelId) {
  if (!stage || !modelId) return;
  const agent = Agents.get(agentId);
  if (!agent) return;
  let map = {};
  try { map = agent.resolved_models ? JSON.parse(agent.resolved_models) : {}; } catch {}
  if (map[stage] === modelId) return;
  map[stage] = modelId;
  update(agentId, { resolved_models: JSON.stringify(map) });
}

export function isRunning(agentId) {
  return live.has(agentId);
}
export function runningIds() {
  return [...live.keys()];
}

function note(agentId, text) {
  const m = Messages.add(agentId, 'system', text);
  emit('message', { agent_id: agentId, message: m });
}
function pushUsage(agentId, row) {
  if (!usageAcc.has(agentId)) usageAcc.set(agentId, []);
  usageAcc.get(agentId).push(row);
}
/** Rolls up this run's stage usage into one message, comparing against the plan model as a
 * single-model baseline for auto-pipeline agents. Call once per run, right before it settles. */
function flushUsage(agentId) {
  const stages = usageAcc.get(agentId);
  usageAcc.delete(agentId);
  if (!stages || !stages.length) return;
  const agent = Agents.get(agentId);
  if (!agent) return;
  const baselineModel = agent.pipeline === 'auto' && stages.length > 1 ? agent.plan_model : null;
  const summary = summarizeRun(stages, baselineModel);
  const m = Messages.add(agentId, 'usage', usageHeadline(summary), summary);
  emit('message', { agent_id: agentId, message: m });
}
function update(agentId, fields) {
  const a = Agents.update(agentId, fields);
  emit('agent.updated', { agent: a });
  return a;
}
function push(agent, title, body) {
  sendPush({ title: `${agent.name} · ${title}`, body: (body || '').replace(/\s+/g, ' ').slice(0, 180), url: `/?agent=${agent.id}`, tag: `agent-${agent.id}` }).catch(() => {});
}

/** Runs one Claude/Codex turn and resolves with the result summary when the process exits. */
function runTurn(agentId, text, cfg, opts = {}) {
  return new Promise((resolve) => {
    const agent = Agents.get(agentId);
    if (!agent) throw new Error('agent not found');
    const workspace = Workspaces.get(agent.workspace_id);
    if (!workspace) throw new Error('workspace not found');
    const provider = opts.kind || agent.kind;
    let savedSession = AgentSessions.get(agentId, provider)?.session_id || null;
    if (!savedSession && provider === agent.kind && agent.session_id) {
      AgentSessions.upsert(agentId, provider, agent.session_id);
      savedSession = agent.session_id;
    }
    // A one-off run (the planner) starts a fresh session and must not become the agent's session.
    if (opts.fresh) savedSession = null;
    // First turn after 대화 정리: hand the summary to the new session, then forget it.
    if (!opts.fresh && !savedSession && agent.carry_note) {
      text = `[이전 대화 요약 · 이어서 진행]\n${agent.carry_note}\n\n${text}`;
      Agents.update(agentId, { carry_note: null });
    }
    const runtimeModel = Object.hasOwn(opts, 'model') ? opts.model : provider === 'codex' ? null : agent.model;
    const runtimeAgent = { ...agent, kind: provider, session_id: savedSession, model: runtimeModel };
    let result = null;
    let resolvedModel = null;
    let usageRow = null;
    const hooks = {
      onLog: (line) => console.log(`[agent ${agentId}] ${line}`),
      onSession: (sessionId, info) => {
        if (info?.model) {
          resolvedModel = info.model;
          recordResolvedModel(agentId, opts.stage, info.model);
        }
        if (!sessionId || opts.fresh) return;
        AgentSessions.upsert(agentId, provider, sessionId);
        const current = Agents.get(agentId);
        if (current?.kind === provider && sessionId !== current.session_id) update(agentId, { session_id: sessionId });
      },
      onMessage: (role, content, meta) => {
        if (!Agents.get(agentId)) return;
        const m = Messages.add(agentId, role, content, { ...(meta || {}), provider, ...(opts.phase ? { phase: opts.phase } : {}) });
        emit('message', { agent_id: agentId, message: m });
      },
      onResult: (r) => {
        result = { ...r, provider, ...(opts.phase ? { phase: opts.phase } : {}) };
        const usage = provider === 'codex' ? (r.usage ? normalizeCodexUsage(r.usage) : null) : r.usage;
        const hasTokens = usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite);
        if (hasTokens) {
          if (usageRow) {
            // Same process reported again: tokens are per segment, cost is the running total.
            usageRow.input += usage.input || 0;
            usageRow.output += usage.output || 0;
            usageRow.cacheRead += usage.cacheRead || 0;
            usageRow.cacheWrite += usage.cacheWrite || 0;
            if (usage.cost != null) usageRow.cost = usage.cost;
          } else {
            usageRow = {
              stage: opts.stage || 'manual',
              phase: opts.phase || null,
              provider,
              model: resolvedModel || r.model || opts.model || null,   // init event names the main model
              ...usage,
            };
            pushUsage(agentId, usageRow);
          }
          // What the main session had to read this turn ≈ how big the conversation has grown.
          if (!opts.fresh && provider === 'claude' && Agents.get(agentId)) {
            Agents.update(agentId, { context_tokens: (usageRow.input || 0) + (usageRow.cacheRead || 0) + (usageRow.cacheWrite || 0) });
          }
        }
        if (r.session_id && !opts.fresh && Agents.get(agentId)) {
          AgentSessions.upsert(agentId, provider, r.session_id);
          if (Agents.get(agentId)?.kind === provider) Agents.update(agentId, { session_id: r.session_id });
        }
      },
      onExit: ({ code, error, gotResult }) => {
        live.delete(agentId);
        const current = Agents.get(agentId);
        if (current) expireApprovals(agentId);
        if (!gotResult && current) {
          const m = Messages.add(agentId, 'error', error || `종료 코드 ${code}`);
          emit('message', { agent_id: agentId, message: m });
          result = { ok: false, text: error || `exit ${code}`, crashed: true, provider };
        }
        emit('agent.exited', { agent_id: agentId, code });
        resolve(result);
      },
    };
    const child = provider === 'codex'
      ? runCodex({ agent: runtimeAgent, workspace, text, hooks, opts })
      : runClaude({ agent: runtimeAgent, workspace, text, cfg, hooks, opts });
    if (child) live.set(agentId, { child, provider });
  });
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    complex: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['complex', 'reason'],
};

async function triage(agent, workspace, text, cfg) {
  const prompt = `You are a dispatcher for a coding agent. Decide whether the following request needs an up-front plan by a stronger model before execution.
Answer complex=true when the request touches several files or components, changes architecture or data flow, is ambiguous about scope, needs investigation before editing, or is a feature/refactor rather than a small fix.
Answer complex=false for questions, explanations, single-file edits, small bug fixes, config tweaks, running tests or commands, and anything a competent engineer would do in under 15 minutes.
Respond only with JSON matching the schema. "reason" is one short Korean sentence.

Request:
${text}`;
  void workspace; // triage only needs the request text; running it in the project folder would load
  const r = await runClaudeOnce({ // that project's CLAUDE.md/AGENTS.md into every triage call (tens of k tokens).
    cwd: TRIAGE_DIR, prompt, model: agent.triage_model || 'haiku', schema: TRIAGE_SCHEMA, cfg,
    onModel: (id) => recordResolvedModel(agent.id, 'triage', id),
    onUsage: (u, id) => pushUsage(agent.id, { stage: 'triage', phase: null, provider: 'claude', model: id || agent.triage_model, ...u }),
  });
  if (!r || typeof r.complex !== 'boolean') return { complex: text.length > 200, reason: '분류 실패, 길이로 판단' };
  return r;
}

const TRIAGE_DIR = path.join(DATA_DIR, 'triage');
fs.mkdirSync(TRIAGE_DIR, { recursive: true });

const EXEC_PROMPT = '위에서 세운 계획을 그대로 실행해. 계획에 없는 작업은 하지 말고, 끝나면 무엇을 바꿨는지 한국어로 짧게 요약해.';

/** The planner runs in its own short session: the request plus a compact summary of recent talk. */
function plannerPrompt(agentId, text) {
  const recent = compactConversation(Messages.forAgent(agentId, 30), 5000);
  return `${recent ? `[최근 대화 요약]\n${recent}\n\n` : ''}[요청]\n${text}\n\n위 요청을 실행하기 위한 계획만 세워라. 파일을 수정하지 말고, 계획이 완성되면 ExitPlanMode로 제출해라.`;
}
/** The executor resumes the main session but never saw the planner's session, so the plan rides along. */
function execPrompt(agentId, sinceMessageId) {
  const plan = Messages.after(agentId, sinceMessageId).filter((m) => m.role === 'plan').at(-1)
    || Messages.forAgent(agentId, 50).filter((m) => m.role === 'plan').at(-1);
  if (!plan) return EXEC_PROMPT;
  return `아래 계획을 그대로 실행해. 계획에 없는 작업은 하지 말고, 끝나면 무엇을 바꿨는지 한국어로 짧게 요약해.\n\n[계획]\n${plan.content}`;
}

export function isUsageLimitError(result) {
  if (!result || result.ok) return false;
  const text = [result.text, result.subtype, result.error].filter(Boolean).join(' ').toLowerCase();
  return /rate[_ -]?limit|usage limit|quota|too many requests|insufficient_quota|weekly limit|5-hour limit|한도.{0,8}(소진|초과|도달)|사용량.{0,8}(소진|초과|도달)/i.test(text);
}

function activateProvider(agentId, fromKind, toKind, stage = null) {
  const nextSession = AgentSessions.get(agentId, toKind)?.session_id || null;
  const switched = update(agentId, { kind: toKind, session_id: nextSession, status: 'working', last_error: null, collab_stage: stage });
  note(agentId, `구독 한도 감지 · ${KIND_LABEL[fromKind]} → ${KIND_LABEL[toKind]} 자동 전환`);
  push(switched, '모델 자동 전환', `${KIND_LABEL[fromKind]} 한도에 도달해 ${KIND_LABEL[toKind]}가 같은 작업을 이어갑니다.`);
  return switched;
}

async function completeOrFailover(agentId, result, originalText, cfg, allowFailover) {
  const agent = Agents.get(agentId);
  if (!agent || !allowFailover || !agent.auto_failover || !isUsageLimitError(result)) {
    return finish(agentId, result);
  }

  const fromKind = result?.provider || agent.kind;
  const toKind = fromKind === 'claude' ? 'codex' : 'claude';
  if (toKind === 'codex' && !findCodexEntry()) return finish(agentId, result);

  activateProvider(agentId, fromKind, toKind);
  const continuation = `이전 모델이 구독 한도에 도달해 자동으로 전환되었습니다. 현재 워크스페이스 상태를 먼저 확인하고, 이미 완료된 작업을 반복하거나 되돌리지 말고 아래 요청을 이어서 완료하세요.\n\n${originalText}`;
  return runPipeline(agentId, continuation, cfg, { allowFailover: false });
}

async function runProviderWork(agentId, text, cfg, { kind, phase, autoRoute = false }) {
  let agent = Agents.get(agentId);
  if (!agent) return null;
  const workspace = Workspaces.get(agent.workspace_id);
  if (!workspace) return null;
  const efforts = stageEfforts(agent);

  if (kind === 'claude' && autoRoute && agent.pipeline === 'auto') {
    note(agentId, `${STAGE_LABEL[phase]} · ${agent.triage_model || 'haiku'}가 작업 난이도를 판단하는 중…`);
    const t = await triage(agent, workspace, text, cfg);
    if (!Agents.get(agentId)) return null;
    if (!t.complex) {
      note(agentId, `${STAGE_LABEL[phase]} · 간단한 작업 → ${withEffort(agent.exec_model, efforts.exec)} 실행`);
      return runTurn(agentId, text, cfg, { kind, phase, stage: 'exec', model: agent.exec_model, effort: efforts.exec });
    }

    note(agentId, `${STAGE_LABEL[phase]} · 복잡한 작업 → ${withEffort(agent.plan_model, efforts.plan)} 계획`);
    const planStartMessageId = Messages.latestId(agentId);
    planPhase.add(agentId);
    let planRun;
    try {
      planRun = await runTurn(agentId, plannerPrompt(agentId, text), cfg, { kind, phase, stage: 'plan', fresh: true, model: agent.plan_model, effort: efforts.plan, permissionMode: 'plan' });
    } finally {
      planPhase.delete(agentId);
    }
    const hasPlan = Messages.after(agentId, planStartMessageId).some((m) => m.role === 'plan');
    if (!planRun || (!planRun.ok && !hasPlan) || planRun.crashed) return planRun;
    note(agentId, `${STAGE_LABEL[phase]} · 계획 완료 → ${withEffort(agent.exec_model, efforts.exec)} 실행`);
    return runTurn(agentId, execPrompt(agentId, planStartMessageId), cfg, { kind, phase, stage: 'exec', model: agent.exec_model, effort: efforts.exec });
  }

  if (kind === 'claude') {
    const model = phase === 'review'
      ? agent.plan_model || 'sonnet'
      : agent.pipeline === 'auto' ? agent.exec_model : agent.model;
    // Review runs on the plan model, so it borrows the plan effort; manual pipeline keeps the single agent effort.
    const effort = phase === 'review' ? efforts.plan : agent.pipeline === 'auto' ? efforts.exec : agent.effort || null;
    return runTurn(agentId, text, cfg, {
      kind,
      phase,
      stage: phase === 'review' ? 'plan' : agent.pipeline === 'auto' ? 'exec' : 'manual',
      model,
      effort,
      ...(phase === 'review' ? { tools: ['Read', 'Glob', 'Grep'], permissionMode: 'dontAsk', disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'] } : {}),
    });
  }

  return runTurn(agentId, text, cfg, { kind, phase, model: null, ...(phase === 'review' ? { sandbox: 'read-only' } : {}) });
}

async function runWorkWithLimitFallback(agentId, text, cfg, kind, phase, autoRoute) {
  let result = await runProviderWork(agentId, text, cfg, { kind, phase, autoRoute });
  const agent = Agents.get(agentId);
  if (!agent || result?.ok || !agent.auto_failover || !isUsageLimitError(result)) return { result, kind };

  const fallback = otherProvider(kind);
  if (fallback === 'codex' && !findCodexEntry()) return { result, kind };
  activateProvider(agentId, kind, fallback, phase);
  const continuation = `이전 구현 모델이 구독 한도에 도달했습니다. 같은 협업 단계와 원래 요청을 이어서 완료하세요. 현재 워크스페이스 상태를 먼저 확인하고 이미 완료된 작업은 반복하거나 되돌리지 마세요.\n\n${text}`;
  result = await runProviderWork(agentId, continuation, cfg, { kind: fallback, phase, autoRoute });
  return { result, kind: fallback };
}

async function collaborationSnapshot(agentId, workspace) {
  const [git, messages] = await Promise.all([
    gitSummary(workspace.path, 5),
    Promise.resolve(Messages.forAgent(agentId, 30)),
  ]);
  return {
    recentContext: compactConversation(messages),
    gitManifest: formatGitManifest(git),
  };
}

async function runCollaboration(agentId, originalText, cfg) {
  let agent = Agents.get(agentId);
  if (!agent) return;
  const workspace = Workspaces.get(agent.workspace_id);
  let implementer = agent.kind;
  let reviewer = otherProvider(implementer);

  note(agentId, `교차 협업 시작 · ${KIND_LABEL[implementer]} 구현 → ${KIND_LABEL[reviewer]} 리뷰 → ${KIND_LABEL[implementer]} 수정`);
  update(agentId, { collab_stage: 'implement' });
  const implementation = await runWorkWithLimitFallback(agentId, originalText, cfg, implementer, 'implement', true);
  if (!implementation.result?.ok) return finish(agentId, implementation.result, { title: '협업 구현 오류' });

  implementer = implementation.kind;
  reviewer = otherProvider(implementer);
  if (reviewer === 'codex' && !findCodexEntry()) {
    return finish(agentId, { ok: false, text: '구현은 완료했지만 Codex CLI를 찾지 못해 교차 리뷰를 시작할 수 없습니다.' }, { title: '협업 리뷰 오류' });
  }

  const beforeReview = await collaborationSnapshot(agentId, workspace);
  const reviewPrompt = buildReviewPrompt({
    originalText,
    implementationText: implementation.result.text,
    ...beforeReview,
    implementer,
    reviewer,
  });
  update(agentId, { collab_stage: 'review' });
  note(agentId, `교차 리뷰 · ${KIND_LABEL[reviewer]}가 읽기 전용으로 변경 사항을 검토합니다`);
  const review = await runProviderWork(agentId, reviewPrompt, cfg, { kind: reviewer, phase: 'review' });
  if (!review?.ok) {
    const reason = isUsageLimitError(review) ? `${KIND_LABEL[reviewer]} 구독 한도에 도달했습니다.` : review?.text || '리뷰 모델 실행에 실패했습니다.';
    return finish(agentId, { ok: false, text: `구현은 보존되었지만 교차 리뷰를 완료하지 못했습니다. ${reason}` }, { title: '협업 리뷰 오류' });
  }

  const beforeRevision = await collaborationSnapshot(agentId, workspace);
  const revisionPrompt = buildRevisionPrompt({
    originalText,
    reviewText: review.text,
    gitManifest: beforeRevision.gitManifest,
    implementer,
    reviewer,
  });
  update(agentId, { collab_stage: 'revise' });
  note(agentId, `최종 수정 · ${KIND_LABEL[implementer]}가 리뷰를 검증하고 마무리합니다`);
  const revision = await runWorkWithLimitFallback(agentId, revisionPrompt, cfg, implementer, 'revise', false);
  return finish(agentId, revision.result, { title: revision.result?.ok ? '교차 협업 완료' : '최종 수정 오류' });
}

async function runPipeline(agentId, text, cfg, flow = { allowFailover: true }) {
  let agent = Agents.get(agentId);
  const workspace = Workspaces.get(agent.workspace_id);
  const efforts = stageEfforts(agent);

  if (agent.kind !== 'claude' || agent.pipeline !== 'auto') {
    const r = await runTurn(agentId, text, cfg, { stage: 'manual' });
    return completeOrFailover(agentId, r, text, cfg, flow.allowFailover !== false);
  }

  note(agentId, `${agent.triage_model || 'haiku'}가 자동 판단 중…`);
  const t = await triage(agent, workspace, text, cfg);
  if (!Agents.get(agentId)) return; // deleted while triage was running

  if (!t.complex) {
    note(agentId, `간단한 작업 → ${withEffort(agent.exec_model, efforts.exec)} 실행 · ${t.reason}`);
    const r = await runTurn(agentId, text, cfg, { stage: 'exec', model: agent.exec_model, effort: efforts.exec });
    return completeOrFailover(agentId, r, text, cfg, flow.allowFailover !== false);
  }

  note(agentId, `복잡한 작업 → ${withEffort(agent.plan_model, efforts.plan)} 계획 · ${t.reason}`);
  const planStartMessageId = Messages.latestId(agentId);
  planPhase.add(agentId);
  let planRun;
  try {
    planRun = await runTurn(agentId, plannerPrompt(agentId, text), cfg, { stage: 'plan', fresh: true, model: agent.plan_model, effort: efforts.plan, permissionMode: 'plan' });
  } finally {
    planPhase.delete(agentId);
  }
  const hasPlan = Messages.after(agentId, planStartMessageId).some((m) => m.role === 'plan');
  if (!planRun || (!planRun.ok && !hasPlan) || planRun.crashed) {
    return completeOrFailover(agentId, planRun, text, cfg, flow.allowFailover !== false);
  }

  agent = Agents.get(agentId);
  if (agent.confirm_plan) {
    update(agentId, { status: 'needs_attention', pending_plan: 1, last_response: planRun.text || '계획이 준비되었습니다.' });
    note(agentId, '계획 확인 대기 · "이 계획대로 실행"을 누르면 진행합니다.');
    push(agent, '계획 확인 필요', planRun.text || '계획이 준비되었습니다.');
    flushUsage(agentId);
    return;
  }
  note(agentId, `계획 완료 → ${withEffort(agent.exec_model, efforts.exec)} 실행`);
  const execRun = await runTurn(agentId, execPrompt(agentId, planStartMessageId), cfg, { stage: 'exec', model: agent.exec_model, effort: efforts.exec });
  return completeOrFailover(agentId, execRun, text, cfg, flow.allowFailover !== false);
}

const COMPACT_LABEL = '대화 정리';
const compacting = new Set(); // agentIds whose summary is being written; new prompts wait

/**
 * 대화 정리: summarize the conversation with the cheap triage model, store the memo, and drop the
 * Claude session so the next turn starts small. Reading a 1M-token history every turn is the
 * single biggest cost once an agent has been used for a while.
 */
export async function compactAgent(agentId, cfg, { reason = 'manual' } = {}) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (live.has(agentId) || agent.status === 'working') throw new Error('작업이 끝난 뒤 정리하세요');
  if (compacting.has(agentId)) throw new Error('이미 정리 중입니다');
  const history = compactConversation(Messages.forAgent(agentId, 80), 14000);
  if (!history.trim()) throw new Error('정리할 대화가 없습니다');
  compacting.add(agentId);
  try {
    return await compactAgentInner(agentId, agent, history, cfg, reason);
  } finally {
    compacting.delete(agentId);
  }
}

async function compactAgentInner(agentId, agent, history, cfg, reason) {
  const prompt = `아래는 코딩 에이전트와 사용자의 대화 기록이다. 다음 대화가 새 세션에서 시작되어도 이어갈 수 있도록 한국어로 "이어가기 메모"를 써라.
형식: 줄머리 "- "로 시작하는 짧은 항목만. 섹션: 목표 / 지금까지 한 일 / 결정한 것 / 남은 일 / 주의할 점. 전체 700자 이내. 파일 이름·명령은 필요할 때만.

${history}`;
  const memo = await runClaudeOnceText({ cwd: TRIAGE_DIR, prompt, model: agent.triage_model || 'haiku', cfg });
  if (!memo) throw new Error('요약 생성에 실패했습니다');
  AgentSessions.remove(agentId, 'claude');
  const fields = { carry_note: memo, context_tokens: 0 };
  if (agent.kind === 'claude') fields.session_id = null;
  update(agentId, fields);
  const m = Messages.add(agentId, 'handoff', `${COMPACT_LABEL} · 이어가기 메모\n${memo}`, { compact: true, reason });
  emit('message', { agent_id: agentId, message: m });
  note(agentId, reason === 'auto'
    ? `${COMPACT_LABEL} · 대화가 길어져 요약해 두고 새 대화로 이어갑니다`
    : `${COMPACT_LABEL} · 요약해 두고 새 대화로 이어갑니다`);
  return memo;
}

function maybeAutoCompact(agentId, cfg) {
  const limit = Number(cfg?.compactAfterTokens) || 0;
  const agent = Agents.get(agentId);
  if (!limit || !agent || agent.kind !== 'claude' || agent.context_tokens < limit) return;
  compactAgent(agentId, cfg, { reason: 'auto' }).catch((e) => note(agentId, `${COMPACT_LABEL} 실패 · ${e.message}`));
}

function finish(agentId, r, opts = {}) {
  flushUsage(agentId);
  const agent = Agents.get(agentId);
  if (!agent) return;
  if (!r) return;
  if (r.ok) setTimeout(() => maybeAutoCompact(agentId, opts.cfg || lastCfg), 500);
  const ok = !!r.ok;
  if (!ok) {
    const errorText = r.text || r.subtype || '문제가 발생했습니다.';
    const last = Messages.forAgent(agentId, 1)[0];
    if (last?.role !== 'error' || last.content !== errorText) {
      const message = Messages.add(agentId, 'error', errorText, r.provider ? { provider: r.provider, ...(r.phase ? { phase: r.phase } : {}) } : null);
      emit('message', { agent_id: agentId, message });
    }
  }
  const a = update(agentId, {
    status: ok ? 'done' : 'error',
    last_response: r.text || null,
    last_error: ok ? null : r.text || r.subtype || 'error',
    pending_plan: 0,
    collab_stage: null,
  });
  push(a, opts.title || (ok ? '완료' : '오류'), r.text || (ok ? '작업이 끝났습니다.' : '문제가 발생했습니다.'));
  return r;
}

let lastCfg = null;
export function startPrompt(agentId, text, cfg) {
  lastCfg = cfg;
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (live.has(agentId) || agent.status === 'working') throw new Error('이미 작업 중입니다');
  if (compacting.has(agentId)) throw new Error('대화를 정리하는 중입니다. 잠시 후 다시 보내세요');
  if (!Workspaces.get(agent.workspace_id)) throw new Error('workspace not found');
  if (agent.collab_mode && !findCodexEntry()) throw new Error('교차 협업에는 Codex CLI가 필요합니다');

  usageAcc.delete(agentId);
  const userMsg = Messages.add(agentId, 'user', text);
  emit('message', { agent_id: agentId, message: userMsg });
  const updated = update(agentId, { status: 'working', last_error: null, pending_plan: 0, collab_stage: agent.collab_mode ? 'implement' : null });
  const task = agent.collab_mode ? runCollaboration(agentId, text, cfg) : runPipeline(agentId, text, cfg);
  task.catch((e) => {
    console.error('[pipeline]', e);
    finish(agentId, { ok: false, text: e.message });
  });
  return updated;
}

export function executePlan(agentId, cfg) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (live.has(agentId)) throw new Error('이미 작업 중입니다');
  if (!agent.pending_plan) throw new Error('실행 대기 중인 계획이 없습니다');
  usageAcc.delete(agentId);
  const updated = update(agentId, { status: 'working', pending_plan: 0, collab_stage: null });
  const efforts = stageEfforts(agent);
  note(agentId, `계획 승인 → ${withEffort(agent.exec_model, efforts.exec)} 실행`);
  const prompt = execPrompt(agentId, 0);
  runTurn(agentId, prompt, cfg, { stage: 'exec', model: agent.exec_model, effort: efforts.exec })
    .then((r) => completeOrFailover(agentId, r, prompt, cfg, true))
    .catch((e) => finish(agentId, { ok: false, text: e.message }));
  return updated;
}

export function switchProvider(agentId, kind) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (!['claude', 'codex'].includes(kind)) throw new Error('provider must be claude|codex');
  if (live.has(agentId) || agent.status === 'working' || agent.status === 'needs_attention') {
    throw new Error('작업 또는 승인이 끝난 뒤 전환하세요');
  }
  if (agent.pending_plan) throw new Error('대기 중인 계획을 실행하거나 새 작업으로 초기화한 뒤 전환하세요');
  if (kind === 'codex' && !findCodexEntry()) throw new Error('Codex CLI를 찾지 못했습니다');
  if (kind === agent.kind) return agent;

  if (agent.session_id) AgentSessions.upsert(agentId, agent.kind, agent.session_id);
  const nextSession = AgentSessions.get(agentId, kind)?.session_id || null;
  const updated = update(agentId, { kind, session_id: nextSession, status: 'idle', last_error: null });
  note(agentId, `실행 모델 전환 · ${KIND_LABEL[agent.kind]} → ${KIND_LABEL[kind]}`);
  return updated;
}

export function stopAgent(agentId) {
  const entry = live.get(agentId);
  if (!entry) return false;
  const child = entry.child;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
  return true;
}
