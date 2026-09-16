// 텔레그램 연동: 앱을 열지 않아도 보고·승인 요청이 메신저로 오고, 버튼으로 승인하거나
// 답장으로 새 지시를 보낼 수 있다. (카카오톡은 개인이 쓸 수 있는 공식 경로가 "나에게 보내기"
// 한 방향뿐이라 답장·버튼 승인이 불가능해 텔레그램을 썼다.)
//
// 연결 절차: BotFather에서 봇을 만들어 토큰을 앱 설정에 붙여넣기 → 앱이 보여주는 6자리 연결 번호를
// 그 봇에게 보내기 → 이후 그 대화로만 알림이 가고 그 대화의 메시지만 받는다.
// 외부 의존성 없이 Bot API를 long polling(getUpdates)으로 읽는다.
import { Settings, Agents, Approvals, Workspaces } from './db.js';
import { addPushSink } from './push.js';
import { resolveApproval } from './approvals.js';
import { startPrompt, enqueuePrompt } from './runners/index.js';
import { emit } from './bus.js';

const API = 'https://api.telegram.org';
let cfgRef = null;
let generation = 0; // 토큰이 바뀌면 이전 폴링 루프가 스스로 멈추도록
let offset = 0;

const token = () => Settings.get('tg_token') || '';
const chatId = () => Settings.get('tg_chat_id') || '';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(method, body, tok = token()) {
  if (!tok) throw new Error('텔레그램이 연결되지 않았습니다');
  const res = await fetch(`${API}/bot${tok}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `telegram ${method} failed (${res.status})`);
  return data.result;
}

export function telegramStatus() {
  return {
    configured: !!token(),
    linked: !!chatId(),
    bot: Settings.get('tg_bot_name') || null,
    pair_code: chatId() ? null : Settings.get('tg_pair_code') || null,
    last_agent: Number(Settings.get('tg_last_agent')) || null,
  };
}

/** 토큰을 저장하고 봇 이름을 확인한다. 아직 연결된 대화가 없으면 6자리 연결 번호를 만든다. */
export async function configureTelegram(botToken) {
  const tok = String(botToken || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(tok)) throw new Error('토큰 형식이 아닙니다. BotFather가 준 "숫자:영문" 형태를 그대로 붙여넣으세요');
  const me = await call('getMe', {}, tok);
  if (tok !== token()) { Settings.set('tg_chat_id', null); Settings.set('tg_last_agent', null); offset = 0; }
  Settings.set('tg_token', tok);
  Settings.set('tg_bot_name', me.username ? `@${me.username}` : me.first_name || 'bot');
  if (!chatId()) Settings.set('tg_pair_code', String(Math.floor(100000 + Math.random() * 900000)));
  startPolling();
  return telegramStatus();
}
export function unlinkTelegram() {
  generation += 1;
  for (const k of ['tg_token', 'tg_chat_id', 'tg_pair_code', 'tg_bot_name', 'tg_last_agent']) Settings.set(k, null);
  return telegramStatus();
}

/** 웹 푸시와 같은 내용을 텔레그램 대화에도 보낸다. 승인 요청이면 버튼을 붙인다. */
export async function sendTelegram(payload) {
  const chat = chatId();
  if (!chat) return;
  const agentId = Number((String(payload.url || '').match(/agent=(\d+)/) || [])[1]);
  if (agentId) Settings.set('tg_last_agent', String(agentId));
  const body = payload.long || payload.body || '';
  const text = `<b>${esc(payload.title || 'leebeegle_SmartAgent')}</b>\n${esc(body).slice(0, 3500)}`;
  const ap = payload.approval;
  let reply_markup;
  if (ap?.id && !ap.question) {
    const rows = [[{ text: '✅ 허용', callback_data: `ap:${ap.id}:allow` }, { text: '⛔ 거부', callback_data: `ap:${ap.id}:deny` }]];
    if (!ap.risk) rows.push([{ text: '이번 작업 동안 모두 허용', callback_data: `ap:${ap.id}:run` }]);
    reply_markup = { inline_keyboard: rows };
  } else if (ap?.question) {
    reply_markup = { inline_keyboard: [[{ text: '앱에서 답하기', url: appUrl(agentId) }]] };
  }
  await call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
}
function appUrl(agentId) {
  const base = (cfgRef?.publicUrl || '').replace(/\/$/, '') || `http://localhost:${cfgRef?.port || 3000}`;
  return `${base}/?agent=${agentId || ''}`;
}

/** 승인 버튼 → 앱의 승인 처리와 똑같이 동작한다. 순수하게 분리해 테스트에서 직접 부른다. */
export function handleCallbackData(data) {
  const m = /^ap:(\d+):(allow|deny|run)$/.exec(String(data || ''));
  if (!m) return { ok: false, text: '알 수 없는 버튼입니다' };
  const id = Number(m[1]);
  const ap = Approvals.get(id);
  if (!ap || ap.status !== 'pending') return { ok: false, text: '이미 처리된 요청입니다' };
  const decision = m[2] === 'deny' ? 'deny' : 'allow';
  const r = resolveApproval(id, decision, { scope: m[2] === 'run' ? 'run' : null, via: '텔레그램', ...(decision === 'deny' ? { message: '텔레그램에서 거부' } : {}) });
  if (!r) return { ok: false, text: '이미 처리된 요청입니다' };
  return { ok: true, text: decision === 'allow' ? (m[2] === 'run' ? '✅ 허용 · 이번 작업의 남은 요청도 모두 허용' : '✅ 허용했습니다') : '⛔ 거부했습니다' };
}

const wsName = (a) => Workspaces.get(a.workspace_id)?.name || '';
/** "프로젝트 › 담당자" — 텔레그램에서 어느 프로젝트로 가는지 한눈에 보이게 */
const who = (a) => `[${wsName(a)}] ${a.name}`;
function agentLine(a) {
  const st = { idle: '대기', working: '작업 중', needs_attention: '승인 필요', done: '완료', error: '오류' }[a.status] || a.status;
  return `#${a.id} ${who(a)} · ${st}`;
}

/** 텍스트 메시지 → 지시. 담당자는 마지막 알림을 보낸 에이전트(또는 /use 로 고른 것). */
export function handleText(text, { cfg = cfgRef } = {}) {
  const t = String(text || '').trim();
  if (!t) return '내용이 없습니다';
  const agents = Agents.all();
  if (/^\/(start|help|도움말)/.test(t)) {
    return ['leebeegle_SmartAgent 연결됨.', '- 그냥 글을 보내면 마지막으로 보고한 담당자에게 지시로 전달됩니다', '- /list 담당자 목록 (앞의 [ ]가 프로젝트)', '- /use 번호 : 지시 받을 담당자(프로젝트) 바꾸기', '- /who 지금 누구에게 가는지 확인', '- 승인 요청은 버튼으로 바로 답할 수 있습니다'].join('\n');
  }
  const cur = () => Agents.get(Number(Settings.get('tg_last_agent')));
  if (/^\/(list|목록)/.test(t)) {
    if (!agents.length) return '담당자가 없습니다. 앱에서 먼저 추가하세요.';
    const c = cur();
    return agents.map(agentLine).join('\n') + (c ? `\n\n지금 지시는 → ${who(c)}` : '');
  }
  if (/^\/(who|누구)/.test(t)) {
    const c = cur();
    return c ? `지금 지시는 ${who(c)} 에게 갑니다` : '아직 정해지지 않았습니다. /list 로 보고 /use 번호';
  }
  const use = /^\/use\s+#?(\d+)/.exec(t);
  if (use) {
    const a = Agents.get(Number(use[1]));
    if (!a) return '그 번호의 담당자가 없습니다';
    Settings.set('tg_last_agent', String(a.id));
    return `이제부터 ${who(a)} 에게 전달합니다`;
  }
  const target = Agents.get(Number(Settings.get('tg_last_agent'))) || (agents.length === 1 ? agents[0] : null);
  if (!target) return '누구에게 보낼지 정해주세요: /list 로 목록을 보고 /use 번호';
  try {
    if (target.status === 'working' || target.status === 'needs_attention') {
      const q = enqueuePrompt(target.id, t);
      return `${who(target)} 이(가) 작업 중이라 ${q.count}번째로 줄 세웠습니다. 끝나면 이어서 시작합니다.`;
    }
    startPrompt(target.id, t, cfg);
    return `${who(target)} 에게 전달했습니다. 끝나면 여기로 보고가 옵니다.`;
  } catch (e) {
    return `전달 실패: ${e.message}`;
  }
}

async function handleUpdate(u) {
  const chat = chatId();
  if (u.callback_query) {
    const cq = u.callback_query;
    if (String(cq.message?.chat?.id) !== chat) { await call('answerCallbackQuery', { callback_query_id: cq.id, text: '등록되지 않은 대화입니다' }).catch(() => {}); return; }
    const r = handleCallbackData(cq.data);
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: r.text }).catch(() => {});
    if (cq.message) {
      await call('editMessageText', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: `${cq.message.text ? esc(cq.message.text) : ''}\n\n${esc(r.text)}`, parse_mode: 'HTML',
      }).catch(() => {});
    }
    return;
  }
  const msg = u.message;
  if (!msg?.chat?.id) return;
  const from = String(msg.chat.id);
  const text = String(msg.text || '').trim();
  if (!chat) {
    const code = Settings.get('tg_pair_code');
    if (code && text === code) {
      Settings.set('tg_chat_id', from);
      Settings.set('tg_pair_code', null);
      emit('telegram.linked', telegramStatus());
      await call('sendMessage', { chat_id: from, text: '연결됐습니다. 이제 승인 요청과 완료 보고가 여기로 옵니다. 글을 보내면 담당자에게 지시로 전달됩니다. (/help)' });
    } else {
      await call('sendMessage', { chat_id: from, text: '앱 설정 화면에 나온 6자리 연결 번호를 보내주세요.' });
    }
    return;
  }
  if (from !== chat) return; // 다른 사람의 대화는 무시
  const reply = handleText(text);
  await call('sendMessage', { chat_id: from, text: reply });
}

async function poll(gen) {
  let backoff = 3000;
  while (gen === generation && token()) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      backoff = 3000;
      for (const u of updates) {
        offset = u.update_id + 1;
        if (gen !== generation) return;
        try { await handleUpdate(u); } catch (e) { console.error('[telegram] update', e.message); }
      }
    } catch (e) {
      if (gen !== generation) return;
      if (!/aborted|timeout/i.test(e.message)) console.error('[telegram] poll', e.message);
      await new Promise((r) => setTimeout(r, backoff).unref());
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}
export function startPolling() {
  generation += 1;
  if (!token()) return false;
  poll(generation).catch((e) => console.error('[telegram]', e.message));
  return true;
}

export function initTelegram(cfg) {
  cfgRef = cfg;
  addPushSink(sendTelegram);
  if (process.env.NODE_TEST_CONTEXT) return; // 테스트에서는 네트워크 폴링을 띄우지 않는다
  startPolling();
}
