// Pending approval registry: the MCP approver (spawned by Claude) long-polls here,
// the phone UI resolves via REST, and this module bridges the two.
import { Approvals, Agents, Messages, Workspaces } from './db.js';
import { outsideRisk } from './guard.js';
import { emit } from './bus.js';
import { sendPush } from './push.js';
import { planPhase } from './state.js';

const pending = new Map(); // approvalId -> { promise, resolve }
const results = new Map(); // approvalId -> result (kept briefly for re-polls)
// "이번 작업 동안 모두 허용": agents whose remaining tool requests are allowed without asking,
// until the current run settles (cleared by the runner) or the owner switches it off.
const blanket = new Map(); // agentId -> { since, count }

export function setBlanketAllow(agentId, on) {
  const was = blanket.has(agentId);
  if (on) { if (!was) blanket.set(agentId, { since: Date.now(), count: 0 }); }
  else blanket.delete(agentId);
  if (was !== blanket.has(agentId)) emit('blanket.changed', { agent_id: agentId, on: !!on });
  return blanket.has(agentId);
}
export function blanketAllow(agentId) {
  return blanket.get(agentId) || null;
}

export function summarizeInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'Bash') return input.command || '';
  if (['Write', 'Edit', 'Read', 'NotebookEdit'].includes(toolName)) return input.file_path || '';
  if (toolName === 'AskUserQuestion') return (input.questions || []).map((q) => q.question).join(' / ');
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

export function requestApproval(agentId, toolName, input, opts = {}) {
  const agent = Agents.get(agentId);
  if (!agent) return null;
  // 작업 폴더 밖 변경은 되돌리기가 못 잡으므로 묶음 허용과 상관없이 대표에게 직접 묻는다.
  const workspace = Workspaces.get(agent.workspace_id);
  const risk = opts.risk === 'outside' || outsideRisk(toolName, input, workspace?.path) ? 'outside' : null;

  // ExitPlanMode carries the finished plan. Surface it in the UI. During the pipeline's planning
  // run we deny it with a stop message, otherwise the same (planning-model) process would go on
  // to implement; the execution model then resumes the session and carries out the plan.
  if (toolName === 'ExitPlanMode') {
    const plan = typeof input?.plan === 'string' ? input.plan.trim() : '';
    if (plan) {
      const m = Messages.add(agentId, 'plan', plan);
      emit('message', { agent_id: agentId, message: m });
    }
    const approval = Approvals.create(agentId, toolName, input);
    if (planPhase.has(agentId)) {
      Approvals.resolve(approval.id, 'denied', 'plan recorded');
      return {
        approval,
        promise: Promise.resolve({
          behavior: 'deny',
          message: '계획이 기록되었습니다. 이 턴에서는 구현하지 말고 한 문장으로 마무리한 뒤 멈추세요. 실행은 다음 지시에서 진행됩니다.',
        }),
      };
    }
    Approvals.resolve(approval.id, 'allowed', 'auto');
    return { approval, promise: Promise.resolve({ behavior: 'allow', updatedInput: input }) };
  }

  const approval = Approvals.create(agentId, toolName, input, risk);
  // Questions and outside-the-workspace changes still need a human even under blanket approval;
  // everything else sails through.
  const auto = toolName !== 'AskUserQuestion' && !risk ? blanket.get(agentId) : null;
  if (auto) {
    auto.count += 1;
    Approvals.resolve(approval.id, 'allowed', 'blanket');
    const m = Messages.add(agentId, 'system', `자동 허용 · ${toolName}: ${summarizeInput(toolName, input)}`, { approval_id: approval.id });
    emit('message', { agent_id: agentId, message: m });
    return { approval, promise: Promise.resolve({ behavior: 'allow', updatedInput: input }) };
  }
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  pending.set(approval.id, { promise, resolve });

  Agents.update(agentId, { status: 'needs_attention' });
  Messages.add(agentId, 'system', `${risk ? '⚠ 작업 폴더 밖 변경 · ' : ''}승인 요청 · ${toolName}: ${summarizeInput(toolName, input)}`, { approval_id: approval.id, ...(risk ? { risk } : {}) });
  emit('approval.requested', { approval, agent: Agents.get(agentId) });
  sendPush({
    title: `${agent.name} · ${risk ? '⚠ 폴더 밖 변경 확인' : '승인 필요'}`,
    body: `${toolName}: ${summarizeInput(toolName, input)}`.slice(0, 180),
    url: `/?agent=${agentId}`,
    tag: `approval-${approval.id}`,
  }).catch(() => {});

  return { approval, promise };
}

export function waitForApproval(id) {
  if (results.has(id)) return Promise.resolve(results.get(id));
  const p = pending.get(id);
  return p ? p.promise : null;
}

export function resolveApproval(id, decision, extra = {}) {
  const approval = Approvals.get(id);
  if (!approval || approval.status !== 'pending') return null;
  const status = decision === 'allow' ? 'allowed' : 'denied';
  const updated = Approvals.resolve(id, status, extra.message || null);
  // scope 'run': this one plus every other pending request, and everything else this run asks for.
  if (decision === 'allow' && extra.scope === 'run') {
    setBlanketAllow(approval.agent_id, true);
    for (const other of Approvals.pendingForAgent(approval.agent_id)) {
      if (other.id === id || other.tool_name === 'AskUserQuestion' || other.risk) continue;
      resolveApproval(other.id, 'allow');
    }
  }

  const input = JSON.parse(approval.input_json);
  let result;
  if (decision === 'allow') {
    const updatedInput = extra.updatedInput && typeof extra.updatedInput === 'object' ? extra.updatedInput : input;
    result = { behavior: 'allow', updatedInput };
  } else {
    result = { behavior: 'deny', message: extra.message || '사용자가 휴대폰에서 거부했습니다.' };
  }
  finish(id, result);

  const stillPending = Approvals.pendingForAgent(approval.agent_id).length > 0;
  const agent = Agents.update(approval.agent_id, { status: stillPending ? 'needs_attention' : 'working' });
  Messages.add(
    approval.agent_id,
    'system',
    decision === 'allow'
      ? `승인함 · ${approval.tool_name}${extra.scope === 'run' ? ' · 이번 작업의 남은 요청도 모두 허용' : ''}`
      : `거부함 · ${approval.tool_name}${extra.message ? ` (${extra.message})` : ''}`,
    { approval_id: id }
  );
  emit('approval.resolved', { approval: updated, agent });
  return updated;
}

function finish(id, result) {
  const p = pending.get(id);
  pending.delete(id);
  results.set(id, result);
  setTimeout(() => results.delete(id), 5 * 60 * 1000).unref();
  if (p) p.resolve(result);
}

// Called when an agent process exits: nothing can consume pending decisions anymore.
export function expireApprovals(agentId) {
  for (const a of Approvals.pendingForAgent(agentId)) {
    finish(a.id, { behavior: 'deny', message: 'Agent process ended' });
  }
  Approvals.expireForAgent(agentId);
}
