// Per-turn token accounting: normalizes what each runner reports, estimates an API-rate cost for
// it, and rolls a pipeline run's stages into one summary with a "single-model baseline" comparison.
import { modelLabel, priceFor } from './models.js';

const STAGE_LABEL = { triage: '판단', plan: '계획', exec: '실행', manual: '실행' };

/** Claude stream-json `result` event -> { input, output, cacheRead, cacheWrite, cost }. */
export function normalizeClaudeUsage(ev) {
  const u = ev?.usage || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const modelUsage = ev?.modelUsage || {};
  const summed = Object.values(modelUsage).reduce((sum, m) => sum + (typeof m?.costUSD === 'number' ? m.costUSD : 0), 0);
  const cost = summed > 0 ? summed : typeof ev?.total_cost_usd === 'number' ? ev.total_cost_usd : null;
  return { input, output, cacheRead, cacheWrite, cost };
}

/** Codex `turn.completed` usage -> same shape. Codex reports cached tokens as part of input_tokens. */
export function normalizeCodexUsage(u) {
  u = u || {};
  const cacheRead = u.cached_input_tokens || 0;
  const input = Math.max(0, (u.input_tokens || 0) - cacheRead);
  const output = u.output_tokens || 0;
  return { input, output, cacheRead, cacheWrite: 0, cost: null };
}

/** Antigravity stream-json `result.usage` -> same shape. cache_read_tokens is the part of input_tokens served from cache. */
export function normalizeGeminiUsage(u) {
  u = u || {};
  const cacheRead = u.cache_read_tokens || u.cached || 0;
  const input = Math.max(0, (u.input_tokens || 0) - cacheRead);
  const output = u.output_tokens || 0;
  return { input, output, cacheRead, cacheWrite: 0, cost: null };
}

/** API-rate estimate for a usage row under a given model, or null if the model has no price row. */
export function estimateCost(model, u) {
  const price = priceFor(model);
  if (!price) return null;
  const [i, o, r, w] = price;
  return ((u.input || 0) * i + (u.output || 0) * o + (u.cacheRead || 0) * r + (u.cacheWrite || 0) * w) / 1e6;
}

/**
 * Rolls up one pipeline run's per-stage usage into totals plus a baseline comparison: what the
 * same tokens would have cost had every stage run on `baselineModel` instead.
 * @param {Array<{stage:string, phase?:string, provider:string, model:string|null, input:number, output:number, cacheRead:number, cacheWrite:number, cost:number|null}>} stages
 * @param {string|null} baselineModel
 */
export function summarizeRun(stages, baselineModel) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, fresh: 0, cost: null };
  let costKnown = false;
  const outStages = stages.map((s) => {
    total.input += s.input || 0;
    total.output += s.output || 0;
    total.cacheRead += s.cacheRead || 0;
    total.cacheWrite += s.cacheWrite || 0;
    total.tokens += (s.input || 0) + (s.output || 0) + (s.cacheRead || 0) + (s.cacheWrite || 0);
    // Same basis as the desktop app's "new tokens": what the model processed fresh, cache writes included.
    total.fresh += (s.input || 0) + (s.output || 0) + (s.cacheWrite || 0);
    const estimated = s.cost == null;
    const cost = estimated ? estimateCost(s.model, s) : s.cost;
    if (cost != null) {
      total.cost = (total.cost || 0) + cost;
      costKnown = true;
    }
    return { ...s, cost, costEstimated: estimated };
  });
  stages = outStages;
  if (!costKnown) total.cost = null;

  let baseline = null;
  let savedPct = null;
  if (baselineModel) {
    let baseCost = 0;
    let baseKnown = false;
    for (const s of stages) {
      const c = estimateCost(baselineModel, s);
      if (c != null) {
        baseCost += c;
        baseKnown = true;
      }
    }
    if (baseKnown) {
      baseline = { model: baselineModel, cost: baseCost };
      if (total.cost != null && baseCost > 0) savedPct = Math.round((1 - total.cost / baseCost) * 100);
    }
  }

  return { stages, total, baseline, savedPct };
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function fmtUsd(n) {
  if (n == null) return null;
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/** One-line summary for the collapsed card, e.g. "새 토큰 32.4k · 환산 $0.19 · Fable 단독 대비 61% 절약". */
/**
 * Headline broken into three non-overlapping buckets: "새 토큰" (input + output — what the model
 * actually read/wrote this turn), "캐시 저장" (cache writes — the one-time cost of re-memorizing a
 * conversation after a long pause or a model switch), and "다시 읽기" (cache reads — replaying
 * already-cached conversation, ~10x cheaper per token). The desktop app's "new tokens" figure is
 * "새 토큰" + "캐시 저장" combined (i.e. `total.fresh`).
 */
export function usageHeadline(summary) {
  const t = summary.total;
  const parts = [`새 토큰 ${fmtTokens((t.input || 0) + (t.output || 0))}`];
  if (t.cacheWrite) parts.push(`캐시 저장 ${fmtTokens(t.cacheWrite)}`);
  if (t.cacheRead) parts.push(`다시 읽기 ${fmtTokens(t.cacheRead)}`);
  const cost = fmtUsd(t.cost);
  if (cost) parts.push(`환산 ${cost}`);
  if (summary.savedPct != null && summary.savedPct > 0) {
    parts.push(`${modelLabel(summary.baseline.model)} 단독 대비 ${summary.savedPct}% 절약`);
  }
  return parts.join(' · ');
}

export { STAGE_LABEL, fmtTokens, fmtUsd };
