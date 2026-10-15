// Off-trend: compare the newest period to the periods before it (from the file and from stored history).
// Compares month to month, never "whole column vs last run", so append-style files don't flag every run.
import type { Finding, PeriodProfile, Severity } from '../types';
import { daysInMonth } from '../dates';
import { formatAmount, type DecimalSep } from '../numbers';

export interface OffTrendParams {
  /** Change needed to flag when there are few earlier periods. */
  threshold: number;
  /** With enough history, the smallest change worth flagging (the z-score does the real work). */
  minChange: number;
  highThreshold: number;
  lookback: number;
  minPriorsForRobust: number;
  robustZ: number;
  incompleteGraceDays: number;
  /** Below this many rows per month, monthly totals are too small to compare (1 vs 2 rows is not a trend). */
  minRowsPerPeriod: number;
}

export interface MetricComparison {
  metric: string; // measure name, or "Rows"
  current: number;
  baseline: number; // expected value: last period x (1 + typical month-over-month growth)
  typicalGrowth: number;
  change: number; // (current - baseline) / |baseline|
  flagged: boolean;
}

export interface OffTrendResult {
  latest: PeriodProfile | null;
  priors: PeriodProfile[];
  comparisons: MetricComparison[];
  incomplete: boolean;
  findings: Finding[];
  status: 'baseline' | 'low-history' | 'ok';
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function checkOffTrend(
  periods: PeriodProfile[],
  measures: string[],
  params: OffTrendParams,
  decs: Record<string, DecimalSep | null> = {},
  today: Date = new Date(),
): OffTrendResult {
  const sorted = [...periods].sort((a, b) => a.period.localeCompare(b.period));
  const latest = sorted[sorted.length - 1] ?? null;
  if (!latest) return { latest, priors: [], comparisons: [], incomplete: false, findings: [], status: 'baseline' };
  const priors = sorted.slice(0, -1).slice(-params.lookback);

  // A month is "incomplete" if its last date is well before month end and the month isn't over yet,
  // or simply if the last date is early in the month. A half month will always look like a drop.
  let incomplete = false;
  if (latest.lastDate && /^\d{4}-\d{2}$/.test(latest.period)) {
    const lastDay = Number(latest.lastDate.slice(8, 10));
    const monthEnd = daysInMonth(latest.period);
    const todayKey = today.toISOString().slice(0, 7);
    incomplete = lastDay < monthEnd - params.incompleteGraceDays || todayKey === latest.period;
  }

  const typicalRows = priors.length ? median(priors.map((p) => p.rows)) : latest.rows;
  if (priors.length > 0 && Math.max(typicalRows, latest.rows) < params.minRowsPerPeriod) {
    return {
      latest,
      priors,
      comparisons: [],
      incomplete,
      status: 'baseline',
      findings: [
        {
          id: 'offTrend:sparse',
          check: 'offTrend',
          severity: 'info',
          column: '',
          title: 'Too few rows per month to compare months',
          detail: `About ${Math.round(typicalRows)} row(s) per month. If this date column isn't when the row happened (e.g. a birth date), change it in Edit rules or set it to "No date column".`,
          cells: [],
        },
      ],
    };
  }

  if (priors.length === 0) {
    return {
      latest,
      priors,
      comparisons: [],
      incomplete,
      status: 'baseline',
      findings: [
        {
          id: 'offTrend:baseline',
          check: 'offTrend',
          severity: 'info',
          column: '',
          title: `Baseline recorded for ${latest.period}`,
          detail:
            'This is the first period DataGuard has seen for this table. The summary is saved inside this workbook, so the next period (in this file or a copy of it) will be compared against it.',
          cells: [],
        },
      ],
    };
  }

  const metrics: { name: string; get: (p: PeriodProfile) => number | undefined }[] = [
    ...measures.map((m) => ({ name: m, get: (p: PeriodProfile) => p.sums[m] })),
    { name: 'Rows', get: (p: PeriodProfile) => p.rows },
  ];

  const comparisons: MetricComparison[] = [];
  const findings: Finding[] = [];
  for (const { name, get } of metrics) {
    const cur = get(latest);
    const prior = priors.map(get).filter((x): x is number => typeof x === 'number');
    if (cur === undefined || prior.length === 0) continue;
    // Expected value = last period grown by the table's typical month-over-month change.
    // That's how the analysts we interviewed reason ("I know what growth should be each month"),
    // and unlike a plain average it doesn't flag every month of a growing business.
    const growth: number[] = [];
    for (let i = 1; i < prior.length; i++) if (prior[i - 1] !== 0) growth.push(prior[i] / prior[i - 1] - 1);
    const typicalGrowth = growth.length ? median(growth) : 0;
    const last = prior[prior.length - 1];
    const base = last * (1 + typicalGrowth);
    const change = base === 0 ? (cur === 0 ? 0 : Infinity) : (cur - base) / Math.abs(base);
    let flagged: boolean;
    if (growth.length >= params.minPriorsForRobust - 1) {
      // Enough history: flag changes that are unusual *for this table* (robust z-score of this month's
      // growth against earlier growth rates), as long as they are at least minChange.
      const curGrowth = last !== 0 ? cur / last - 1 : Infinity;
      const mad = median(growth.map((g) => Math.abs(g - typicalGrowth)));
      const z = mad > 0 ? Math.abs((0.6745 * (curGrowth - typicalGrowth)) / mad) : Infinity;
      flagged = Math.abs(change) >= params.minChange && z >= params.robustZ;
    } else {
      flagged = Math.abs(change) >= params.threshold;
    }
    comparisons.push({ metric: name, current: cur, baseline: base, typicalGrowth, change, flagged });
    if (!flagged) continue;

    let severity: Severity = Math.abs(change) >= params.highThreshold ? 'high' : 'medium';
    const dec = decs[name] ?? null;
    const fmt = (n: number) => (name === 'Rows' ? formatAmount(Math.round(n), dec) : formatAmount(n, dec));
    const pct = Number.isFinite(change) ? `${change > 0 ? '+' : ''}${Math.round(change * 100)}%` : 'new';
    const g = `${typicalGrowth >= 0 ? '+' : ''}${Math.round(typicalGrowth * 100)}%`;
    let detail =
      `${name} for ${latest.period} is ${fmt(cur)}. Expected about ${fmt(base)} (${pct} off)` +
      (growth.length ? `, given a typical change of ${g} a month over ${prior.length} earlier periods.` : `, based on the previous period.`);

    const hidden = name !== 'Rows' ? latest.hidden?.[name] ?? 0 : 0;
    if (hidden && change < 0) {
      detail += ` ${fmt(hidden)} of this period's ${name} is stored as text. Counting it would make the total ${fmt(cur + hidden)}.`;
    }
    if (incomplete) {
      severity = 'info';
      detail += ` The latest date in this period is ${latest.lastDate}, so the month may not be complete yet.`;
    }
    if (prior.length < 3) detail += ' Few earlier periods yet, so treat this as a rough signal.';

    findings.push({
      id: `offTrend:${name}`,
      check: 'offTrend',
      severity,
      column: name === 'Rows' ? '' : name,
      title: `${name} ${change < 0 ? 'dropped' : 'jumped'} ${Number.isFinite(change) ? Math.abs(Math.round(change * 100)) + '%' : ''} vs. expected`.replace('  ', ' '),
      detail,
      cells: [],
    });
  }
  return {
    latest,
    priors,
    comparisons,
    incomplete,
    findings,
    status: priors.length < 3 ? 'low-history' : 'ok',
  };
}
