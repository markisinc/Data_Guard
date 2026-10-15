// Garbled accents: "MarÃ­a GÃ³mez" is "María Gómez" saved as UTF-8 and opened as Latin-1 (common with CSV exports).
// The repair is exact: re-read the characters as the bytes they came from.
import type { Finding, TableData } from '../types';
import { column } from '../columns';

const MOJIBAKE = /Ã[\u0080-¿¡-ÿ]|Â[ -¿]|â€[\u0080-¿™œ"]/;

/** "MarÃ­a" -> "María". Returns null if the text isn't garbled this way. */
export function repairMojibake(s: string): string | null {
  if (!MOJIBAKE.test(s)) return null;
  // Map each char back to its byte (Latin-1 / Windows-1252), then decode the bytes as UTF-8.
  const cp1252: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
  const bytes: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 256) bytes.push(code);
    else if (ch in cp1252) bytes.push(cp1252[ch]);
    else return null;
  }
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return out !== s ? out : null;
  } catch {
    return null;
  }
}

export function checkEncoding(table: TableData, col: number): Finding[] {
  const header = table.headers[col];
  const fixes: { row: number; from: string; to: string }[] = [];
  column(table, col).forEach((c, row) => {
    if (typeof c.v !== 'string') return;
    const to = repairMojibake(c.v);
    if (to) fixes.push({ row, from: c.v, to });
  });
  if (!fixes.length) return [];
  const ex = fixes[0];
  return [
    {
      id: `encoding:${header}`,
      check: 'encoding',
      severity: 'medium',
      column: header,
      title: `${fixes.length} ${header} value${fixes.length > 1 ? 's have' : ' has'} garbled accents`,
      detail: `e.g. "${ex.from}" should read "${ex.to}". This happens when a UTF-8 file (a CSV export) is opened with the wrong encoding. The repair is exact, and it also stops "María" and "MarÃ­a" counting as two different values.`,
      cells: fixes.map((f) => ({ row: f.row, col })),
      fix: {
        kind: 'setValues',
        label: `Repair ${fixes.length}`,
        values: fixes.map((f) => ({ row: f.row, col, value: f.to })),
      },
    },
  ];
}
