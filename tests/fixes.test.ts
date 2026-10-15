import type { TableData } from '../src/core/types';
import { checkVariants, editDistance } from '../src/core/checks/variants';
import { checkDependency } from '../src/core/checks/dependency';
import { checkTotals } from '../src/core/checks/totals';
import { checkSuspicious } from '../src/core/checks/suspicious';
import { checkEncoding, repairMojibake } from '../src/core/checks/encoding';
import { checkDateQuality } from '../src/core/checks/dateQuality';
import { checkDuplicates } from '../src/core/checks/duplicates';
import { parseNumberWords } from '../src/core/numbers';
import { logRows, nextBatch, planUndo, LOG_HEADERS } from '../src/core/changelog';

const mk = (headers: string[], rows: (string | number | null)[][], fmts: string[] = []): TableData => ({
  tableName: null, sheet: 'S', address: 'S!A1', headers, firstRow: 1, firstCol: 0,
  rows: rows.map((r) => r.map((v, i) => ({ v, t: v === null ? '' : String(v), f: fmts[i] ?? 'General' }))),
});
const rep = <T,>(n: number, v: T) => Array.from({ length: n }, () => v);

describe('spelling variants', () => {
  const vals = [...rep(60, 'Electronics'), ...rep(50, 'Apparel'), ...rep(40, 'Home & Garden'), ...rep(6, 'Elecronics'), ...rep(5, ' Apparel  '), ...rep(4, 'APPAREL'), ...rep(3, 'Home & Gardn')];
  const [f] = checkVariants(mk(['category'], vals.map((v) => [v])), 0, { maxDistinct: 60, maxDistinctShare: 0.02, rareShare: 0.1 });

  it('maps spacing/case variants and likely typos to the usual spelling', () => {
    const map = Object.fromEntries(f.groups!.map((g) => [g.key, g.note]));
    expect(map['"Elecronics" → "Electronics"']).toContain('likely typo');
    expect(map['" Apparel  " → "Apparel"']).toBe('extra spaces');
    expect(map['"APPAREL" → "Apparel"']).toBe('capitals');
    expect(map['"Home & Gardn" → "Home & Garden"']).toContain('likely typo');
    expect(f.fix!.values).toHaveLength(18);
    expect(f.altFixes![0].values).toHaveLength(9); // spaces & capitals only
  });

  it('leaves genuinely different short or numbered values alone', () => {
    const t = mk(['size'], [...rep(30, 'Size 10'), ...rep(3, 'Size 11'), ...rep(30, 'Red'), ...rep(3, 'Rod')].map((v) => [v]));
    expect(checkVariants(t, 0, { maxDistinct: 60, maxDistinctShare: 0.02, rareShare: 0.1 })).toEqual([]);
  });

  it('edit distance counts a swap as one', () => {
    expect(editDistance('accessories', 'accesories')).toBe(1);
    expect(editDistance('apparel', 'apaprel')).toBe(1);
  });
});

describe('same ID, different values', () => {
  const rows: (string | null)[][] = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 5; j++) rows.push([`C${i}`, `Name ${i}`]);
  rows.push(['C1', 'Somebody Else']); // odd one out
  rows.push(['C2', null]); // missing, fillable
  rows.push(['C3', 'N/A']); // placeholder, fillable
  const f = checkDependency(mk(['customer_id', 'customer_name'], rows), 0, 1, { minGroups: 10, minAgreement: 0.9 });

  it('fills missing values from the same ID', () => {
    const fill = f.find((x) => x.id === 'fillFromId:customer_name')!;
    expect(fill.fix!.values.map((v) => v.value)).toEqual(['Name 2', 'Name 3']);
  });

  it('flags the odd one out and offers the usual value', () => {
    const c = f.find((x) => x.id === 'conflict:customer_name')!;
    expect(c.groups![0].note).toContain('"Name 1" ×5 vs "Somebody Else" ×1');
    expect(c.fix!.values).toEqual([{ row: 100, col: 1, value: 'Name 1' }]);
  });

  it('says nothing when the column is not tied to the ID', () => {
    const r = Array.from({ length: 100 }, (_, i) => [`C${i % 20}`, `Product ${i % 7}`]);
    expect(checkDependency(mk(['customer_id', 'product'], r), 0, 1, { minGroups: 10, minAgreement: 0.9 })).toEqual([]);
  });

  it('duplicate groups say exact copy vs what differs', () => {
    const t = mk(['id', 'amount', 'status'], [['A', 10, 'ok'], ['A', 10, 'ok'], ['B', 5, 'ok'], ['B', 6, 'ok'], ['C', 1, 'ok']]);
    const notes = checkDuplicates(t, 0)[0].groups!.map((g) => [g.key, g.note]);
    expect(notes).toEqual([['A', 'exact copy'], ['B', 'differs in amount']]);
  });
});

describe('totals and stand-in numbers', () => {
  const rows: number[][] = Array.from({ length: 60 }, (_, i) => [1 + (i % 5), 10 + i, (1 + (i % 5)) * (10 + i)]);
  rows.push([2, 50, 999]); // wrong total
  rows.push([3, 999999.99, 90]); // stand-in price: total is the right one
  const t = mk(['quantity', 'unit_price', 'total'], rows);

  it('finds total = qty × price and offers both directions', () => {
    const [f] = checkTotals(t, [0, 1, 2], { minShare: 0.85, minRows: 20 }, '.');
    expect(f.title).toBe("2 total values don't match quantity × unit_price");
    expect(f.fix!.values).toEqual([{ row: 60, col: 2, value: 100 }]); // stand-in row left alone
    const [standIns, recalcPrice] = f.altFixes!;
    expect(standIns.label).toBe('Fix stand-ins from total (1)');
    expect(standIns.values).toEqual([{ row: 61, col: 1, value: 30 }]); // price = 90 ÷ 3, total untouched
    expect(recalcPrice.values).toHaveLength(2);
    expect(f.groups!.map((g) => [g.key, g.rows])).toEqual([["total doesn't match", [60]], ['unit_price is a stand-in', [61]]]);
  });

  it('flags repeated stand-ins like 999999.99 and 0.01', () => {
    const prices = [...Array.from({ length: 200 }, (_, i) => 20 + (i % 50)), ...rep(15, 0.01), 999999.99];
    const [f] = checkSuspicious(mk(['price'], prices.map((p) => [p])), 0);
    expect(f.groups!.map((g) => g.key).sort()).toEqual(['0.01', '999999.99']);
  });
});

describe('conversions', () => {
  it('number words and units', () => {
    expect(['two', 'Cinco', 'dos', 'três', '10 units', '3 uds.', 'Included'].map(parseNumberWords)).toEqual([2, 5, 2, 3, 10, 3, null]);
  });

  it('repairs garbled accents exactly', () => {
    expect(repairMojibake('MarÃ­a GÃ³mez')).toBe('María Gómez');
    expect(repairMojibake('María Gómez')).toBeNull();
    expect(checkEncoding(mk(['name'], [['ZoÃ« MÃ¼ller'], ['Ana']]), 0)[0].fix!.values[0].value).toBe('Zoë Müller');
  });

  it('text dates: converts clear ones and offers day-first / month-first for the rest', () => {
    const serial = (iso: string) => Math.round(Date.parse(iso) / 86400000) + 25569;
    const rows: (string | number)[][] = [...Array.from({ length: 30 }, (_, i) => [serial(`2026-03-${String(1 + i).padStart(2, '0')}`)]), ['20/03/2026'], ['03-24-2026'], ['07/03/2026'], ['Mar 06, 2026']];
    const t = mk(['fecha'], rows, ['dd/mm/yyyy']);
    t.rows.forEach((r) => { if (typeof r[0].v === 'string') r[0].f = 'General'; });
    const f = checkDateQuality(t, 0, { futureGraceDays: 31, farPastDays: 365, minRowsPerPeriod: 10 }, new Date('2026-10-14')).findings.find((x) => x.id === 'textDates:fecha')!;
    expect(f.fix!.label).toBe('Convert 3 clear ones');
    expect(f.fix!.numberFormat).toBe('dd/mm/yyyy');
    const [dayFirst, monthFirst] = f.altFixes!;
    const v = (fx: typeof dayFirst) => fx.values.find((x) => x.row === 32)!.value;
    expect(v(dayFirst)).toBe(serial('2026-03-07'));
    expect(v(monthFirst)).toBe(serial('2026-07-03'));
  });
});

describe('undo log', () => {
  const head = [[...LOG_HEADERS]];
  const b1 = logRows(1, new Date('2026-10-14T12:00:00Z'), 'Fix A', [{ sheet: 'S', address: 'B2', oldValue: '00123', newValue: 123, oldFormat: '@' }]);
  const b2 = logRows(2, new Date('2026-10-14T12:05:00Z'), 'Fix B', [
    { sheet: 'S', address: 'C2', oldValue: 'N/A', newValue: '', oldFormat: 'General' },
    { sheet: 'S', address: 'C3', oldValue: 5, newValue: 6, oldFormat: '0.00' },
  ]);

  it('numbers batches and undoes the latest applied one, keeping value types', () => {
    const log = [...head, ...b1, ...b2];
    expect(nextBatch(log)).toBe(3);
    const plan = planUndo(log)!;
    expect(plan.fix).toBe('Fix B');
    expect(plan.items.map((i) => [i.address, i.oldValue, i.newValue])).toEqual([['C2', 'N/A', ''], ['C3', 5, 6]]);
  });

  it('after a batch is undone, the previous one is next', () => {
    const log = [...head, ...b1, ...b2.map((r) => r.map((v, i) => (i === 7 ? 'undone' : v)))];
    const plan = planUndo(log)!;
    expect(plan.batch).toBe(1);
    expect(plan.items[0].oldValue).toBe('00123'); // text stays text
  });

  it('nothing to undo on an empty log', () => {
    expect(planUndo(head)).toBeNull();
  });
});

import { checkIdFormat } from '../src/core/checks/idFormat';
it('ID prefix includes fixed segments like "FA-0001-"', () => {
  const t = mk(['Nro'], Array.from({ length: 30 }, (_, i) => [`FA-0001-${String(1200 + i).padStart(8, '0')}`]));
  expect(checkIdFormat(t, 0, { minShare: 0.8, minValues: 20 }).description).toBe('"FA-0001-" followed by 8 digits');
  const u = mk(['t'], Array.from({ length: 30 }, (_, i) => [`TXN-${100000 + i * 37}`]));
  expect(checkIdFormat(u, 0, { minShare: 0.8, minValues: 20 }).description).toBe('"TXN-" followed by 6 digits');
});


import { runChecks } from '../src/core/run';
import { emptyState } from '../src/core/history';
import { groupByColumn } from '../src/ui/ColumnView';

describe('fix order', () => {
  // qty has words and price has a stand-in, total is calculated from them.
  const rows: (string | number)[][] = Array.from({ length: 80 }, (_, i) => [`T${1000 + i}`, 1 + (i % 4), 10 + (i % 9), (1 + (i % 4)) * (10 + (i % 9))]);
  rows.push(['T2000', 'two', 15, 30], ['T2001', 2, 7, 99], ...Array.from({ length: 12 }, (_, i) => [`T30${10 + i}`, 3, 999999.99, 45]));
  const t = mk(['id', 'quantity', 'unit_price', 'total'], rows);
  const r = runChecks(t, { keyColumn: 'id', dateColumn: null, measures: ['quantity', 'unit_price', 'total'], ignored: [], confirmedAt: '' }, emptyState(), { now: new Date('2026-10-15') });

  it('puts cleaning first and recalculation after, and says which columns to fix first', () => {
    const totals = r.findings.find((f) => f.id === 'totals:total')!;
    expect(totals.step).toBe(3);
    expect(totals.after).toEqual(expect.arrayContaining(['quantity', 'unit_price']));
    expect(r.findings.find((f) => f.id === 'nonNumeric:quantity')!.step).toBe(1);
  });

  it('column view lists the calculated column after its inputs, even when it is more severe', () => {
    const order = groupByColumn(r.findings, t.headers).map((g) => g.column);
    expect(order.indexOf('total')).toBeGreaterThan(order.indexOf('quantity'));
    expect(order.indexOf('total')).toBeGreaterThan(order.indexOf('unit_price'));
  });
});

import { checkRepeated, checkEmails } from '../src/core/checks/repeated';
import { hitStrength, VOCAB } from '../src/core/vocab';

describe('shared personal values and emails', () => {
  // 60 customers, 3 orders each, each with their own email; a default email typed on 15 of them.
  const rows: string[][] = [];
  for (let i = 0; i < 60; i++) for (let j = 0; j < 3; j++) rows.push([`C${i}`, `user${i}@mail.com`]);
  for (let i = 0; i < 15; i++) rows.push([`C${i}`, 'test@unrelated.org']);
  const t = mk(['customer_id', 'customer_email'], rows);

  it('flags a value shared by many different customers, not a customer repeating their own', () => {
    const [f] = checkRepeated(t, 1, 0, { minSpread: 10, timesTypical: 10 });
    expect(f.groups!.map((g) => g.key)).toEqual(['test@unrelated.org']);
    expect(f.fix!.values).toHaveLength(15);
  });

  it('without an ID column, leaves category-like columns alone', () => {
    const cat = mk(['district'], Array.from({ length: 200 }, (_, i) => [`District ${i % 40}`]));
    expect(checkRepeated(cat, 0, -1, { minSpread: 10, timesTypical: 10 })).toEqual([]);
  });

  it('flags malformed emails by reason', () => {
    const e = mk(['email'], [...Array.from({ length: 12 }, (_, i) => [`a${i}@b.com`]), ['ana@'], ['ana.gmail.com'], ['ana @ b.com']]);
    expect(checkEmails(e, 0)[0].groups!.map((g) => g.key).sort()).toEqual(['contains spaces', 'no @', 'nothing after @']);
  });
});

describe('vocabulary shared with the schema profiler', () => {
  it('uses the profiler rules: exact, prefix ("quant" → quantity), smushed ("fechapedido")', () => {
    expect(hitStrength(['cantidad'], VOCAB.measure)).toBe(1);
    expect(hitStrength(['quant'], VOCAB.measure)).toBe(0.6);
    expect(hitStrength(['fechapedido'], VOCAB.date)).toBe(0.6);
    expect(hitStrength(['cliente'], VOCAB.measure)).toBe(0);
    expect(VOCAB.key).toEqual(expect.arrayContaining(['id', 'cuit', 'factura']));
  });
});
