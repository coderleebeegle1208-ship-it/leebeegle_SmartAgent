// 작업 폴더 밖 변경 감지. 되돌리기(snapshot.js)는 작업 폴더 안만 기록하므로, 밖을 고치거나 지우는
// 요청은 "이번 작업 동안 모두 허용"이 켜져 있어도 대표에게 한 번 더 묻는다. 순수 함수만 두어
// 서버(approvals.js)와 Claude 훅(guard-hook.js) 양쪽에서 같은 판단을 쓴다.
import path from 'node:path';
import os from 'node:os';

export const OUTSIDE_REASON = '작업 폴더 밖 변경 · 되돌리기가 안 됩니다';

function norm(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function insideWorkspace(target, workspacePath) {
  if (!target || !workspacePath) return true;
  const ws = norm(workspacePath);
  const t = norm(path.isAbsolute(target) ? target : path.join(workspacePath, target));
  return t === ws || t.startsWith(ws + '/');
}

// 절대 경로 후보: C:\..., C:/..., /..., ~/..., %USERPROFILE%..., $HOME...
const ABS_PATH_RE = /(?:^|[\s"'=(])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|%USERPROFILE%|\$HOME|\$env:USERPROFILE|\/(?!dev\/null))[^\s"'`;&|)<>]*)/g;
// 파일을 바꾸거나 지우는 명령. 읽기만 하는 명령(cat, ls, grep, git status …)은 밖을 봐도 괜찮다.
const MUTATING_RE = /(?:^|[\s;&|(])(rm|rmdir|rd|del|erase|mv|move|cp|copy|xcopy|robocopy|ren|rename|mkdir|md|touch|tee|dd|shred|truncate|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Set-Content|Add-Content|Out-File|Clear-Content|Remove-ItemProperty|ri|rni|mi|cpi|ni|sc|ac)(?:\.exe)?(?=\s|$)|>{1,2}(?!&|\s*\/dev\/null)\s*\S|\bgit\s+(?:reset\s+--hard|clean|checkout\s+--|push\s+[^\n]*(?:--force|-f\b))/i;
// 경로와 상관없이 되돌릴 수 없는 명령.
const DESTRUCTIVE_RE = /(?:^|[\s;&|(])(format(?:\.com)?\s+[A-Za-z]:|diskpart|shutdown|Restart-Computer|Stop-Computer|reg\s+(?:delete|add)|Remove-ItemProperty|schtasks\s+\/(?:create|delete)|Clear-RecycleBin|cipher\s+\/w)\b/i;

function expandHome(p) {
  const home = os.homedir();
  p = p.replace(/^\/([a-z])\//i, '$1:/'); // git-bash 식 /c/Users → C:/Users
  return p.replace(/^~(?=[\\/])/, home).replace(/^%USERPROFILE%|^\$HOME|^\$env:USERPROFILE/i, home);
}

/** Bash 명령이 작업 폴더 밖을 바꾸는지. 절대 경로가 하나라도 밖을 가리키고 변경 명령이 섞여 있으면 true. */
export function bashTouchesOutside(command, workspacePath) {
  if (!command || !workspacePath) return false;
  if (DESTRUCTIVE_RE.test(command)) return true;
  if (!MUTATING_RE.test(command)) return false;
  for (const m of command.matchAll(ABS_PATH_RE)) {
    const raw = expandHome(m[1]);
    if (!insideWorkspace(raw, workspacePath)) return true;
  }
  // `cd ..` 뒤에 변경 명령이 오면 결국 밖을 고치는 셈이다.
  return /(?:^|[\s;&|(])(?:cd|Set-Location|pushd)\s+\.\.(?=[\\/\s]|$)/.test(command);
}

/** 요청이 작업 폴더 밖을 바꾸면 이유 문자열, 아니면 null. */
export function outsideRisk(toolName, input, workspacePath) {
  if (!workspacePath || !input || typeof input !== 'object') return null;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const fp = input.file_path || input.notebook_path;
    return fp && !insideWorkspace(fp, workspacePath) ? OUTSIDE_REASON : null;
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return bashTouchesOutside(input.command || '', workspacePath) ? OUTSIDE_REASON : null;
  }
  return null;
}
