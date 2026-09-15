// Web Push notifications (VAPID). Subscriptions are stored in SQLite.
import webpush from 'web-push';
import { PushSubs } from './db.js';

let ready = false;

export function initPush(cfg) {
  webpush.setVapidDetails(cfg.pushSubject, cfg.vapid.publicKey, cfg.vapid.privateKey);
  ready = true;
}

export async function sendPush(payload) {
  if (!ready) return;
  const subs = PushSubs.all();
  const body = JSON.stringify(payload);
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
