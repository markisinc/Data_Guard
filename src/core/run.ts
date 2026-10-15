// One entry point: table + confirmed rules + stored workbook state -> findings, trend, new state.
import checksConfig from '../../config/checks.json';
import type { Finding, Rules, Severity, TableData, TableState, WorkbookState } from './types';
import { checkDuplicates } from './checks/duplicates';
import { checkTextNumbers } from './checks/textNumbers';
import { checkOffTrend, type OffTrendParams, type OffTrendResult } from './checks/offTrend';
import { profileByPeriod } from './periods';
import { checkPlaceholders } from './checks/placeholders';
import { checkIdFormat, type IdFormatParams } from './checks/idFormat';
import { checkDateQuality, type DateQualityParams } from './checks/dateQuality';
import { decimalSepFor, headerTokens, profileColumns } from './columns';
import { checkVariants, type VariantParams } from './checks/variants';
import { checkDependency, type DependencyParams } from './checks/dependency';
import { checkTotals, findProductRelation, type TotalsParams } from './checks/totals';
import { checkSuspicious, suspiciousValues } from './checks/suspicious';
import { checkEncoding } from './checks/encoding';
import { checkEmails, checkRepeated, type RepeatedParams } from './checks/repeated';
import { upsertTableState } from './history';
import type { DecimalSep } from './numbers';

type CheckDef = (typeof checksConfig.checks)[number];
const def = (id: string): CheckDef => checksConfig.checks.find((c) => c.id === id)!;
const offTrendParams = def('offTrend').params as unknown as OffTrendParams & { maxStoredPeriods: number };
const textParams = def('textNumbers').params as { minNumericShare: number };
const idParams = def('idFormat').params as IdFormatParams;
const variantParams = def('variants').params as VariantParams;
const dependencyParams = def('consistency').params as DependencyParams;
const totalsParams = def('totals').params as TotalsParams;
const repeatedParams = def('repeated').params as RepeatedParams;
const dateParams = { ...(def('dateQuality').params as Omit<DateQualityParams, 'minRowsPerPeriod'>), minRowsPerPeriod: offTrendParams.minRowsPerPeriod };

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

// Fix order. Cleaning values first means later steps see the corrected data: converting "two" to 2 in quantity
// changes which totals can be checked, so recalculating totals comes after.
const STEP: Record<string, 1 | 2 | 3 | 4> = {
  placeholders: 1, encoding: 1, repeated: 1, email: 1, textNumbers: 1, nonNumeric: 1, variants: 1, idFormat: 1, blankKeys: 1, textDates: 1, undated: 1,
  fillFromId: 2, conflict: 2, duplicates: 2, mixedCurrency: 2, suspicious: 2,
  totals: 3, totalsMissing: 3,
  dateRange: 4, dateGaps: 4, idGaps: 4, offTrend: 4,
};
export const STEP_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Clean up values',
  2: 'Fill gaps and resolve conflicts',
  3: 'Recalculate',
  4: 'Review (no automatic fix)',
};

export interface RunResult {
  findings: Finding[];
  ignoredCount: number;
  trend: OffTrendResult;
  undatedRows: number[];
  /** Plain-words ID format per checked column, e.g. '"TXN-" followed by 6 digits'. */
  idFormats: Record<string, string>;
  /** Decimal separator per measure, for display. */
  decs: Record<string, DecimalSep | null>;
  state: WorkbookState;
  tableState: TableState;
}

export function runChecks(
  table: TableData,
  rules: Rules,
  state: WorkbookState,
  opts: { now?: Date } = {},
): RunResult {
  const now = opts.now ?? new Date();
  const col = (h: string | null) => (h === null ? -1 : table.headers.indexOf(h));
  let findings: Finding[] = [];

  const keyCol = col(rules.keyColumn);
  if (keyCol >= 0) findings.push(...checkDuplicates(table, keyCol));

  const dateCol = col(rules.dateColumn);

  // Placeholders (N/A, NULL, -...) in every column except the ID column, which reports them as missing IDs.
  table.headers.forEach((_h, c) => {
    if (c !== keyCol) findings.push(...checkPlaceholders(table, c));
  });

  // ID format: the confirmed ID column, plus other columns that are clearly IDs (customer_id, Cliente_ID).
  const idFormats: Record<string, string> = {};
  table.headers.forEach((h, c) => {
    const looksLikeId = headerTokens(h).includes('id');
    if (c !== keyCol && (!looksLikeId || c === dateCol)) return;
    const r = checkIdFormat(table, c, idParams);
    if (r.description) idFormats[h] = r.description;
    findings.push(...r.findings);
  });

  // Date sanity first: rows with impossible dates must not drive the monthly totals.
  const dq = dateCol >= 0 ? checkDateQuality(table, dateCol, dateParams, now) : null;
  if (dq) findings.push(...dq.findings);

  table.headers.forEach((_h, c) => {
    if (c === keyCol || c === dateCol) return; // IDs stored as text are fine; dates are handled separately
    findings.push(
      ...checkTextNumbers(table, c, {
        minNumericShare: textParams.minNumericShare,
        isMeasure: rules.measures.includes(table.headers[c]),
      }),
    );
  });

  const profiles = profileColumns(table);
  const idLike = (c: number) => headerTokens(table.headers[c]).includes('id') || c === keyCol;

  // Garbled accents (any text column), then spelling variants in category-like text columns.
  table.headers.forEach((_h, c) => findings.push(...checkEncoding(table, c)));
  table.headers.forEach((_h, c) => {
    if (c === dateCol || idLike(c)) return;
    findings.push(...checkVariants(table, c, variantParams));
  });

  // Columns that identify something and repeat (customer_id): the reference for per-entity checks.
  const refs = profiles.filter((p) => idLike(p.index) && p.index !== dateCol && p.nonEmpty > 0 && p.distinct < p.nonEmpty * 0.95);

  // Personal values shared by too many records (default/test emails), and malformed emails.
  table.headers.forEach((_h, c) => {
    if (c === dateCol || idLike(c)) return;
    findings.push(...checkRepeated(table, c, refs[0]?.index ?? -1, repeatedParams));
    findings.push(...checkEmails(table, c));
  });

  // Columns determined by an ID (customer_id -> name): fill gaps, flag disagreements.
  refs.forEach((ref) => {
      table.headers.forEach((_h, c) => {
        if (c === ref.index || c === keyCol || c === dateCol || idLike(c)) return;
        findings.push(...checkDependency(table, ref.index, c, dependencyParams));
      });
    });

  // Totals = quantity × price.
  const numericCols = profiles
    .filter((p) => p.index !== keyCol && p.index !== dateCol && !idLike(p.index) && p.realNumbers >= 20 && p.numericShare >= 0.8)
    .map((p) => p.index);
  // Stand-in numbers in the inputs (price, quantity). A calculated total inherits them, so it isn't flagged twice.
  const rel = numericCols.length >= 3 ? findProductRelation(table, numericCols, totalsParams) : null;
  for (const c of numericCols) if (rules.measures.includes(table.headers[c]) && c !== rel?.c) findings.push(...checkSuspicious(table, c));
  if (numericCols.length >= 3) {
    const dec = numericCols.map((c) => decimalSepFor(table, c)).find((d) => d) ?? null;
    findings.push(...checkTotals(table, numericCols, totalsParams, dec));
  }

  // Period profiles from this file, merged with what the workbook remembers.
  const standIns = new Map(
    rules.measures.filter((m) => col(m) >= 0).map((m) => [m, new Set([...suspiciousValues(table, col(m)).values()].flat())]),
  );
  const { periods: current, undated } = profileByPeriod(table, rules, dq?.excludeRows, standIns);
  const { state: nextState, table: tableState } = upsertTableState(
    state,
    table,
    rules,
    current,
    offTrendParams.maxStoredPeriods,
    now.toISOString(),
  );
  const fileKeys = new Set(current.map((p) => p.period));
  const merged = tableState.periods.map((p) => ({ ...p, source: fileKeys.has(p.period) ? ('file' as const) : ('history' as const) }));
  // Only compare against periods before the newest one in the file. Re-opening an old copy must not
  // compare September against October.
  const newestInFile = current.length ? current[current.length - 1].period : null;
  const comparable = newestInFile ? merged.filter((p) => p.period <= newestInFile) : merged;

  const decs: Record<string, DecimalSep | null> = {};
  for (const m of rules.measures) if (col(m) >= 0) decs[m] = decimalSepFor(table, col(m));
  // Integer-only columns (quantities) carry no separator hint: borrow the table's.
  const tableDec = Object.values(decs).find((d) => d) ?? null;
  for (const m of rules.measures) decs[m] = decs[m] ?? tableDec;
  const trend = checkOffTrend(comparable, rules.measures, offTrendParams, decs, now);
  trend.priors = trend.priors.map((p) => merged.find((m) => m.period === p.period) ?? p);
  findings.push(...trend.findings);

  // Steps, and "fix these columns first" for calculated columns.
  for (const f of findings) f.step = STEP[f.id.split(':')[0]] ?? 4;
  if (rel) {
    const inputs = [table.headers[rel.a], table.headers[rel.b]];
    const open = findings.filter((f) => inputs.includes(f.column) && (f.step ?? 4) < 3 && !rules.ignored.includes(f.id) && (f.fix || f.altFixes?.length || f.check === 'suspicious'));
    if (open.length) {
      const cols = [...new Set(open.map((f) => f.column))];
      for (const f of findings) {
        if (f.check !== 'totals') continue;
        f.after = cols;
      }
    }
  }

  const before = findings.length;
  findings = findings.filter((f) => !rules.ignored.includes(f.id));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    findings,
    ignoredCount: before - findings.length,
    trend,
    undatedRows: undated,
    idFormats,
    decs,
    state: nextState,
    tableState,
  };
}

export { checksConfig };
