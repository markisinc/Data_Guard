// Column helpers and setup suggestions (key column, date column, measures).
// Suggestions only: the user confirms them once and the choice is remembered in the workbook.
import { VOCAB as vocab, hitStrength } from './vocab';
import type { Cell, TableData } from './types';
import { dateShare, inferDateOrder, type DateOrder } from './dates';
import { inferDecimalSep, parseNumberText, type DecimalSep } from './numbers';
import { isPlaceholder } from './missing';

export function column(table: TableData, col: number): Cell[] {
  return table.rows.map((r) => r[col] ?? { v: null, t: '', f: 'General' });
}

export function isEmpty(c: Cell): boolean {
  return c.v === null || c.v === '' || (typeof c.v === 'string' && c.v.trim() === '');
}

/** Blank, or a placeholder like N/A / NULL / "-" that means "no data". */
export function isMissing(c: Cell): boolean {
  return isEmpty(c) || isPlaceholder(c);
}

/** Lowercase, strip accents, split on anything that isn't a letter or digit. */
export function headerTokens(h: string): string[] {
  const norm = h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/n[°º]/g, 'nro ');
  return norm.split(/[^a-z0-9]+/).filter(Boolean);
}

const hasToken = (h: string, list: string[]) => hitStrength(headerTokens(h), list) > 0;

export function decimalSepFor(table: TableData, col: number): DecimalSep | null {
  return inferDecimalSep(column(table, col).map((c) => c.t || String(c.v ?? '')));
}

export function dateOrderFor(table: TableData, col: number): DateOrder {
  return inferDateOrder(column(table, col).filter((c) => typeof c.v === 'string').map((c) => String(c.v)));
}

export interface ColumnProfile {
  index: number;
  header: string;
  nonEmpty: number;
  distinct: number;
  numericShare: number; // real numbers + numeric text, over non-empty
  realNumbers: number;
  dateShare: number;
  keyScore: number;
  keyReason: string;
  looksLikeMeasure: boolean;
}

export function profileColumns(table: TableData): ColumnProfile[] {
  const total = table.rows.length || 1;
  return table.headers.map((header, index) => {
    const cells = column(table, index);
    const dec = decimalSepFor(table, index);
    const order = dateOrderFor(table, index);
    const values = new Set<string>();
    let nonEmpty = 0;
    let numeric = 0;
    let realNumbers = 0;
    let decimals = 0;
    for (const c of cells) {
      if (isMissing(c)) continue;
      nonEmpty++;
      values.add(normaliseKey(c.v));
      if (typeof c.v === 'number') {
        numeric++;
        realNumbers++;
        if (!Number.isInteger(c.v)) decimals++;
      } else if (typeof c.v === 'string' && parseNumberText(c.v, dec)) numeric++;
    }
    const ds = dateShare(cells, order);
    const numericShare = nonEmpty ? numeric / nonEmpty : 0;
    const distinctRatio = nonEmpty ? values.size / nonEmpty : 0;
    // "Precio_del_Producto_ID" is an ID even though it contains "precio": an explicit id token wins.
    const tokens = headerTokens(header);
    const explicitId = tokens.includes('id') || tokens[tokens.length - 1] === 'nro' || tokens[0] === 'nro';
    const nameKey = hasToken(header, vocab.key);
    const nameMeasure = !explicitId && hasToken(header, vocab.measure);
    const notMeasure = hasToken(header, vocab.notMeasure);

    // Key score: name hint + mostly unique + mostly filled. Dates and decimal amounts are never keys.
    let keyScore = 0;
    const reasons: string[] = [];
    if (ds < 0.5 && decimals / Math.max(nonEmpty, 1) < 0.1 && !nameMeasure) {
      if (nameKey) {
        keyScore += 0.5;
        reasons.push('name looks like an ID');
      }
      keyScore += 0.4 * distinctRatio;
      keyScore += 0.1 * (nonEmpty / total);
      reasons.push(`${Math.round(distinctRatio * 100)}% unique`);
    }
    // A total to watch must actually hold numbers: a name match alone ("Metodo de Pago") is not enough.
    const looksLikeMeasure = ds < 0.5 && !nameKey && !notMeasure && numericShare >= 0.8 && (nameMeasure || decimals > 0);
    return {
      index,
      header,
      nonEmpty,
      distinct: values.size,
      numericShare,
      realNumbers,
      dateShare: ds,
      keyScore,
      keyReason: reasons.join(', '),
      looksLikeMeasure,
    };
  });
}

export interface SetupSuggestion {
  keyColumn: string | null;
  keyReason: string;
  dateColumn: string | null;
  measures: string[];
}

export function suggestSetup(table: TableData): SetupSuggestion {
  const profiles = profileColumns(table);
  const keys = [...profiles].sort((a, b) => b.keyScore - a.keyScore);
  const key = keys[0] && keys[0].keyScore >= 0.5 ? keys[0] : null;
  // Only dates that say *when the row happened* make sense for month-by-month totals.
  // Birth dates and "member since" dates are attributes of a person, not periods, so they're never suggested.
  const dateRank = (h: string) => (hasToken(h, vocab.periodDate) ? 2 : 0) + (hasToken(h, vocab.date) ? 1 : 0);
  const dates = profiles
    .filter((p) => p.dateShare >= 0.9 && !hasToken(p.header, vocab.notPeriodDate))
    .sort((a, b) => dateRank(b.header) - dateRank(a.header));
  return {
    keyColumn: key?.header ?? null,
    keyReason: key?.keyReason ?? '',
    dateColumn: dates[0]?.header ?? null,
    measures: profiles.filter((p) => p.looksLikeMeasure && p.header !== key?.header).map((p) => p.header),
  };
}

/** How IDs are compared: trimmed, spaces collapsed, case-insensitive. 123 and "123" are the same. */
export function normaliseKey(v: Cell['v']): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim().replace(/\s+/g, ' ').toUpperCase();
}
