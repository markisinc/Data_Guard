// Browser-only stand-in for Office.js, so the task pane can be opened and clicked through without Excel.
// Open https://localhost:3000/dev/mock.html?fixture=Ventas_Sep  (or Ventas_Acumulado). Not used in the add-in.
// Supports what the add-in uses: tables, selection, cell writes, the "DataGuard Changes" log sheet, custom XML.
import sep from '../fixtures/Ventas_Sep.json';
import acc from '../fixtures/Ventas_Acumulado.json';

type Snap = typeof sep;
const fixtures: Record<string, Snap> = { Ventas_Sep: sep, Ventas_Acumulado: acc as Snap };
const name = new URLSearchParams(location.search).get('fixture') ?? 'Ventas_Sep';
const snap = fixtures[name];

type MCell = { v: unknown; t: string; f: string };
const sheets = new Map<string, MCell[][]>();
sheets.set(snap.sheet, [
  snap.headers.map((h) => ({ v: h as unknown, t: h, f: 'General' })),
  ...snap.rows.map((r) => r.map((c) => ({ v: (c.v ?? '') as unknown, t: c.t, f: c.f }))),
]);
let xmlParts: { id: string; xml: string }[] = [];
try {
  xmlParts = JSON.parse(sessionStorage.getItem('mockXml:' + name) ?? '[]');
} catch {}
const persist = () => sessionStorage.setItem('mockXml:' + name, JSON.stringify(xmlParts));
const mock = { sheets, xmlParts, selected: [] as string[] };
(window as any).__mock = mock;

const L = (c: number) => String.fromCharCode(65 + c);
const parseA1 = (a: string) => {
  const m = a.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/)!;
  return { col: m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row: +m[2] - 1 };
};
const cellAt = (grid: MCell[][], r: number, c: number) => {
  while (grid.length <= r) grid.push([]);
  while (grid[r].length <= c) grid[r].push({ v: '', t: '', f: 'General' });
  return grid[r][c];
};

function range(sheet: string, row: number, col: number, nr: number, nc: number): any {
  const grid = sheets.get(sheet)!;
  const block = <T,>(fn: (c: MCell) => T) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(cellAt(grid, row + i, col + j))));
  const self: any = {
    address: `${sheet}!${L(col)}${row + 1}${nr * nc > 1 ? `:${L(col + nc - 1)}${row + nr}` : ''}`,
    rowCount: nr,
    columnCount: nc,
    rowIndex: row,
    columnIndex: col,
    format: { font: {} },
    load() {
      // Snapshot like Office.js does: reading .values after load doesn't rebuild the block every time.
      const snapVals = block((c) => c.v);
      Object.defineProperty(self, 'values', { get: () => snapVals, set: (v: unknown[][]) => v.forEach((r, i) => r.forEach((x, j) => Object.assign(cellAt(grid, row + i, col + j), { v: x, t: String(x) }))), configurable: true });
      self.text = block((c) => c.t);
      self.formulas = block((c) => c.v);
      const snapFmt = block((c) => c.f);
      Object.defineProperty(self, 'numberFormat', { get: () => snapFmt, set: (v: string[][]) => v.forEach((r, i) => r.forEach((x, j) => (cellAt(grid, row + i, col + j).f = x))), configurable: true });
      return self;
    },
    select() {
      mock.selected = [self.address];
    },
  };
  Object.defineProperty(self, 'values', { get: () => block((c) => c.v), set: (v: unknown[][]) => v.forEach((r, i) => r.forEach((x, j) => Object.assign(cellAt(grid, row + i, col + j), { v: x, t: String(x) }))), configurable: true });
  Object.defineProperty(self, 'worksheet', { get: () => worksheet(sheet) });
  Object.defineProperty(self, 'numberFormat', { get: () => block((c) => c.f), set: (v: string[][]) => v.forEach((r, i) => r.forEach((x, j) => (cellAt(grid, row + i, col + j).f = x))), configurable: true });
  return self;
}

function worksheet(sheet: string): any {
  return {
    name: sheet,
    isNullObject: !sheets.has(sheet),
    activate() {},
    getCell: (r: number, c: number) => range(sheet, r, c, 1, 1),
    getRangeByIndexes: (r: number, c: number, nr: number, nc: number) => range(sheet, r, c, nr, nc),
    getRange(a: string) {
      if (/^[A-Z]+:[A-Z]+$/.test(a)) return { numberFormat: null };
      const [s, e] = a.split(':').map(parseA1);
      const end = e ?? s;
      return range(sheet, s.row, s.col, end.row - s.row + 1, end.col - s.col + 1);
    },
    getRanges: (a: string) => ({ select() { mock.selected = a.split(','); } }),
    getUsedRange() {
      const grid = sheets.get(sheet)!;
      const nc = Math.max(...grid.map((r) => r.length));
      return range(sheet, 0, 0, grid.length, nc);
    },
  };
}

function part(p: { id: string; xml: string }) {
  return {
    id: p.id,
    getXml: () => ({ get value() { return p.xml; } }),
    setXml(x: string) { p.xml = x; persist(); },
    delete() { xmlParts.splice(xmlParts.indexOf(p), 1); persist(); },
  };
}

const workbook = {
  getSelectedRange() {
    return {
      rowCount: 1, columnCount: 1, load() {},
      getTables: () => ({
        items: [{ name: snap.tableName, getRange: () => range(snap.sheet, 0, 0, snap.rows.length + 1, snap.headers.length) }],
        load() {},
      }),
    };
  },
  worksheets: {
    getItem: (n: string) => worksheet(n),
    getItemOrNullObject: (n: string) => worksheet(n),
    add(n: string) {
      sheets.set(n, []);
      return worksheet(n);
    },
  },
  customXmlParts: {
    getByNamespace: () => {
      const coll: any = { load() { coll.items = xmlParts.map(part); }, items: [] };
      return coll;
    },
    add(xml: string) { xmlParts.push({ id: String(Date.now()), xml }); persist(); },
  },
};

(window as any).Excel = {
  run: async (fn: any) => fn({ workbook, sync: async () => {} }),
  SheetVisibility: { visible: 'Visible', hidden: 'Hidden', veryHidden: 'VeryHidden' },
};
(window as any).Office = {
  HostType: { Excel: 'Excel' },
  context: { requirements: { isSetSupported: () => true } },
  onReady: (cb: any) => cb({ host: 'Excel' }),
};
