// ID format: learn the pattern most IDs follow ("TXN-" + 6 digits, or whole numbers 1..N) and flag the ones that don't.
// Variants are grouped by likely cause, and the safe ones (spaces, case, doubled separator) can be fixed in one click.
import type { DuplicateGroup, Finding, TableData } from '../types';
import { column, isMissing } from '../columns';
import { pushTo } from '../util';

export interface IdFormatParams {
  /** Share of IDs that must follow one pattern before we call it "the" format. */
  minShare: number;
  /** Don't infer a format from fewer IDs than this. */
  minValues: number;
}

/** "TXN-131154" -> "AAA-999999"; "txn-1" -> "aaa-9". */
export const shapeOf = (s: string) => s.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9');

/** Plain-words description of a shape: "AAA-999999" -> '3 capital letters, "-", 6 digits'. */
function describeShape(shape: string, prefix: string): string {
  if (prefix) {
    const rest = shape.slice(prefix.length);
    if (/^9+$/.test(rest)) return `"${prefix}" followed by ${rest.length} digits`;
  }
  const parts: string[] = [];
  for (const run of shape.match(/(A+|a+|9+|[^Aa9]+)/g) ?? []) {
    if (run[0] === 'A') parts.push(`${run.length} capital letter${run.length > 1 ? 's' : ''}`);
    else if (run[0] === 'a') parts.push(`${run.length} lower-case letter${run.length > 1 ? 's' : ''}`);
    else if (run[0] === '9') parts.push(`${run.length} digit${run.length > 1 ? 's' : ''}`);
    else parts.push(`"${run}"`);
  }
  return parts.join(', ');
}

function commonPrefix(values: string[]): string {
  if (!values.length) return '';
  let p = values[0].replace(/\d.*$/, ''); // letters/separators before the first digit
  for (const v of values) while (p && !v.startsWith(p)) p = p.slice(0, -1);
  return p;
}

export interface IdFormatResult {
  /** Plain-words format, e.g. '"TXN-" followed by 6 digits'. Null if no dominant format. */
  description: string | null;
  conforming: number;
  total: number;
  findings: Finding[];
}

export function checkIdFormat(table: TableData, col: number, params: IdFormatParams): IdFormatResult {
  const header = table.headers[col];
  const items: { row: number; raw: string; isNum: boolean }[] = [];
  column(table, col).forEach((c, row) => {
    if (isMissing(c)) return; // blanks and N/A are reported elsewhere
    const raw = typeof c.v === 'number' ? String(c.v) : String(c.v);
    items.push({ row, raw, isNum: typeof c.v === 'number' ? Number.isInteger(c.v) : /^\d+$/.test(raw) });
  });
  const none = { description: null, conforming: 0, total: items.length, findings: [] };
  if (items.length < params.minValues) return none;

  // --- Numeric IDs: 1, 2, 3 ... ---
  const nums = items.filter((i) => i.isNum && !/^0\d/.test(i.raw));
  if (nums.length / items.length >= params.minShare) {
    const vals = nums.map((n) => Number(n.raw));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const distinct = new Set(vals).size;
    const gaps = max - min + 1 - distinct;
    let asc = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1]) asc++;
    const ascending = vals.length > 1 && asc / (vals.length - 1) >= 0.99;
    const description =
      `whole numbers from ${min} to ${max}` +
      (gaps === 0 ? ', no gaps' : `, ${gaps} number${gaps > 1 ? 's' : ''} missing`) +
      (ascending ? ', in ascending order' : '');
    const findings: Finding[] = [];
    const odd = items.filter((i) => !(i.isNum && !/^0\d/.test(i.raw)));
    if (odd.length) findings.push(violations(header, col, odd.map((o) => ({ ...o, reason: 'not a whole number' })), description, nums.length, items.length));
    if (ascending && gaps > 0 && gaps <= distinct) {
      const present = new Set(vals);
      const missingNums: number[] = [];
      for (let v = min; v <= max && missingNums.length < 10; v++) if (!present.has(v)) missingNums.push(v);
      findings.push({
        id: `idGaps:${header}`,
        check: 'idFormat',
        severity: 'info',
        column: header,
        title: `${header} skips ${gaps} number${gaps > 1 ? 's' : ''}`,
        detail: `IDs run from ${min} to ${max} in order, but ${gaps} are missing (e.g. ${missingNums.slice(0, 6).join(', ')}). Often deleted or filtered-out rows; worth a look if rows shouldn't be removed.`,
        cells: [],
      });
    }
    return { description, conforming: nums.length, total: items.length, findings };
  }

  // --- Patterned IDs: "TXN-131154" ---
  const counts = new Map<string, number>();
  for (const i of items) counts.set(shapeOf(i.raw), (counts.get(shapeOf(i.raw)) ?? 0) + 1);
  const [domShape, domCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (domCount / items.length < params.minShare) return none;

  // The literal prefix ("TXN-") is the most common text before the first digit among same-shaped IDs,
  // so "ORD-116554" (same shape, other prefix) is still caught.
  const conformingRaw = items.filter((i) => shapeOf(i.raw) === domShape).map((i) => i.raw);
  const prefixCounts = new Map<string, number>();
  for (const r of conformingRaw) {
    const p = r.replace(/\d.*$/, '');
    prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  const [topPrefix, topCount] = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  let prefix = topCount / items.length >= params.minShare ? topPrefix : commonPrefix(conformingRaw);
  // Fixed segments like "FA-0001-" belong to the prefix too: extend to the last separator all main-format IDs share.
  const withPrefix = conformingRaw.filter((r) => r.startsWith(prefix));
  const shared = commonPrefix2(withPrefix);
  const cut = Math.max(shared.lastIndexOf('-'), shared.lastIndexOf('_'), shared.lastIndexOf('/'), shared.lastIndexOf('.'), shared.lastIndexOf(' '));
  if (cut + 1 > prefix.length && withPrefix.length / items.length >= params.minShare) prefix = shared.slice(0, cut + 1);
  const matches = (s: string) => shapeOf(s) === domShape && s.startsWith(prefix);
  const description = describeShape(domShape, prefix);

  const odd = items
    .filter((i) => !matches(i.raw))
    .map((i) => {
      const t = i.raw.trim();
      const up = t.toUpperCase();
      const collapsed = up.replace(/([^A-Z0-9])\1+/g, '$1');
      const digits = t.replace(/\D/g, '');
      const domDigits = domShape.replace(/[^9]/g, '').length;
      let reason: string;
      let canonical: string | null = null;
      if (t !== i.raw && matches(t)) [reason, canonical] = ['extra spaces', t];
      else if (matches(up)) [reason, canonical] = ['lower case', up];
      else if (matches(collapsed)) [reason, canonical] = ['doubled separator', collapsed];
      else if (/^\d+$/.test(t) && t.length === domDigits) reason = prefix ? `missing "${prefix}" prefix` : 'digits only';
      else if (digits.length === domDigits && /^[^\d]+/.test(t)) reason = `different prefix "${t.match(/^[^\d]+/)![0]}"`;
      else reason = 'other format';
      return { ...i, reason, canonical };
    });
  if (!odd.length) return { description, conforming: items.length, total: items.length, findings: [] };
  return {
    description,
    conforming: items.length - odd.length,
    total: items.length,
    findings: [violations(header, col, odd, description, items.length - odd.length, items.length)],
  };
}

function violations(
  header: string,
  col: number,
  odd: { row: number; raw: string; reason: string; canonical?: string | null }[],
  description: string,
  conforming: number,
  total: number,
): Finding {
  const byReason = new Map<string, typeof odd>();
  for (const o of odd) pushTo(byReason, o.reason, o);
  const groups: DuplicateGroup[] = [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([reason, list]) => ({
      key: reason,
      rows: list.map((l) => l.row),
      note: `e.g. ${list.slice(0, 3).map((l) => `"${l.raw}"`).join(', ')}`,
    }));
  const fixable = odd.filter((o) => o.canonical);
  const pct = Math.round((conforming / total) * 100);
  return {
    id: `idFormat:${header}`,
    check: 'idFormat',
    severity: 'medium',
    column: header,
    title: `${odd.length} ${header} value${odd.length > 1 ? 's don' : ' doesn'}'t follow the usual format`,
    detail:
      `${pct}% of IDs are ${description}. The rest: ` +
      groups.map((g) => `${g.key} ×${g.rows.length}`).join(', ') +
      '. Different formats can mean rows from another system, or the same ID written two ways (so lookups and de-duplication miss them).',
    cells: odd.map((o) => ({ row: o.row, col })),
    groups,
    fix: fixable.length
      ? {
          kind: 'setValues',
          label: `Fix ${fixable.length} (spaces, case, separators)`,
          values: fixable.map((f) => ({ row: f.row, col, value: f.canonical! })),
        }
      : undefined,
  };
}

/** Longest prefix shared by all values (digits included). */
function commonPrefix2(values: string[]): string {
  if (!values.length) return '';
  let p = values[0];
  for (const v of values) {
    let i = 0;
    while (i < p.length && i < v.length && p[i] === v[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}
