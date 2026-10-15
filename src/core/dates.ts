// Dates in Excel arrive two ways: a serial number with a date format, or text typed/pasted as "15/09/2026".
import type { Cell } from './types';

export type DateOrder = 'dmy' | 'mdy';

/** True when an Excel number format shows a date. Ignores quoted literals and [..] sections. */
export function isDateFormat(fmt: string): boolean {
  if (!fmt || fmt === 'General' || fmt === '@') return false;
  const clean = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(clean) || /m{3,}/i.test(clean) || /(^|[^h:])m{1,2}[/\-.\s]/i.test(clean);
}

export function serialToDate(serial: number): Date {
  // Excel serial 25569 = 1970-01-01. Fine for anything after March 1900.
  return new Date(Math.round((serial - 25569) * 86400000));
}

const DMY = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[ T].*)?$/;
const YMD = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ T].*)?$/;

function build(y: number, m: number, d: number): Date | null {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null; // "0000-00-00" is not a date
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt : null;
}

// Month names, English + Spanish + Portuguese (first 3 letters are enough).
const MONTHS: Record<string, number> = {
  jan: 1, ene: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8,
  sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dic: 12, dez: 12,
};
const MON_D_Y = /^([A-Za-zÀ-ÿ]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/; // May 06, 2026
const D_MON_Y = /^(\d{1,2})[\s\-/.]+(?:de\s+)?([A-Za-zÀ-ÿ]{3,})\.?[\s\-/.]+(?:de\s+)?(\d{2}|\d{4})$/; // 06 May 2026, 6-may-26, 6 de mayo de 2026

const monthNum = (name: string) => MONTHS[name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 3).toLowerCase()];

export function parseDateText(s: string, order: DateOrder = 'dmy'): Date | null {
  const t = s.trim();
  let n = t.match(MON_D_Y);
  if (n && monthNum(n[1])) return build(+n[3], monthNum(n[1]), +n[2]);
  n = t.match(D_MON_Y);
  if (n && monthNum(n[2])) return build(+n[3], monthNum(n[2]), +n[1]);
  let m = t.match(YMD);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = t.match(DMY);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    return order === 'dmy' ? build(+m[3], b, a) : build(+m[3], a, b);
  }
  return null;
}

/** Day/month order for a text date column. Defaults to day-first (AR/ES/PT). */
export function inferDateOrder(texts: string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const s of texts) {
    const m = s.trim().match(DMY);
    if (!m) continue;
    if (+m[1] > 12) dmy++;
    else if (+m[2] > 12) mdy++;
  }
  return mdy > dmy ? 'mdy' : 'dmy';
}

export function cellToDate(c: Cell, order: DateOrder): Date | null {
  if (typeof c.v === 'number') {
    if (!isDateFormat(c.f)) return null;
    return serialToDate(c.v);
  }
  if (typeof c.v === 'string') return parseDateText(c.v, order);
  return null;
}

export function periodKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Share of non-empty cells in a column that read as dates. */
export function dateShare(cells: Cell[], order: DateOrder): number {
  let nonEmpty = 0;
  let dates = 0;
  for (const c of cells) {
    if (c.v === null || c.v === '') continue;
    nonEmpty++;
    if (cellToDate(c, order)) dates++;
  }
  return nonEmpty ? dates / nonEmpty : 0;
}
