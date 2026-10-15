import { currencyFromFormat, formatAmount, inferDecimalSep, parseNumberText } from '../src/core/numbers';

const v = (s: string, dec: ',' | '.' | null = null) => parseNumberText(s, dec)?.value ?? null;

describe('parseNumberText', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['$ 1.234,56', 1234.56],
    ['$1.234.567,8', 1234567.8],
    ['US$ 1,200.00', 1200],
    ['ARS 5.000,00', 5000],
    ['5.000,00 ARS', 5000],
    ['R$ 10,50', 10.5],
    ['€ 99,9', 99.9],
    ['(2.500,00)', -2500],
    ['-$ 100', -100],
    ['$ -100', -100],
    ['100-', -100],
    ['1 234,56', 1234.56],
    ["1'234.56", 1234.56],
    ['12,5', 12.5],
    ['1234.567', 1234.567],
    ['0.125', 0.125],
    ['15%', 0.15],
    ['42', 42],
    ['  3.000,00 ', 3000],
  ])('%s -> %d', (s, expected) => {
    expect(v(s)).toBeCloseTo(expected, 6);
  });

  it.each(['FA-0001-00001234', 'abc', '', '12/09/2026', '1.23.4', '1,2,3', '1.234,56,7', '$', '--'])('rejects %s', (s) => {
    expect(parseNumberText(s)).toBeNull();
  });

  it('flags "1.234" as ambiguous without a hint and resolves it with one', () => {
    expect(parseNumberText('1.234')).toMatchObject({ value: 1234, ambiguous: true });
    expect(parseNumberText('1.234', ',')).toMatchObject({ value: 1234, ambiguous: false });
    expect(parseNumberText('1.234', '.')).toMatchObject({ value: 1.234, ambiguous: false });
    expect(parseNumberText('1,234', ',')).toMatchObject({ value: 1.234, ambiguous: false });
  });

  it('keeps the currency it saw', () => {
    expect(parseNumberText('US$ 10')?.currency).toBe('US$');
    expect(parseNumberText('$ 10')?.currency).toBe('$');
    expect(parseNumberText('10')?.currency).toBeNull();
  });
});

describe('inferDecimalSep', () => {
  it('reads the locale from displayed numbers', () => {
    expect(inferDecimalSep(['$90.449,14', '$1.000,00', '8.900'])).toBe(',');
    expect(inferDecimalSep(['$90,449.14', '1,000.00'])).toBe('.');
    expect(inferDecimalSep(['1.234.567'])).toBe(',');
    expect(inferDecimalSep(['12', 'abc'])).toBeNull();
  });
});

describe('currencyFromFormat', () => {
  it.each([
    ['"$"#,##0.00', '$'],
    ['"US$"#,##0.00', 'USD'],
    ['[$USD] #,##0.00', 'USD'],
    ['[$ARS] #,##0', 'ARS'],
    ['[$€-2] #,##0.00', 'EUR'],
    ['$#,##0', '$'],
    ['[$-409]dd/mm/yyyy', null],
    ['#,##0.00', null],
    ['General', null],
  ])('%s -> %s', (fmt, cur) => expect(currencyFromFormat(fmt)).toBe(cur));
});

describe('formatAmount', () => {
  it('uses the column separators', () => {
    expect(formatAmount(48200.5, ',', '$')).toBe('$ 48.200,50');
    expect(formatAmount(48200.5, '.')).toBe('48,200.50');
    expect(formatAmount(-1000, ',')).toBe('-1.000');
  });
});
