// 자동 백업 — a consistent copy of the SQLite database plus config.json, taken once per local day
// (first scheduler tick of the day, so a PC that sleeps at night still gets one when it wakes) and
// kept for `keep` days. `VACUUM INTO` snapshots the live WAL database safely without stopping the server.
import fs from 'node:fs';
import path from 'node:path';
import db, { Settings } from './db.js';
import { DATA_DIR } from './paths.js';
import { localDate } from './digest.js';

const CONFIG_PATH = process.env.AGENT_REMOTE_CONFIG || path.join(DATA_DIR, 'config.json');
export const DEFAULT_KEEP = 14;

export function backupDir(cfg = {}) {
  return process.env.AGENT_REMOTE_BACKUP_DIR || cfg.backupDir || path.join(DATA_DIR, 'backups');
}

/** Folders named YYYY-MM-DD inside the backup dir, newest first, with size and time. */
export function listBackups(cfg = {}) {
  const dir = backupDir(cfg);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && fs.existsSync(path.join(dir, n, 'app.sqlite')))
    .sort().reverse()
    .map((n) => {
      const st = fs.statSync(path.join(dir, n, 'app.sqlite'));
      return { date: n, bytes: st.size, at: st.mtimeMs };
    });
}

/** Writes today's backup (overwriting a same-day one) and drops folders beyond `keep`. */
export function runBackup(cfg = {}, { date = localDate(), keep = DEFAULT_KEEP } = {}) {
  const dir = backupDir(cfg);
  const target = path.join(dir, date);
  fs.mkdirSync(target, { recursive: true });
  const dbFile = path.join(target, 'app.sqlite');
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, path.join(target, 'config.json'));
  const stale = listBackups(cfg).slice(keep);
  for (const b of stale) fs.rmSync(path.join(dir, b.date), { recursive: true, force: true });
  Settings.set('backup_last', date);
  return { date, dir: target, bytes: fs.statSync(dbFile).size, removed: stale.length };
}

/** Called by the scheduler every tick: one backup per local day, whenever the server is up. */
export function backupIfDue(cfg = {}, now = Date.now()) {
  const today = localDate(new Date(now));
  if (Settings.get('backup_last') === today) return null;
  return runBackup(cfg, { date: today });
}

export function backupStatus(cfg = {}) {
  const list = listBackups(cfg);
  return { dir: backupDir(cfg), last: list[0] || null, count: list.length, keep: DEFAULT_KEEP, bytes: list.reduce((s, b) => s + b.bytes, 0) };
}
