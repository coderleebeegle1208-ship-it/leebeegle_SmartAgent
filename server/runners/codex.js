// Runs OpenAI Codex CLI headlessly: `codex exec --json`.
// Uses the saved ChatGPT login (`codex login`). Requires: npm i -g @openai/codex
import { spawn } from 'node:child_process';
import { withPhoneStyle } from '../style.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export function findCodexEntry() {
  if (process.env.CODEX_BIN) return { cmd: process.env.CODEX_BIN, pre: [] };
  const candidates = [
    ...desktopCodexCandidates(),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
  ].filter(Boolean);
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    return c.endsWith('.js') ? { cmd: process.execPath, pre: [c] } : { cmd: c, pre: [] };
  }
  const onPath = findOnPath(process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']);
  if (onPath) return { cmd: onPath, pre: [] };
  return null;
}

function desktopCodexCandidates() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return [];
  const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name, 'codex.exe'));
  } catch {
    return [];
  }
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

export function runCodex({ agent, workspace, text, hooks, opts = {} }) {
  const entry = findCodexEntry();
  if (!entry) {
    queueMicrotask(() => hooks.onExit?.({ code: -1, error: 'Codex CLI가 설치되어 있지 않습니다. `npm i -g @openai/codex` 후 `codex login`을 실행하세요.', gotResult: false }));
    return null;
  }

  const args = buildCodexArgs(entry, agent, workspace, withPhoneStyle(text), opts);

  hooks.onLog?.(`spawn ${entry.cmd} ${args.join(' ')}`);
  const child = spawn(entry.cmd, args, { cwd: workspace.path, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let gotResult = false;
  let lastMessage = '';
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
    try {
      ev = JSON.parse(line);
    } catch {
      hooks.onLog?.(`[stdout] ${line}`);
      return;
    }
    const t = ev.type;
    if (t === 'thread.started' && ev.thread_id) {
      hooks.onSession?.(ev.thread_id, {});
    } else if (t === 'item.completed' && ev.item) {
      const it = ev.item;
      if (it.type === 'agent_message' && it.text) {
        lastMessage = it.text;
        hooks.onMessage?.('assistant', it.text);
      } else if (it.type === 'command_execution') {
        hooks.onMessage?.('tool', `$ ${it.command || ''}`, { tool: 'Bash', exit_code: it.exit_code });
        const out = (it.aggregated_output || '').trim();
        if (out) hooks.onMessage?.('tool_result', out.length > 1200 ? out.slice(0, 1200) + '\n…' : out, { is_error: it.exit_code !== 0 });
      } else if (it.type === 'file_change') {
        const files = (it.changes || []).map((c) => `${c.kind || 'edit'} ${c.path}`).join(', ');
        hooks.onMessage?.('tool', `파일 변경: ${files}`, { tool: 'Edit' });
      }
    } else if (t === 'turn.completed') {
      gotResult = true;
      hooks.onResult?.({ ok: true, text: lastMessage, usage: ev.usage });
    } else if (t === 'turn.failed' || t === 'error') {
      gotResult = true;
      hooks.onResult?.({ ok: false, text: ev.message || ev.error?.message || 'Codex error' });
    }
  });

  let exited = false;
  const exitOnce = (payload) => {
    if (exited) return;
    exited = true;
    hooks.onExit?.(payload);
  };
  child.on('error', (err) => exitOnce({ code: -1, error: `실행 실패: ${err.message}`, gotResult }));
  child.on('close', (code) => exitOnce({ code, error: gotResult ? null : stderrTail.trim() || `프로세스 종료 (code ${code})`, gotResult }));
  return child;
}

export function buildCodexArgs(entry, agent, workspace, text, opts = {}) {
  const sandbox = opts.sandbox || (agent.permission_mode === 'ask' ? 'read-only' : 'workspace-write');
  // exec-level options must precede the `resume` subcommand. Putting -C/--sandbox
  // after `resume` makes current Codex CLIs reject the command before it starts.
  const args = [...entry.pre, 'exec', '--json', '--skip-git-repo-check', '-C', workspace.path, '--sandbox', sandbox];
  if (agent.model) args.push('-m', agent.model);
  if (agent.session_id) args.push('resume', agent.session_id, text);
  else args.push(text);
  return args;
}
