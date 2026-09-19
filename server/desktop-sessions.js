// PC의 Claude 데스크톱 앱(코드 탭) 대화를 읽어 이 앱의 담당자로 잇는다.
//
// 데스크톱 앱과 이 앱은 같은 Claude Code CLI를 쓰므로 대화 기록도 한 곳에 쌓인다:
//   ~/.claude/projects/<작업 폴더를 -로 바꾼 이름>/<세션 id>.jsonl
// 데스크톱 앱의 목록(제목·폴더·세션 id)은 %APPDATA%\Claude\claude-code-sessions\<org>\<user>\local_*.json,
// 사이드바 그룹은 claude_desktop_config.json 의 preferences.epitaxyPrefs["dframe-group-scopes"] 에 있다.
// 같은 세션 id를 그대로 --resume 하면 양쪽이 한 기록 파일을 번갈아 이어 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PHONE_STYLE_REMINDER_SHORT } from './style.js';

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/**
 * 데스크톱 앱 데이터 폴더. 스토어(MSIX)로 설치된 Claude 앱은 AppData 쓰기가
 * %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude 로 가상화된다. 앱 자신과 그 자식 프로세스는
 * %APPDATA%\Claude 에 있는 것처럼 보지만, 예약 작업으로 따로 뜬 이 서버는 실제 위치를 직접 읽어야 한다.
 */
export function desktopRoot() {
  if (process.env.CLAUDE_DESKTOP_DIR) return process.env.CLAUDE_DESKTOP_DIR;
  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    try {
      for (const name of fs.readdirSync(path.join(local, 'Packages'))) {
        if (/^Claude_/i.test(name)) candidates.push(path.join(local, 'Packages', name, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch {}
    candidates.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude'));
  } else {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude'));
  }
  return candidates.find((c) => fs.existsSync(path.join(c, 'claude-code-sessions'))) || candidates[candidates.length - 1];
}

/** CLI가 작업 폴더 경로를 projects 아래 폴더 이름으로 바꾸는 규칙: 영문·숫자 말고는 전부 '-'. */
export function encodeCwd(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}
export function transcriptPath(cwd, sessionId) {
  return path.join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

/** 데스크톱 앱이 세션 목록을 두는 폴더들(<org>/<user>). 계정이 여럿이면 여러 개. */
function sessionListDirs(root = desktopRoot(), diag = null) {
  const base = path.join(root, 'claude-code-sessions');
  const out = [];
  if (diag) diag.base = base;
  try {
    for (const org of fs.readdirSync(base, { withFileTypes: true })) {
      if (!org.isDirectory()) continue;
      for (const user of fs.readdirSync(path.join(base, org.name), { withFileTypes: true })) {
        if (user.isDirectory()) out.push({ scope: `${org.name}/${user.name}`, dir: path.join(base, org.name, user.name) });
      }
    }
  } catch (e) { if (diag) diag.dirsError = e.message; }
  if (diag) diag.dirs = out.map((d) => d.dir);
  return out;
}

/** 사이드바 그룹: { "<org>/<user>": { "local_x": "매장관련", … } } */
function groupAssignments(root = desktopRoot()) {
  const out = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'claude_desktop_config.json'), 'utf8'));
    const scopes = cfg?.preferences?.epitaxyPrefs?.['dframe-group-scopes'] || {};
    for (const [scope, v] of Object.entries(scopes)) {
      const names = Object.fromEntries((v?.groups || []).map((g) => [g.id, g.name]));
      const map = {};
      for (const [key, gid] of Object.entries(v?.assignments || {})) {
        const hostId = key.replace(/^code:/, '');
        if (names[gid]) map[hostId] = names[gid];
      }
      out[scope] = map;
    }
  } catch {}
  return out;
}

/**
 * 데스크톱 앱의 대화 목록. 각 항목:
 * { host_id, session_id, title, cwd, group, archived, last_activity_at, model, effort, permission_mode,
 *   transcript (기록 파일 존재), folder_exists, resumable, reason }
 */
export function listDesktopSessions(root = desktopRoot(), diag = null) {
  const groups = groupAssignments(root);
  const rows = [];
  for (const { scope, dir } of sessionListDirs(root, diag)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (diag) diag.readError = e.message; continue; }
    if (diag) diag.files = (diag.files || 0) + names.length;
    for (const name of names) {
      if (!name.startsWith('local_') || !name.endsWith('.json')) continue; // deleted_*·backlog 는 제외
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      const hostId = j.sessionId || name.replace(/\.json$/, '');
      const sessionId = typeof j.cliSessionId === 'string' && /^[0-9a-f-]{36}$/i.test(j.cliSessionId) ? j.cliSessionId : null;
      const cwd = typeof j.cwd === 'string' ? j.cwd : '';
      const file = sessionId && cwd ? transcriptPath(cwd, sessionId) : null;
      const transcript = !!file && fs.existsSync(file);
      let folderExists = false;
      try { folderExists = !!cwd && fs.statSync(cwd).isDirectory(); } catch {}
      const reason = !sessionId ? '세션 정보 없음' : !transcript ? '대화 기록 파일이 없음' : !folderExists ? '작업 폴더가 없음' : null;
      rows.push({
        host_id: hostId,
        session_id: sessionId,
        title: (j.title || '').trim() || '제목 없음',
        cwd,
        group: groups[scope]?.[hostId] || null,
        archived: !!j.isArchived,
        last_activity_at: Number(j.lastActivityAt || j.lastFocusedAt || j.createdAt) || 0,
        model: j.model || null,
        effort: j.effort || null,
        permission_mode: j.permissionMode || null,
        transcript,
        folder_exists: folderExists,
        resumable: !reason,
        reason,
      });
    }
  }
  // 같은 대화가 계정 폴더 여러 곳에 남아 있으면(예: 조직 전환) 가장 최근 항목 하나만 보여 준다.
  rows.sort((a, b) => b.last_activity_at - a.last_activity_at);
  const seen = new Set();
  return rows.filter((r) => { const k = r.session_id || r.host_id; if (seen.has(k)) return false; seen.add(k); return true; });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && !/^\s*<(system-reminder|command-|local-command)/.test(b.text))
    .map((b) => b.text)
    .join('\n');
}
/** 이 앱이 붙여 보내는 폰 말투 안내문은 대화 내용이 아니므로 뗀다. */
function stripReminder(text) {
  return text.endsWith(PHONE_STYLE_REMINDER_SHORT) ? text.slice(0, -PHONE_STYLE_REMINDER_SHORT.length).trimEnd() : text;
}

/**
 * 기록 파일에서 `fromPos` 바이트 이후에 새로 쌓인 대화(사용자 말·모델 답변 글만)를 읽는다.
 * 도구 호출·결과·생각·서브에이전트 갈래·메타 줄은 건너뛴다. 마지막에 덜 써진 줄은 다음 호출로 미룬다.
 * @returns {{ messages: {role:'user'|'assistant', content:string, ts:number, uuid:string|null}[], pos: number }}
 */
export function readTranscript(file, fromPos = 0) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { messages: [], pos: fromPos }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= fromPos) return { messages: [], pos: Math.min(fromPos, size) };
    const buf = Buffer.alloc(size - fromPos);
    fs.readSync(fd, buf, 0, buf.length, fromPos);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { messages: [], pos: fromPos };
    const chunk = buf.subarray(0, lastNl + 1).toString('utf8');
    const messages = [];
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.isSidechain || j.isMeta) continue;
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      const content = j.message?.content;
      if (j.type === 'user' && Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      const text = stripReminder(textOf(content).trim());
      if (!text || text.startsWith('[Request interrupted by user')) continue; // PC에서 중단 버튼을 누르면 남는 표시줄
      messages.push({ role: j.type, content: text, ts: Date.parse(j.timestamp) || Date.now(), uuid: j.uuid || null });
    }
    return { messages, pos: fromPos + lastNl + 1 };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

export function transcriptSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}
