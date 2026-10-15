import type { DuplicateGroup, Finding, TableData } from '../types';
import { column, isEmpty, normaliseKey } from '../columns';
import { placeholderOf, summarisePlaceholders } from '../missing';

const cellKey = (v: unknown) => (v === null || v === '' ? '' : typeof v === 'number' ? `n:${v}` : `s:${String(v).trim().toLowerCase()}`);

export function checkDuplicates(table: TableData, keyCol: number): Finding[] {
  const header = table.headers[keyCol];
  const cells = column(table, keyCol);
  const byKey = new Map<string, number[]>();
  const blanks: number[] = [];
  const placeholders: { row: number; raw: string }[] = [];

  cells.forEach((c, row) => {
    if (isEmpty(c)) {
      if (!table.rows[row].every(isEmpty)) blanks.push(row); // fully empty rows are just padding
      return;
    }
    // "N/A" or "NULL" in an ID column is a missing ID, not an ID that repeats 50 times.
    if (placeholderOf(c)) {
      placeholders.push({ row, raw: String(c.v) });
      return;
    }
    const k = normaliseKey(c.v);
    const list = byKey.get(k);
    if (list) list.push(row);
    else byKey.set(k, [row]);
  });

  const findings: Finding[] = [];
  const groups: DuplicateGroup[] = [];
  for (const [key, rows] of byKey) {
    if (rows.length < 2) continue;
    const raws = new Set(rows.map((r) => String(cells[r].v)));
    // Exact copy (every other column the same) = counted twice; otherwise the rows disagree and someone must choose.
    const differs = table.headers.filter((_h, c) => {
      if (c === keyCol) return false;
      const vals = new Set(rows.map((r) => cellKey(table.rows[r][c]?.v ?? null)));
      return vals.size > 1;
    });
    groups.push({
      key,
      rows,
      hiddenVariant: raws.size > 1,
      note: differs.length ? `differs in ${differs.slice(0, 3).join(', ')}${differs.length > 3 ? ` +${differs.length - 3}` : ''}` : 'exact copy',
    });
  }
  groups.sort((a, b) => b.rows.length - a.rows.length || a.rows[0] - b.rows[0]);

  if (groups.length) {
    const dupRows = groups.reduce((n, g) => n + g.rows.length, 0);
    const hidden = groups.filter((g) => g.hiddenVariant).length;
    const exact = groups.filter((g) => g.note === 'exact copy').length;
    findings.push({
      id: `duplicates:${header}`,
      check: 'duplicates',
      severity: 'high',
      column: header,
      title: `${groups.length} ${header} value${groups.length > 1 ? 's' : ''} appear more than once`,
      detail:
        `${dupRows} rows share an ID.` +
        (exact ? ` ${exact} ${exact === 1 ? 'is an exact copy' : 'are exact copies'} (counted twice in totals; safe to delete one).` : '') +
        (groups.length - exact
          ? ` ${groups.length - exact} ${groups.length - exact === 1 ? 'has' : 'have'} different values in other columns (pick the right row; see "Show list").`
          : '') +
        (hidden
          ? ` ${hidden} of these only differ by spaces or capital letters, so they don't look the same at a glance.`
          : ''),
      cells: groups.flatMap((g) => g.rows.map((row) => ({ row, col: keyCol }))),
      groups,
    });
  }

  const missing = blanks.length + placeholders.length;
  if (missing) {
    const parts = [
      ...(blanks.length ? [`${blanks.length} blank`] : []),
      ...summarisePlaceholders(placeholders).map((p) => `${p.count} "${p.label}"`),
    ];
    findings.push({
      id: `blankKeys:${header}`,
      check: 'blankKeys',
      severity: 'medium',
      column: header,
      title: `${missing} row${missing > 1 ? 's have' : ' has'} no ${header}`,
      detail:
        `Missing: ${parts.join(', ')}. Rows without an ID cannot be matched or de-duplicated.` +
        (placeholders.length ? ' Placeholders like "N/A" also look like a repeated ID to Excel formulas.' : ''),
      cells: [...blanks, ...placeholders.map((p) => p.row)].sort((a, b) => a - b).map((row) => ({ row, col: keyCol })),
      fix: placeholders.length
        ? {
            kind: 'setValues',
            label: `Clear ${placeholders.length} placeholder${placeholders.length > 1 ? 's' : ''}`,
            values: placeholders.map((p) => ({ row: p.row, col: keyCol, value: null })),
          }
        : undefined,
    });
  }
  return findings;
}
