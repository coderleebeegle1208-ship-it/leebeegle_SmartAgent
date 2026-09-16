// Claude Code PreToolUse 훅. 작업 폴더 밖을 바꾸는 요청이면 허용 방식(묻기/자동/편집 자동)과
// 상관없이 폰에 승인 카드를 띄우고 답이 올 때까지 기다린다. 밖이 아니면 아무 말 없이 통과.
// Env: APPROVER_URL, APPROVER_TOKEN, APPROVER_AGENT_ID, APPROVER_WORKSPACE (runners/claude.js가 넣음)
import { outsideRisk } from './guard.js';

const URL_BASE = process.env.APPROVER_URL;
const TOKEN = process.env.APPROVER_TOKEN;
const AGENT_ID = Number(process.env.APPROVER_AGENT_ID);
const WORKSPACE = process.env.APPROVER_WORKSPACE;

function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason },
  }));
}

async function ask(toolName, input, risk) {
  let approvalId = null;
  for (;;) {
    const res = await fetch(`${URL_BASE}/internal/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentId: AGENT_ID, toolName, input, approvalId, risk }),
    });
    if (!res.ok) return { behavior: 'deny', message: `Dashboard error ${res.status}` };
    const data = await res.json();
    if (data.pending) { approvalId = data.approvalId; continue; }
    return data.result;
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  let ev = {};
  try { ev = JSON.parse(raw || '{}'); } catch {}
  const workspace = WORKSPACE || ev.cwd;
  const risk = outsideRisk(ev.tool_name, ev.tool_input, workspace);
  if (!risk) return process.exit(0);
  if (!URL_BASE || !TOKEN || !AGENT_ID) return decide('deny', `${risk} · 승인 서버 연결 정보가 없어 막았습니다`);
  try {
    const r = await ask(ev.tool_name, ev.tool_input, 'outside');
    if (r?.behavior === 'allow') decide('allow', '대표가 폰에서 허용했습니다');
    else decide('deny', r?.message || '대표가 폰에서 거부했습니다');
  } catch (e) {
    decide('deny', `${risk} · 승인 요청 실패: ${e.message}`);
  }
});
