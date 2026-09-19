// Agent Remote — phone-first dashboard for Claude Code / Codex / Gemini running on this PC.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { PUBLIC_DIR, ROOT_DIR } from './paths.js';
import { spawn } from 'node:child_process';
import { AgentSessions, Workspaces, Agents, Messages, Approvals, PushSubs, SavedPrompts, Schedules, Settings, Snapshots } from './db.js';
import { bus, emit } from './bus.js';
import { initPush, sendPush } from './push.js';
import { gitSummary, gitCommitDiff, gitRemote, setGitRemote, restoreTree } from './git.js';
import { requestApproval, waitForApproval, resolveApproval, setBlanketAllow, blanketAllow, configureUnattended } from './approvals.js';
import { DAY_LABEL, describeDays, digestSettings, isValidTime, nextDue, normalizeDays, runSchedule, sendDigestPush, startScheduler } from './scheduler.js';
import { buildDigest } from './digest.js';
import { backupStatus, runBackup } from './backup.js';
import { startPrompt, stopAgent, isRunning, runningIds, executePlan, switchProvider, compactAgent, enqueuePrompt, queuedPrompts, removeQueued, steerQueued, syncDesktopTranscript, liveStatsOf } from './runners/index.js';
import { desktopRoot, listDesktopSessions, readTranscript, transcriptPath } from './desktop-sessions.js';
import { answerStyle, setAnswerStyle } from './style.js';
import { findClaudeBin } from './runners/claude.js';
import { findCodexEntry } from './runners/codex.js';
import { findGeminiEntry } from './runners/gemini.js';
import { allQuotas as geminiQuotas, finishLogin as geminiFinishLogin, getAccount as geminiAccount, listAccounts as geminiAccounts, probeLogin as geminiProbeLogin, removeAccount as geminiRemoveAccount, startLogin as geminiStartLogin } from './gemini-accounts.js';
import { getUsage } from './usage.js';
import { CAPTURE_DIR, captureScreenshot, findBrowserBin } from './capture.js';
import { CODEX_MODEL_CATALOG, GEMINI_EFFORTS, MODEL_CATALOG, codexDefaults, geminiDefaults, geminiModelCatalog, isCodexModelAllowed, isGeminiModelAllowed, isModelAllowed } from './models.js';
import { refreshGeminiModels } from './gemini-models.js';
import { UPLOAD_DIR, findFfmpeg, loadUpload, saveUpload } from './uploads.js';
import { copySkill, deleteSkill, listImportableSkills, listSkills, parseFrontmatter, validateSkillName, writeSkill } from './skills.js';
import { heldNotifications, isQuietNow, quietSettings, saveQuietSettings } from './quiet.js';
import { cancelJobs, jobFollowUpPrompt, jobsForAgent, restoreJobs, setJobFinishedHandler, startJob, watchLog } from './jobs.js';
import { configureTelegram, initTelegram, muteTelegram, sendTelegram, telegramStatus, unlinkTelegram } from './telegram.js';

const cfg = loadConfig();
// 폰이 열어 둔 화면이 오래된 app.js/style.css로 계속 돌지 않도록: 파일이 바뀌면 값이 달라지고, 폰은 이 값이 바뀐 걸 보면 스스로 새로 고친다.
const BUILD_ID = ['app.js', 'style.css', 'index.html'].map((f) => { try { return Math.round(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch { return 0; } }).join('-');
initPush(cfg);
configureUnattended(cfg);
startScheduler(cfg);
initTelegram(cfg);

// A restart means no agent process survived: clear stale "working"/"needs_attention" states.
for (const a of Agents.all()) {
  if (a.status === 'working' || a.status === 'needs_attention') {
    Approvals.expireForAgent(a.id);
    Agents.update(a.id, { status: a.pending_plan ? 'needs_attention' : 'idle', collab_stage: null });
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- auth ----------
function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.query.token || null;
}
function requireAuth(req, res, next) {
  if (tokenFrom(req) === cfg.token) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function requireInternal(req, res, next) {
  if (tokenFrom(req) === cfg.internalToken) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---------- system stats ----------
let stats = { cpu: 0, mem: 0, host: os.hostname() };
let prevCpu = os.cpus().map((c) => ({ ...c.times }));
setInterval(() => {
  const cur = os.cpus().map((c) => ({ ...c.times }));
  let idle = 0, total = 0;
  cur.forEach((t, i) => {
    const p = prevCpu[i] || t;
    const dIdle = t.idle - p.idle;
    const dTotal = Object.keys(t).reduce((s, k) => s + (t[k] - p[k]), 0);
    idle += dIdle;
    total += dTotal;
  });
  prevCpu = cur;
  stats = {
    cpu: total ? Math.round((1 - idle / total) * 100) : 0,
    mem: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    host: os.hostname(),
  };
}, 3000).unref();

function agentView(a) {
  const saved = Object.fromEntries(AgentSessions.forAgent(a.id).map((s) => [s.kind, true]));
  if (a.session_id) saved[a.kind] = true;
  return {
    ...a,
    running: isRunning(a.id),
    pending_approvals: Approvals.pendingForAgent(a.id).length,
    provider_sessions: { claude: !!saved.claude, codex: !!saved.codex, gemini: !!saved.gemini },
    compact_limit: cfg.compactAfterTokens || 0,
    blanket_allow: !!blanketAllow(a.id),
    schedules: Schedules.forAgent(a.id).length,
    queued: queuedPrompts(a.id).length,
    jobs: jobsForAgent(a.id),
    live: liveStatsOf(a.id),
  };
}

// ---------- public config (no auth) ----------
app.get('/api/meta', (req, res) => {
  res.json({ host: os.hostname(), vapidPublicKey: cfg.vapid.publicKey });
});
app.post('/api/auth/check', (req, res) => {
  res.json({ ok: (req.body?.token || '') === cfg.token });
});

// ---------- authenticated API ----------
const api = express.Router();
api.use(requireAuth);

// `git remote` per workspace is cheap but not free, and /state is polled; cache briefly.
const remoteCache = new Map(); // path -> { at, info }
const REMOTE_TTL = 60_000;
function cachedRemote(p) {
  const hit = remoteCache.get(p);
  if (hit && Date.now() - hit.at < REMOTE_TTL) return hit.info;
  if (!hit) remoteCache.set(p, { at: Date.now(), info: null });
  else hit.at = Date.now();
  gitRemote(p).then((info) => remoteCache.set(p, { at: Date.now(), info })).catch(() => {});
  return hit?.info ?? null;
}

api.get('/workspaces/:id/remote', async (req, res) => {
  const ws = Workspaces.get(Number(req.params.id));
  if (!ws) return res.status(404).json({ error: 'not found' });
  const info = await gitRemote(ws.path);
  remoteCache.set(ws.path, { at: Date.now(), info });
  res.json(info);
});
api.post('/workspaces/:id/remote', async (req, res) => {
  const ws = Workspaces.get(Number(req.params.id));
  if (!ws) return res.status(404).json({ error: 'not found' });
  try {
    const info = await setGitRemote(ws.path, req.body?.url);
    remoteCache.set(ws.path, { at: Date.now(), info });
    emit('workspace.updated', { workspace: ws });
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.get('/state', (req, res) => {
  const workspaces = Workspaces.all().map((w) => ({ ...w, repo: cachedRemote(w.path) }));
  refreshGeminiModels(); // Antigravity CLI(agy)가 업데이트되면 새 모델이 목록에 바로 나타난다
  const agents = Agents.all().map(agentView);
  const counts = { all: agents.length, needs_attention: 0, working: 0, done: 0, error: 0, idle: 0 };
  for (const a of agents) counts[a.status] = (counts[a.status] || 0) + 1;
  res.json({
    computer: { name: os.hostname(), platform: process.platform, ...stats, connected: true },
    tools: { claude: findClaudeBin(), codex: !!findCodexEntry(), gemini: !!findGeminiEntry(), capture: !!findBrowserBin(), ffmpeg: !!findFfmpeg() },
    models: MODEL_CATALOG,
    codex: { models: CODEX_MODEL_CATALOG, ...codexDefaults() },
    gemini: { models: geminiModelCatalog(), efforts: GEMINI_EFFORTS, ...geminiDefaults(), accounts: geminiAccounts() },
    settings: { answer_style: answerStyle() },
    build: BUILD_ID,
    workspaces,
    agents,
    counts,
  });
});

api.get('/usage', async (req, res) => {
  const provider = ['codex', 'gemini'].includes(req.query.provider) ? req.query.provider : 'claude';
  res.json(await getUsage(provider, req.query.refresh === '1'));
});

// ---------- Gemini: Google 계정 연결 (Antigravity CLI 로그인, 한 번에 하나) ----------
api.get('/gemini/accounts', async (req, res) => {
  // 아직 계정을 모르면(첫 실행·PC에서 직접 로그인한 뒤) agy에게 물어본다.
  if (!geminiAccounts().length || req.query.refresh === '1') {
    const before = geminiAccounts().length;
    await geminiProbeLogin();
    if (geminiAccounts().length !== before) emit('gemini.accounts', { accounts: geminiAccounts() });
  }
  res.json({ accounts: await geminiQuotas(req.query.refresh === '1') });
});
api.post('/gemini/login/start', async (req, res) => {
  try {
    res.json(await geminiStartLogin());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/gemini/login/finish', async (req, res) => {
  try {
    const account = await geminiFinishLogin(String(req.body?.loginId || ''), String(req.body?.code || ''));
    emit('gemini.accounts', { accounts: geminiAccounts() });
    res.json({ account });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.delete('/gemini/accounts/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!geminiAccount(id)) return res.status(404).json({ error: 'not found' });
  // 이 계정에 고정돼 있던 담당자는 자동 선택으로 돌린다.
  for (const a of Agents.all()) if (a.gemini_account === id) Agents.update(a.id, { gemini_account: null });
  await geminiRemoveAccount(id);
  emit('gemini.accounts', { accounts: geminiAccounts() });
  res.json({ ok: true });
});

api.post('/workspaces', (req, res) => {
  const { name, path: p } = req.body || {};
  if (!p) return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return res.status(400).json({ error: '폴더가 존재하지 않습니다: ' + abs });
  try {
    const ws = Workspaces.create(name?.trim() || path.basename(abs), abs);
    emit('workspace.created', { workspace: ws });
    res.json(ws);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.patch('/workspaces/:id', (req, res) => {
  const id = Number(req.params.id);
  if (typeof req.body?.name === 'string') Workspaces.rename(id, req.body.name.trim() || 'workspace');
  if ('pinned' in (req.body || {})) Workspaces.setPinned(id, !!req.body.pinned);
  const ws = Workspaces.get(id);
  emit('workspace.updated', { workspace: ws });
  res.json(ws);
});
api.delete('/workspaces/:id', (req, res) => {
  const id = Number(req.params.id);
  for (const a of Agents.byWorkspace(id)) { stopAgent(a.id); cancelJobs(a.id); }
  Workspaces.remove(id);
  emit('workspace.deleted', { id });
  res.json({ ok: true });
});
api.get('/workspaces/:id/git', async (req, res) => {
  const ws = Workspaces.get(Number(req.params.id));
  if (!ws) return res.status(404).json({ error: 'not found' });
  res.json(await gitSummary(ws.path, Number(req.query.limit) || 20));
});
api.get('/workspaces/:id/git/:hash', async (req, res) => {
  const ws = Workspaces.get(Number(req.params.id));
  if (!ws) return res.status(404).json({ error: 'not found' });
  if (!/^[0-9a-f]{4,40}$/i.test(req.params.hash)) return res.status(400).json({ error: 'bad hash' });
  res.type('text/plain').send(await gitCommitDiff(ws.path, req.params.hash));
});
api.get('/browse', (req, res) => {
  // Folder picker helper for the phone: list subfolders of a path.
  const p = req.query.path ? path.resolve(String(req.query.path)) : os.homedir();
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    res.json({ path: p, parent: path.dirname(p) !== p ? path.dirname(p) : null, dirs: entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
api.post('/agents', (req, res) => {
  const { workspace_id, kind, name, model, effort, codex_model, codex_effort, gemini_model, gemini_effort, gemini_account, plan_effort, exec_effort, permission_mode, pipeline, triage_model, plan_model, exec_model, confirm_plan, collab_mode, cross_plan, codex_plan_model, codex_plan_effort, plan_debate } = req.body || {};
  const ws = Workspaces.get(Number(workspace_id));
  if (!ws) return res.status(400).json({ error: 'workspace not found' });
  const k = ['codex', 'gemini'].includes(kind) ? kind : 'claude';
  const KIND_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  let agent = Agents.create(ws.id, k, name?.trim() || KIND_NAME[k]);
  const fields = {};
  if (k === 'codex') {
    if (isCodexModelAllowed(codex_model || model)) fields.codex_model = codex_model || model;
    if (EFFORTS.includes(codex_effort || effort)) fields.codex_effort = codex_effort || effort;
  } else if (k === 'gemini') {
    if (isGeminiModelAllowed(gemini_model || model)) fields.gemini_model = gemini_model || model;
    if (GEMINI_EFFORTS.includes(gemini_effort || effort)) fields.gemini_effort = gemini_effort || effort;
    if (gemini_account && geminiAccount(String(gemini_account))) fields.gemini_account = String(gemini_account);
  } else if (isModelAllowed('manual', model)) fields.model = model;
  // A single "강도" chosen at creation applies to every stage until it is tuned per stage in the composer.
  if (k === 'claude' && EFFORTS.includes(effort)) { fields.effort = effort; fields.plan_effort = effort; fields.exec_effort = effort; }
  if (EFFORTS.includes(plan_effort)) fields.plan_effort = plan_effort;
  if (EFFORTS.includes(exec_effort)) fields.exec_effort = exec_effort;
  if (['ask', 'acceptEdits', 'auto'].includes(permission_mode)) fields.permission_mode = permission_mode;
  if (['auto', 'manual'].includes(pipeline)) fields.pipeline = pipeline;
  if (isModelAllowed('triage', triage_model)) fields.triage_model = triage_model;
  if (isModelAllowed('plan', plan_model)) fields.plan_model = plan_model;
  if (isModelAllowed('exec', exec_model)) fields.exec_model = exec_model;
  if (confirm_plan !== undefined) fields.confirm_plan = confirm_plan ? 1 : 0;
  if (collab_mode !== undefined) fields.collab_mode = collab_mode ? 1 : 0;
  if (plan_debate !== undefined) fields.plan_debate = plan_debate ? 1 : 0;
  if (cross_plan !== undefined) fields.cross_plan = cross_plan ? 1 : 0;
  if (isCodexModelAllowed(codex_plan_model)) fields.codex_plan_model = codex_plan_model;
  if (EFFORTS.includes(codex_plan_effort)) fields.codex_plan_effort = codex_plan_effort;
  if (Object.keys(fields).length) agent = Agents.update(agent.id, fields);
  emit('agent.updated', { agent: agentView(agent) });
  res.json(agentView(agent));
});
// ---------- PC 클로드 앱(코드 탭) 대화 이어받기 ----------
// 같은 세션 id를 그대로 --resume 하므로 폰과 PC가 한 기록 파일을 번갈아 이어 쓴다.
const DESKTOP_HISTORY_LIMIT = 300;
function desktopSessionRows() {
  const linked = new Map();
  for (const a of Agents.all()) {
    if (a.desktop_host_id) linked.set(a.desktop_host_id, a.id);
    if (a.session_id) linked.set(`s:${a.session_id}`, a.id);
  }
  return listDesktopSessions().map((s) => ({ ...s, agent_id: linked.get(s.host_id) || linked.get(`s:${s.session_id}`) || null }));
}
api.get('/desktop-sessions', (req, res) => res.json(desktopSessionRows()));
api.post('/desktop-sessions/import', (req, res) => {
  const ids = Array.isArray(req.body?.host_ids) ? req.body.host_ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: '가져올 대화를 고르세요' });
  const rows = desktopSessionRows();
  const created = [];
  const skipped = [];
  for (const id of ids) {
    const s = rows.find((r) => r.host_id === id);
    if (!s) { skipped.push({ host_id: id, reason: '목록에 없음' }); continue; }
    if (s.agent_id) { skipped.push({ host_id: id, title: s.title, reason: '이미 가져옴' }); continue; }
    if (!s.resumable) { skipped.push({ host_id: id, title: s.title, reason: s.reason }); continue; }
    const abs = path.resolve(s.cwd);
    let ws = Workspaces.all().find((w) => path.resolve(w.path).toLowerCase() === abs.toLowerCase());
    if (!ws) { ws = Workspaces.create(path.basename(abs), abs); emit('workspace.created', { workspace: ws }); }
    let agent = Agents.create(ws.id, 'claude', s.title);
    // PC에서 쓰던 모델·강도·권한을 그대로. 자동 파이프라인(분류→계획→실행)은 이어받는 대화에는 맞지 않아 수동으로 둔다.
    const family = String(s.model || '').match(/^claude-(fable|opus|sonnet|haiku)/)?.[1] || null;
    const fields = {
      session_id: s.session_id,
      desktop_host_id: s.host_id,
      pipeline: 'manual',
      permission_mode: ['acceptEdits', 'auto'].includes(s.permission_mode) ? s.permission_mode : 'ask',
      model: isModelAllowed('manual', s.model) ? s.model : family && isModelAllowed('manual', family) ? family : null,
    };
    if (EFFORTS.includes(s.effort)) { fields.effort = s.effort; fields.plan_effort = s.effort; fields.exec_effort = s.effort; }
    const { messages, pos } = readTranscript(transcriptPath(abs, s.session_id), 0);
    for (const m of messages.slice(-DESKTOP_HISTORY_LIMIT)) Messages.add(agent.id, m.role, m.content, { desktop: true }, m.ts);
    fields.transcript_pos = pos;
    const lastAnswer = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAnswer) fields.last_response = lastAnswer.content;
    agent = Agents.update(agent.id, fields);
    AgentSessions.upsert(agent.id, 'claude', s.session_id);
    emit('agent.updated', { agent: agentView(agent) });
    created.push(agentView(agent));
  }
  res.json({ created, skipped });
});
api.get('/agents/:id', (req, res) => {
  let a = Agents.get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  // PC 클로드 앱에서 그사이 오간 대화를 먼저 옮겨 두고 보여 준다.
  if (a.desktop_host_id && !isRunning(a.id)) { try { if (syncDesktopTranscript(a.id)) a = Agents.get(a.id); } catch {} }
  res.json({
    agent: agentView(a),
    workspace: Workspaces.get(a.workspace_id),
    messages: Messages.forAgent(a.id, Number(req.query.limit) || 300),
    approvals: Approvals.pendingForAgent(a.id),
    queue: queuedPrompts(a.id),
    usage_summary: Messages.usageSummary(a.id),
  });
});
api.patch('/agents/:id', (req, res) => {
  const id = Number(req.params.id);
  const current = Agents.get(id);
  if (!current) return res.status(404).json({ error: 'not found' });
  if ('collab_mode' in (req.body || {}) && (isRunning(id) || current.status === 'working' || current.status === 'needs_attention')) {
    return res.status(400).json({ error: '작업 또는 승인이 끝난 뒤 협업 모드를 바꾸세요' });
  }
  const fields = {};
  if (typeof req.body?.name === 'string') fields.name = req.body.name.trim() || 'agent';
  if (['ask', 'acceptEdits', 'auto'].includes(req.body?.permission_mode)) fields.permission_mode = req.body.permission_mode;
  if ('model' in (req.body || {})) fields.model = isModelAllowed('manual', req.body.model) ? req.body.model : null;
  if ('codex_model' in (req.body || {})) fields.codex_model = isCodexModelAllowed(req.body.codex_model) ? req.body.codex_model : null;
  if ('effort' in (req.body || {})) fields.effort = EFFORTS.includes(req.body.effort) ? req.body.effort : null;
  if ('codex_effort' in (req.body || {})) fields.codex_effort = EFFORTS.includes(req.body.codex_effort) ? req.body.codex_effort : null;
  if ('gemini_model' in (req.body || {})) fields.gemini_model = isGeminiModelAllowed(req.body.gemini_model) ? req.body.gemini_model : null;
  if ('gemini_effort' in (req.body || {})) fields.gemini_effort = GEMINI_EFFORTS.includes(req.body.gemini_effort) ? req.body.gemini_effort : null;
  if ('gemini_account' in (req.body || {})) fields.gemini_account = req.body.gemini_account && geminiAccount(String(req.body.gemini_account)) ? String(req.body.gemini_account) : null;
  if ('plan_effort' in (req.body || {})) fields.plan_effort = EFFORTS.includes(req.body.plan_effort) ? req.body.plan_effort : null;
  if ('exec_effort' in (req.body || {})) fields.exec_effort = EFFORTS.includes(req.body.exec_effort) ? req.body.exec_effort : null;
  if (['auto', 'manual'].includes(req.body?.pipeline)) fields.pipeline = req.body.pipeline;
  if (isModelAllowed('triage', req.body?.triage_model)) fields.triage_model = req.body.triage_model;
  if (isModelAllowed('plan', req.body?.plan_model)) fields.plan_model = req.body.plan_model;
  if (isModelAllowed('exec', req.body?.exec_model)) fields.exec_model = req.body.exec_model;
  if ('confirm_plan' in (req.body || {})) fields.confirm_plan = req.body.confirm_plan ? 1 : 0;
  if ('auto_failover' in (req.body || {})) fields.auto_failover = req.body.auto_failover ? 1 : 0;
  if ('collab_mode' in (req.body || {})) fields.collab_mode = req.body.collab_mode ? 1 : 0;
  if ('cross_plan' in (req.body || {})) fields.cross_plan = req.body.cross_plan ? 1 : 0;
  if ('plan_debate' in (req.body || {})) fields.plan_debate = req.body.plan_debate ? 1 : 0;
  if ('codex_plan_model' in (req.body || {})) fields.codex_plan_model = isCodexModelAllowed(req.body.codex_plan_model) ? req.body.codex_plan_model : null;
  if ('codex_plan_effort' in (req.body || {})) fields.codex_plan_effort = EFFORTS.includes(req.body.codex_plan_effort) ? req.body.codex_plan_effort : null;
  if (req.body?.reset_session) {
    fields.session_id = null;
    fields.desktop_host_id = null; // 새 대화로 시작하면 PC 클로드 앱과 같은 기록을 더는 쓰지 않는다
    fields.transcript_pos = 0;
    AgentSessions.clear(id);
  }
  // Changing the running model mid-conversation means the next turn re-writes the whole
  // conversation into that model's own cache — a one-time cost worth flagging, not hiding by
  // clearing the session (that would also throw away the conversation memory).
  const modelFields = ['model', 'codex_model', 'gemini_model', 'exec_model'];
  const modelChanged = current.session_id && modelFields.some((f) => f in fields && fields[f] !== current[f]);
  const a = Agents.update(id, fields);
  if (req.body?.clear_messages) Messages.clear(id);
  if (modelChanged) {
    // PC 클로드 앱처럼 같은 대화에서 모델만 바꾼다(요약해서 새 세션으로 갈아타지 않는다).
    const m = Messages.add(id, 'system', '실행 모델이 바뀌었습니다. PC 앱처럼 같은 대화에서 이어갑니다(다음 지시 한 번은 대화를 새 모델에 다시 기억시켜 비용이 더 듭니다).');
    emit('message', { agent_id: id, message: m });
  }
  emit('agent.updated', { agent: agentView(a) });
  res.json(agentView(a));
});
api.delete('/agents/:id', (req, res) => {
  const id = Number(req.params.id);
  stopAgent(id);
  cancelJobs(id);
  Agents.remove(id);
  emit('agent.deleted', { id });
  res.json({ ok: true });
});
api.post('/agents/:id/prompt', (req, res) => {
  const id = Number(req.params.id);
  const text = String(req.body?.text || '');
  const links = Array.isArray(req.body?.links) ? req.body.links.filter((l) => typeof l === 'string') : [];
  const attachmentIds = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const attachments = [];
  for (const item of attachmentIds) {
    const upload = loadUpload(id, item?.id ?? item);
    if (!upload) return res.status(400).json({ error: `첨부 파일을 찾을 수 없습니다: ${item?.id ?? item}` });
    attachments.push(upload);
  }
  try {
    const current = Agents.get(id);
    if (!current) return res.status(404).json({ error: 'not found' });
    // 바쁘면 줄을 세운다. 계획 확인 대기 중일 때는 대표 결정이 먼저라 그대로 400.
    if ((isRunning(id) || current.status === 'working') && !current.pending_plan) {
      const { count } = enqueuePrompt(id, text, { attachments, links });
      return res.json({ ...agentView(Agents.get(id)), queued_now: count });
    }
    const a = startPrompt(id, text, cfg, { attachments, links });
    res.json(agentView(a));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.get('/agents/:id/queue', (req, res) => res.json(queuedPrompts(Number(req.params.id))));
// 줄 세운 지시를 지금 처리 중인 작업에 바로 끼워 넣는다(Claude만). 안 되면 그대로 줄에 남는다.
api.post('/agents/:id/queue/:qid/now', (req, res) => {
  try {
    res.json(agentView(steerQueued(Number(req.params.id), Number(req.params.qid))));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.delete('/agents/:id/queue/:qid', (req, res) => {
  const ok = removeQueued(Number(req.params.id), Number(req.params.qid));
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
// 결과물 내려받기: 작업 폴더 안의 파일만, 경로 탈출 금지.
api.get('/agents/:id/file', (req, res) => {
  const a = Agents.get(Number(req.params.id));
  const w = a && Workspaces.get(a.workspace_id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const rel = String(req.query.path || '');
  const abs = path.resolve(w.path, rel);
  const root = path.resolve(w.path);
  if (!rel || !(abs === root || abs.startsWith(root + path.sep))) return res.status(400).json({ error: 'bad path' });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'file not found' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
  res.sendFile(abs);
});
api.post('/agents/:id/compact', async (req, res) => {
  try {
    await compactAgent(Number(req.params.id), cfg, { reason: 'manual' });
    res.json(agentView(Agents.get(Number(req.params.id))));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/agents/:id/execute-plan', (req, res) => {
  try {
    res.json(agentView(executePlan(Number(req.params.id), cfg, req.body?.side === 'reviewer' ? 'reviewer' : 'planner')));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/agents/:id/switch-provider', (req, res) => {
  try {
    res.json(agentView(switchProvider(Number(req.params.id), req.body?.kind)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/agents/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  const stopped = stopAgent(id);
  const jobs = cancelJobs(id); // 배경 작업도 같이 끊는다 — 안 그러면 '작업 중' 표시가 남고, 끝나면 재시도까지 한다
  res.json({ ok: stopped || jobs > 0, jobs });
});

// ---------- skills (/이름 slash commands) ----------
function agentWorkspaceOr404(req, res) {
  const agent = Agents.get(Number(req.params.id));
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return null; }
  const ws = Workspaces.get(agent.workspace_id);
  if (!ws) { res.status(404).json({ error: 'workspace not found' }); return null; }
  return ws;
}
api.get('/agents/:id/skills', (req, res) => {
  const ws = agentWorkspaceOr404(req, res);
  if (!ws) return;
  res.json(listSkills(ws.path));
});
api.get('/agents/:id/skills/importable', (req, res) => {
  const ws = agentWorkspaceOr404(req, res);
  if (!ws) return;
  res.json(listImportableSkills(ws.path, Workspaces.all()));
});
api.post('/agents/:id/skills/import', (req, res) => {
  const ws = agentWorkspaceOr404(req, res);
  if (!ws) return;
  const { sourceWorkspaceId, name, overwrite, move } = req.body || {};
  const scope = req.body?.scope === 'user' ? 'user' : req.body?.scope === 'project' ? 'project' : null;
  if (!scope) return res.status(400).json({ error: 'scope는 user 또는 project여야 합니다' });
  const sourceWs = Workspaces.get(Number(sourceWorkspaceId));
  if (!sourceWs) return res.status(404).json({ error: '원본 프로젝트를 찾을 수 없습니다' });
  const srcDir = path.join(sourceWs.path, '.claude', 'skills', String(name || ''));
  try {
    const saved = copySkill({ srcDir, wsPath: ws.path, scope, name, overwrite: !!overwrite, move: !!move });
    res.json(saved);
  } catch (e) {
    if (e.code === 'EXISTS') return res.status(409).json({ error: e.message, exists: true });
    res.status(400).json({ error: e.message });
  }
});
api.get('/agents/:id/skills/:name', (req, res) => {
  const ws = agentWorkspaceOr404(req, res);
  if (!ws) return;
  const skill = listSkills(ws.path).find((s) => s.name === req.params.name && (!req.query.scope || s.scope === req.query.scope));
  if (!skill) return res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
  let body = '';
  try { body = parseFrontmatter(fs.readFileSync(skill.file, 'utf8')).body; } catch {}
  res.json({ ...skill, body });
});
api.put('/agents/:id/skills/:name', (req, res) => {
  const ws = agentWorkspaceOr404(req, res);
  if (!ws) return;
  const name = req.params.name;
  if (!validateSkillName(name)) return res.status(400).json({ error: '스킬 이름은 소문자·숫자·하이픈만 사용할 수 있습니다' });
  const scope = req.body?.scope === 'user' ? 'user' : req.body?.scope === 'project' ? 'project' : null;
  if (!scope) return res.status(400).json({ error: 'scope는 user 또는 project여야 합니다' });
  const description = String(req.body?.description || '').trim();
  if (!description) return res.status(400).json({ error: '설명을 입력하세요' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: '내용을 입력하세요' });
  try {
    const saved = writeSkill({ wsPath: ws.path, scope, name, description, body });
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.delete('/agents/:id/skills/:name', (req, res) => {
  const ws = agentWorkspaceOr404(req, res);
  if (!ws) return;
  const scope = req.query.scope === 'user' ? 'user' : req.query.scope === 'project' ? 'project' : null;
  if (!scope) return res.status(400).json({ error: 'scope는 user 또는 project여야 합니다' });
  try {
    deleteSkill({ wsPath: ws.path, scope, name: req.params.name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post('/approvals/:id', (req, res) => {
  const { decision, message, updatedInput, scope } = req.body || {};
  if (!['allow', 'deny'].includes(decision)) return res.status(400).json({ error: 'decision must be allow|deny' });
  const r = resolveApproval(Number(req.params.id), decision, { message, updatedInput, scope: scope === 'run' ? 'run' : null });
  if (!r) return res.status(404).json({ error: 'approval not pending' });
  res.json(r);
});
// "이번 작업 동안 모두 허용" can be switched on or off again mid-run from the phone.
api.post('/agents/:id/blanket', (req, res) => {
  const id = Number(req.params.id);
  const a = Agents.get(id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const on = !!req.body?.on;
  if (on && !(isRunning(id) || a.status === 'working' || a.status === 'needs_attention')) return res.status(400).json({ error: '진행 중인 작업이 없습니다' });
  setBlanketAllow(id, on);
  if (on) {
    for (const ap of Approvals.pendingForAgent(id)) if (ap.tool_name !== 'AskUserQuestion' && !ap.risk) resolveApproval(ap.id, 'allow');
  }
  res.json(agentView(Agents.get(id)));
});

// ---------- 되돌리기: revert everything one run changed ----------
api.post('/agents/:id/undo/:snapshot', async (req, res) => {
  const id = Number(req.params.id);
  const a = Agents.get(id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (isRunning(id) || a.status === 'working' || a.status === 'needs_attention') return res.status(400).json({ error: '작업이 끝난 뒤 되돌리세요' });
  const snap = Snapshots.get(Number(req.params.snapshot));
  if (!snap || snap.agent_id !== id || !snap.after_tree) return res.status(404).json({ error: '되돌릴 기록을 찾을 수 없습니다' });
  if (snap.undone_at) return res.status(400).json({ error: '이미 되돌린 작업입니다' });
  const ws = Workspaces.get(a.workspace_id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  try {
    const r = await restoreTree(ws.path, snap.after_tree, snap.before_tree);
    Snapshots.markUndone(snap.id);
    const m = Messages.add(id, 'system', `되돌림 · 파일 ${r.files}개를 작업 전 상태로 돌려놓았습니다`, { snapshot_id: snap.id, undone: true });
    emit('message', { agent_id: id, message: m });
    emit('snapshot.undone', { agent_id: id, snapshot_id: snap.id });
    res.json({ ok: true, files: r.files });
  } catch (e) {
    res.status(400).json({ error: e.message, detail: e.detail || null });
  }
});

// ---------- 예약 실행 ----------
function scheduleView(s) {
  return { ...s, days_label: describeDays(s.days), next_at: s.enabled ? nextDue(s.time, s.days) : null };
}
api.get('/agents/:id/schedules', (req, res) => {
  if (!Agents.get(Number(req.params.id))) return res.status(404).json({ error: 'not found' });
  res.json({ schedules: Schedules.forAgent(Number(req.params.id)).map(scheduleView), day_labels: DAY_LABEL });
});
api.post('/agents/:id/schedules', (req, res) => {
  const id = Number(req.params.id);
  if (!Agents.get(id)) return res.status(404).json({ error: 'not found' });
  const text = String(req.body?.text || '').trim();
  const time = String(req.body?.time || '').trim();
  if (!text) return res.status(400).json({ error: '지시 내용을 입력하세요' });
  if (!isValidTime(time)) return res.status(400).json({ error: '시각은 HH:MM 형식입니다' });
  const s = Schedules.create(id, text, time, normalizeDays(req.body?.days));
  emit('agent.updated', { agent: agentView(Agents.get(id)) });
  res.json(scheduleView(s));
});
api.patch('/schedules/:id', (req, res) => {
  const s = Schedules.get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'not found' });
  const fields = {};
  if (typeof req.body?.text === 'string' && req.body.text.trim()) fields.text = req.body.text.trim();
  if ('time' in (req.body || {})) {
    if (!isValidTime(req.body.time)) return res.status(400).json({ error: '시각은 HH:MM 형식입니다' });
    fields.time = req.body.time;
  }
  if ('days' in (req.body || {})) fields.days = normalizeDays(req.body.days);
  if ('enabled' in (req.body || {})) fields.enabled = req.body.enabled ? 1 : 0;
  res.json(scheduleView(Schedules.update(s.id, fields)));
});
api.delete('/schedules/:id', (req, res) => {
  const s = Schedules.get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'not found' });
  Schedules.remove(s.id);
  emit('agent.updated', { agent: agentView(Agents.get(s.agent_id)) });
  res.json({ ok: true });
});
api.post('/schedules/:id/run', (req, res) => {
  const s = Schedules.get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'not found' });
  try {
    res.json(agentView(runSchedule(s, cfg, { manual: true })));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 오늘 한 일 요약 ----------
api.get('/digest', (req, res) => {
  try {
    res.json({ ...buildDigest(req.query.date ? String(req.query.date) : undefined, String(req.query.period || 'day')), settings: digestSettings() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/digest/send', async (req, res) => {
  await sendDigestPush();
  res.json({ ok: true, subscriptions: PushSubs.all().length });
});
api.patch('/digest/settings', (req, res) => {
  if ('enabled' in (req.body || {})) Settings.set('digest_enabled', req.body.enabled ? '1' : '0');
  if ('time' in (req.body || {})) {
    if (!isValidTime(req.body.time)) return res.status(400).json({ error: '시각은 HH:MM 형식입니다' });
    Settings.set('digest_time', req.body.time);
  }
  res.json(digestSettings());
});

// ---------- 앱 전체 설정 ----------
api.patch('/settings', (req, res) => {
  try {
    if ('answer_style' in (req.body || {})) setAnswerStyle(String(req.body.answer_style));
    res.json({ answer_style: answerStyle() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 자주 쓰는 지시 ----------
const promptFields = (body) => {
  const text = String(body?.text ?? '').trim();
  const title = String(body?.title ?? '').trim() || text.replace(/\s+/g, ' ').slice(0, 24);
  if (!text) throw new Error('지시 내용을 입력하세요');
  return { title: title.slice(0, 40), text: text.slice(0, 4000) };
};
api.get('/prompts', (req, res) => res.json({ prompts: SavedPrompts.all() }));
api.post('/prompts', (req, res) => {
  try {
    const { title, text } = promptFields(req.body);
    res.json(SavedPrompts.create(title, text));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
api.patch('/prompts/:id', (req, res) => {
  const p = SavedPrompts.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    res.json(SavedPrompts.update(p.id, promptFields({ ...p, ...req.body })));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
api.post('/prompts/:id/use', (req, res) => {
  const p = SavedPrompts.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  SavedPrompts.touch(p.id);
  res.json(SavedPrompts.get(p.id));
});
api.delete('/prompts/:id', (req, res) => {
  SavedPrompts.remove(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 자동 백업 ----------
api.get('/backup', (req, res) => res.json(backupStatus(cfg)));
api.post('/backup', (req, res) => {
  try {
    const r = runBackup(cfg);
    res.json({ ...r, status: backupStatus(cfg) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'bad subscription' });
  PushSubs.upsert(sub);
  res.json({ ok: true });
});
api.post('/push/test', async (req, res) => {
  await sendPush({ title: 'leebeegle_SmartAgent', body: '푸시 알림이 정상 동작합니다.', url: '/' }, { urgent: true });
  res.json({ ok: true, subscriptions: PushSubs.all().length });
});

// ---------- 방해금지 시간 ----------
const quietView = () => ({ ...quietSettings(), active: isQuietNow(), held: heldNotifications().length });
api.get('/quiet', (req, res) => res.json(quietView()));
api.patch('/quiet', (req, res) => {
  try { saveQuietSettings(req.body || {}); res.json(quietView()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 텔레그램 연동 ----------
api.get('/telegram', (req, res) => res.json(telegramStatus()));
api.post('/telegram', async (req, res) => {
  try { res.json(await configureTelegram(req.body?.token)); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.delete('/telegram', (req, res) => res.json(unlinkTelegram()));
// 알림 잠깐 끄기: { minutes: 0 } 다시 켬, { minutes: 120 } 2시간, { minutes: null } 다시 켤 때까지
api.post('/telegram/mute', (req, res) => res.json(muteTelegram(req.body?.minutes)));
api.post('/telegram/test', async (req, res) => {
  try {
    await sendTelegram({ title: 'leebeegle_SmartAgent', body: '텔레그램 연결이 정상입니다. 이제 승인 요청과 완료 보고가 여기로 옵니다.', url: '/', force: true });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});


// Captured screenshots. <img> tags cannot send the bearer header, so the phone passes ?token=.
api.get('/captures/:dir/:name', (req, res) => {
  const { dir, name } = req.params;
  if (!/^agent-\d+$/.test(dir) || !/^\d+\.png$/.test(name)) return res.status(400).end();
  const p = path.join(CAPTURE_DIR, dir, name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(p);
});

// Phone attachments: one file per request as a raw body (no multipart parser in this project).
api.post('/agents/:id/uploads', express.raw({ type: () => true, limit: '400mb' }), async (req, res) => {
  const agentId = Number(req.params.id);
  if (!Agents.get(agentId)) return res.status(404).json({ error: 'agent not found' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '빈 파일입니다' });
  let name = '';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
  try {
    const descriptor = await saveUpload({ agentId, name, mime: req.headers['content-type'], buffer: req.body });
    res.json(descriptor);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// Original + derived (resized photo / video scene frames) attachment files. Same ?token= pattern as captures.
api.get('/uploads/:dir/:name', (req, res) => {
  const { dir, name } = req.params;
  if (!/^agent-\d+$/.test(dir) || !/^[\w.-]+\.(jpe?g|png|gif|webp|heic|heif|mp4|mov|webm|m4v|3gp)$/i.test(name)) return res.status(400).end();
  const p = path.join(UPLOAD_DIR, dir, name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(p);
});

app.use('/api', api);

// ---------- internal: screenshot requested by the agent's `capture` MCP tool ----------
// ---------- restart: the only safe way to bounce this server from inside an agent turn ----------
// Agents run as children of this process, so killing it mid-turn cuts their own tool output. We
// note the request, let every running turn finish, then hand off to scripts/restart-server.ps1
// (which relaunches through the logon task) and exit.
let restartPending = null;
function scheduleRestart(reason, agentId) {
  if (restartPending) return restartPending;
  restartPending = { reason, agentId, at: Date.now() };
  if (agentId) {
    const m = Messages.add(agentId, 'system', '서버 재시작 예약 · 이 답변이 끝나면 5초 안에 다시 켜집니다');
    emit('message', { agent_id: agentId, message: m });
  }
  const tick = setInterval(() => {
    if (runningIds().length) return;
    clearInterval(tick);
    console.log(`restart requested (${reason}); relaunching via scripts/restart-server.ps1`);
    // A directly spawned PowerShell dies with this process even when detached; going through
    // `cmd start` hands it to a fresh console-less session that outlives us.
    const script = path.join(ROOT_DIR, 'scripts', 'restart-server.ps1').replace(/'/g, "''");
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/b', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' -DelaySeconds 2`], {
      cwd: ROOT_DIR, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', (e) => console.error('restart spawn failed:', e.message));
    child.unref();
    setTimeout(() => process.exit(0), 800);
  }, 1000);
  return restartPending;
}
app.post('/internal/restart', requireInternal, (req, res) => {
  const agentId = Number(req.body?.agentId) || null;
  scheduleRestart(req.body?.reason || 'agent', agentId);
  res.json({ ok: true, pending: true });
});
api.post('/restart', (req, res) => {
  scheduleRestart('user', null);
  res.json({ ok: true, pending: true });
});

/** 같은 화면(source)을 이 담당자가 최근에 찍은 캡처. 'before' 표시가 있으면 시간 제한 없이, 아니면 24시간 안의 것만. */
function previousCapture(agentId, source, explicitAfter) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  for (const m of Messages.recentByRole(agentId, ['image'], 30).reverse()) {
    let meta = {};
    try { meta = m.meta ? JSON.parse(m.meta) : {}; } catch { continue; }
    if (meta.source !== source || !meta.file) continue;
    if (meta.phase === 'before' || explicitAfter || m.created_at >= since) return { file: meta.file, width: meta.width, height: meta.height, caption: m.content, at: m.created_at };
    return null;
  }
  return null;
}
app.post('/internal/capture', requireInternal, async (req, res) => {
  const { agentId, url, file, html, caption, width, height, full_page, wait_ms, fit_width_px, phase } = req.body || {};
  const agent = Agents.get(Number(agentId));
  if (!agent) return res.status(400).json({ error: 'unknown agent' });
  const workspace = Workspaces.get(agent.workspace_id);
  try {
    const shot = await captureScreenshot({ agentId: agent.id, url, file, html, width, height, fullPage: !!full_page, waitMs: wait_ms, fitWidthPx: fit_width_px, workspacePath: workspace?.path });
    const source = url || file || 'html';
    // 전·후 비교: 같은 화면을 전에 찍어 둔 게 있으면(phase 'before'로 찍었거나 24시간 안) 나란히 보여준다.
    const before = phase === 'before' ? null : previousCapture(agent.id, source, phase === 'after');
    const label = String(caption || '').trim() || (phase === 'before' ? '고치기 전' : before ? '고친 뒤' : '결과 화면');
    const m = Messages.add(agent.id, 'image', label, { file: shot.file, width: shot.width, height: shot.height, source, ...(phase ? { phase } : {}), ...(before ? { before } : {}) });
    emit('message', { agent_id: agent.id, message: m });
    res.json({ ok: true, ...shot });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 영상 파일 보내기(2026-09-17): 에이전트의 `send_file` MCP 도구. PC의 mp4/mov/webm/m4v(또는 사진)를
// 폰 첨부 저장소(data/uploads/agent-N)로 복사하고, 채팅에 바로 재생되는 'video' 메시지를 올린다.
// 완성 영상을 유튜브를 거치지 않고 폰에서 바로 확인하려는 용도. 썸네일은 saveUpload가 ffmpeg로 뽑는다.
const SEND_FILE_MIME = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const SEND_FILE_MAX = 400 * 1024 * 1024;
app.post('/internal/send_file', requireInternal, async (req, res) => {
  const { agentId, file, caption } = req.body || {};
  const agent = Agents.get(Number(agentId));
  if (!agent) return res.status(400).json({ error: 'unknown agent' });
  const workspace = Workspaces.get(agent.workspace_id);
  try {
    const raw = String(file || '').trim();
    if (!raw) throw new Error('file 인자가 비었습니다');
    const abs = path.isAbsolute(raw) ? raw : path.resolve(workspace?.path || process.cwd(), raw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`파일이 없습니다: ${abs}`);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = SEND_FILE_MIME[ext];
    if (!mime) throw new Error(`보낼 수 없는 형식입니다(.${ext}). mp4·mov·webm·m4v·jpg·png·gif·webp만 됩니다`);
    const size = fs.statSync(abs).size;
    if (size > SEND_FILE_MAX) throw new Error(`파일이 너무 큽니다(${Math.round(size / 1048576)}MB, 최대 400MB)`);
    const saved = await saveUpload({ agentId: agent.id, name: path.basename(abs), mime, buffer: fs.readFileSync(abs) });
    const label = String(caption || '').trim() || path.basename(abs);
    const m = Messages.add(agent.id, saved.kind === 'video' ? 'video' : 'image-file', label, {
      file: saved.file, name: saved.name, size: saved.size, mime: saved.mime,
      ...(saved.poster ? { poster: saved.poster } : {}), ...(saved.view ? { view: saved.view } : {}),
      ...(saved.width ? { width: saved.width, height: saved.height } : {}), ...(saved.duration ? { duration: saved.duration } : {}),
    });
    emit('message', { agent_id: agent.id, message: m });
    res.json({ ok: true, kind: saved.kind, size: saved.size, duration: saved.duration || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 배경 작업: run_job(서버가 띄움) / watch_job(로그만 감시). 끝나면 아래 handler가 에이전트에게 후속 지시를 넣는다.
app.post('/internal/jobs', requireInternal, (req, res) => {
  const { agentId, mode, command, label, cwd, shell, log_file, pid } = req.body || {};
  const agent = Agents.get(Number(agentId));
  if (!agent) return res.status(400).json({ error: 'unknown agent' });
  const workspace = Workspaces.get(agent.workspace_id);
  try {
    const job = mode === 'watch'
      ? watchLog(agent.id, { log_file, label, pid, workspacePath: workspace?.path })
      : startJob(agent.id, { command, label, cwd, shell, workspacePath: workspace?.path });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
setJobFinishedHandler((agentId, job, outcome, tail) => {
  const agent = Agents.get(agentId);
  if (!agent) return;
  const prompt = jobFollowUpPrompt(job, outcome, tail);
  const display = `배경 작업 확인 · ${job.label} · ${outcome === 'done' ? '끝남' : outcome === 'stalled' ? '멈춤' : '실패'} (시도 ${job.attempt})`;
  const extra = { direct: true, display };
  try {
    // 담당자가 일하는 중이면 줄을 세운다. 계획 확인 대기 중이면 대표 결정이 먼저라 그 뒤에 이어간다.
    if (isRunning(agentId) || agent.status === 'working' || agent.pending_plan) enqueuePrompt(agentId, prompt, extra);
    else startPrompt(agentId, prompt, cfg, extra);
  } catch (e) {
    console.error('[jobs] follow-up', e.message);
  }
});
restoreJobs();

// ---------- internal: approval long-poll from the MCP approver ----------
app.post('/internal/approval', requireInternal, async (req, res) => {
  const { agentId, toolName, input, approvalId, risk } = req.body || {};
  let id = approvalId;
  let promise;
  if (id) {
    promise = waitForApproval(id);
    if (!promise) return res.json({ result: { behavior: 'deny', message: 'approval expired' } });
  } else {
    const r = requestApproval(Number(agentId), toolName, input, { risk });
    if (!r) return res.json({ result: { behavior: 'deny', message: 'unknown agent' } });
    id = r.approval.id;
    promise = r.promise;
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 25_000));
  const result = await Promise.race([promise, timeout]);
  if (!result) return res.json({ pending: true, approvalId: id });
  res.json({ result });
});

// ---------- static ----------
// Phones (especially installed PWAs) happily reuse a stale style.css/app.js for days without an
// explicit policy; make every static asset revalidate (ETag) on each load so UI updates land.
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
}));

// ---------- websocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== cfg.token) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', running: runningIds(), ts: Date.now() }));
});
bus.on('event', (ev) => {
  const data = JSON.stringify(ev);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});
setInterval(() => {
  for (const c of wss.clients) if (c.readyState === 1) c.ping();
}, 30_000).unref();
// PC 클로드 앱과 대화를 같이 쓰는 담당자는 PC 쪽에서 새로 오간 말을 주기적으로 폰 화면에 옮긴다(파일 크기만 보므로 가볍다).
setInterval(() => {
  for (const a of Agents.all()) if (a.desktop_host_id && !isRunning(a.id)) { try { syncDesktopTranscript(a.id); } catch {} }
}, 15_000).unref();

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`leebeegle_SmartAgent listening on http://localhost:${cfg.port}`);
  console.log(process.stdout.isTTY ? `Access token: ${cfg.token}` : 'Access token: stored in data/config.json');
  console.log(`Claude binary: ${findClaudeBin()}`);
  try { console.log(`Desktop Claude app: ${listDesktopSessions().length} chats (${desktopRoot()}) · APPDATA=${process.env.APPDATA || "(unset)"}`); } catch (e) { console.log(`Desktop Claude app: unreadable · ${e.message}`); }
  console.log(`Codex CLI: ${findCodexEntry() ? 'found' : 'not installed'}`);
  console.log(`Antigravity CLI (Gemini): ${findGeminiEntry() ? `found · models ${refreshGeminiModels().join(', ')}` : 'not installed'}`);
  // 켜질 때 agy 로그인 상태를 한 번 확인해 둔다(PC에서 직접 로그인했어도 앱이 알아채도록).
  if (findGeminiEntry()) geminiProbeLogin().then((p) => { console.log(`Antigravity login: ${p.loggedIn ? p.email : 'none'}`); if (p.loggedIn) emit('gemini.accounts', { accounts: geminiAccounts() }); }).catch(() => {});
});
