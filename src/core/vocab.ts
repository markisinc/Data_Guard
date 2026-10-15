// Column-name vocabulary, shared with the schema profiler.
// Base words come from the profiler's vocab/default.yaml (config/vocab.shared.json, via `npm run sync-vocab`);
// config/vocab.json adds spreadsheet-only words. Matching follows the profiler's rules:
//   exact token (1.0) · token is the start of a longer word, e.g. "cant" → cantidad (0.6) · word hidden inside a
//   smushed name, e.g. "fechapedido" (0.6).
import shared from '../../config/vocab.shared.json';
import local from '../../config/vocab.json';

const c = shared.concepts as Record<string, string[]>;
// Percent words that can also name money columns ("descuento", "rate") are left out of "not a total".
const PERCENT_ONLY = (c.percent ?? []).filter((w) => !['dto', 'descuento', 'desconto', 'rate', 'tasa', 'taxa'].includes(w));

const uniq = (...lists: string[][]) => [...new Set(lists.flat())];

export const VOCAB = {
  key: uniq(c.identifier ?? [], local.extra.key),
  date: uniq(c.date ?? [], local.extra.date),
  measure: uniq(c.money ?? [], c.count ?? [], c.price ?? [], local.extra.measure),
  notMeasure: uniq(c.geo ?? [], c.postal ?? [], PERCENT_ONLY, local.extra.notMeasure),
  periodDate: local.periodDate,
  notPeriodDate: local.notPeriodDate,
};

/** Strength in [0, 1] that any of `tokens` names the concept described by `words`. */
export function hitStrength(tokens: string[], words: string[]): number {
  const set = new Set(words);
  let best = 0;
  for (const t of tokens) {
    if (set.has(t)) return 1;
    if (t.length >= 3 && words.some((w) => w.length >= 5 && w.startsWith(t))) best = Math.max(best, 0.6);
  }
  if (best === 0 && tokens.some((t) => words.some((w) => w.length >= 4 && w !== t && t.includes(w)))) best = 0.6;
  return best;
}
