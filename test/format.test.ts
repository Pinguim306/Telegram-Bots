import { describe, expect, it } from 'vitest';
import {
  age,
  emojiBlock,
  fromUnits,
  pct,
  price,
  sanitizeTokenText,
  shortAddr,
  usd,
} from '../src/core/format.js';

describe('usd', () => {
  it('abrevia por ordem de grandeza', () => {
    expect(usd(67_300)).toBe('$67.3K');
    expect(usd(2_090)).toBe('$2.09K');
    expect(usd(20_900)).toBe('$20.9K');
    expect(usd(1_234_567)).toBe('$1.23M');
    expect(usd(4_000_000_000)).toBe('$4B');
  });

  it('mantém centavos abaixo de mil', () => {
    expect(usd(12.5)).toBe('$12.50');
    expect(usd(1)).toBe('$1.00');
  });

  it('preserva o sinal de valores negativos (fluxo líquido de saída)', () => {
    expect(usd(-1500)).toBe('-$1.5K');
  });

  it('não quebra com entrada inválida', () => {
    expect(usd(Number.NaN)).toBe('$?');
    expect(usd(Number.POSITIVE_INFINITY)).toBe('$?');
  });
});

describe('price', () => {
  it('mantém algarismos significativos em preços minúsculos', () => {
    // O caso que motiva a função: toFixed(2) transformaria isso em "0.00".
    expect(price(0.000_000_637)).toBe('0.000000637');
    expect(price(0.000_002_093)).toBe('0.000002093');
  });

  it('não devolve notação científica', () => {
    expect(price(1e-15)).not.toContain('e');
  });

  it('trata zero e negativo', () => {
    expect(price(0)).toBe('0');
    expect(price(-1)).toBe('0');
  });
});

describe('pct', () => {
  it('inclui o sinal', () => {
    expect(pct(104.2)).toBe('+104%');
    expect(pct(-30)).toBe('-30%');
  });

  it('usa uma casa decimal em variações pequenas', () => {
    expect(pct(2.35)).toBe('+2.4%');
  });
});

describe('age', () => {
  it('formata segundos, minutos, horas e dias', () => {
    expect(age(53)).toBe('53s');
    expect(age(600)).toBe('10m');
    expect(age(3_700)).toBe('1h 1m');
    expect(age(90_000)).toBe('1d 1h');
  });
});

describe('sanitizeTokenText', () => {
  it('escapa HTML — nome de token é entrada hostil', () => {
    expect(sanitizeTokenText('<b>SAFE</b>')).toBe('&lt;b&gt;SAFE&lt;/b&gt;');
  });

  it('remove marcas bidirecionais usadas para deformar a mensagem', () => {
    expect(sanitizeTokenText('AB‮CD')).toBe('ABCD');
  });

  it('corta nomes absurdamente longos', () => {
    expect(sanitizeTokenText('A'.repeat(200), 10)).toBe(`${'A'.repeat(10)}…`);
  });

  it('devolve um marcador quando sobra string vazia', () => {
    expect(sanitizeTokenText('​​')).toBe('???');
  });
});

describe('fromUnits', () => {
  it('converte com os decimals do token', () => {
    expect(fromUnits(1_000_000n, 6)).toBe(1);
    expect(fromUnits(10n ** 18n, 18)).toBe(1);
    // USDC na Arc tem 6 decimals, não 18 — errar isso desloca o preço em 10^12.
    expect(fromUnits(26_735_347_286n, 6)).toBeCloseTo(26_735.347_286, 6);
  });

  it('suporta token com 0 decimals', () => {
    expect(fromUnits(42n, 0)).toBe(42);
  });

  it('mantém o sinal', () => {
    expect(fromUnits(-5_000_000n, 6)).toBe(-5);
  });
});

describe('emojiBlock', () => {
  it('quebra em linhas e respeita o teto', () => {
    const block = emojiBlock(45, '🟩', 20, 60);
    expect(block.split('\n')).toHaveLength(3);
    expect([...block.replaceAll('\n', '')]).toHaveLength(45);
  });

  it('limita o total para não estourar o tamanho da mensagem', () => {
    const block = emojiBlock(5_000, '🟩', 20, 60);
    expect([...block.replaceAll('\n', '')]).toHaveLength(60);
  });
});

describe('shortAddr', () => {
  it('encurta preservando início e fim', () => {
    expect(shortAddr('0x3600000000000000000000000000000000000000')).toBe('0x3600..0000');
  });
});
