// Minute-resolution scheduler for two things the owner does not want to remember:
//  - 예약 실행: a saved instruction fired into an agent at HH:MM on chosen weekdays
//  - 오늘 한 일 요약: the evening digest push
// Both are checked every 30s; a missed minute (server was down, agent was busy) is retried for
// up to GRACE_MS so a schedule does not silently skip a day.
import { Agents, Messages, Schedules, Settings } from './db.js';
import { backupIfDue } from './backup.js';
import { emit } from './bus.js';
import { sendPush } from './push.js';
import { startPrompt } from './runners/index.js';
import { buildDigest, digestPushText, localDate } from './digest.js';
import { clearHeld, heldNotifications, heldSummary, isQuietNow } from './quiet.js';
import { tickProgress } from './progress.js';

const GRACE_MS = 15 * 60 * 1000;
export const DEFAULT_DIGEST_TIME = '21:00';
export const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

export function isValidTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
}
/** Accepts an array or comma list of 0(일)..6(토); every day collapses to '' (the default). */
export function normalizeDays(days) {
  const list = Array.isArray(days) ? days : String(days || '').split(',');
  const set = new Set(list.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  return set.size === 7 || set.size === 0 ? '' : [...set].sort().join(',');
}
export function describeDays(days) {
  if (!days) return '매일';
  const list = days.split(',').map(Number);
  if (list.length === 5 && [1, 2, 3, 4, 5].every((d) => list.includes(d))) return '평일';
  if (list.length === 2 && list.includes(0) && list.includes(6)) return '주말';
  return list.map((d) => DAY_LABEL[d]).join('·');
}

/** Most recent moment (≤ now) at which a 'HH:MM' + days schedule was due, or null if none within `grace`. */
export function lastDue(time, days, now = Date.now(), grace = GRACE_MS) {
  if (!isValidTime(time)) return null;
  const [h, m] = time.split(':').map(Number);
  const allowed = days ? new Set(days.split(',').map(Number)) : null;
  for (let back = 0; back < 2; back += 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > now) continue;
    if (allowed && !allowed.has(d.getDay())) continue;
    return now - d.getTime() <= grace ? d.getTime() : null;
  }
  return null;
}

export function nextDue(time, days, now = Date.now()) {
  if (!isValidTime(time)) return null;
  const [h, m] = time.split(':').map(Number);
  const allowed = days ? new Set(days.split(',').map(Number)) : null;
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const d = new Date(now);
    d.setDate(d.getDate() + ahead);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) continue;
    if (allowed && !allowed.has(d.getDay())) continue;
    return d.getTime();
  }
  return null;
}

export function digestSettings() {
  const time = Settings.get('digest_time', DEFAULT_DIGEST_TIME) || '';
  return {
    enabled: Settings.get('digest_enabled', '1') === '1' && isValidTime(time),
    time: isValidTime(time) ? time : DEFAULT_DIGEST_TIME,
    last_sent: Settings.get('digest_last_sent') || null,
  };
}

export async function sendDigestPush(date) {
  const digest = buildDigest(date);
  const text = digestPushText(digest);
  await sendPush({ ...text, url: `/?digest=${digest.date}`, tag: `digest-${digest.date}` });
  Settings.set('digest_last_sent', digest.date);
  return digest;
}

/** Fires one schedule now. Returns the agent, or throws when it cannot start (busy etc.). */
export function runSchedule(schedule, cfg, { manual = false } = {}) {
  const agent = Agents.get(schedule.agent_id);
  if (!agent) throw new Error('에이전트가 없습니다');
  const m = Messages.add(agent.id, 'system', manual ? '예약 지시 바로 실행' : `예약 실행 · ${schedule.time}`);
  emit('message', { agent_id: agent.id, message: m });
  const started = startPrompt(agent.id, schedule.text, cfg);
  Schedules.update(schedule.id, { last_run_at: Date.now() });
  emit('schedule.updated', { schedule: Schedules.get(schedule.id) });
  return started;
}

export function tick(cfg, now = Date.now()) {
  for (const s of Schedules.enabled()) {
    const due = lastDue(s.time, s.days, now);
    if (!due || (s.last_run_at && s.last_run_at >= due)) continue;
    const agent = Agents.get(s.agent_id);
    if (!agent) { Schedules.remove(s.id); continue; }
    if (agent.status === 'working' || agent.status === 'needs_attention') continue; // retry within the grace window
    try {
      runSchedule(s, cfg);
    } catch (e) {
      console.error(`[schedule ${s.id}]`, e.message);
      const m = Messages.add(agent.id, 'error', `예약 실행 실패: ${e.message}`);
      emit('message', { agent_id: agent.id, message: m });
      Schedules.update(s.id, { last_run_at: now });
    }
  }
  const digest = digestSettings();
  if (digest.enabled) {
    const due = lastDue(digest.time, '', now);
    if (due && digest.last_sent !== localDate(new Date(due))) {
      sendDigestPush(localDate(new Date(due))).catch((e) => console.error('[digest]', e.message));
    }
  }
  try { backupIfDue(cfg, now); } catch (e) { console.error('[backup]', e.message); }
  try { flushHeldIfMorning(now); } catch (e) { console.error('[quiet]', e.message); }
  try { tickProgress(now); } catch (e) { console.error('[progress]', e.message); }
}

/** 방해금지 시간이 끝나면 참아 둔 알림을 한 장으로 모아 보낸다. */
export function flushHeldIfMorning(now = Date.now()) {
  if (isQuietNow(now)) return false;
  const held = heldNotifications();
  if (!held.length) return false;
  clearHeld();
  sendPush(heldSummary(held)).catch((e) => console.error('[quiet]', e.message));
  return true;
}

export function startScheduler(cfg) {
  const timer = setInterval(() => { try { tick(cfg); } catch (e) { console.error('[scheduler]', e.message); } }, 30_000);
  timer.unref();
  return timer;
}
