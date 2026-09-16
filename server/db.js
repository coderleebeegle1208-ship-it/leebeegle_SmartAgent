// SQLite storage using Node's built-in node:sqlite (Node >= 22.13).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './paths.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.AGENT_REMOTE_DB || path.join(DATA_DIR, 'app.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- 'claude' | 'codex'
  name TEXT NOT NULL,
  session_id TEXT,                   -- claude session id / codex thread id
  status TEXT NOT NULL DEFAULT 'idle', -- idle | working | needs_attention | done | error
  permission_mode TEXT NOT NULL DEFAULT 'ask', -- ask | acceptEdits | auto
  last_response TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                -- user | assistant | tool | system | error
  content TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | allowed | denied | expired
  message TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, kind)
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  time TEXT NOT NULL,                -- 'HH:MM' local time
  days TEXT NOT NULL DEFAULT '',     -- '' = every day, else comma-separated 0(일)..6(토)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  before_tree TEXT NOT NULL,
  after_tree TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  undone_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS prompt_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  extra_json TEXT,            -- { attachments, links } as handed to startPrompt
  created_at INTEGER NOT NULL
);
`);

// Lightweight migrations for columns added after the first release.
for (const [table, col, def] of [
  ['agents', 'model', 'TEXT'],
  ['agents', 'effort', 'TEXT'],
  ['agents', 'codex_model', 'TEXT'],
  ['agents', 'codex_effort', 'TEXT'],
  ['workspaces', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'pipeline', "TEXT NOT NULL DEFAULT 'auto'"],      // auto | manual
  ['agents', 'triage_model', "TEXT NOT NULL DEFAULT 'haiku'"],
  ['agents', 'plan_model', "TEXT NOT NULL DEFAULT 'fable'"],
  ['agents', 'exec_model', "TEXT NOT NULL DEFAULT 'sonnet'"],
  ['agents', 'plan_effort', 'TEXT'],                          // null → 'high'
  ['agents', 'exec_effort', 'TEXT'],                          // null → CLI default
  ['agents', 'resolved_models', 'TEXT'],                      // JSON: stage → concrete model id last used
  ['agents', 'context_tokens', 'INTEGER NOT NULL DEFAULT 0'],  // tokens the main session read on its last turn
  ['agents', 'carry_note', 'TEXT'],                            // summary to prepend to the first turn after 대화 정리
  ['agents', 'confirm_plan', 'INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'pending_plan', 'INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'auto_failover', 'INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'collab_mode', 'INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'collab_stage', 'TEXT'],
  ['approvals', 'risk', 'TEXT'],                              // 'outside' → 작업 폴더 밖 변경, 묶음 허용에서 제외
]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (has) continue;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  // Agents created before per-stage effort existed keep their single "강도" for every stage.
  if (col === 'plan_effort' || col === 'exec_effort') db.exec(`UPDATE agents SET ${col} = effort WHERE effort IS NOT NULL`);
}

const now = () => Date.now();

export const Workspaces = {
  all: () => db.prepare('SELECT * FROM workspaces ORDER BY id').all(),
  get: (id) => db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id),
  create: (name, p) => {
    const r = db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(name, p, now());
    return Workspaces.get(Number(r.lastInsertRowid));
  },
  rename: (id, name) => db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id),
  setPinned: (id, pinned) => db.prepare('UPDATE workspaces SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id),
  remove: (id) => db.prepare('DELETE FROM workspaces WHERE id = ?').run(id),
};

export const Agents = {
  all: () => db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all(),
  byWorkspace: (wid) => db.prepare('SELECT * FROM agents WHERE workspace_id = ? ORDER BY id').all(wid),
  get: (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id),
  create: (workspace_id, kind, name) => {
    const t = now();
    const r = db.prepare(
      'INSERT INTO agents (workspace_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(workspace_id, kind, name, t, t);
    return Agents.get(Number(r.lastInsertRowid));
  },
  update: (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return Agents.get(id);
    const set = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE agents SET ${set}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
    return Agents.get(id);
  },
  remove: (id) => db.prepare('DELETE FROM agents WHERE id = ?').run(id),
};

export const Messages = {
  forAgent: (aid, limit = 200) =>
    db.prepare('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(aid, limit),
  /** Like forAgent, but only counts messages whose role is in `roles` — so "last N" means N turns
   * of actual conversation, not N rows once tool/system chatter (most of the table) is mixed in. */
  recentByRole: (aid, roles, limit = 30) => {
    const placeholders = roles.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? AND role IN (${placeholders}) ORDER BY id DESC LIMIT ?) ORDER BY id`
    ).all(aid, ...roles, limit);
  },
  add: (agent_id, role, content, meta) => {
    const r = db.prepare('INSERT INTO messages (agent_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(agent_id, role, content, meta ? JSON.stringify(meta) : null, now());
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(r.lastInsertRowid));
  },
  clear: (aid) => db.prepare('DELETE FROM messages WHERE agent_id = ?').run(aid),
  latestId: (aid) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE agent_id = ?').get(aid)?.id || 0),
  after: (aid, id) => db.prepare('SELECT * FROM messages WHERE agent_id = ? AND id > ? ORDER BY id').all(aid, id),
  usageSummary: (aid) => {
    // "fresh" matches the per-run headline's "새 토큰"+"캐시 저장" combined (input+output+cacheWrite).
    // Older rows predate the `total.fresh` field, so fall back to deriving it from their parts.
    const row = (sinceMs) => db.prepare(`
      SELECT COUNT(*) AS runs,
             COALESCE(SUM(json_extract(meta, '$.total.tokens')), 0) AS tokens,
             COALESCE(SUM(COALESCE(
               json_extract(meta, '$.total.fresh'),
               json_extract(meta, '$.total.input') + json_extract(meta, '$.total.output') + json_extract(meta, '$.total.cacheWrite')
             )), 0) AS fresh,
             COALESCE(SUM(json_extract(meta, '$.total.cacheRead')), 0) AS cache_read,
             SUM(json_extract(meta, '$.total.cost')) AS cost,
             SUM(json_extract(meta, '$.baseline.cost')) AS baseline_cost
      FROM messages WHERE agent_id = ? AND role = 'usage' AND created_at >= ?
    `).get(aid, sinceMs);
    const startOfDay = new Date(now()); startOfDay.setHours(0, 0, 0, 0);
    return { all: row(0), today: row(startOfDay.getTime()) };
  },
};

export const Approvals = {
  get: (id) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id),
  pending: () => db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all(),
  pendingForAgent: (aid) => db.prepare("SELECT * FROM approvals WHERE agent_id = ? AND status = 'pending' ORDER BY id").all(aid),
  create: (agent_id, tool_name, input, risk = null) => {
    const r = db.prepare('INSERT INTO approvals (agent_id, tool_name, input_json, created_at, risk) VALUES (?, ?, ?, ?, ?)')
      .run(agent_id, tool_name, JSON.stringify(input), now(), risk);
    return Approvals.get(Number(r.lastInsertRowid));
  },
  resolve: (id, status, message) => {
    db.prepare('UPDATE approvals SET status = ?, message = ?, resolved_at = ? WHERE id = ?').run(status, message ?? null, now(), id);
    return Approvals.get(id);
  },
  expireForAgent: (aid) =>
    db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE agent_id = ? AND status = 'pending'").run(now(), aid),
};

export const PushSubs = {
  all: () => db.prepare('SELECT * FROM push_subscriptions').all(),
  upsert: (sub) => {
    db.prepare(
      'INSERT INTO push_subscriptions (endpoint, subscription_json, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json'
    ).run(sub.endpoint, JSON.stringify(sub), now());
  },
  remove: (endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint),
};

export const AgentSessions = {
  get: (agentId, kind) => db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ? AND kind = ?').get(agentId, kind),
  forAgent: (agentId) => db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY kind').all(agentId),
  upsert: (agentId, kind, sessionId) => {
    db.prepare(`
      INSERT INTO agent_sessions (agent_id, kind, session_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, kind) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(agentId, kind, sessionId, now());
    return AgentSessions.get(agentId, kind);
  },
  remove: (agentId, kind) => db.prepare('DELETE FROM agent_sessions WHERE agent_id = ? AND kind = ?').run(agentId, kind),
  clear: (agentId) => db.prepare('DELETE FROM agent_sessions WHERE agent_id = ?').run(agentId),
};

export const Schedules = {
  all: () => db.prepare('SELECT * FROM schedules ORDER BY time, id').all(),
  enabled: () => db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY time, id').all(),
  forAgent: (aid) => db.prepare('SELECT * FROM schedules WHERE agent_id = ? ORDER BY time, id').all(aid),
  get: (id) => db.prepare('SELECT * FROM schedules WHERE id = ?').get(id),
  create: (agent_id, text, time, days) => {
    const r = db.prepare('INSERT INTO schedules (agent_id, text, time, days, created_at) VALUES (?, ?, ?, ?, ?)').run(agent_id, text, time, days, now());
    return Schedules.get(Number(r.lastInsertRowid));
  },
  update: (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return Schedules.get(id);
    db.prepare(`UPDATE schedules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    return Schedules.get(id);
  },
  remove: (id) => db.prepare('DELETE FROM schedules WHERE id = ?').run(id),
};

export const Snapshots = {
  get: (id) => db.prepare('SELECT * FROM turn_snapshots WHERE id = ?').get(id),
  create: (agent_id, before_tree) => {
    const r = db.prepare('INSERT INTO turn_snapshots (agent_id, before_tree, created_at) VALUES (?, ?, ?)').run(agent_id, before_tree, now());
    return Snapshots.get(Number(r.lastInsertRowid));
  },
  finish: (id, after_tree, files) => {
    db.prepare('UPDATE turn_snapshots SET after_tree = ?, files = ? WHERE id = ?').run(after_tree, files, id);
    return Snapshots.get(id);
  },
  markUndone: (id) => db.prepare('UPDATE turn_snapshots SET undone_at = ? WHERE id = ?').run(now(), id),
  /** Keeps only the newest `keep` rows per agent so the table (and the git objects it references) stay small. */
  prune: (aid, keep = 30) =>
    db.prepare('DELETE FROM turn_snapshots WHERE agent_id = ? AND id NOT IN (SELECT id FROM turn_snapshots WHERE agent_id = ? ORDER BY id DESC LIMIT ?)').run(aid, aid, keep),
};

/** 담당자가 바쁠 때 받아 둔 지시. 앞선 작업이 끝나면 순서대로 시작한다. */
export const Queue = {
  forAgent: (aid) => db.prepare('SELECT * FROM prompt_queue WHERE agent_id = ? ORDER BY id').all(aid),
  get: (id) => db.prepare('SELECT * FROM prompt_queue WHERE id = ?').get(id),
  add: (aid, text, extra) => {
    const r = db.prepare('INSERT INTO prompt_queue (agent_id, text, extra_json, created_at) VALUES (?, ?, ?, ?)')
      .run(aid, text, extra ? JSON.stringify(extra) : null, now());
    return Queue.get(Number(r.lastInsertRowid));
  },
  shift: (aid) => {
    const row = db.prepare('SELECT * FROM prompt_queue WHERE agent_id = ? ORDER BY id LIMIT 1').get(aid);
    if (row) db.prepare('DELETE FROM prompt_queue WHERE id = ?').run(row.id);
    return row || null;
  },
  remove: (id) => db.prepare('DELETE FROM prompt_queue WHERE id = ?').run(id),
  clear: (aid) => db.prepare('DELETE FROM prompt_queue WHERE agent_id = ?').run(aid),
};

export const SavedPrompts = {
  all: () => db.prepare('SELECT * FROM saved_prompts ORDER BY uses DESC, last_used_at DESC, id DESC').all(),
  get: (id) => db.prepare('SELECT * FROM saved_prompts WHERE id = ?').get(id),
  create: (title, text) => {
    const r = db.prepare('INSERT INTO saved_prompts (title, text, created_at) VALUES (?, ?, ?)').run(title, text, now());
    return SavedPrompts.get(Number(r.lastInsertRowid));
  },
  update: (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return SavedPrompts.get(id);
    db.prepare(`UPDATE saved_prompts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    return SavedPrompts.get(id);
  },
  touch: (id) => db.prepare('UPDATE saved_prompts SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(now(), id),
  remove: (id) => db.prepare('DELETE FROM saved_prompts WHERE id = ?').run(id),
};

export const Settings = {
  get: (key, fallback = null) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  set: (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value)),
  all: () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])),
};

/** Per-agent activity for one local day: how many requests came in, the last reply, and what it cost. */
export function dailyActivity(sinceMs, untilMs = now()) {
  return db.prepare(`
    SELECT a.id, a.name, a.kind, a.status, a.workspace_id, w.name AS workspace,
           (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id AND m.role = 'user' AND m.created_at >= ? AND m.created_at < ?) AS requests,
           (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id AND m.role = 'error' AND m.created_at >= ? AND m.created_at < ?) AS errors,
           (SELECT content FROM messages m WHERE m.agent_id = a.id AND m.role = 'assistant' AND m.created_at >= ? AND m.created_at < ? ORDER BY id DESC LIMIT 1) AS last_reply,
           (SELECT COALESCE(SUM(COALESCE(json_extract(meta, '$.total.fresh'), json_extract(meta, '$.total.input') + json_extract(meta, '$.total.output') + json_extract(meta, '$.total.cacheWrite'))), 0)
              FROM messages m WHERE m.agent_id = a.id AND m.role = 'usage' AND m.created_at >= ? AND m.created_at < ?) AS fresh,
           (SELECT SUM(json_extract(meta, '$.total.cost')) FROM messages m WHERE m.agent_id = a.id AND m.role = 'usage' AND m.created_at >= ? AND m.created_at < ?) AS cost,
           (SELECT COALESCE(SUM(files), 0) FROM turn_snapshots s WHERE s.agent_id = a.id AND s.created_at >= ? AND s.created_at < ? AND s.undone_at IS NULL) AS files
    FROM agents a JOIN workspaces w ON w.id = a.workspace_id
    ORDER BY a.updated_at DESC
  `).all(sinceMs, untilMs, sinceMs, untilMs, sinceMs, untilMs, sinceMs, untilMs, sinceMs, untilMs, sinceMs, untilMs)
    .filter((r) => r.requests > 0 || r.fresh > 0);
}

/** Per-local-day totals inside a range (for the week/month cost view). Days with nothing are omitted. */
export function dailyTotals(sinceMs, untilMs = now()) {
  return db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS date,
           SUM(role = 'user') AS requests,
           SUM(role = 'error') AS errors,
           COALESCE(SUM(CASE WHEN role = 'usage' THEN COALESCE(json_extract(meta, '$.total.fresh'), json_extract(meta, '$.total.input') + json_extract(meta, '$.total.output') + json_extract(meta, '$.total.cacheWrite')) END), 0) AS fresh,
           SUM(CASE WHEN role = 'usage' THEN json_extract(meta, '$.total.cost') END) AS cost
    FROM messages WHERE created_at >= ? AND created_at < ?
    GROUP BY date HAVING requests > 0 OR fresh > 0
    ORDER BY date
  `).all(sinceMs, untilMs);
}

export default db;
