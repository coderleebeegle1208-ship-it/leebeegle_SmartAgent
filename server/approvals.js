// Pending approval registry: the MCP approver (spawned by Claude) long-polls here,
// the phone UI resolves via REST, and this module bridges the two.
import { Approvals, Agents, Messages, Workspaces } from './db.js';
import { outsideRisk, insideWorkspace } from './guard.js';
import { emit } from './bus.js';
import { sendPush } from './push.js';
import { planPhase } from './state.js';

const pending = new Map(); // approvalId -> { promise, resolve }
const timers = new Map(); // approvalId -> [remindTimer, autoTimer]
// 대표가 자리를 비웠을 때: 이 시간 뒤 한 번 더 알리고, 그래도 없으면 안전한 요청만 자동 허용.
let unattended = { remindMin: 10, autoMin: 20 };
export function configureUnattended(cfg) {
  const n = (v, d) => (v === 0 ? 0 : Number(v) || d);
  unattended = { remindMin: n(cfg?.approvalRemindMin, 10), autoMin: n(cfg?.approvalAutoMin, 20) };
  return unattended;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'ToolSearch', 'Task', 'Agent', 'Skill']);
// 읽기만 하는 셸 명령. 파이프·체인은 조각마다 모두 통과해야 한다.
const READ_ONLY_CMD = /^\s*(?:ls|dir|pwd|cat|head|tail|wc|grep|rg|find|type|echo|which|where|node\s+--(?:version|test)|npm\s+(?:test|ls|--version|run\s+(?:test|lint|check|build))|git\s+(?:status|log|diff|show|branch|remote|rev-parse)|python\s+--version|sed\s+-n)\b[^>]*$/;
export function isSafeWhenUnattended(toolName, input, workspacePath) {
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return false;
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const fp = input?.file_path || input?.notebook_path;
    return !!fp && !!workspacePath && insideWorkspace(fp, workspacePath); // 작업 폴더 안 = 되돌리기 가능
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = String(input?.command || '');
    if (!cmd.trim() || /[\r\n]/.test(cmd)) return false;
    return cmd.split(/\s*(?:&&|\|\||\||;)\s*/).every((part) => READ_ONLY_CMD.test(part));
  }
  return false;
}

// 위험 등급: 초록(safe)=읽기만 함, 노랑(caution)=작업 폴더 안을 바꿈(되돌리기 가능), 빨강(danger)=되돌릴 수 없음.
// 질문(AskUserQuestion)은 등급 없음(null). 카드 색깔·알림 제목·텔레그램 문구가 모두 이 값을 쓴다.
export const LEVEL_LABEL = {
  safe: { icon: '🟢', title: '안전', note: '읽기만 하는 요청입니다. 파일이 바뀌지 않습니다.' },
  caution: { icon: '🟡', title: '주의', note: '작업 폴더 안을 바꾸는 요청입니다. 마음에 안 들면 되돌리기로 복구할 수 있습니다.' },
  danger: { icon: '🔴', title: '위험', note: '작업 폴더 밖을 바꾸거나 되돌릴 수 없는 요청입니다. 허용하면 되돌리기로 복구할 수 없습니다.' },
};
export function riskLevel(toolName, input, workspacePath, risk = null) {
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return null;
  if (risk === 'outside' || outsideRisk(toolName, input, workspacePath)) return 'danger';
  if (isSafeWhenUnattended(toolName, input, workspacePath)) {
    // 작업 폴더 안 편집은 자리 비움 자동 허용 기준으로는 "안전"이지만 파일이 바뀌므로 색은 노랑.
    return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) ? 'caution' : 'safe';
  }
  return 'caution';
}

function clearTimers(id) {
  for (const t of timers.get(id) || []) clearTimeout(t);
  timers.delete(id);
}
function armUnattended(approval, agent, toolName, input, risk) {
  const list = [];
  if (unattended.remindMin > 0) {
    list.push(setTimeout(() => {
      if (Approvals.get(approval.id)?.status !== 'pending') return;
      const m = Messages.add(agent.id, 'system', `아직 승인 대기 중 · ${unattended.remindMin}분째 답이 없습니다`, { approval_id: approval.id });
      emit('message', { agent_id: agent.id, message: m });
      sendPush({
        title: `${agent.name} · 아직 승인을 기다립니다`,
        body: `${toolName}: ${summarizeInput(toolName, input)}`.slice(0, 180),
        url: `/?agent=${agent.id}`,
        tag: `approval-${approval.id}-remind`,
      }).catch(() => {});
    }, unattended.remindMin * 60_000).unref());
  }
  const workspace = Workspaces.get(agent.workspace_id);
  if (unattended.autoMin > 0 && !risk && isSafeWhenUnattended(toolName, input, workspace?.path)) {
    list.push(setTimeout(() => {
      if (Approvals.get(approval.id)?.status !== 'pending') return;
      resolveApproval(approval.id, 'allow', { message: 'unattended', note: `${unattended.autoMin}분 동안 답이 없어 안전한 요청이라 자동 허용` });
    }, unattended.autoMin * 60_000).unref());
  }
  if (list.length) timers.set(approval.id, list);
}
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

  const level = riskLevel(toolName, input, workspace?.path, risk);
  const approval = Approvals.create(agentId, toolName, input, risk, level);
  // Questions still need a human even under blanket approval; everything else (outside-the-folder
  // changes included — they're only marked red, not gated) sails through.
  const auto = toolName !== 'AskUserQuestion' ? blanket.get(agentId) : null;
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
  armUnattended(approval, agent, toolName, input, risk);

  Agents.update(agentId, { status: 'needs_attention' });
  Messages.add(agentId, 'system', `${risk ? '⚠ 작업 폴더 밖 변경 · ' : ''}승인 요청 · ${toolName}: ${summarizeInput(toolName, input)}`, { approval_id: approval.id, ...(risk ? { risk } : {}), ...(level ? { level } : {}) });
  emit('approval.requested', { approval, agent: Agents.get(agentId) });
  const lv = level ? LEVEL_LABEL[level] : null;
  sendPush({
    title: `${lv ? `${lv.icon} ` : ''}${agent.name} · ${toolName === 'AskUserQuestion' ? '질문에 답해주세요' : risk ? '위험 · 폴더 밖 변경 확인' : lv ? `${lv.title} · 승인 필요` : '승인 필요'}`,
    body: `${toolName}: ${summarizeInput(toolName, input)}`.slice(0, 180),
    url: `/?agent=${agentId}`,
    tag: `approval-${approval.id}`,
    // 메신저(텔레그램)에서는 버튼으로 바로 답할 수 있게 승인 정보를 함께 보낸다.
    approval: { id: approval.id, tool: toolName, level, risk, question: toolName === 'AskUserQuestion' },
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
      if (other.id === id || other.tool_name === 'AskUserQuestion') continue;
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
      ? extra.note
        ? `자동 허용 · ${approval.tool_name} · ${extra.note}`
        : `승인함 · ${approval.tool_name}${extra.scope === 'run' ? ' · 이번 작업의 남은 요청도 모두 허용' : ''}${extra.via ? ` · ${extra.via}에서` : ''}`
      : `거부함 · ${approval.tool_name}${extra.message ? ` (${extra.message})` : ''}${extra.via ? ` · ${extra.via}에서` : ''}`,
    { approval_id: id }
  );
  emit('approval.resolved', { approval: updated, agent });
  return updated;
}

function finish(id, result) {
  clearTimers(id);
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
