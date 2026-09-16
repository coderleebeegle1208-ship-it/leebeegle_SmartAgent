// 한 작업(지시 한 번)의 비용·반복 감시. 알림 선을 넘으면 알리기만 하고 계속 진행, 멈춤 선을 넘거나
// 같은 도구 호출을 계속 되풀이하면 멈추고 폰에 묻는다. 순수 로직만 두고 실행/알림은 runners가 한다.
import { estimateCost } from './tokens.js';

export const WATCH_DEFAULTS = { runAlertUsd: 10, runStopUsd: 30, loopRepeatLimit: 8 };

export function watchLimits(cfg) {
  const n = (v, d) => (v === 0 ? 0 : Number(v) || d);
  return {
    alertUsd: n(cfg?.runAlertUsd, WATCH_DEFAULTS.runAlertUsd),
    stopUsd: n(cfg?.runStopUsd, WATCH_DEFAULTS.runStopUsd),
    loopRepeat: n(cfg?.loopRepeatLimit, WATCH_DEFAULTS.loopRepeatLimit),
  };
}

function toolSignature(name, input) {
  // 같은 도구를 같은 내용으로 부르는지만 본다. 내용이 길면 앞부분만으로도 충분히 구분된다.
  let s = '';
  try { s = JSON.stringify(input ?? {}); } catch { s = String(input); }
  return `${name}:${s.slice(0, 600)}`;
}

/** 한 작업용 감시자. feed()에 담당자가 보내는 진행 정보를 넣으면 알림/멈춤 판정을 돌려준다. */
export function createRunWatch(limits) {
  const lim = { ...WATCH_DEFAULTS, alertUsd: WATCH_DEFAULTS.runAlertUsd, stopUsd: WATCH_DEFAULTS.runStopUsd, loopRepeat: WATCH_DEFAULTS.loopRepeatLimit, ...limits };
  const seenMsg = new Set();
  const calls = new Map(); // signature -> count
  const w = { cost: 0, unknownCost: false, toolCalls: 0, alerted: false, stopped: null };

  w.feed = ({ msgId, model, usage, tools } = {}) => {
    if (w.stopped) return null;
    if (usage && msgId && !seenMsg.has(msgId)) {
      seenMsg.add(msgId);
      const c = estimateCost(model, usage);
      if (c == null) w.unknownCost = true; else w.cost += c;
    }
    for (const t of tools || []) {
      w.toolCalls += 1;
      const sig = toolSignature(t.name, t.input);
      const n = (calls.get(sig) || 0) + 1;
      calls.set(sig, n);
      if (lim.loopRepeat && n >= lim.loopRepeat) {
        w.stopped = { kind: 'stop', reason: 'loop', tool: t.name, repeats: n, cost: w.cost };
        return w.stopped;
      }
    }
    if (lim.stopUsd && w.cost >= lim.stopUsd) {
      w.stopped = { kind: 'stop', reason: 'budget', cost: w.cost };
      return w.stopped;
    }
    if (lim.alertUsd && !w.alerted && w.cost >= lim.alertUsd) {
      w.alerted = true;
      return { kind: 'alert', cost: w.cost };
    }
    return null;
  };
  return w;
}

const usd = (v) => `$${v.toFixed(2)}`;

/** 폰에 보일 문장. */
export function describeVerdict(v, limits) {
  if (v.kind === 'alert') {
    return `비용 알림 · 이 작업이 ${usd(v.cost)}를 넘었습니다. 계속 진행합니다 (${usd(limits.stopUsd)}를 넘으면 멈추고 묻습니다)`;
  }
  if (v.reason === 'loop') {
    return `같은 시도(${v.tool})를 ${v.repeats}번 되풀이해서 멈췄습니다 · 지금까지 ${usd(v.cost)}. 계속하려면 "계속해줘"라고 보내거나 방향을 알려주세요.`;
  }
  return `이 작업이 ${usd(limits.stopUsd)}를 넘어 멈췄습니다 · 지금까지 ${usd(v.cost)}. 계속하려면 "계속해줘"라고 보내주세요.`;
}
