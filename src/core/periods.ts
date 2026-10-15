// Period-aware profiles (option C): group rows by month of the date column and summarise each month.
// An append-style file already holds its own history, so off-trend works on the first run.
import type { PeriodProfile, Rules, TableData } from './types';
import { column, dateOrderFor, decimalSepFor, isEmpty, normaliseKey } from './columns';
import { cellToDate, periodKey } from './dates';
import { parseNumberText } from './numbers';

export interface PeriodResult {
  periods: PeriodProfile[];
  /** Rows whose date could not be read. */
  undated: number[];
}

export function profileByPeriod(
  table: TableData,
  rules: Rules,
  excludeRows: Set<number> = new Set(),
  /** Per measure, rows whose value is a stand-in (999999.99) and must not count in the totals. */
  excludeCells: Map<string, Set<number>> = new Map(),
): PeriodResult {
  const idx = (h: string | null) => (h === null ? -1 : table.headers.indexOf(h));
  const dateCol = idx(rules.dateColumn);
  const keyCol = idx(rules.keyColumn);
  const measures = rules.measures.map((m) => ({ name: m, col: idx(m) })).filter((m) => m.col >= 0);
  const decs = new Map(measures.map((m) => [m.name, decimalSepFor(table, m.col)]));
  const order = dateCol >= 0 ? dateOrderFor(table, dateCol) : 'dmy';

  const map = new Map<string, { p: PeriodProfile; keys: Set<string> }>();
  const undated: number[] = [];

  const bucket = (period: string) => {
    let b = map.get(period);
    if (!b) {
      b = { p: { period, rows: 0, sums: {}, hidden: {}, source: 'file' }, keys: new Set() };
      for (const m of measures) {
        b.p.sums[m.name] = 0;
        b.p.hidden![m.name] = 0;
      }
      map.set(period, b);
    }
    return b;
  };

  table.rows.forEach((row, r) => {
    if (row.every(isEmpty) || excludeRows.has(r)) return;
    let period: string;
    let date: Date | null = null;
    if (dateCol >= 0) {
      date = cellToDate(row[dateCol], order);
      if (!date) {
        undated.push(r);
        return;
      }
      period = periodKey(date);
    } else {
      period = rules.snapshotPeriod ?? 'snapshot';
    }
    const b = bucket(period);
    b.p.rows++;
    if (date) {
      const iso = date.toISOString().slice(0, 10);
      if (!b.p.lastDate || iso > b.p.lastDate) b.p.lastDate = iso;
    }
    if (keyCol >= 0 && !isEmpty(row[keyCol])) b.keys.add(normaliseKey(row[keyCol].v));
    for (const m of measures) {
      const c = row[m.col];
      if (excludeCells.get(m.name)?.has(r)) continue;
      if (typeof c.v === 'number') b.p.sums[m.name] += c.v;
      else if (typeof c.v === 'string' && !c.formula) {
        const p = parseNumberText(c.v, decs.get(m.name) ?? null);
        if (p) b.p.hidden![m.name] += p.value;
      }
    }
  });

  const periods = [...map.values()]
    .map(({ p, keys }) => (keyCol >= 0 ? { ...p, distinctKeys: keys.size } : p))
    .sort((a, b) => a.period.localeCompare(b.period));
  return { periods, undated };
}

/** Columns used, for convenience in the UI. */
export function measureCells(table: TableData, name: string) {
  return column(table, table.headers.indexOf(name));
}
