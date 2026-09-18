// Runs OpenAI Codex CLI headlessly: `codex exec --json`.
// Uses the saved ChatGPT login (`codex login`). Requires: npm i -g @openai/codex
import { spawn } from 'node:child_process';
import { withPhoneReminder, withPhoneStyle } from '../style.js';
import { SERVER_DIR } from '../paths.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Keep long tool-heavy turns from re-reading an ever-growing transcript. These are per-run
// overrides, so an expensive desktop default cannot silently leak into the phone app.
export const CODEX_EFFICIENCY_CONFIG = [
  'model_auto_compact_token_limit=100000',
  'model_auto_compact_token_limit_scope="total"',
  'tool_output_token_limit=4000',
  'skills.max_context_tokens=4000',
  'memories.use_memories=false',
  'model_verbosity="low"',
  'model_reasoning_summary="none"',
];

/** Per-run MCP wiring without putting the dashboard's internal token in command-line logs. */
export function codexApproverConfig(cfg) {
  if (!cfg?.internalToken || !cfg?.port) return [];
  return [
    `mcp_servers.approver.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.approver.args=${JSON.stringify([path.join(SERVER_DIR, 'mcp-approver.js')])}`,
    'mcp_servers.approver.env_vars=["APPROVER_URL","APPROVER_TOKEN","APPROVER_AGENT_ID"]',
    'mcp_servers.approver.enabled_tools=["capture","restart_server","run_job","watch_job","send_file"]',
    'mcp_servers.approver.default_tools_approval_mode="auto"',
  ];
}

export function codexApproverEnv(agent, cfg) {
  if (!cfg?.internalToken || !cfg?.port) return process.env;
  return {
    ...process.env,
    APPROVER_URL: `http://127.0.0.1:${cfg.port}`,
    APPROVER_TOKEN: cfg.internalToken,
    APPROVER_AGENT_ID: String(agent.id),
  };
}

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

/** Codex has no system-prompt flag, so the phone tone guide rides along in the instruction text.
 * The reader of a review is the other model, not the owner, so reviews get no guidance at all.
 * Otherwise: a thread's first turn (no saved session yet) gets the full guide; a resumed turn
 * already has it in context but tends to drift back to a plain engineer tone, so it gets the
 * short reminder instead of paying for the full ~560-token guide again. */
export function codexStyledText(text, agent, opts = {}) {
  if (opts.phase === 'review' || opts.stage === 'plan') return text; // 계획서도 실행 모델이 읽는다
  return agent.session_id ? withPhoneReminder(text) : withPhoneStyle(text);
}

export function runCodex({ agent, workspace, text, cfg, hooks, opts = {} }) {
  const entry = findCodexEntry();
  if (!entry) {
    queueMicrotask(() => hooks.onExit?.({ code: -1, error: 'Codex CLI가 설치되어 있지 않습니다. `npm i -g @openai/codex` 후 `codex login`을 실행하세요.', gotResult: false }));
    return null;
  }

  const args = buildCodexArgs(entry, agent, workspace, codexStyledText(text, agent, opts), opts, cfg);

  hooks.onLog?.(`spawn ${entry.cmd} ${args.join(' ')}`);
  const child = spawn(entry.cmd, args, { cwd: workspace.path, env: codexApproverEnv(agent, cfg), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

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

export function buildCodexArgs(entry, agent, workspace, text, opts = {}, cfg = null) {
  const sandbox = opts.sandbox || (agent.permission_mode === 'ask' ? 'read-only' : 'workspace-write');
  // exec-level options must precede the `resume` subcommand. Putting -C/--sandbox
  // after `resume` makes current Codex CLIs reject the command before it starts.
  const args = [...entry.pre];
  for (const config of CODEX_EFFICIENCY_CONFIG) args.push('-c', config);
  for (const config of codexApproverConfig(cfg)) args.push('-c', config);
  if (agent.effort) args.push('-c', `model_reasoning_effort="${agent.effort}"`);
  // SmartAgent supplies its own small, task-specific configuration. Skipping the desktop config
  // prevents unrelated personal plugins/MCP catalogs from being injected on every model call;
  // Codex authentication is explicitly preserved by this CLI flag.
  args.push('exec', '--ignore-user-config', '--json', '--skip-git-repo-check', '-C', workspace.path, '--sandbox', sandbox);
  if (agent.model) args.push('-m', agent.model);
  for (const image of opts.images || []) args.push('-i', image);
  if (agent.session_id) args.push('resume', agent.session_id, text);
  else args.push(text);
  return args;
}
