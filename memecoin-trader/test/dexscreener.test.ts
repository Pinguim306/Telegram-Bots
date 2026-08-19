import { describe, expect, it } from 'vitest';
import { bestPairPerMint, normalizePair } from '../src/datasources/dexscreener.js';

const NOW_MS = 1_700_000_000_000;

/** Par cru no formato real da API do DexScreener. */
function rawPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/abc',
    pairAddress: 'PairAddr1111111111111111111111111111111111',
    baseToken: { address: 'MintA11111111111111111111111111111111111111', name: 'Token A', symbol: 'TKA' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: '0.0000051234',
    priceUsd: '0.001042',
    txns: { m5: { buys: 12, sells: 4 }, h1: { buys: 130, sells: 60 }, h6: { buys: 500, sells: 300 }, h24: { buys: 900, sells: 700 } },
    volume: { h24: 250000.5, h6: 90000, h1: 40000, m5: 5000 },
    priceChange: { m5: 2.5, h1: 12, h6: 30, h24: -5 },
    liquidity: { usd: 75000.25, base: 50000000, quote: 190 },
    fdv: 1042000,
    marketCap: 1000000,
    pairCreatedAt: NOW_MS - 6 * 3600 * 1000,
    ...overrides,
  };
}

describe('normalizePair', () => {
  it('normaliza o par completo', () => {
    const snap = normalizePair(rawPair(), NOW_MS)!;
    expect(snap.mint).toBe('MintA11111111111111111111111111111111111111');
    expect(snap.symbol).toBe('TKA');
    expect(snap.priceUsd).toBeCloseTo(0.001042);
    expect(snap.priceNative).toBeCloseTo(0.0000051234);
    expect(snap.liquidityUsd).toBeCloseTo(75000.25);
    expect(snap.vol1hUsd).toBe(40000);
    expect(snap.buys1h).toBe(130);
    expect(snap.sells1h).toBe(60);
    expect(snap.change1hPct).toBe(12);
    expect(snap.ageMin).toBeCloseTo(360);
    expect(snap.marketCapUsd).toBe(1000000);
  });

  it('descarta par de outra chain', () => {
    expect(normalizePair(rawPair({ chainId: 'ethereum' }), NOW_MS)).toBeNull();
  });

  it('descarta par sem preço', () => {
    expect(normalizePair(rawPair({ priceUsd: undefined }), NOW_MS)).toBeNull();
    expect(normalizePair(rawPair({ priceUsd: '0' }), NOW_MS)).toBeNull();
  });

  it('idade fica null quando pairCreatedAt falta — desconhecido não é zero', () => {
    const snap = normalizePair(rawPair({ pairCreatedAt: undefined }), NOW_MS)!;
    expect(snap.ageMin).toBeNull();
  });

  it('campos de volume/txns ausentes viram zero, não NaN', () => {
    const snap = normalizePair(rawPair({ volume: undefined, txns: undefined, priceChange: undefined }), NOW_MS)!;
    expect(snap.vol1hUsd).toBe(0);
    expect(snap.buys1h).toBe(0);
    expect(snap.change5mPct).toBe(0);
  });

  it('sobrevive a lixo na entrada', () => {
    expect(normalizePair(null, NOW_MS)).toBeNull();
    expect(normalizePair('string', NOW_MS)).toBeNull();
    expect(normalizePair({}, NOW_MS)).toBeNull();
    expect(normalizePair({ chainId: 'solana', baseToken: {} }, NOW_MS)).toBeNull();
  });
});

describe('bestPairPerMint', () => {
  it('escolhe o par de maior liquidez por mint', () => {
    const small = normalizePair(rawPair({ liquidity: { usd: 1000 }, pairAddress: 'small' }), NOW_MS)!;
    const big = normalizePair(rawPair({ liquidity: { usd: 90000 }, pairAddress: 'big' }), NOW_MS)!;
    const other = normalizePair(
      rawPair({
        baseToken: { address: 'MintB11111111111111111111111111111111111111', symbol: 'TKB', name: 'B' },
        pairAddress: 'otherpair',
      }),
      NOW_MS,
    )!;
    const best = bestPairPerMint([small, big, other]);
    expect(best.size).toBe(2);
    expect(best.get(small.mint)!.pairAddress).toBe('big');
  });
});
