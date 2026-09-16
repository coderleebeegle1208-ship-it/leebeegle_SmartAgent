// 방해금지 시간: 밤사이 폰 알림을 참았다가 아침에 한 번에 모아서 보낸다.
// 설정은 settings 테이블(quiet_enabled / quiet_start / quiet_end), 참아 둔 알림은 quiet_held(JSON)에
// 두어 서버가 재시작돼도 잃지 않는다. 승인 요청도 같이 참는다 — 안전한 요청은 자리 비움 규칙이
// 20분 뒤 알아서 허용하고, 위험한 요청은 아침에 대표가 보고 결정하면 된다.
import { Settings } from './db.js';

export const DEFAULT_QUIET = { enabled: false, start: '23:00', end: '08:00' };
const MAX_HELD = 200;

const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const minutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

export function quietSettings() {
  const start = Settings.get('quiet_start', DEFAULT_QUIET.start);
  const end = Settings.get('quiet_end', DEFAULT_QUIET.end);
  return {
    enabled: Settings.get('quiet_enabled', '0') === '1',
    start: validTime(start) ? start : DEFAULT_QUIET.start,
    end: validTime(end) ? end : DEFAULT_QUIET.end,
  };
}
export function saveQuietSettings(patch = {}) {
  if ('enabled' in patch) Settings.set('quiet_enabled', patch.enabled ? '1' : '0');
  for (const k of ['start', 'end']) {
    if (!(k in patch)) continue;
    if (!validTime(patch[k])) throw new Error('시각은 HH:MM 형식입니다');
    Settings.set(`quiet_${k}`, patch[k]);
  }
  return quietSettings();
}

/** 'HH:MM' 구간 안인지. 23:00→08:00처럼 자정을 넘는 구간도 다룬다. 시작=끝이면 항상 꺼진 것으로 본다. */
export function inQuietWindow(now, start, end) {
  if (!validTime(start) || !validTime(end) || start === end) return false;
  const d = now instanceof Date ? now : new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = minutes(start), e = minutes(end);
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}
export function isQuietNow(now = Date.now()) {
  const q = quietSettings();
  return q.enabled && inQuietWindow(now, q.start, q.end);
}

function readHeld() {
  try { const v = JSON.parse(Settings.get('quiet_held', '[]') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function heldNotifications() { return readHeld(); }
export function holdNotification(payload) {
  const list = readHeld();
  list.push({ title: payload.title || '', body: payload.body || '', url: payload.url || '/', at: Date.now() });
  Settings.set('quiet_held', JSON.stringify(list.slice(-MAX_HELD)));
  return list.length;
}
export function clearHeld() { Settings.set('quiet_held', '[]'); }

/** 아침에 보낼 한 장짜리 알림 문구. */
export function heldSummary(list) {
  const n = list.length;
  const titles = [];
  for (const h of list) {
    const t = String(h.title || '').replace(/^[^\p{L}\p{N}]+\s*/u, '').trim(); // 🟢 같은 앞 기호 제거
    if (t && !titles.includes(t)) titles.push(t);
    if (titles.length >= 4) break;
  }
  const more = n > titles.length ? ` 외 ${n - titles.length}건` : '';
  return {
    title: `밤사이 보고 ${n}건`,
    body: (titles.join(' / ') + more).slice(0, 180) || '방해금지 시간 동안 쌓인 알림입니다.',
    url: list.length === 1 ? list[0].url || '/' : '/',
    tag: 'quiet-summary',
  };
}
