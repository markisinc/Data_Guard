// Numbers stored as text, and mixed currencies. Both make SUM quietly wrong.
import type { CellRef, Finding, TableData } from '../types';
import { column, decimalSepFor, isMissing } from '../columns';
import { currencyFromFormat, formatAmount, normaliseCurrency, parseNumberText, parseNumberWords } from '../numbers';
import { pushTo } from '../util';

export interface TextNumberOptions {
  minNumericShare: number;
  /** User-confirmed measure columns: always checked, even if every value is text. */
  isMeasure: boolean;
}

function dominant<T>(items: T[]): T | null {
  const counts = new Map<T, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

export function checkTextNumbers(table: TableData, col: number, opts: TextNumberOptions): Finding[] {
  const header = table.headers[col];
  const cells = column(table, col);
  const dec = decimalSepFor(table, col);

  const numericFormats: string[] = [];
  const numericCurrencies: (string | null)[] = [];
  const textHits: { row: number; value: number; currency: string | null; ambiguous: boolean }[] = [];
  let nonEmpty = 0;
  let real = 0;
  let formulaText = 0;
  const nonNumeric: { row: number; raw: string }[] = [];

  cells.forEach((c, row) => {
    if (isMissing(c)) return; // placeholders are reported by the placeholder check
    nonEmpty++;
    if (typeof c.v === 'number') {
      real++;
      numericFormats.push(c.f || 'General');
      numericCurrencies.push(currencyFromFormat(c.f));
      return;
    }
    if (typeof c.v !== 'string') return;
    const p = parseNumberText(c.v, dec);
    if (!p) {
      if (!c.formula) nonNumeric.push({ row, raw: c.v });
      return;
    }
    if (c.formula) {
      formulaText++;
      return;
    }
    textHits.push({ row, value: p.value, currency: normaliseCurrency(p.currency), ambiguous: p.ambiguous });
  });

  const share = nonEmpty ? (real + textHits.length + formulaText) / nonEmpty : 0;
  const relevant = opts.isMeasure || (real > 0 && share >= opts.minNumericShare);
  if (!relevant) return [];
  const extra: Finding[] = [];

  // --- Words in a number column ("Included", "two", "see notes") ---
  if (nonNumeric.length) {
    const counts = new Map<string, number[]>();
    for (const n of nonNumeric) {
      const k = n.raw.trim();
      pushTo(counts, k, n.row);
    }
    const groups: { key: string; rows: number[]; note?: string }[] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, rows]) => ({ key, rows }));
    const sample = groups.slice(0, 4).map((g) => `"${g.key}" ×${g.rows.length}`).join(', ');
    const convertible = nonNumeric
      .map((n) => ({ ...n, value: parseNumberWords(n.raw) }))
      .filter((n): n is { row: number; raw: string; value: number } => n.value !== null);
    for (const g of groups) {
      const v = parseNumberWords(g.key);
      if (v !== null) (g as { note?: string }).note = `→ ${v}`;
    }
    extra.push({
      id: `nonNumeric:${header}`,
      check: 'nonNumeric',
      severity: 'medium',
      column: header,
      title: `${nonNumeric.length} ${header} value${nonNumeric.length > 1 ? 's are' : ' is'} words, not numbers`,
      detail: `${sample}${groups.length > 4 ? `, and ${groups.length - 4} more` : ''}. SUM and averages skip these rows.`,
      cells: nonNumeric.map((n) => ({ row: n.row, col })),
      groups,
      fix: convertible.length
        ? {
            kind: 'convertNumbers',
            label: `Convert ${convertible.length} to numbers`,
            values: convertible.map((n) => ({ row: n.row, col, value: n.value })),
          }
        : undefined,
    });
  }

  const colCurrency = dominant(numericCurrencies.filter((c): c is string => !!c)) ?? null;
  const findings: Finding[] = extra;

  // --- Mixed currencies (numeric formats + text prefixes) ---
  const curOf = (c: string | null) => c ?? colCurrency;
  const allCurrencies = new Set<string>();
  numericCurrencies.forEach((c) => c && allCurrencies.add(c));
  textHits.forEach((h) => {
    const c = curOf(h.currency);
    if (c) allCurrencies.add(c);
  });
  if (allCurrencies.size >= 2) {
    const named = [...allCurrencies].filter((c) => c !== '$');
    const hitByRow = new Map(textHits.map((h) => [h.row, h]));
    const cellsByCur: CellRef[] = [];
    cells.forEach((c, row) => {
      const hit = hitByRow.get(row);
      const cur = typeof c.v === 'number' ? currencyFromFormat(c.f) : hit ? curOf(hit.currency) : null;
      if (cur && cur !== colCurrency) cellsByCur.push({ row, col });
    });
    findings.push({
      id: `mixedCurrency:${header}`,
      check: 'mixedCurrency',
      severity: named.length >= 2 ? 'high' : 'medium',
      column: header,
      title: `${header} mixes currencies: ${[...allCurrencies].join(', ')}`,
      detail:
        named.length >= 2
          ? 'Amounts in different currencies are being added together. Convert or split them before totalling.'
          : `"$" and ${named.join(', ')} both appear. Check they are the same currency.`,
      cells: cellsByCur,
    });
  }

  // --- Numbers stored as text ---
  if (textHits.length) {
    // With a single currency everything converts; with a mix, only values in the column's main currency do.
    const singleCurrency = allCurrencies.size <= 1;
    const convertible = textHits.filter((h) => singleCurrency || !h.currency || curOf(h.currency) === colCurrency);
    const byCurrency = new Map<string | null, number>();
    for (const h of textHits) {
      const c = curOf(h.currency);
      byCurrency.set(c, (byCurrency.get(c) ?? 0) + h.value);
    }
    const impact = [...byCurrency].map(([currency, amount]) => ({ amount, currency }));
    const impactText = impact.map((i) => formatAmount(i.amount, dec, i.currency)).join(' + ');
    const ambiguous = textHits.filter((h) => h.ambiguous).length;
    const skipped = textHits.length - convertible.length;

    let detail = `SUM is missing ${impactText}: these values are stored as text, so Excel skips them.`;
    if (ambiguous) detail += ` ${ambiguous} value${ambiguous > 1 ? 's' : ''} like "1.234" were read with "." as the thousands separator. Check before converting.`;
    if (skipped) detail += ` ${skipped} in another currency won't be converted automatically.`;
    if (formulaText) detail += ` ${formulaText} more come from formulas that return text; fix the formula instead.`;

    findings.push({
      id: `textNumbers:${header}`,
      check: 'textNumbers',
      severity: 'high',
      column: header,
      title: `${textHits.length} ${header} value${textHits.length > 1 ? 's are' : ' is'} stored as text`,
      detail,
      cells: textHits.map((h) => ({ row: h.row, col })),
      impact,
      fix: convertible.length
        ? {
            kind: 'convertNumbers',
            label: `Convert ${convertible.length} to numbers`,
            values: convertible.map((h) => ({ row: h.row, col, value: h.value })),
            numberFormat: dominant(numericFormats.filter((f) => f !== 'General')) ?? '#,##0.00',
          }
        : undefined,
    });
  }
  return findings;
}
