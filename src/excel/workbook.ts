// Everything that talks to Excel. Kept thin: read the table, select cells, write converted numbers,
// load/save the DataGuard state part. All logic lives in src/core.
import type { CellRef, ConvertFix, TableData, WorkbookState } from '../core/types';
import { XML_NAMESPACE, emptyState, fromXml, toXml } from '../core/history';
import { LOG_HEADERS, LOG_SHEET, STATUS_COL, logRows, nextBatch, planUndo, sameValue, type CellValue, type Change } from '../core/changelog';

// Up to a million cells (e.g. 100k rows × 10 columns), read in slices so each round trip stays small
// (Excel on the web caps how much one request can return).
const MAX_CELLS = 1_000_000;
const CHUNK_CELLS = 25_000;

export function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const sheetOf = (address: string) => address.slice(0, address.lastIndexOf('!')).replace(/^'|'$/g, '').replace(/''/g, "'");

/**
 * Read the Excel table under the selection. If the selection isn't in a table, use the selection itself,
 * or, for a single cell, the block of data around it. First row is the header.
 */
export async function readActiveTable(): Promise<TableData> {
  return Excel.run(async (ctx) => {
    const sel = ctx.workbook.getSelectedRange();
    sel.load(['rowCount', 'columnCount']);
    const tables = sel.getTables(false);
    tables.load('items/name');
    await ctx.sync();

    let range: Excel.Range;
    let tableName: string | null = null;
    if (tables.items.length > 0) {
      tableName = tables.items[0].name;
      range = tables.items[0].getRange();
    } else if (sel.rowCount * sel.columnCount === 1) {
      range = Office.context.requirements.isSetSupported('ExcelApi', '1.13')
        ? sel.getSurroundingRegion()
        : sel.worksheet.getUsedRange(true);
    } else {
      range = sel;
    }
    range.load(['address', 'rowCount', 'columnCount', 'rowIndex', 'columnIndex']);
    await ctx.sync();
    if (range.rowCount < 2) throw new Error('Select a table with a header row and at least one row of data.');
    if (range.rowCount * range.columnCount > MAX_CELLS)
      throw new Error(`This table has ${(range.rowCount * range.columnCount).toLocaleString()} cells. DataGuard handles up to ${MAX_CELLS.toLocaleString()}; select a smaller range.`);

    const ws = range.worksheet;
    const nCols = range.columnCount;
    const step = Math.max(1, Math.floor(CHUNK_CELLS / nCols));
    const values: unknown[][] = [];
    const text: string[][] = [];
    const formats: string[][] = [];
    const formulas: unknown[][] = [];
    for (let start = 0; start < range.rowCount; start += step) {
      const n = Math.min(step, range.rowCount - start);
      const part = ws.getRangeByIndexes(range.rowIndex + start, range.columnIndex, n, nCols);
      part.load(['values', 'text', 'numberFormat', 'formulas']);
      await ctx.sync();
      values.push(...part.values);
      text.push(...(part.text as string[][]));
      formats.push(...(part.numberFormat as string[][]));
      formulas.push(...part.formulas);
    }

    const headers = (text[0] as string[]).map((h, i) => (h?.trim() ? h.trim() : `Column ${colLetter(range.columnIndex + i)}`));
    const rows = [];
    for (let r = 1; r < range.rowCount; r++) {
      const row = [];
      for (let c = 0; c < nCols; c++) {
        const v = values[r][c] as string | number | boolean;
        const formula = formulas[r][c];
        row.push({
          v: v === '' ? null : v,
          t: String(text[r][c] ?? ''),
          f: String(formats[r][c] ?? 'General'),
          formula: typeof formula === 'string' && formula.startsWith('='),
        });
      }
      rows.push(row);
    }
    return {
      tableName,
      sheet: sheetOf(range.address),
      address: range.address,
      headers,
      rows,
      firstRow: range.rowIndex + 1,
      firstCol: range.columnIndex,
    };
  });
}

/** Turn cell refs into compact addresses: consecutive rows in a column become one area ("F5:F9"). */
export function toAreas(table: TableData, cells: CellRef[], maxAreas = 200): { areas: string[]; truncated: boolean } {
  const byCol = new Map<number, number[]>();
  for (const { row, col } of cells) {
    const list = byCol.get(col) ?? [];
    list.push(row);
    byCol.set(col, list);
  }
  const areas: string[] = [];
  for (const [col, rows] of byCol) {
    const sorted = [...new Set(rows)].sort((a, b) => a - b);
    const L = colLetter(table.firstCol + col);
    let start = sorted[0];
    let prev = sorted[0];
    const flush = () => {
      const a = table.firstRow + start + 1;
      const b = table.firstRow + prev + 1;
      areas.push(a === b ? `${L}${a}` : `${L}${a}:${L}${b}`);
    };
    for (const r of sorted.slice(1)) {
      if (r === prev + 1) prev = r;
      else {
        flush();
        start = prev = r;
      }
    }
    if (sorted.length) flush();
  }
  return { areas: areas.slice(0, maxAreas), truncated: areas.length > maxAreas };
}

/**
 * Select the flagged cells. Multi-area selection needs ExcelApi 1.18; on older Excel we select the first cell
 * and the UI lists the rest (each one clickable).
 */
export async function selectCells(table: TableData, cells: CellRef[]): Promise<{ selected: number; truncated: boolean }> {
  if (!cells.length) return { selected: 0, truncated: false };
  const { areas, truncated } = toAreas(table, cells);
  return Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItem(table.sheet);
    ws.activate();
    if (areas.length > 1 && Office.context.requirements.isSetSupported('ExcelApi', '1.18')) {
      // RangeAreas.select() is ExcelApi 1.18; older @types/office-js don't declare it yet.
      (ws.getRanges(areas.join(',')) as unknown as { select(): void }).select();
      await ctx.sync();
      return { selected: areas.length, truncated };
    }
    ws.getRange(areas[0]).select();
    await ctx.sync();
    return { selected: 1, truncated: areas.length > 1 || truncated };
  });
}

/**
 * Apply a fix and record every changed cell in the "DataGuard Changes" sheet so it can be undone.
 * Skips cells that changed since we read them, and never touches formulas.
 */
export async function applyFix(table: TableData, fix: ConvertFix, findingTitle: string): Promise<{ written: number; skipped: number; batch: number }> {
  return Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItem(table.sheet);
    const targets = fix.values.map((x) => {
      const r = ws.getCell(table.firstRow + x.row, table.firstCol + x.col);
      r.load(['values', 'formulas', 'numberFormat', 'address']);
      return { x, r };
    });
    await ctx.sync();

    const changes: Change[] = [];
    let skipped = 0;
    for (const { x, r } of targets) {
      const current = r.values[0][0] as CellValue;
      const formula = r.formulas[0][0];
      if (!sameValue(current, table.rows[x.row][x.col].v ?? '') || (typeof formula === 'string' && formula.startsWith('='))) {
        skipped++;
        continue;
      }
      const newValue: CellValue = x.value === null ? '' : x.value;
      const fmt = x.numberFormat ?? fix.numberFormat;
      changes.push({ sheet: table.sheet, address: r.address.split('!').pop()!, oldValue: current, newValue, oldFormat: String(r.numberFormat[0][0] ?? 'General') });
      if (fmt) r.numberFormat = [[fmt]];
      r.values = [[newValue]];
    }
    const batch = changes.length ? await appendLog(ctx, `${fix.label} — ${findingTitle}`, changes) : 0;
    await ctx.sync();
    return { written: changes.length, skipped, batch };
  });
}

async function logSheet(ctx: Excel.RequestContext): Promise<{ ws: Excel.Worksheet; values: unknown[][] }> {
  let ws = ctx.workbook.worksheets.getItemOrNullObject(LOG_SHEET);
  await ctx.sync();
  if (ws.isNullObject) {
    ws = ctx.workbook.worksheets.add(LOG_SHEET);
    const head = ws.getRangeByIndexes(0, 0, 1, LOG_HEADERS.length);
    head.values = [[...LOG_HEADERS]];
    head.format.font.bold = true;
    // Raw columns are text so JSON like "123" isn't turned into a number by Excel.
    ws.getRange('I:K').numberFormat = [['@']];
    // Out of the way: "very hidden" sheets don't appear in Excel's Unhide list. The pane can show it on request.
    ws.visibility = Excel.SheetVisibility.veryHidden;
    await ctx.sync();
    return { ws, values: [[...LOG_HEADERS]] };
  }
  const used = ws.getUsedRange(true);
  used.load('values');
  await ctx.sync();
  return { ws, values: used.values };
}

async function appendLog(ctx: Excel.RequestContext, label: string, changes: Change[]): Promise<number> {
  const { ws, values } = await logSheet(ctx);
  const batch = nextBatch(values);
  const rows = logRows(batch, new Date(), label, changes);
  const range = ws.getRangeByIndexes(values.length, 0, rows.length, LOG_HEADERS.length);
  range.numberFormat = rows.map(() => LOG_HEADERS.map((_h, i) => (i >= 8 ? '@' : 'General')));
  range.values = rows;
  return batch;
}

/** Show the change log sheet (and go to it), or hide it again. Returns false if there is no log yet. */
export async function setChangeLogVisible(visible: boolean): Promise<boolean> {
  return Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItemOrNullObject(LOG_SHEET);
    await ctx.sync();
    if (ws.isNullObject) return false;
    if (visible) {
      ws.visibility = Excel.SheetVisibility.visible;
      ws.activate();
    } else {
      ws.visibility = Excel.SheetVisibility.veryHidden;
    }
    await ctx.sync();
    return true;
  });
}

/** Undo the most recent fix. Cells edited since the fix are left alone and counted as skipped. */
export async function undoLastFix(): Promise<{ fix: string; restored: number; skipped: number } | null> {
  return Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItemOrNullObject(LOG_SHEET);
    await ctx.sync();
    if (ws.isNullObject) return null;
    const used = ws.getUsedRange(true);
    used.load('values');
    await ctx.sync();
    const plan = planUndo(used.values);
    if (!plan) return null;

    const cells = plan.items.map((it) => {
      const r = ctx.workbook.worksheets.getItem(it.sheet).getRange(it.address);
      r.load(['values', 'formulas']);
      return { it, r };
    });
    await ctx.sync();
    let restored = 0;
    let skipped = 0;
    for (const { it, r } of cells) {
      const f = r.formulas[0][0];
      const status = ws.getCell(it.logRow, STATUS_COL);
      if (!sameValue(r.values[0][0], it.newValue) || (typeof f === 'string' && f.startsWith('='))) {
        skipped++;
        status.values = [['kept (edited since)']];
        continue;
      }
      r.numberFormat = [[it.oldFormat]];
      r.values = [[it.oldValue]];
      status.values = [['undone']];
      restored++;
    }
    await ctx.sync();
    return { fix: plan.fix, restored, skipped };
  });
}

// --- State stored in the workbook (custom XML part) ------------------------------------------

export async function loadState(): Promise<WorkbookState> {
  return Excel.run(async (ctx) => {
    const parts = ctx.workbook.customXmlParts.getByNamespace(XML_NAMESPACE);
    parts.load('items');
    await ctx.sync();
    if (!parts.items.length) return emptyState();
    const xml = parts.items[0].getXml();
    await ctx.sync();
    return fromXml(xml.value);
  });
}

export async function saveState(state: WorkbookState): Promise<void> {
  const xml = toXml(state);
  await Excel.run(async (ctx) => {
    const parts = ctx.workbook.customXmlParts.getByNamespace(XML_NAMESPACE);
    parts.load('items');
    await ctx.sync();
    if (parts.items.length) {
      parts.items[0].setXml(xml);
      // Clean up stray duplicates (e.g. two add-in instances racing on first save).
      parts.items.slice(1).forEach((p) => p.delete());
    } else {
      ctx.workbook.customXmlParts.add(xml);
    }
    await ctx.sync();
  });
}

/** Remove everything DataGuard stored in this workbook. */
export async function clearState(): Promise<void> {
  await Excel.run(async (ctx) => {
    const parts = ctx.workbook.customXmlParts.getByNamespace(XML_NAMESPACE);
    parts.load('items');
    await ctx.sync();
    parts.items.forEach((p) => p.delete());
    await ctx.sync();
  });
}
