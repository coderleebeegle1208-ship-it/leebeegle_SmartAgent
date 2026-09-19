// One source of truth for the model names the phone UI offers.
//
// An alias ("fable") always resolves to whatever the installed Claude CLI considers newest, so it
// silently changes when the CLI updates; an explicit id ("claude-fable-5-1") is pinned. Both are
// offered, and the app shows which concrete version an alias actually resolved to on the last run.
export const MODEL_FAMILIES = [
  { alias: 'fable', name: 'Fable', versions: [['claude-fable-5-1', '5.1'], ['claude-fable-5', '5']] },
  { alias: 'opus', name: 'Opus', versions: [['claude-opus-5', '5'], ['claude-opus-4-8', '4.8']] },
  { alias: 'sonnet', name: 'Sonnet', versions: [['claude-sonnet-5', '5'], ['claude-sonnet-4-6', '4.6'], ['claude-sonnet-4-5', '4.5']] },
  { alias: 'haiku', name: 'Haiku', versions: [['claude-haiku-4-5', '4.5']] },
];

/** Family order per pipeline stage: cheapest-first for triage, strongest-first for planning. */
const STAGE_FAMILIES = {
  triage: ['haiku', 'sonnet', 'opus', 'fable'],
  plan: ['fable', 'opus', 'sonnet'],
  exec: ['sonnet', 'opus', 'haiku'],
  manual: ['fable', 'opus', 'sonnet', 'haiku'],
};

const byAlias = Object.fromEntries(MODEL_FAMILIES.map((f) => [f.alias, f]));

/** [{ value, label, family, latest }] for one stage: each family's alias followed by its versions. */
export function stageOptions(stage) {
  const out = [];
  for (const alias of STAGE_FAMILIES[stage] || STAGE_FAMILIES.manual) {
    const f = byAlias[alias];
    if (!f) continue;
    out.push({ value: f.alias, label: `${f.name} 최신`, family: f.name, latest: true });
    for (const [value, v] of f.versions) out.push({ value, label: `${f.name} ${v}`, family: f.name, latest: false });
  }
  return out;
}

export const MODEL_CATALOG = Object.fromEntries(Object.keys(STAGE_FAMILIES).map((s) => [s, stageOptions(s)]));

// Codex is intentionally a single-model flow. These are the current non-deprecated
// choices advertised by the installed Codex client and official Codex model guide.
export const CODEX_MODEL_CATALOG = [
  { value: 'gpt-6-astra', label: 'Astra' },
  { value: 'gpt-5.6-sol', label: '5.6 Sol' },
  { value: 'gpt-5.6-terra', label: '5.6 Terra' },
  { value: 'gpt-5.6-luna', label: '5.6 Luna' },
  { value: 'gpt-5.5', label: '5.5' },
];

// Gemini via the Antigravity CLI (agy). agy names its models as "<family>-<thinking level>" slugs
// (gemini-3.8-flash-high, gemini-3.1-pro-low, claude-sonnet-4-6 …). The phone picks a family and an
// effort; geminiSlug() turns that into the slug agy accepts. The hand-written floor is today's
// `agy models` output; gemini-models.js re-reads that command when agy updates so a newer Pro/Flash
// shows up without a code change. Claude/GPT entries come through the same Google subscription.
const GEMINI_ALIASES = [
  { value: 'auto', label: '자동 (최신 Flash)' },
];
const GEMINI_BASE_SLUGS = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'], ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'], ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'], ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'], ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'], ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'], ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'],
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'], ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'], ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
];
let geminiFamilies = []; // [{ id, label, gemini, levels: { low?: slug, medium?: slug, high?: slug }, slug }]

/** gemini-3.1-pro-high → { version: 3.1, gen: 3, tier: 'Pro', tierRank: 0, level: 'high', base: 'gemini-3.1-pro' } (null for others). */
export function parseGeminiModel(value) {
  const m = String(value || '').match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)(?:-preview)?(?:-(low|medium|high))?$/);
  if (!m) return null;
  const tier = m[2] === 'pro' ? 'Pro' : m[2] === 'flash' ? 'Flash' : 'Flash Lite';
  return { version: parseFloat(m[1]), gen: Math.floor(parseFloat(m[1])), tier, tierRank: ['Pro', 'Flash', 'Flash Lite'].indexOf(tier), level: m[3] || null, base: `gemini-${m[1]}-${m[2]}`, preview: /-preview/.test(value) };
}
/** Newest generation first; inside a generation Pro → Flash → Flash Lite, each newest first. Non-Gemini last, in agy's order. */
function geminiOrder(a, b) {
  const pa = parseGeminiModel(a.id), pb = parseGeminiModel(b.id);
  if (pa && pb) return (pb.gen - pa.gen) || (pa.tierRank - pb.tierRank) || (pb.version - pa.version);
  if (pa) return -1;
  if (pb) return 1;
  return 0;
}
/** "Gemini 3.8 Flash (High)" → "3.8 Flash"; "Claude Sonnet 4.6 (Thinking)" → "Claude Sonnet 4.6". */
function cleanLabel(label, id) {
  const p = parseGeminiModel(id);
  if (p) return `${p.version} ${p.tier}`;
  return String(label || id).replace(/\s*\((?:low|medium|high|thinking)\)\s*$/i, '').trim() || id;
}
/** Merge `agy models` rows ([[slug, label], …]) into families the phone can pick from. Empty input → the floor. */
export function registerGeminiModels(rows) {
  const source = rows?.length ? rows : GEMINI_BASE_SLUGS;
  const byId = new Map();
  for (const row of source) {
    const [slug, label] = Array.isArray(row) ? row : [row, null];
    if (!slug || typeof slug !== 'string' || /\s/.test(slug)) continue;
    const p = parseGeminiModel(slug);
    const m = p ? null : slug.match(/^(.*)-(low|medium|high)$/);
    const id = p ? p.base : m ? m[1] : slug;
    const level = p ? p.level : m ? m[2] : null;
    const fam = byId.get(id) || { id, label: cleanLabel(label, id), gemini: !!p, levels: {}, slug: null };
    if (level) fam.levels[level] = slug; else fam.slug = slug;
    byId.set(id, fam);
  }
  geminiFamilies = [...byId.values()].sort(geminiOrder);
  return geminiFamilies.map((f) => f.id);
}
registerGeminiModels(GEMINI_BASE_SLUGS);

export function geminiModelCatalog() {
  return [...GEMINI_ALIASES, ...geminiFamilies.map((f) => ({ value: f.id, label: geminiModelLabel(f.id) }))];
}
// agy takes low / medium / high (Pro ships only high and low; medium rounds up).
export const GEMINI_EFFORTS = ['low', 'medium', 'high'];

function familyOf(value) {
  return geminiFamilies.find((f) => f.id === value || f.slug === value || Object.values(f.levels).includes(value)) || null;
}
export function isGeminiModelAllowed(value) {
  return GEMINI_ALIASES.some((o) => o.value === value) || geminiFamilies.some((f) => f.id === value);
}
export function geminiModelLabel(value) {
  const alias = GEMINI_ALIASES.find((o) => o.value === value);
  if (alias) return alias.label;
  const fam = familyOf(value);
  if (fam) return fam.gemini ? fam.label : `${fam.label} (Google)`;
  const p = parseGeminiModel(value);
  return p ? `${p.version} ${p.tier}` : value || '기본 모델';
}
/** The newest Gemini Flash family — what "auto" means. */
export function geminiNewestFlash() {
  return geminiFamilies.find((f) => f.gemini && parseGeminiModel(f.id).tier === 'Flash') || geminiFamilies.find((f) => f.gemini) || geminiFamilies[0] || null;
}
/** Family + effort → { model: slug for --model, effort: value for --effort or null }.
 *  Missing levels fall to the nearest one (medium → high → low, low → medium → high, high → medium → low). */
export function geminiSlug(value, effort) {
  const fam = !value || value === 'auto' ? geminiNewestFlash() : familyOf(value);
  if (!fam) return { model: value && value !== 'auto' ? value : null, effort: effort || null };
  const levels = Object.keys(fam.levels);
  if (!levels.length) return { model: fam.slug || fam.id, effort: effort || null };
  const wish = effort || 'medium';
  const order = { medium: ['medium', 'high', 'low'], low: ['low', 'medium', 'high'], high: ['high', 'medium', 'low'] }[wish] || ['medium', 'high', 'low'];
  const level = order.find((l) => fam.levels[l]);
  return { model: fam.levels[level], effort: null };
}
/** The next older family of the same tier (3.8 Flash → 3.7 Flash → 3.6 Flash), or "auto" when none is left.
 * Used when a pinned model turns out not to be enabled for the account. */
export function geminiFallbackModel(value) {
  const p = parseGeminiModel(value);
  if (!p) return value === 'auto' ? null : 'auto';
  const older = geminiFamilies.filter((f) => { const q = parseGeminiModel(f.id); return q && q.tier === p.tier && q.version < p.version; });
  return older[0]?.id || 'auto';
}
/** Auto (newest Flash) is the balanced default; pinning Pro is one tap away in the composer. */
export function geminiDefaults() {
  return { model: 'auto', effort: null };
}

export function isCodexModelAllowed(value) {
  return CODEX_MODEL_CATALOG.some((o) => o.value === value);
}

export function codexModelLabel(value) {
  return CODEX_MODEL_CATALOG.find((o) => o.value === value)?.label || value || '기본 모델';
}

/** App-owned defaults deliberately override a potentially expensive desktop setting.
 * Terra + medium is the balanced everyday path; harder work can still opt into Sol/high. */
export function codexDefaults() {
  return { model: 'gpt-5.6-terra', effort: 'medium' };
}

export function isModelAllowed(stage, value) {
  return (MODEL_CATALOG[stage] || []).some((o) => o.value === value);
}

/** Human label for an alias, an explicit id, or a raw id reported back by the CLI. */
export function modelLabel(value) {
  const codex = CODEX_MODEL_CATALOG.find((o) => o.value === value);
  if (codex) return codex.label;
  if (value === 'auto') return 'Gemini 자동';
  if (parseGeminiModel(value)) return `Gemini ${geminiModelLabel(value)}`;
  if (/^gemini-/.test(String(value))) return String(value).replace(/^gemini-/, 'Gemini ').replace('-preview', '');
  if (!value) return '기본 모델';
  for (const f of MODEL_FAMILIES) {
    if (f.alias === value) return `${f.name} 최신`;
    for (const [id, v] of f.versions) if (id === value) return `${f.name} ${v}`;
  }
  // Ids the CLI returns can carry a date suffix (claude-haiku-4-5-20251001).
  const m = String(value).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (m) {
    const fam = MODEL_FAMILIES.find((f) => f.alias === m[1]);
    return `${fam ? fam.name : m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  }
  // Claude/GPT models agy serves through the Google subscription.
  if (familyOf(value)) return geminiModelLabel(value);
  return String(value);
}

// $/1M tokens: [input, output, cacheRead, cacheWrite]. Anthropic first-party API rates
// (cached: 2026-06), used only to estimate what a subscription turn would have cost via the API.
export const MODEL_PRICES = {
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
  'claude-fable-5': [10, 50, 1, 12.5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
};

/** Resolves an alias ("fable"), a pinned id, or a date-suffixed CLI id to its price row, or null. */
export function priceFor(value) {
  if (!value) return null;
  if (MODEL_PRICES[value]) return MODEL_PRICES[value];
  const f = byAlias[value];
  if (f) {
    for (const [id] of f.versions) if (MODEL_PRICES[id]) return MODEL_PRICES[id];
    return null;
  }
  const m = String(value).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (m) {
    const id = `claude-${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
    if (MODEL_PRICES[id]) return MODEL_PRICES[id];
  }
  return null;
}
