import { describe, expect, it } from 'vitest';
import { quoteTokenSchema, type QuoteToken } from '../src/config/schema.js';
import { chooseQuote } from '../src/core/pools.js';

const USDC = quoteTokenSchema.parse({
  address: '0x3600000000000000000000000000000000000000',
  symbol: 'USDC',
  decimals: 6,
  usdPrice: 1,
  isStable: true,
  preference: 100,
});

const WETH = quoteTokenSchema.parse({
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
  isStable: false,
  preference: 50,
});

const MEME = '0x00000000000000000000000000000000000000aa' as const;
const OUTRO = '0x00000000000000000000000000000000000000bb' as const;

const quotes: QuoteToken[] = [USDC, WETH];

describe('chooseQuote', () => {
  it('escolhe o quote conhecido e trata o outro lado como token negociado', () => {
    expect(chooseQuote(MEME, USDC.address, quotes)).toEqual({ base: MEME, quote: USDC });
    expect(chooseQuote(USDC.address, MEME, quotes)).toEqual({ base: MEME, quote: USDC });
  });

  it('em par quote/quote, o de maior preferência precifica o outro', () => {
    // USDC (100) precifica WETH (50), não o contrário.
    expect(chooseQuote(WETH.address, USDC.address, quotes)).toEqual({
      base: WETH.address,
      quote: USDC,
    });
    expect(chooseQuote(USDC.address, WETH.address, quotes)).toEqual({
      base: WETH.address,
      quote: USDC,
    });
  });

  it('devolve null quando nenhum lado é quote conhecido', () => {
    // Sem quote não há preço em USD — e alerta com preço errado é pior que nenhum.
    expect(chooseQuote(MEME, OUTRO, quotes)).toBeNull();
  });

  it('devolve null quando não há nenhum quote configurado', () => {
    expect(chooseQuote(MEME, USDC.address, [])).toBeNull();
  });
});
