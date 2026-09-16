// Loads/creates data/config.json: access token, VAPID keys, port.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { DATA_DIR } from './paths.js';

const CONFIG_PATH = process.env.AGENT_REMOTE_CONFIG || path.join(DATA_DIR, 'config.json');

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
  if (!(Number(cfg.tokenOptimizationVersion) >= 2)) {
    // v1 capped runaway 200k/300k installs at 100k; v2 tightens further to 50k so every tool
    // call re-reads less of a growing conversation. An explicit 0 (off) stays respected.
    if (cfg.compactAfterTokens !== 0) {
      cfg.compactAfterTokens = Math.min(Number(cfg.compactAfterTokens) || 50_000, 50_000);
    }
    cfg.tokenOptimizationVersion = 2;
    changed = true;
  }
  if (cfg.tokenOptimizationVersion === 2) {
    // v3: the 50k cap rotated real conversations dozens of times a day, and every rotation loses
    // detail the owner then has to repeat. Triple it; a custom lower value or 0 (off) stays put.
    if (cfg.compactAfterTokens !== 0 && (!cfg.compactAfterTokens || Number(cfg.compactAfterTokens) === 50_000)) {
      cfg.compactAfterTokens = 150_000;
    }
    cfg.tokenOptimizationVersion = 3;
    changed = true;
  }
  if (cfg.approvalRemindMin === undefined) {
    cfg.approvalRemindMin = 10; // 승인 요청에 답이 없으면 이 시간 뒤 한 번 더 알림 (0 = 끔)
    cfg.approvalAutoMin = 20;   // 그래도 없으면 안전한 요청(읽기·작업 폴더 안 편집)만 자동 허용 (0 = 끔)
    changed = true;
  }
  if (cfg.runAlertUsd === undefined) {
    cfg.runAlertUsd = 10;      // 한 작업이 이 금액을 넘으면 알림만 (0 = 끔)
    cfg.runStopUsd = 30;       // 이 금액을 넘으면 멈추고 폰에 묻기 (0 = 끔)
    cfg.loopRepeatLimit = 8;   // 같은 도구 호출이 이만큼 되풀이되면 멈춤 (0 = 끔)
    changed = true;
  }
  if (cfg.planBudgetUsd === undefined) {
    cfg.planBudgetUsd = 0; // USD ceiling for the plan stage (Fable); 0 = no cap. Triage already
    changed = true;        // decides whether a plan runs at all, so quality shouldn't be capped once it does.
  }
  if (!cfg.pushSubject) {
    cfg.pushSubject = 'mailto:admin@localhost';
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
