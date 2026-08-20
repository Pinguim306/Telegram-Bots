import { describe, expect, it } from 'vitest';
import { ageMin, cleanLabel, pct, price, sol, table, usd } from '../src/format.js';

describe('format', () => {
  it('usd abrevia', () => {
    expect(usd(1234)).toBe('$1.23K');
    expect(usd(67_300)).toBe('$67.3K');
    expect(usd(2_500_000)).toBe('$2.5M');
    expect(usd(NaN)).toBe('$?');
  });

  it('price mantém algarismos significativos em preço minúsculo', () => {
    expect(price(0.0000006)).toBe('0.0000006');
    expect(price(0)).toBe('0');
  });

  it('pct com sinal', () => {
    expect(pct(104.2)).toBe('+104%');
    expect(pct(-3.4)).toBe('-3.4%');
  });

  it('sol com precisão útil', () => {
    expect(sol(0.05)).toBe('0.0500');
    expect(sol(12.3456789)).toBe('12.346');
  });

  it('ageMin legível e null vira ?', () => {
    expect(ageMin(53)).toBe('53m');
    expect(ageMin(90)).toBe('1h 30m');
    expect(ageMin(null)).toBe('?');
  });

  it('cleanLabel remove controle/ANSI/bidi e limita tamanho', () => {
    expect(cleanLabel('BONK')).toBe('BONK');
    expect(cleanLabel('OK\u001b[8A\u001b[0Jfim')).toBe('OK[8A[0Jfim');
    expect(cleanLabel('a\u202eb\u200bc')).toBe('abc');
    expect(cleanLabel('x'.repeat(100), 12)).toHaveLength(12);
    expect(cleanLabel('\u0000\u0007')).toBe('?');
    expect(cleanLabel('  espaços  ')).toBe('espaços');
  });

  it('table alinha colunas', () => {
    const out = table(
      [
        ['TKA', '+10%'],
        ['LONGTOKEN', '-3%'],
      ],
      ['Token', 'PnL'],
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('TKA');
    expect(lines[2]!.indexOf('+10%')).toBe(lines[3]!.indexOf('-3%'));
  });
});
