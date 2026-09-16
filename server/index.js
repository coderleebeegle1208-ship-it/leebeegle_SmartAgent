// Agent Remote — phone-first dashboard for Claude Code / Codex running on this PC.
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
import { requestApproval, waitForApproval, resolveApproval, setBlanketAllow, blanketAllow } from './approvals.js';
import { DAY_LABEL, describeDays, digestSettings, isValidTime, nextDue, normalizeDays, runSchedule, sendDigestPush, startScheduler } from './scheduler.js';
import { buildDigest } from './digest.js';
import { backupStatus, runBackup } from './backup.js';
import { startPrompt, stopAgent, isRunning, runningIds, executePlan, switchProvider, compactAgent } from './runners/index.js';
import { findClaudeBin } from './runners/claude.js';
import { findCodexEntry } from './runners/codex.js';
import { getUsage } from './usage.js';
import { CAPTURE_DIR, captureScreenshot, findBrowserBin } from './capture.js';
import { CODEX_MODEL_CATALOG, MODEL_CATALOG, codexDefaults, isCodexModelAllowed, isModelAllowed } from './models.js';
import { UPLOAD_DIR, findFfmpeg, loadUpload, saveUpload } from './uploads.js';
import { copySkill, deleteSkill, listImportableSkills, listSkills, parseFrontmatter, validateSkillName, writeSkill } from './skills.js';

const cfg = loadConfig();
initPush(cfg);
startScheduler(cfg);

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
    provider_sessions: { claude: !!saved.claude, codex: !!saved.codex },
    compact_limit: cfg.compactAfterTokens || 0,
    blanket_allow: !!blanketAllow(a.id),
    schedules: Schedules.forAgent(a.id).length,
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
  const agents = Agents.all().map(agentView);
  const counts = { all: agents.length, needs_attention: 0, working: 0, done: 0, error: 0, idle: 0 };
  for (const a of agents) counts[a.status] = (counts[a.status] || 0) + 1;
  res.json({
    computer: { name: os.hostname(), platform: process.platform, ...stats, connected: true },
    tools: { claude: findClaudeBin(), codex: !!findCodexEntry(), capture: !!findBrowserBin(), ffmpeg: !!findFfmpeg() },
    models: MODEL_CATALOG,
    codex: { models: CODEX_MODEL_CATALOG, ...codexDefaults() },
    workspaces,
    agents,
    counts,
  });
});

api.get('/usage', async (req, res) => {
  const provider = req.query.provider === 'codex' ? 'codex' : 'claude';
  res.json(await getUsage(provider, req.query.refresh === '1'));
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
  for (const a of Agents.byWorkspace(id)) stopAgent(a.id);
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
  const { workspace_id, kind, name, model, effort, codex_model, codex_effort, plan_effort, exec_effort, permission_mode, pipeline, triage_model, plan_model, exec_model, confirm_plan, collab_mode } = req.body || {};
  const ws = Workspaces.get(Number(workspace_id));
  if (!ws) return res.status(400).json({ error: 'workspace not found' });
  const k = kind === 'codex' ? 'codex' : 'claude';
  let agent = Agents.create(ws.id, k, name?.trim() || (k === 'codex' ? 'Codex' : 'Claude'));
  const fields = {};
  if (k === 'codex') {
    if (isCodexModelAllowed(codex_model || model)) fields.codex_model = codex_model || model;
    if (EFFORTS.includes(codex_effort || effort)) fields.codex_effort = codex_effort || effort;
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
  if (Object.keys(fields).length) agent = Agents.update(agent.id, fields);
  emit('agent.updated', { agent: agentView(agent) });
  res.json(agentView(agent));
});
api.get('/agents/:id', (req, res) => {
  const a = Agents.get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({
    agent: agentView(a),
    workspace: Workspaces.get(a.workspace_id),
    messages: Messages.forAgent(a.id, Number(req.query.limit) || 300),
    approvals: Approvals.pendingForAgent(a.id),
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
  if ('plan_effort' in (req.body || {})) fields.plan_effort = EFFORTS.includes(req.body.plan_effort) ? req.body.plan_effort : null;
  if ('exec_effort' in (req.body || {})) fields.exec_effort = EFFORTS.includes(req.body.exec_effort) ? req.body.exec_effort : null;
  if (['auto', 'manual'].includes(req.body?.pipeline)) fields.pipeline = req.body.pipeline;
  if (isModelAllowed('triage', req.body?.triage_model)) fields.triage_model = req.body.triage_model;
  if (isModelAllowed('plan', req.body?.plan_model)) fields.plan_model = req.body.plan_model;
  if (isModelAllowed('exec', req.body?.exec_model)) fields.exec_model = req.body.exec_model;
  if ('confirm_plan' in (req.body || {})) fields.confirm_plan = req.body.confirm_plan ? 1 : 0;
  if ('auto_failover' in (req.body || {})) fields.auto_failover = req.body.auto_failover ? 1 : 0;
  if ('collab_mode' in (req.body || {})) fields.collab_mode = req.body.collab_mode ? 1 : 0;
  if (req.body?.reset_session) {
    fields.session_id = null;
    AgentSessions.clear(id);
  }
  // Changing the running model mid-conversation means the next turn re-writes the whole
  // conversation into that model's own cache — a one-time cost worth flagging, not hiding by
  // clearing the session (that would also throw away the conversation memory).
  const modelFields = ['model', 'codex_model', 'exec_model'];
  const modelChanged = current.session_id && modelFields.some((f) => f in fields && fields[f] !== current[f]);
  const a = Agents.update(id, fields);
  if (req.body?.clear_messages) Messages.clear(id);
  if (modelChanged) {
    // Summarize into a memo instead of resuming: the alternative is re-writing the whole
    // conversation into the new model's cache on the next turn, which costs far more.
    compactAgent(id, cfg, { reason: 'model-change' }).catch(() => {
      const m = Messages.add(id, 'system', '실행 모델이 바뀌어 다음 지시는 대화를 새 모델에 다시 기억시킵니다(한 번만 비용이 더 듭니다).');
      emit('message', { agent_id: id, message: m });
    });
  }
  emit('agent.updated', { agent: agentView(a) });
  res.json(agentView(a));
});
api.delete('/agents/:id', (req, res) => {
  const id = Number(req.params.id);
  stopAgent(id);
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
    const a = startPrompt(id, text, cfg, { attachments, links });
    res.json(agentView(a));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
    res.json(agentView(executePlan(Number(req.params.id), cfg)));
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
  res.json({ ok: stopped });
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
  await sendPush({ title: 'leebeegle_SmartAgent', body: '푸시 알림이 정상 동작합니다.', url: '/' });
  res.json({ ok: true, subscriptions: PushSubs.all().length });
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

app.post('/internal/capture', requireInternal, async (req, res) => {
  const { agentId, url, file, html, caption, width, height, full_page, wait_ms, fit_width_px } = req.body || {};
  const agent = Agents.get(Number(agentId));
  if (!agent) return res.status(400).json({ error: 'unknown agent' });
  const workspace = Workspaces.get(agent.workspace_id);
  try {
    const shot = await captureScreenshot({ agentId: agent.id, url, file, html, width, height, fullPage: !!full_page, waitMs: wait_ms, fitWidthPx: fit_width_px, workspacePath: workspace?.path });
    const m = Messages.add(agent.id, 'image', String(caption || '').trim() || '결과 화면', { file: shot.file, width: shot.width, height: shot.height, source: url || file || 'html' });
    emit('message', { agent_id: agent.id, message: m });
    res.json({ ok: true, ...shot });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`leebeegle_SmartAgent listening on http://localhost:${cfg.port}`);
  console.log(process.stdout.isTTY ? `Access token: ${cfg.token}` : 'Access token: stored in data/config.json');
  console.log(`Claude binary: ${findClaudeBin()}`);
  console.log(`Codex CLI: ${findCodexEntry() ? 'found' : 'not installed'}`);
});
