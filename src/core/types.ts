// Core types. Nothing in src/core touches Office.js, so it runs in tests and could run elsewhere.

/** One cell as Excel reports it: raw value, displayed text, number format. */
export interface Cell {
  /** Range.values: number | string | boolean. Empty cells are null. */
  v: string | number | boolean | null;
  /** Range.text: what the user sees. Shows the locale's separators even for real numbers. */
  t: string;
  /** Range.numberFormat. Currency symbols often live here, not in the value. */
  f: string;
  /** True when the cell holds a formula. We never overwrite formulas. */
  formula?: boolean;
}

export interface TableData {
  /** Excel table name, or null for a plain range. */
  tableName: string | null;
  sheet: string;
  /** Full address including the header row, e.g. "Ventas!A1:F120". */
  address: string;
  headers: string[];
  /** Data rows only (header excluded). rows[r][c]. */
  rows: Cell[][];
  /** 0-based worksheet row index of the first DATA row. */
  firstRow: number;
  /** 0-based worksheet column index of the first column. */
  firstCol: number;
}

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type CheckId =
  | 'duplicates'
  | 'blankKeys'
  | 'textNumbers'
  | 'nonNumeric'
  | 'mixedCurrency'
  | 'placeholders'
  | 'idFormat'
  | 'dateQuality'
  | 'variants'
  | 'consistency'
  | 'totals'
  | 'suspicious'
  | 'encoding'
  | 'repeated'
  | 'offTrend';

/** Position inside TableData.rows (not worksheet coordinates). */
export interface CellRef {
  row: number;
  col: number;
}

/** A labelled set of rows inside one finding (duplicate group, ID-format variant, date format...). */
export interface DuplicateGroup {
  key: string;
  rows: number[];
  /** Duplicates only: members differ only by spaces or case, so they look different but aren't. */
  hiddenVariant?: boolean;
  /** Short explanation shown next to the group. */
  note?: string;
}

/** A change the user can apply with one click (always confirmed first). */
export interface ConvertFix {
  kind: 'convertNumbers' | 'setValues';
  /** Button text, e.g. "Convert 7 to numbers". */
  label: string;
  /** value null clears the cell. */
  values: { row: number; col: number; value: number | string | null; numberFormat?: string }[];
  /** Applied to every changed cell unless the value carries its own. */
  numberFormat?: string;
}

export interface Finding {
  /** Stable id `${check}:${column}`, used for "ignore". */
  id: string;
  check: CheckId;
  severity: Severity;
  column: string;
  title: string;
  detail: string;
  cells: CellRef[];
  groups?: DuplicateGroup[];
  fix?: ConvertFix;
  /** Suggested fix order: 1 clean values, 2 fill & reconcile, 3 recalculate, 4 review. Set by runChecks. */
  step?: 1 | 2 | 3 | 4;
  /** Columns with open findings that should be fixed before this one (e.g. quantity, unit_price before total). */
  after?: string[];
  /** Other ways to fix the same problem, when the right one is a judgement call (e.g. day-first vs month-first). */
  altFixes?: ConvertFix[];
  /** Money (or units) affected, by currency. */
  impact?: { amount: number; currency: string | null }[];
}

/** Rules the user confirmed for one table. Stored in the workbook. */
export interface Rules {
  keyColumn: string | null;
  dateColumn: string | null;
  measures: string[];
  /** Used only when there is no date column: the period this snapshot represents (YYYY-MM). */
  snapshotPeriod?: string;
  ignored: string[];
  confirmedAt: string;
}

/** Compact summary of one data period. This is all the history we keep. */
export interface PeriodProfile {
  period: string; // YYYY-MM
  rows: number;
  /** What Excel's SUM sees: real numbers only. */
  sums: Record<string, number>;
  /** Amounts stored as text in this period (invisible to SUM). */
  hidden?: Record<string, number>;
  distinctKeys?: number;
  /** Last date seen in the period (ISO date), used to spot incomplete months. */
  lastDate?: string;
  recordedAt?: string;
  source?: 'file' | 'history';
}

export interface TableState {
  tableName: string | null;
  sheet: string;
  headerFingerprint: string;
  headers: string[];
  rules: Rules;
  periods: PeriodProfile[];
  updatedAt: string;
}

export interface WorkbookState {
  version: 1;
  tables: TableState[];
}
