// Subscription usage limits for Claude, Codex and Gemini.
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { findClaudeBin, cleanClaudeEnv } from './runners/claude.js';
import { findCodexEntry } from './runners/codex.js';
import { geminiUsage } from './gemini-accounts.js';

const caches = {
  claude: { at: 0, data: null, promise: null },
  codex: { at: 0, data: null, promise: null },
  gemini: { at: 0, data: null, promise: null },
};
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

function formatReset(seconds) {
  if (!seconds) return '';
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(Number(seconds) * 1000));
  } catch {
    return '';
  }
}

function windowLabel(window, fallback) {
  const mins = Number(window?.windowDurationMins) || 0;
  if (mins > 0 && mins <= 360) return '5시간 한도';
  if (mins >= 6 * 24 * 60 && mins <= 8 * 24 * 60) return '주간 한도';
  if (mins > 0 && mins % (24 * 60) === 0) return `${mins / (24 * 60)}일 한도`;
  if (mins > 0 && mins % 60 === 0) return `${mins / 60}시간 한도`;
  return fallback;
}

export function parseCodexRateLimits(payload) {
  const buckets = payload?.rateLimitsByLimitId || {};
  const snapshot = buckets.codex || payload?.rateLimits || Object.values(buckets)[0] || null;
  const items = [];
  const add = (window, fallback) => {
    if (!window || !Number.isFinite(Number(window.usedPercent))) return;
    items.push({
      label: windowLabel(window, fallback),
      pct: Math.max(0, Math.min(100, Number(window.usedPercent))),
      resets: formatReset(window.resetsAt),
    });
  };
  add(snapshot?.primary, '현재 한도');
  add(snapshot?.secondary, '추가 한도');
  return {
    ok: items.length > 0,
    provider: 'codex',
    items,
    plan: snapshot?.planType || null,
    credits: snapshot?.credits || null,
    fetchedAt: Date.now(),
    ...(items.length ? {} : { error: 'Codex 한도 정보가 없습니다' }),
  };
}

function fetchClaudeUsage() {
  return new Promise((resolve) => {
    execFile(
      findClaudeBin(),
      ['-p', '/usage', '--output-format', 'json'],
      { env: cleanClaudeEnv(), timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, provider: 'claude', error: err.message, items: [] });
        try {
          const j = JSON.parse(stdout);
          const text = j.result || '';
          const items = parseUsage(text);
          if (!items.length) return resolve({ ok: false, provider: 'claude', error: text.slice(0, 200) || 'no data', items: [] });
          resolve({ ok: true, provider: 'claude', items, fetchedAt: Date.now() });
        } catch (e) {
          resolve({ ok: false, provider: 'claude', error: e.message, items: [] });
        }
      }
    );
  });
}

function fetchCodexUsage() {
  const entry = findCodexEntry();
  if (!entry) return Promise.resolve({ ok: false, provider: 'codex', error: 'Codex를 찾지 못했습니다', items: [] });
  return new Promise((resolve) => {
    const child = spawn(entry.cmd, [...entry.pre, 'app-server', '--stdio'], {
      env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderrTail = '';
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      resolve(data);
    };
    const timer = setTimeout(() => finish({ ok: false, provider: 'codex', error: 'Codex 한도 조회 시간이 초과되었습니다', items: [] }), 15_000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-1000); });
    child.stdin.on('error', (err) => finish({ ok: false, provider: 'codex', error: err.message, items: [] }));
    child.on('error', (err) => finish({ ok: false, provider: 'codex', error: err.message, items: [] }));
    child.on('close', () => {
      if (!settled) finish({ ok: false, provider: 'codex', error: stderrTail.trim() || 'Codex 한도 조회가 종료되었습니다', items: [] });
    });
    rl.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish({ ok: false, provider: 'codex', error: message.error.message || 'Codex 연결 실패', items: [] });
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
      } else if (message.id === 2) {
        if (message.error) return finish({ ok: false, provider: 'codex', error: message.error.message || 'Codex 한도 조회 실패', items: [] });
        finish(parseCodexRateLimits(message.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'leebeegle-smart-agent', version: '0.1.0' }, capabilities: null } });
  });
}

export async function getUsage(provider = 'claude', force = false) {
  const kind = provider === 'codex' ? 'codex' : provider === 'gemini' ? 'gemini' : 'claude';
  const cache = caches[kind];
  const fresh = cache.data && Date.now() - cache.at < TTL;
  if (fresh && !force) return cache.data;
  if (!cache.promise) {
    // Gemini keeps its own per-account cache; the entry here only dedupes concurrent calls.
    const fetcher = kind === 'codex' ? fetchCodexUsage : kind === 'gemini' ? () => geminiUsage(force) : fetchClaudeUsage;
    cache.promise = fetcher().then((data) => {
      if (data.ok) { cache.data = data; cache.at = Date.now(); }
      cache.promise = null;
      return data.ok ? data : cache.data || data;
    });
  }
  return cache.promise;
}
