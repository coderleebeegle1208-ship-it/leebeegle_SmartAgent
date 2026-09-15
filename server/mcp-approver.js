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
    },
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
        ],
      },
    });
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
