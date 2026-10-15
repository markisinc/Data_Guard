// "N/A", "NULL", "-", "TBD", #N/A... typed into cells instead of leaving them blank.
// Excel treats them as real values: COUNTA counts them, pivot tables show an "N/A" group, lookups match them.
import type { Finding, TableData } from '../types';
import { column } from '../columns';
import { placeholderOf, summarisePlaceholders } from '../missing';

export function checkPlaceholders(table: TableData, col: number): Finding[] {
  const header = table.headers[col];
  const hits: { row: number; raw: string }[] = [];
  column(table, col).forEach((c, row) => {
    if (placeholderOf(c)) hits.push({ row, raw: String(c.v) });
  });
  if (!hits.length) return [];

  const summary = summarisePlaceholders(hits);
  const errors = summary.filter((s) => s.label.startsWith('#')).reduce((n, s) => n + s.count, 0);
  const parts = summary.slice(0, 5).map((s) => `"${s.label}" ×${s.count}`);
  const groups = summary.map((s) => ({
    key: s.label,
    rows: hits.filter((h) => h.raw.trim().toLowerCase() === s.label.toLowerCase()).map((h) => h.row),
    note: s.label.startsWith('#') ? 'Excel error value' : undefined,
  }));

  return [
    {
      id: `placeholders:${header}`,
      check: 'placeholders',
      severity: 'medium',
      column: header,
      title: `${hits.length} ${header} value${hits.length > 1 ? 's are' : ' is'} placeholders for missing data`,
      detail:
        `${parts.join(', ')}${summary.length > 5 ? `, and ${summary.length - 5} more` : ''}. ` +
        'Excel counts these as real values, so COUNTA, pivot tables and lookups treat "N/A" as data.' +
        (errors ? ` ${errors} are Excel errors (e.g. #N/A from a failed lookup); clearing them hides the cause, so check the source first.` : ''),
      cells: hits.map((h) => ({ row: h.row, col })),
      groups,
      fix: {
        kind: 'setValues',
        label: `Clear ${hits.length} placeholder${hits.length > 1 ? 's' : ''}`,
        values: hits.map((h) => ({ row: h.row, col, value: null })),
      },
    },
  ];
}
