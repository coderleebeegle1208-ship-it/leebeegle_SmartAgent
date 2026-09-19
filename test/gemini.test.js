import assert from 'node:assert/strict';
import test from 'node:test';

process.env.AGENT_REMOTE_DB = ':memory:';
process.env.CODEX_BIN = process.execPath;
const path = (await import('node:path')).default;
const os = (await import('node:os')).default;
process.env.AGENT_REMOTE_CONFIG = path.join(os.tmpdir(), `agent-remote-gemini-test-config-${process.pid}.json`);

const { Agents, Workspaces } = await import('../server/db.js');
const { otherProvider } = await import('../server/collaboration.js');
const { PHONE_STYLE_PROMPT, PHONE_STYLE_REMINDER, setAnswerStyle, stylePrompt } = await import('../server/style.js');
const { geminiDefaults, geminiFallbackModel, geminiModelCatalog, geminiModelLabel, geminiSlug, isGeminiModelAllowed, modelLabel, registerGeminiModels } = await import('../server/models.js');
const { parseAgyModels } = await import('../server/gemini-models.js');
const { buildGeminiArgs, createGeminiEventHandler, geminiEnv, geminiHomeFiles, geminiStyledText, geminiThinkingLevel } = await import('../server/runners/gemini.js');
const { bucketFor, parseGeminiQuota, parseLoginEmail, listAccounts } = await import('../server/gemini-accounts.js');
const { normalizeGeminiUsage } = await import('../server/tokens.js');
const { isModelUnavailableError, isUsageLimitError, splitGeminiSession, switchProvider } = await import('../server/runners/index.js');
const { getUsage } = await import('../server/usage.js');

test('Gemini pairs with Claude for planning and review', () => {
  assert.equal(otherProvider('gemini'), 'claude');
  assert.equal(otherProvider('claude'), 'codex');
  assert.equal(otherProvider('codex'), 'claude');
});

test('Gemini model catalog: auto default, families without the level suffix, labels, allow-list', () => {
  assert.equal(geminiDefaults().model, 'auto');
  assert.ok(isGeminiModelAllowed('gemini-3.1-pro'));
  assert.ok(isGeminiModelAllowed('gemini-3.8-flash'));
  assert.ok(!isGeminiModelAllowed('gemini-3.8-flash-high')); // 강도는 따로 고른다
  assert.ok(!isGeminiModelAllowed('gpt-5.5'));
  assert.equal(geminiModelLabel('gemini-3.8-flash'), '3.8 Flash');
  assert.equal(geminiModelLabel('gemini-3.8-flash-high'), '3.8 Flash');
  assert.equal(modelLabel('gemini-3.1-pro-low'), 'Gemini 3.1 Pro');
  assert.equal(modelLabel('auto'), 'Gemini 자동');
  assert.equal(modelLabel('claude-sonnet-4-6'), 'Sonnet 4.6'); // Claude 담당자의 모델 이름은 그대로
  assert.equal(modelLabel('gpt-oss-120b-medium'), 'GPT-OSS 120B (Google)');
  assert.ok(geminiModelCatalog().every((o) => o.value && o.label));
  assert.equal(geminiModelCatalog()[0].value, 'auto');
});

test('Gemini catalog follows `agy models`: slugs grouped into families, newest first, junk ignored', () => {
  const rows = parseAgyModels([
    'Fetching available models...',
    'gemini-3.9-flash-high\tGemini 3.9 Flash (High)',
    'gemini-3.9-flash-low\tGemini 3.9 Flash (Low)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'not a model line',
    '',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => r[0]), ['gemini-3.9-flash-high', 'gemini-3.9-flash-low', 'gemini-3.1-pro-high', 'claude-sonnet-4-6']);
  const merged = registerGeminiModels(rows);
  assert.deepEqual(merged, ['gemini-3.1-pro', 'gemini-3.9-flash', 'claude-sonnet-4-6']);
  assert.ok(isGeminiModelAllowed('gemini-3.9-flash') && !isGeminiModelAllowed('gemini-3.8-flash'));
  assert.equal(geminiModelLabel('gemini-3.9-flash'), '3.9 Flash');
  assert.equal(geminiModelLabel('claude-sonnet-4-6'), 'Claude Sonnet 4.6 (Google)');
  // 자동 = 최신 Flash. 강도에 맞는 슬러그가 없으면 가까운 단계로.
  assert.deepEqual(geminiSlug('auto', 'medium'), { model: 'gemini-3.9-flash-high', effort: null });
  assert.deepEqual(geminiSlug('gemini-3.9-flash', 'low'), { model: 'gemini-3.9-flash-low', effort: null });
  assert.deepEqual(geminiSlug('claude-sonnet-4-6', 'high'), { model: 'claude-sonnet-4-6', effort: 'high' });
  registerGeminiModels([]); // 빈 목록 → 손으로 적어 둔 기본 목록으로 복귀
  assert.ok(isGeminiModelAllowed('gemini-3.8-flash') && !isGeminiModelAllowed('gemini-3.9-flash'));
  assert.deepEqual(geminiSlug('auto', null), { model: 'gemini-3.8-flash-medium', effort: null });
  assert.deepEqual(geminiSlug('gemini-3.1-pro', 'medium'), { model: 'gemini-3.1-pro-high', effort: null }); // Pro엔 medium이 없다
  assert.deepEqual(geminiSlug(null, 'high'), { model: 'gemini-3.8-flash-high', effort: null });
});

test('Gemini model fallback: same tier one step older, then auto', () => {
  assert.equal(geminiFallbackModel('gemini-3.8-flash'), 'gemini-3.7-flash');
  assert.equal(geminiFallbackModel('gemini-3.7-flash'), 'gemini-3.6-flash');
  assert.equal(geminiFallbackModel('gemini-3.6-flash'), 'auto');
  assert.equal(geminiFallbackModel('gemini-3.1-pro'), 'auto');
  assert.equal(geminiFallbackModel('claude-sonnet-4-6'), 'auto');
  assert.equal(geminiFallbackModel('auto'), null);
  assert.ok(isModelUnavailableError({ ok: false, text: 'Model gemini-3.5-flash is not found for API version v1internal' }));
  assert.ok(isModelUnavailableError({ ok: false, text: 'unknown model "gemini-9-flash-high"', subtype: 'ERROR' }));
  assert.ok(!isModelUnavailableError({ ok: false, text: 'RESOURCE_EXHAUSTED: quota exceeded' }));
  assert.ok(!isModelUnavailableError({ ok: true, text: 'done' }));
});

test('Gemini args: stream-json both ways, plan mode for ask, resume by conversation id, add dirs', () => {
  const args = buildGeminiArgs({ pre: [] }, { permission_mode: 'ask', session_id: 'abc-123', model: 'gemini-3.1-pro', effort: 'low' }, { includeDirs: ['C:\\up'] });
  assert.deepEqual(args, ['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--model', 'gemini-3.1-pro-low', '--add-dir', 'C:\\up', '--conversation', 'abc-123']);
  const full = buildGeminiArgs({ pre: [] }, { permission_mode: 'auto', session_id: null, model: null }, {});
  assert.ok(full.includes('--dangerously-skip-permissions') && !full.includes('--conversation') && !full.includes('--mode'));
  assert.ok(full.includes('gemini-3.8-flash-medium')); // 자동 = 최신 Flash, 강도 없음 → medium
  // 계획·검토 단계는 권한 설정과 무관하게 읽기 전용
  assert.ok(buildGeminiArgs({ pre: [] }, { permission_mode: 'auto' }, { approvalMode: 'plan' }).includes('plan'));
  // Claude(Google) 모델은 --effort로 강도를 넘긴다
  const cl = buildGeminiArgs({ pre: [] }, { permission_mode: 'auto', model: 'claude-sonnet-4-6', effort: 'high' }, {});
  assert.ok(cl.includes('--effort') && cl[cl.indexOf('--effort') + 1] === 'high');
});

test('Gemini thinking level: low/medium/high pass through, anything above → high', () => {
  assert.equal(geminiThinkingLevel('low'), 'low');
  assert.equal(geminiThinkingLevel('medium'), 'medium');
  assert.equal(geminiThinkingLevel('high'), 'high');
  assert.equal(geminiThinkingLevel('max'), 'high');
  assert.equal(geminiThinkingLevel(null), null);
});

test('Gemini home files: approver MCP per agent, credits off, owner git identity included', () => {
  const files = geminiHomeFiles({ id: 7 }, { port: 3000, internalToken: 'tok' });
  const mcp = files['.gemini/config/mcp_config.json'].mcpServers.approver;
  assert.equal(mcp.env.APPROVER_AGENT_ID, '7');
  assert.equal(mcp.env.APPROVER_URL, 'http://127.0.0.1:3000');
  assert.equal(files['.gemini/antigravity-cli/settings.json'].useG1Credits, false);
  assert.match(files['.gitconfig'], /\[include\]/);
  assert.deepEqual(geminiHomeFiles({ id: 7 }, {})['.gemini/config/mcp_config.json'].mcpServers, {});
});

test('Gemini env: per-agent home, no API key or SSH marker leaking in', () => {
  process.env.GEMINI_API_KEY = 'leak';
  process.env.SSH_CONNECTION = 'leak';
  try {
    const env = geminiEnv({ id: 1 }, { port: 3000, internalToken: 't' }, { home: 'H' });
    assert.equal(env.USERPROFILE, 'H');
    assert.equal(env.HOME, 'H');
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, '1');
    assert.ok(!('GEMINI_API_KEY' in env) && !('SSH_CONNECTION' in env));
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.SSH_CONNECTION;
  }
});

test('Gemini styled text: full guide on first turn, reminder on resume, nothing for plan/review', () => {
  setAnswerStyle('phone');
  assert.ok(geminiStyledText('x', { session_id: null }).startsWith(PHONE_STYLE_PROMPT));
  assert.ok(geminiStyledText('x', { session_id: 's' }).endsWith(PHONE_STYLE_REMINDER));
  assert.equal(geminiStyledText('x', { session_id: null }, { stage: 'plan' }), 'x');
  setAnswerStyle('desktop');
  assert.ok(geminiStyledText('x', { session_id: null }).startsWith(stylePrompt()));
  assert.ok(geminiStyledText('x', { session_id: 's' }).endsWith('x')); // PC 앱 말투는 되새김 문구가 없다
});

test('Antigravity stream-json → hooks: text deltas merge per step, tools shown, result carries usage', () => {
  const calls = [];
  const hooks = {
    onSession: (id, info) => calls.push(['session', id, info.model]),
    onMessage: (role, content, meta) => calls.push([role, content, meta?.is_error]),
    onResult: (r) => calls.push(['result', r]),
  };
  const handle = createGeminiEventHandler(hooks);
  const cid = 'conv-1';
  handle({ event: 'init', init: { conversation_id: cid, model: 'gemini-3.8-flash-high', cwd: 'C:\\w', tools: [] } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 0, state: 'DONE', step_type: 'user_input' } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '먼저 ' } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '확인합니다.', usage: { input_tokens: 10, output_tokens: 5 } } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, error: { type: 'TOOL_ERROR', message: 'boom' } } } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:\\w\\a.js' } } } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'C:\\w\\a.js' }, output: '5 lines' } } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: '완료했습니다.' } });
  handle({ event: 'step_update', step_update: { conversation_id: cid, step_index: 4, state: 'DONE', step_type: 'agent_response' } });
  handle({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: '먼저 확인합니다.\n완료했습니다.\n', num_turns: 1, usage: { input_tokens: 1000, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 400, total_tokens: 1050 } } });
  assert.deepEqual(calls[0], ['session', cid, 'gemini-3.8-flash-high']);
  assert.deepEqual(calls[1], ['assistant', '먼저 확인합니다.', undefined]);
  assert.deepEqual(calls[2], ['tool', '$ ls', undefined]);
  assert.deepEqual(calls[3], ['tool_result', 'boom', true]);
  assert.deepEqual(calls[4], ['tool', 'view_file: C:\\w\\a.js', undefined]);
  assert.deepEqual(calls[5], ['tool_result', '5 lines', false]);
  assert.deepEqual(calls[6], ['assistant', '완료했습니다.', undefined]);
  assert.equal(calls[7][0], 'result');
  const r = calls[7][1];
  assert.equal(r.ok, true);
  assert.equal(r.text, '완료했습니다.');
  assert.equal(r.session_id, cid);
  assert.equal(calls.length, 8); // result.response는 이미 보여준 글이라 다시 붙이지 않는다
  assert.deepEqual(normalizeGeminiUsage(r.usage), { input: 600, output: 50, cacheRead: 400, cacheWrite: 0, cost: null });
  // 조각이 하나도 안 온 턴: result.response를 답으로 쓴다
  const c2 = [];
  const h2 = createGeminiEventHandler({ onResult: (x) => c2.push(['result', x]), onMessage: (role, content) => c2.push([role, content]) });
  h2({ event: 'result', result: { status: 'SUCCESS', response: '4\n', usage: {} } });
  assert.deepEqual(c2[0], ['assistant', '4']);
  assert.equal(c2[1][1].text, '4');
  // 오류 결과
  const errCalls = [];
  const h3 = createGeminiEventHandler({ onResult: (x) => errCalls.push(x), onMessage() {} });
  h3({ event: 'result', result: { status: 'ERROR', response: '', error: 'Weekly limit reached for Gemini models', usage: {} } });
  assert.equal(errCalls[0].ok, false);
  assert.ok(isUsageLimitError({ ok: false, text: errCalls[0].text }));
  assert.ok(isUsageLimitError({ ok: false, text: 'RESOURCE_EXHAUSTED' }));
  assert.ok(isUsageLimitError({ ok: false, text: 'MODEL_CAPACITY_EXHAUSTED' }));
  // 도구가 막혀 답이 비면 그 이유를 답으로 남긴다
  const d = [];
  const h4 = createGeminiEventHandler({ onResult: (x) => d.push(x), onMessage() {} });
  h4({ event: 'result', result: { status: 'SUCCESS', response: '', usage: {}, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
  assert.match(d[0].text, /RunCommand/);
});

test('Antigravity /usage table → used-percent rows; login email from the log', () => {
  const rows = parseGeminiQuota([
    'Gemini Models\tWeekly Limit Remaining\t75%\t2026-09-26T04:10:03Z',
    'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-19T09:10:03Z',
    'Claude and GPT models\tWeekly Limit Remaining\t40%\t2026-09-26T04:18:54Z',
    'garbage line',
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, 'Gemini 주간');
  assert.equal(rows[0].pct, 25);
  assert.equal(rows[0].remainingFraction, 0.75);
  assert.ok(rows[0].resets);
  assert.equal(rows[1].label, 'Gemini 5시간');
  assert.equal(rows[1].pct, 0);
  assert.equal(rows[2].label, 'Claude·GPT 주간');
  assert.equal(rows[2].pct, 60);
  assert.deepEqual(parseGeminiQuota(''), []);
  // 모델이 속한 묶음 중 더 빠듯한 창이 기준
  assert.equal(bucketFor(rows, 'gemini-3.8-flash-high').label, 'Gemini 주간');
  assert.equal(bucketFor(rows, 'claude-sonnet-4-6').label, 'Claude·GPT 주간');
  assert.equal(parseLoginEmail('I0919 server_oauth.go:201] OAuth: authenticated successfully as someone@gmail.com\n'), 'someone@gmail.com');
  assert.equal(parseLoginEmail('nothing here'), null);
});

test('Gemini session ids carry the account they belong to', () => {
  assert.deepEqual(splitGeminiSession('agy:1234-abcd'), { accountId: 'agy', sessionId: '1234-abcd' });
  assert.deepEqual(splitGeminiSession('1234-abcd'), { accountId: null, sessionId: '1234-abcd' });
  assert.deepEqual(splitGeminiSession(null), { accountId: null, sessionId: null });
});

test('switching to Gemini needs a connected Google account; usage says so too', async () => {
  const ws = Workspaces.create('gws', path.join(os.tmpdir(), `gws-${process.pid}`));
  const a = Agents.create(ws.id, 'claude', 'g');
  if (!listAccounts().length) {
    assert.throws(() => switchProvider(a.id, 'gemini'), /Google 계정|Antigravity/);
    const u = await getUsage('gemini');
    assert.equal(u.provider, 'gemini');
    assert.equal(u.ok, false);
    assert.match(u.error, /Google 계정/);
  }
  assert.throws(() => switchProvider(a.id, 'nope'), /provider must be/);
});
