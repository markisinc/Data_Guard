// Numbers that look like stand-ins rather than real values: 999999.99, 9999, 0.01 repeated hundreds of times.
// Systems and people type these when the real value is unknown; they quietly wreck totals and averages.
import type { Finding, TableData } from '../types';
import { column } from '../columns';
import { pushTo } from '../util';

const ALL_NINES = /^9{4,}(\.9+)?$/;

export function suspiciousValues(table: TableData, col: number): Map<number, number[]> {
  const byValue = new Map<number, number[]>();
  column(table, col).forEach((c, row) => {
    if (typeof c.v === 'number') pushTo(byValue, c.v, row);
  });
  const total = [...byValue.values()].reduce((n, r) => n + r.length, 0);
  const out = new Map<number, number[]>();
  if (total < 50) return out;
  for (const [v, rows] of byValue) {
    if (ALL_NINES.test(String(Math.abs(v)))) {
      out.set(v, rows);
      continue;
    }
    if (rows.length < Math.max(10, total * 0.002) || v <= 0) continue;
    const others = [...byValue.entries()].filter(([k]) => k !== v && k > 0).flatMap(([k, r]) => r.map(() => k)).sort((a, b) => a - b);
    if (others.length < 20) continue;
    const p5 = others[Math.floor(others.length * 0.05)];
    const p95 = others[Math.floor(others.length * 0.95)];
    if (v >= p95 * 10 || v <= p5 / 10) out.set(v, rows);
  }
  return out;
}

export function checkSuspicious(table: TableData, col: number): Finding[] {
  const header = table.headers[col];
  const hits = suspiciousValues(table, col);
  if (!hits.size) return [];
  const list = [...hits.entries()].sort((a, b) => b[1].length - a[1].length);
  const n = list.reduce((s, [, r]) => s + r.length, 0);
  return [
    {
      id: `suspicious:${header}`,
      check: 'suspicious',
      severity: 'medium',
      column: header,
      title: `${n} ${header} value${n > 1 ? 's look' : ' looks'} like stand-ins, not real values`,
      detail: `${list.map(([v, r]) => `${v} ×${r.length}`).join(', ')}: far outside the usual range and repeated, typical of a placeholder typed when the real value was unknown. They distort totals and averages. There's no way to know the real value from the sheet, so these need checking at the source.`,
      cells: list.flatMap(([, rows]) => rows.map((row) => ({ row, col }))),
      groups: list.map(([v, rows]) => ({ key: String(v), rows })),
    },
  ];
}
