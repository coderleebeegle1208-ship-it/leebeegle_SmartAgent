// Read-only git helpers for the workspace view (branch, recent commits, dirty files).
import { execFile } from 'node:child_process';

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
