import type { CellRef, ConvertFix, Finding, Severity, TableData } from '../core/types';
import { STEP_LABELS } from '../core/run';
import { FindingCard } from './FindingCard';
import { groupByColumn } from './ColumnView';
import { toAreas } from '../excel/workbook';

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const HINT: Record<1 | 2 | 3 | 4, string> = {
  1: 'Placeholders, text that should be numbers or dates, spelling and format variants. Later checks need these cleaned first.',
  2: 'Copy missing values from the same ID, pick between conflicting rows, decide on duplicates and stand-in numbers.',
  3: 'Totals that should equal other columns. Do this last, after the inputs are clean.',
  4: 'Things to check at the source: impossible dates, empty months, unusual monthly totals.',
};

interface Props {
  findings: Finding[];
  table: TableData;
  onSelect: (f: Finding, cells: CellRef[]) => void;
  onConvert: (f: Finding, fix: ConvertFix) => void;
  onIgnore: (f: Finding) => void;
}

/** Findings in the order they should be fixed, so one fix doesn't undo or skip another. */
export function FixOrderView({ findings, table, onSelect, onConvert, onIgnore }: Props) {
  // Column order (inputs before calculated columns) breaks ties inside a step.
  const colOrder = groupByColumn(findings, table.headers).map((g) => g.column);
  const rank = (f: Finding) => {
    const i = colOrder.indexOf(f.column);
    return i < 0 ? colOrder.length : i;
  };
  const steps = ([1, 2, 3, 4] as const)
    .map((step) => ({
      step,
      list: findings
        .filter((f) => (f.step ?? 4) === step)
        .sort((a, b) => rank(a) - rank(b) || ORDER[a.severity] - ORDER[b.severity]),
    }))
    .filter((s) => s.list.length);

  return (
    <div className="columns">
      {steps.map(({ step, list }) => (
        <section key={step} className="step">
          <h2>
            <span className="stepno">{step}</span> {STEP_LABELS[step]}
            <span className="muted small"> · {list.length}</span>
          </h2>
          <p className="muted small">{HINT[step]}</p>
          {list.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              table={table}
              onSelect={(cells) => onSelect(f, cells)}
              onConvert={(fix) => onConvert(f, fix)}
              onIgnore={() => onIgnore(f)}
              areaCount={toAreas(table, f.cells).areas.length}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
