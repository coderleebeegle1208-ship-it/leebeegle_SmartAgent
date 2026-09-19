// Runs Google's Antigravity CLI (`agy`) headlessly: the prompt goes in as one stream-json message
// on stdin, `--output-format stream-json` events come back. The Google login lives in the OS
// keyring (one per machine, see gemini-accounts.js). Install: irm https://antigravity.google/cli/install.ps1 | iex
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR, SERVER_DIR } from '../paths.js';
import { withPhoneReminder, withPhoneStyle } from '../style.js';
import { geminiSlug } from '../models.js';

export const GEMINI_DIR = path.join(DATA_DIR, 'gemini');

export function findGeminiEntry() {
  if (process.env.GEMINI_BIN) return { cmd: process.env.GEMINI_BIN, pre: [] };
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: c, pre: [] };
  }
  const onPath = findOnPath(process.platform === 'win32' ? ['agy.exe', 'agy.cmd'] : ['agy']);
  if (onPath) return { cmd: onPath, pre: [] };
  return null;
}

function findOnPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      try { if (fs.existsSync(candidate)) return candidate; } catch {}
    }
  }
  return null;
}

/** agy has no system-prompt flag either, so the phone guide rides in the prompt like Codex. */
export function geminiStyledText(text, agent, opts = {}) {
  if (opts.phase === 'review' || opts.stage === 'plan') return text;
  // agy runs with a private home folder; a first turn spells out where the project actually is so
  // the model doesn't go looking for files under that home.
  const where = !agent.session_id && opts.workspacePath ? `현재 작업 폴더(프로젝트)는 ${opts.workspacePath} 입니다. 파일은 이 폴더 안에서 찾고, 도구에는 이 폴더 기준 절대 경로를 넘기세요.\n\n` : '';
  return agent.session_id ? withPhoneReminder(text) : withPhoneStyle(where + text);
}

/** agy's --effort takes low|medium|high; anything above maps to high, nothing → CLI default. */
export function geminiThinkingLevel(effort) {
  if (!effort) return null;
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

/**
 * Each (account, agent) pair gets its own home folder (USERPROFILE/HOME for the agy process): agy
 * reads its MCP servers from <home>/.gemini/config/mcp_config.json and keeps conversations under
 * <home>/.gemini/antigravity-cli, so the approver wiring is per agent and the owner's own
 * ~/.gemini (shared with the Antigravity IDE) is never touched. The keyring login is machine-wide;
 * a home account's login files are copied in from its account home before every run.
 */
export function geminiHome(agentId, accountId = 'agy') {
  return path.join(GEMINI_DIR, 'homes', String(accountId || 'agy'), `agent-${agentId}`);
}

/** Files written into the agent's home before each run. Exported for tests. */
export function geminiHomeFiles(agent, cfg) {
  const mcpServers = {};
  if (cfg?.internalToken && cfg?.port) {
    mcpServers.approver = {
      command: process.execPath,
      args: [path.join(SERVER_DIR, 'mcp-approver.js')],
      env: {
        APPROVER_URL: `http://127.0.0.1:${cfg.port}`,
        APPROVER_TOKEN: cfg.internalToken,
        APPROVER_AGENT_ID: String(agent.id),
      },
    };
  }
  return {
    '.gemini/config/mcp_config.json': { mcpServers },
    // Subscription only: never fall through to paid AI credits when the plan quota is used up.
    '.gemini/antigravity-cli/settings.json': { enableTelemetry: false, useG1Credits: false, allowNonWorkspaceAccess: true },
    // Tools the agent runs (git, npm…) inherit the home too; keep the owner's git identity reachable.
    '.gitconfig': `[include]\n\tpath = ${path.join(os.homedir(), '.gitconfig').replace(/\\/g, '/')}\n`,
  };
}

/** Copies a home account's login files between its account home and an agent run home (either way).
 *  Returns the number of files that actually changed. */
export function syncCredFiles(fromHome, toHome, relFiles) {
  let changed = 0;
  for (const rel of relFiles || []) {
    const src = path.join(fromHome, rel);
    const dst = path.join(toHome, rel);
    let a = null, b = null;
    try { a = fs.readFileSync(src); } catch { continue; }
    try { b = fs.readFileSync(dst); } catch {}
    if (b && a.equals(b)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, a);
    changed += 1;
  }
  return changed;
}

export function prepareGeminiHome(agent, cfg, account = null) {
  const home = geminiHome(agent.id, account?.id);
  for (const [rel, content] of Object.entries(geminiHomeFiles(agent, cfg))) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    let current = null;
    try { current = fs.readFileSync(p, 'utf8'); } catch {}
    if (current !== text) fs.writeFileSync(p, text);
  }
  if (account?.home) syncCredFiles(account.home, home, account.credFiles);
  return home;
}

export function geminiEnv(agent, cfg, { home, accountEnv = {} }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // An API key in the environment would switch agy off the subscription login; the SSH marker
    // would flip it into the manual sign-in flow; neither belongs in a run unless the account asks.
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GEMINI_BASE_URL|GOOGLE_APPLICATION_CREDENTIALS|SSH_CONNECTION|SSH_CLIENT|SSH_TTY)$/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, accountEnv, {
    USERPROFILE: home,
    HOME: home,
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    AGY_CLI_HIDE_LOGO: '1',
  });
  if (cfg?.internalToken && cfg?.port) {
    Object.assign(env, {
      APPROVER_URL: `http://127.0.0.1:${cfg.port}`,
      APPROVER_TOKEN: cfg.internalToken,
      APPROVER_AGENT_ID: String(agent.id),
    });
  }
  return env;
}

export function buildGeminiArgs(entry, agent, opts = {}) {
  // ask → 읽기만(plan), 그 외 → 전체 허용. agy 헤드리스는 중간에 물어볼 수 없어서 승인이 필요한 도구는
  // 그냥 막히므로, 코덱스처럼 두 단계로 나눈다(폴더 안/밖 구분은 agy에 없다).
  const APPROVAL = { ask: 'plan', acceptEdits: 'yolo', auto: 'yolo' };
  const approval = opts.approvalMode || APPROVAL[agent.permission_mode] || 'yolo';
  const args = [...entry.pre, '-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  args.push(...(approval === 'plan' ? ['--mode', 'plan'] : ['--dangerously-skip-permissions']));
  const effort = geminiThinkingLevel(opts.effort ?? agent.effort);
  const slug = geminiSlug(agent.model, effort);
  if (slug.model) args.push('--model', slug.model);
  if (slug.effort) args.push('--effort', slug.effort);
  for (const dir of opts.includeDirs || []) args.push('--add-dir', dir);
  if (agent.session_id) args.push('--conversation', agent.session_id);
  return args;
}

/** Stream-json events → the same hooks the other runners drive. Exported for tests. */
export function createGeminiEventHandler(hooks, state = {}) {
  state.text = state.text || '';
  state.last = state.last || '';
  state.shown = state.shown || '';
  const flush = () => {
    const t = state.text.trim();
    state.text = '';
    if (!t) return;
    state.last = t;
    state.shown += t;
    hooks.onMessage?.('assistant', t);
  };
  return (ev) => {
    const t = ev?.event;
    if (t === 'init') {
      const init = ev.init || {};
      state.model = init.model || null;
      if (init.conversation_id) hooks.onSession?.(init.conversation_id, { model: init.model });
    } else if (t === 'step_update') {
      const su = ev.step_update || {};
      if (su.step_type === 'agent_response') {
        if (typeof su.text_delta === 'string') state.text += su.text_delta;
        if (su.state === 'DONE') flush();
      } else if (su.step_type === 'tool') {
        const p = su.tool_info?.parameters || {};
        const name = su.tool_name || su.tool_info?.name || 'tool';
        if (su.state === 'ACTIVE') {
          flush();
          const file = p.AbsolutePath || p.TargetFile || p.file_path || p.path;
          const detail = name === 'run_command' ? `$ ${p.CommandLine || p.command || ''}`
            : file ? `${name}: ${file}`
            : name === 'call_mcp_tool' ? `${p.ServerName || 'mcp'}/${p.ToolName || ''}`
            : name;
          hooks.onMessage?.('tool', detail, { tool: name });
        } else if (su.state === 'ERROR' || su.state === 'DONE') {
          const err = su.tool_info?.error?.message;
          const out = String(err || su.tool_info?.output || '').trim();
          if (out) hooks.onMessage?.('tool_result', out.length > 1200 ? out.slice(0, 1200) + '\n…' : out, { is_error: su.state === 'ERROR' });
          if (su.state === 'ERROR' && /quota|rate limit|resource_exhausted|capacity/i.test(String(err || ''))) state.error = err;
        }
      }
    } else if (t === 'result') {
      const r = ev.result || {};
      flush();
      state.gotResult = true;
      const ok = r.status === 'SUCCESS';
      // Text that never came through a step (older builds, or a turn with no text_delta).
      const response = String(r.response || '').trim();
      const squash = (x) => String(x).replace(/\s+/g, '');
      if (ok && response && !squash(state.shown).includes(squash(response))) {
        state.last = response;
        hooks.onMessage?.('assistant', response);
      }
      const err = r.error || state.error;
      const denied = (r.denied_actions || []).map((d) => d.display_name || d.action).filter(Boolean);
      const text = ok ? (state.last || (denied.length ? `허용되지 않은 도구(${denied.join(', ')}) 때문에 답을 만들지 못했습니다` : '')) : err || state.last || 'Antigravity error';
      hooks.onResult?.({ ok, text, usage: r.usage || null, model: state.model, subtype: ok ? null : r.status || null, session_id: r.conversation_id || null });
    }
  };
}

export function runGemini({ agent, workspace, text, cfg, hooks, opts = {} }) {
  const entry = findGeminiEntry();
  if (!entry) {
    queueMicrotask(() => hooks.onExit?.({ code: -1, error: 'Antigravity CLI(agy)가 설치되어 있지 않습니다. PowerShell에서 `irm https://antigravity.google/cli/install.ps1 | iex` 를 실행하세요.', gotResult: false }));
    return null;
  }
  if (!opts.accountId) {
    queueMicrotask(() => hooks.onExit?.({ code: -1, error: 'Gemini에 쓸 Google 계정이 없습니다. 설정에서 계정을 연결하세요.', gotResult: false }));
    return null;
  }
  // opts.account: { id, home?, credFiles?, env? } from gemini-accounts.js (a keyring login has no home).
  const account = opts.account || { id: opts.accountId };
  const home = prepareGeminiHome(agent, cfg, account);
  const args = buildGeminiArgs(entry, agent, opts);
  const env = geminiEnv(agent, cfg, { home, accountEnv: account.env || {} });
  hooks.onLog?.(`spawn ${entry.cmd} ${args.join(' ')} [account ${opts.accountId}]`);
  const child = spawn(entry.cmd, args, { cwd: workspace.path, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ event: 'user', message: { content: geminiStyledText(text, agent, { ...opts, workspacePath: workspace.path }) } }) + '\n');

  const state = {};
  const handle = createGeminiEventHandler(hooks, state);
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-4000);
    hooks.onLog?.(`[stderr] ${d.trimEnd()}`);
  });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line); } catch { hooks.onLog?.(`[stdout] ${line}`); return; }
    handle(ev);
  });

  let exited = false;
  const exitOnce = (payload) => {
    if (exited) return;
    exited = true;
    hooks.onExit?.(payload);
  };
  child.on('error', (err) => exitOnce({ code: -1, error: `실행 실패: ${err.message}`, gotResult: !!state.gotResult }));
  child.on('close', (code) => {
    // A refreshed token lands in the run home; keep the account home current for the next agent.
    if (account.home) { try { syncCredFiles(home, account.home, account.credFiles); } catch {} }
    exitOnce({ code, error: state.gotResult ? null : cleanStderr(stderrTail) || `프로세스 종료 (code ${code})`, gotResult: !!state.gotResult });
  });
  return child;
}

/** agy prints its own notes to stderr (warnings, the "jetski:" permission hint); keep the last useful line. */
function cleanStderr(s) {
  const lines = String(s || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => !/^warning:|^\[?DEBUG/i.test(l)).slice(-3).join(' · ');
}
