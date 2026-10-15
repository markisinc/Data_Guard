// Values that should be personal (an email, a phone, a name) but are shared by many different customers:
// "wrong.user999@unrelated.org" on 167 customers is a default or test value, not data. Plus malformed emails.
import type { Finding, TableData } from '../types';
import { column, isMissing, normaliseKey } from '../columns';
import { foldText } from './variants';
import { pushTo } from '../util';

export interface RepeatedParams {
  /** A value must be on at least this many different IDs (or rows, without an ID column)... */
  minSpread: number;
  /** ...and this many times more than a typical value. */
  timesTypical: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * @param refCol a column identifying the entity (customer_id), or -1. With it, "spread" counts distinct IDs,
 *               so a customer's own email repeated on all their orders is fine.
 */
export function checkRepeated(table: TableData, col: number, refCol: number, params: RepeatedParams): Finding[] {
  const header = table.headers[col];
  const cells = column(table, col);
  const ref = refCol >= 0 ? column(table, refCol) : null;
  const rowsBy = new Map<string, number[]>();
  const idsBy = new Map<string, Set<string>>();
  const raw = new Map<string, string>();
  let texts = 0;
  let nonMissing = 0;
  cells.forEach((c, row) => {
    if (isMissing(c)) return;
    nonMissing++;
    if (typeof c.v !== 'string') return;
    texts++;
    const k = foldText(c.v);
    pushTo(rowsBy, k, row);
    if (!raw.has(k)) raw.set(k, c.v.trim());
    if (ref && !isMissing(ref[row])) {
      const s = idsBy.get(k) ?? new Set<string>();
      s.add(normaliseKey(ref[row].v));
      idsBy.set(k, s);
    }
  });
  // Only "personal" text columns: mostly text, and many different values (not a category like "Completed").
  if (texts < 50 || texts / Math.max(nonMissing, 1) < 0.8 || rowsBy.size < texts * 0.02 || rowsBy.size < 30) return [];
  // Without an ID column we can't tell "one customer, many orders" from "one fake value", so only judge columns
  // where most values are unique (emails, phones), not categories like District.
  if (!ref && rowsBy.size < texts * 0.5) return [];

  const spread = (k: string) => (ref ? idsBy.get(k)?.size ?? 0 : rowsBy.get(k)!.length);
  const typical = Math.max(1, median([...rowsBy.keys()].map(spread)));
  const hits = [...rowsBy.keys()]
    .filter((k) => spread(k) >= Math.max(params.minSpread, typical * params.timesTypical))
    .sort((a, b) => spread(b) - spread(a));
  if (!hits.length) return [];

  const unit = ref ? `different ${table.headers[refCol]}s` : 'rows';
  const n = hits.reduce((s, k) => s + rowsBy.get(k)!.length, 0);
  return [
    {
      id: `repeated:${header}`,
      check: 'repeated',
      severity: 'medium',
      column: header,
      title: `${hits.length} ${header} value${hits.length > 1 ? 's are' : ' is'} shared by far too many records`,
      detail:
        `${hits.slice(0, 3).map((k) => `"${raw.get(k)}" on ${spread(k)} ${unit}`).join(', ')}. A ${header} is normally ` +
        `one per record (typically ${typical}), so these look like defaults or test values typed in place of the real one. ` +
        `Clearing them lets "fill from the same ID" put the right value back where it's known.`,
      cells: hits.flatMap((k) => rowsBy.get(k)!.map((row) => ({ row, col }))),
      groups: hits.map((k) => ({ key: raw.get(k)!, rows: rowsBy.get(k)!, note: `${spread(k)} ${unit}` })),
      fix: { kind: 'setValues', label: `Clear ${n}`, values: hits.flatMap((k) => rowsBy.get(k)!.map((row) => ({ row, col, value: null }))) },
    },
  ];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const isEmailColumn = (h: string) => /e-?mail|correo/i.test(h);

/** Malformed emails ("liam.gomez40@", "ana@gmail") in a column named like an email column. */
export function checkEmails(table: TableData, col: number): Finding[] {
  const header = table.headers[col];
  if (!isEmailColumn(header)) return [];
  const bad: { row: number; raw: string; reason: string }[] = [];
  let checked = 0;
  column(table, col).forEach((c, row) => {
    if (isMissing(c) || typeof c.v !== 'string') return;
    checked++;
    const v = c.v.trim();
    if (EMAIL.test(v)) return;
    const reason = !v.includes('@') ? 'no @' : v.endsWith('@') ? 'nothing after @' : /\s/.test(v) ? 'contains spaces' : !/\.[A-Za-z]{2,}$/.test(v) ? 'no domain ending (.com, .ar…)' : 'other format';
    bad.push({ row, raw: c.v, reason });
  });
  if (!bad.length || checked < 10) return [];
  const byReason = new Map<string, typeof bad>();
  for (const b of bad) pushTo(byReason, b.reason, b);
  return [
    {
      id: `email:${header}`,
      check: 'repeated',
      severity: 'medium',
      column: header,
      title: `${bad.length} ${header} value${bad.length > 1 ? 's are' : ' is'} not a valid email address`,
      detail: `${[...byReason.entries()].map(([r, l]) => `${r} ×${l.length}`).join(', ')}, e.g. "${bad[0].raw}". Emails sent to these will bounce.`,
      cells: bad.map((b) => ({ row: b.row, col })),
      groups: [...byReason.entries()].map(([r, l]) => ({ key: r, rows: l.map((x) => x.row), note: `e.g. ${l.slice(0, 2).map((x) => `"${x.raw}"`).join(', ')}` })),
      fix: { kind: 'setValues', label: `Clear ${bad.length}`, values: bad.map((b) => ({ row: b.row, col, value: null })) },
    },
  ];
}
