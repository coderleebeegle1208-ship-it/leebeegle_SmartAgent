// Minimal MCP server over stdio, spawned by Claude Code via --permission-prompt-tool.
// Exposes `approve` (forwards a permission request to the phone and blocks for the answer)
// and `capture` (screenshots a page/file/HTML on this PC and posts it into the phone chat).
//
// Env: APPROVER_URL (http://127.0.0.1:PORT), APPROVER_TOKEN, APPROVER_AGENT_ID
import readline from 'node:readline';

const URL_BASE = process.env.APPROVER_URL;
const TOKEN = process.env.APPROVER_TOKEN;
const AGENT_ID = process.env.APPROVER_AGENT_ID;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function askDashboard(toolName, input, toolUseId) {
  // Long-poll: the dashboard holds the request until the user decides (or re-poll on timeout).
  let approvalId = null;
  for (;;) {
    const res = await fetch(`${URL_BASE}/internal/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentId: Number(AGENT_ID), toolName, input, toolUseId, approvalId }),
    });
    if (!res.ok) return { behavior: 'deny', message: `Dashboard error ${res.status}` };
    const data = await res.json();
    if (data.pending) {
      approvalId = data.approvalId;
      continue; // server timed out the long-poll, ask again for the same approval
    }
    return data.result;
  }
}

async function captureForPhone(args) {
  const res = await fetch(`${URL_BASE}/internal/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId: Number(AGENT_ID), ...args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `capture failed (${res.status})`);
  return data;
}

async function sendFileToPhone(args) {
  const res = await fetch(`${URL_BASE}/internal/send_file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId: Number(AGENT_ID), ...args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `send_file failed (${res.status})`);
  return data;
}

const SEND_FILE_TOOL = {
  name: 'send_file',
  description: 'Sends a video (mp4/mov/webm/m4v) or image file from this PC into the phone chat so the owner can play or view it right there. Use it for finished videos, rendered clips, or generated images instead of describing them or pasting a path. Max 400MB.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the file (absolute, or relative to the workspace)' },
      caption: { type: 'string', description: 'One short Korean sentence shown under the video/image' },
    },
    required: ['file'],
  },
};

const RESTART_TOOL = {
  name: 'restart_server',
  description: 'Restarts the phone dashboard server (this app, leebeegle_SmartAgent) after its code was changed. The restart waits until your current turn ends, then relaunches automatically within ~5 seconds. Call this instead of killing processes, running node server/index.js, or starting scheduled tasks yourself; those break the phone connection.',
  inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'One short line: what changed' } } },
};

const CAPTURE_TOOL = {
  name: 'capture',
  description: 'Takes a screenshot of a web page, a local HTML file, or an HTML string on this PC and shows it in the phone chat as an image. Use it whenever the result of your work is something visual (web page, HTML, chart, UI) so the owner can see it on the phone. Only one of url / file / html is needed.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to render, e.g. a local dev server' },
      file: { type: 'string', description: 'Path to an .html file (absolute, or relative to the workspace)' },
      html: { type: 'string', description: 'Raw HTML to render' },
      caption: { type: 'string', description: 'One short Korean sentence shown under the image' },
      width: { type: 'number', description: 'Viewport width in px (default 500; values below 500 are raised to 500 because the headless browser cannot lay out narrower). Use 1200 for desktop-style pages.' },
      height: { type: 'number', description: 'Viewport height in px (default 844)' },
      full_page: { type: 'boolean', description: 'Use a tall viewport (2400px) to show more of the page' },
      wait_ms: { type: 'number', description: 'Extra render time before the shot (default 1500)' },
      fit_width_px: { type: 'number', description: "Use when the target's natural CSS width (e.g. a print poster laid out at 1600px) is wider than `width`. The page is scaled down to fit so the whole thing shows instead of being cropped to its left edge. Set this to the target's actual CSS pixel width." },
      phase: { type: 'string', enum: ['before', 'after'], description: "For visual changes: capture the same url/file with phase 'before' BEFORE editing and 'after' when done. The phone then shows the two side by side (전·후 비교)." },
    },
  },
};

const RUN_JOB_TOOL = {
  name: 'run_job',
  description: "Hands a long-running command (video/audio generation, rendering, uploads, builds, batches, anything over ~2 minutes) to the server. The server launches it in the background, keeps its output in a log file, and when it exits — success, failure, or 20 minutes without output — it automatically calls you again with the log tail so you can verify the result, send it to the phone, or fix the cause and retry (up to 3 attempts per label). After calling this, report '시작했습니다' and END YOUR TURN; do not sleep, poll, or tail the log.",
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The full shell command to run, e.g. "python make_video.py --ep 12"' },
      label: { type: 'string', description: 'Short Korean name of the job, e.g. "12화 영상 생성". Reuse the same label when retrying.' },
      cwd: { type: 'string', description: 'Working directory (absolute or relative to the workspace). Default: the workspace.' },
      shell: { type: 'string', enum: ['bash', 'powershell', 'cmd'], description: 'Which shell runs the command. Default bash (Git Bash).' },
    },
    required: ['command', 'label'],
  },
};
const WATCH_JOB_TOOL = {
  name: 'watch_job',
  description: "For a background job you already started some other way: registers its log file so the server watches it after your turn ends and calls you again when the log says done/완료, prints an error and stops changing, or (if `pid` is given) the process exits. Prefer run_job for new jobs.",
  inputSchema: {
    type: 'object',
    properties: {
      log_file: { type: 'string', description: 'Path to the log file (absolute, or relative to the workspace)' },
      label: { type: 'string', description: 'Short Korean name of the job' },
      pid: { type: 'number', description: 'Windows process id, if known' },
    },
    required: ['log_file', 'label'],
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'approver', version: '0.1.0' },
      },
    });
  } else if (method === 'notifications/initialized') {
    // no-op
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'approve',
            description: 'Forwards a permission prompt to the phone dashboard and returns the decision.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object', additionalProperties: true },
                tool_use_id: { type: 'string' },
              },
              required: ['tool_name', 'input'],
            },
          },
          CAPTURE_TOOL,
          SEND_FILE_TOOL,
          RUN_JOB_TOOL,
          WATCH_JOB_TOOL,
          RESTART_TOOL,
        ],
      },
    });
  } else if (method === 'tools/call' && params?.name === 'restart_server') {
    try {
      const res = await fetch(`${URL_BASE}/internal/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ agentId: Number(AGENT_ID), reason: params?.arguments?.reason || '' }),
      });
      if (!res.ok) throw new Error(`restart failed (${res.status})`);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '재시작을 예약했습니다. 이 답변을 마치면 서버가 5초 안에 자동으로 다시 켜집니다. 더 이상 명령을 실행하지 말고 대표에게 "잠시 후 앱을 새로고침하면 됩니다"라고만 알리세요.' }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `재시작 예약 실패: ${err.message}` }] } });
    }
  } else if (method === 'tools/call' && (params?.name === 'run_job' || params?.name === 'watch_job')) {
    try {
      const res = await fetch(`${URL_BASE}/internal/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ agentId: Number(AGENT_ID), mode: params.name === 'run_job' ? 'run' : 'watch', ...(params?.arguments || {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${params.name} failed (${res.status})`);
      const j = data.job || {};
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `배경 작업 "${j.label}"을(를) ${params.name === 'run_job' ? `띄웠습니다 (PID ${j.pid || '?'}, 로그 ${j.log_file})` : `지켜봅니다 (로그 ${j.log_file})`}. 끝나면 서버가 로그와 함께 당신을 자동으로 다시 부르니, 기다리거나 로그를 확인하지 말고 "시작했습니다"라고 보고한 뒤 턴을 끝내세요.` }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `배경 작업 등록 실패: ${err.message}` }] } });
    }
  } else if (method === 'tools/call' && params?.name === 'send_file') {
    const args = params?.arguments || {};
    try {
      const r = await sendFileToPhone(args);
      const sec = r.duration ? ` · ${Math.round(r.duration)}초` : '';
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `폰 채팅에 ${r.kind === 'video' ? '영상' : '사진'}을 보냈습니다 (${Math.round(r.size / 1048576)}MB${sec}). 답변에 파일 경로를 적을 필요는 없습니다.` }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `파일 보내기 실패: ${err.message}` }] } });
    }
  } else if (method === 'tools/call' && params?.name === 'capture') {
    const args = params?.arguments || {};
    try {
      const r = await captureForPhone(args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `캡처해서 폰 화면에 표시했습니다 (${r.width}×${r.height}). 답변에 이미지 경로를 적을 필요는 없습니다.` }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `캡처 실패: ${err.message}` }] } });
    }
  } else if (method === 'tools/call') {
    const args = params?.arguments || {};
    let result;
    try {
      result = await askDashboard(args.tool_name, args.input ?? {}, args.tool_use_id);
    } catch (err) {
      result = { behavior: 'deny', message: `Approver failed: ${err.message}` };
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});

rl.on('close', () => process.exit(0));
