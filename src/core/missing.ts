// Placeholder values that mean "no data": N/A, NULL, "-", TBD, Excel errors like #N/A.
// Excel counts them as real values (COUNTA, pivot tables, duplicate checks), so they hide missing data.
import vocab from '../../config/vocab.json';
import type { Cell } from './types';

const TOKENS = new Set(vocab.missing.map((t) => t.toLowerCase()));

/** The placeholder text, normalised (e.g. "n/a"), or null if the cell isn't a placeholder. */
export function placeholderOf(c: Cell): string | null {
  if (typeof c.v !== 'string') return null;
  const t = c.v.trim().toLowerCase();
  return t && TOKENS.has(t) ? t : null;
}

export const isPlaceholder = (c: Cell) => placeholderOf(c) !== null;

/** Display form for a group of placeholders: the most common original spelling. */
export function summarisePlaceholders(cells: { raw: string }[]): { label: string; count: number }[] {
  const byNorm = new Map<string, Map<string, number>>();
  for (const { raw } of cells) {
    const norm = raw.trim().toLowerCase();
    const m = byNorm.get(norm) ?? new Map<string, number>();
    m.set(raw.trim(), (m.get(raw.trim()) ?? 0) + 1);
    byNorm.set(norm, m);
  }
  return [...byNorm.values()]
    .map((spellings) => {
      const count = [...spellings.values()].reduce((a, b) => a + b, 0);
      const label = [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { label, count };
    })
    .sort((a, b) => b.count - a.count);
}
