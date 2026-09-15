// Phone attachments: saves photos/videos the user picks into data/uploads, and — when ffmpeg is
// installed — shrinks photos and pulls a few scene frames out of videos so the model (which can
// only look at still images) has something to actually see.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './paths.js';

const execFileP = promisify(execFile);

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/3gpp': '3gp',
};

function findOnPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      try { if (fs.existsSync(candidate)) return candidate; } catch {}
    }
  }
  return null;
}

export function findFfmpeg() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.FFMPEG_BIN,
    local && path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    findOnPath(process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

export function findFfprobe() {
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext || ''}`);
    if (probe !== ffmpeg) {
      try { if (fs.existsSync(probe)) return probe; } catch {}
    }
  }
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.FFPROBE_BIN,
    local && path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe'),
    findOnPath(process.platform === 'win32' ? ['ffprobe.exe'] : ['ffprobe']),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

async function probeStreamAndDuration(filePath) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return null;
  try {
    const { stdout } = await execFileP(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json', filePath,
    ], { timeout: 15_000 });
    const j = JSON.parse(stdout);
    const s = j.streams?.[0];
    return { width: s?.width || null, height: s?.height || null, duration: Number(j.format?.duration) || 0 };
  } catch {
    return null;
  }
}

async function makeImageView(inPath, outPath) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return false;
  try {
    await execFileP(ffmpeg, ['-y', '-i', inPath, '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', outPath], { timeout: 30_000 });
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
}

async function extractFrames(inPath, dir, id, count, duration) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return [];
  const names = [];
  const step = duration > 0 ? duration / (count + 1) : 1;
  for (let i = 1; i <= count; i++) {
    const t = Math.max(0, Math.min(duration > 0.2 ? duration - 0.1 : 0, step * i));
    const name = `${id}-f${i}.jpg`;
    const out = path.join(dir, name);
    try {
      await execFileP(ffmpeg, ['-y', '-ss', t.toFixed(2), '-i', inPath, '-frames:v', '1', '-vf', 'scale=800:-2', out], { timeout: 20_000 });
      if (fs.existsSync(out)) names.push(name);
    } catch {}
  }
  return names;
}

/** Saves one uploaded file, preprocesses it for the model, and writes a JSON sidecar descriptor. */
export async function saveUpload({ agentId, name, mime, buffer }) {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`지원하지 않는 파일 형식입니다: ${mime || '알 수 없음'}`);
  if (!buffer?.length) throw new Error('빈 파일입니다');
  const kind = mime.startsWith('image/') ? 'image' : 'video';

  const dir = path.join(UPLOAD_DIR, `agent-${agentId}`);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const fileName = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);

  const descriptor = { id, kind, name: name || fileName, mime, size: buffer.length, file: `agent-${agentId}/${fileName}` };

  if (kind === 'image') {
    const probe = await probeStreamAndDuration(path.join(dir, fileName));
    if (probe) { descriptor.width = probe.width; descriptor.height = probe.height; }
    const viewName = `${id}-view.jpg`;
    const made = await makeImageView(path.join(dir, fileName), path.join(dir, viewName));
    if (made) descriptor.view = `agent-${agentId}/${viewName}`;
    else descriptor.warn = 'ffmpeg가 없어 미리보기를 만들지 못했습니다. 원본 파일을 그대로 전달합니다.';
  } else {
    const probe = await probeStreamAndDuration(path.join(dir, fileName));
    if (!probe) {
      descriptor.warn = 'ffmpeg/ffprobe가 없어 동영상 정보를 읽지 못했습니다. 모델이 이 동영상을 볼 수 없습니다.';
    } else {
      descriptor.duration = probe.duration;
      descriptor.width = probe.width;
      descriptor.height = probe.height;
      const frameCount = probe.duration > 0 && probe.duration <= 8 ? Math.max(1, Math.round(probe.duration)) : 8;
      const frames = await extractFrames(path.join(dir, fileName), dir, id, frameCount, probe.duration || frameCount);
      if (frames.length) {
        descriptor.frames = frames.map((f) => `agent-${agentId}/${f}`);
        descriptor.poster = descriptor.frames[0];
      } else {
        descriptor.warn = '장면 사진을 만들지 못했습니다. 모델이 이 동영상을 볼 수 없습니다.';
      }
    }
  }

  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(descriptor));
  return descriptor;
}

/** Resolves a client-supplied attachment id to its stored descriptor, or null if it doesn't exist. */
export function loadUpload(agentId, id) {
  if (!/^\d+-[a-z0-9]+$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `agent-${agentId}`, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Whether this agent has ever received an upload — gates giving Claude read access to the folder. */
export function hasUploads(agentId) {
  try { return fs.existsSync(path.join(UPLOAD_DIR, `agent-${agentId}`)); } catch { return false; }
}

const URL_RE = /https?:\/\/[^\s<>"'」)]+/g;

/** Merges body-text URLs with explicitly attached links, de-duplicated, order preserved. */
export function extractLinks(text, explicitLinks = []) {
  const found = String(text || '').match(URL_RE) || [];
  return [...new Set([...explicitLinks.filter(Boolean), ...found])];
}

/** Builds the text block appended to the model's prompt describing attachments and links. */
export function attachmentBlock(attachments = [], links = []) {
  const abs = (rel) => path.join(UPLOAD_DIR, rel);
  const parts = [];
  if (attachments.length) {
    let imgN = 0, vidN = 0;
    const lines = attachments.map((a) => {
      const dims = a.width && a.height ? `, ${a.width}×${a.height}` : '';
      if (a.kind === 'image') {
        imgN += 1;
        return `- 사진 ${imgN}: ${abs(a.view || a.file)} (원본 ${a.name}${dims})`;
      }
      vidN += 1;
      const dur = a.duration ? `${Math.round(a.duration)}초` : '길이 미상';
      const framesTxt = a.frames?.length ? ` · 장면 사진 ${a.frames.length}장: ${a.frames.map(abs).join(', ')}` : ' · 장면 사진 없음(모델이 내용을 볼 수 없음)';
      return `- 동영상 ${vidN}: ${abs(a.file)} (${dur}${dims})${framesTxt}`;
    });
    parts.push(`[첨부 파일]\n${lines.join('\n')}\n첨부된 사진과 장면 사진은 Read 도구로 열어 직접 본 뒤 답해라. 동영상 내용이 더 필요하면 ffmpeg로 프레임을 더 뽑아도 된다.`);
  }
  if (links.length) {
    parts.push(`[참고 링크]\n${links.map((l) => `- ${l}`).join('\n')}\n링크 내용은 WebFetch 도구로 읽고 참고해라.`);
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}
