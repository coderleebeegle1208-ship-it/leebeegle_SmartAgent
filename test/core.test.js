import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.AGENT_REMOTE_DB = ':memory:';
process.env.CODEX_BIN = process.execPath;
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const os = (await import('node:os')).default;
process.env.AGENT_REMOTE_CONFIG = path.join(os.tmpdir(), `agent-remote-test-config-${process.pid}.json`);
process.env.AGENT_REMOTE_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-backups-'));

const { AgentSessions, Agents, Messages, Workspaces } = await import('../server/db.js');
const { buildClaudeArgs, claudeStdinText, guardSettings } = await import('../server/runners/claude.js');
const { outsideRisk } = await import('../server/guard.js');
const { createRunWatch, watchLimits, describeVerdict } = await import('../server/watchdog.js');
const { enqueuePrompt, queuedPrompts, removeQueued, isTransientError, deliverableFiles } = await import('../server/runners/index.js');
const { isSafeWhenUnattended, configureUnattended } = await import('../server/approvals.js');
const { explainError, errorMessageText } = await import('../server/errors.js');
const { Queue } = await import('../server/db.js');
const { CODEX_EFFICIENCY_CONFIG, buildCodexArgs, codexApproverConfig, codexApproverEnv, codexStyledText } = await import('../server/runners/codex.js');
const { clipForTriage, claudeAddDirs, failoverContinuation, isUsageLimitError, stageEfforts, switchProvider } = await import('../server/runners/index.js');
const { buildReviewPrompt, buildRevisionPrompt, compactConversation, formatGitManifest, otherProvider } = await import('../server/collaboration.js');
const { parseUsage, parseCodexRateLimits } = await import('../server/usage.js');
const { PHONE_STYLE_PROMPT, PHONE_STYLE_REMINDER, PHONE_STYLE_REMINDER_SHORT, withPhoneReminder, withPhoneReminderShort, withPhoneStyle } = await import('../server/style.js');
const { MIN_CAPTURE_WIDTH, resolveTarget } = await import('../server/capture.js');
const { CODEX_MODEL_CATALOG, MODEL_CATALOG, codexDefaults, codexModelLabel, isCodexModelAllowed, isModelAllowed, modelLabel } = await import('../server/models.js');
const { isValidRemoteUrl, parseRemote } = await import('../server/git.js');
const { estimateCost, normalizeClaudeUsage, normalizeCodexUsage, summarizeRun, usageHeadline } = await import('../server/tokens.js');
const { UPLOAD_DIR, attachmentBlock, extractLinks, loadUpload, videoFrameCount } = await import('../server/uploads.js');
const { loadConfig } = await import('../server/config.js');
const {
  copySkill, deleteSkill, expandSkill, listImportableSkills, listSkills, parseFrontmatter, resolveSkillCommand,
  skillCatalogBlock, skillPointerBlock, triageTextFor, validateSkillName, writeSkill,
} = await import('../server/skills.js');

test('Codex resume options stay before the resume subcommand', () => {
  const args = buildCodexArgs(
    { pre: ['codex.js'] },
    { permission_mode: 'ask', session_id: 'thread-123', model: null },
    { path: 'C:\\project' },
    '계속 진행',
  );
  assert.deepEqual(args.slice(args.indexOf('exec')), [
    'exec', '--ignore-user-config', '--json', '--skip-git-repo-check', '-C', 'C:\\project',
    '--sandbox', 'read-only', 'resume', 'thread-123', '계속 진행',
  ]);
  assert.ok(args.indexOf('-C') < args.indexOf('resume'));
  assert.ok(args.indexOf('--sandbox') < args.indexOf('resume'));
});

test('buildClaudeArgs resumes an existing Claude session and omits --resume otherwise', () => {
  const withSession = buildClaudeArgs({ session_id: 'claude-session-1' }, 'mcp.json', {});
  const at = withSession.indexOf('--resume');
  assert.ok(at !== -1);
  assert.equal(withSession[at + 1], 'claude-session-1');

  const withoutSession = buildClaudeArgs({ session_id: null }, 'mcp.json', {});
  assert.equal(withoutSession.indexOf('--resume'), -1);
});

test('Codex model and reasoning choice are passed to the CLI', () => {
  const args = buildCodexArgs(
    { pre: ['codex.js'] },
    { permission_mode: 'acceptEdits', session_id: null, model: 'gpt-5.6-terra', effort: 'high' },
    { path: 'C:\\project' },
    '작업',
  );
  const execAt = args.indexOf('exec');
  assert.ok(execAt > 0);
  assert.ok(args.slice(0, execAt).includes('model_reasoning_effort="high"'));
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-terra');
});

test('Codex always gets bounded context, tool output, and concise response settings', () => {
  const args = buildCodexArgs(
    { pre: [] },
    { permission_mode: 'acceptEdits', session_id: 'thread-1', model: 'gpt-5.6-terra', effort: 'medium' },
    { path: 'C:\\project' },
    '계속',
  );
  for (const setting of CODEX_EFFICIENCY_CONFIG) assert.ok(args.includes(setting), setting);
  assert.ok(args.includes('memories.use_memories=false'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.indexOf('model_auto_compact_token_limit=100000') < args.indexOf('exec'));
  assert.ok(args.indexOf('tool_output_token_limit=4000') < args.indexOf('resume'));
});

test('Codex gets only the safe dashboard tools without leaking the internal token into arguments', () => {
  const cfg = { port: 3000, internalToken: 'secret-value' };
  const settings = codexApproverConfig(cfg);
  assert.ok(settings.some((s) => s.includes('enabled_tools=["capture","restart_server"]')));
  assert.ok(settings.every((s) => !s.includes(cfg.internalToken)));
  const env = codexApproverEnv({ id: 7 }, cfg);
  assert.equal(env.APPROVER_AGENT_ID, '7');
  assert.equal(env.APPROVER_TOKEN, cfg.internalToken);
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

test('failoverContinuation carries the plan along instead of dropping it on provider switch', () => {
  const withoutPlan = failoverContinuation('버그 고쳐줘', null);
  assert.match(withoutPlan, /버그 고쳐줘/);
  assert.doesNotMatch(withoutPlan, /\[계획\]/);

  const withPlan = failoverContinuation('버그 고쳐줘', '- 1단계: 원인 파악\n- 2단계: 수정');
  assert.match(withPlan, /버그 고쳐줘/);
  assert.match(withPlan, /\[계획\]\n- 1단계: 원인 파악/);
});

test('videoFrameCount tapers off for longer videos instead of always maxing out', () => {
  assert.equal(videoFrameCount(0), 8); // unknown duration: keep the old safe default
  assert.equal(videoFrameCount(5), 5);
  assert.equal(videoFrameCount(8), 8);
  assert.equal(videoFrameCount(15), 4);
  assert.equal(videoFrameCount(60), 6);
  assert.equal(videoFrameCount(600), 8);
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

test('Codex rate limits expose the five-hour and weekly windows', () => {
  const usage = parseCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        planType: 'plus',
        primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 2_000_100_000 },
      },
    },
  });
  assert.equal(usage.ok, true);
  assert.equal(usage.provider, 'codex');
  assert.deepEqual(usage.items.map(({ label, pct }) => ({ label, pct })), [
    { label: '5시간 한도', pct: 24 },
    { label: '주간 한도', pct: 61 },
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
    diff: '+added line\n-removed line', plan: '- 계획 1단계',
    implementer: 'claude', reviewer: 'codex',
  });
  assert.match(review, /Codex 교차 리뷰어/);
  assert.match(review, /파일을 수정하지 마세요/);
  assert.match(review, /<diff>[\s\S]*added line[\s\S]*<\/diff>/);
  assert.match(review, /<plan>[\s\S]*계획 1단계[\s\S]*<\/plan>/);
  assert.match(review, /diff가 이번 변경 사항을 그대로/);
  // diff --stat already names every changed file, so the manifest is dropped to avoid a duplicate file list.
  assert.doesNotMatch(review, /M src\/app\.js/);
  assert.doesNotMatch(review, /git_manifest/);

  const reviewWithoutDiff = buildReviewPrompt({
    originalText: '기능을 구현해', implementationText: '구현 완료', recentContext: '사용자: 기능을 구현해', gitManifest,
    diff: '', plan: '- 계획 1단계',
    implementer: 'claude', reviewer: 'codex',
  });
  assert.match(reviewWithoutDiff, /M src\/app\.js/);

  const revision = buildRevisionPrompt({
    originalText: '기능을 구현해', reviewText: '검토 결과',
    implementer: 'codex', reviewer: 'claude',
  });
  assert.match(revision, /최초 구현자인 Codex/);
  assert.match(revision, /Claude의 교차 리뷰/);
  assert.doesNotMatch(revision, /git_manifest/);
});

test('phone-friendly answer style reaches both providers', () => {
  const args = buildClaudeArgs({ permission_mode: 'ask', session_id: null, model: null, effort: null }, 'agent.json', {});
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], PHONE_STYLE_PROMPT);
  assert.match(PHONE_STYLE_PROMPT, /마크다운 기호/);
  assert.ok(withPhoneStyle('계속 진행').endsWith('\n\n---\n\n계속 진행'));
  assert.ok(withPhoneStyle('계속 진행').startsWith(PHONE_STYLE_PROMPT));
  assert.equal(withPhoneReminder('계속 진행'), `계속 진행\n\n${PHONE_STYLE_REMINDER}`);
  assert.equal(withPhoneReminderShort('계속 진행'), `계속 진행\n\n${PHONE_STYLE_REMINDER_SHORT}`);
  assert.ok(PHONE_STYLE_REMINDER_SHORT.length < PHONE_STYLE_REMINDER.length / 2);
});

test('phone tone reminder/guide only reaches turns the owner actually reads', () => {
  // Claude: the same turn's --append-system-prompt already carries the full guide, so the stdin
  // reminder only needs the short form that points back at it (except on plan/review turns, which
  // get neither since their output isn't read by the owner).
  assert.equal(claudeStdinText('계속 진행', {}), withPhoneReminderShort('계속 진행'));
  assert.equal(claudeStdinText('계획 세워', { stage: 'plan' }), '계획 세워');
  assert.equal(claudeStdinText('검토해', { phase: 'review' }), '검토해');
  assert.equal(claudeStdinText('실행해', { stage: 'exec' }), withPhoneReminderShort('실행해'));

  // Codex: no system-prompt flag, so the guide (or its reminder) rides in the instruction text itself.
  assert.equal(codexStyledText('시작', { session_id: null }, {}), withPhoneStyle('시작'));
  assert.equal(codexStyledText('계속', { session_id: 'thread-1' }, {}), withPhoneReminder('계속'));
  assert.equal(codexStyledText('검토해', { session_id: null }, { phase: 'review' }), '검토해');
  assert.equal(codexStyledText('검토해', { session_id: 'thread-1' }, { phase: 'review' }), '검토해');
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

test('Codex model catalog is a single-model picker with current choices', () => {
  assert.ok(isCodexModelAllowed('gpt-6-astra'));
  assert.ok(isCodexModelAllowed('gpt-5.6-sol'));
  assert.ok(!isCodexModelAllowed('gpt-5.2'));
  assert.equal(CODEX_MODEL_CATALOG[1].label, '5.6 Sol');
  assert.equal(codexModelLabel('gpt-5.6-terra'), '5.6 Terra');
  assert.deepEqual(codexDefaults(), { model: 'gpt-5.6-terra', effort: 'medium' });
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

test('WebFetch is pre-allowed and attachment folders get --add-dir', () => {
  const args = buildClaudeArgs({ permission_mode: 'ask', session_id: null, model: null, effort: null }, 'agent.json', { addDirs: ['C:\\data\\uploads\\agent-1'] });
  assert.ok(args.includes('WebFetch'));
  const i = args.indexOf('--add-dir');
  assert.ok(i > -1);
  assert.equal(args[i + 1], 'C:\\data\\uploads\\agent-1');
});

test('claudeAddDirs always includes the agent upload folder, even with no uploads yet', () => {
  const dirs = claudeAddDirs('add-dirs-test-agent');
  assert.equal(dirs.length, 1);
  assert.ok(dirs[0].endsWith(path.join('uploads', 'agent-add-dirs-test-agent')));
  assert.ok(fs.existsSync(dirs[0]));
  const withExtra = claudeAddDirs('add-dirs-test-agent', ['C:\\extra\\dir']);
  assert.deepEqual(withExtra, ['C:\\extra\\dir', dirs[0]]);
});

test('Codex image attachments are passed as -i flags before resume', () => {
  const args = buildCodexArgs(
    { pre: ['codex.js'] },
    { permission_mode: 'ask', session_id: 'thread-123', model: null },
    { path: 'C:\\project' },
    '사진 보고 답해',
    { images: ['C:\\data\\uploads\\agent-1\\1-view.jpg'] },
  );
  const i = args.indexOf('-i');
  assert.ok(i > -1);
  assert.equal(args[i + 1], 'C:\\data\\uploads\\agent-1\\1-view.jpg');
  assert.ok(i < args.indexOf('resume'));
});

test('attachmentBlock describes photos and video scene frames; extractLinks merges body URLs with explicit ones and dedupes', () => {
  const links = extractLinks('이 페이지도 봐줘 https://example.com/a', ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(links, ['https://example.com/a', 'https://example.com/b']);

  const block = attachmentBlock(
    [
      { kind: 'image', name: 'IMG_1.jpg', file: 'agent-1/1.jpg', view: 'agent-1/1-view.jpg', width: 4032, height: 3024 },
      { kind: 'video', name: 'clip.mp4', file: 'agent-1/2.mp4', frames: ['agent-1/2-f1.jpg', 'agent-1/2-f2.jpg'], duration: 12, width: 1920, height: 1080 },
    ],
    links,
  );
  assert.match(block, /\[첨부 파일\]/);
  assert.match(block, /사진 1: .*1-view\.jpg \(원본 IMG_1\.jpg, 4032×3024\)/);
  assert.match(block, /동영상 1: .*2\.mp4 \(12초, 1920×1080\) · 장면 사진 2장:/);
  assert.match(block, /Read 도구로 열어/);
  assert.match(block, /\[참고 링크\]/);
  assert.match(block, /https:\/\/example\.com\/a/);
  assert.match(block, /WebFetch 도구로/);
});

test('a video with no scene frames tells the model it cannot see the content', () => {
  const block = attachmentBlock([{ kind: 'video', name: 'clip.mp4', file: 'agent-1/2.mp4' }], []);
  assert.match(block, /장면 사진 없음\(모델이 내용을 볼 수 없음\)/);
});

test('loadUpload rejects malformed or unknown attachment ids', () => {
  assert.equal(loadUpload(1, '../../../etc/passwd'), null);
  assert.equal(loadUpload(1, '1234-abcxyz'), null); // well-formed id, but no sidecar exists on disk
  assert.equal(typeof UPLOAD_DIR, 'string');
});

test('Claude usage normalizer reads token counts and prefers summed modelUsage cost', () => {
  const withModelUsage = normalizeClaudeUsage({
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
    modelUsage: { 'claude-sonnet-5': { costUSD: 0.01 }, 'claude-haiku-4-5': { costUSD: 0.002 } },
    total_cost_usd: 999, // should be ignored when modelUsage costs sum to something positive
  });
  assert.deepEqual(withModelUsage, { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, cost: 0.012 });

  const fallsBackToTotal = normalizeClaudeUsage({ usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.003 });
  assert.equal(fallsBackToTotal.cost, 0.003);

  const noUsage = normalizeClaudeUsage({});
  assert.deepEqual(noUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
});

test('Codex usage normalizer splits cached tokens out of input and never reports a cost', () => {
  assert.deepEqual(normalizeCodexUsage({ input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 }),
    { input: 100, output: 40, cacheRead: 20, cacheWrite: 0, cost: null });
  assert.deepEqual(normalizeCodexUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
});

test('estimateCost prices known models and returns null for unpriced ones', () => {
  const haikuCost = estimateCost('claude-haiku-4-5', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(haikuCost, 0.006); // $1/1M in + $5/1M out
  assert.equal(estimateCost('gpt-4o', { input: 1000, output: 1000 }), null);
  assert.equal(estimateCost('haiku', { input: 1000, output: 0 }), 0.001); // alias resolves to its priced version
});

test('summarizeRun rolls up stages and compares against a single-model baseline', () => {
  const stages = [
    { stage: 'triage', provider: 'claude', model: 'claude-haiku-4-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: null },
    { stage: 'plan', provider: 'claude', model: 'claude-fable-5-1', input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, cost: null },
    { stage: 'exec', provider: 'claude', model: 'claude-sonnet-5', input: 3000, output: 800, cacheRead: 0, cacheWrite: 0, cost: null },
  ];
  const summary = summarizeRun(stages, 'claude-fable-5-1');
  assert.equal(summary.total.tokens, 1100 + 2500 + 3800);
  assert.ok(summary.total.cost > 0);
  assert.ok(summary.baseline.cost > summary.total.cost); // an all-Fable run would have cost more
  assert.ok(summary.savedPct > 0 && summary.savedPct < 100);
  assert.ok(summary.stages.every((s) => s.cost != null && s.costEstimated === true));

  const manual = summarizeRun([{ stage: 'manual', provider: 'claude', model: 'claude-sonnet-5', input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: null }], null);
  assert.equal(manual.baseline, null);
  assert.equal(manual.savedPct, null);
});

test('usageHeadline separates fresh tokens, cache writes, and cache reads', () => {
  const withCacheWrite = summarizeRun(
    [{ stage: 'exec', provider: 'claude', model: 'claude-sonnet-5', input: 1000, output: 200, cacheRead: 5000, cacheWrite: 3000, cost: null }],
    null,
  );
  const headline = usageHeadline(withCacheWrite);
  assert.match(headline, /새 토큰 1\.2k/); // input + output only, cache write excluded
  assert.match(headline, /캐시 저장 3k/);
  assert.match(headline, /다시 읽기 5k/);

  const noCacheWrite = summarizeRun(
    [{ stage: 'exec', provider: 'claude', model: 'claude-sonnet-5', input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: null }],
    null,
  );
  assert.doesNotMatch(usageHeadline(noCacheWrite), /캐시 저장/);
});

test('recentByRole counts only matching-role messages toward the limit, unlike forAgent', () => {
  const workspace = Workspaces.create('recent-by-role-test', process.cwd() + '/recent-by-role-fixture');
  const agent = Agents.create(workspace.id, 'claude', 'recent-by-role agent');
  Messages.add(agent.id, 'user', '요청 1');
  for (let i = 0; i < 5; i += 1) Messages.add(agent.id, 'tool', `도구 호출 ${i}`);
  Messages.add(agent.id, 'assistant', '응답 1');

  const onlyConvo = Messages.recentByRole(agent.id, ['user', 'assistant', 'plan', 'handoff'], 2);
  assert.deepEqual(onlyConvo.map((m) => m.content), ['요청 1', '응답 1']);

  const mixedLastTwo = Messages.forAgent(agent.id, 2);
  assert.ok(mixedLastTwo.every((m) => m.role === 'tool' || m.role === 'assistant'));
});

test('clipForTriage keeps short requests intact and trims long ones from the middle', () => {
  assert.equal(clipForTriage('짧은 요청'), '짧은 요청');
  const long = 'a'.repeat(5000);
  const clipped = clipForTriage(long, 3000);
  assert.ok(clipped.length < long.length);
  assert.match(clipped, /… \(중략\) …/);
  assert.ok(clipped.startsWith('a'));
  assert.ok(clipped.endsWith('a'));
});

test('agent token usage rolls up per day and lifetime from stored usage messages', () => {
  const workspace = Workspaces.create('usage-test', process.cwd() + '/usage-test-fixture');
  const agent = Agents.create(workspace.id, 'claude', 'usage agent');
  const summaryPayload = summarizeRun(
    [{ stage: 'exec', provider: 'claude', model: 'claude-sonnet-5', input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: null }],
    null,
  );
  Messages.add(agent.id, 'usage', 'headline', summaryPayload);
  const rollup = Messages.usageSummary(agent.id);
  assert.equal(rollup.today.runs, 1);
  assert.equal(rollup.all.runs, 1);
  assert.equal(rollup.today.tokens, 1200);
  assert.ok(rollup.today.cost > 0);
});

test('usageSummary rolls up "fresh" (new tokens + cache writes) and cache reads separately', () => {
  const workspace = Workspaces.create('usage-fresh-test', process.cwd() + '/usage-fresh-fixture');
  const agent = Agents.create(workspace.id, 'claude', 'usage fresh agent');
  const run1 = summarizeRun(
    [{ stage: 'exec', provider: 'claude', model: 'claude-sonnet-5', input: 1000, output: 200, cacheRead: 500, cacheWrite: 300, cost: null }],
    null,
  );
  const run2 = summarizeRun(
    [{ stage: 'exec', provider: 'claude', model: 'claude-sonnet-5', input: 2000, output: 400, cacheRead: 1500, cacheWrite: 0, cost: null }],
    null,
  );
  Messages.add(agent.id, 'usage', 'headline', run1);
  Messages.add(agent.id, 'usage', 'headline', run2);
  const rollup = Messages.usageSummary(agent.id);
  assert.equal(rollup.today.runs, 2);
  assert.equal(rollup.today.fresh, (1000 + 200 + 300) + (2000 + 400 + 0));
  assert.equal(rollup.today.cache_read, 500 + 1500);
});

test('plan and review turns skip global MCP config/skills and get a spend cap; normal turns only skip global MCP config', () => {
  const base = { permission_mode: 'ask', session_id: null, model: null, effort: null };
  const planArgs = buildClaudeArgs(base, 'agent.json', { stage: 'plan', budgetUsd: 2 });
  assert.ok(planArgs.includes('--strict-mcp-config'));
  assert.ok(planArgs.includes('--disable-slash-commands'));
  assert.deepEqual(planArgs.slice(planArgs.indexOf('--max-budget-usd')), ['--max-budget-usd', '2']);

  const reviewArgs = buildClaudeArgs(base, 'agent.json', { phase: 'review' });
  assert.ok(reviewArgs.includes('--disable-slash-commands'));
  assert.ok(!reviewArgs.includes('--max-budget-usd')); // no budgetUsd passed

  const execArgs = buildClaudeArgs(base, 'agent.json', { stage: 'exec' });
  assert.ok(execArgs.includes('--strict-mcp-config'));
  assert.ok(!execArgs.includes('--disable-slash-commands'));
  assert.ok(!execArgs.includes('--max-budget-usd'));
});

test('the phone-tone system prompt only rides on turns the owner reads, not plan/review turns', () => {
  const base = { permission_mode: 'ask', session_id: null, model: null, effort: null };
  assert.ok(!buildClaudeArgs(base, 'agent.json', { stage: 'plan' }).includes('--append-system-prompt'));
  assert.ok(!buildClaudeArgs(base, 'agent.json', { phase: 'review' }).includes('--append-system-prompt'));
  const execArgs = buildClaudeArgs(base, 'agent.json', { stage: 'exec' });
  assert.equal(execArgs[execArgs.indexOf('--append-system-prompt') + 1], PHONE_STYLE_PROMPT);
  const manualArgs = buildClaudeArgs(base, 'agent.json', {});
  assert.equal(manualArgs[manualArgs.indexOf('--append-system-prompt') + 1], PHONE_STYLE_PROMPT);
});

test('compactAfterTokens migration: v2-capped installs rise to 150k, 0 (off) and a lower custom value stay put', () => {
  const configPath = process.env.AGENT_REMOTE_CONFIG;
  const write = (fields) => fs.writeFileSync(configPath, JSON.stringify(fields));

  write({ tokenOptimizationVersion: 1, compactAfterTokens: 100_000 });
  assert.equal(loadConfig().compactAfterTokens, 150_000, 'v1 → v2 cap → v3 triple');

  write({ tokenOptimizationVersion: 2, compactAfterTokens: 50_000 });
  assert.equal(loadConfig().compactAfterTokens, 150_000);

  write({ tokenOptimizationVersion: 2, compactAfterTokens: 0 });
  assert.equal(loadConfig().compactAfterTokens, 0);

  write({ tokenOptimizationVersion: 2, compactAfterTokens: 30_000 });
  assert.equal(loadConfig().compactAfterTokens, 30_000);

  write({ tokenOptimizationVersion: 3, compactAfterTokens: 50_000 });
  assert.equal(loadConfig().compactAfterTokens, 50_000, 'already on v3: an explicit 50k is a choice');

  fs.rmSync(configPath, { force: true });
  const fresh = loadConfig();
  assert.equal(fresh.compactAfterTokens, 150_000);
  assert.equal(fresh.tokenOptimizationVersion, 3);
  assert.equal(fresh.planBudgetUsd, 0);
  assert.deepEqual([fresh.runAlertUsd, fresh.runStopUsd, fresh.loopRepeatLimit], [10, 30, 8]);
  assert.deepEqual([fresh.approvalRemindMin, fresh.approvalAutoMin], [10, 20]);

  fs.rmSync(configPath, { force: true });
});

// ---------- skills (/이름 slash commands) ----------
function mkSkillWorkspace() {
  const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-ws-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-user-'));
  process.env.CLAUDE_CONFIG_DIR = userDir;
  return { wsPath, userDir };
}
function writeSkillFile(dir, name, frontmatter, body) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${frontmatter}\n\n${body}`);
  return skillDir;
}

test('parseFrontmatter reads quoted/unquoted values, strips BOM+CRLF, and falls back with no frontmatter', () => {
  const withQuotes = parseFrontmatter('---\r\nname: "my-skill"\r\ndescription: \'quoted desc\'\r\nargument-hint: <text>\r\n---\r\nBody text\r\nmore.');
  assert.equal(withQuotes.fields.name, 'my-skill');
  assert.equal(withQuotes.fields.description, 'quoted desc');
  assert.equal(withQuotes.fields['argument-hint'], '<text>');
  assert.equal(withQuotes.body, 'Body text\nmore.');

  const bom = parseFrontmatter('\uFEFF---\nname: bommed\n---\nhello');
  assert.equal(bom.fields.name, 'bommed');
  assert.equal(bom.body, 'hello');

  const missing = parseFrontmatter('no frontmatter here');
  assert.deepEqual(missing.fields, {});
  assert.equal(missing.body, 'no frontmatter here');
});

test('listSkills prefers project scope over user scope and skips non-invocable/malformed entries', () => {
  const { wsPath, userDir } = mkSkillWorkspace();
  try {
    const userSkills = path.join(userDir, 'skills');
    const projectSkills = path.join(wsPath, '.claude', 'skills');
    writeSkillFile(userSkills, 'shared', '---\nname: shared\ndescription: user version\n---', 'user body');
    writeSkillFile(projectSkills, 'shared', '---\nname: shared\ndescription: project version\n---', 'project body');
    writeSkillFile(userSkills, 'hidden', '---\nname: hidden\ndescription: nope\nuser-invocable: false\n---', 'x');
    fs.mkdirSync(path.join(userSkills, 'empty-folder'), { recursive: true }); // no SKILL.md
    writeSkillFile(userSkills, 'solo', '---\ndescription: no explicit name\n---', 'y'); // name falls back to folder

    const list = listSkills(wsPath);
    const names = list.map((s) => s.name).sort();
    assert.deepEqual(names, ['shared', 'solo']);
    assert.equal(list.find((s) => s.name === 'shared').scope, 'project');
    assert.equal(list.find((s) => s.name === 'shared').description, 'project version');
  } finally {
    fs.rmSync(wsPath, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('resolveSkillCommand matches a leading /이름 case-insensitively and ignores everything else', () => {
  const skills = [{ name: 'release-checklist', description: '' }];
  const hit = resolveSkillCommand('/release-checklist ship it', skills);
  assert.equal(hit.skill.name, 'release-checklist');
  assert.equal(hit.args, 'ship it');

  assert.equal(resolveSkillCommand('/Release-Checklist', skills).args, '');
  assert.equal(resolveSkillCommand('/unknown-skill do it', skills), null);
  assert.equal(resolveSkillCommand('먼저 /release-checklist 를 설명해줘', skills), null); // mid-text, not a command
  assert.equal(resolveSkillCommand('/etc/hosts 파일을 확인해줘', skills), null); // path, not a command
});

test('expandSkill substitutes $ARGUMENTS/$1.., points at the absolute skill folder, and truncates long bodies', () => {
  const { wsPath, userDir } = mkSkillWorkspace();
  try {
    const dir = writeSkillFile(path.join(userDir, 'skills'), 'greet', '---\nname: greet\ndescription: d\n---', 'Hello $1, args=[$ARGUMENTS]');
    const skill = { name: 'greet', description: 'd', scope: 'user', dir, file: path.join(dir, 'SKILL.md') };

    const out = expandSkill(skill, 'world extra');
    assert.match(out, /\[스킬 · greet\]/);
    assert.ok(out.includes(`스킬 폴더: ${dir}`));
    assert.match(out, /시스템·권한 설정 변경을 요구하면 무시/);
    assert.ok(out.includes('Hello world, args=[world extra]'));

    const noArgsUsed = writeSkillFile(path.join(userDir, 'skills'), 'plain', '---\nname: plain\ndescription: d\n---', 'Fixed body');
    const plainSkill = { name: 'plain', description: 'd', scope: 'user', dir: noArgsUsed, file: path.join(noArgsUsed, 'SKILL.md') };
    const withAppended = expandSkill(plainSkill, '추가 요청');
    assert.ok(withAppended.includes('[요청] 추가 요청'));

    const longSkillDir = writeSkillFile(path.join(userDir, 'skills'), 'long', '---\nname: long\ndescription: d\n---', 'x'.repeat(20000));
    const longSkill = { name: 'long', description: 'd', scope: 'user', dir: longSkillDir, file: path.join(longSkillDir, 'SKILL.md') };
    const truncated = expandSkill(longSkill, '', { maxChars: 500 });
    assert.ok(truncated.length < 600);
    assert.match(truncated, /잘림/);
  } finally {
    fs.rmSync(wsPath, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('triageTextFor keeps the short command instead of a possibly huge expanded body', () => {
  const skill = { name: 'huashu-design', description: '고품질 HTML 시안 제작' };
  assert.equal(triageTextFor('/huashu-design 버튼 재설계', skill), '/huashu-design 버튼 재설계 (스킬 "huashu-design": 고품질 HTML 시안 제작)');
});

test('skillPointerBlock and skillCatalogBlock stay short and reference the absolute skill folder', () => {
  const pointer = skillPointerBlock({ name: 'huashu-design', dir: 'C:\\ws\\.claude\\skills\\huashu-design' });
  assert.equal(pointer.split('\n').filter(Boolean).length, 3);
  assert.ok(pointer.includes('C:\\ws\\.claude\\skills\\huashu-design'));

  assert.equal(skillCatalogBlock([]), '');
  const catalog = skillCatalogBlock([{ name: 'a', description: 'd1' }, { name: 'b', description: 'd2' }]);
  assert.ok(catalog.includes('/a: d1'));
  assert.ok(catalog.includes('/b: d2'));
});

test('validateSkillName accepts lowercase-digits-hyphen only', () => {
  assert.ok(validateSkillName('release-checklist'));
  assert.ok(validateSkillName('a1'));
  assert.ok(!validateSkillName('Release'));
  assert.ok(!validateSkillName('-leading'));
  assert.ok(!validateSkillName('has space'));
  assert.ok(!validateSkillName(''));
});

test('writeSkill preserves existing frontmatter keys (e.g. allowed-tools) across an edit, and deleteSkill refuses bad input', () => {
  const { wsPath, userDir } = mkSkillWorkspace();
  try {
    const first = writeSkill({ wsPath, scope: 'project', name: 'my-tool', description: '첫 설명', body: '첫 본문' });
    const projectDir = path.join(wsPath, '.claude', 'skills', 'my-tool');
    assert.equal(first.dir, projectDir);
    // Simulate a hand-edited allowed-tools key that the UI doesn't expose.
    const raw1 = fs.readFileSync(path.join(projectDir, 'SKILL.md'), 'utf8');
    fs.writeFileSync(path.join(projectDir, 'SKILL.md'), raw1.replace('---\n\n첫 본문', 'allowed-tools: Bash, Read\n---\n\n첫 본문'));

    writeSkill({ wsPath, scope: 'project', name: 'my-tool', description: '두번째 설명', body: '두번째 본문' });
    const raw2 = fs.readFileSync(path.join(projectDir, 'SKILL.md'), 'utf8');
    const parsed = parseFrontmatter(raw2);
    assert.equal(parsed.fields['allowed-tools'], 'Bash, Read');
    assert.equal(parsed.fields.description, '두번째 설명');
    assert.equal(parsed.body, '두번째 본문\n');
    assert.ok(!raw2.startsWith('\uFEFF'));
    assert.ok(!raw2.includes('\r\n'));

    assert.throws(() => writeSkill({ wsPath, scope: 'project', name: 'Bad Name', description: 'd', body: 'b' }));
    assert.throws(() => deleteSkill({ wsPath, scope: 'project', name: '../../etc' }));
    assert.throws(() => deleteSkill({ wsPath, scope: 'project', name: 'never-created' }));

    deleteSkill({ wsPath, scope: 'project', name: 'my-tool' });
    assert.ok(!fs.existsSync(projectDir));
  } finally {
    fs.rmSync(wsPath, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('listImportableSkills groups other workspaces\' project skills, excluding the current workspace and user scope', () => {
  const { wsPath: wsA, userDir } = mkSkillWorkspace();
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-ws-'));
  const wsC = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-ws-'));
  try {
    writeSkillFile(path.join(userDir, 'skills'), 'user-only', '---\nname: user-only\ndescription: d\n---', 'b');
    writeSkillFile(path.join(wsA, '.claude', 'skills'), 'current-proj', '---\nname: current-proj\ndescription: d\n---', 'b');
    writeSkillFile(path.join(wsB, '.claude', 'skills'), 'from-b-1', '---\nname: from-b-1\ndescription: d1\n---', 'b1');
    writeSkillFile(path.join(wsB, '.claude', 'skills'), 'from-b-2', '---\nname: from-b-2\ndescription: d2\n---', 'b2');

    const workspaces = [
      { id: 1, name: 'A (current)', path: wsA },
      { id: 2, name: 'B', path: wsB },
      { id: 3, name: 'C (empty)', path: wsC },
    ];
    const groups = listImportableSkills(wsA, workspaces);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].workspaceId, 2);
    assert.deepEqual(groups[0].skills.map((s) => s.name).sort(), ['from-b-1', 'from-b-2']);
  } finally {
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
    fs.rmSync(wsC, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('copySkill copies nested files, requires overwrite for name clashes, supports move, and rejects bad names', () => {
  const { wsPath: wsA, userDir } = mkSkillWorkspace();
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-ws-'));
  try {
    const srcDir = writeSkillFile(path.join(wsB, '.claude', 'skills'), 'my-tool', '---\nname: my-tool\ndescription: d\n---', 'body');
    fs.mkdirSync(path.join(srcDir, 'scripts'));
    fs.writeFileSync(path.join(srcDir, 'scripts', 'run.js'), 'console.log(1)');

    const saved = copySkill({ srcDir, wsPath: wsA, scope: 'project', name: 'my-tool' });
    const destDir = path.join(wsA, '.claude', 'skills', 'my-tool');
    assert.equal(saved.dir, destDir);
    assert.ok(fs.existsSync(path.join(destDir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(destDir, 'scripts', 'run.js')));
    assert.ok(fs.existsSync(srcDir)); // copy, not move: source untouched

    assert.throws(() => copySkill({ srcDir, wsPath: wsA, scope: 'project', name: 'my-tool' }), (e) => e.code === 'EXISTS');
    copySkill({ srcDir, wsPath: wsA, scope: 'project', name: 'my-tool', overwrite: true }); // succeeds with overwrite

    const moveSrcDir = writeSkillFile(path.join(wsB, '.claude', 'skills'), 'to-move', '---\nname: to-move\ndescription: d\n---', 'body');
    copySkill({ srcDir: moveSrcDir, wsPath: wsA, scope: 'user', name: 'to-move', move: true });
    assert.ok(fs.existsSync(path.join(userDir, 'skills', 'to-move', 'SKILL.md')));
    assert.ok(!fs.existsSync(moveSrcDir));

    assert.throws(() => copySkill({ srcDir, wsPath: wsA, scope: 'project', name: '../evil' }));
  } finally {
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('agent menu button lives in the topbar and the sheet keeps all six actions', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const topbar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(topbar, /id="btn-agent-menu"/);
  const menu = html.slice(html.indexOf('id="dlg-agent-menu"'), html.indexOf('</dialog>', html.indexOf('id="dlg-agent-menu"')));
  for (const act of ['rename', 'skills', 'compact', 'reset', 'clear', 'delete']) {
    assert.match(menu, new RegExp(`data-act="${act}"`), `missing data-act="${act}" in agent menu`);
  }
});

// ---------- 예약 실행 · 오늘 한 일 · 승인 묶음 · 되돌리기 ----------
const { describeDays, lastDue, nextDue, normalizeDays, isValidTime, tick: schedulerTick } = await import('../server/scheduler.js');
const { buildDigest, digestPushText, dayBounds } = await import('../server/digest.js');
const { Approvals, SavedPrompts, Schedules, Snapshots, dailyActivity, dailyTotals } = await import('../server/db.js');
const { periodBounds } = await import('../server/digest.js');
const rawDb = (await import('../server/db.js')).default;
const { backupIfDue, backupStatus, listBackups, runBackup } = await import('../server/backup.js');
const { requestApproval, resolveApproval, setBlanketAllow, blanketAllow } = await import('../server/approvals.js');
const { snapshotTree, treeChanges, restoreTree } = await import('../server/git.js');
const { execFileSync } = await import('node:child_process');

test('schedule times: due within the grace window, next occurrence honours weekdays, day lists normalize', () => {
  const at = (s) => new Date(s).getTime();
  assert.equal(lastDue('09:00', '', at('2026-09-17T09:05:00')), at('2026-09-17T09:00:00'));
  assert.equal(lastDue('09:00', '', at('2026-09-17T09:20:00')), null);           // past the 15-minute grace
  assert.equal(lastDue('23:50', '', at('2026-09-18T00:02:00')), at('2026-09-17T23:50:00')); // yesterday still counts
  assert.equal(lastDue('09:00', '1,2,3,4,5', at('2026-09-19T09:03:00')), null);   // Saturday, weekdays only
  assert.equal(nextDue('09:00', '1,2,3,4,5', at('2026-09-19T10:00:00')), at('2026-09-21T09:00:00'));
  assert.equal(nextDue('09:00', '', at('2026-09-17T08:00:00')), at('2026-09-17T09:00:00'));
  assert.equal(normalizeDays([0, 1, 2, 3, 4, 5, 6]), '');
  assert.equal(normalizeDays('5,1,9,x'), '1,5');
  assert.equal(describeDays(''), '매일');
  assert.equal(describeDays('1,2,3,4,5'), '평일');
  assert.equal(describeDays('0,6'), '주말');
  assert.equal(describeDays('2,4'), '화·목');
  assert.ok(isValidTime('07:30') && !isValidTime('24:00') && !isValidTime('9:30'));
});

test('scheduler fires a due schedule once and retries a busy agent inside the grace window', () => {
  const ws = Workspaces.create('sched-ws', path.join(os.tmpdir(), `sched-ws-${process.pid}`));
  const agent = Agents.create(ws.id, 'claude', '예약봇');
  const s = Schedules.create(agent.id, '점검해줘', '09:00', '');
  Agents.update(agent.id, { status: 'working' });
  schedulerTick({}, new Date('2026-09-17T09:01:00').getTime());
  assert.equal(Schedules.get(s.id).last_run_at, null, 'busy agent: not fired yet');
  Agents.update(agent.id, { status: 'idle' });
  // startPrompt fails here (no workspace folder / CLI) but the slot still counts as attempted
  schedulerTick({}, new Date('2026-09-17T09:02:00').getTime());
  assert.ok(Schedules.get(s.id).last_run_at, 'fired once the agent was free');
  const firedAt = Schedules.get(s.id).last_run_at;
  schedulerTick({}, new Date('2026-09-17T09:03:00').getTime());
  assert.equal(Schedules.get(s.id).last_run_at, firedAt, 'not fired twice for the same slot');
  Schedules.remove(s.id);
  Workspaces.remove(ws.id);
});

test('daily digest rolls up per-agent requests, files and cost for the local day', () => {
  const ws = Workspaces.create('digest-ws', path.join(os.tmpdir(), `digest-ws-${process.pid}`));
  const a = Agents.create(ws.id, 'claude', '요약봇');
  const b = Agents.create(ws.id, 'codex', '조용한봇');
  Messages.add(a.id, 'user', '첫 지시');
  Messages.add(a.id, 'user', '둘째 지시');
  Messages.add(a.id, 'assistant', '네, 처리했습니다.  이제 됩니다.');
  Messages.add(a.id, 'usage', 'x', { total: { tokens: 1000, fresh: 800, cacheRead: 200, cost: 0.5 } });
  Snapshots.finish(Snapshots.create(a.id, 'aaaa').id, 'bbbb', 3);
  // Earlier tests leave their own agents with today's messages behind, so single out ours.
  const all = buildDigest();
  const mine = all.agents.find((r) => r.id === a.id);
  assert.ok(mine, 'active agent is listed');
  assert.ok(!all.agents.some((r) => r.id === b.id), 'agent with no activity is left out');
  assert.equal(mine.requests, 2);
  assert.equal(mine.files, 3);
  assert.equal(mine.fresh, 800);
  assert.equal(mine.cost, 0.5);
  assert.equal(mine.last_reply, '네, 처리했습니다. 이제 됩니다.');
  const d = { ...all, agents: [mine], totals: { requests: 2, errors: 0, files: 3, fresh: 800, cost: 0.5 } };
  const push = digestPushText(d);
  assert.match(push.title, /에이전트 1개/);
  assert.match(push.body, /지시 2건 · 파일 3개 수정/);
  assert.ok(push.body.length <= 180);
  assert.equal(digestPushText({ agents: [], totals: { requests: 0 } }).body, '오늘은 지시한 작업이 없었습니다.');
  const old = dayBounds('2000-01-01');
  assert.equal(dailyActivity(old.since, old.until).length, 0);
  assert.throws(() => dayBounds('nope'));
  Agents.remove(a.id); Agents.remove(b.id); Workspaces.remove(ws.id);
});

test('blanket approval: allowing "for this run" auto-allows later tool requests but never questions', async () => {
  const ws = Workspaces.create('blanket-ws', path.join(os.tmpdir(), `blanket-ws-${process.pid}`));
  const agent = Agents.create(ws.id, 'claude', '승인봇');
  const first = requestApproval(agent.id, 'Bash', { command: 'npm test' });
  const second = requestApproval(agent.id, 'Edit', { file_path: 'a.js' });
  resolveApproval(first.approval.id, 'allow', { scope: 'run' });
  assert.ok(blanketAllow(agent.id), 'blanket switched on');
  assert.equal((await second.promise).behavior, 'allow', 'other pending request resolved too');
  const third = requestApproval(agent.id, 'Write', { file_path: 'b.js' });
  assert.equal((await third.promise).behavior, 'allow');
  assert.equal(Approvals.get(third.approval.id).message, 'blanket');
  const q = requestApproval(agent.id, 'AskUserQuestion', { questions: [{ question: '어느 쪽?' }] });
  assert.equal(Approvals.get(q.approval.id).status, 'pending', 'questions still wait for the owner');
  resolveApproval(q.approval.id, 'deny');
  setBlanketAllow(agent.id, false);
  const fourth = requestApproval(agent.id, 'Bash', { command: 'ls' });
  assert.equal(Approvals.get(fourth.approval.id).status, 'pending', 'asks again once switched off');
  resolveApproval(fourth.approval.id, 'deny');
  Agents.remove(agent.id); Workspaces.remove(ws.id);
});

test('guard: edits and mutating commands outside the workspace are flagged, reads and in-folder work are not', () => {
  const ws = 'C:/Users/leebe/Desktop/leebeegle_SmartAgent';
  const risk = (tool, input) => !!outsideRisk(tool, input, ws);
  assert.equal(risk('Edit', { file_path: 'server/a.js' }), false);
  assert.equal(risk('Edit', { file_path: String.raw`C:\Users\leebe\Desktop\leebeegle_SmartAgent\server\a.js` }), false);
  assert.equal(risk('Write', { file_path: 'C:/Users/leebe/Desktop/other/x.txt' }), true);
  assert.equal(risk('Write', { file_path: '../other/x.txt' }), true);
  assert.equal(risk('Read', { file_path: 'C:/Windows/x' }), false, 'reading outside is fine');
  assert.equal(risk('Bash', { command: 'cat C:/Users/leebe/Desktop/other/x.txt 2>/dev/null' }), false);
  assert.equal(risk('Bash', { command: 'ls C:/Users/leebe/Desktop 2>&1' }), false);
  assert.equal(risk('Bash', { command: 'claude -p --output-format json' }), false);
  assert.equal(risk('Bash', { command: 'rm -rf node_modules' }), false, 'inside: the snapshot can undo it');
  assert.equal(risk('Bash', { command: 'echo hi > notes.txt' }), false);
  assert.equal(risk('Bash', { command: 'mv data/x C:/Users/leebe/Desktop/leebeegle_SmartAgent/data/y' }), false);
  assert.equal(risk('Bash', { command: 'git reset --hard HEAD~1' }), false);
  assert.equal(risk('Bash', { command: 'rm -rf C:/Users/leebe/Desktop/other' }), true);
  assert.equal(risk('Bash', { command: String.raw`Remove-Item -Recurse "C:\Users\leebe\Desktop\old"` }), true);
  assert.equal(risk('Bash', { command: 'echo hi > ~/notes.txt' }), true);
  assert.equal(risk('Bash', { command: 'cp -r public /c/Users/leebe/Desktop/backup' }), true);
  assert.equal(risk('Bash', { command: 'cp -r public /c/Users/leebe/Desktop/leebeegle_SmartAgent/backup' }), false, 'git-bash style path inside');
  assert.equal(risk('Bash', { command: 'cd .. && rm -rf foo' }), true);
  assert.equal(risk('Bash', { command: 'shutdown /s' }), true);
});

test('guard: outside-the-workspace requests skip blanket approval, are marked, and stay out of bulk allows', async () => {
  const wsPath = path.join(os.tmpdir(), `guard-ws-${process.pid}`);
  const ws = Workspaces.create('guard-ws', wsPath);
  const agent = Agents.create(ws.id, 'claude', '안전봇');
  setBlanketAllow(agent.id, true);
  const inside = requestApproval(agent.id, 'Write', { file_path: path.join(wsPath, 'a.txt') });
  assert.equal((await inside.promise).behavior, 'allow', 'inside: blanket applies');
  const outside = requestApproval(agent.id, 'Write', { file_path: path.join(os.tmpdir(), 'elsewhere.txt') });
  assert.equal(Approvals.get(outside.approval.id).status, 'pending', 'outside: still asks the owner');
  assert.equal(Approvals.get(outside.approval.id).risk, 'outside');
  const hooked = requestApproval(agent.id, 'Bash', { command: 'npm test' }, { risk: 'outside' });
  assert.equal(Approvals.get(hooked.approval.id).risk, 'outside', 'the hook may flag a request itself');
  setBlanketAllow(agent.id, false);
  const plain = requestApproval(agent.id, 'Bash', { command: 'npm test' });
  resolveApproval(plain.approval.id, 'allow', { scope: 'run' });
  assert.equal(Approvals.get(outside.approval.id).status, 'pending', '"allow for this run" leaves outside requests alone');
  assert.equal(Approvals.get(hooked.approval.id).status, 'pending');
  resolveApproval(outside.approval.id, 'deny');
  resolveApproval(hooked.approval.id, 'allow');
  assert.equal((await hooked.promise).behavior, 'allow');
  setBlanketAllow(agent.id, false);
  Agents.remove(agent.id); Workspaces.remove(ws.id);
});

test('guard hook: passes silently inside the workspace, blocks outside when the server is unreachable', () => {
  const hook = fileURLToPath(new URL('../server/guard-hook.js', import.meta.url));
  const wsPath = path.join(os.tmpdir(), `hook-ws-${process.pid}`);
  const run = (payload, env = {}) => execFileSync(process.execPath, [hook], {
    input: JSON.stringify(payload), env: { ...process.env, APPROVER_WORKSPACE: wsPath, APPROVER_URL: '', APPROVER_TOKEN: '', APPROVER_AGENT_ID: '', ...env }, stdio: 'pipe',
  }).toString();
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: path.join(wsPath, 'x.js') } }), '', 'no output → Claude Code decides as usual');
  const out = JSON.parse(run({ tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'outside.txt') } }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /작업 폴더 밖/);
  const settings = guardSettings();
  assert.match(settings.hooks.PreToolUse[0].matcher, /Bash/);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /guard-hook\.js/);
  const args = buildClaudeArgs({ permission_mode: 'auto', session_id: null }, 'mcp.json', { settingsPath: 's.json' });
  assert.equal(args[args.indexOf('--settings') + 1], 's.json');
  const planArgs = buildClaudeArgs({ permission_mode: 'auto', session_id: null }, 'mcp.json', { settingsPath: 's.json', stage: 'plan' });
  assert.equal(planArgs.includes('--settings'), false, 'plan turns cannot edit, so no hook');
});

test('run watchdog: alerts once past the alert line, keeps going, stops past the stop line', () => {
  const w = createRunWatch({ alertUsd: 10, stopUsd: 30, loopRepeat: 8 });
  // Opus 5: $5/M input → 1M fresh input tokens ≈ $5 per message
  const msg = (id) => ({ msgId: id, model: 'claude-opus-5', usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [] });
  assert.equal(w.feed(msg('m1')), null);
  assert.equal(w.feed(msg('m1')), null, 'same message id is not counted twice');
  assert.equal(w.feed(msg('m2')).kind, 'alert', 'crossing $10 alerts');
  assert.equal(w.feed(msg('m3')), null, 'alert fires once, work continues');
  w.feed(msg('m4')); w.feed(msg('m5'));
  const stop = w.feed(msg('m6'));
  assert.equal(stop.kind, 'stop'); assert.equal(stop.reason, 'budget');
  assert.equal(w.feed(msg('m7')), null, 'nothing more after a stop');
  assert.match(describeVerdict(stop, { stopUsd: 30 }), /\$30\.00.*멈췄습니다.*계속해줘/);
});

test('run watchdog: the same tool call repeated too often stops the run, varied calls do not', () => {
  const w = createRunWatch({ alertUsd: 0, stopUsd: 0, loopRepeat: 3 });
  const call = (cmd) => ({ msgId: `t${Math.random()}`, model: 'claude-sonnet-5', usage: null, tools: [{ name: 'Bash', input: { command: cmd } }] });
  assert.equal(w.feed(call('npm test')), null);
  assert.equal(w.feed(call('npm run build')), null);
  assert.equal(w.feed(call('npm test')), null);
  const stop = w.feed(call('npm test'));
  assert.equal(stop?.reason, 'loop'); assert.equal(stop.repeats, 3); assert.equal(stop.tool, 'Bash');
  assert.match(describeVerdict(stop, { stopUsd: 30 }), /같은 시도\(Bash\)를 3번/);
  const off = createRunWatch({ alertUsd: 0, stopUsd: 0, loopRepeat: 0 });
  for (let i = 0; i < 20; i++) assert.equal(off.feed(call('x')), null, '0 = off');
  assert.deepEqual(watchLimits({ runAlertUsd: 0, runStopUsd: 50 }), { alertUsd: 0, stopUsd: 50, loopRepeat: 8 });
  assert.deepEqual(watchLimits({}), { alertUsd: 10, stopUsd: 30, loopRepeat: 8 });
});

test('prompt queue: a busy agent parks prompts in order, they can be removed, and the view counts them', () => {
  const ws = Workspaces.create('queue-ws', path.join(os.tmpdir(), `queue-ws-${process.pid}`));
  const agent = Agents.create(ws.id, 'claude', '줄서기봇');
  const first = enqueuePrompt(agent.id, '첫 번째 지시', { attachments: [], links: [] });
  const second = enqueuePrompt(agent.id, '두 번째 지시', { links: ['https://x'] });
  assert.equal(first.count, 1); assert.equal(second.count, 2);
  assert.deepEqual(queuedPrompts(agent.id).map((q) => q.text), ['첫 번째 지시', '두 번째 지시']);
  assert.throws(() => enqueuePrompt(agent.id, '   ', {}), /내용이 없습니다/);
  assert.equal(removeQueued(agent.id, first.row.id), true);
  assert.equal(removeQueued(agent.id, 999999), false);
  assert.deepEqual(queuedPrompts(agent.id).map((q) => q.text), ['두 번째 지시']);
  assert.equal(Queue.shift(agent.id).text, '두 번째 지시');
  assert.equal(Queue.shift(agent.id), null);
  Agents.remove(agent.id); Workspaces.remove(ws.id);
});

test('unattended approvals: only reads and in-folder edits count as safe; questions, outside edits and mutating shell never do', () => {
  const ws = 'C:/Users/leebe/Desktop/leebeegle_SmartAgent';
  assert.equal(isSafeWhenUnattended('Read', { file_path: 'C:/Windows/x' }, ws), true);
  assert.equal(isSafeWhenUnattended('Grep', { pattern: 'x' }, ws), true);
  assert.equal(isSafeWhenUnattended('Edit', { file_path: 'server/a.js' }, ws), true);
  assert.equal(isSafeWhenUnattended('Edit', { file_path: 'C:/Users/leebe/Desktop/other/a.js' }, ws), false);
  assert.equal(isSafeWhenUnattended('AskUserQuestion', { questions: [] }, ws), false);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'git status && git diff' }, ws), true);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'npm test' }, ws), true);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'cat a.txt | grep x' }, ws), true);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'rm -rf dist' }, ws), false);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'git status; rm x' }, ws), false);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'cat a > b' }, ws), false);
  assert.equal(isSafeWhenUnattended('Bash', { command: 'git push' }, ws), false);
  const lim = configureUnattended({ approvalRemindMin: 0, approvalAutoMin: 5 });
  assert.deepEqual(lim, { remindMin: 0, autoMin: 5 });
  assert.deepEqual(configureUnattended({}), { remindMin: 10, autoMin: 20 });
});

test('errors: plain-Korean explanations and the transient (retry-worthy) flag', () => {
  assert.equal(explainError('Error: fetch failed ECONNRESET').transient, true);
  assert.match(explainError('fetch failed').plain, /인터넷/);
  assert.equal(explainError('API Error: 529 overloaded').transient, true);
  assert.equal(explainError('You have hit your usage limit').transient, false);
  assert.match(explainError('rate limit exceeded').plain, /몰려/);
  assert.equal(explainError('종료 코드 1').transient, true);
  assert.equal(explainError('unauthorized 401').transient, false);
  assert.equal(explainError('something odd').transient, false);
  assert.equal(isTransientError({ ok: false, text: 'socket hang up' }), true);
  assert.equal(isTransientError({ ok: false, subtype: 'error_max_turns', text: 'exit 1' }), false);
  assert.equal(isTransientError({ ok: true }), false);
  assert.equal(errorMessageText('이미 작업 중입니다'), '이미 작업 중입니다', 'a short Korean line stays as is');
  assert.match(errorMessageText('Error: connect ETIMEDOUT 1.2.3.4:443'), /^인터넷 연결이 잠깐 끊겼습니다\n원문: Error: connect ETIMEDOUT/);
});

test('deliverables: media/docs among changed files are listed with size, code files are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-'));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'final.mp4'), Buffer.alloc(1500));
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'pdf');
  fs.writeFileSync(path.join(dir, 'server.js'), 'js');
  const list = deliverableFiles(dir, ['out/final.mp4', 'report.pdf', 'server.js', 'missing.png']);
  assert.deepEqual(list.map((f) => [f.path, f.name, f.size]), [['out/final.mp4', 'final.mp4', 1500], ['report.pdf', 'report.pdf', 3]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('phone UI wires the queue, deliverables, read-aloud and unattended copy', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /case 'queue\.changed'/);
  assert.match(js, /줄 세우기/);
  assert.match(js, /queued_now/);
  assert.match(js, /deliver-btn/);
  assert.match(js, /navigator\.share/);
  assert.match(js, /SpeechSynthesisUtterance/);
  assert.match(html, /id="tts-enabled"/);
  assert.match(html, /자리 비웠을 때/);
});

test('turn snapshots capture tracked + untracked files and undo restores the exact previous tree', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'init');
    const before = await snapshotTree(repo);
    assert.match(before, /^[0-9a-f]{40}$/);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'x.txt'), 'x');
    const after = await snapshotTree(repo);
    assert.notEqual(after, before);
    const changes = await treeChanges(repo, before, after);
    assert.deepEqual(changes.files.sort(), ['a.txt', 'new.txt', 'sub/x.txt']);
    assert.ok(git('status', '--porcelain').includes('?? new.txt'), 'project index untouched');
    const r = await restoreTree(repo, after, before);
    assert.equal(r.files, 3);
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
    assert.ok(!fs.existsSync(path.join(repo, 'new.txt')));
    assert.ok(!fs.existsSync(path.join(repo, 'sub', 'x.txt')));
    assert.equal(await snapshotTree(repo), before, 'tree identical to the pre-run snapshot');
    assert.equal(await snapshotTree(os.tmpdir()), null, 'outside a repo: no snapshot, no undo');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('phone UI wires the new features: allow-all button, undo card, mic, schedules, digest', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-act="schedules"/);
  assert.match(html, /id="dlg-schedules"/);
  assert.match(html, /id="dlg-digest"/);
  assert.match(html, /id="digest-time"/);
  assert.match(js, /data-allow-run/);
  assert.match(js, /scope: 'run'/);
  assert.match(js, /m\.role === 'undo'/);
  assert.match(js, /webkitSpeechRecognition/);
  assert.match(js, /case 'blanket\.changed'/);
  assert.match(js, /q\.get\('digest'\)/);
});

test('period digest: week runs Mon–Sun, month is the calendar month, days roll up per local date', () => {
  const w = periodBounds('week', '2025-03-13'); // Thursday, well before any other test's messages
  assert.equal(w.from, '2025-03-10'); assert.equal(w.to, '2025-03-16');
  const m = periodBounds('month', '2026-02-10');
  assert.equal(m.from, '2026-02-01'); assert.equal(m.to, '2026-02-28');
  assert.equal(periodBounds('bogus', '2026-09-17').period, 'day');
  const ws = Workspaces.create('period-ws', path.join(os.tmpdir(), `period-ws-${process.pid}`));
  const a = Agents.create(ws.id, 'claude', '기간봇');
  const at = (s) => new Date(s).getTime();
  // Insert with explicit timestamps through the raw DB so the days land where we expect.
  const raw = rawDb;
  const ins = raw.prepare('INSERT INTO messages (agent_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run(a.id, 'user', '월요일 지시', null, at('2025-03-10T10:00:00'));
  ins.run(a.id, 'usage', 'u', JSON.stringify({ total: { fresh: 100, cost: 0.25 } }), at('2025-03-10T10:05:00'));
  ins.run(a.id, 'user', '수요일 지시', null, at('2025-03-12T10:00:00'));
  ins.run(a.id, 'usage', 'u', JSON.stringify({ total: { fresh: 300, cost: 0.75 } }), at('2025-03-12T10:05:00'));
  ins.run(a.id, 'user', '지난주 지시', null, at('2025-03-07T10:00:00'));
  const days = dailyTotals(w.since, w.until);
  assert.deepEqual(days.map((d) => [d.date, d.requests, d.fresh, d.cost]), [['2025-03-10', 1, 100, 0.25], ['2025-03-12', 1, 300, 0.75]]);
  const week = buildDigest('2025-03-13', 'week');
  const mine = week.agents.find((r) => r.id === a.id);
  assert.equal(mine.requests, 2, 'last week is excluded');
  assert.equal(mine.cost, 1);
  assert.equal(week.days.length, 2);
  assert.equal(buildDigest('2026-09-17').days, undefined, 'day view has no per-day list');
  Agents.remove(a.id); Workspaces.remove(ws.id);
});

test('saved prompts: ordered by use, title defaults to the text, validation rejects empty text', () => {
  const p1 = SavedPrompts.create('리뷰', '어제 커밋 리뷰해줘');
  const p2 = SavedPrompts.create('테스트', '테스트 돌려줘');
  SavedPrompts.touch(p2.id);
  assert.deepEqual(SavedPrompts.all().map((p) => p.id), [p2.id, p1.id]);
  assert.equal(SavedPrompts.get(p2.id).uses, 1);
  SavedPrompts.update(p1.id, { title: '코드 리뷰' });
  assert.equal(SavedPrompts.get(p1.id).title, '코드 리뷰');
  SavedPrompts.remove(p1.id); SavedPrompts.remove(p2.id);
  assert.equal(SavedPrompts.all().length, 0);
});

test('backup: one consistent copy per local day, overwritten on rerun, old days pruned', () => {
  const dir = process.env.AGENT_REMOTE_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-backups-'));
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) runBackup({}, { date: d, keep: 10 });
  assert.deepEqual(listBackups().map((b) => b.date), ['2026-09-03', '2026-09-02', '2026-09-01']);
  assert.ok(fs.existsSync(path.join(dir, '2026-09-03', 'app.sqlite')));
  const r = runBackup({}, { date: '2026-09-04', keep: 2 });
  assert.equal(r.removed, 2);
  assert.deepEqual(listBackups().map((b) => b.date), ['2026-09-04', '2026-09-03']);
  assert.ok(runBackup({}, { date: '2026-09-04', keep: 2 }).bytes > 0, 'same-day rerun overwrites instead of failing');
  const first = backupIfDue({});
  assert.ok(first === null || first.date, 'first tick may back up');
  assert.equal(backupIfDue({}), null, 'second tick the same day does nothing');
  const st = backupStatus();
  assert.ok(st.last && st.count >= 2 && st.keep > 0);
});

test('phone UI wires backup, saved prompts and the period digest', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="btn-backup-now"/);
  assert.match(html, /id="dlg-prompts"/);
  assert.match(html, /data-period="month"/);
  assert.match(js, /id="attach-saved"/);
  assert.match(js, /\/prompts\/\$\{id\}\/use/);
  assert.match(js, /period=month/);
  assert.match(js, /api\('\/backup', \{ method: 'POST' \}\)/);
});

// ---------- 위험 등급 · 방해금지 · 진행률 · 전후 비교 · 텔레그램 ----------
const { riskLevel, LEVEL_LABEL } = await import('../server/approvals.js');
const { inQuietWindow, saveQuietSettings, quietSettings, isQuietNow, holdNotification, heldNotifications, heldSummary, clearHeld } = await import('../server/quiet.js');
const { sendPush } = await import('../server/push.js');
const { flushHeldIfMorning } = await import('../server/scheduler.js');
const { parseProgress, setProgress, getProgress, clearProgress, tickProgress } = await import('../server/progress.js');
const { handleCallbackData, handleText, telegramStatus, unlinkTelegram } = await import('../server/telegram.js');
const { Settings: KV } = await import('../server/db.js');

test('risk level: green for reads, yellow for undoable edits inside the workspace, red for outside/destructive, none for questions', () => {
  const wsPath = path.join(os.tmpdir(), `lvl-ws-${process.pid}`);
  assert.equal(riskLevel('Read', { file_path: 'C:/anywhere/x.txt' }, wsPath), 'safe');
  assert.equal(riskLevel('Bash', { command: 'git status && ls' }, wsPath), 'safe');
  assert.equal(riskLevel('Edit', { file_path: path.join(wsPath, 'a.js'), old_string: 'a', new_string: 'b' }, wsPath), 'caution');
  assert.equal(riskLevel('Bash', { command: 'npm install' }, wsPath), 'caution', 'unknown command inside the workspace');
  assert.equal(riskLevel('Write', { file_path: path.join(os.tmpdir(), 'elsewhere.txt') }, wsPath), 'danger');
  assert.equal(riskLevel('Bash', { command: 'shutdown /s' }, wsPath), 'danger');
  assert.equal(riskLevel('Bash', { command: 'ls' }, wsPath, 'outside'), 'danger', 'an explicit outside flag wins');
  assert.equal(riskLevel('AskUserQuestion', { questions: [] }, wsPath), null);
  for (const k of ['safe', 'caution', 'danger']) assert.ok(LEVEL_LABEL[k].title && LEVEL_LABEL[k].note);
  // 저장·알림까지 이어지는지
  const ws = Workspaces.create('lvl-ws', wsPath);
  const agent = Agents.create(ws.id, 'claude', '등급봇');
  const r = requestApproval(agent.id, 'Edit', { file_path: path.join(wsPath, 'a.js') });
  assert.equal(Approvals.get(r.approval.id).level, 'caution');
  const d = requestApproval(agent.id, 'Bash', { command: `rm -rf ${path.join(os.tmpdir(), 'zzz')}` });
  assert.equal(Approvals.get(d.approval.id).level, 'danger');
  assert.equal(Approvals.get(d.approval.id).risk, 'outside');
  resolveApproval(r.approval.id, 'allow'); resolveApproval(d.approval.id, 'deny');
  Agents.remove(agent.id); Workspaces.remove(ws.id);
});

test('quiet hours: overnight window, notifications are held and flushed as one morning summary', async () => {
  const at = (h, m = 0) => { const d = new Date(2026, 8, 17, h, m); return d; };
  assert.equal(inQuietWindow(at(23, 30), '23:00', '08:00'), true);
  assert.equal(inQuietWindow(at(2), '23:00', '08:00'), true);
  assert.equal(inQuietWindow(at(8), '23:00', '08:00'), false, 'end is exclusive');
  assert.equal(inQuietWindow(at(12), '23:00', '08:00'), false);
  assert.equal(inQuietWindow(at(13), '12:00', '14:00'), true, 'same-day window');
  assert.equal(inQuietWindow(at(13), '13:00', '13:00'), false, 'empty window never quiet');
  assert.throws(() => saveQuietSettings({ start: '25:00' }));
  assert.equal(quietSettings().enabled, false, 'off by default');
  // 지금 시각을 포함하는 창을 만들어 실제 sendPush가 참는지
  const now = new Date();
  const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const start = new Date(now.getTime() - 60 * 60 * 1000), end = new Date(now.getTime() + 60 * 60 * 1000);
  saveQuietSettings({ enabled: true, start: hh(start), end: hh(end) });
  assert.equal(isQuietNow(), true);
  clearHeld();
  const r1 = await sendPush({ title: '🟡 등급봇 · 주의 · 승인 필요', body: 'Edit: a.js', url: '/?agent=1' });
  const r2 = await sendPush({ title: '등급봇 · 완료', body: '끝났습니다', url: '/?agent=1' });
  assert.equal(r1.held && r2.held, true);
  assert.equal(heldNotifications().length, 2);
  assert.equal(flushHeldIfMorning(), false, 'still quiet: nothing sent');
  const urgent = await sendPush({ title: 'test', body: 'x' }, { urgent: true });
  assert.equal(urgent.held, false, 'urgent bypasses the hold');
  const sum = heldSummary(heldNotifications());
  assert.equal(sum.title, '밤사이 보고 2건');
  assert.match(sum.body, /^등급봇 · 주의 · 승인 필요 \/ 등급봇 · 완료$/, 'emoji prefix stripped, titles joined');
  saveQuietSettings({ enabled: false });
  assert.equal(flushHeldIfMorning(), true, 'window over: summary goes out');
  assert.equal(heldNotifications().length, 0);
  holdNotification({ title: 't' });
  clearHeld();
});

test('progress: percent/"n/m" parsing, agent-set values, and a tailed log file that reports completion', () => {
  assert.deepEqual(parseProgress('frame 120 ... 37% done\nframe 130 ... 41%'), { percent: 41, done: false, failed: false });
  assert.equal(parseProgress('processing [3/10] clip_03.mp4').percent, 30);
  assert.equal(parseProgress('rendering 100%').done, true);
  assert.equal(parseProgress('업로드 완료').done, true);
  assert.equal(parseProgress('no numbers here').percent, null);
  assert.equal(parseProgress('Traceback (most recent call last): error').failed, true);
  assert.equal(parseProgress('9/12/2026 ok').percent, null, 'dates are not progress');

  const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-ws-'));
  const ws = Workspaces.create('progress-ws', wsPath);
  const agent = Agents.create(ws.id, 'claude', '진행봇');
  const p = setProgress(agent.id, { percent: 25, label: '쇼츠 영상 만드는 중' });
  assert.equal(p.percent, 25);
  assert.equal(p.source, 'agent');
  clearProgress(agent.id);
  assert.equal(getProgress(agent.id), null, 'agent-set progress clears when the run settles');

  const log = path.join(wsPath, 'render.log');
  fs.writeFileSync(log, 'start\n');
  assert.throws(() => setProgress(agent.id, { log_file: 'missing.log', workspacePath: wsPath }));
  setProgress(agent.id, { log_file: 'render.log', label: '영상 렌더링', workspacePath: wsPath });
  clearProgress(agent.id);
  assert.ok(getProgress(agent.id), 'a watched log survives the end of the turn');
  fs.appendFileSync(log, 'progress 40%\n');
  tickProgress();
  assert.equal(getProgress(agent.id).percent, 40);
  assert.equal(getProgress(agent.id).eta_ms !== null, true);
  fs.appendFileSync(log, 'progress 100%\n');
  tickProgress();
  const done = getProgress(agent.id);
  assert.equal(done.done, true);
  assert.equal(done.percent, 100);
  const last = Messages.forAgent(agent.id).at(-1);
  assert.match(last.content, /끝났습니다 · 영상 렌더링/);
  clearProgress(agent.id, { force: true });
  assert.equal(getProgress(agent.id), null);
  Agents.remove(agent.id); Workspaces.remove(ws.id);
  fs.rmSync(wsPath, { recursive: true, force: true });
});

test('telegram: approval buttons resolve like the phone, replies become prompts, pairing state is exposed', () => {
  unlinkTelegram();
  assert.deepEqual(telegramStatus(), { configured: false, linked: false, bot: null, pair_code: null, last_agent: null });
  const ws = Workspaces.create('tg-ws', path.join(os.tmpdir(), `tg-ws-${process.pid}`));
  const agent = Agents.create(ws.id, 'claude', '텔레봇');
  const r = requestApproval(agent.id, 'Bash', { command: 'npm test' });
  assert.equal(handleCallbackData('nonsense').ok, false);
  const ok = handleCallbackData(`ap:${r.approval.id}:allow`);
  assert.equal(ok.ok, true);
  assert.equal(Approvals.get(r.approval.id).status, 'allowed');
  assert.equal(handleCallbackData(`ap:${r.approval.id}:allow`).text, '이미 처리된 요청입니다');
  assert.match(Messages.forAgent(agent.id).at(-1).content, /승인함 · Bash · 텔레그램에서/);
  const d = requestApproval(agent.id, 'Bash', { command: 'npm run build' });
  assert.equal(handleCallbackData(`ap:${d.approval.id}:deny`).text, '⛔ 거부했습니다');
  assert.equal(Approvals.get(d.approval.id).status, 'denied');
  Agents.update(agent.id, { status: 'idle' });

  assert.match(handleText('/help'), /leebeegle_SmartAgent/);
  assert.ok(handleText("/list").includes(`#${agent.id} [tg-ws] 텔레봇`));
  assert.equal(handleText('/use 999999'), '그 번호의 담당자가 없습니다');
  assert.match(handleText(`/use ${agent.id}`), /] 텔레봇 에게 전달합니다/);
  assert.match(handleText("/who"), /텔레봇 에게 갑니다/);
  assert.equal(telegramStatus().last_agent, agent.id);
  // 작업 중이면 줄 세우기
  Agents.update(agent.id, { status: 'working' });
  assert.match(handleText('로고 색 바꿔줘'), /1번째로 줄 세웠습니다/);
  assert.equal(queuedPrompts(agent.id).length, 1);
  removeQueued(agent.id, queuedPrompts(agent.id)[0].id);
  Agents.update(agent.id, { status: 'idle' });
  KV.set('tg_last_agent', null);
  Agents.remove(agent.id); Workspaces.remove(ws.id);
  unlinkTelegram();
});

test('phone UI wires risk colours, the progress bar, before/after captures and the new settings', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const mcp = fs.readFileSync(new URL('../server/mcp-approver.js', import.meta.url), 'utf8');
  assert.match(js, /level-pill \$\{level\}/);
  assert.match(css, /\.approve\.lvl-danger/);
  assert.match(js, /id="progress-bar"/);
  assert.match(js, /case 'progress\.updated'/);
  assert.match(js, /msg image compare/);
  assert.match(js, /meta\.before\?\.file/);
  assert.match(html, /id="quiet-enabled"/);
  assert.match(html, /id="tg-token"/);
  assert.match(js, /api\('\/quiet', \{ method: 'PATCH'/);
  assert.match(js, /api\('\/telegram', \{ method: 'POST'/);
  assert.match(mcp, /name: 'progress'/);
  assert.match(mcp, /phase: \{ type: 'string', enum: \['before', 'after'\]/);
  assert.match(buildClaudeArgs({ permission_mode: 'ask' }, 'x', {}).join(' '), /mcp__approver__progress/);
  assert.match(PHONE_STYLE_PROMPT, /mcp__approver__progress/);
  assert.match(PHONE_STYLE_PROMPT, /phase를 before/);
});
