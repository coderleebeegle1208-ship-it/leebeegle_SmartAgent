// Dev check for the approval bridge without needing a logged-in Claude:
// drives server/mcp-approver.js over stdio exactly as Claude Code would, then waits for
// the decision made in the phone UI. Usage: node scripts/test-approver.js <agentId> [port]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const agentId = process.argv[2] || '1';

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-approver.js')], {
  env: { ...process.env, APPROVER_URL: `http://127.0.0.1:${process.argv[3] || cfg.port}`, APPROVER_TOKEN: cfg.internalToken, APPROVER_AGENT_ID: agentId },
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => process.stdout.write('[approver] ' + d));

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test', description: 'run tests' }, tool_use_id: 'toolu_test' } },
});
console.log('approval requested for agent', agentId, '- decide it in the UI');
setTimeout(() => { console.log('timeout'); child.kill(); process.exit(1); }, 120000);
child.on('close', () => process.exit(0));
