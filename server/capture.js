// Screenshots for the phone: renders a URL / local HTML file / HTML string with the machine's
// Edge or Chrome in headless mode (no extra dependencies) and stores the PNG under data/captures.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './paths.js';

export const CAPTURE_DIR = path.join(DATA_DIR, 'captures');

export function findBrowserBin() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.CAPTURE_BROWSER,
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

/** Turns the tool's target (url | file | html) into something the browser can open. */
export function resolveTarget({ url, file, html }, workspacePath, scratchDir) {
  if (html) {
    fs.mkdirSync(scratchDir, { recursive: true });
    const p = path.join(scratchDir, `inline-${Date.now()}.html`);
    fs.writeFileSync(p, html, 'utf8');
    return { href: pathToFileURL(p).href, cleanup: () => { try { fs.unlinkSync(p); } catch {} } };
  }
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.resolve(workspacePath || process.cwd(), file);
    if (!fs.existsSync(abs)) throw new Error(`파일이 없습니다: ${abs}`);
    return { href: pathToFileURL(abs).href, cleanup: null };
  }
  if (url) {
    if (!/^https?:\/\//i.test(url) && !/^file:/i.test(url)) throw new Error('url은 http(s):// 로 시작해야 합니다');
    return { href: url, cleanup: null };
  }
  throw new Error('url, file, html 중 하나는 필요합니다');
}

const LINE_BREAK = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));

/**
 * @returns {Promise<{ file: string, width: number, height: number }>} file is relative to CAPTURE_DIR.
 */
// Headless Chromium keeps a ~500px minimum layout width even when --window-size asks for less;
// narrower requests get laid out at ~492px and merely cropped, cutting off the right edge.
export const MIN_CAPTURE_WIDTH = 500;

export function captureScreenshot({ agentId, url, file, html, width = MIN_CAPTURE_WIDTH, height = 844, fullPage = false, waitMs = 1500, workspacePath }) {
  const bin = findBrowserBin();
  if (!bin) return Promise.reject(new Error('Edge 또는 Chrome을 찾지 못해 캡처할 수 없습니다'));
  const w = Math.max(MIN_CAPTURE_WIDTH, Math.min(1600, Number(width) || MIN_CAPTURE_WIDTH));
  const h = fullPage ? 2400 : Math.max(400, Math.min(3000, Number(height) || 844));
  const dir = path.join(CAPTURE_DIR, `agent-${agentId}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}.png`;
  const out = path.join(dir, name);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-capture-'));
  const target = resolveTarget({ url, file, html }, workspacePath, profile);
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--window-size=${w},${h}`, `--virtual-time-budget=${Math.max(0, Math.min(15000, Number(waitMs) || 0))}`,
    `--screenshot=${out}`, target.href,
  ];
  // The launcher process exits right away on Windows and a detached child writes the PNG a
  // second or two later, so wait for the file rather than trusting the exit event.
  const waitForFile = (deadline) => new Promise((resolve) => {
    const iv = setInterval(() => {
      if (fs.existsSync(out) || Date.now() > deadline) { clearInterval(iv); resolve(fs.existsSync(out)); }
    }, 150);
  });
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 45_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, async (err, _stdout, stderr) => {
      const ok = await waitForFile(Date.now() + 20_000);
      // Give the detached child a moment to release the temp profile before deleting it.
      setTimeout(() => { target.cleanup?.(); fs.rm(profile, { recursive: true, force: true }, () => {}); }, 3000);
      if (!ok) {
        const tail = String(stderr || '').split(LINE_BREAK).filter((l) => /ERROR|FATAL|screenshot/i.test(l)).slice(-3).join(' | ');
        return reject(new Error(`캡처 실패: ${err?.message || tail || '브라우저가 이미지를 만들지 못했습니다'}`));
      }
      resolve({ file: `agent-${agentId}/${name}`, width: w, height: h });
    });
  });
}
