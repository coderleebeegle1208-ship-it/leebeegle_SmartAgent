// Loads/creates data/config.json: access token, VAPID keys, port.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { DATA_DIR } from './paths.js';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  let changed = false;
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    changed = true;
  }
  if (!cfg.internalToken) {
    cfg.internalToken = crypto.randomBytes(24).toString('base64url');
    changed = true;
  }
  if (!cfg.vapid) {
    cfg.vapid = webpush.generateVAPIDKeys();
    changed = true;
  }
  if (!cfg.port) {
    cfg.port = 3000;
    changed = true;
  }
  if (cfg.subagentModel === undefined) {
    cfg.subagentModel = 'haiku'; // set to "" to let subagents use the main model
    changed = true;
  }
  if (cfg.compactAfterTokens === undefined) {
    cfg.compactAfterTokens = 300_000; // context size (tokens read per turn) that triggers 대화 정리; 0 = off
    changed = true;
  }
  if (!cfg.pushSubject) {
    cfg.pushSubject = 'mailto:admin@localhost';
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
