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

export function isModelAllowed(stage, value) {
  return (MODEL_CATALOG[stage] || []).some((o) => o.value === value);
}

/** Human label for an alias, an explicit id, or a raw id reported back by the CLI. */
export function modelLabel(value) {
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
  return String(value);
}
