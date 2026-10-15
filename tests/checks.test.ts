import fs from 'node:fs';
import path from 'node:path';
import type { Rules, TableData } from '../src/core/types';
import { suggestSetup } from '../src/core/columns';
import { runChecks } from '../src/core/run';
import { emptyState, fromXml, toXml } from '../src/core/history';
import { isDateFormat, parseDateText } from '../src/core/dates';

const load = (name: string): TableData =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf-8'));

const NOW = new Date('2026-10-14T12:00:00Z');
const rulesFrom = (t: TableData, extra: Partial<Rules> = {}): Rules => {
  const s = suggestSetup(t);
  return {
    keyColumn: s.keyColumn,
    dateColumn: s.dateColumn,
    measures: s.measures,
    ignored: [],
    confirmedAt: NOW.toISOString(),
    ...extra,
  };
};

/** Keep only rows of the given months (YYYY-MM), to simulate "one month per file". */
const onlyMonths = (t: TableData, months: string[]): TableData => {
  const serialToKey = (s: number) => new Date(Math.round((s - 25569) * 86400000)).toISOString().slice(0, 7);
  return { ...t, rows: t.rows.filter((r) => months.includes(serialToKey(r[1].v as number))) };
};

describe('setup suggestions', () => {
  it('picks the invoice number, the date and the amount', () => {
    const s = suggestSetup(load('Ventas_Sep.json'));
    expect(s.keyColumn).toBe('Nro Factura');
    expect(s.dateColumn).toBe('Fecha');
    expect(s.measures).toContain('Importe');
    expect(s.measures).not.toContain('Nro Factura');
  });
});

describe('Ventas_Sep (one month per file)', () => {
  const t = load('Ventas_Sep.json');
  const res = runChecks(t, rulesFrom(t), emptyState(), { now: NOW });
  const byCheck = (c: string) => res.findings.filter((f) => f.check === c);

  it('finds the 3 duplicate invoice numbers, including the ones that only differ by space/case', () => {
    const [dup] = byCheck('duplicates');
    expect(dup.groups).toHaveLength(3);
    expect(dup.groups!.filter((g) => g.hiddenVariant)).toHaveLength(2);
    expect(dup.cells).toHaveLength(6);
  });

  it('finds the blank ID', () => {
    expect(byCheck('blankKeys')[0].cells).toEqual([{ row: 101, col: 0 }]);
  });

  it('finds the 8 amounts stored as text and says how much SUM misses', () => {
    const [tn] = byCheck('textNumbers');
    expect(tn.cells).toHaveLength(8);
    const ars = tn.impact!.find((i) => i.currency === '$')!;
    // 12345.5 + 12345.5 + 8900 + 1234 + 15000 - 2500 + 4321.1
    expect(ars.amount).toBeCloseTo(51646.1, 2);
    expect(tn.impact!.find((i) => i.currency === 'USD')!.amount).toBe(1200);
    // The USD text value is not auto-converted into the ARS column.
    expect(tn.fix!.values).toHaveLength(7);
    expect(tn.fix!.numberFormat).toBe('"$"#,##0.00');
  });

  it('flags the USD amounts in an ARS column', () => {
    const [mc] = byCheck('mixedCurrency');
    expect(mc.title).toContain('USD');
    expect(mc.cells.map((c) => c.row).sort((a, b) => a - b)).toEqual([52, 70]);
  });

  it('records a baseline on the first run', () => {
    expect(res.trend.status).toBe('baseline');
    expect(res.tableState.periods.map((p) => p.period)).toEqual(['2026-09']);
  });

  it('does not treat invoice numbers or quantities as text-numbers', () => {
    expect(res.findings.some((f) => f.column === 'Nro Factura' && f.check === 'textNumbers')).toBe(false);
    expect(res.findings.some((f) => f.column === 'Cantidad')).toBe(false);
  });
});

describe('Ventas_Acumulado (append rows)', () => {
  const t = load('Ventas_Acumulado.json');
  const res = runChecks(t, rulesFrom(t), emptyState(), { now: NOW });

  it('builds history from the file itself on the first run', () => {
    expect(res.trend.latest!.period).toBe('2026-09');
    expect(res.trend.priors).toHaveLength(6);
    expect(res.trend.status).toBe('ok');
  });

  it('flags September and explains it with the text-stored amounts', () => {
    const f = res.findings.find((x) => x.id === 'offTrend:Importe')!;
    expect(f).toBeDefined();
    expect(f.severity).not.toBe('info');
    expect(f.detail).toContain('stored as text');
    const rows = res.trend.comparisons.find((c) => c.metric === 'Rows')!;
    expect(rows.flagged).toBe(false); // row count is normal; only the amount is off
  });

  it('does not flag a month that is in line with the others', () => {
    const aug = onlyMonths(t, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    const r = runChecks(aug, rulesFrom(aug), emptyState(), { now: NOW });
    expect(r.findings.filter((f) => f.check === 'offTrend')).toHaveLength(0);
  });
});

describe('overwrite / copy-last-month habits: history travels in the workbook', () => {
  const full = load('Ventas_Acumulado.json');

  it('compares this month against months stored from earlier runs', () => {
    let xml = toXml(emptyState());
    for (const m of ['2026-06', '2026-07', '2026-08']) {
      const t = onlyMonths(full, [m]);
      const r = runChecks(t, rulesFrom(t), fromXml(xml), { now: NOW });
      xml = toXml(r.state); // what gets written into the custom XML part
    }
    const sep = onlyMonths(full, ['2026-09']);
    const r = runChecks(sep, rulesFrom(sep), fromXml(xml), { now: NOW });
    expect(r.trend.priors.map((p) => p.period)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(r.trend.priors.every((p) => p.source === 'history')).toBe(true);
    expect(r.findings.some((f) => f.id === 'offTrend:Importe')).toBe(true);
  });

  it('re-running on the same month overwrites that month instead of adding a point', () => {
    const aug = onlyMonths(full, ['2026-08']);
    const r1 = runChecks(aug, rulesFrom(aug), emptyState(), { now: NOW });
    const r2 = runChecks(aug, rulesFrom(aug), fromXml(toXml(r1.state)), { now: NOW });
    const r3 = runChecks(aug, rulesFrom(aug), fromXml(toXml(r2.state)), { now: NOW });
    expect(r3.tableState.periods).toHaveLength(1);
    expect(r3.trend.status).toBe('baseline');
  });

  it('opening an older copy does not compare September against October', () => {
    const sep = onlyMonths(full, ['2026-09']);
    const state = runChecks(sep, rulesFrom(sep), emptyState(), { now: NOW }).state;
    const aug = onlyMonths(full, ['2026-08']);
    const r = runChecks(aug, rulesFrom(aug), state, { now: NOW });
    expect(r.trend.latest!.period).toBe('2026-08');
    expect(r.trend.priors).toHaveLength(0);
  });
});

describe('state XML', () => {
  it('round-trips headers with characters that would break XML', () => {
    const t = load('Ventas_Sep.json');
    t.headers = t.headers.map((h, i) => (i === 2 ? 'Cliente <A&B> ]]>' : h));
    const r = runChecks(t, rulesFrom(t), emptyState(), { now: NOW });
    const xml = toXml(r.state);
    expect(xml).not.toMatch(/<A&B>/);
    expect(fromXml(xml).tables[0].headers[2]).toBe('Cliente <A&B> ]]>');
  });

  it('treats garbage as empty state', () => {
    expect(fromXml('<dataguard><state>{nope</state></dataguard>').tables).toEqual([]);
    expect(fromXml(null).tables).toEqual([]);
  });
});

describe('dates', () => {
  it('recognises date formats and text dates', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isDateFormat('[$-es-AR]d "de" mmmm "de" yyyy')).toBe(true);
    expect(isDateFormat('"$"#,##0.00')).toBe(false);
    expect(isDateFormat('h:mm')).toBe(false);
    expect(parseDateText('15/09/2026')!.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(parseDateText('2026-09-15')!.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(parseDateText('31/02/2026')).toBeNull();
  });
});

import { checkOffTrend } from '../src/core/checks/offTrend';
import checks from '../config/checks.json';

describe('checkOffTrend on its own', () => {
  const params = checks.checks.find((c) => c.id === 'offTrend')!.params as any;
  const series = (vals: number[], last = '-28') =>
    vals.map((v, i) => ({ period: `2026-${String(i + 1).padStart(2, '0')}`, rows: 100, sums: { Importe: v }, lastDate: `2026-${String(i + 1).padStart(2, '0')}${last}` }));

  it('a business growing 5% a month is not flagged', () => {
    const r = checkOffTrend(series([100, 105, 110, 116, 122, 128, 134]), ['Importe'], params, {}, NOW);
    expect(r.findings).toHaveLength(0);
  });

  it('a 55% drop after steady months is flagged high', () => {
    const r = checkOffTrend(series([100, 102, 99, 101, 100, 45]), ['Importe'], params, {}, NOW);
    expect(r.findings[0]).toMatchObject({ id: 'offTrend:Importe', severity: 'high' });
  });

  it('a half-finished month is reported as info, not as a problem', () => {
    const s = series([100, 102, 99, 101, 100, 50]);
    s[5].lastDate = '2026-06-14';
    const r = checkOffTrend(s, ['Importe'], params, {}, NOW);
    expect(r.incomplete).toBe(true);
    expect(r.findings[0].severity).toBe('info');
  });

  it('with only two earlier months it uses the plain 30% threshold', () => {
    expect(checkOffTrend(series([100, 100, 80]), ['Importe'], params, {}, NOW).findings).toHaveLength(0);
    expect(checkOffTrend(series([100, 100, 60]), ['Importe'], params, {}, NOW).findings).toHaveLength(1);
  });
});

describe('lessons from Base_de_Datos_Tablas (real workbook)', () => {
  const mk = (headers: string[], rows: (string | number | null)[][], fmts: string[] = []): TableData => ({
    tableName: null, sheet: 'S', address: 'S!A1', headers, firstRow: 1, firstCol: 0,
    rows: rows.map((r) => r.map((v, i) => ({ v, t: v === null ? '' : String(v), f: fmts[i] ?? 'General' }))),
  });

  it('an ID column wins over a measure word in its name', () => {
    const t = mk(['Precio_del_Producto_ID', 'Producto', 'Precio'], Array.from({ length: 20 }, (_, i) => [i + 1, `P${i % 7}`, 100 + i]));
    expect(suggestSetup(t).keyColumn).toBe('Precio_del_Producto_ID');
    expect(suggestSetup(t).measures).toEqual(['Precio']);
  });

  it('never suggests a birth date or "member since" as the month column', () => {
    const t = mk(['Client ID', 'Date of Birth', 'Member since?', 'Fecha de Compra'],
      Array.from({ length: 20 }, (_, i) => [i + 1, 30000 + i * 300, 42000 + i * 40, 45000 + i]), ['General', 'dd/mm/yyyy', 'dd/mm/yyyy', 'dd/mm/yyyy']);
    expect(suggestSetup(t).dateColumn).toBe('Fecha de Compra');
    const noTx = mk(['Client ID', 'Date of Birth'], Array.from({ length: 20 }, (_, i) => [i + 1, 30000 + i * 300]), ['General', 'dd/mm/yyyy']);
    expect(suggestSetup(noTx).dateColumn).toBeNull();
  });

  it('does not call 1 vs 2 rows a month a trend', () => {
    const params = checks.checks.find((c) => c.id === 'offTrend')!.params as any;
    const s = Array.from({ length: 7 }, (_, i) => ({ period: `2004-0${i + 1}`, rows: i === 6 ? 2 : 1, sums: {} }));
    const r = checkOffTrend(s, [], params, {}, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ id: 'offTrend:sparse', severity: 'info' });
  });

  it('coordinates and phone numbers are not totals', () => {
    const t = mk(['ID', 'Latitud', 'Longitud', 'Numero de Celular', 'Distancia'],
      Array.from({ length: 20 }, (_, i) => [i + 1, -34.6 - i / 100, -58.4 - i / 100, 1100000000 + i, 1.5 + i / 10]));
    expect(suggestSetup(t).measures).toEqual(['Distancia']);
  });
});

import { checkIdFormat } from '../src/core/checks/idFormat';
import { checkDateQuality } from '../src/core/checks/dateQuality';
import { checkPlaceholders } from '../src/core/checks/placeholders';
import { checkDuplicates } from '../src/core/checks/duplicates';

describe('lessons from messy_sales_qc_test_data.csv', () => {
  const mk = (headers: string[], rows: (string | number | null)[][], fmts: string[] = []): TableData => ({
    tableName: null, sheet: 'S', address: 'S!A1', headers, firstRow: 1, firstCol: 0,
    rows: rows.map((r) => r.map((v, i) => ({ v, t: v === null ? '' : String(v), f: fmts[i] ?? 'General' }))),
  });
  const idParams = { minShare: 0.8, minValues: 20 };
  const serial = (iso: string) => Math.round(Date.parse(iso) / 86400000) + 25569;

  it('N/A and NULL in the ID column are missing IDs, not duplicates', () => {
    const ids = [...Array.from({ length: 30 }, (_, i) => `TXN-${100000 + i}`), 'N/A', 'N/A', 'NULL', 'null', null];
    const f = checkDuplicates(mk(['transaction_id', 'x'], ids.map((v) => [v, 1])), 0);
    expect(f.find((x) => x.check === 'duplicates')).toBeUndefined();
    const blank = f.find((x) => x.check === 'blankKeys')!;
    expect(blank.cells).toHaveLength(5);
    expect(blank.detail).toContain('"N/A"');
    expect(blank.fix!.values).toHaveLength(4);
  });

  it('flags placeholders in any column, Excel errors included', () => {
    const t = mk(['email'], [['a@b.com'], ['N/A'], ['null'], ['None'], ['-'], ['#N/A'], ['x@y.com']]);
    const [f] = checkPlaceholders(t, 0);
    expect(f.cells).toHaveLength(5);
    expect(f.detail).toContain('Excel errors');
  });

  it('learns "TXN-" + 6 digits and groups the variants by cause', () => {
    const ids = [
      ...Array.from({ length: 50 }, (_, i) => `TXN-${100000 + i}`),
      'txn-100100', '  TXN-100101 ', 'TXN--100102', '100103', 'INV_100104', 'ORD-100105', 'ID#100106',
    ];
    const r = checkIdFormat(mk(['transaction_id'], ids.map((v) => [v])), 0, idParams);
    expect(r.description).toBe('"TXN-" followed by 6 digits');
    const keys = r.findings[0].groups!.map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(['lower case', 'extra spaces', 'doubled separator', 'missing "TXN-" prefix', 'different prefix "INV_"', 'different prefix "ORD-"', 'different prefix "ID#"']));
    expect(r.findings[0].fix!.values.map((v) => v.value)).toEqual(['TXN-100100', 'TXN-100101', 'TXN-100102']);
  });

  it('describes numeric IDs and their gaps', () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1).filter((n) => n !== 7 && n !== 20);
    const r = checkIdFormat(mk(['id'], ids.map((v) => [v])), 0, idParams);
    expect(r.description).toBe('whole numbers from 1 to 40, 2 numbers missing, in ascending order');
    expect(r.findings[0]).toMatchObject({ severity: 'info', title: 'id skips 2 numbers' });
  });

  it('flags 2035 / 2099, 1900-01-01 / 1970-01-01, stray rows, impossible and mixed-order text dates', () => {
    const good = Array.from({ length: 300 }, (_, i) => serial(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`));
    const rows: (string | number)[][] = [
      ...good.map((s) => [s]),
      [serial('2099-12-31')], [serial('2035-05-20')], [serial('1900-01-01')], [serial('1970-01-01')], [serial('2023-03-03')],
      ['2026-13-01'], ['0000-00-00'], ['pending'], ['20/12/2025'], ['07-24-2026'], ['May 06, 2026'],
    ];
    const t = mk(['order_date'], rows, Array(1).fill('yyyy-mm-dd'));
    t.rows.forEach((r) => { if (typeof r[0].v === 'string') r[0].f = 'General'; });
    const r = checkDateQuality(t, 0, { futureGraceDays: 31, farPastDays: 365, minRowsPerPeriod: 10 }, NOW);
    const range = r.findings.find((f) => f.id === 'dateRange:order_date')!;
    expect(range.groups!.map((g) => [g.key, g.rows.length])).toEqual([
      ['in the future', 2], ['default "unknown" dates', 2], ['before the main data starts', 2], // 2023-03-03 and the text date 20/12/2025
    ]);
    expect(r.findings.find((f) => f.id === 'undated:order_date')!.cells).toHaveLength(3);
    const text = r.findings.find((f) => f.id === 'textDates:order_date')!;
    expect(text.severity).toBe('high'); // day-first and month-first both present
    expect(r.excludeRows.size).toBe(9);
  });

  it('reports a month with no rows inside the range', () => {
    const rows = ['2026-01', '2026-02', '2026-04', '2026-05'].flatMap((m) => Array.from({ length: 20 }, (_, i) => [serial(`${m}-${String(1 + i).padStart(2, '0')}`)]));
    const r = checkDateQuality(mk(['fecha'], rows, ['dd/mm/yyyy']), 0, { futureGraceDays: 31, farPastDays: 365, minRowsPerPeriod: 10 }, NOW);
    expect(r.findings.find((f) => f.id === 'dateGaps:fecha')!.detail).toContain('2026-03');
  });

  it('words in a number column are flagged', () => {
    const t = mk(['quantity'], [[1], [2], [3], ['two'], ['five'], ['10 units'], [4]]);
    const r = runChecks(t, { keyColumn: null, dateColumn: null, measures: ['quantity'], ignored: [], confirmedAt: '' }, emptyState(), { now: NOW });
    expect(r.findings.find((f) => f.check === 'nonNumeric')!.cells).toHaveLength(3);
  });

  it('reads month-name dates', () => {
    expect(parseDateText('May 06, 2026')!.toISOString().slice(0, 10)).toBe('2026-05-06');
    expect(parseDateText('6 de mayo de 2026')!.toISOString().slice(0, 10)).toBe('2026-05-06');
    expect(parseDateText('0000-00-00')).toBeNull();
  });
});
