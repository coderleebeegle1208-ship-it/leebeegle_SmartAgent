import assert from 'node:assert/strict';
import test from 'node:test';

process.env.AGENT_REMOTE_DB = ':memory:';
process.env.CODEX_BIN = process.execPath;

const { AgentSessions, Agents, Workspaces } = await import('../server/db.js');
const { buildClaudeArgs } = await import('../server/runners/claude.js');
const { buildCodexArgs } = await import('../server/runners/codex.js');
const { isUsageLimitError, stageEfforts, switchProvider } = await import('../server/runners/index.js');
const { buildReviewPrompt, buildRevisionPrompt, compactConversation, formatGitManifest, otherProvider } = await import('../server/collaboration.js');
const { parseUsage } = await import('../server/usage.js');
const { PHONE_STYLE_PROMPT, PHONE_STYLE_REMINDER, withPhoneReminder, withPhoneStyle } = await import('../server/style.js');
const { MIN_CAPTURE_WIDTH, resolveTarget } = await import('../server/capture.js');
const { MODEL_CATALOG, isModelAllowed, modelLabel } = await import('../server/models.js');
const { isValidRemoteUrl, parseRemote } = await import('../server/git.js');

test('Codex resume options stay before the resume subcommand', () => {
  const args = buildCodexArgs(
    { pre: ['codex.js'] },
    { permission_mode: 'ask', session_id: 'thread-123', model: null },
    { path: 'C:\\project' },
    '계속 진행',
  );
  assert.deepEqual(args, [
    'codex.js', 'exec', '--json', '--skip-git-repo-check', '-C', 'C:\\project',
    '--sandbox', 'read-only', 'resume', 'thread-123', '계속 진행',
  ]);
  assert.ok(args.indexOf('-C') < args.indexOf('resume'));
  assert.ok(args.indexOf('--sandbox') < args.indexOf('resume'));
});

test('Claude reviewer is restricted to read-only inspection tools', () => {
  const args = buildClaudeArgs(
    { permission_mode: 'acceptEdits', session_id: 'claude-session', model: null, effort: null },
    'agent.json',
    { tools: ['Read', 'Glob', 'Grep'], permissionMode: 'dontAsk', disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'], model: 'sonnet' },
  );
  assert.ok(args.includes('dontAsk'));
  assert.deepEqual(args.slice(args.indexOf('--tools') + 1, args.indexOf('--permission-mode')), ['Read', 'Glob', 'Grep']);
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--model')), ['Write', 'Edit', 'NotebookEdit', 'Bash']);
});

test('usage-limit classifier only accepts quota-style failures', () => {
  assert.equal(isUsageLimitError({ ok: false, text: 'rate_limit_exceeded' }), true);
  assert.equal(isUsageLimitError({ ok: false, text: '주간 한도에 도달했습니다' }), true);
  assert.equal(isUsageLimitError({ ok: false, text: 'syntax error in app.js' }), false);
  assert.equal(isUsageLimitError({ ok: true, text: 'quota mentioned in a successful answer' }), false);
});

test('provider switching preserves independent Claude and Codex sessions', () => {
  const workspace = Workspaces.create('test', process.cwd());
  let agent = Agents.create(workspace.id, 'claude', 'switch test');
  assert.equal(agent.auto_failover, 0);
  assert.equal(agent.collab_mode, 0);
  assert.equal(agent.collab_stage, null);
  assert.equal(agent.pipeline, 'auto');
  assert.equal(agent.triage_model, 'haiku');
  assert.equal(agent.plan_model, 'fable');
  assert.equal(agent.exec_model, 'sonnet');
  assert.equal(agent.plan_effort, null);
  assert.equal(agent.exec_effort, null);

  agent = Agents.update(agent.id, { session_id: 'claude-session', status: 'done' });
  agent = switchProvider(agent.id, 'codex');
  assert.equal(agent.kind, 'codex');
  assert.equal(agent.session_id, null);
  assert.equal(AgentSessions.get(agent.id, 'claude').session_id, 'claude-session');

  AgentSessions.upsert(agent.id, 'codex', 'codex-thread');
  Agents.update(agent.id, { session_id: 'codex-thread', status: 'done' });
  agent = switchProvider(agent.id, 'claude');
  assert.equal(agent.kind, 'claude');
  assert.equal(agent.session_id, 'claude-session');
  assert.equal(AgentSessions.get(agent.id, 'codex').session_id, 'codex-thread');
  AgentSessions.clear(agent.id);
  assert.equal(AgentSessions.forAgent(agent.id).length, 0);
});

test('Claude usage parser keeps session, weekly, and Fable-specific limits', () => {
  const items = parseUsage([
    'Current session: 22% used · resets 3pm (Asia/Seoul)',
    'Current week (all models): 41% used · resets Sep 20',
    'Current week (Fable 5.1): 63% used · resets Sep 20',
  ].join('\n'));
  assert.deepEqual(items.map(({ label, pct }) => ({ label, pct })), [
    { label: '5시간 세션', pct: 22 },
    { label: '주간 · 전체 모델', pct: 41 },
    { label: '주간 · Fable 5.1', pct: 63 },
  ]);
});

test('collaboration direction is symmetric', () => {
  assert.equal(otherProvider('claude'), 'codex');
  assert.equal(otherProvider('codex'), 'claude');
});

test('collaboration context keeps recent useful messages within its budget', () => {
  const text = compactConversation([
    { role: 'tool_result', content: 'skip this' },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'x'.repeat(80) },
    { role: 'user', content: 'latest request' },
  ], 110);
  assert.doesNotMatch(text, /skip this/);
  assert.match(text, /latest request/);
  assert.ok(text.length <= 110);
});

test('review and revision prompts preserve roles and privacy-minimized Git context', () => {
  const gitManifest = formatGitManifest({ isRepo: true, branch: 'main', changes: [{ code: 'M', file: 'src/app.js' }] });
  const review = buildReviewPrompt({
    originalText: '기능을 구현해', implementationText: '구현 완료', recentContext: '사용자: 기능을 구현해', gitManifest,
    implementer: 'claude', reviewer: 'codex',
  });
  assert.match(review, /Codex 교차 리뷰어/);
  assert.match(review, /파일을 수정하지 마세요/);
  assert.match(review, /M src\/app\.js/);

  const revision = buildRevisionPrompt({
    originalText: '기능을 구현해', reviewText: '검토 결과', gitManifest,
    implementer: 'codex', reviewer: 'claude',
  });
  assert.match(revision, /최초 구현자인 Codex/);
  assert.match(revision, /Claude의 교차 리뷰/);
});

test('phone-friendly answer style reaches both providers', () => {
  const args = buildClaudeArgs({ permission_mode: 'ask', session_id: null, model: null, effort: null }, 'agent.json', {});
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], PHONE_STYLE_PROMPT);
  assert.match(PHONE_STYLE_PROMPT, /마크다운 기호/);
  assert.ok(withPhoneStyle('계속 진행').endsWith('\n\n---\n\n계속 진행'));
  assert.ok(withPhoneStyle('계속 진행').startsWith(PHONE_STYLE_PROMPT));
  assert.equal(withPhoneReminder('계속 진행'), `계속 진행\n\n${PHONE_STYLE_REMINDER}`);
});

test('model catalog offers latest aliases plus pinned versions per stage', () => {
  assert.ok(isModelAllowed('plan', 'fable'));
  assert.ok(isModelAllowed('plan', 'claude-fable-5-1'));
  assert.ok(!isModelAllowed('plan', 'haiku'));          // planning never drops to the small model
  assert.ok(!isModelAllowed('exec', 'claude-fable-5'));
  assert.ok(!isModelAllowed('triage', 'gpt-4o'));
  assert.equal(MODEL_CATALOG.plan[0].value, 'fable');
  assert.equal(MODEL_CATALOG.plan[0].label, 'Fable 최신');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('sonnet'), 'Sonnet 최신');
});

test('git remote URLs are parsed for display and validated before reaching git', () => {
  assert.equal(parseRemote('https://github.com/owner/repo.git').name, 'owner/repo');
  assert.equal(parseRemote('git@github.com:owner/repo.git').webUrl, 'https://github.com/owner/repo');
  assert.equal(parseRemote('ssh://git@gitlab.com/o/r').host, 'gitlab.com');
  assert.equal(parseRemote('').url, null);
  assert.ok(isValidRemoteUrl('https://github.com/a/b'));
  assert.ok(isValidRemoteUrl('git@github.com:a/b.git'));
  assert.ok(!isValidRemoteUrl('--upload-pack=touch x'));
  assert.ok(!isValidRemoteUrl('https://github.com/a/b; rm -rf /'));
  assert.ok(!isValidRemoteUrl('http://github.com/a/b'));
  assert.ok(!isValidRemoteUrl(''));
});

test('capture tool is pre-allowed for Claude and targets resolve safely', () => {
  const args = buildClaudeArgs({ permission_mode: 'ask', session_id: null, model: null, effort: null }, 'agent.json', {});
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__approver__capture');
  assert.match(PHONE_STYLE_PROMPT, /mcp__approver__capture/);
  assert.throws(() => resolveTarget({}, process.cwd(), process.cwd()), /url, file, html/);
  assert.throws(() => resolveTarget({ url: 'javascript:alert(1)' }, process.cwd(), process.cwd()), /http/);
  assert.throws(() => resolveTarget({ file: 'definitely-missing.html' }, process.cwd(), process.cwd()), /파일이 없습니다/);
  assert.match(resolveTarget({ url: 'http://localhost:5173/' }, process.cwd(), process.cwd()).href, /^http:\/\/localhost:5173\/$/);
  assert.equal(MIN_CAPTURE_WIDTH, 500);
});

test('per-stage effort: plan stays at least high, execution follows the CLI default until set', () => {
  assert.deepEqual(stageEfforts({ plan_effort: null, exec_effort: null }), { plan: 'high', exec: null });
  assert.deepEqual(stageEfforts({ plan_effort: 'max', exec_effort: 'low' }), { plan: 'max', exec: 'low' });
  const args = buildClaudeArgs({ permission_mode: 'ask', session_id: null, model: null, effort: 'medium' }, 'agent.json', { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(args.slice(args.indexOf('--effort')), ['--effort', 'xhigh']);
  const inherited = buildClaudeArgs({ permission_mode: 'ask', session_id: null, model: null, effort: null }, 'agent.json', { model: 'sonnet', effort: null });
  assert.ok(!inherited.includes('--effort'));
});
