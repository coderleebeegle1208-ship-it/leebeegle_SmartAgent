// 배경 작업(영상·음성 생성, 렌더링, 업로드, 대량 처리). 담당 에이전트가 mcp__approver__run_job으로
// 명령을 맡기면 서버가 직접 띄워 로그를 파일로 받고, 끝나면(성공·실패·멈춤) 에이전트를 자동으로
// 다시 불러 결과를 확인하고 실패면 고쳐서 다시 시도하게 한다. 진행률 막대는 없다 — 끝났을 때
// 한 번 알리는 방식. 다른 방법으로 띄운 작업은 watch_job으로 로그 파일만 넘겨도 같은 감시를 받는다.
// 목록은 data/jobs/jobs.json에 남겨 두어 서버가 재시작돼도 감시가 이어진다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Agents, Messages } from './db.js';
import { emit } from './bus.js';
import { sendPush } from './push.js';
import { DATA_DIR } from './paths.js';

const JOB_DIR = path.join(DATA_DIR, 'jobs');
const STATE_FILE = path.join(JOB_DIR, 'jobs.json');
const TAIL_BYTES = 6000;
const STALL_MS = 20 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const DONE_RE = /\b(done|finished|completed?|success(?:fully)?)\b|완료|끝났|성공/i;
const FAIL_RE = /\b(error|failed|exception|traceback)\b|오류|실패/i;

const jobs = new Map();      // id -> job
const children = new Map();  // id -> ChildProcess (이 서버가 띄운 것만)
const attempts = new Map();  // `${agentId}:${labelKey}` -> { n, at } 같은 이름의 작업이 실패 뒤 다시 오면 시도 횟수를 잇는다
let nextId = 1;
let onFinished = null;

/** 작업이 끝났을 때 부를 함수. (agentId, job, outcome, tail) → 보통 에이전트에게 후속 지시를 넣는다. */
export function setJobFinishedHandler(fn) {
  onFinished = fn;
}

function labelKey(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function nextAttempt(agentId, label) {
  const key = `${agentId}:${labelKey(label)}`;
  const prev = attempts.get(key);
  // 2시간 안에 같은 이름으로 다시 오면 재시도로 센다.
  const n = prev && prev.failed && Date.now() - prev.at < 2 * 60 * 60 * 1000 ? prev.n + 1 : 1;
  attempts.set(key, { n, at: Date.now(), failed: false });
  return n;
}
function rememberOutcome(job, outcome) {
  const key = `${job.agent_id}:${labelKey(job.label)}`;
  attempts.set(key, { n: job.attempt, at: Date.now(), failed: outcome !== 'done' });
}

function persist() {
  try {
    fs.mkdirSync(JOB_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify([...jobs.values()], null, 1));
  } catch {}
}
/** 서버가 재시작된 뒤: 남아 있던 작업을 다시 지켜본다(프로세스 종료는 pid 생존 여부로 판단). */
export function restoreJobs() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return 0; }
  for (const j of list) {
    if (!j || j.status !== 'running' || !Agents.get(j.agent_id)) continue;
    jobs.set(j.id, { ...j, restored: true });
    nextId = Math.max(nextId, j.id + 1);
  }
  return jobs.size;
}

export function readTail(file, bytes = TAIL_BYTES) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

/** 로그 끝부분만 보고 끝났는지·실패인지 짐작한다(pid를 모르는 작업, 또는 재시작 뒤 복원된 작업용). */
export function judgeLog(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) || '';
  const partial = /\d+(?:\.\d+)?\s*%|\d+\s*\/\s*\d+/.test(last) && !/\b100\s*%/.test(last);
  const done = (/\b100\s*%/.test(last)) || (DONE_RE.test(last) && !partial);
  return { done, failed: !done && FAIL_RE.test(lines.slice(-3).join('\n')) };
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function findBash() {
  const cands = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    '/bin/bash', '/usr/bin/bash',
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/** 명령을 서버가 직접 띄운다. 출력은 로그 파일로. 끝나면 finishJob → 후속 지시. */
export function startJob(agentId, { command, label, cwd, shell = 'bash', workspacePath } = {}) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('unknown agent');
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command가 비어 있습니다');
  const name = String(label || '').trim().slice(0, 80) || '배경 작업';
  const dir = cwd ? (path.isAbsolute(cwd) ? cwd : path.join(workspacePath || process.cwd(), cwd)) : workspacePath || process.cwd();
  if (!fs.existsSync(dir)) throw new Error(`작업 폴더가 없습니다: ${dir}`);
  const logDir = path.join(JOB_DIR, `agent-${agentId}`);
  fs.mkdirSync(logDir, { recursive: true });
  const id = nextId++;
  const logFile = path.join(logDir, `${Date.now()}-${id}.log`);
  fs.writeFileSync(logFile, `$ ${cmd}\n`);
  const fd = fs.openSync(logFile, 'a');

  let bin, args;
  if (shell === 'powershell') {
    bin = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd];
  } else if (shell === 'cmd') {
    bin = 'cmd.exe'; args = ['/d', '/s', '/c', cmd];
  } else {
    bin = findBash();
    if (!bin) { bin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'; args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd]; }
    else args = ['-lc', cmd];
  }
  const attempt = nextAttempt(agentId, name);
  const job = { id, agent_id: agentId, label: name, command: cmd, cwd: dir, log_file: logFile, pid: null, attempt, started_at: Date.now(), status: 'running', source: 'server' };
  let child;
  try {
    // detached: 이 앱을 재시작해도 작업은 계속된다. 종료는 살아 있는 동안 exit 이벤트로, 재시작 뒤엔 pid 생존으로 안다.
    child = spawn(bin, args, { cwd: dir, stdio: ['ignore', fd, fd], windowsHide: true, detached: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  } catch (e) {
    fs.closeSync(fd);
    throw new Error(`실행 실패: ${e.message}`);
  }
  fs.closeSync(fd);
  child.unref();
  job.pid = child.pid || null;
  jobs.set(id, job);
  children.set(id, child);
  persist();
  child.on('error', (e) => finishJob(id, { code: -1, error: e.message }));
  child.on('exit', (code, signal) => finishJob(id, { code: code ?? (signal ? -1 : 0), signal }));
  const m = Messages.add(agentId, 'system', `배경 작업 시작 · ${name}${attempt > 1 ? ` (재시도 ${attempt}/${MAX_ATTEMPTS})` : ''} · 끝나면 자동으로 확인합니다`, { job: id });
  emit('message', { agent_id: agentId, message: m });
  emit('jobs.changed', { agent_id: agentId, jobs: jobsForAgent(agentId) });
  return job;
}

/** 다른 방법으로 띄운 작업: 로그 파일만 지켜본다. 끝났다/실패 표시 또는 20분 정지로 판단. */
export function watchLog(agentId, { log_file, label, pid, workspacePath } = {}) {
  const agent = Agents.get(agentId);
  if (!agent) throw new Error('unknown agent');
  if (!log_file) throw new Error('log_file이 필요합니다');
  const file = path.isAbsolute(log_file) ? log_file : path.join(workspacePath || process.cwd(), log_file);
  if (!fs.existsSync(file)) throw new Error(`로그 파일이 없습니다: ${log_file}`);
  const name = String(label || '').trim().slice(0, 80) || path.basename(file);
  const id = nextId++;
  const attempt = nextAttempt(agentId, name);
  const job = { id, agent_id: agentId, label: name, command: null, cwd: null, log_file: file, pid: Number(pid) || null, attempt, started_at: Date.now(), status: 'running', source: 'log', restored: true };
  jobs.set(id, job);
  persist();
  const m = Messages.add(agentId, 'system', `배경 작업 감시 · ${name} · 끝나면 자동으로 확인합니다`, { job: id });
  emit('message', { agent_id: agentId, message: m });
  emit('jobs.changed', { agent_id: agentId, jobs: jobsForAgent(agentId) });
  return job;
}

export function jobsForAgent(agentId) {
  return [...jobs.values()].filter((j) => j.agent_id === agentId).map(({ id, label, started_at, attempt, status }) => ({ id, label, started_at, attempt, status }));
}
export function getJob(id) {
  return jobs.get(id) || null;
}

function tailOf(job) {
  try { return readTail(job.log_file).text.trim(); } catch { return ''; }
}

/** 작업 종료 처리. outcome: done | failed | stalled. 후속 지시는 handler가 넣는다. */
export function finishJob(id, { code = null, error = null, outcome = null } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  jobs.delete(id);
  children.delete(id);
  persist();
  const tail = tailOf(job);
  const result = outcome || (code === 0 ? (judgeLog(tail).failed ? 'suspect' : 'done') : 'failed');
  job.status = result;
  job.exit_code = code;
  job.error = error;
  job.finished_at = Date.now();
  rememberOutcome(job, result === 'suspect' ? 'done' : result);
  const agent = Agents.get(job.agent_id);
  if (!agent) return job;
  const text = result === 'done' ? `배경 작업 끝남 · ${job.label} · 결과를 확인합니다`
    : result === 'suspect' ? `배경 작업 끝남 · ${job.label} · 로그에 오류 표시가 있어 확인합니다`
    : result === 'stalled' ? `배경 작업 멈춤 · ${job.label} · 20분 넘게 진행이 없어 확인합니다`
    : `배경 작업 실패 · ${job.label}${code != null ? ` (종료 코드 ${code})` : ''} · 원인을 보고 다시 시도합니다`;
  const m = Messages.add(job.agent_id, 'system', text, { job: id, outcome: result });
  emit('message', { agent_id: job.agent_id, message: m });
  emit('jobs.changed', { agent_id: job.agent_id, jobs: jobsForAgent(job.agent_id) });
  if (result !== 'done') {
    sendPush({ title: `${agent.name} · 배경 작업 ${result === 'stalled' ? '멈춤' : '문제'}`, body: `${job.label} — 담당자가 확인하고 다시 시도합니다`, url: `/?agent=${job.agent_id}`, tag: `job-${job.agent_id}` }).catch(() => {});
  }
  try { onFinished?.(job.agent_id, job, result, tail); } catch (e) { console.error('[jobs] follow-up failed', e.message); }
  return job;
}

/** 스케줄러가 30초마다 부른다: pid를 모르는(또는 복원된) 작업의 로그·프로세스 상태를 본다. */
export function tickJobs(now = Date.now()) {
  for (const job of [...jobs.values()]) {
    if (children.has(job.id)) continue; // 이 서버가 띄운 건 exit 이벤트가 알려 준다
    let tail;
    try { tail = readTail(job.log_file); } catch { continue; }
    const j = judgeLog(tail.text);
    const alive = job.pid ? pidAlive(job.pid) : null;
    if (alive === false) { finishJob(job.id, { code: j.failed ? 1 : 0, outcome: j.failed ? 'failed' : 'done' }); continue; }
    if (j.done) { finishJob(job.id, { code: 0, outcome: 'done' }); continue; }
    const stalled = now - tail.mtime > STALL_MS && now - job.started_at > STALL_MS;
    if (j.failed && stalled) { finishJob(job.id, { code: 1, outcome: 'failed' }); continue; }
    if (stalled) { finishJob(job.id, { code: null, outcome: 'stalled' }); continue; }
  }
}

/** 끝난 작업을 에이전트에게 알리는 후속 지시문. 성공이면 결과물 보내기, 실패면 고쳐서 재시도(최대 3번). */
export function jobFollowUpPrompt(job, outcome, tail) {
  const what = outcome === 'done' ? '끝났습니다 (종료 코드 0)'
    : outcome === 'suspect' ? '끝났지만 로그에 오류 표시가 있습니다'
    : outcome === 'stalled' ? `20분 넘게 진행이 없어 멈춘 것으로 보입니다${job.pid ? ` (PID ${job.pid})` : ''}`
    : `실패한 것 같습니다${job.exit_code != null ? ` (종료 코드 ${job.exit_code})` : ''}${job.error ? ` · ${job.error}` : ''}`;
  const last = job.attempt >= MAX_ATTEMPTS;
  const lines = [
    `[배경 작업 감시] "${job.label}" 작업이 ${what}. (시도 ${job.attempt}/${MAX_ATTEMPTS})`,
    job.command ? `실행했던 명령: ${job.command}` : '',
    `로그 파일: ${job.log_file}`,
    tail ? `로그 끝부분:\n${tail}` : '로그가 비어 있습니다.',
    '',
    '해야 할 일:',
    '- 로그와 결과물을 직접 확인해라. 제대로 됐으면 결과물(영상·사진 등)을 mcp__approver__send_file로 폰에 보내고 짧게 보고해라.',
    last
      ? '- 실패했다면 이미 3번째 시도라 더 재시도하지 말고, 원인과 대표가 결정할 것만 짧게 보고해라.'
      : `- 실패했거나 결과물이 없으면 로그에서 원인을 찾아 고친 뒤, 같은 label("${job.label}")로 mcp__approver__run_job을 다시 불러 재시도해라. 서버가 다시 지켜보다가 끝나면 또 불러 준다.`,
    outcome === 'stalled' && job.pid ? `- 프로세스가 아직 살아 있으면(PID ${job.pid}) 정말 멈춘 건지 확인하고, 멈췄으면 끝낸 뒤 다시 시도해라.` : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
