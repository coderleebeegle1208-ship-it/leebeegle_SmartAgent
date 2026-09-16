// 긴 작업 진행률. 두 가지 경로가 있다.
//  - 담당 에이전트가 mcp__approver__progress 도구로 percent를 직접 알려 주는 경우
//  - 백그라운드로 띄운 작업의 로그 파일을 넘겨 주면 서버가 30초마다 끝부분을 읽어 "42%" 또는 "3/10"
//    같은 표시를 찾아내는 경우 (에이전트가 턴을 끝낸 뒤에도 폰에 진행률이 계속 뜬다)
// 값은 메모리에만 두고 폰에는 agent.progress와 progress.updated 이벤트로 내려간다.
import fs from 'node:fs';
import path from 'node:path';
import { Agents, Messages } from './db.js';
import { emit } from './bus.js';
import { sendPush } from './push.js';

const state = new Map(); // agentId -> { percent, label, log_file, at, started_at, done, source, stalled }
const TAIL_BYTES = 8192;
const STALL_MS = 20 * 60 * 1000;
const DONE_RE = /\b(done|finished|completed?|success(?:fully)?)\b|완료|끝났|성공/i;
const FAIL_RE = /\b(error|failed|exception|traceback)\b|오류|실패/i;

/** 로그 조각에서 진행률을 읽는다. 마지막에 나온 "NN%" 또는 "n/m"(m ≥ 2)을 쓴다. 없으면 null. */
export function parseProgress(text) {
  const s = String(text || '');
  let percent = null;
  for (const m of s.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const v = Number(m[1]);
    if (v >= 0 && v <= 100) percent = v;
  }
  if (percent === null) {
    for (const m of s.matchAll(/(?:^|[\s\[(:])(\d{1,6})\s*\/\s*(\d{1,6})(?=$|[\s\])])/gm)) {
      const cur = Number(m[1]), total = Number(m[2]);
      if (total >= 2 && cur <= total) percent = Math.round((cur / total) * 100);
    }
  }
  // 마지막 줄만 본다. "37% done"처럼 진행 표시가 함께 있는 줄은 아직 끝난 게 아니다.
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.at(-1) || '';
  const partial = /\d+(?:\.\d+)?\s*%|\d+\s*\/\s*\d+/.test(lastLine) && percent !== 100;
  const done = percent === 100 || (DONE_RE.test(lastLine) && !partial);
  return { percent, done, failed: !done && FAIL_RE.test(lines.slice(-3).join('\n')) };
}

function readTail(file) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

export function getProgress(agentId) {
  const p = state.get(agentId);
  if (!p) return null;
  const elapsed = Date.now() - p.started_at;
  const eta = !p.done && p.percent >= 5 && p.percent < 100 ? Math.round(elapsed * (100 - p.percent) / p.percent) : null;
  return { ...p, elapsed_ms: elapsed, eta_ms: eta };
}
export function allProgress() {
  return Object.fromEntries([...state.keys()].map((id) => [id, getProgress(id)]));
}
function broadcast(agentId) {
  emit('progress.updated', { agent_id: agentId, progress: getProgress(agentId) });
}

/** 에이전트/로그 어느 쪽이든 이 함수로 갱신. percent 없이 log_file만 줘도 된다. */
export function setProgress(agentId, { percent, label, log_file, done, workspacePath } = {}) {
  const prev = state.get(agentId);
  let file = null;
  if (log_file) {
    file = path.isAbsolute(log_file) ? log_file : path.join(workspacePath || process.cwd(), log_file);
    if (!fs.existsSync(file)) throw new Error(`로그 파일이 없습니다: ${log_file}`);
  }
  const p = {
    percent: percent == null ? (prev?.percent ?? 0) : Math.max(0, Math.min(100, Math.round(Number(percent)))),
    label: String(label || prev?.label || '작업').trim().slice(0, 80),
    log_file: file || prev?.log_file || null,
    started_at: prev?.started_at || Date.now(),
    at: Date.now(),
    done: !!done || Number(percent) >= 100,
    failed: false,
    stalled: false,
    source: file ? 'log' : 'agent',
  };
  state.set(agentId, p);
  // 로그를 넘겨받았으면 30초 뒤 첫 확인을 기다리지 않고 지금 바로 한 번 읽는다.
  if (p.log_file && percent == null && !p.done) {
    try {
      const r = parseProgress(readTail(p.log_file).text);
      if (r.percent != null) p.percent = r.percent;
      if (r.done) p.done = true;
    } catch {}
  }
  if (p.done) markDone(agentId, p);
  else broadcast(agentId);
  return getProgress(agentId);
}

/** 작업이 끝났을 때. 에이전트가 직접 준 진행률은 지우고, 로그 감시 중인 것은 그대로 둔다. */
export function clearProgress(agentId, { force = false } = {}) {
  const p = state.get(agentId);
  if (!p) return;
  if (!force && p.log_file && !p.done) return;
  state.delete(agentId);
  broadcast(agentId);
}

function markDone(agentId, p, { failed = false } = {}) {
  p.done = true;
  p.failed = failed;
  p.percent = failed ? p.percent : 100;
  p.at = Date.now();
  const agent = Agents.get(agentId);
  if (!agent) { state.delete(agentId); return; }
  const text = failed ? `진행 중이던 작업에 문제가 생긴 것 같습니다 · ${p.label}` : `끝났습니다 · ${p.label}`;
  const m = Messages.add(agentId, 'system', text, { progress: true });
  emit('message', { agent_id: agentId, message: m });
  broadcast(agentId);
  if (p.source === 'log') {
    sendPush({ title: `${agent.name} · ${failed ? '확인 필요' : '작업 완료'}`, body: `${p.label}${failed ? ' — 로그에 오류 표시가 있습니다' : ' 100%'}`, url: `/?agent=${agentId}`, tag: `progress-${agentId}` }).catch(() => {});
  }
  // 완료 표시는 10분 뒤 사라진다.
  setTimeout(() => { if (state.get(agentId) === p) { state.delete(agentId); broadcast(agentId); } }, 10 * 60 * 1000).unref();
}

/** 스케줄러가 30초마다 부른다: 로그 파일 끝을 읽어 진행률을 갱신한다. */
export function tickProgress(now = Date.now()) {
  for (const [agentId, p] of state) {
    if (!p.log_file || p.done) continue;
    let tail;
    try { tail = readTail(p.log_file); } catch { continue; }
    const r = parseProgress(tail.text);
    let changed = false;
    if (r.percent != null && r.percent !== p.percent) { p.percent = r.percent; p.at = now; changed = true; }
    const stalled = now - tail.mtime > STALL_MS;
    if (stalled !== p.stalled) { p.stalled = stalled; changed = true; }
    if (r.done) { markDone(agentId, p); continue; }
    if (r.failed && stalled) { markDone(agentId, p, { failed: true }); continue; }
    if (changed) broadcast(agentId);
  }
}
