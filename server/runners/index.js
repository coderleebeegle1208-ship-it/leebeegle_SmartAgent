// Runner manager: one live process per agent, status bookkeeping, push on completion,
// and the automatic "triage → plan (Fable) → execute (Sonnet)" pipeline.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';
import { AgentSessions, Agents, Messages, Snapshots, Workspaces, Queue } from '../db.js';
import { explainError, errorMessageText } from '../errors.js';
import { emit } from '../bus.js';
import { sendPush } from '../push.js';
import { expireApprovals, setBlanketAllow } from '../approvals.js';
import { createRunWatch, watchLimits, describeVerdict } from '../watchdog.js';
import { runClaude, runClaudeOnce, runClaudeOnceText } from './claude.js';
import { findCodexEntry, runCodex } from './codex.js';
import { findGeminiEntry, runGemini } from './gemini.js';
import { accountCredFiles as geminiCredFiles, accountEnv as geminiAccountEnv, accountHome as geminiAccountHome, hasAccounts as hasGeminiAccounts, listAccounts as listGeminiAccounts, pickAccount as pickGeminiAccount, forgetQuota as forgetGeminiQuota } from '../gemini-accounts.js';
import { planPhase } from '../state.js';
import { codexDefaults, geminiDefaults, geminiFallbackModel, geminiModelLabel, modelLabel } from '../models.js';
import { gitDiff, gitSummary, snapshotTree, treeChanges } from '../git.js';
import { buildReviewPrompt, buildRevisionPrompt, compactConversation, formatGitManifest, otherProvider } from '../collaboration.js';
import { normalizeCodexUsage, normalizeGeminiUsage, summarizeRun, usageHeadline } from '../tokens.js';
import { UPLOAD_DIR, attachmentBlock, extractLinks } from '../uploads.js';
import { expandSkill, listSkills, resolveSkillCommand, skillCatalogBlock, skillPointerBlock, triageTextFor } from '../skills.js';
import { readTranscript, transcriptPath, transcriptSize } from '../desktop-sessions.js';

const live = new Map(); // agentId -> { child, cancelled }
const usageAcc = new Map(); // agentId -> stage usage rows for the run in progress
const turnSnap = new Map(); // agentId -> turn_snapshots row taken before the run in progress
const runWatch = new Map(); // agentId -> cost/loop watch for the run in progress (spans plan + exec)
const retried = new Set(); // agentIds whose current run already got its one automatic retry
const liveStats = new Map(); // agentId -> { base, cur, phase, tool, sentAt } 답변 중 상태 줄(토큰·단계)
const LIVE_EMIT_MS = 400;
/** 지금 돌고 있는 턴의 상태(폰 상태 줄용). 없으면 null. */
export function liveStatsOf(agentId) {
  const s = liveStats.get(agentId);
  return s ? { tokens: s.base + s.cur, phase: s.phase, tool: s.tool } : null;
}
const RETRY_DELAY_MS = 20_000;
// 폰으로 바로 받아볼 만한 결과물. 코드·설정 파일은 제외.
const DELIVERABLE_RE = /\.(mp4|mov|webm|mp3|wav|m4a|pdf|png|jpe?g|gif|webp|svg|html?|docx?|xlsx?|pptx?|csv|zip|srt|md|txt)$/i;
const CONVO_ROLES = ['user', 'assistant', 'plan', 'handoff']; // the roles compactConversation actually reads
const KIND_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
// 읽기 전용 턴(계획·검토): Codex는 샌드박스, Gemini는 승인 모드로 막는다. 각 실행기는 자기 것만 읽는다.
const READ_ONLY = { sandbox: 'read-only', approvalMode: 'plan' };
const STAGE_LABEL = { implement: '구현', review: '교차 리뷰', revise: '최종 수정' };
const EFFORT_LABEL = { low: '낮음', medium: '중간', high: '높음', xhigh: '매우 높음', max: '최대' };

/** 단일 모델 실행기(Codex·Gemini)의 실제 모델·강도. Claude는 pipeline에 따라 달라 여기 없다. */
export function singleModelOf(agent, kind = agent.kind) {
  if (kind === 'codex') return { kind, model: agent.codex_model || codexDefaults().model, effort: agent.codex_effort || codexDefaults().effort };
  if (kind === 'gemini') return { kind, model: agent.gemini_model || geminiDefaults().model, effort: agent.gemini_effort || null };
  return { kind: 'claude', model: agent.model, effort: agent.effort || null };
}
/** "Codex 5.6 Terra (강도 중간)" 같은 실행 담당 표시 이름. */
function execLabelOf(agent) {
  const m = singleModelOf(agent);
  return `${KIND_LABEL[m.kind]} ${withEffort(m.model, m.effort)}`;
}

// Per-stage effort: the plan stage always gets at least 'high'; execution follows the CLI default unless set.
export function stageEfforts(agent) {
  return { plan: agent.plan_effort || 'high', exec: agent.exec_effort || null };
}
function withEffort(model, effort) {
  const name = modelLabel(model);
  return effort ? `${name} (강도 ${EFFORT_LABEL[effort] || effort})` : name;
}

// 단일 모델 + 계획 분담: 다른 제공자가 계획서를 먼저 쓰고, 원래 모델이 그 계획대로 실행한다.
// Claude가 계획을 맡으면 교차 모델의 계획 모델·강도(plan_model/plan_effort)를 그대로 쓰고,
// Codex가 맡으면 전용 설정(codex_plan_model/codex_plan_effort)을 쓴다.
export function usesCrossPlan(agent) {
  return !!agent?.cross_plan && (agent.kind === 'codex' || agent.pipeline !== 'auto');
}
/** 계획 합의: 계획 분담 위에 "실행 모델이 초안 검토 → 계획 모델이 최종안" 왕복을 한 번 얹는다. */
export function usesPlanDebate(agent) {
  return usesCrossPlan(agent) && !!agent.plan_debate;
}
export function crossPlanner(agent) {
  if (agent.kind === 'claude') return { kind: 'codex', model: agent.codex_plan_model || codexDefaults().model, effort: agent.codex_plan_effort || 'high' };
  return { kind: 'claude', model: agent.plan_model || 'fable', effort: stageEfforts(agent).plan };
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
/** PC 클로드 앱과 같은 세션을 쓰는 담당자: 기록 파일에 새로 쌓인 PC 쪽 대화(내 말·답변 글)를 앱 화면으로 옮긴다. */
export function syncDesktopTranscript(agentId) {
  const agent = Agents.get(agentId);
  if (!agent?.desktop_host_id || agent.kind !== 'claude' || !agent.session_id) return 0;
  const workspace = Workspaces.get(agent.workspace_id);
  if (!workspace) return 0;
  const from = agent.transcript_pos || 0;
  const { messages, pos } = readTranscript(transcriptPath(workspace.path, agent.session_id), from);
  if (pos === from) return 0;
  for (const m of messages) {
    const row = Messages.add(agentId, m.role, m.content, { desktop: true }, m.ts);
    emit('message', { agent_id: agentId, message: row });
  }
  const fields = { transcript_pos: pos };
  const lastAnswer = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAnswer) fields.last_response = lastAnswer.content;
  if (messages.length) update(agentId, fields); else Agents.update(agentId, fields);
  return messages.length;
}
/** 이 앱이 직접 돌린 턴은 이미 화면에 있으므로, 기록 파일의 그 부분은 건너뛰도록 위치를 끝으로 옮긴다. */
function skipOwnTranscript(agentId) {
  const agent = Agents.get(agentId);
  if (!agent?.desktop_host_id || agent.kind !== 'claude' || !agent.session_id) return;
  const workspace = Workspaces.get(agent.workspace_id);
  if (!workspace) return;
  Agents.update(agentId, { transcript_pos: transcriptSize(transcriptPath(workspace.path, agent.session_id)) });
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
  const full = (body || '').trim();
  // long: 메신저(텔레그램)에는 보고 전문을 보낸다. 웹 푸시는 180자만.
  sendPush({ title: `${agent.name} · ${title}`, body: full.replace(/\s+/g, ' ').slice(0, 180), long: full.slice(0, 3500), url: `/?agent=${agent.id}`, tag: `agent-${agent.id}` }).catch(() => {});
}

/** Always includes this agent's upload folder (creating it if needed) so the --add-dir flag is
 * present on every Claude turn from the first one, keeping the command line stable across turns. */
export function claudeAddDirs(agentId, extra = []) {
  const dir = path.join(UPLOAD_DIR, `agent-${agentId}`);
  fs.mkdirSync(dir, { recursive: true });
  return [...(extra || []), dir];
}

/** What the runner needs to run as this Google account: env for the login and, for a home account,
 *  where its login files live so they can be copied into the run home. */
function geminiRunAccount(acct) {
  if (!acct) return null;
  return { id: acct.id, env: geminiAccountEnv(acct.id), ...(acct.kind === 'home' ? { home: geminiAccountHome(acct.id), credFiles: geminiCredFiles(acct.id) } : {}) };
}

/** Gemini 대화는 로그인 계정에 묶여 있어 "계정id:대화id"로 저장한다. 다른 계정으로 돌면 이어 쓸 수 없다. */
export function splitGeminiSession(saved) {
  const m = String(saved || '').match(/^([a-z0-9]{1,16}):(.+)$/);
  return m ? { accountId: m[1], sessionId: m[2] } : { accountId: null, sessionId: saved || null };
}

/** Pinned Gemini models this process has seen rejected (not enabled for the account / not rolled out
 * yet) → the model we fell back to. Remembered for an hour so every turn doesn't pay a failed call. */
const geminiModelFallbacks = new Map();
const GEMINI_FALLBACK_TTL = 60 * 60 * 1000;
function rememberedGeminiFallback(model) {
  const hit = geminiModelFallbacks.get(model);
  if (!hit) return null;
  if (Date.now() - hit.at > GEMINI_FALLBACK_TTL) { geminiModelFallbacks.delete(model); return null; }
  return hit.to;
}
/** "gemini-3.5-flash is not found / not supported / no access" style failures for a pinned model. */
export function isModelUnavailableError(result) {
  if (!result || result.ok || isUsageLimitError(result)) return false;
  const text = [result.text, result.subtype, result.error].filter(Boolean).join(' ');
  return /\bmodel\b.{0,80}(not found|not available|unavailable|not supported|unsupported|does not exist|is not (?:yet )?available|invalid|unknown|no access|not enabled|denied)|(not found|unavailable|invalid|unknown|unsupported).{0,40}\bmodel\b|\bNOT_FOUND\b|\bPERMISSION_DENIED\b|\b404\b/i.test(text);
}

/** Runs one Claude/Codex/Gemini turn and resolves with the result summary when the process exits.
 * Gemini: 한도에 닿으면 다른 Google 계정으로 같은 지시를 이어서 한 번씩 더 시도하고, 고른 모델이
 * 이 계정에서 안 열리면(아직 안 풀린 3.5 Flash 등) 같은 계열의 한 단계 아래 모델로 바꿔 다시 돈다. */
async function runTurn(agentId, text, cfg, opts = {}) {
  const provider = opts.kind || Agents.get(agentId)?.kind;
  if (provider !== 'gemini') return runTurnOnce(agentId, text, cfg, opts);
  const tried = [];
  let prompt = text;
  let model = Object.hasOwn(opts, 'model') ? opts.model : (Agents.get(agentId)?.gemini_model || geminiDefaults().model);
  const remembered = rememberedGeminiFallback(model);
  if (remembered) {
    note(agentId, `Gemini ${geminiModelLabel(model)} 모델은 아직 이 계정에서 안 열려 ${geminiModelLabel(remembered)}로 진행`);
    model = remembered;
  }
  let modelSwaps = 0;
  for (;;) {
    const r = await runTurnOnce(agentId, prompt, cfg, { ...opts, model, excludeAccounts: tried });
    if (!r?.accountId || !Agents.get(agentId)) return r;
    if (isUsageLimitError(r)) {
      tried.push(r.accountId);
      const next = await pickGeminiAccount(null, model, tried);
      if (!next) return r;
      forgetGeminiQuota(r.accountId);
      const from = listGeminiAccounts().find((a) => a.id === r.accountId);
      note(agentId, `Gemini 한도 감지 · ${from?.email || r.accountId} → ${next.email} 계정으로 이어서 시도`);
      prompt = `이전 Google 계정의 Gemini 한도가 차서 다른 계정으로 전환되었습니다(대화 기억은 새로 시작). 현재 워크스페이스 상태를 먼저 확인하고, 이미 완료된 작업을 반복하거나 되돌리지 말고 아래 요청을 이어서 완료하세요.\n\n${text}`;
      continue;
    }
    if (isModelUnavailableError(r) && modelSwaps < 3) {
      const to = geminiFallbackModel(model);
      if (!to) return r;
      modelSwaps++;
      geminiModelFallbacks.set(model, { to, at: Date.now() });
      note(agentId, `Gemini ${geminiModelLabel(model)} 모델을 이 계정에서 쓸 수 없어 ${geminiModelLabel(to)}로 바꿔 다시 시도`);
      model = to;
      continue;
    }
    return r;
  }
}

function runTurnOnce(agentId, text, cfg, opts = {}) {
  return new Promise(async (resolve, reject) => {
   try {
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
    // Codex has no native SKILL.md discovery like Claude Code, so a brand-new thread gets a one-time
    // catalog to reach for on its own; the /이름 command path below never needs this (it inlines the
    // skill directly), so this only matters for requests that don't spell out a skill explicitly.
    // Gemini 계정 고르기: 고정 계정이 있으면 그것, 없으면 한도가 가장 많이 남은 계정. 저장된 세션이
    // 다른 계정 것이면 이어 쓸 수 없으니 새 대화로 간다(계정 전환 안내는 runTurn이 붙인다).
    let geminiAccount = null;
    if (provider === 'gemini') {
      const split = splitGeminiSession(savedSession);
      const exclude = opts.excludeAccounts || [];
      const preferred = exclude.length ? null : agent.gemini_account || split.accountId;
      geminiAccount = await pickGeminiAccount(preferred, opts.model || agent.gemini_model, exclude);
      savedSession = geminiAccount && split.accountId === geminiAccount.id ? split.sessionId : null;
    }
    if ((provider === 'codex' || provider === 'gemini') && !savedSession && !opts.fresh) {
      const catalog = skillCatalogBlock(listSkills(workspace.path));
      if (catalog) text = `${catalog}\n\n${text}`;
    }
    // First turn after 대화 정리: hand the summary to the new session, then forget it.
    if (!opts.fresh && !savedSession && agent.carry_note) {
      text = `[이전 대화 요약 · 이어서 진행]\n${agent.carry_note}\n\n${text}`;
      Agents.update(agentId, { carry_note: null });
    }
    const single = singleModelOf(agent, provider);
    const runtimeModel = Object.hasOwn(opts, 'model') ? opts.model : single.model;
    const runtimeEffort = Object.hasOwn(opts, 'effort') ? opts.effort : provider === 'claude' ? agent.effort : single.effort;
    const runtimeAgent = { ...agent, kind: provider, session_id: savedSession, model: runtimeModel, effort: runtimeEffort };
    // 저장할 때는 계정 접두어를 붙인다.
    const storedSession = (id) => (provider === 'gemini' && geminiAccount ? `${geminiAccount.id}:${id}` : id);
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
        sessionId = storedSession(sessionId);
        AgentSessions.upsert(agentId, provider, sessionId);
        const current = Agents.get(agentId);
        if (current?.kind === provider && sessionId !== current.session_id) update(agentId, { session_id: sessionId });
      },
      onMessage: (role, content, meta) => {
        if (!Agents.get(agentId)) return;
        // Codex 계획 담당: 마지막 답변만 계획 카드로 저장하므로 중간 답변은 대화에 남기지 않는다.
        if (opts.captureAs === 'plan' && role === 'assistant') return;
        const m = Messages.add(agentId, role, content, { ...(meta || {}), provider, ...(opts.phase ? { phase: opts.phase } : {}) });
        emit('message', { agent_id: agentId, message: m });
      },
      onLive: (p) => {
        if (opts.phase === 'review') return;
        const s = liveStats.get(agentId) || { base: 0, cur: 0, phase: 'thinking', tool: null, sentAt: 0 };
        const changed = s.phase !== p.phase || s.tool !== p.tool;
        s.cur = p.tokens; s.phase = p.phase; s.tool = p.tool;
        liveStats.set(agentId, s);
        const now = Date.now();
        if (!changed && now - s.sentAt < LIVE_EMIT_MS) return;
        s.sentAt = now;
        emit('run.live', { agent_id: agentId, live: { tokens: s.base + s.cur, phase: s.phase, tool: s.tool } });
      },
      onProgress: (p) => {
        if (!Agents.get(agentId) || opts.phase === 'review') return;
        const limits = watchLimits(cfg);
        if (!runWatch.has(agentId)) runWatch.set(agentId, createRunWatch(limits));
        const verdict = runWatch.get(agentId).feed(p);
        if (!verdict) return;
        const text = describeVerdict(verdict, limits);
        const current = Agents.get(agentId);
        if (verdict.kind === 'alert') {
          note(agentId, text);
          push(current, '비용 알림', text);
          return;
        }
        // 멈춤: 프로세스를 끊고, onExit가 이 사유로 마무리하도록 남겨 둔다.
        const entry = live.get(agentId);
        if (entry) entry.stopReason = text;
        note(agentId, text);
        stopAgent(agentId);
      },
      onResult: (r) => {
        // 단계(계획→실행)가 바뀌어도 이번 턴의 토큰은 이어서 센다.
        const ls = liveStats.get(agentId);
        if (ls) { ls.base += ls.cur; ls.cur = 0; }
        result = { ...r, provider, ...(opts.phase ? { phase: opts.phase } : {}), ...(geminiAccount ? { accountId: geminiAccount.id } : {}) };
        const usage = provider === 'codex' ? (r.usage ? normalizeCodexUsage(r.usage) : null)
          : provider === 'gemini' ? (r.usage ? normalizeGeminiUsage(r.usage) : null)
          : r.usage;
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
              model: resolvedModel || r.model || runtimeModel || null,   // init event names the main model
              ...usage,
            };
            pushUsage(agentId, usageRow);
          }
          // What the main session had to read this turn ≈ how big the conversation has grown.
          // r.contextTokens (from the assistant events) is the actual per-turn context size; the
          // usage-row sum is only a fallback for providers/paths that don't report it (e.g. Codex).
          if (!opts.fresh && Agents.get(agentId)) {
            // Claude reports the current context directly. Codex reports the accumulated input
            // for its tool loop; that is the right signal for rotating a thread that became costly.
            const contextTokens = provider === 'claude'
              ? r.contextTokens ?? ((usageRow.input || 0) + (usageRow.cacheRead || 0) + (usageRow.cacheWrite || 0))
              : (usageRow.input || 0) + (usageRow.cacheRead || 0);
            Agents.update(agentId, { context_tokens: contextTokens, ...(r.contextWindow ? { context_window: r.contextWindow } : {}) });
          }
        }
        if (r.session_id && !opts.fresh && Agents.get(agentId)) {
          AgentSessions.upsert(agentId, provider, storedSession(r.session_id));
          if (Agents.get(agentId)?.kind === provider) Agents.update(agentId, { session_id: storedSession(r.session_id) });
        }
      },
      onExit: ({ code, error, gotResult }) => {
        const stopReason = live.get(agentId)?.stopReason || null;
        live.delete(agentId);
        const current = Agents.get(agentId);
        if (current) expireApprovals(agentId);
        if (stopReason && current) {
          // Watchdog stop: the note already explains it; the session stays resumable ("계속해줘").
          result = { ok: false, text: stopReason, stopped: true, provider };
        } else if (!gotResult && current) {
          const m = Messages.add(agentId, 'error', error || `종료 코드 ${code}`);
          emit('message', { agent_id: agentId, message: m });
          result = { ok: false, text: error || `exit ${code}`, crashed: true, provider, ...(geminiAccount ? { accountId: geminiAccount.id } : {}) };
        }
        emit('agent.exited', { agent_id: agentId, code });
        resolve(result);
      },
    };
    // Uploaded photos/videos live outside the project folder, so every Claude turn gets read
    // access to this agent's upload folder up front — added from the very first turn (not only
    // once an upload exists) so the --add-dir flag never changes the command line later and
    // invalidates the prompt cache built on earlier turns.
    const claudeOpts = provider === 'claude' ? { ...opts, addDirs: claudeAddDirs(agentId, opts.addDirs) } : opts;
    const child = provider === 'codex'
      ? runCodex({ agent: runtimeAgent, workspace, text, cfg, hooks, opts })
      : provider === 'gemini'
        ? runGemini({ agent: runtimeAgent, workspace, text, cfg, hooks, opts: { ...opts, accountId: geminiAccount?.id || null, account: geminiRunAccount(geminiAccount), includeDirs: claudeAddDirs(agentId, opts.addDirs) } })
        : runClaude({ agent: runtimeAgent, workspace, text, cfg, hooks, opts: claudeOpts });
    if (child) live.set(agentId, { child, provider });
   } catch (e) {
    reject(e);
   }
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

const TRIAGE_SYSTEM_PROMPT = `You are a dispatcher for a coding agent. Decide whether the following request needs an up-front plan by a stronger model before execution.
A plan only helps when there's a real decision to make before editing starts. Answer complex=true only when at least one of these holds: the request spans several files or components AND the approach across them isn't obvious, it changes architecture or data flow, the scope is genuinely ambiguous, or it needs investigation before you'd even know what to edit.
Answer complex=false whenever a competent engineer could start editing immediately without weighing approaches first: questions, explanations, single-file edits, bug fixes, config tweaks, running tests or commands, and small well-scoped features/refactors — even if they touch a few files — as long as the approach is clear. When unsure, prefer complex=false; skipping a plan for something that turns out ambiguous costs far less than planning something that didn't need it.
Respond only with JSON matching the schema: {"complex": boolean, "reason": "one short Korean sentence"}. Output only the JSON object, no prose, no code fence.`;

/** Keeps triage input small: a long request costs the same judgment either way. */
export function clipForTriage(text, maxChars = 3000) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const headLen = Math.round(maxChars * 2 / 3);
  const tailLen = maxChars - headLen;
  return `${s.slice(0, headLen)}\n… (중략) …\n${s.slice(-tailLen)}`;
}

async function triage(agent, workspace, text, cfg) {
  void workspace; // triage only needs the request text; running it in the project folder would load
  const r = await runClaudeOnce({ // that project's CLAUDE.md/AGENTS.md into every triage call (tens of k tokens).
    cwd: TRIAGE_DIR, prompt: clipForTriage(text), systemPrompt: TRIAGE_SYSTEM_PROMPT, model: agent.triage_model || 'haiku', schema: TRIAGE_SCHEMA, cfg,
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
function plannerPrompt(agentId, text, { skill } = {}) {
  const recent = compactConversation(Messages.recentByRole(agentId, CONVO_ROLES, 30), 5000);
  const skillNote = skill ? ' 실행자가 열어야 할 스킬 폴더 파일은 절대 경로로 계획에 적어라.' : '';
  return `${recent ? `[최근 대화 요약]\n${recent}\n\n` : ''}[요청]\n${text}\n\n위 요청을 실행하기 위한 계획만 세워라. 파일을 수정하지 말고, 계획이 완성되면 ExitPlanMode로 제출해라. 계획은 한국어로, 실행자가 그대로 따를 수 있게 핵심만 3,000자 이내로 적어라. 코드 전문은 넣지 말고 바꿀 파일·함수·내용만 적어라.${skillNote}`;
}
/** The most recent user turn's attachments/links, rebuilt into the same block the planner saw —
 * needed because the executor resumes the main session, which never saw the planner's fresh session. */
function latestAttachmentBlock(agentId) {
  const last = Messages.recentByRole(agentId, ['user'], 1)[0];
  if (!last?.meta) return '';
  let meta;
  try { meta = JSON.parse(last.meta); } catch { return ''; }
  if (!meta?.attachments?.length && !meta?.links?.length) return '';
  return attachmentBlock(meta.attachments || [], meta.links || []);
}
/** Same idea for a /이름 command: the executor never saw the planner's expanded skill body, so it
 * only gets the folder to go re-open files from. */
function latestSkillPointer(agentId) {
  const last = Messages.recentByRole(agentId, ['user'], 1)[0];
  if (!last?.meta) return '';
  let meta;
  try { meta = JSON.parse(last.meta); } catch { return ''; }
  if (!meta?.skill) return '';
  return skillPointerBlock(meta.skill);
}
function findPlanMessage(agentId, sinceMessageId) {
  return Messages.after(agentId, sinceMessageId).filter((m) => m.role === 'plan').at(-1)
    || Messages.forAgent(agentId, 50).filter((m) => m.role === 'plan').at(-1);
}
/** The executor resumes the main session but never saw the planner's session, so the plan rides along. */
function execPrompt(agentId, sinceMessageId) {
  const plan = findPlanMessage(agentId, sinceMessageId);
  const base = plan
    ? `아래 계획을 그대로 실행해. 계획에 없는 작업은 하지 말고, 끝나면 무엇을 바꿨는지 한국어로 짧게 요약해.\n\n[계획]\n${plan.content}`
    : EXEC_PROMPT;
  return base + latestAttachmentBlock(agentId) + latestSkillPointer(agentId);
}

/** 계획 이견에서 대표가 검토 담당 손을 들어준 경우: 최종안을 바탕으로 하되, 갈린 지점은 검토 의견을 따른다. */
function execPromptReviewerSide(agentId) {
  const plan = findPlanMessage(agentId, 0);
  const review = Messages.forAgent(agentId, 50).filter((m) => m.role === 'plan_review').at(-1);
  if (!plan || !review) return execPrompt(agentId, 0);
  const base = `아래 계획을 실행하되, 계획 담당과 검토 담당의 의견이 갈린 지점은 대표가 [검토 의견] 쪽을 택했다. 그 지점은 검토 의견대로 계획을 고쳐서 실행하고, 나머지는 계획대로 해. 계획에 없는 작업은 하지 말고, 끝나면 무엇을 바꿨는지 한국어로 짧게 요약해.\n\n[계획]\n${plan.content}\n\n[검토 의견 · 갈린 지점은 이쪽을 따를 것]\n${review.content}`;
  return base + latestAttachmentBlock(agentId) + latestSkillPointer(agentId);
}

/** Codex has no ExitPlanMode, so its planner turn just answers with the plan text (read-only sandbox). */
export function codexPlannerPrompt(agentId, text, { skill } = {}) {
  const recent = compactConversation(Messages.recentByRole(agentId, CONVO_ROLES, 30), 5000);
  const skillNote = skill ? ' 실행자가 열어야 할 스킬 폴더 파일은 절대 경로로 계획에 적어라.' : '';
  return `${recent ? `[최근 대화 요약]\n${recent}\n\n` : ''}[요청]\n${text}\n\n당신은 계획 담당이다. 위 요청을 실행하기 위한 계획만 세워라. 파일을 수정하거나 상태를 바꾸는 명령은 실행하지 말고, 코드를 읽어 확인만 해라. 계획은 한국어로, 다른 모델(실행자)이 그대로 따를 수 있게 핵심만 3,000자 이내로 적어라. 코드 전문은 넣지 말고 바꿀 파일·함수·내용만 적어라. 최종 답변에는 계획 본문만 써라.${skillNote}`;
}

/** 계획 검토(실행 담당): 대화 전체가 아니라 요청과 계획서만 받는다 — 토큰 절약. */
export function planReviewPrompt(text, planText) {
  return `[요청]\n${text}\n\n[계획 초안]\n${planText}\n\n당신은 이 계획을 그대로 실행할 담당자다. 실행 전에 초안을 검토해라. 파일을 수정하지 말고 코드를 읽어 확인만 해라. 초안대로 실행해도 문제없으면 첫 줄에 "판정: 동의"라고만 쓰고 한두 문장으로 이유를 덧붙여라. 고쳐야 할 점이 있으면 첫 줄에 "판정: 수정 제안"이라 쓰고, 그 아래 "- "로 시작하는 항목으로 무엇을 왜 어떻게 바꿔야 하는지 핵심만 1,500자 이내로 적어라. 사소한 표현 차이는 지적하지 말고, 실행 결과가 달라질 부분만 짚어라. 한국어로, 최종 답변에는 판정과 의견만 써라.`;
}
/** 최종안(계획 담당): 검토 의견을 반영하되, 동의 못 하는 지점은 "이견"으로 표시해 대표가 고를 수 있게 한다. */
export function planFinalPrompt(text, planText, reviewText, plannerKind) {
  const submit = plannerKind === 'claude' ? ' 파일을 수정하지 말고, 최종 계획이 완성되면 ExitPlanMode로 제출해라.' : ' 파일을 수정하거나 상태를 바꾸는 명령은 실행하지 말고, 최종 답변에는 최종 계획 본문만 써라.';
  return `[요청]\n${text}\n\n[당신이 쓴 계획 초안]\n${planText}\n\n[실행 담당의 검토 의견]\n${reviewText}\n\n검토 의견 중 타당한 것은 반영해 최종 계획을 써라. 계획 본문의 첫 줄은 반드시 "결론: 합의" 또는 "결론: 이견" 중 하나다. 검토 의견을 모두 받아들였거나 남은 차이가 사소하면 "결론: 합의". 실행 결과가 달라질 만큼 중요한 지점에서 검토 의견에 동의할 수 없으면 "결론: 이견"이라 쓰고, 둘째 줄부터 "이견 사유:"로 어느 지점을 왜 반대하는지 3줄 이내로 적은 뒤 당신의 최종 계획을 이어 써라. 계획은 한국어로, 실행자가 그대로 따를 수 있게 핵심만 3,000자 이내로, 코드 전문 없이 바꿀 파일·함수·내용만 적어라.${submit}`;
}
/** 검토 답변 첫 줄의 판정. 못 읽으면 수정 제안으로 본다(초안을 그냥 밀어붙이는 쪽보다 안전). */
export function parsePlanVerdict(reviewText) {
  const first = String(reviewText || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return /판정\s*[:：]\s*동의/.test(first) ? 'agree' : 'revise';
}
/** 최종안 첫 줄의 결론. "이견"이 아니면 합의로 본다. */
export function parsePlanConclusion(planText) {
  const first = String(planText || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return /결론\s*[:：]\s*이견/.test(first) ? 'dispute' : 'agree';
}

/** 계획 분담 + 합의: 실행 담당이 초안을 검토하고(동의면 끝), 계획 담당이 의견을 반영해 최종안을 쓴다.
 * 최종안이 "이견"이면 대표가 어느 안으로 실행할지 고를 때까지 멈춘다(paused). 검토·최종안을 못 받으면 초안대로 간다. */
async function runPlanDebate(agentId, text, cfg, planner, planStartMessageId) {
  const agent = Agents.get(agentId);
  const plan = findPlanMessage(agentId, planStartMessageId);
  if (!agent || !plan) return {};
  const reviewer = singleModelOf(agent);
  note(agentId, `계획 검토 · ${KIND_LABEL[reviewer.kind]} ${withEffort(reviewer.model, reviewer.effort)}가 초안을 읽고 의견을 내는 중…`);
  const reviewPrompt = planReviewPrompt(text, plan.content);
  const reviewRun = reviewer.kind === 'claude'
    ? await runTurn(agentId, reviewPrompt, cfg, { kind: 'claude', stage: 'plan', fresh: true, model: reviewer.model, effort: reviewer.effort, tools: ['Read', 'Glob', 'Grep'], permissionMode: 'dontAsk', disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'], captureAs: 'plan_review', budgetUsd: cfg.planBudgetUsd || undefined })
    : await runTurn(agentId, reviewPrompt, cfg, { kind: reviewer.kind, stage: 'plan', fresh: true, model: reviewer.model, effort: reviewer.effort, ...READ_ONLY, captureAs: 'plan_review' });
  if (!Agents.get(agentId)) return { deleted: true };
  if (reviewRun?.stopped) return { failed: reviewRun };
  const reviewText = String(reviewRun?.text || '').trim();
  if (!reviewRun?.ok || !reviewText) {
    note(agentId, '검토 의견을 받지 못함 → 초안대로 진행');
    return {};
  }
  const verdict = parsePlanVerdict(reviewText);
  const rm = Messages.add(agentId, 'plan_review', reviewText, { provider: reviewer.kind, verdict });
  emit('message', { agent_id: agentId, message: rm });
  if (verdict === 'agree') {
    note(agentId, '검토 동의 → 초안대로 진행');
    return {};
  }

  note(agentId, `최종안 · ${KIND_LABEL[planner.kind]} ${withEffort(planner.model, planner.effort)}가 검토 의견을 반영해 최종 계획을 쓰는 중…`);
  const finalStartId = Messages.latestId(agentId);
  const finalPrompt = planFinalPrompt(text, plan.content, reviewText, planner.kind);
  let finalRun;
  if (planner.kind === 'claude') {
    planPhase.add(agentId);
    try {
      finalRun = await runTurn(agentId, finalPrompt, cfg, { kind: 'claude', stage: 'plan', fresh: true, model: planner.model, effort: planner.effort, permissionMode: 'plan', budgetUsd: cfg.planBudgetUsd || undefined });
    } finally {
      planPhase.delete(agentId);
    }
  } else {
    finalRun = await runTurn(agentId, finalPrompt, cfg, { kind: 'codex', stage: 'plan', fresh: true, model: planner.model, effort: planner.effort, sandbox: 'read-only', captureAs: 'plan' });
    if (finalRun?.ok && String(finalRun.text || '').trim() && Agents.get(agentId)) {
      const m = Messages.add(agentId, 'plan', finalRun.text.trim(), { provider: 'codex', final: true });
      emit('message', { agent_id: agentId, message: m });
    }
  }
  if (!Agents.get(agentId)) return { deleted: true };
  if (finalRun?.stopped) return { failed: finalRun };
  const finalPlan = Messages.after(agentId, finalStartId).filter((m) => m.role === 'plan').at(-1);
  if (!finalPlan) {
    note(agentId, '최종안을 받지 못함 → 초안대로 진행');
    return {};
  }
  if (parsePlanConclusion(finalPlan.content) !== 'dispute') {
    note(agentId, '합의 완료 → 최종안대로 진행');
    return {};
  }
  const current = update(agentId, { status: 'needs_attention', pending_plan: 1, plan_dispute: 1, last_response: finalPlan.content });
  note(agentId, `계획 이견 · ${KIND_LABEL[planner.kind]}(계획)와 ${KIND_LABEL[reviewer.kind]}(검토)의 의견이 갈렸습니다. 어느 안으로 실행할지 골라 주세요.`);
  push(current, '계획 이견 · 결정 필요', `${KIND_LABEL[planner.kind]} 계획 담당과 ${KIND_LABEL[reviewer.kind]} 검토 담당의 의견이 갈렸습니다.\n\n${finalPlan.content}`);
  flushUsage(agentId);
  return { paused: true };
}

/** 단일 모델 + 계획 분담: 다른 제공자가 계획서를 쓴다. 계획이 나오면 그 계획을 담은 실행 지시문을,
 * 계획 담당이 멈추거나 에이전트가 사라지면 failed/deleted를 돌려준다. 계획서를 못 받은 경우는 계획 없이 바로 실행한다. */
async function runCrossPlan(agentId, text, cfg, extra = {}) {
  const agent = Agents.get(agentId);
  const planner = crossPlanner(agent);
  const execLabel = execLabelOf(agent);
  if (planner.kind === 'codex' && !findCodexEntry()) {
    note(agentId, `Codex CLI를 찾지 못해 계획 없이 ${execLabel} 바로 실행`);
    return { prompt: text, planStartMessageId: null };
  }
  note(agentId, `계획 분담 · ${KIND_LABEL[planner.kind]} ${withEffort(planner.model, planner.effort)}가 계획서를 쓰는 중…`);
  const planStartMessageId = Messages.latestId(agentId);
  let planRun;
  if (planner.kind === 'claude') {
    planPhase.add(agentId);
    try {
      planRun = await runTurn(agentId, plannerPrompt(agentId, text, { skill: extra.skill }), cfg, { kind: 'claude', stage: 'plan', fresh: true, model: planner.model, effort: planner.effort, permissionMode: 'plan', budgetUsd: cfg.planBudgetUsd || undefined });
    } finally {
      planPhase.delete(agentId);
    }
  } else {
    planRun = await runTurn(agentId, codexPlannerPrompt(agentId, text, { skill: extra.skill }), cfg, { kind: 'codex', stage: 'plan', fresh: true, model: planner.model, effort: planner.effort, sandbox: 'read-only', images: extra.images, captureAs: 'plan' });
    if (planRun?.ok && String(planRun.text || '').trim() && Agents.get(agentId)) {
      const m = Messages.add(agentId, 'plan', planRun.text.trim(), { provider: 'codex' });
      emit('message', { agent_id: agentId, message: m });
    }
  }
  if (!Agents.get(agentId)) return { deleted: true };
  if (!planRun || planRun.stopped) return { failed: planRun || { ok: false, text: '계획 단계가 끝나지 않았습니다.' } };
  const hasPlan = Messages.after(agentId, planStartMessageId).some((m) => m.role === 'plan');
  if (!hasPlan) {
    // 계획 담당의 한도·오류로 이 지시 전체를 막지는 않는다: 실행 모델이 계획 없이 그대로 맡는다.
    const why = isUsageLimitError(planRun) ? `${KIND_LABEL[planner.kind]} 한도 도달` : isPlanBudgetExceeded(planRun) ? '계획 예산 초과' : '계획서를 받지 못함';
    note(agentId, `${why} → 계획 없이 ${execLabel} 바로 실행`);
    return { prompt: text, planStartMessageId: null };
  }
  if (extra.debate && usesPlanDebate(agent)) {
    const d = await runPlanDebate(agentId, text, cfg, planner, planStartMessageId);
    if (d.deleted) return { deleted: true };
    if (d.failed) return { failed: d.failed };
    if (d.paused) return { paused: true };
  }
  note(agentId, `계획 완료 → ${execLabel} 실행`);
  return { prompt: execPrompt(agentId, planStartMessageId), planStartMessageId };
}

export function isUsageLimitError(result) {
  if (!result || result.ok) return false;
  const text = [result.text, result.subtype, result.error].filter(Boolean).join(' ').toLowerCase();
  return /rate[_ -]?limit|usage limit|quota|resource[_ ]exhausted|too many requests|insufficient_quota|weekly limit|5-hour limit|five hour limit|capacity[_ ]exhausted|out of (?:plan )?credits|한도.{0,8}(소진|초과|도달)|사용량.{0,8}(소진|초과|도달)/i.test(text);
}

/** Network blips, overloaded API, a crashed CLI: worth one automatic retry. */
export function isTransientError(result) {
  if (!result || result.ok) return false;
  if (result.subtype === 'error_max_turns' || result.subtype === 'error_max_budget_usd') return false;
  const text = [result.text, result.subtype, result.error, result.crashed ? 'crashed' : ''].filter(Boolean).join(' ');
  return explainError(text).transient;
}

/** The CLI's result subtype when --max-budget-usd cuts a plan turn off mid-run. */
function isPlanBudgetExceeded(result) {
  return result?.subtype === 'error_max_budget_usd';
}

function activateProvider(agentId, fromKind, toKind, stage = null) {
  const nextSession = AgentSessions.get(agentId, toKind)?.session_id || null;
  const switched = update(agentId, { kind: toKind, session_id: nextSession, status: 'working', last_error: null, collab_stage: stage });
  note(agentId, `구독 한도 감지 · ${KIND_LABEL[fromKind]} → ${KIND_LABEL[toKind]} 자동 전환`);
  push(switched, '모델 자동 전환', `${KIND_LABEL[fromKind]} 한도에 도달해 ${KIND_LABEL[toKind]}가 같은 작업을 이어갑니다.`);
  return switched;
}

/** Pure text builder for a failover continuation, so the plan (when one exists) rides along
 * instead of being silently dropped and re-derived (or skipped) by the new provider. */
export function failoverContinuation(text, planContent) {
  const preamble = '이전 모델이 구독 한도에 도달해 자동으로 전환되었습니다. 현재 워크스페이스 상태를 먼저 확인하고, 이미 완료된 작업을 반복하거나 되돌리지 말고 아래 요청을 이어서 완료하세요.';
  return planContent ? `${preamble}\n\n${text}\n\n[계획]\n${planContent}` : `${preamble}\n\n${text}`;
}

async function completeOrFailover(agentId, result, originalText, cfg, allowFailover, planStartMessageId = null) {
  const agent = Agents.get(agentId);
  if (agent && result && !result.ok && !result.stopped && !isUsageLimitError(result) && !retried.has(agentId) && isTransientError(result)) {
    // 잠깐 기다렸다 같은 대화를 이어서 한 번 더. 두 번째도 실패하면 그때 오류로 알린다.
    retried.add(agentId);
    const { plain } = explainError([result.text, result.subtype, result.error].filter(Boolean).join(' '));
    note(agentId, `${plain} · ${Math.round(RETRY_DELAY_MS / 1000)}초 뒤 자동으로 한 번 더 시도합니다`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    if (!Agents.get(agentId)) return;
    const efforts = stageEfforts(agent);
    const model = agent.pipeline === 'auto' ? agent.exec_model : agent.model;
    const effort = agent.pipeline === 'auto' ? efforts.exec : agent.effort || null;
    const again = await runTurn(agentId, '직전 작업이 일시적인 오류로 끊겼습니다. 이미 된 부분은 건너뛰고 남은 일을 이어서 마무리하세요.', cfg, { stage: 'exec', model, effort });
    return completeOrFailover(agentId, again, originalText, cfg, allowFailover, planStartMessageId);
  }
  if (!agent || !allowFailover || !agent.auto_failover || !isUsageLimitError(result)) {
    return finish(agentId, result);
  }

  const fromKind = result?.provider || agent.kind;
  const toKind = otherProvider(fromKind);
  if (toKind === 'codex' && !findCodexEntry()) return finish(agentId, result);

  activateProvider(agentId, fromKind, toKind);
  const planContent = planStartMessageId != null ? findPlanMessage(agentId, planStartMessageId)?.content || null : null;
  const continuation = failoverContinuation(originalText, planContent);
  return runPipeline(agentId, continuation, cfg, { allowFailover: false });
}

async function runProviderWork(agentId, text, cfg, { kind, phase, autoRoute = false, triageText = null, crossPlan = false }) {
  let agent = Agents.get(agentId);
  if (!agent) return null;
  const workspace = Workspaces.get(agent.workspace_id);
  if (!workspace) return null;
  const efforts = stageEfforts(agent);

  if (kind === 'claude' && autoRoute && agent.pipeline === 'auto') {
    note(agentId, `${STAGE_LABEL[phase]} · ${agent.triage_model || 'haiku'}가 작업 난이도를 판단하는 중…`);
    const t = await triage(agent, workspace, triageText || text, cfg);
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
      planRun = await runTurn(agentId, plannerPrompt(agentId, text), cfg, { kind, phase, stage: 'plan', fresh: true, model: agent.plan_model, effort: efforts.plan, permissionMode: 'plan', budgetUsd: cfg.planBudgetUsd || undefined });
    } finally {
      planPhase.delete(agentId);
    }
    const hasPlan = Messages.after(agentId, planStartMessageId).some((m) => m.role === 'plan');
    const budgetHit = isPlanBudgetExceeded(planRun);
    if (!planRun || (!planRun.ok && !hasPlan && !budgetHit) || planRun.crashed || planRun.stopped) return planRun;
    if (!hasPlan && budgetHit) {
      note(agentId, `${STAGE_LABEL[phase]} · 계획 예산 초과 → 계획 없이 ${withEffort(agent.exec_model, efforts.exec)} 바로 실행`);
      return runTurn(agentId, text, cfg, { kind, phase, stage: 'exec', model: agent.exec_model, effort: efforts.exec });
    }
    note(agentId, `${STAGE_LABEL[phase]} · 계획 완료 → ${withEffort(agent.exec_model, efforts.exec)} 실행`);
    return runTurn(agentId, execPrompt(agentId, planStartMessageId), cfg, { kind, phase, stage: 'exec', model: agent.exec_model, effort: efforts.exec });
  }

  if (crossPlan && phase === 'implement' && usesCrossPlan(agent)) {
    const cp = await runCrossPlan(agentId, text, cfg);
    if (cp.deleted) return null;
    if (cp.failed) return cp.failed;
    text = cp.prompt;
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
      // Review carries its own diff/plan/git context (buildReviewPrompt), so a resumed session
      // would only add the reviewer's own unrelated history for it to re-read.
      ...(phase === 'review' ? { tools: ['Read', 'Glob', 'Grep'], permissionMode: 'dontAsk', disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'], fresh: true } : {}),
    });
  }

  return runTurn(agentId, text, cfg, { kind, phase, ...(phase === 'review' ? { ...READ_ONLY, fresh: true } : {}) });
}

async function runWorkWithLimitFallback(agentId, text, cfg, kind, phase, autoRoute, triageText = null, crossPlan = false) {
  let result = await runProviderWork(agentId, text, cfg, { kind, phase, autoRoute, triageText, crossPlan });
  const agent = Agents.get(agentId);
  if (!agent || result?.ok || !agent.auto_failover || !isUsageLimitError(result)) return { result, kind };

  const fallback = otherProvider(kind);
  if (fallback === 'codex' && !findCodexEntry()) return { result, kind };
  activateProvider(agentId, kind, fallback, phase);
  const continuation = `이전 구현 모델이 구독 한도에 도달했습니다. 같은 협업 단계와 원래 요청을 이어서 완료하세요. 현재 워크스페이스 상태를 먼저 확인하고 이미 완료된 작업은 반복하거나 되돌리지 마세요.\n\n${text}`;
  result = await runProviderWork(agentId, continuation, cfg, { kind: fallback, phase, autoRoute, triageText });
  return { result, kind: fallback };
}

async function collaborationSnapshot(agentId, workspace) {
  const [git, diff, messages] = await Promise.all([
    gitSummary(workspace.path, 5),
    gitDiff(workspace.path),
    Promise.resolve(Messages.recentByRole(agentId, CONVO_ROLES, 30)),
  ]);
  const plan = Messages.recentByRole(agentId, ['plan'], 1)[0];
  // The most recent user turn and the plan already ride along as their own prompt sections
  // (original_request, plan), so drop them here instead of sending the same text twice.
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const trimmed = messages.filter((m, i) => m.role !== 'plan' && i !== lastUserIdx);
  return {
    recentContext: compactConversation(trimmed, 3000),
    gitManifest: formatGitManifest(git),
    diff,
    plan: plan?.content || '',
  };
}

async function runCollaboration(agentId, originalText, cfg, { requestText, triageText } = {}) {
  let agent = Agents.get(agentId);
  if (!agent) return;
  const workspace = Workspaces.get(agent.workspace_id);
  let implementer = agent.kind;
  let reviewer = otherProvider(implementer);
  const shortRequest = requestText || originalText;

  note(agentId, `교차 협업 시작 · ${KIND_LABEL[implementer]} 구현 → ${KIND_LABEL[reviewer]} 리뷰 → ${KIND_LABEL[implementer]} 수정`);
  update(agentId, { collab_stage: 'implement' });
  const implementation = await runWorkWithLimitFallback(agentId, originalText, cfg, implementer, 'implement', true, triageText, true);
  if (!implementation.result?.ok) return finish(agentId, implementation.result, { title: '협업 구현 오류' });

  implementer = implementation.kind;
  reviewer = otherProvider(implementer);
  if (reviewer === 'codex' && !findCodexEntry()) {
    return finish(agentId, { ok: false, text: '구현은 완료했지만 Codex CLI를 찾지 못해 교차 리뷰를 시작할 수 없습니다.' }, { title: '협업 리뷰 오류' });
  }

  const beforeReview = await collaborationSnapshot(agentId, workspace);
  const reviewPrompt = buildReviewPrompt({
    originalText: shortRequest,
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

  // The implementer resumes its own session with full edit access, so unlike the review step it
  // doesn't need a git snapshot handed to it — it can check current file state itself.
  const revisionPrompt = buildRevisionPrompt({ originalText: shortRequest, reviewText: review.text, implementer, reviewer });
  update(agentId, { collab_stage: 'revise' });
  note(agentId, `최종 수정 · ${KIND_LABEL[implementer]}가 리뷰를 검증하고 마무리합니다`);
  const revision = await runWorkWithLimitFallback(agentId, revisionPrompt, cfg, implementer, 'revise', false);
  return finish(agentId, revision.result, { title: revision.result?.ok ? '교차 협업 완료' : '최종 수정 오류' });
}

async function runPipeline(agentId, text, cfg, flow = { allowFailover: true }, extra = {}) {
  let agent = Agents.get(agentId);
  const workspace = Workspaces.get(agent.workspace_id);
  const efforts = stageEfforts(agent);

  // 서버가 넣은 후속 지시(배경 작업 결과 확인 등)는 판단·계획 없이 실행 모델이 바로 이어받는다.
  if (extra.direct) {
    const autoExec = agent.kind === 'claude' && agent.pipeline === 'auto';
    const r = await runTurn(agentId, text, cfg, autoExec ? { stage: 'exec', model: agent.exec_model, effort: efforts.exec } : { stage: 'manual', images: extra.images });
    return completeOrFailover(agentId, r, text, cfg, flow.allowFailover !== false);
  }

  if (agent.kind !== 'claude' || agent.pipeline !== 'auto') {
    let prompt = text;
    let planStartMessageId = null;
    if (usesCrossPlan(agent) && flow.allowFailover !== false) { // 한도 전환으로 이어받은 지시는 계획이 이미 붙어 있다
      const cp = await runCrossPlan(agentId, text, cfg, { ...extra, debate: true });
      if (cp.deleted || cp.paused) return; // paused: 대표가 계획 이견을 고르면 executePlan이 이어간다
      if (cp.failed) return finish(agentId, cp.failed);
      prompt = cp.prompt;
      planStartMessageId = cp.planStartMessageId;
    }
    // Codex has no equivalent of Claude's --add-dir Read access, so photos ride along as -i flags
    // instead — only meaningful on this single-turn path, since Codex never enters the plan/exec split below.
    const r = await runTurn(agentId, prompt, cfg, { stage: 'manual', images: extra.images });
    return completeOrFailover(agentId, r, text, cfg, flow.allowFailover !== false, planStartMessageId);
  }

  note(agentId, `${agent.triage_model || 'haiku'}가 자동 판단 중…`);
  const t = await triage(agent, workspace, extra.triageText || text, cfg);
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
    planRun = await runTurn(agentId, plannerPrompt(agentId, text, { skill: extra.skill }), cfg, { stage: 'plan', fresh: true, model: agent.plan_model, effort: efforts.plan, permissionMode: 'plan', budgetUsd: cfg.planBudgetUsd || undefined });
  } finally {
    planPhase.delete(agentId);
  }
  const hasPlan = Messages.after(agentId, planStartMessageId).some((m) => m.role === 'plan');
  const budgetHit = isPlanBudgetExceeded(planRun);
  if (!planRun || (!planRun.ok && !hasPlan && !budgetHit) || planRun.crashed || planRun.stopped) {
    return completeOrFailover(agentId, planRun, text, cfg, flow.allowFailover !== false);
  }
  if (!hasPlan && budgetHit) {
    note(agentId, `계획 예산 초과 → 계획 없이 ${withEffort(agent.exec_model, efforts.exec)} 바로 실행`);
    const r = await runTurn(agentId, text, cfg, { stage: 'exec', model: agent.exec_model, effort: efforts.exec });
    return completeOrFailover(agentId, r, text, cfg, flow.allowFailover !== false);
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
  return completeOrFailover(agentId, execRun, text, cfg, flow.allowFailover !== false, planStartMessageId);
}

const COMPACT_LABEL = '대화 정리';
const compacting = new Set(); // agentIds whose summary is being written; new prompts wait

/**
 * 대화 정리: summarize the conversation with the cheap triage model, store the memo, and drop the
 * active provider session so the next turn starts small. Reading a huge history every turn is the
 * single biggest cost once an agent has been used for a while.
 */
export async function compactAgent(agentId, cfg, { reason = 'manual', skipStatusCheck = false } = {}) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (live.has(agentId) || (agent.status === 'working' && !skipStatusCheck)) throw new Error('작업이 끝난 뒤 정리하세요');
  if (compacting.has(agentId)) throw new Error('이미 정리 중입니다');
  const history = compactConversation(Messages.recentByRole(agentId, CONVO_ROLES, 80), 14000);
  if (!history.trim()) throw new Error('정리할 대화가 없습니다');
  compacting.add(agentId);
  try {
    return await compactAgentInner(agentId, agent, history, cfg, reason);
  } finally {
    compacting.delete(agentId);
  }
}

const COMPACT_SYSTEM_PROMPT = `아래는 코딩 에이전트와 사용자의 대화 기록이다. 다음 대화가 새 세션에서 시작되어도 이어갈 수 있도록 한국어로 "이어가기 메모"를 써라.
형식: 줄머리 "- "로 시작하는 짧은 항목만. 섹션: 목표 / 지금까지 한 일 / 다룬 파일(경로 그대로 나열) / 결정한 것 / 남은 일 / 주의할 점. 전체 1,500자 이내.
새 세션은 이 메모만 보고 이어가며 파일을 처음부터 다시 찾지 않아야 하므로, 다룬 파일 경로와 현재 상태는 정확히 남겨라.`;

/** A memo this short or this hedged is worse than no summary: the next session would silently
 * start from nothing while believing it has context. Fail loudly instead of clearing the session. */
function isUsableMemo(memo) {
  if (!memo || memo.length < 80) return false;
  return !/기록이 없|스니펫|알 수 없/.test(memo);
}

async function compactAgentInner(agentId, agent, history, cfg, reason) {
  const memo = await runClaudeOnceText({ cwd: TRIAGE_DIR, prompt: history, systemPrompt: COMPACT_SYSTEM_PROMPT, model: agent.triage_model || 'haiku', cfg });
  if (!isUsableMemo(memo)) throw new Error('요약 생성에 실패했습니다');
  AgentSessions.remove(agentId, agent.kind);
  const fields = { carry_note: memo, context_tokens: 0 };
  fields.session_id = null;
  // 요약 뒤에는 새 세션이라 PC 클로드 앱의 기록과는 더 이상 같은 파일이 아니다.
  if (agent.desktop_host_id) { fields.desktop_host_id = null; fields.transcript_pos = 0; note(agentId, 'PC 클로드 앱 대화 연동 해제 · 요약해서 새 대화로 넘어가면 PC 쪽과 따로 갑니다'); }
  update(agentId, fields);
  const m = Messages.add(agentId, 'handoff', `${COMPACT_LABEL} · 이어가기 메모\n${memo}`, { compact: true, reason });
  emit('message', { agent_id: agentId, message: m });
  note(agentId, reason === 'auto'
    ? `${COMPACT_LABEL} · 대화가 길어져 요약해 두고 새 대화로 이어갑니다`
    : reason === 'model-change'
    ? `${COMPACT_LABEL} · 모델이 바뀌어 요약해 두고 새 모델로 이어갑니다`
    : `${COMPACT_LABEL} · 요약해 두고 새 대화로 이어갑니다`);
  return memo;
}

function maybeAutoCompact(agentId, cfg) {
  const limit = Number(cfg?.compactAfterTokens) || 0;
  const agent = Agents.get(agentId);
  if (!limit || !agent || agent.desktop_host_id || agent.context_tokens < limit) return; // PC 연동 담당자는 자동 요약으로 세션을 갈아타지 않는다
  compactAgent(agentId, cfg, { reason: 'auto' }).catch((e) => note(agentId, `${COMPACT_LABEL} 실패 · ${e.message}`));
}

/** Same check, run before a turn starts instead of after one finishes — so a conversation that
 * crossed the limit right after the last turn doesn't pay one more full-history read before it rotates. */
async function precompactIfNeeded(agentId, cfg) {
  const limit = Number(cfg?.compactAfterTokens) || 0;
  const agent = Agents.get(agentId);
  if (!limit || !agent || agent.desktop_host_id || agent.context_tokens < limit) return; // PC 연동 담당자는 자동 요약으로 세션을 갈아타지 않는다
  try {
    await compactAgent(agentId, cfg, { reason: 'auto', skipStatusCheck: true });
  } catch (e) {
    note(agentId, `${COMPACT_LABEL} 실패 · ${e.message}`);
  }
}

/** Records the working tree right before a run so the whole run can be undone as one step. */
async function snapshotBefore(agentId, workspace) {
  turnSnap.delete(agentId);
  try {
    const tree = await snapshotTree(workspace.path);
    if (tree) turnSnap.set(agentId, Snapshots.create(agentId, tree));
  } catch (e) {
    console.error('[snapshot]', e.message);
  }
}
/** Compares the tree after the run with the one before it and posts a 되돌리기 card if anything changed. */
async function snapshotAfter(agentId) {
  const snap = turnSnap.get(agentId);
  turnSnap.delete(agentId);
  if (!snap) return;
  const agent = Agents.get(agentId);
  const workspace = agent && Workspaces.get(agent.workspace_id);
  if (!workspace) return;
  try {
    const after = await snapshotTree(workspace.path);
    if (!after) return;
    const changes = after === snap.before_tree ? { files: [], added: 0, removed: 0 } : await treeChanges(workspace.path, snap.before_tree, after);
    Snapshots.finish(snap.id, after, changes.files.length);
    Snapshots.prune(agentId);
    if (!changes.files.length) return;
    const names = changes.files.slice(0, 5).map((f) => path.basename(f)).join(', ') + (changes.files.length > 5 ? ' 외' : '');
    const deliverables = deliverableFiles(workspace.path, changes.files);
    const m = Messages.add(agentId, 'undo', `이번 작업으로 파일 ${changes.files.length}개가 바뀌었습니다 · ${names}`, {
      snapshot_id: snap.id, files: changes.files.length, added: changes.added, removed: changes.removed,
      ...(deliverables.length ? { deliverables } : {}),
    });
    emit('message', { agent_id: agentId, message: m });
  } catch (e) {
    console.error('[snapshot]', e.message);
  }
}

/** Changed files the owner would want on the phone (videos, PDFs, images, docs…), with sizes. */
export function deliverableFiles(workspacePath, files, limit = 8) {
  const out = [];
  for (const rel of files) {
    if (!DELIVERABLE_RE.test(rel)) continue;
    const abs = path.join(workspacePath, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      out.push({ path: rel.replace(/\\/g, '/'), name: path.basename(rel), size: st.size });
    } catch {}
    if (out.length >= limit) break;
  }
  return out;
}

/** 앞선 작업이 끝났으니 줄 서 있던 다음 지시를 시작한다. 정리 중이면 잠깐 뒤에 다시. */
function drainQueue(agentId, cfg, attempt = 0) {
  const next = Queue.forAgent(agentId)[0];
  if (!next) return;
  const agent = Agents.get(agentId);
  if (!agent || live.has(agentId) || agent.status === 'working' || agent.pending_plan) return;
  if (compacting.has(agentId)) {
    if (attempt < 30) setTimeout(() => drainQueue(agentId, cfg, attempt + 1), 2000);
    return;
  }
  Queue.remove(next.id);
  emit('queue.changed', { agent_id: agentId, count: Queue.forAgent(agentId).length });
  let extra = {};
  try { extra = next.extra_json ? JSON.parse(next.extra_json) : {}; } catch {}
  note(agentId, `대기열 · 줄 서 있던 다음 지시를 시작합니다${Queue.forAgent(agentId).length ? ` (남은 ${Queue.forAgent(agentId).length}건)` : ''}`);
  try {
    startPrompt(agentId, next.text, cfg, extra);
  } catch (e) {
    note(agentId, `대기열 지시를 시작하지 못했습니다 · ${e.message}`);
  }
}

function finish(agentId, r, opts = {}) {
  liveStats.delete(agentId);
  flushUsage(agentId);
  setBlanketAllow(agentId, false);
  runWatch.delete(agentId);
  snapshotAfter(agentId);
  skipOwnTranscript(agentId);
  const agent = Agents.get(agentId);
  if (!agent) return;
  if (!r) return;
  if (r.ok) setTimeout(() => maybeAutoCompact(agentId, opts.cfg || lastCfg), 500);
  const ok = !!r.ok;
  retried.delete(agentId);
  if (!ok && !r.stopped) {
    const errorText = errorMessageText(r.text || r.subtype || '문제가 발생했습니다.');
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
  push(a, opts.title || (ok ? '완료' : r.stopped ? '멈춤 · 확인 필요' : '오류'), ok ? r.text || '작업이 끝났습니다.' : r.stopped ? r.text : errorMessageText(r.text || '문제가 발생했습니다.'));
  // 줄 서 있던 지시가 있으면 이어서. 감시 장치가 멈춘 경우는 대표 판단이 먼저라 이어가지 않는다.
  if (!r.stopped) setTimeout(() => drainQueue(agentId, opts.cfg || lastCfg), 800);
  return r;
}

/** Chat-visible fallback text for a prompt that is only attachments/links (no typed message). */
function describeAttachments(attachments, links) {
  const imgN = attachments.filter((a) => a.kind === 'image').length;
  const vidN = attachments.filter((a) => a.kind === 'video').length;
  const parts = [];
  if (imgN) parts.push(`(사진 ${imgN}장)`);
  if (vidN) parts.push(`(동영상 ${vidN}개)`);
  if (links.length) parts.push(`(링크 ${links.length}개)`);
  return parts.join(' ');
}

let lastCfg = null;
/** Busy agent: park the prompt; it starts by itself when the current run settles. */
export function enqueuePrompt(agentId, text, extra = {}) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (!text.trim() && !(extra.attachments || []).length && !(extra.links || []).length) throw new Error('내용이 없습니다');
  const row = Queue.add(agentId, text, { attachments: extra.attachments || [], links: extra.links || [], ...(extra.direct ? { direct: true } : {}), ...(extra.display ? { display: extra.display } : {}) });
  const count = Queue.forAgent(agentId).length;
  note(agentId, `대기열 · ${count}번째로 받아 두었습니다 · 지금 작업이 끝나면 이어서 시작합니다`);
  emit('queue.changed', { agent_id: agentId, count });
  return { row, count };
}
export function queuedPrompts(agentId) {
  return Queue.forAgent(agentId).map((q) => {
    let extra = {};
    try { extra = q.extra_json ? JSON.parse(q.extra_json) : {}; } catch {}
    return { id: q.id, text: extra.display || q.text, created_at: q.created_at, auto: !!extra.direct };
  });
}

/** 줄 세운 지시를 지금 돌고 있는 Claude 프로세스에 바로 넣는다(데스크톱의 "처리 중 끼워 넣기"와 같은 동작).
 * 모델이 지금 단계를 마치는 대로 이 지시를 읽는다. Codex는 입력을 열어 둘 수 없어 줄에 남긴다. */
export function steerQueued(agentId, qid) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  const q = Queue.get(qid);
  if (!q || q.agent_id !== agentId) throw new Error('대기열에 없는 지시입니다');
  const entry = live.get(agentId);
  if (!entry) {
    // 이미 끝났으면 굳이 끼워 넣을 필요 없이 바로 시작한다.
    drainQueue(agentId, lastCfg);
    return Agents.get(agentId);
  }
  if (entry.provider !== 'claude') throw new Error(`${KIND_LABEL[entry.provider] || entry.provider}는 처리 중 끼워 넣기가 안 됩니다. 작업이 끝나면 이어서 시작합니다`);
  if (typeof entry.child?.steer !== 'function') throw new Error('지금 단계에는 끼워 넣을 수 없습니다. 작업이 끝나면 이어서 시작합니다');
  let extra = {};
  try { extra = q.extra_json ? JSON.parse(q.extra_json) : {}; } catch {}
  const attachments = extra.attachments || [];
  const links = extra.links || [];
  const text = `[대표가 처리 중에 끼워 넣은 지시]\n${q.text}${attachmentBlock(attachments, links)}`;
  if (!entry.child.steer(text)) throw new Error('지금은 끼워 넣을 수 없습니다. 작업이 끝나면 이어서 시작합니다');
  Queue.remove(qid);
  emit('queue.changed', { agent_id: agentId, count: Queue.forAgent(agentId).length });
  const meta = { steered: true };
  if (attachments.length) meta.attachments = attachments;
  if (links.length) meta.links = links;
  const userMsg = Messages.add(agentId, 'user', q.text.trim() || describeAttachments(attachments, links), meta);
  emit('message', { agent_id: agentId, message: userMsg });
  note(agentId, '끼워 넣기 · 처리 중인 작업에 바로 전달했습니다. 지금 단계를 마치는 대로 반영됩니다');
  return Agents.get(agentId);
}
export function removeQueued(agentId, id) {
  const q = Queue.get(id);
  if (!q || q.agent_id !== agentId) return false;
  Queue.remove(id);
  emit('queue.changed', { agent_id: agentId, count: Queue.forAgent(agentId).length });
  return true;
}

export function startPrompt(agentId, text, cfg, extra = {}) {
  lastCfg = cfg;
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (live.has(agentId) || agent.status === 'working') throw new Error('이미 작업 중입니다');
  if (compacting.has(agentId)) throw new Error('대화를 정리하는 중입니다. 잠시 후 다시 보내세요');
  const workspace = Workspaces.get(agent.workspace_id);
  if (!workspace) throw new Error('workspace not found');
  if (agent.collab_mode && agent.kind === 'claude' && !findCodexEntry()) throw new Error('교차 협업에는 Codex CLI가 필요합니다');

  const attachments = extra.attachments || [];
  const links = extractLinks(text, extra.links || []);
  if (!text.trim() && !attachments.length && !links.length) throw new Error('내용이 없습니다');

  // PC 클로드 앱에서 그사이 오간 대화가 있으면 먼저 화면에 옮겨 순서를 맞춘다.
  syncDesktopTranscript(agentId);
  liveStats.delete(agentId);
  usageAcc.delete(agentId);
  // `/이름 인자` at the start of the message swaps in that skill's SKILL.md as the model text,
  // regardless of provider or pipeline stage — the CLIs' own native skill loading only ever
  // applies to the plain execution turn, not the triage/plan stages this app adds around it.
  const command = resolveSkillCommand(text, listSkills(workspace.path));
  const storedContent = extra.display || text.trim() || describeAttachments(attachments, links);
  const meta = {};
  if (attachments.length) meta.attachments = attachments;
  if (links.length) meta.links = links;
  if (command) meta.skill = { name: command.skill.name, scope: command.skill.scope, dir: command.skill.dir };
  if (extra.direct) meta.auto = true; // 서버가 넣은 후속 지시(배경 작업 감시 등)
  const userMsg = Messages.add(agentId, 'user', storedContent, Object.keys(meta).length ? meta : null);
  emit('message', { agent_id: agentId, message: userMsg });
  const updated = update(agentId, { status: 'working', last_error: null, pending_plan: 0, plan_dispute: 0, collab_stage: agent.collab_mode ? 'implement' : null });
  const triageText = command ? triageTextFor(text, command.skill) : text;
  const requestText = command ? `${command.skill.name} 스킬 요청: ${command.args || text.trim()}` : text;
  const modelText = (command ? expandSkill(command.skill, command.args) : text) + attachmentBlock(attachments, links);
  const images = attachments.filter((a) => a.kind === 'image').map((a) => path.join(UPLOAD_DIR, a.view || a.file));
  const task = snapshotBefore(agentId, workspace).then(() => precompactIfNeeded(agentId, cfg)).then(() =>
    agent.collab_mode && !extra.direct
      ? runCollaboration(agentId, modelText, cfg, { requestText, triageText })
      : runPipeline(agentId, modelText, cfg, { allowFailover: true }, { images, triageText, skill: command?.skill || null, direct: !!extra.direct })
  );
  task.catch((e) => {
    console.error('[pipeline]', e);
    finish(agentId, { ok: false, text: e.message });
  });
  return updated;
}

/** side: 계획 이견일 때 대표의 선택. 'planner'는 최종안 그대로, 'reviewer'는 갈린 지점을 검토 의견대로. */
export function executePlan(agentId, cfg, side = 'planner') {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (live.has(agentId)) throw new Error('이미 작업 중입니다');
  if (!agent.pending_plan) throw new Error('실행 대기 중인 계획이 없습니다');
  usageAcc.delete(agentId);
  const dispute = !!agent.plan_dispute;
  const updated = update(agentId, { status: 'working', pending_plan: 0, plan_dispute: 0, collab_stage: null });
  const efforts = stageEfforts(agent);
  // 교차 모델(auto)만 계획·실행 모델이 따로 있다. 계획 분담(manual)은 에이전트의 단일 실행 모델이 맡는다.
  const autoExec = agent.kind === 'claude' && agent.pipeline === 'auto';
  const execLabel = autoExec ? withEffort(agent.exec_model, efforts.exec) : execLabelOf(agent);
  const decision = dispute ? (side === 'reviewer' ? '검토 담당 안 선택' : '계획 담당 안 선택') : '계획 승인';
  note(agentId, `${decision} → ${execLabel} 실행`);
  const prompt = dispute && side === 'reviewer' ? execPromptReviewerSide(agentId) : execPrompt(agentId, 0);
  const turnOpts = autoExec ? { stage: 'exec', model: agent.exec_model, effort: efforts.exec } : { stage: 'manual' };
  snapshotBefore(agentId, Workspaces.get(agent.workspace_id))
    .then(() => runTurn(agentId, prompt, cfg, turnOpts))
    .then((r) => completeOrFailover(agentId, r, prompt, cfg, true))
    .catch((e) => finish(agentId, { ok: false, text: e.message }));
  return updated;
}

export function switchProvider(agentId, kind) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (!['claude', 'codex', 'gemini'].includes(kind)) throw new Error('provider must be claude|codex|gemini');
  if (live.has(agentId) || agent.status === 'working' || agent.status === 'needs_attention') {
    throw new Error('작업 또는 승인이 끝난 뒤 전환하세요');
  }
  if (agent.pending_plan) throw new Error('대기 중인 계획을 실행하거나 새 작업으로 초기화한 뒤 전환하세요');
  if (kind === 'codex' && !findCodexEntry()) throw new Error('Codex CLI를 찾지 못했습니다');
  if (kind === 'gemini' && !findGeminiEntry()) throw new Error('Antigravity CLI(agy)를 찾지 못했습니다');
  if (kind === 'gemini' && !hasGeminiAccounts()) throw new Error('설정에서 Google 계정을 먼저 연결하세요');
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
