// Runs Claude Code headlessly: `claude -p --output-format stream-json`.
// Uses the user's existing claude.ai login (no API key needed).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { DATA_DIR, SERVER_DIR } from '../paths.js';
import { PHONE_STYLE_PROMPT, withPhoneReminderShort } from '../style.js';
import { normalizeClaudeUsage } from '../tokens.js';

export function findClaudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return 'claude';
}

// Start children from a clean Claude environment. If this server itself was launched from
// inside a Claude Code session (desktop app / terminal), inherited CLAUDE_CODE_* variables
// make the child expect host-provided auth and it reports "Not logged in".
export function cleanClaudeEnv(cfg) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'CLAUDE_CONFIG_DIR') { env[k] = v; continue; }
    if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION)$/.test(k) || /^CLAUDE_(CODE|PREVIEW)_/.test(k)) continue;
    env[k] = v;
  }
  // Cheap subagents by default (Explore/Plan helpers otherwise inherit the main model).
  if (cfg?.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.subagentModel;
  return env;
}

/** Common flags for a one-shot, tool-less, context-free call: no default Claude Code system
 * prompt (replaced by `systemPrompt`), no tool definitions loaded, no session file written. */
function onceArgs(model, systemPrompt) {
  return ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', systemPrompt];
}

/**
 * One-shot, tool-less, context-free call used for triage. Resolves with parsed
 * structured output (or null on failure). Never touches the agent's session.
 */
export function runClaudeOnce({ cwd, prompt, systemPrompt = '', model = 'haiku', schema, cfg, onModel, onUsage, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    // No tools at all, one turn: the model must answer in text. (--json-schema needs an internal
    // tool call, which conflicts with disabling tools, so we ask for JSON text and parse it.)
    const args = onceArgs(model, systemPrompt);
    void schema;
    const child = spawn(findClaudeBin(), args, { cwd, env: cleanClaudeEnv(cfg), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        const used = Object.keys(j.modelUsage || {})[0];
        if (used) onModel?.(used);
        onUsage?.(normalizeClaudeUsage(j), used);
        if (j.structured_output) return resolve(j.structured_output);
        const m = String(j.result || '').match(/\{[\s\S]*\}/);
        resolve(m ? JSON.parse(m[0]) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** One-shot, tool-less call that returns the model's text (used for 대화 정리 summaries). */
export function runClaudeOnceText({ cwd, prompt, systemPrompt = '', model = 'haiku', cfg, timeoutMs = 90_000 }) {
  return new Promise((resolve) => {
    const args = onceArgs(model, systemPrompt);
    const child = spawn(findClaudeBin(), args, { cwd, env: cleanClaudeEnv(cfg), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        resolve(j.is_error ? null : String(j.result || '').trim() || null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Extra fields the phone folds into its "생성됨 · 편집됨 +N -M" summary line. */
function toolStats(name, input) {
  if (!input) return {};
  const lines = (s) => (s ? String(s).split('\n').length : 0);
  if (name === 'Write') return { file: input.file_path || '', added: lines(input.content), removed: 0 };
  if (name === 'Edit') return { file: input.file_path || '', added: lines(input.new_string), removed: lines(input.old_string) };
  if (name === 'NotebookEdit') return { file: input.notebook_path || '', added: lines(input.new_source), removed: 0 };
  return {};
}

function summarizeToolUse(name, input) {
  if (!input) return name;
  if (name === 'Bash') return `$ ${input.command || ''}`;
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(name)) return `${name} ${input.file_path || ''}`;
  if (name === 'Glob' || name === 'Grep') return `${name} ${input.pattern || ''}`;
  if (name === 'WebFetch') return `WebFetch ${input.url || ''}`;
  if (name === 'Agent') return `Agent: ${input.description || ''}`;
  const s = JSON.stringify(input);
  return `${name} ${s.length > 200 ? s.slice(0, 200) + '…' : s}`;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

/**
 * @param {object} p
 * @param {object} p.agent        agents row
 * @param {object} p.workspace    workspaces row
 * @param {string} p.text         user prompt
 * @param {object} p.cfg          app config (port, internalToken)
 * @param {object} p.hooks        { onSession, onMessage, onResult, onExit, onLog }
 */
export function runClaude({ agent, workspace, text, cfg, hooks, opts = {} }) {
  const mcpDir = path.join(DATA_DIR, 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, `agent-${agent.id}.json`);
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        approver: {
          command: process.execPath,
          args: [path.join(SERVER_DIR, 'mcp-approver.js')],
          env: {
            APPROVER_URL: `http://127.0.0.1:${cfg.port}`,
            APPROVER_TOKEN: cfg.internalToken,
            APPROVER_AGENT_ID: String(agent.id),
          },
        },
      },
    })
  );

  const args = buildClaudeArgs(agent, mcpPath, opts);

  const env = cleanClaudeEnv(cfg);

  const bin = findClaudeBin();
  hooks.onLog?.(`spawn ${bin} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  const child = spawn(bin, args, { cwd: workspace.path, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin.on('error', () => {});
  child.stdin.end(claudeStdinText(text, opts));

  let gotResult = false;
  let lastContext = 0;
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
    handleEvent(ev);
  });

  function handleEvent(ev) {
    if (ev.type === 'system') {
      if (ev.subtype === 'init') {
        hooks.onSession?.(ev.session_id, { model: ev.model });
      } else if (ev.subtype === 'permission_denied') {
        hooks.onMessage?.('system', `권한 거부됨: ${ev.tool_name || ''}`);
      } else if (ev.subtype === 'api_retry') {
        hooks.onMessage?.('system', `API 재시도 ${ev.attempt}/${ev.max_retries} (${ev.error || ''})`);
      }
      return;
    }
    if (ev.type === 'assistant' && ev.message?.content) {
      if (ev.parent_tool_use_id) return; // subagent chatter: skip
      const u = ev.message.usage;
      if (u) lastContext = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text?.trim()) hooks.onMessage?.('assistant', block.text);
        else if (block.type === 'tool_use') hooks.onMessage?.('tool', summarizeToolUse(block.name, block.input), { tool: block.name, id: block.id, ...toolStats(block.name, block.input) });
      }
      return;
    }
    if (ev.type === 'user' && ev.message?.content && Array.isArray(ev.message.content)) {
      if (ev.parent_tool_use_id) return;
      for (const block of ev.message.content) {
        if (block.type === 'tool_result') {
          const t = contentToText(block.content).trim();
          if (t) hooks.onMessage?.('tool_result', t.length > 1200 ? t.slice(0, 1200) + '\n…' : t, { is_error: !!block.is_error });
        }
      }
      return;
    }
    if (ev.type === 'result') {
      gotResult = true;
      hooks.onResult?.({
        ok: !ev.is_error && ev.subtype === 'success',
        text: ev.result || '',
        subtype: ev.subtype,
        session_id: ev.session_id,
        duration_ms: ev.duration_ms,
        num_turns: ev.num_turns,
        cost: ev.total_cost_usd,
        denials: ev.permission_denials,
        usage: normalizeClaudeUsage(ev),
        contextTokens: lastContext,
        // modelUsage also lists subagent models (Explore helpers run on Haiku); the main model is
        // the one that spent the most, not whichever key happens to come first.
        model: Object.entries(ev.modelUsage || {}).sort((a, b) => (b[1]?.costUSD || 0) - (a[1]?.costUSD || 0))[0]?.[0] || null,
      });
    }
  }

  let exited = false;
  const exitOnce = (payload) => {
    if (exited) return;
    exited = true;
    hooks.onExit?.(payload);
  };
  child.on('error', (err) => {
    exitOnce({ code: -1, error: `실행 실패: ${err.message}`, gotResult });
  });
  child.on('close', (code) => {
    exitOnce({ code, error: gotResult ? null : stderrTail.trim() || `프로세스 종료 (code ${code})`, gotResult });
  });

  return child;
}

/** Text written to Claude's stdin. The phone-tone reminder is for what the owner reads, so it's
 * skipped on the plan stage (its output is internal ExitPlanMode text, not shown as a chat answer)
 * and on cross-provider reviews (the reader is the other model, not the owner). Short form: the
 * turn's --append-system-prompt already carries the full guide, so the reminder only needs to
 * point back at it instead of accumulating a full copy in every turn's conversation history. */
export function claudeStdinText(text, opts = {}) {
  const skip = opts.stage === 'plan' || opts.phase === 'review';
  return skip ? text : withPhoneReminderShort(text);
}

export function buildClaudeArgs(agent, mcpPath, opts = {}) {
  // `capture` only writes into data/captures on this PC, so it never needs a phone approval.
  // WebFetch is also pre-allowed: it's read-only, and a link the user attaches should just get read.
  // --strict-mcp-config keeps every turn from also loading the user's global ~/.claude.json MCP
  // servers (unauthorized ones still ship their tool definitions in the prefix); the approver
  // server above still loads because it's passed via --mcp-config.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'mcp__approver__approve', '--mcp-config', mcpPath, '--strict-mcp-config', '--allowedTools', 'mcp__approver__capture', 'mcp__approver__restart_server', 'WebFetch'];
  const isPlanOrReview = opts.stage === 'plan' || opts.phase === 'review';
  // Plan output goes to ExitPlanMode (read by the executor turn, not the owner) and review output
  // goes to the other model, so neither needs the phone-tone guide — skipping it there also keeps
  // it from being re-sent as part of the plan/review text that later turns carry along.
  if (!isPlanOrReview) args.push('--append-system-prompt', PHONE_STYLE_PROMPT);
  if (agent.session_id) args.push('--resume', agent.session_id);
  // Plan and cross-review turns start a fresh session every time, so they pay the full system
  // prompt + tool + skill definitions from zero; skills add nothing when the turn can't edit anyway.
  if (isPlanOrReview) args.push('--disable-slash-commands');
  if (opts.budgetUsd) args.push('--max-budget-usd', String(opts.budgetUsd));
  if (opts.tools) {
    const tools = Array.isArray(opts.tools) ? opts.tools : [opts.tools];
    args.push('--tools', ...tools);
  }
  // Uploaded photos/videos live under data/uploads, outside the project folder Claude normally reads.
  for (const dir of opts.addDirs || []) args.push('--add-dir', dir);
  const permissionMode = opts.permissionMode || (agent.permission_mode === 'acceptEdits' ? 'acceptEdits' : agent.permission_mode === 'auto' ? 'auto' : null);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (opts.disallowedTools) {
    const tools = Array.isArray(opts.disallowedTools) ? opts.disallowedTools : [opts.disallowedTools];
    args.push('--disallowedTools', ...tools);
  }
  const model = opts.model !== undefined ? opts.model : agent.model;
  const effort = opts.effort !== undefined ? opts.effort : agent.effort;
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}
