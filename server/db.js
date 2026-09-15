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
`);

// Lightweight migrations for columns added after the first release.
for (const [table, col, def] of [
  ['agents', 'model', 'TEXT'],
  ['agents', 'effort', 'TEXT'],
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
  add: (agent_id, role, content, meta) => {
    const r = db.prepare('INSERT INTO messages (agent_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(agent_id, role, content, meta ? JSON.stringify(meta) : null, now());
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(r.lastInsertRowid));
  },
  clear: (aid) => db.prepare('DELETE FROM messages WHERE agent_id = ?').run(aid),
  latestId: (aid) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE agent_id = ?').get(aid)?.id || 0),
  after: (aid, id) => db.prepare('SELECT * FROM messages WHERE agent_id = ? AND id > ? ORDER BY id').all(aid, id),
  usageSummary: (aid) => {
    const row = (sinceMs) => db.prepare(`
      SELECT COUNT(*) AS runs,
             COALESCE(SUM(json_extract(meta, '$.total.tokens')), 0) AS tokens,
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
  create: (agent_id, tool_name, input) => {
    const r = db.prepare('INSERT INTO approvals (agent_id, tool_name, input_json, created_at) VALUES (?, ?, ?, ?)')
      .run(agent_id, tool_name, JSON.stringify(input), now());
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

export default db;
