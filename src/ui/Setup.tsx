import { useMemo, useState } from 'react';
import type { Rules, TableData } from '../core/types';
import { profileColumns, type SetupSuggestion } from '../core/columns';
import { checkIdFormat } from '../core/checks/idFormat';
import { checksConfig } from '../core/run';

interface Props {
  table: TableData;
  suggestion: SetupSuggestion;
  initial: Rules;
  onConfirm: (rules: Rules) => void;
}

export function Setup({ table, suggestion, initial, onConfirm }: Props) {
  const [keyColumn, setKey] = useState<string | null>(initial.keyColumn);
  const [dateColumn, setDate] = useState<string | null>(initial.dateColumn);
  const [measures, setMeasures] = useState<string[]>(initial.measures);
  const [period, setPeriod] = useState(initial.snapshotPeriod ?? new Date().toISOString().slice(0, 7));
  const [ignored, setIgnored] = useState<string[]>(initial.ignored);

  const profiles = useMemo(() => profileColumns(table), [table]);
  const keyProfile = profiles.find((p) => p.header === keyColumn);
  const keyBlank = keyProfile ? table.rows.length - keyProfile.nonEmpty : 0;
  const keyDupes = keyProfile ? keyProfile.nonEmpty - keyProfile.distinct : 0;
  const keyFormat = useMemo(() => {
    if (!keyProfile) return null;
    const params = checksConfig.checks.find((c) => c.id === 'idFormat')!.params as { minShare: number; minValues: number };
    const r = checkIdFormat(table, keyProfile.index, params);
    return r.description ? `${r.description} (${Math.round((r.conforming / Math.max(r.total, 1)) * 100)}% of IDs)` : null;
  }, [table, keyProfile]);

  const toggle = (h: string) => setMeasures((m) => (m.includes(h) ? m.filter((x) => x !== h) : [...m, h]));
  const opt = (h: string) => (
    <option key={h} value={h}>
      {h}
    </option>
  );

  return (
    <section className="card">
      <h2>Confirm how this table works</h2>
      <p className="muted small">Asked once. Saved in this workbook and reused on every check.</p>

      <label>
        ID column <span className="muted">(should be unique)</span>
        <select value={keyColumn ?? ''} onChange={(e) => setKey(e.target.value || null)}>
          <option value="">No ID column</option>
          {table.headers.map(opt)}
        </select>
      </label>
      {suggestion.keyColumn && keyColumn === suggestion.keyColumn && (
        <div className="hint">Suggested: {suggestion.keyReason}</div>
      )}
      {keyFormat && <div className="hint">Format: {keyFormat}</div>}
      {keyProfile && (keyBlank > 0 || keyDupes > 0) && (
        <div className="hint warn">
          Heads-up: {keyColumn} has {keyBlank > 0 && `${keyBlank} missing`}
          {keyBlank > 0 && keyDupes > 0 && ' and '}
          {keyDupes > 0 && `${keyDupes} repeated value${keyDupes > 1 ? 's' : ''}`}. These will be flagged. If blanks are
          expected here (e.g. only some rows have one), it's probably not the table's ID column.
        </div>
      )}

      <label>
        Date column <span className="muted">(used to compare month by month)</span>
        <select value={dateColumn ?? ''} onChange={(e) => setDate(e.target.value || null)}>
          <option value="">No date column</option>
          {table.headers.map(opt)}
        </select>
      </label>

      {!dateColumn && (
        <label>
          Which month is this data?
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <div className="hint">Without a date column, each check is saved as one month's snapshot.</div>
        </label>
      )}

      <fieldset>
        <legend>
          Totals to watch <span className="muted">(amounts, quantities)</span>
        </legend>
        {table.headers
          .filter((h) => h !== keyColumn && h !== dateColumn)
          .map((h) => (
            <label key={h} className="check">
              <input type="checkbox" checked={measures.includes(h)} onChange={() => toggle(h)} /> {h}
            </label>
          ))}
      </fieldset>

      {ignored.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={false} onChange={() => setIgnored([])} /> Show {ignored.length} ignored warning
          {ignored.length > 1 ? 's' : ''} again
        </label>
      )}

      <button
        className="primary"
        onClick={() =>
          onConfirm({
            keyColumn,
            dateColumn,
            measures: measures.filter((m) => m !== keyColumn && m !== dateColumn),
            snapshotPeriod: dateColumn ? undefined : period,
            ignored,
            confirmedAt: new Date().toISOString(),
          })
        }
      >
        Save and check
      </button>
    </section>
  );
}
