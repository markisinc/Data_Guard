// The undo log. Every fix writes one row per changed cell to a "DataGuard Changes" sheet:
// what changed, when, old and new value. "Undo last fix" restores a batch, but only cells nobody edited since.
// Excel usually can't undo add-in changes, and auditors want a trail anyway.

export const LOG_SHEET = 'DataGuard Changes';
export const LOG_HEADERS = ['Batch', 'When', 'Fix', 'Sheet', 'Cell', 'Old value', 'New value', 'Status', 'Old (raw)', 'New (raw)', 'Old format'] as const;
const C = Object.fromEntries(LOG_HEADERS.map((h, i) => [h, i])) as Record<(typeof LOG_HEADERS)[number], number>;

export type CellValue = string | number | boolean;

export interface Change {
  sheet: string;
  address: string; // e.g. "F12"
  oldValue: CellValue;
  newValue: CellValue;
  oldFormat: string;
}

/** Raw values are JSON so "00123" stays text and 123 stays a number on undo. */
const raw = (v: CellValue) => JSON.stringify(v);
const show = (v: CellValue) => (v === '' ? '(blank)' : String(v));

export function logRows(batch: number, when: Date, fixLabel: string, changes: Change[]): (string | number)[][] {
  const stamp = when.toISOString().replace('T', ' ').slice(0, 16);
  return changes.map((c) => [batch, stamp, fixLabel, c.sheet, c.address, show(c.oldValue), show(c.newValue), 'applied', raw(c.oldValue), raw(c.newValue), c.oldFormat]);
}

export function nextBatch(log: unknown[][]): number {
  let max = 0;
  for (const r of log.slice(1)) { const b = r[C.Batch]; if (typeof b === "number" && b > max) max = b; }
  return max + 1;
}

export interface UndoPlan {
  batch: number;
  fix: string;
  /** 0-based row index in the log sheet, and what to put back. */
  items: { logRow: number; sheet: string; address: string; oldValue: CellValue; newValue: CellValue; oldFormat: string }[];
}

/** The most recent batch that is still applied, or null. */
export function planUndo(log: unknown[][]): UndoPlan | null {
  let batch = 0;
  for (const r of log.slice(1)) { const b = r[C.Batch]; if (r[C.Status] === "applied" && typeof b === "number" && b > batch) batch = b; }
  if (!batch) return null;
  const items: UndoPlan['items'] = [];
  let fix = '';
  log.forEach((r, i) => {
    if (i === 0 || r[C.Batch] !== batch || r[C.Status] !== 'applied') return;
    fix = String(r[C.Fix]);
    try {
      items.push({
        logRow: i,
        sheet: String(r[C.Sheet]),
        address: String(r[C.Cell]),
        oldValue: JSON.parse(String(r[C['Old (raw)']])),
        newValue: JSON.parse(String(r[C['New (raw)']])),
        oldFormat: String(r[C['Old format']] || 'General'),
      });
    } catch {
      /* a hand-edited log row: skip it */
    }
  });
  return { batch, fix, items };
}

export const STATUS_COL = C.Status;

/** Excel can hand back 5 for a cell we wrote as 5.0, or "" for blank: compare loosely. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === '' || a === null) && (b === '' || b === null)) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}
