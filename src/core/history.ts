// Option A: history lives inside the workbook (a custom XML part), next to the confirmed rules.
// It travels with "Save As Ventas_Oct.xlsx" copies and with whoever opens the file next.
// We keep one entry per data period (not per run), so re-running on the same month overwrites it.
import type { PeriodProfile, Rules, TableData, TableState, WorkbookState } from './types';
import { headerTokens } from './columns';

export const XML_NAMESPACE = 'urn:dataguard:state:v1';

export function emptyState(): WorkbookState {
  return { version: 1, tables: [] };
}

/** Header fingerprint: survives renamed sheets and tables, changes if columns change. */
export function fingerprint(headers: string[]): string {
  const s = headers.map((h) => headerTokens(h).join('_')).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Find the stored state for this table: by Excel table name first, then by header fingerprint. */
export function findTableState(state: WorkbookState, table: TableData): TableState | null {
  const fp = fingerprint(table.headers);
  if (table.tableName) {
    const byName = state.tables.find((t) => t.tableName === table.tableName);
    if (byName) return byName;
  }
  return (
    state.tables.find((t) => t.headerFingerprint === fp && t.sheet === table.sheet) ??
    state.tables.find((t) => t.headerFingerprint === fp) ??
    null
  );
}

/** Current data wins for any period it contains; older periods come from history. */
export function mergePeriods(stored: PeriodProfile[], current: PeriodProfile[], maxKeep: number, now: string): PeriodProfile[] {
  const map = new Map<string, PeriodProfile>();
  for (const p of stored) map.set(p.period, { ...p, source: 'history' });
  for (const p of current) map.set(p.period, { ...p, source: 'file', recordedAt: now });
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period)).slice(-maxKeep);
}

export function upsertTableState(
  state: WorkbookState,
  table: TableData,
  rules: Rules,
  current: PeriodProfile[],
  maxKeep: number,
  now = new Date().toISOString(),
): { state: WorkbookState; table: TableState } {
  const existing = findTableState(state, table);
  const periods = mergePeriods(existing?.periods ?? [], current, maxKeep, now);
  const next: TableState = {
    tableName: table.tableName,
    sheet: table.sheet,
    headerFingerprint: fingerprint(table.headers),
    headers: table.headers,
    rules,
    // Stored copy drops the per-run "source" flag; it's recomputed on load.
    periods: periods.map(({ source: _s, ...p }) => p),
    updatedAt: now,
  };
  const tables = state.tables.filter((t) => t !== existing);
  tables.push(next);
  return { state: { version: 1, tables }, table: next };
}

// --- XML (de)serialisation ---------------------------------------------------------------
// JSON inside one element. Escaping <, > and & as \u00XX keeps it valid XML and valid JSON
// (those characters can only appear inside JSON strings).

export function toXml(state: WorkbookState): string {
  const json = JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<dataguard xmlns="${XML_NAMESPACE}" version="1"><state>${json}</state></dataguard>`;
}

export function fromXml(xml: string | null | undefined): WorkbookState {
  if (!xml) return emptyState();
  const m = xml.match(/<state>([\s\S]*)<\/state>/);
  if (!m) return emptyState();
  try {
    const parsed = JSON.parse(m[1]) as WorkbookState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.tables)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}
