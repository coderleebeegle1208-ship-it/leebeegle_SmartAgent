import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PC 클로드 앱 대화 이어받기: 목록 읽기·기록 파일 파싱은 임시 폴더에 흉내 낸 파일로 검사한다.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-desktop-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
process.env.CLAUDE_DESKTOP_DIR = path.join(home, 'Claude');
const { desktopRoot, encodeCwd, listDesktopSessions, readTranscript, transcriptPath } = await import('../server/desktop-sessions.js');
const { PHONE_STYLE_REMINDER_SHORT } = await import('../server/style.js');

const line = (o) => JSON.stringify(o) + '\n';
const user = (content, extra = {}) => line({ type: 'user', uuid: 'u' + Math.random(), timestamp: '2026-09-20T01:00:00.000Z', message: { role: 'user', content }, ...extra });
const assistant = (blocks, extra = {}) => line({ type: 'assistant', uuid: 'a' + Math.random(), timestamp: '2026-09-20T01:00:01.000Z', message: { role: 'assistant', content: blocks }, ...extra });

test('encodeCwd: CLI가 projects 폴더 이름을 만드는 규칙 그대로', () => {
  const win = (...p) => path.win32.join(...p); // 테스트 파일 안에서 역슬래시를 직접 쓰지 않으려고
  assert.equal(encodeCwd(win("C:", "Users", "leebe", "Desktop", "leebeegle_SmartAgent")), "C--Users-leebe-Desktop-leebeegle-SmartAgent");
  assert.equal(encodeCwd(win("C:", "Users", "leebe", "Desktop", "비글")), "C--Users-leebe-Desktop---");
});

test('readTranscript: 내 말·답변 글만, 도구·메타·갈래는 건너뛰고 덜 써진 줄은 다음으로', () => {
  const file = path.join(home, 't.jsonl');
  fs.writeFileSync(file,
    line({ type: 'custom-title', customTitle: '제목' }) +
    user('안녕') +
    user([{ type: 'text', text: '<system-reminder>숨김</system-reminder>' }, { type: 'text', text: '사진 봐줘' }, { type: 'image', source: {} }]) +
    user('메타', { isMeta: true }) +
    assistant([{ type: 'thinking', thinking: '...' }, { type: 'text', text: '봤어요' }]) +
    assistant([{ type: 'tool_use', name: 'Read', input: {} }]) +
    user([{ type: 'tool_result', content: '파일 내용' }]) +
    assistant([{ type: 'text', text: '갈래' }], { isSidechain: true }) +
    user(`폰에서 보냄\n\n${PHONE_STYLE_REMINDER_SHORT}`) +
    user('[Request interrupted by user for tool use]') +
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"덜 써'
  );
  const r = readTranscript(file, 0);
  assert.deepEqual(r.messages.map((m) => [m.role, m.content]), [['user', '안녕'], ['user', '사진 봐줘'], ['assistant', '봤어요'], ['user', '폰에서 보냄']]);
  assert.equal(r.messages[0].ts, Date.parse('2026-09-20T01:00:00.000Z'));
  // 마지막 줄은 아직 개행이 없으므로 위치는 그 앞까지만. 마저 써지면 다음 호출에서 읽힌다.
  const size = fs.statSync(file).size;
  assert.ok(r.pos < size);
  fs.appendFileSync(file, '진 줄"}]}}\n');
  const r2 = readTranscript(file, r.pos);
  assert.deepEqual(r2.messages.map((m) => m.content), ['덜 써진 줄']);
  assert.equal(r2.pos, fs.statSync(file).size);
  assert.deepEqual(readTranscript(file, r2.pos), { messages: [], pos: r2.pos });
  assert.deepEqual(readTranscript(path.join(home, 'none.jsonl'), 5), { messages: [], pos: 5 });
});

test('listDesktopSessions: 제목·폴더·그룹을 읽고 이어받기 가능 여부를 판단한다', () => {
  const cwdOk = fs.mkdtempSync(path.join(home, 'proj-'));
  const listDir = path.join(process.env.CLAUDE_DESKTOP_DIR, 'claude-code-sessions', 'org1', 'user1');
  fs.mkdirSync(listDir, { recursive: true });
  const write = (id, j) => fs.writeFileSync(path.join(listDir, `${id}.json`), JSON.stringify({ sessionId: id, ...j }));
  write('local_a', { cliSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: cwdOk, title: '되는 대화', lastActivityAt: 30, model: 'claude-fable-5-1', effort: 'high', permissionMode: 'auto' });
  write('local_b', { cliSessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', cwd: cwdOk, title: '기록 없음', lastActivityAt: 20 });
  write('local_c', { cliSessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', cwd: path.join(home, 'gone'), title: '폴더 없음', lastActivityAt: 10, isArchived: true });
  // 다른 계정 폴더에 같은 세션이 더 오래된 채로 남아 있어도 한 번만 나온다.
  const otherDir = path.join(process.env.CLAUDE_DESKTOP_DIR, 'claude-code-sessions', 'org2', 'user1');
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'local_a-old.json'), JSON.stringify({ sessionId: 'local_a-old', cliSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: cwdOk, title: '되는 대화(옛 사본)', lastActivityAt: 5 }));
  fs.writeFileSync(path.join(listDir, 'deleted_x.json'), JSON.stringify({ cliSessionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', cwd: cwdOk, title: '지운 대화' }));
  for (const id of ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc']) {
    const p = transcriptPath(id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' ? cwdOk : path.join(home, 'gone'), id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, user('안녕'));
  }
  fs.writeFileSync(path.join(process.env.CLAUDE_DESKTOP_DIR, 'claude_desktop_config.json'), JSON.stringify({
    preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'org1/user1': { groups: [{ id: 'g1', name: '매장관련' }], assignments: { 'code:local_a': 'g1', 'code:local_zzz': 'g1' } } } } },
  }));
  const rows = listDesktopSessions();
  assert.deepEqual(rows.map((r) => r.host_id), ['local_a', 'local_b', 'local_c']); // 최근 활동순, deleted_* 제외
  const a = rows[0];
  assert.equal(a.title, '되는 대화');
  assert.equal(a.group, '매장관련');
  assert.equal(a.resumable, true);
  assert.equal(a.model, 'claude-fable-5-1');
  assert.equal(a.permission_mode, 'auto');
  assert.deepEqual([rows[1].resumable, rows[1].reason], [false, '대화 기록 파일이 없음']);
  assert.deepEqual([rows[2].resumable, rows[2].reason, rows[2].archived, rows[2].group], [false, '작업 폴더가 없음', true, null]);
});

test('desktopRoot: 스토어(MSIX) 앱의 가상화된 AppData 를 먼저 찾고, 없으면 %APPDATA%\Claude 로', () => {
  const saved = { CLAUDE_DESKTOP_DIR: process.env.CLAUDE_DESKTOP_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
  const fake = fs.mkdtempSync(path.join(home, 'win-'));
  process.env.LOCALAPPDATA = path.join(fake, 'Local');
  process.env.APPDATA = path.join(fake, 'Roaming');
  delete process.env.CLAUDE_DESKTOP_DIR;
  try {
    if (process.platform !== 'win32') return;
    fs.mkdirSync(path.join(fake, 'Roaming', 'Claude'), { recursive: true });
    assert.equal(desktopRoot(), path.join(fake, 'Roaming', 'Claude')); // 아무 데도 목록이 없으면 일반 경로
    const pkg = path.join(fake, 'Local', 'Packages', 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude');
    fs.mkdirSync(path.join(pkg, 'claude-code-sessions'), { recursive: true });
    assert.equal(desktopRoot(), pkg);
    fs.mkdirSync(path.join(fake, 'Roaming', 'Claude', 'claude-code-sessions'), { recursive: true });
    assert.equal(desktopRoot(), pkg); // 둘 다 있으면 패키지 쪽(실제로 앱이 쓰는 곳)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
