// "오늘 한 일" — one-screen roll-up of what every agent did in a local day, for the phone card and
// the evening push. Built from stored messages/usage rows only, so it costs no model tokens.
import { dailyActivity } from './db.js';

const fmtTokens = (n) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`);
const fmtUsd = (n) => (n == null ? null : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local-day bounds for `date` ('YYYY-MM-DD'); defaults to today. */
export function dayBounds(date) {
  const start = date ? new Date(`${date}T00:00:00`) : new Date();
  if (Number.isNaN(start.getTime())) throw new Error('날짜 형식은 YYYY-MM-DD 입니다');
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { since: start.getTime(), until: end.getTime(), date: localDate(start) };
}

export function buildDigest(date) {
  const { since, until, date: day } = dayBounds(date);
  const rows = dailyActivity(since, until).map((r) => ({
    ...r,
    last_reply: (r.last_reply || '').replace(/\s+/g, ' ').slice(0, 160),
  }));
  const totals = rows.reduce((t, r) => ({
    requests: t.requests + r.requests,
    errors: t.errors + r.errors,
    files: t.files + r.files,
    fresh: t.fresh + (r.fresh || 0),
    cost: r.cost == null ? t.cost : (t.cost || 0) + r.cost,
  }), { requests: 0, errors: 0, files: 0, fresh: 0, cost: null });
  return { date: day, agents: rows, totals };
}

/** Push-sized text: totals on the first line, then one line per agent (most active first). */
export function digestPushText(digest) {
  const t = digest.totals;
  if (!digest.agents.length) return { title: '오늘 한 일 요약', body: '오늘은 지시한 작업이 없었습니다.' };
  const head = [`지시 ${t.requests}건`, t.files ? `파일 ${t.files}개 수정` : null, t.errors ? `오류 ${t.errors}건` : null, t.fresh ? `새 토큰 ${fmtTokens(t.fresh)}` : null, fmtUsd(t.cost)]
    .filter(Boolean).join(' · ');
  const lines = [...digest.agents].sort((a, b) => b.requests - a.requests).slice(0, 3)
    .map((a) => `${a.name}: ${a.requests}건${a.last_reply ? ` — ${a.last_reply.slice(0, 40)}` : ''}`);
  return { title: `오늘 한 일 요약 · 에이전트 ${digest.agents.length}개`, body: [head, ...lines].join('\n').slice(0, 180) };
}
