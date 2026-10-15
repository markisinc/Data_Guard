import { useState } from 'react';
import type { CellRef, ConvertFix, Finding, TableData } from '../core/types';
import { colLetter } from '../excel/workbook';

interface Props {
  finding: Finding;
  table: TableData;
  areaCount: number;
  onSelect: (cells: CellRef[]) => void;
  onConvert: (fix: ConvertFix) => void;
  onIgnore: () => void;
  /** Inside a column group: column name is already in the group header. */
  compact?: boolean;
}

const addr = (t: TableData, c: CellRef) => `${colLetter(t.firstCol + c.col)}${t.firstRow + c.row + 1}`;
const LIST_LIMIT = 30;

export function FindingCard({ finding: f, table, areaCount, onSelect, onConvert, onIgnore, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConvertFix | null>(null);
  const fixes = [...(f.fix ? [f.fix] : []), ...(f.altFixes ?? [])];
  const hasCells = f.cells.length > 0;

  return (
    <section className={`card finding ${f.severity}`}>
      <div className="row between">
        <span className={`pill ${f.severity}`}>{f.severity}</span>
        {f.column && !compact && <span className="muted small">{f.column}</span>}
      </div>
      <h3>{f.title}</h3>
      {f.after && f.after.length > 0 && (
        <div className="after">
          Do this after fixing {f.after.join(' and ')}. Their open findings change the values used here, and rows with text in
          those columns can't be checked yet.
        </div>
      )}
      <p>{f.detail}</p>

      <div className="row wrap">
        {hasCells && (
          <button className="secondary" onClick={() => onSelect(f.cells)}>
            Select {f.cells.length} cell{f.cells.length > 1 ? 's' : ''}
          </button>
        )}
        {!confirming &&
          fixes.map((fx, i) => (
            <button key={fx.label} className={i === 0 ? 'primary' : 'secondary'} onClick={() => setConfirming(fx)}>
              {fx.label}
            </button>
          ))}
        {hasCells && (areaCount > 1 || f.groups) && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? 'Hide list' : 'Show list'}
          </button>
        )}
        <button className="link muted" onClick={onIgnore} title="Don't show this again for this table">
          Ignore
        </button>
      </div>

      {confirming && (
        <div className="confirm">
          <p className="small">
            <b>{confirming.label}:</b> {confirming.values.length} cell{confirming.values.length > 1 ? 's' : ''} will change, e.g.{' '}
            {confirming.values.slice(0, 3).map((x, i) => (
              <span key={i}>
                {i > 0 && ', '}"{table.rows[x.row][x.col].t}" → {x.value === null ? '(blank)' : `"${x.value}"`}
              </span>
            ))}
            . Old values are saved in the change log, and <b>Undo last fix</b> puts them back.
            {f.after && f.after.length > 0 && <> <b>{f.after.join(' and ')} still have open findings</b>; fixing them first avoids redoing this.</>}
          </p>
          <div className="row">
            <button className="primary" onClick={() => { const fx = confirming; setConfirming(null); onConvert(fx); }}>
              Apply
            </button>
            <button className="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {open && f.groups && (
        <ul className="list">
          {f.groups.slice(0, LIST_LIMIT).map((g) => {
            const cells = g.rows.map((row) => ({ row, col: f.cells[0].col }));
            return (
              <li key={g.key}>
                <button className="link" onClick={() => onSelect(cells)}>
                  {g.key}
                </button>{' '}
                <span className="muted">
                  × {g.rows.length}
                  {g.rows.length <= 4 && ` · ${cells.map((c) => addr(table, c)).join(', ')}`}
                  {g.hiddenVariant && ' · differs only by spaces/case'}
                  {g.note && ` · ${g.note}`}
                </span>
              </li>
            );
          })}
          {f.groups.length > LIST_LIMIT && <li className="muted">…and {f.groups.length - LIST_LIMIT} more</li>}
        </ul>
      )}

      {open && !f.groups && (
        <ul className="list">
          {f.cells.slice(0, LIST_LIMIT).map((c) => (
            <li key={`${c.row}:${c.col}`}>
              <button className="link" onClick={() => onSelect([c])}>
                {addr(table, c)}
              </button>{' '}
              <span className="muted">{table.rows[c.row][c.col].t}</span>
            </li>
          ))}
          {f.cells.length > LIST_LIMIT && <li className="muted">…and {f.cells.length - LIST_LIMIT} more</li>}
        </ul>
      )}
    </section>
  );
}
