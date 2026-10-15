import type { Rules } from '../core/types';
import type { RunResult } from '../core/run';
import { formatAmount } from '../core/numbers';

/** Month-by-month totals, newest last, with a small bar per month for the first measure. */
export function Trend({ result, rules }: { result: RunResult; rules: Rules }) {
  const { trend } = result;
  if (!trend.latest) return null;
  const periods = [...trend.priors, trend.latest];
  // Bar for the measure with the largest totals (usually the money column).
  const measure = [...rules.measures].sort((a, b) => Math.abs(trend.latest!.sums[b] ?? 0) - Math.abs(trend.latest!.sums[a] ?? 0))[0];
  const max = measure ? Math.max(...periods.map((p) => Math.abs(p.sums[measure] ?? 0)), 1) : 1;
  const flagged = new Set(trend.comparisons.filter((c) => c.flagged).map((c) => c.metric));

  return (
    <section className="card">
      <h2>Month by month</h2>
      <p className="muted small">
        {trend.status === 'baseline'
          ? 'First period seen. The next one will be compared against it.'
          : trend.status === 'low-history'
            ? `Compared with ${trend.priors.length} earlier period${trend.priors.length > 1 ? 's' : ''}. More history makes this sharper.`
            : `Latest period compared with the ${trend.priors.length} before it.`}
      </p>
      <table className="trend">
        <thead>
          <tr>
            <th>Month</th>
            <th className="num">Rows</th>
            {rules.measures.map((m) => (
              <th key={m} className="num">
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => {
            const isLatest = p.period === trend.latest!.period;
            return (
              <tr key={p.period} className={isLatest ? 'latest' : ''}>
                <td>
                  {p.period}
                  {p.source === 'history' && <span className="tag" title="From an earlier check saved in this workbook">saved</span>}
                </td>
                <td className={`num ${isLatest && flagged.has('Rows') ? 'flag' : ''}`}>{p.rows}</td>
                {rules.measures.map((m) => (
                  <td key={m} className={`num ${isLatest && flagged.has(m) ? 'flag' : ''}`}>
                    {formatAmount(p.sums[m] ?? 0, result.decs[m] ?? null)}
                    {m === measure && (
                      <div className="bar" style={{ width: `${(Math.abs(p.sums[m] ?? 0) / max) * 100}%` }} />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
