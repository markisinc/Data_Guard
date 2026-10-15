// Spelling variants in category-like columns: "Electronics", " Electronics  ", "ELECTRONICS", "Elecronics".
// Pivot tables and filters show each as its own category. Two kinds:
//   - same text once spaces, capitals and accents are ignored  -> certain, fix to the most common spelling
//   - a rare value one or two letters away from a common one   -> likely typo, suggested
import type { DuplicateGroup, Finding, TableData } from '../types';
import { column, isMissing } from '../columns';
import { pushTo } from '../util';

export interface VariantParams {
  /** Only columns with at most this many distinct values (or this share of rows) are treated as categories. */
  maxDistinct: number;
  maxDistinctShare: number;
  /** A value is "rare" when it's used less than this share of the value it resembles. */
  rareShare: number;
}

/** Compare key: trimmed, single spaces, lower case, no accents. */
export const foldText = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Optimal string alignment distance (Levenshtein + adjacent swaps), capped for speed. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

export function checkVariants(table: TableData, col: number, params: VariantParams): Finding[] {
  const header = table.headers[col];
  const cells = column(table, col);
  const texts: { row: number; raw: string }[] = [];
  let nonMissing = 0;
  cells.forEach((c, row) => {
    if (isMissing(c)) return;
    nonMissing++;
    if (typeof c.v === 'string' && /[A-Za-zÀ-ÿ]/.test(c.v)) texts.push({ row, raw: c.v });
  });
  if (texts.length < 20 || texts.length / Math.max(nonMissing, 1) < 0.8) return [];

  // Group by folded text; the canonical spelling is the most common raw form (preferring one without stray spaces).
  const byFold = new Map<string, Map<string, number[]>>();
  for (const t of texts) {
    const k = foldText(t.raw);
    const m = byFold.get(k) ?? new Map<string, number[]>();
    pushTo(m, t.raw, t.row);
    byFold.set(k, m);
  }
  if (byFold.size > Math.max(params.maxDistinct, texts.length * params.maxDistinctShare)) return [];

  const canonical = new Map<string, string>();
  const count = new Map<string, number>();
  for (const [k, spellings] of byFold) {
    const best = [...spellings.entries()].sort(
      (a, b) => b[1].length - a[1].length || Number(a[0] !== a[0].trim()) - Number(b[0] !== b[0].trim()),
    )[0][0];
    canonical.set(k, best.trim().replace(/\s+/g, ' '));
    count.set(k, [...spellings.values()].reduce((n, r) => n + r.length, 0));
  }

  const mapping: { from: string; to: string; rows: number[]; reason: string }[] = [];

  // 1. Same text apart from spaces / capitals / accents.
  for (const [k, spellings] of byFold) {
    const to = canonical.get(k)!;
    for (const [raw, rows] of spellings) if (raw !== to) mapping.push({ from: raw, to, rows, reason: describeDiff(raw, to) });
  }

  // 2. Likely typos: a rare folded value close to a much more common one.
  const folds = [...byFold.keys()].sort((a, b) => count.get(b)! - count.get(a)!);
  for (const rare of folds) {
    const n = count.get(rare)!;
    let best: { k: string; d: number } | null = null;
    for (const common of folds) {
      if (common === rare || count.get(common)! * params.rareShare < n) continue;
      if (digitsOf(common) !== digitsOf(rare)) continue; // "Size 10" vs "Size 11" are different things
      const limit = Math.min(common.length, rare.length) >= 8 ? 2 : 1;
      if (Math.min(common.length, rare.length) < 4) continue;
      const d = editDistance(rare, common, limit);
      if (d <= limit && (!best || d < best.d || (d === best.d && count.get(common)! > count.get(best.k)!))) best = { k: common, d };
    }
    if (!best) continue;
    const to = canonical.get(best.k)!;
    for (const [raw, rows] of byFold.get(rare)!) {
      // Replace any spaces/case mapping for this raw value with the typo mapping.
      const i = mapping.findIndex((m) => m.from === raw);
      if (i >= 0) mapping.splice(i, 1);
      mapping.push({ from: raw, to, rows, reason: `likely typo of "${to}"` });
    }
  }
  if (!mapping.length) return [];

  mapping.sort((a, b) => b.rows.length - a.rows.length);
  const total = mapping.reduce((n, m) => n + m.rows.length, 0);
  const typos = mapping.filter((m) => m.reason.startsWith('likely typo'));
  const groups: DuplicateGroup[] = mapping.map((m) => ({ key: `"${m.from}" → "${m.to}"`, rows: m.rows, note: m.reason }));
  const show = mapping.slice(0, 4).map((m) => `"${m.from}" → "${m.to}" ×${m.rows.length}`);

  return [
    {
      id: `variants:${header}`,
      check: 'variants',
      severity: 'medium',
      column: header,
      title: `${total} ${header} value${total > 1 ? 's are' : ' is'} spelled differently from the usual version`,
      detail:
        `Pivot tables and filters show each spelling as its own category: ${show.join(', ')}${mapping.length > 4 ? `, and ${mapping.length - 4} more` : ''}.` +
        (typos.length ? ` ${typos.length} are likely typos (one or two letters off a common value); check the list before applying.` : ''),
      cells: mapping.flatMap((m) => m.rows.map((row) => ({ row, col }))),
      groups,
      fix: {
        kind: 'setValues',
        label: `Standardise ${total}`,
        values: mapping.flatMap((m) => m.rows.map((row) => ({ row, col, value: m.to }))),
      },
      altFixes:
        typos.length && typos.length < mapping.length
          ? [
              {
                kind: 'setValues',
                label: 'Only spaces & capitals',
                values: mapping.filter((m) => !m.reason.startsWith('likely typo')).flatMap((m) => m.rows.map((row) => ({ row, col, value: m.to }))),
              },
            ]
          : undefined,
    },
  ];
}

function describeDiff(from: string, to: string): string {
  const parts: string[] = [];
  if (from.trim() !== from || /\s{2,}/.test(from)) parts.push('extra spaces');
  const a = from.trim().replace(/\s+/g, ' ');
  if (a.toLowerCase() !== to.toLowerCase()) parts.push('accents');
  else if (a !== to) parts.push('capitals');
  return parts.join(' + ') || 'spacing';
}
