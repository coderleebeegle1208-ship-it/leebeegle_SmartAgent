// Subscription usage limits, read from `claude -p /usage` (same text the /usage command shows).
import { execFile } from 'node:child_process';
import { findClaudeBin, cleanClaudeEnv } from './runners/claude.js';

let cache = { at: 0, data: null, promise: null };
const TTL = 2 * 60 * 1000;

const LABELS = [
  [/^current session$/i, '5시간 세션'],
  [/^current week \(all models\)$/i, '주간 · 전체 모델'],
  [/^current week \((.+)\)$/i, (m) => `주간 · ${m[1]}`],
];

export function parseUsage(text) {
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(.+?):\s+(\d+)%\s+used(?:\s+·\s+resets\s+(.+))?$/i);
    if (!m) continue;
    let label = m[1];
    for (const [re, to] of LABELS) {
      const mm = label.match(re);
      if (mm) { label = typeof to === 'function' ? to(mm) : to; break; }
    }
    const resets = (m[3] || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    items.push({ label, pct: Number(m[2]), resets });
  }
  return items;
}

function fetchUsage() {
  return new Promise((resolve) => {
    execFile(
      findClaudeBin(),
      ['-p', '/usage', '--output-format', 'json'],
      { env: cleanClaudeEnv(), timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message, items: [] });
        try {
          const j = JSON.parse(stdout);
          const text = j.result || '';
          const items = parseUsage(text);
          if (!items.length) return resolve({ ok: false, error: text.slice(0, 200) || 'no data', items: [] });
          resolve({ ok: true, items, fetchedAt: Date.now() });
        } catch (e) {
          resolve({ ok: false, error: e.message, items: [] });
        }
      }
    );
  });
}

export async function getUsage(force = false) {
  const fresh = cache.data && Date.now() - cache.at < TTL;
  if (fresh && !force) return cache.data;
  if (!cache.promise) {
    cache.promise = fetchUsage().then((d) => {
      if (d.ok) { cache.data = d; cache.at = Date.now(); }
      cache.promise = null;
      return d.ok ? d : cache.data || d;
    });
  }
  return cache.promise;
}
