// Parsing amounts typed or pasted as text: "1.234,56", "1,234.56", "$ 1.234", "US$ 1,200.00", "ARS 5.000", "(1.234,00)".
// This is the part users will either trust or ignore, so every rule here has a test in tests/numbers.test.ts.

export type DecimalSep = ',' | '.';

export interface ParsedNumber {
  value: number;
  currency: string | null;
  /** True when "1.234" could be 1234 or 1.234 and we had no column-level hint. */
  ambiguous: boolean;
}

// Longest first so "US$" wins over "$".
const CURRENCY_TOKENS = [
  'US$', 'U$S', 'U$D', 'USD', 'AR$', 'ARS', 'R$', 'BRL', 'EUR', 'MXN', 'CLP', 'COP', 'PEN', 'UYU', 'GBP',
  '$', '€', '£',
];

/** Normalise currency spellings so "US$" and "USD" count as one currency. */
export function normaliseCurrency(c: string | null): string | null {
  if (!c) return null;
  const u = c.toUpperCase();
  if (['US$', 'U$S', 'U$D', 'USD'].includes(u)) return 'USD';
  if (['AR$', 'ARS'].includes(u)) return 'ARS';
  if (['R$', 'BRL'].includes(u)) return 'BRL';
  if (['€', 'EUR'].includes(u)) return 'EUR';
  if (['£', 'GBP'].includes(u)) return 'GBP';
  return u; // "$" stays "$": it could be ARS, USD, MXN... we don't guess.
}

function stripCurrency(s: string): { rest: string; currency: string | null } {
  const upper = s.toUpperCase();
  for (const tok of CURRENCY_TOKENS) {
    if (upper.startsWith(tok)) return { rest: s.slice(tok.length).trim(), currency: tok };
    if (upper.endsWith(tok)) return { rest: s.slice(0, s.length - tok.length).trim(), currency: tok };
  }
  return { rest: s, currency: null };
}

interface Prepared {
  body: string;
  negative: boolean;
  percent: boolean;
  currency: string | null;
}

/** Strip sign, brackets, currency, percent and spacing. Returns null if what's left isn't digits and separators. */
function prepare(raw: string): Prepared | null {
  let s = raw.replace(/[   ]/g, ' ').trim();
  if (!s) return null;
  let negative = false;
  let percent = false;

  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Sign can sit before or after the currency: "-$ 100", "$ -100", "100-".
  const takeSign = () => {
    if (s.startsWith('-') || s.startsWith('−')) {
      negative = !negative;
      s = s.slice(1).trim();
    } else if (s.startsWith('+')) {
      s = s.slice(1).trim();
    }
  };
  takeSign();
  const cur = stripCurrency(s);
  s = cur.rest;
  takeSign();
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  // Spaces and apostrophes as thousands separators: "1 234,56", "1'234.56".
  if (/^\d{1,3}([ '’]\d{3})+([.,]\d+)?$/.test(s)) s = s.replace(/[ '’]/g, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  return { body: s, negative, percent, currency: cur.currency };
}

const THOUSANDS_OK = (intPart: string, sep: string) => {
  const groups = intPart.split(sep);
  if (groups.length < 2) return true;
  if (!/^\d{1,3}$/.test(groups[0]) || groups[0] === '0') return false;
  return groups.slice(1).every((g) => /^\d{3}$/.test(g));
};

/**
 * Parse one text value. `dec` is the column's decimal separator if known (see inferDecimalSep).
 * Returns null when the text is not a number (words, IDs with letters, dates...).
 */
export function parseNumberText(raw: string, dec: DecimalSep | null = null): ParsedNumber | null {
  const p = prepare(raw);
  if (!p) return null;
  const s = p.body;
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let value: number;
  let ambiguous = false;

  if (dots === 0 && commas === 0) {
    value = Number(s);
  } else if (dots > 0 && commas > 0) {
    // Both present: the last one is the decimal separator.
    const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const [intPart, fracPart, extra] = s.split(decSep);
    if (extra !== undefined || fracPart === undefined || !/^\d+$/.test(fracPart)) return null;
    if (!THOUSANDS_OK(intPart, thouSep)) return null;
    value = Number(intPart.split(thouSep).join('') + '.' + fracPart);
  } else {
    const sep = dots > 0 ? '.' : ',';
    const count = dots + commas;
    if (count > 1) {
      // "1.234.567" — must be thousands.
      if (!THOUSANDS_OK(s, sep)) return null;
      value = Number(s.split(sep).join(''));
    } else {
      const [intPart, fracPart] = s.split(sep);
      const looksLikeThousands = fracPart.length === 3 && /^\d{1,3}$/.test(intPart) && intPart !== '0';
      let isDecimal: boolean;
      if (!looksLikeThousands) isDecimal = true;
      else if (dec) isDecimal = sep === dec;
      else {
        // "1.234" with no hint. Default to thousands (es/pt locales), but say so.
        isDecimal = false;
        ambiguous = true;
      }
      value = isDecimal ? Number((intPart || '0') + '.' + fracPart) : Number(intPart + fracPart);
    }
  }
  if (!Number.isFinite(value)) return null;
  if (p.percent) value = value / 100;
  if (p.negative) value = -value;
  return { value, currency: p.currency, ambiguous };
}

/**
 * Work out a column's decimal separator from all its displayed texts.
 * Real numeric cells count too: Excel displays them in the user's locale, which is the best hint we have.
 */
export function inferDecimalSep(texts: string[]): DecimalSep | null {
  let comma = 0;
  let dot = 0;
  for (const raw of texts) {
    const p = prepare(raw);
    if (!p) continue;
    const s = p.body;
    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    if (dots && commas) {
      if (s.lastIndexOf('.') > s.lastIndexOf(',')) dot++;
      else comma++;
    } else if (dots + commas === 1) {
      const sep = dots ? '.' : ',';
      const frac = s.split(sep)[1];
      if (frac.length !== 3) sep === '.' ? dot++ : comma++;
    } else if (dots > 1) comma++;
    else if (commas > 1) dot++;
  }
  if (comma === 0 && dot === 0) return null;
  return comma >= dot ? ',' : '.';
}

/** Pull a currency out of an Excel number format: `"US$"#,##0.00`, `[$ARS] #,##0`, `$#,##0`. */
export function currencyFromFormat(fmt: string): string | null {
  if (!fmt || fmt === 'General') return null;
  const bracket = fmt.match(/\[\$([^\]-]+)(?:-[0-9A-Fa-f]+)?\]/);
  if (bracket && bracket[1].trim()) return normaliseCurrency(bracket[1].trim());
  const quoted = fmt.match(/"([^"]+)"/);
  if (quoted) {
    const q = quoted[1].trim().toUpperCase();
    const hit = CURRENCY_TOKENS.find((t) => q === t || q.startsWith(t));
    if (hit) return normaliseCurrency(hit);
  }
  const bare = fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').match(/(US\$|R\$|\$|€|£)/);
  return bare ? normaliseCurrency(bare[1]) : null;
}

/** Format an amount for display using the column's separators. */
export function formatAmount(n: number, dec: DecimalSep | null, currency: string | null = null): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const fixed = abs.toFixed(Number.isInteger(abs) ? 0 : 2);
  const [i, f] = fixed.split('.');
  const thou = dec === ',' ? '.' : ',';
  const decSep = dec === ',' ? ',' : '.';
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
  const body = f ? `${grouped}${decSep}${f}` : grouped;
  const cur = currency ? `${currency} ` : '';
  return `${neg ? '-' : ''}${cur}${body}`;
}

// --- Numbers written as words or with a unit: "two", "cinco", "dos", "10 units", "3 uds." ---
const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, hundred: 100, dozen: 12,
  cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100, docena: 12,
  um: 1, uma: 1, dois: 2, duas: 2, quatro: 4, sete: 7, oito: 8, nove: 9, dez: 10, vinte: 20,
};
const UNIT = /^(-?\d+(?:[.,]\d+)?)\s*(?:units?|unit\.|pcs?\.?|pieces?|items?|uds?\.?|u\.?|unidades?|unid\.?|x)$/i;

/** "two" -> 2, "Cinco" -> 5, "10 units" -> 10. Null when it isn't a number in words. */
export function parseNumberWords(raw: string): number | null {
  const t = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  if (t in WORDS) return WORDS[t];
  const m = t.match(UNIT);
  return m ? Number(m[1].replace(',', '.')) : null;
}
