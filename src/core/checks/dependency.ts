// Columns determined by an ID: every row for customer CUST-11260 should have the same name and email.
// When that holds for almost every ID, we can (a) fill missing values from the ID's other rows, and
// (b) flag IDs whose rows disagree ("same ID, different price").
import type { DuplicateGroup, Finding, TableData } from '../types';
import { column, isMissing, normaliseKey } from '../columns';
import { foldText } from './variants';

export interface DependencyParams {
  /** At least this many IDs must appear on 2+ rows with a value, to judge the relationship. */
  minGroups: number;
  /** Share of rows that match their ID's usual value, for the column to count as "determined by the ID". */
  minAgreement: number;
}

const valueKey = (v: unknown) => (typeof v === 'number' ? `n:${v}` : `s:${foldText(String(v))}`);

/** Ref columns: non-unique columns that identify something (customer_id, Cliente_ID, SKU). */
export function checkDependency(table: TableData, refCol: number, targetCol: number, params: DependencyParams): Finding[] {
  const ref = column(table, refCol);
  const target = column(table, targetCol);
  const refHeader = table.headers[refCol];
  const header = table.headers[targetCol];

  // For each ID: the values seen (with their original spellings) and rows missing a value.
  type Entry = { raw: string | number; rows: number[] };
  const groups = new Map<string, { values: Map<string, Entry>; missing: number[] }>();
  ref.forEach((c, row) => {
    if (isMissing(c)) return;
    const k = normaliseKey(c.v);
    const g = groups.get(k) ?? { values: new Map<string, Entry>(), missing: [] as number[] };
    const t = target[row];
    if (isMissing(t)) g.missing.push(row);
    else {
      const vk = valueKey(t.v);
      const e: Entry = g.values.get(vk) ?? { raw: typeof t.v === 'number' ? t.v : String(t.v).trim(), rows: [] };
      e.rows.push(row);
      g.values.set(vk, e);
    }
    groups.set(k, g);
  });

  const sorted = (g: { values: Map<string, Entry> }) => [...g.values.values()].sort((a, b) => b.rows.length - a.rows.length);
  const judged = [...groups.values()].filter((g) => [...g.values.values()].reduce((n, e) => n + e.rows.length, 0) >= 2);
  if (judged.length < params.minGroups) return [];
  // Row-level agreement: rows that match the most common value for their ID.
  let rowsJudged = 0;
  let rowsAgree = 0;
  for (const g of judged) {
    const vs = sorted(g);
    rowsJudged += vs.reduce((n, e) => n + e.rows.length, 0);
    rowsAgree += vs[0].rows.length;
  }
  const agreement = rowsAgree / rowsJudged;
  if (agreement < params.minAgreement) return [];
  // A value "wins" for an ID when it's the only one, or at least twice as common as the runner-up (5 vs 1, not 1 vs 1).
  const winner = (g: { values: Map<string, Entry> }) => {
    const vs = sorted(g);
    if (!vs.length) return null;
    return vs.length === 1 || (vs[0].rows.length >= 2 && vs[0].rows.length >= 2 * vs[1].rows.length) ? vs[0] : null;
  };

  const findings: Finding[] = [];
  const pct = `${Math.round(agreement * 100)}%`;

  // (a) Fill gaps from the ID's other rows.
  const fills: { row: number; value: string | number }[] = [];
  for (const g of groups.values()) {
    const w = g.missing.length ? winner(g) : null;
    if (w) for (const row of g.missing) fills.push({ row, value: w.raw });
  }
  if (fills.length) {
    const sample = fills.slice(0, 2).map((f) => `"${f.value}"`).join(', ');
    findings.push({
      id: `fillFromId:${header}`,
      check: 'consistency',
      severity: 'info',
      column: header,
      title: `${fills.length} missing ${header} value${fills.length > 1 ? 's' : ''} can be filled from other rows`,
      detail: `In ${pct} of rows, ${header} matches the usual value for its ${refHeader}, so a missing ${header} can be copied from other rows with the same ${refHeader} (e.g. ${sample}).`,
      cells: fills.map((f) => ({ row: f.row, col: targetCol })),
      fix: {
        kind: 'setValues',
        label: `Fill ${fills.length} from same ${refHeader}`,
        values: fills.map((f) => ({ row: f.row, col: targetCol, value: f.value })),
      },
    });
  }

  // (b) IDs whose rows disagree.
  const conflicts: DuplicateGroup[] = [];
  const corrections: { row: number; value: string | number }[] = [];
  for (const [k, g] of groups) {
    if (g.values.size < 2) continue;
    const vals = sorted(g);
    const w = winner(g);
    conflicts.push({
      key: k,
      rows: vals.flatMap((v) => v.rows),
      note: vals.slice(0, 3).map((v) => `"${v.raw}" ×${v.rows.length}`).join(' vs ') + (w ? '' : ' (no clear winner)'),
    });
    if (w) for (const v of vals.slice(1)) for (const row of v.rows) corrections.push({ row, value: w.raw });
  }
  if (conflicts.length) {
    conflicts.sort((a, b) => b.rows.length - a.rows.length);
    const odd = corrections.length;
    findings.push({
      id: `conflict:${header}`,
      check: 'consistency',
      severity: 'medium',
      column: header,
      title: `${conflicts.length} ${refHeader}${conflicts.length > 1 ? 's have' : ' has'} more than one ${header}`,
      detail:
        `In ${pct} of rows each ${refHeader} has one ${header}, but these disagree (e.g. ${conflicts[0].key}: ${conflicts[0].note}). ` +
        `Usually the odd one out is wrong${odd ? `; ${odd} row${odd > 1 ? 's' : ''} can be set to their ${refHeader}'s usual value` : ''}.`,
      cells: conflicts.flatMap((c) => c.rows.map((row) => ({ row, col: targetCol }))),
      groups: conflicts,
      fix: odd
        ? {
            kind: 'setValues',
            label: `Use the usual value (${odd})`,
            values: corrections.map((c) => ({ row: c.row, col: targetCol, value: c.value })),
          }
        : undefined,
    });
  }
  return findings;
}
