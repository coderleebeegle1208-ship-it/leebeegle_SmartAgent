// Read-only git helpers for the workspace view (branch, recent commits, dirty files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

function git(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

export async function gitSummary(cwd, limit = 20) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || !inside.trim().startsWith('true')) return { isRepo: false };

  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || '';
  const SEP = '';
  const log = await git(cwd, ['log', `-${limit}`, `--pretty=format:%h${SEP}%s${SEP}%an${SEP}%ct`]);
  const commits = (log || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, ts] = line.split(SEP);
      return { hash, subject, author, time: Number(ts) * 1000 };
    });
  const status = await git(cwd, ['status', '--porcelain']);
  const changes = (status || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) }));
  return { isRepo: true, branch, commits, changes };
}

export async function gitCommitDiff(cwd, hash) {
  const out = await git(cwd, ['show', '--stat', '--format=%H%n%an <%ae>%n%ad%n%n%B', hash], 15000);
  return out || '';
}

/** Working-tree diff for a cross-provider reviewer: what actually changed, not just which files.
 * Untracked files show up in `git diff` as nothing, so their names are appended separately. */
export async function gitDiff(cwd, maxChars = 40_000) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || !inside.trim().startsWith('true')) return '';
  const [stat, diff, status] = await Promise.all([
    git(cwd, ['diff', 'HEAD', '--stat'], 15000),
    git(cwd, ['diff', 'HEAD'], 15000),
    git(cwd, ['status', '--porcelain']),
  ]);
  const untracked = (status || '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3));
  const parts = [];
  if (stat?.trim()) parts.push(stat.trim());
  if (diff?.trim()) parts.push(diff.trim());
  if (untracked.length) parts.push(`추적되지 않는 새 파일:\n${untracked.join('\n')}`);
  let text = parts.join('\n\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (잘림, 나머지는 파일을 직접 읽으세요)`;
  return text;
}

/** Parses the remote URL into its parts. Handles https, ssh and scp-style GitHub/GitLab URLs. */
export function parseRemote(url) {
  const raw = String(url || '').trim();
  if (!raw) return { url: null };
  const m = raw.match(/^(?:https?:\/\/(?:[^@/]+@)?([^/]+)\/|(?:ssh:\/\/)?(?:git@)([^:/]+)[:/])([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return { url: raw };
  const host = m[1] || m[2];
  const owner = m[3];
  const repo = m[4];
  return { url: raw, host, owner, repo, name: `${owner}/${repo}`, webUrl: `https://${host}/${owner}/${repo}` };
}

export async function gitRemote(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || !inside.trim().startsWith('true')) return { isRepo: false, url: null };
  const url = (await git(cwd, ['remote', 'get-url', 'origin']))?.trim() || '';
  return { isRepo: true, ...parseRemote(url) };
}

/** Accepts only well-formed https/ssh repository URLs, so a typo cannot become a git argument. */
export function isValidRemoteUrl(url) {
  const raw = String(url || '').trim();
  if (!raw || raw.length > 400 || /\s/.test(raw)) return false;
  return /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/i.test(raw)
    || /^(ssh:\/\/)?git@[\w.-]+[:/][\w.-]+\/[\w.-]+?(\.git)?\/?$/i.test(raw);
}

/** Points origin at `url`, running `git init` first when the folder is not a repository yet. */
export async function setGitRemote(cwd, url) {
  if (!isValidRemoteUrl(url)) throw new Error('주소 형식이 올바르지 않습니다. 예: https://github.com/이름/저장소');
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  const isRepo = !!inside && inside.trim().startsWith('true');
  if (!isRepo && (await git(cwd, ['init'])) === null) throw new Error('이 폴더를 Git 저장소로 만들지 못했습니다');
  const existing = (await git(cwd, ['remote', 'get-url', 'origin']))?.trim();
  const applied = existing
    ? await git(cwd, ['remote', 'set-url', 'origin', url])
    : await git(cwd, ['remote', 'add', 'origin', url]);
  if (applied === null) throw new Error('원격 저장소 주소를 저장하지 못했습니다');
  return gitRemote(cwd);
}

// ---------- turn snapshots (되돌리기) ----------
// Before and after each agent turn the whole working tree (tracked + untracked, .gitignore
// respected) is written as a git tree object through a throwaway index, so the project's own
// index, HEAD and stash stay untouched. Undo is then just the reverse diff between two trees.
function gitEnv(cwd, args, { env, input, timeout = 30_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...(env || {}) }, windowsHide: true });
    const out = [], err = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { size += d.length; if (size <= maxBuffer) out.push(d); });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout: Buffer.alloc(0), stderr: 'git not found' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export async function gitToplevel(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r ? r.trim() : null;
}

/** Writes the current working tree as a tree object and returns its hash (null outside a repo). */
export async function snapshotTree(cwd) {
  const top = await gitToplevel(cwd);
  if (!top) return null;
  const index = path.join(os.tmpdir(), `smartagent-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    // Seed from HEAD so file modes/renames resolve the same way as a normal `git add -A`.
    const head = await gitEnv(top, ['read-tree', 'HEAD'], { env });
    if (!head.ok) await gitEnv(top, ['read-tree', '--empty'], { env });
    const add = await gitEnv(top, ['add', '-A', '--', '.'], { env, timeout: 120_000 });
    if (!add.ok) return null;
    const tree = await gitEnv(top, ['write-tree'], { env });
    return tree.ok ? tree.stdout.toString('utf8').trim() : null;
  } finally {
    try { fs.unlinkSync(index); } catch {}
  }
}

/** Files changed between two tree snapshots (names + a +/- line count). */
export async function treeChanges(cwd, fromTree, toTree) {
  const top = await gitToplevel(cwd);
  if (!top) return { files: [], added: 0, removed: 0 };
  const r = await gitEnv(top, ['diff', '--numstat', fromTree, toTree]);
  if (!r.ok) return { files: [], added: 0, removed: 0 };
  const files = [];
  let added = 0, removed = 0;
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const [a, d, file] = line.split('\t');
    if (a !== '-') { added += Number(a) || 0; removed += Number(d) || 0; }
    files.push(file);
  }
  return { files, added, removed };
}

/** Reverts the working tree from `fromTree` back to `toTree` by applying the reverse diff.
 * Fails (without touching anything) when later edits overlap the same lines. */
export async function restoreTree(cwd, fromTree, toTree) {
  const top = await gitToplevel(cwd);
  if (!top) throw new Error('Git 저장소가 아닙니다');
  for (const t of [fromTree, toTree]) {
    const exists = await gitEnv(top, ['cat-file', '-e', `${t}^{tree}`]);
    if (!exists.ok) throw new Error('되돌릴 기록이 더 이상 남아 있지 않습니다');
  }
  const diff = await gitEnv(top, ['diff', '--binary', '--full-index', fromTree, toTree], { timeout: 60_000 });
  if (!diff.ok) throw new Error('변경 내용을 읽지 못했습니다');
  if (!diff.stdout.length) return { files: 0 };
  const check = await gitEnv(top, ['apply', '--check', '--whitespace=nowarn', '-'], { input: diff.stdout, timeout: 60_000 });
  if (!check.ok) {
    const err = new Error('그 뒤에 같은 부분이 또 바뀌어 자동으로 되돌리지 못했습니다');
    err.detail = check.stderr.slice(0, 600);
    throw err;
  }
  const apply = await gitEnv(top, ['apply', '--whitespace=nowarn', '-'], { input: diff.stdout, timeout: 60_000 });
  if (!apply.ok) {
    const err = new Error('되돌리는 중 문제가 생겼습니다');
    err.detail = apply.stderr.slice(0, 600);
    throw err;
  }
  const changes = await treeChanges(top, fromTree, toTree);
  return { files: changes.files.length };
}
