// Totals that don't add up: finds a column that equals A × B in almost every row (total = quantity × price),
// then flags the rows where it doesn't and offers to recalculate. Which side is wrong is the user's call.
import type { Finding, TableData } from '../types';
import { column } from '../columns';
import { formatAmount, type DecimalSep } from '../numbers';
import { suspiciousValues } from './suspicious';

export interface TotalsParams {
  /** Share of complete rows that must satisfy C = A × B before we treat it as a rule. */
  minShare: number;
  minRows: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);

interface Relation {
  a: number;
  b: number;
  c: number;
  share: number;
  complete: number;
}

/** Find the best "c = a × b" among numeric columns. */
export function findProductRelation(table: TableData, numericCols: number[], params: TotalsParams): Relation | null {
  const nums = new Map(numericCols.map((c) => [c, column(table, c).map((x) => (typeof x.v === 'number' ? x.v : null))]));
  let best: Relation | null = null;
  for (const c of numericCols) {
    for (const a of numericCols) {
      for (const b of numericCols) {
        if (a >= b || a === c || b === c) continue;
        const [va, vb, vc] = [nums.get(a)!, nums.get(b)!, nums.get(c)!];
        let complete = 0;
        let ok = 0;
        for (let r = 0; r < va.length; r++) {
          const x = va[r];
          const y = vb[r];
          const z = vc[r];
          if (x === null || y === null || z === null || (x === 0 && y === 0)) continue;
          complete++;
          if (close(x * y, z)) ok++;
        }
        if (complete < params.minRows) continue;
        const share = ok / complete;
        if (share >= params.minShare && (!best || share > best.share)) best = { a, b, c, share, complete };
      }
    }
  }
  return best;
}

export function checkTotals(table: TableData, numericCols: number[], params: TotalsParams, dec: DecimalSep | null): Finding[] {
  const rel = findProductRelation(table, numericCols, params);
  if (!rel) return [];
  const [A, B, Cn] = [rel.a, rel.b, rel.c].map((i) => table.headers[i]);
  const va = column(table, rel.a);
  const vb = column(table, rel.b);
  const vc = column(table, rel.c);

  const wrong: { row: number; expected: number; actual: number; a: number; b: number }[] = [];
  const missing: { row: number; expected: number }[] = [];
  va.forEach((x, r) => {
    const a = x.v;
    const b = vb[r].v;
    const c = vc[r].v;
    if (typeof a !== 'number' || typeof b !== 'number') return;
    const expected = round2(a * b);
    if (typeof c === 'number') {
      if (!close(a * b, c)) wrong.push({ row: r, expected, actual: c, a, b });
    } else if (c === null || c === '') missing.push({ row: r, expected });
  });

  const findings: Finding[] = [];
  const rule = `${Cn} = ${A} × ${B} in ${Math.round(rel.share * 100)}% of rows`;
  // Rows where A or B is a stand-in (999999.99, 0.01): there the total is probably right and the input is wrong,
  // so "recalculate the total" must not touch them.
  const standInA = new Set([...suspiciousValues(table, rel.a).values()].flat());
  const standInB = new Set([...suspiciousValues(table, rel.b).values()].flat());
  if (wrong.length) {
    const diff = wrong.reduce((s, w) => s + (w.actual - w.expected), 0);
    // Rows where A or B is a stand-in (999999.99, 0.01, 99999): there the total is probably right and the input
    // is wrong, so "recalculate the total" leaves them alone and they get their own fix: input = total ÷ the other.
    const plain = wrong.filter((w) => !standInA.has(w.row) && !standInB.has(w.row));
    const badB = wrong.filter((w) => standInB.has(w.row) && !standInA.has(w.row) && w.a !== 0);
    const badA = wrong.filter((w) => standInA.has(w.row) && !standInB.has(w.row) && w.b !== 0);
    const ex = plain[0] ?? wrong[0];
    const nStand = wrong.length - plain.length;
    const standInFix = [
      ...badB.map((w) => ({ row: w.row, col: rel.b, value: round2(w.actual / w.a) })),
      ...badA.map((w) => ({ row: w.row, col: rel.a, value: round2(w.actual / w.b) })),
    ];
    const rowNo = (r: number) => table.firstRow + r + 1;
    const groups = [
      ...(plain.length ? [{ key: `total doesn't match`, rows: plain.map((w) => w.row), note: '"Recalculate" fixes these' }] : []),
      ...(badB.length
        ? [{ key: `${B} is a stand-in`, rows: badB.map((w) => w.row), note: `e.g. row ${rowNo(badB[0].row)}: ${B} ${badB[0].b}, total ${formatAmount(badB[0].actual, dec)} → ${B} ${round2(badB[0].actual / badB[0].a)}` }]
        : []),
      ...(badA.length
        ? [{ key: `${A} is a stand-in`, rows: badA.map((w) => w.row), note: `e.g. row ${rowNo(badA[0].row)}: ${A} ${badA[0].a} → ${round2(badA[0].actual / badA[0].b)}` }]
        : []),
    ];
    findings.push({
      id: `totals:${Cn}`,
      check: 'totals',
      severity: 'high',
      column: Cn,
      title: `${wrong.length} ${Cn} value${wrong.length > 1 ? "s don't" : " doesn't"} match ${A} × ${B}`,
      detail:
        `${rule}, but not in these. E.g. row ${rowNo(ex.row)}: ${ex.a} × ${ex.b} = ${formatAmount(ex.expected, dec)}, sheet says ${formatAmount(ex.actual, dec)}. ` +
        `Together they add ${formatAmount(diff, dec)} to the ${Cn} total.` +
        (nStand
          ? ` In ${nStand} rows the problem is a stand-in ${badA.length ? `${A} or ` : ''}${B} (like 999999.99), not the total: "Recalculate ${Cn}" skips those, and "Fix stand-ins from ${Cn}" corrects the input instead.`
          : '') +
        ` If you trust the totals everywhere, use "Recalculate ${B}".`,
      cells: wrong.map((w) => ({ row: w.row, col: rel.c })),
      groups,
      fix: plain.length
        ? {
            kind: 'setValues',
            label: `Recalculate ${Cn} (${plain.length})`,
            values: plain.map((w) => ({ row: w.row, col: rel.c, value: w.expected })),
          }
        : undefined,
      altFixes: [
        ...(standInFix.length
          ? [{ kind: 'setValues' as const, label: `Fix stand-ins from ${Cn} (${standInFix.length})`, values: standInFix }]
          : []),
        ...(wrong.some((w) => w.a !== 0)
          ? [
              {
                kind: 'setValues' as const,
                label: `Recalculate ${B} = ${Cn} ÷ ${A} (${wrong.filter((w) => w.a !== 0).length})`,
                values: wrong.filter((w) => w.a !== 0).map((w) => ({ row: w.row, col: rel.b, value: round2(w.actual / w.a) })),
              },
            ]
          : []),
      ],
    });
  }
  if (missing.length) {
    findings.push({
      id: `totalsMissing:${Cn}`,
      check: 'totals',
      severity: 'medium',
      column: Cn,
      title: `${missing.length} blank ${Cn} value${missing.length > 1 ? 's' : ''} can be calculated`,
      detail: `${rule}, so a blank ${Cn} can be filled from ${A} × ${B}.`,
      cells: missing.map((m) => ({ row: m.row, col: rel.c })),
      fix: {
        kind: 'setValues',
        label: `Calculate ${missing.length}`,
        values: missing.map((m) => ({ row: m.row, col: rel.c, value: m.expected })),
      },
    });
  }
  return findings;
}
