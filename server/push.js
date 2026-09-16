// Web Push notifications (VAPID). Subscriptions are stored in SQLite.
// 모든 폰 알림이 이 한 곳을 지난다: 방해금지 시간이면 참아 두고, 아니면 웹 푸시와
// 등록된 메신저(텔레그램)로 함께 보낸다.
import webpush from 'web-push';
import { PushSubs } from './db.js';
import { isQuietNow, holdNotification } from './quiet.js';

let ready = false;
const sinks = []; // (payload) => Promise — 텔레그램 등 추가 전달 경로

export function initPush(cfg) {
  webpush.setVapidDetails(cfg.pushSubject, cfg.vapid.publicKey, cfg.vapid.privateKey);
  ready = true;
}
export function addPushSink(fn) { sinks.push(fn); }

/** 웹 푸시만 (방해금지·메신저 무시). 아침 요약 발송처럼 직접 보낼 때 쓴다. */
export async function sendWebPush(payload) {
  if (!ready) return;
  const subs = PushSubs.all();
  const { approval, long, ...rest } = payload; // 승인 버튼·보고 전문은 메신저 전용
  const body = JSON.stringify(rest);
  await Promise.all(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription_json), body, { TTL: 60 * 60 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          PushSubs.remove(row.endpoint);
        } else {
          console.error('[push] failed:', err.statusCode || err.message);
        }
      }
    })
  );
}

export async function sendPush(payload, { urgent = false } = {}) {
  if (!urgent && isQuietNow()) {
    holdNotification(payload);
    return { held: true };
  }
  await Promise.all([
    sendWebPush(payload),
    ...sinks.map((fn) => Promise.resolve().then(() => fn(payload)).catch((e) => console.error('[push sink]', e.message))),
  ]);
  return { held: false };
}
