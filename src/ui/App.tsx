import { useState } from 'react';
import type { ConvertFix, Finding, Rules, TableData, WorkbookState } from '../core/types';
import { suggestSetup, type SetupSuggestion } from '../core/columns';
import { findTableState, upsertTableState } from '../core/history';
import { runChecks, type RunResult } from '../core/run';
import { applyFix, undoLastFix, setChangeLogVisible, clearState, loadState, readActiveTable, saveState, selectCells, toAreas } from '../excel/workbook';
import { Setup } from './Setup';
import { FindingCard } from './FindingCard';
import { ColumnView } from './ColumnView';
import { FixOrderView } from './FixOrderView';
import { Trend } from './Trend';

type View =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'setup'; table: TableData; state: WorkbookState; suggestion: SetupSuggestion; rules: Rules | null }
  | { kind: 'results'; table: TableData; rules: Rules; result: RunResult };

const currentMonth = () => new Date().toISOString().slice(0, 7);

export function App() {
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Undo is available whenever the workbook has a log; we show it after any fix in this session.
  const [canUndo, setCanUndo] = useState(false);
  type Layout = 'column' | 'order' | 'severity';
  const [layout, setLayoutState] = useState<Layout>(() => {
    try {
      const l = localStorage.getItem('dg.layout');
      return l === 'severity' || l === 'order' ? l : 'column';
    } catch {
      return 'column';
    }
  });
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem('dg.layout', l);
    } catch {
      /* storage unavailable: just don't remember */
    }
  };

  const guard = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setNote(null);
    const prev = view;
    setView({ kind: 'busy', label });
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setView(prev.kind === 'busy' ? { kind: 'idle' } : prev);
    }
  };

  const run = async (table: TableData, rules: Rules, state: WorkbookState) => {
    const result = runChecks(table, rules, state);
    await saveState(result.state);
    setView({ kind: 'results', table, rules, result });
  };

  const start = () =>
    guard('Reading table…', async () => {
      const [table, state] = await Promise.all([readActiveTable(), loadState()]);
      const saved = findTableState(state, table);
      const suggestion = suggestSetup(table);
      // Rules confirmed earlier and still matching the columns: run straight away.
      if (saved && rulesFit(saved.rules, table)) return run(table, saved.rules, state);
      setView({ kind: 'setup', table, state, suggestion, rules: saved?.rules ?? null });
    });

  const confirm = (table: TableData, state: WorkbookState, rules: Rules) =>
    guard('Checking…', async () => {
      // Save rules first so they're remembered even if the run fails.
      await saveState(upsertTableState(state, table, rules, [], 36).state);
      await run(table, rules, await loadState());
    });

  const rerun = () =>
    guard('Checking again…', async () => {
      const [table, state] = await Promise.all([readActiveTable(), loadState()]);
      const saved = findTableState(state, table);
      if (!saved) return start();
      await run(table, saved.rules, state);
    });

  const select = async (table: TableData, f: Finding) => {
    try {
      const r = await selectCells(table, f.cells);
      if (r.truncated) setNote('Excel selected the first cell. Use the list below to go to the others.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const recheck = async () => {
    const [fresh, state] = await Promise.all([readActiveTable(), loadState()]);
    const saved = findTableState(state, fresh);
    await run(fresh, saved?.rules ?? (view.kind === 'results' ? view.rules : defaultRules(suggestSetup(fresh))), state);
  };

  const convert = (table: TableData, f: Finding, fix: ConvertFix) =>
    guard('Applying…', async () => {
      const { written, skipped } = await applyFix(table, fix, f.title);
      await recheck();
      setNote(
        `Updated ${written} cell${written === 1 ? '' : 's'}; old values saved in the change log.` +
          (skipped ? ` Skipped ${skipped} that changed since the check or hold formulas.` : ''),
      );
      setCanUndo(written > 0);
    });

  const [logShown, setLogShown] = useState(false);
  const toggleLog = () => {
    const back = view;
    return guard(logShown ? 'Hiding change log…' : 'Opening change log…', async () => {
      const ok = await setChangeLogVisible(!logShown);
      setView(back);
      if (!ok) {
        setNote('No changes yet: the log is created with the first fix.');
        return;
      }
      setLogShown(!logShown);
    });
  };

  const undo = () =>
    guard('Undoing…', async () => {
      const r = await undoLastFix();
      if (!r) {
        setNote('Nothing to undo.');
        setCanUndo(false);
        return;
      }
      await recheck();
      setNote(
        `Undid "${r.fix.split(' — ')[0]}": restored ${r.restored} cell${r.restored === 1 ? '' : 's'}.` +
          (r.skipped ? ` Kept ${r.skipped} that were edited after the fix.` : ''),
      );
    });

  const ignore = (f: Finding) =>
    guard('Saving…', async () => {
      if (view.kind !== 'results') return;
      const rules = { ...view.rules, ignored: [...view.rules.ignored, f.id] };
      const state = await loadState();
      await run(view.table, rules, state);
    });

  const reset = () =>
    guard('Clearing…', async () => {
      await clearState();
      setView({ kind: 'idle' });
      setNote('DataGuard history and rules were removed from this workbook.');
    });

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">◆</span> DataGuard
        </div>
        {view.kind === 'results' ? (
          <div className="row">
            <button className="secondary" onClick={() => setView({ kind: 'setup', table: view.table, state: view.result.state, suggestion: suggestSetup(view.table), rules: view.rules })}>
              Edit rules
            </button>
            <button onClick={rerun}>Check again</button>
            <button className="link small" onClick={undo} title="Undo the most recent DataGuard fix in this workbook">
              Undo last fix
            </button>
          </div>
        ) : (
          <button onClick={start} disabled={view.kind === 'busy'}>
            Check this table
          </button>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}
      {note && (
        <div className="banner row between">
          <span>{note}</span>
          {canUndo && view.kind === 'results' && (
            <button className="link" onClick={undo}>
              Undo
            </button>
          )}
        </div>
      )}

      {view.kind === 'idle' && (
        <section className="empty">
          <p>Click any cell in your table, then <b>Check this table</b>.</p>
          <p className="muted">
            DataGuard looks for duplicate IDs, amounts stored as text that SUM skips, mixed currencies, and months whose
            totals are off-trend.
          </p>
        </section>
      )}

      {view.kind === 'busy' && <section className="empty muted">{view.label}</section>}

      {view.kind === 'setup' && (
        <Setup
          table={view.table}
          suggestion={view.suggestion}
          initial={view.rules ?? defaultRules(view.suggestion)}
          onConfirm={(rules) => confirm(view.table, view.state, rules)}
        />
      )}

      {view.kind === 'results' && (
        <>
          <Summary result={view.result} table={view.table} />
          <div className="row tabs" role="tablist">
            <button role="tab" aria-selected={layout === 'column'} className={layout === 'column' ? 'tab on' : 'tab'} onClick={() => setLayout('column')}>
              By column
            </button>
            <button role="tab" aria-selected={layout === 'order'} className={layout === 'order' ? 'tab on' : 'tab'} onClick={() => setLayout('order')}>
              Fix order
            </button>
            <button role="tab" aria-selected={layout === 'severity'} className={layout === 'severity' ? 'tab on' : 'tab'} onClick={() => setLayout('severity')}>
              By severity
            </button>
          </div>
          {layout === 'order' ? (
            <FixOrderView
              findings={view.result.findings}
              table={view.table}
              onSelect={(f, cells) => select(view.table, { ...f, cells })}
              onConvert={(f, fix) => convert(view.table, f, fix)}
              onIgnore={(f) => ignore(f)}
            />
          ) : layout === 'column' ? (
            <ColumnView
              key={view.result.findings.map((f) => f.id).join('|')}
              findings={view.result.findings}
              table={view.table}
              onSelect={(f, cells) => select(view.table, { ...f, cells })}
              onConvert={(f, fix) => convert(view.table, f, fix)}
              onIgnore={(f) => ignore(f)}
            />
          ) : (
            view.result.findings.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                table={view.table}
                onSelect={(cells) => select(view.table, { ...f, cells })}
                onConvert={(fix) => convert(view.table, f, fix)}
                onIgnore={() => ignore(f)}
                areaCount={toAreas(view.table, f.cells).areas.length}
              />
            ))
          )}
          <Trend result={view.result} rules={view.rules} />
          <footer>
            <p className="muted">
              Every fix is recorded in a hidden "DataGuard Changes" sheet (old and new value per cell). Rules and a monthly
              summary (row count and totals per month) are saved <b>inside this workbook</b>, so they
              travel with copies of the file. Nothing is sent anywhere. Anyone you share the file with can see those
              totals too.
            </p>
            <div className="row wrap">
              <button className="link" onClick={toggleLog}>
                {logShown ? 'Hide change log' : 'View change log'}
              </button>
              <button className="link" onClick={reset}>
                Remove DataGuard data from this workbook
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

function Summary({ result, table }: { result: RunResult; table: TableData }) {
  const count = (s: string) => result.findings.filter((f) => f.severity === s).length;
  const high = count('high');
  const medium = count('medium');
  return (
    <section className="summary">
      <div className="muted small">
        {table.tableName ?? table.address} · {table.rows.length} rows
      </div>
      {high + medium === 0 ? (
        <div className="ok">No problems found.</div>
      ) : (
        <div>
          {high > 0 && <span className="pill high">{high} high</span>} {medium > 0 && <span className="pill medium">{medium} medium</span>}
        </div>
      )}
      {result.ignoredCount > 0 && <div className="muted small">{result.ignoredCount} ignored (Edit rules to restore)</div>}
    </section>
  );
}

function defaultRules(s: SetupSuggestion): Rules {
  return {
    keyColumn: s.keyColumn,
    dateColumn: s.dateColumn,
    measures: s.measures,
    snapshotPeriod: s.dateColumn ? undefined : currentMonth(),
    ignored: [],
    confirmedAt: new Date().toISOString(),
  };
}

function rulesFit(r: Rules, t: TableData): boolean {
  const has = (h: string | null) => h === null || t.headers.includes(h);
  // Without a date column the user must confirm which period this snapshot is, every run.
  return has(r.keyColumn) && has(r.dateColumn) && r.measures.every((m) => t.headers.includes(m)) && r.dateColumn !== null;
}
