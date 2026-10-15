import { useState } from 'react';
import type { CellRef, ConvertFix, Finding, Severity, TableData } from '../core/types';
import { FindingCard } from './FindingCard';
import { toAreas } from '../excel/workbook';

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const TABLE_LEVEL = 'Whole table';

export interface ColumnGroup {
  column: string;
  findings: Finding[];
  worst: Severity;
  /** Distinct cells flagged in this column, across all its findings. */
  cellCount: number;
}

/**
 * One group per column, worst severity first; findings inside sorted by fix step, then severity.
 * A calculated column (total) always comes after the columns it's calculated from. Table-wide findings go last.
 */
export function groupByColumn(findings: Finding[], headers: string[]): ColumnGroup[] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.column && headers.includes(f.column) ? f.column : TABLE_LEVEL;
    map.set(key, [...(map.get(key) ?? []), f]);
  }
  const groups = [...map.entries()]
    .map(([column, list]) => {
      const sorted = [...list].sort((a, b) => (a.step ?? 4) - (b.step ?? 4) || ORDER[a.severity] - ORDER[b.severity]);
      const cells = new Set(sorted.flatMap((f) => f.cells.map((c) => `${c.row}:${c.col}`)));
      const worst = [...list].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])[0].severity;
      return { column, findings: sorted, worst, cellCount: cells.size };
    })
    .sort((a, b) => {
      if ((a.column === TABLE_LEVEL) !== (b.column === TABLE_LEVEL)) return a.column === TABLE_LEVEL ? 1 : -1;
      return ORDER[a.worst] - ORDER[b.worst] || b.cellCount - a.cellCount || headers.indexOf(a.column) - headers.indexOf(b.column);
    });
  return afterInputs(groups);
}

/** Move each group that must wait for other columns to just after the last of them (stable otherwise). */
function afterInputs(groups: ColumnGroup[]): ColumnGroup[] {
  const out = [...groups];
  for (let pass = 0; pass < out.length; pass++) {
    let moved = false;
    for (const g of [...out]) {
      const deps = new Set(g.findings.flatMap((f) => f.after ?? []));
      if (!deps.size) continue;
      const i = out.indexOf(g);
      const last = Math.max(...out.map((x, j) => (deps.has(x.column) ? j : -1)));
      if (last > i) {
        out.splice(i, 1);
        out.splice(last, 0, g);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

interface Props {
  findings: Finding[];
  table: TableData;
  onSelect: (f: Finding, cells: CellRef[]) => void;
  onConvert: (f: Finding, fix: ConvertFix) => void;
  onIgnore: (f: Finding) => void;
}

export function ColumnView({ findings, table, onSelect, onConvert, onIgnore }: Props) {
  const groups = groupByColumn(findings, table.headers);
  // Columns with a high-severity finding start open; the rest start collapsed.
  const [open, setOpen] = useState<Set<string>>(() => new Set(groups.filter((g) => g.worst === 'high').map((g) => g.column)));
  const toggle = (c: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  const allOpen = groups.every((g) => open.has(g.column));

  return (
    <div className="columns">
      <div className="row between">
        <span className="muted small">
          {groups.filter((g) => g.column !== TABLE_LEVEL).length} column{groups.length === 1 ? '' : 's'} with findings
        </span>
        <button className="link small" onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.column)))}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {groups.map((g) => {
        const counts = (['high', 'medium', 'info'] as Severity[])
          .map((s) => [s, g.findings.filter((f) => f.severity === s || (s === 'info' && f.severity === 'low')).length] as const)
          .filter(([, n]) => n > 0);
        const isOpen = open.has(g.column);
        return (
          <section key={g.column} className={`colgroup ${g.worst}`}>
            <button className="colhead" onClick={() => toggle(g.column)} aria-expanded={isOpen}>
              <span className="chev">{isOpen ? '▾' : '▸'}</span>
              <span className="colname">{g.column}</span>
              <span className="colmeta">
                {counts.map(([s, n]) => (
                  <span key={s} className={`pill ${s}`}>
                    {n} {s}
                  </span>
                ))}
                {g.cellCount > 0 && <span className="muted small">{g.cellCount} cells</span>}
              </span>
            </button>
            {isOpen &&
              g.findings.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  table={table}
                  compact
                  onSelect={(cells) => onSelect(f, cells)}
                  onConvert={(fix) => onConvert(f, fix)}
                  onIgnore={() => onIgnore(f)}
                  areaCount={toAreas(table, f.cells).areas.length}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}
