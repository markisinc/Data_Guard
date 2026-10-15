// Date column sanity: impossible or placeholder dates (2099, 1900-01-01, 1970-01-01), unreadable dates,
// dates typed as text in several formats, and months with no rows inside the data's range.
// Rows with bad dates are left out of month-by-month totals, so one "2099" row can't become "the latest month".
import type { DuplicateGroup, Finding, TableData } from '../types';
import { column, dateOrderFor, isEmpty, isMissing } from '../columns';
import { cellToDate, isDateFormat, parseDateText, periodKey } from '../dates';
import type { ConvertFix } from '../types';
import { shapeOf } from './idFormat';
import { pushTo } from '../util';

export interface DateQualityParams {
  /** Dates more than this many days after today are flagged as future. */
  futureGraceDays: number;
  /** Dates this many days before the bulk of the data (1st percentile) are flagged. */
  farPastDays: number;
  /** Monthly gaps are only reported when months typically have at least this many rows. */
  minRowsPerPeriod: number;
}

// Values systems write when a date is unknown.
const DEFAULT_DATES = new Set(['1899-12-30', '1899-12-31', '1900-01-01', '1900-01-00', '1970-01-01']);

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface DateQualityResult {
  findings: Finding[];
  /** Rows to leave out of period totals. */
  excludeRows: Set<number>;
  /** Range of the good dates, for display. */
  range: { from: string; to: string } | null;
}

export function checkDateQuality(table: TableData, col: number, params: DateQualityParams, now: Date): DateQualityResult {
  const header = table.headers[col];
  const order = dateOrderFor(table, col);
  const unreadable: { row: number; raw: string }[] = [];
  const textDates: { row: number; raw: string }[] = [];
  const valid: { row: number; d: Date }[] = [];

  column(table, col).forEach((c, row) => {
    if (table.rows[row].every(isEmpty) || isMissing(c)) return; // blanks / N/A: placeholder check reports them
    let d = cellToDate(c, order);
    // "07-24-2026" in a day-first column: not invalid, just month-first. Read it, and the text-format finding warns.
    if (!d && typeof c.v === 'string') d = parseDateText(c.v, order === 'dmy' ? 'mdy' : 'dmy');
    if (!d) {
      unreadable.push({ row, raw: c.t || String(c.v) });
      return;
    }
    if (typeof c.v === 'string') textDates.push({ row, raw: c.v.trim() });
    valid.push({ row, d });
  });

  const future = valid.filter((v) => v.d.getTime() > now.getTime() + params.futureGraceDays * DAY);
  const defaults = valid.filter((v) => DEFAULT_DATES.has(iso(v.d)));
  const flagged = new Set([...future, ...defaults].map((v) => v.row));
  let core = valid.filter((v) => !flagged.has(v.row));

  // Rows outside the main block of months: a handful of stray rows before or after the data really runs.
  // A month belongs to the block if it has at least 5% of a typical month's rows.
  let before: typeof valid = [];
  let after: typeof valid = [];
  let block: { from: string; to: string } | null = null;
  if (core.length >= 50) {
    const perMonth = new Map<string, number>();
    for (const v of core) perMonth.set(periodKey(v.d), (perMonth.get(periodKey(v.d)) ?? 0) + 1);
    const counts = [...perMonth.values()].sort((a, b) => a - b);
    const typical = counts[Math.floor(counts.length / 2)];
    const dense = [...perMonth.entries()].filter(([, n]) => n >= Math.max(2, typical * 0.05)).map(([k]) => k).sort();
    if (dense.length) {
      block = { from: dense[0], to: dense[dense.length - 1] };
      before = core.filter((v) => periodKey(v.d) < block!.from);
      after = core.filter((v) => periodKey(v.d) > block!.to);
      const stray = new Set([...before, ...after].map((v) => v.row));
      core = core.filter((v) => !stray.has(v.row));
    }
  }
  const old = [...before, ...after];

  const findings: Finding[] = [];
  const range =
    block ??
    (core.length
      ? {
          from: periodKey(new Date(Math.min(...core.map((v) => v.d.getTime())))),
          to: periodKey(new Date(Math.max(...core.map((v) => v.d.getTime())))),
        }
      : null);

  // --- Out of range ---
  const outGroups: DuplicateGroup[] = [];
  const sample = (list: typeof valid) => [...new Set(list.map((l) => iso(l.d)))].slice(0, 3).join(', ');
  if (future.length) outGroups.push({ key: 'in the future', rows: future.map((f) => f.row), note: `e.g. ${sample(future)}` });
  if (defaults.length)
    outGroups.push({ key: 'default "unknown" dates', rows: defaults.map((f) => f.row), note: `${sample(defaults)}: what systems write when the date is missing` });
  if (before.length) outGroups.push({ key: 'before the main data starts', rows: before.map((f) => f.row), note: `e.g. ${sample(before)}` });
  if (after.length) outGroups.push({ key: 'after the main data ends', rows: after.map((f) => f.row), note: `e.g. ${sample(after)}` });
  const outCount = future.length + defaults.length + old.length;
  if (outCount) {
    findings.push({
      id: `dateRange:${header}`,
      check: 'dateQuality',
      severity: 'high',
      column: header,
      title: `${outCount} ${header} value${outCount > 1 ? 's are' : ' is'} outside the data's date range`,
      detail:
        (range ? `The data runs from ${range.from} to ${range.to}. ` : '') +
        outGroups.map((g) => `${g.rows.length} ${g.key}`).join(', ') +
        '. They are left out of the month-by-month totals.',
      cells: outGroups.flatMap((g) => g.rows).map((row) => ({ row, col })),
      groups: outGroups,
    });
  }

  // --- Unreadable ---
  if (unreadable.length) {
    const byShape = new Map<string, typeof unreadable>();
    for (const u of unreadable) {
      const k = /\d/.test(u.raw) ? shapeOf(u.raw) : u.raw.toLowerCase();
      pushTo(byShape, k, u);
    }
    const groups = [...byShape.values()]
      .sort((a, b) => b.length - a.length)
      .map((list) => {
        const distinct = [...new Set(list.map((l) => l.raw))];
        return { key: `"${distinct[0]}"`, rows: list.map((l) => l.row), note: distinct.length > 1 ? `also ${distinct.slice(1, 4).map((d) => `"${d}"`).join(', ')}` : undefined };
      });
    const examples = [...new Set(unreadable.map((u) => u.raw))].slice(0, 5).map((r) => `"${r}"`);
    findings.push({
      id: `undated:${header}`,
      check: 'dateQuality',
      severity: 'medium',
      column: header,
      title: `${unreadable.length} ${header} value${unreadable.length > 1 ? 's are' : ' is'} not a valid date`,
      detail: `e.g. ${examples.join(', ')}. Impossible dates (31 April, month 13, year 0000) or words. These rows are left out of the month-by-month totals.`,
      cells: unreadable.map((u) => ({ row: u.row, col })),
      groups,
    });
  }

  // --- Dates typed as text, in several formats ---
  if (textDates.length) {
    const byShape = new Map<string, typeof textDates>();
    for (const t of textDates) {
      const k = shapeOf(t.raw).replace(/[Aa]+/g, 'Mon');
      pushTo(byShape, k, t);
    }
    let dayFirst = 0;
    let monthFirst = 0;
    let eitherWay = 0;
    for (const t of textDates) {
      const m = t.raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{2,4}$/);
      if (!m) continue;
      if (+m[1] > 12) dayFirst++;
      else if (+m[2] > 12) monthFirst++;
      else eitherWay++;
    }
    const mixedOrder = dayFirst > 0 && monthFirst > 0;
    const groups = [...byShape.values()]
      .sort((a, b) => b.length - a.length)
      .map((list) => ({ key: list[0].raw, rows: list.map((l) => l.row), note: `×${list.length}` }));
    // Conversion to real dates. Dates that read the same either way convert directly;
    // ones like 07/05/2026 need the user to say day-first or month-first, once for all of them.
    const realFormats = column(table, col)
      .filter((c) => typeof c.v === 'number' && isDateFormat(c.f))
      .map((c) => c.f);
    const fmt = mostCommon(realFormats) ?? 'yyyy-mm-dd';
    const toSerial = (d: Date) => Math.round(d.getTime() / DAY) + 25569;
    const clear: { row: number; value: number }[] = [];
    const ambiguous: { row: number; dmy: number; mdy: number }[] = [];
    for (const t of textDates) {
      const a = parseDateText(t.raw, 'dmy');
      const b = parseDateText(t.raw, 'mdy');
      if (a && b && a.getTime() !== b.getTime()) ambiguous.push({ row: t.row, dmy: toSerial(a), mdy: toSerial(b) });
      else if (a || b) clear.push({ row: t.row, value: toSerial((a ?? b)!) });
    }
    const mkFix = (label: string, vals: { row: number; value: number }[]): ConvertFix => ({
      kind: 'convertNumbers',
      label,
      numberFormat: fmt,
      values: vals.map((v) => ({ row: v.row, col, value: v.value })),
    });
    const dateFix = ambiguous.length
      ? clear.length
        ? mkFix(`Convert ${clear.length} clear ones`, clear)
        : undefined
      : mkFix(`Convert ${clear.length} to real dates`, clear);
    const dateAlts = ambiguous.length
      ? [
          mkFix(`All ${clear.length + ambiguous.length}, day first (07/05 = 7 May)`, [...clear, ...ambiguous.map((a) => ({ row: a.row, value: a.dmy }))]),
          mkFix(`All ${clear.length + ambiguous.length}, month first (07/05 = July 5)`, [...clear, ...ambiguous.map((a) => ({ row: a.row, value: a.mdy }))]),
        ]
      : undefined;

    findings.push({
      fix: dateFix,
      altFixes: dateAlts,
      id: `textDates:${header}`,
      check: 'dateQuality',
      severity: mixedOrder ? 'high' : 'medium',
      column: header,
      title: `${textDates.length} ${header} value${textDates.length > 1 ? 's are' : ' is'} text, in ${byShape.size} format${byShape.size > 1 ? 's' : ''}`,
      detail:
        `Excel doesn't treat these as dates, so sorting, filters and date formulas skip or misorder them. Formats seen: ${groups
          .slice(0, 5)
          .map((g) => `"${g.key}"`)
          .join(', ')}.` +
        (mixedOrder
          ? ` Both day-first (e.g. 20/12/2025) and month-first (e.g. 07-24-2026) appear, so ${eitherWay} date${eitherWay === 1 ? '' : 's'} like 07/05/2026 can't be read safely either way.`
          : ''),
      cells: textDates.map((t) => ({ row: t.row, col })),
      groups,
    });
  }

  // --- Empty months inside the range ---
  if (core.length && range) {
    const perMonth = new Map<string, number>();
    for (const v of core) perMonth.set(periodKey(v.d), (perMonth.get(periodKey(v.d)) ?? 0) + 1);
    const counts = [...perMonth.values()].sort((a, b) => a - b);
    const typical = counts[Math.floor(counts.length / 2)];
    const empty: string[] = [];
    let [y, m] = range.from.split('-').map(Number);
    const [ty, tm] = range.to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      if (!perMonth.has(k)) empty.push(k);
      if (++m > 12) [y, m] = [y + 1, 1];
    }
    if (empty.length && typical >= params.minRowsPerPeriod) {
      findings.push({
        id: `dateGaps:${header}`,
        check: 'dateQuality',
        severity: 'medium',
        column: header,
        title: `No rows for ${empty.length} month${empty.length > 1 ? 's' : ''} inside the data's range`,
        detail: `${empty.slice(0, 6).join(', ')}${empty.length > 6 ? '…' : ''} have no rows, while a typical month has about ${typical}. Missing export, or a filter applied before copying?`,
        cells: [],
      });
    }
  }

  const excludeRows = new Set<number>([...flagged, ...old.map((o) => o.row), ...unreadable.map((u) => u.row)]);
  return { findings, excludeRows, range };
}

function mostCommon<T>(xs: T[]): T | null {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [k, v] of m) if (v > n) [best, n] = [k, v];
  return best;
}
