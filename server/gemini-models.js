// Keeps the Gemini model list in step with the installed Antigravity CLI. `agy models` prints
// "<slug>\t<label>" rows for the logged-in account; we run it once per agy build (re-run when the
// binary changes, i.e. after an update) and keep the last answer on disk so a restart shows the
// right list immediately. Until the first answer arrives models.js serves its hand-written floor.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findGeminiEntry, GEMINI_DIR } from './runners/gemini.js';
import { registerGeminiModels } from './models.js';

const CACHE_FILE = path.join(GEMINI_DIR, 'models.json');
let cache = { key: null, rows: [] };
let inflight = null;

/** Pure: `agy models` output → [[slug, label], …]. The "Fetching…" line and blanks are dropped. */
export function parseAgyModels(text) {
  const rows = [];
  for (const raw of String(text || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^([a-z0-9][a-z0-9.-]*)\t(.+)$/i);
    if (m) rows.push([m[1].trim(), m[2].trim()]);
  }
  return rows;
}

function binaryKey() {
  const entry = findGeminiEntry();
  if (!entry) return null;
  try { const s = fs.statSync(entry.cmd); return `${entry.cmd}:${s.size}:${s.mtimeMs}`; } catch { return entry.cmd; }
}

function loadCache() {
  if (cache.key) return;
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (saved?.key && Array.isArray(saved.rows)) cache = saved;
  } catch {}
}

/** Runs `agy models` in the background and registers whatever it lists. Resolves to the rows. */
export function fetchGeminiModels() {
  if (inflight) return inflight;
  const entry = findGeminiEntry();
  if (!entry) return Promise.resolve([]);
  inflight = new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(entry.cmd, [...entry.pre, 'models'], { cwd: GEMINI_DIR, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve([]); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      const rows = parseAgyModels(out);
      if (rows.length) {
        cache = { key: binaryKey(), rows };
        try { fs.mkdirSync(GEMINI_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
        registerGeminiModels(rows);
      }
      resolve(rows);
    });
  }).finally(() => { inflight = null; });
  return inflight;
}

/** Register the last known list (sync) and refresh in the background if agy changed. Safe to call often. */
export function refreshGeminiModels() {
  fs.mkdirSync(GEMINI_DIR, { recursive: true });
  loadCache();
  const key = binaryKey();
  if (key && key !== cache.key) fetchGeminiModels();
  return registerGeminiModels(cache.rows);
}
