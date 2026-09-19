// Google logins + quota for the Antigravity CLI (`agy`), which is how Gemini runs here since Google
// closed Gemini CLI to personal accounts (2026-06-18).
//
// Two kinds of login exist:
//  • "agy" — the one login agy keeps in the OS keyring (Windows Credential Manager). It is machine-wide
//    and is whatever the owner signed in as on the PC (or through the phone flow, if agy decided to
//    store that in the keyring too).
//  • home accounts (8-hex ids) — logins made through agy's manual "SSH" flow (SSH_CONNECTION set: agy
//    prints a Google URL and takes the pasted code on stdin instead of opening a browser). Each one
//    gets its own home folder under data/gemini/accounts/<id>/home so several Google AI Pro/Ultra
//    subscriptions can sit side by side; whatever files agy writes into that home during the login
//    are remembered (meta.credFiles) and copied into the per-agent run homes before a turn.
// Quota is what the TUI's /usage prints when driven over a pipe (a tab-separated table).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { findGeminiEntry, GEMINI_DIR } from './runners/gemini.js';

export const KEYRING_ID = 'agy';
const ACCOUNTS_DIR = path.join(GEMINI_DIR, 'accounts');
const LOGIN_FILE = path.join(GEMINI_DIR, 'login.json'); // keyring login as last seen
const PROBE_TIMEOUT = 45_000;
export const SSH_ENV = { SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 22' };

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
const isHomeId = (id) => /^[a-f0-9]{8}$/.test(String(id || ''));

// ---------- accounts ----------

export function accountDir(id) {
  return path.join(ACCOUNTS_DIR, id);
}
/** Home folder agy runs in for a home account (USERPROFILE/HOME). */
export function accountHome(id) {
  return path.join(accountDir(id), 'home');
}
function metaPath(id) {
  return path.join(accountDir(id), 'meta.json');
}

/** [{ id, email, tier, kind: 'keyring'|'home', addedAt }] — every saved login. */
export function listAccounts() {
  const out = [];
  const keyring = readJson(LOGIN_FILE);
  if (keyring?.email) out.push({ id: KEYRING_ID, email: keyring.email, tier: keyring.tier || '', kind: 'keyring', addedAt: keyring.addedAt || 0 });
  let ids = [];
  try { ids = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && isHomeId(d.name)).map((d) => d.name); } catch {}
  for (const id of ids) {
    const meta = readJson(metaPath(id));
    if (!meta?.email || meta.loginMode !== 'ssh') continue; // folders from the old Gemini CLI days are not logins
    out.push({ id, email: meta.email, tier: meta.tier || '', kind: 'home', addedAt: meta.addedAt || 0 });
  }
  return out.sort((a, b) => a.addedAt - b.addedAt);
}
export function getAccount(id) {
  return listAccounts().find((a) => a.id === id) || null;
}
export function hasAccounts() {
  return listAccounts().length > 0;
}

/** Env + cwd agy needs to see this account's login. Exported for the runner. */
export function accountEnv(id) {
  if (isHomeId(id)) {
    const home = accountHome(id);
    return { ...SSH_ENV, USERPROFILE: home, HOME: home };
  }
  return {};
}

/** Files agy wrote into the account home while logging in — the login itself. */
export function accountCredFiles(id) {
  return isHomeId(id) ? (readJson(metaPath(id))?.credFiles || []) : [];
}

/** The TUI is driven over a pipe: no TTY needed, `/usage` prints and the process exits on EOF. */
function spawnAgy(stdinText, extraEnv = {}, extraArgs = [], cwd = GEMINI_DIR) {
  const entry = findGeminiEntry();
  if (!entry) throw new Error('Antigravity CLI(agy)가 설치되어 있지 않습니다');
  const env = { ...process.env };
  // The owner's shell may carry an SSH marker or an API key; neither belongs in a probe.
  for (const k of Object.keys(env)) if (/^(SSH_CONNECTION|SSH_CLIENT|SSH_TTY|GEMINI_API_KEY|GOOGLE_API_KEY)$/.test(k)) delete env[k];
  Object.assign(env, { AGY_CLI_DISABLE_AUTO_UPDATE: '1', AGY_CLI_HIDE_LOGO: '1' }, extraEnv);
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(entry.cmd, [...entry.pre, ...extraArgs], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  if (stdinText != null) child.stdin.end(stdinText);
  return child;
}

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');

/** Pure: agy's /usage table → rows the usage popover can show. Input lines look like
 *  `Gemini Models\tWeekly Limit Remaining\t100%\t2026-09-26T04:10:03Z`. */
export function parseGeminiQuota(text) {
  const rows = [];
  for (const raw of stripAnsi(text).split('\n')) {
    const cols = raw.split('\t').map((c) => c.trim());
    if (cols.length < 3) continue;
    const pctMatch = cols.find((c) => /^\d+(?:\.\d+)?%$/.test(c));
    if (!pctMatch) continue;
    const remaining = Math.max(0, Math.min(100, parseFloat(pctMatch)));
    const group = /claude|gpt/i.test(cols[0]) ? 'Claude·GPT' : /gemini/i.test(cols[0]) ? 'Gemini' : cols[0];
    const window = /week/i.test(cols[1]) ? '주간' : /hour/i.test(cols[1]) ? `${(cols[1].match(/(\d+)/) || [])[1] || 5}시간` : cols[1];
    const resetAt = cols.find((c) => /^\d{4}-\d{2}-\d{2}T/.test(c)) || null;
    rows.push({
      group,
      window,
      model: `${group} ${window}`,
      label: `${group} ${window}`,
      pct: Math.round(100 - remaining),
      remainingFraction: remaining / 100,
      remaining: null,
      resets: formatReset(resetAt),
      resetAt,
    });
  }
  return rows;
}

function formatReset(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** The email agy logged in as, from its own log ("OAuth: authenticated successfully as <email>"). */
export function parseLoginEmail(logText) {
  const m = String(logText || '').match(/authenticated successfully as ([^\s"]+@[^\s"]+)/);
  return m ? m[1] : null;
}

const needsLogin = (text) => /accounts\.google\.com|authentication required|not logged in|paste the authorization code/i.test(text);

/**
 * Runs `/usage` through agy as the given account and returns { loggedIn, email, rows, error }.
 * Never throws. For the keyring account this also records/forgets data/gemini/login.json.
 */
export async function probeLogin(id = KEYRING_ID) {
  const home = isHomeId(id) ? accountHome(id) : GEMINI_DIR;
  const logFile = path.join(home, `probe-${process.pid}-${Date.now()}.log`);
  let child;
  try {
    child = spawnAgy('/usage\n', accountEnv(id), ['--log-file', logFile], home);
  } catch (e) {
    return { loggedIn: false, email: null, rows: [], error: e.message };
  }
  const out = await collect(child, PROBE_TIMEOUT, (text) => needsLogin(text));
  const rows = parseGeminiQuota(out.stdout);
  let log = '';
  try { log = fs.readFileSync(logFile, 'utf8'); } catch {}
  try { fs.rmSync(logFile, { force: true }); } catch {}
  const loggedIn = rows.length > 0 && !needsLogin(out.stdout);
  const email = parseLoginEmail(log) || (loggedIn ? getAccount(id)?.email || null : null);
  if (id === KEYRING_ID) {
    if (loggedIn && email) {
      const prev = readJson(LOGIN_FILE) || {};
      writeJson(LOGIN_FILE, { ...prev, email, addedAt: prev.email === email ? prev.addedAt || Date.now() : Date.now(), checkedAt: Date.now() });
    } else if (!loggedIn && needsLogin(out.stdout + out.stderr + log)) {
      try { fs.rmSync(LOGIN_FILE, { force: true }); } catch {}
    }
  } else if (loggedIn && email) {
    const meta = readJson(metaPath(id)) || {};
    if (meta.email !== email) writeJson(metaPath(id), { ...meta, email });
  }
  return { loggedIn, email, rows, error: loggedIn ? null : (needsLogin(out.stdout) ? '로그인되어 있지 않습니다' : cleanError(out.stderr || out.stdout) || '로그인되어 있지 않습니다') };
}

function cleanError(s) {
  return stripAnsi(s).split('\n').map((l) => l.trim()).filter((l) => l && !/^warning/i.test(l)).slice(-2).join(' · ');
}

/** Gathers stdout/stderr until exit, a timeout, or `stopWhen(stdout)` says the interesting part came. */
function collect(child, timeoutMs, stopWhen) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; if (stopWhen?.(stdout)) { try { child.kill(); } catch {} finish(null); } });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}

/** Relative paths of every file under <home>/.gemini (what a login may have written). */
function listHomeFiles(home) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(log|logs|brain|conversations|annotations|crashes|builtin|bin|cache)$/.test(e.name)) walk(p); }
      else if (!/\.log$/.test(e.name)) out.push(path.relative(home, p));
    }
  };
  walk(path.join(home, '.gemini'));
  return out;
}

// ---------- login (phone) ----------

const pendingLogins = new Map(); // loginId -> { id, child, url, at, log, before }
const LOGIN_TTL = 10 * 60 * 1000;

/** Step 1: starts agy in its manual sign-in flow inside a fresh account home and returns the Google
 *  URL it prints. The process stays alive waiting for the code; finishLogin feeds it. */
export async function startLogin() {
  for (const [k, v] of pendingLogins) if (Date.now() - v.at > LOGIN_TTL) { try { v.child.kill(); } catch {} pendingLogins.delete(k); }
  const id = crypto.randomBytes(4).toString('hex');
  const home = accountHome(id);
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  const before = new Set(listHomeFiles(home));
  const logFile = path.join(accountDir(id), 'login.log');
  const child = spawnAgy(null, accountEnv(id), ['--log-file', logFile], home);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {});
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('Google 로그인 주소를 받지 못했습니다. PC에서 터미널에 agy 를 한 번 실행해 로그인해 주세요')); }, 30_000);
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = stripAnsi(stdout).match(/https:\/\/accounts\.google\.com\/[^\s'"<>]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.on('close', () => { clearTimeout(timer); reject(new Error(cleanError(stdout) || '로그인 절차가 바로 끝났습니다')); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  }).catch((e) => { try { fs.rmSync(accountDir(id), { recursive: true, force: true }); } catch {} throw e; });
  const loginId = crypto.randomBytes(8).toString('hex');
  pendingLogins.set(loginId, { id, child, url, at: Date.now(), log: logFile, before });
  return { loginId, url };
}

/** Step 2: hands the pasted code to the waiting agy, waits for its "authenticated as" line, remembers
 *  which files the login wrote, and confirms with a probe. */
export async function finishLogin(loginId, rawCode) {
  const pending = pendingLogins.get(loginId);
  if (!pending) throw new Error('로그인 요청이 만료되었습니다. 다시 시작해 주세요');
  let code = String(rawCode || '').trim();
  try { const u = new URL(code); code = u.searchParams.get('code') || code; } catch {}
  if (!code) throw new Error('코드를 붙여 넣어 주세요');
  pendingLogins.delete(loginId);
  const { id, child, log, before } = pending;
  const home = accountHome(id);
  child.stdin.write(`${code}\n`);
  const readLog = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };
  const email = await new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = parseLoginEmail(readLog());
      if (found) { clearInterval(tick); resolve(found); }
      else if (Date.now() - started > 90_000) { clearInterval(tick); resolve(null); }
    }, 700);
    child.on('close', () => { clearInterval(tick); resolve(parseLoginEmail(readLog())); });
  });
  // Give agy a moment to persist the token, then end the TUI.
  await new Promise((r) => setTimeout(r, 2500));
  try { child.stdin.end('/exit\n'); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} }, 4000);
  await new Promise((r) => setTimeout(r, 1500));
  if (!email) {
    try { fs.rmSync(accountDir(id), { recursive: true, force: true }); } catch {}
    throw new Error('Google이 코드를 받아주지 않았습니다. 다시 시도해 주세요');
  }
  const credFiles = listHomeFiles(home).filter((f) => !before.has(f));
  const existing = listAccounts().find((a) => a.kind === 'home' && a.email === email);
  writeJson(metaPath(id), { email, addedAt: existing?.addedAt || Date.now(), credFiles, loginMode: 'ssh' });
  quotaCache.delete(id);
  // Did the login stick to this home? (If agy put it in the keyring instead, the keyring account changed.)
  const probe = await probeLogin(id);
  if (!probe.loggedIn) {
    try { fs.rmSync(accountDir(id), { recursive: true, force: true }); } catch {}
    const keyring = await probeLogin(KEYRING_ID);
    if (keyring.loggedIn && keyring.email === email) return getAccount(KEYRING_ID);
    throw new Error(probe.error || '로그인은 됐지만 계정 저장을 확인하지 못했습니다');
  }
  // Same Google account logged in twice: keep the newest login only.
  if (existing && existing.id !== id) removeAccount(existing.id);
  return getAccount(id) || { id, email };
}

/** Drops a saved login. The keyring one is cleared through agy's own /logout. */
export async function removeAccount(id) {
  if (isHomeId(id)) {
    if (!fs.existsSync(accountDir(id))) return false;
    fs.rmSync(accountDir(id), { recursive: true, force: true });
    quotaCache.delete(id);
    return true;
  }
  if (id !== KEYRING_ID || !getAccount(KEYRING_ID)) return false;
  let child;
  try { child = spawnAgy('/logout\n'); } catch { return false; }
  await collect(child, 20_000, (text) => /logged out|signed out|accounts\.google\.com/i.test(text));
  try { fs.rmSync(LOGIN_FILE, { force: true }); } catch {}
  quotaCache.delete(KEYRING_ID);
  return true;
}

// ---------- quota ----------

const quotaCache = new Map(); // id -> { at, data, promise }
const QUOTA_TTL = 2 * 60 * 1000;

/** Quota rows for one account (cached 2 min). Never throws: a failed lookup is a row with `error`. */
export async function accountQuota(id, force = false) {
  const cached = quotaCache.get(id);
  if (cached?.promise) return cached.promise;
  if (cached && !force && Date.now() - cached.at < QUOTA_TTL) return cached.data;
  const acct = getAccount(id);
  if (!acct) return { id, ok: false, error: '계정 없음', models: [], items: [] };
  const promise = (async () => {
    const probe = await probeLogin(id);
    const email = probe.email || acct.email;
    const items = (probe.rows || []).map((m) => ({ label: m.label, pct: m.pct, resets: m.resets, remaining: m.remaining }));
    const data = probe.loggedIn
      ? { id, email, tier: acct.tier, kind: acct.kind, ok: true, models: probe.rows, items, fetchedAt: Date.now() }
      : { id, email, tier: acct.tier, kind: acct.kind, ok: false, error: probe.error || '한도를 읽지 못했습니다', models: [], items: [] };
    quotaCache.set(id, { at: Date.now(), data });
    return data;
  })();
  quotaCache.set(id, { at: Date.now(), data: cached?.data || null, promise });
  return promise;
}

/** Every account's quota at once — what the usage popover and account picker read. */
export async function allQuotas(force = false) {
  return Promise.all(listAccounts().map((a) => accountQuota(a.id, force)));
}

/** The quota bucket that governs a model: Gemini ids share one pool, Claude/GPT the other; the
 *  tighter of the weekly and 5-hour windows decides. */
export function bucketFor(models, modelId) {
  if (!models?.length) return null;
  const group = /^(claude|gpt)/i.test(String(modelId || '')) ? 'Claude·GPT' : 'Gemini';
  const same = models.filter((m) => m.group === group);
  return (same.length ? same : models).slice().sort((a, b) => a.remainingFraction - b.remainingFraction)[0];
}

/**
 * Which account should run the next turn. A pinned account (agent setting) wins if it exists;
 * otherwise the account with the most quota left for this model. `exclude` skips accounts that
 * just hit their limit so a retry lands on a different subscription.
 */
export async function pickAccount(preferredId, modelId, exclude = []) {
  const accounts = listAccounts().filter((a) => !exclude.includes(a.id));
  if (!accounts.length) return null;
  if (preferredId) {
    const pinned = accounts.find((a) => a.id === preferredId);
    if (pinned) return pinned;
  }
  if (accounts.length === 1) return accounts[0];
  const quotas = await Promise.all(accounts.map((a) => accountQuota(a.id)));
  let best = null;
  let bestScore = -1;
  for (const a of accounts) {
    const q = quotas.find((x) => x.id === a.id);
    const bucket = q?.ok ? bucketFor(q.models, modelId) : null;
    // No quota info: treat as half full so a fresh account still gets tried but a known-fuller one wins.
    const score = bucket ? bucket.remainingFraction : 0.5;
    if (score > bestScore) { best = a; bestScore = score; }
  }
  return best;
}

/** Usage-popover shape for provider=gemini: one section per account, one row per quota window. */
export async function geminiUsage(force = false) {
  const quotas = await allQuotas(force);
  if (!quotas.length) return { ok: false, provider: 'gemini', error: 'Google 계정을 아직 연결하지 않았습니다', items: [], accounts: [] };
  const accounts = quotas.map((q) => ({
    id: q.id, email: q.email, tier: q.tier || '', kind: q.kind || getAccount(q.id)?.kind || 'home', ok: q.ok, error: q.error || null,
    items: q.models.map((m) => ({ label: m.label, pct: m.pct, resets: m.resets, remaining: m.remaining })),
  }));
  const items = accounts.flatMap((a) => a.items.map((it) => ({ ...it, label: accounts.length > 1 ? `${a.email.split('@')[0]} · ${it.label}` : it.label })));
  return { ok: accounts.some((a) => a.ok), provider: 'gemini', items, accounts, fetchedAt: Date.now() };
}

export function forgetQuota(id) {
  quotaCache.delete(id);
}
