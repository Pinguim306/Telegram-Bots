import { describe, expect, it } from 'vitest';
import type { Position } from '../src/db.js';
import { computeTradeStats, normalizeExitReason, wilsonCi95 } from '../src/stats.js';

function pos(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    mode: 'paper',
    chain: 'solana',
    mint: 'MintA',
    symbol: 'TKA',
    status: 'closed',
    entryTs: 1_000,
    entryPriceUsd: 0.001,
    entryMarkPriceUsd: null,
    entryLiquidityUsd: 10_000,
    entryMcapUsd: 20_000,
    exitMcapUsd: 21_000,
    entryScore: 60,
    entryRiskScore: 10,
    entryReasons: '',
    solSpent: 0.2,
    usdSpent: 40,
    tokensBought: 1000,
    tokensQty: 0,
    peakPriceUsd: 0.0011,
    lastPriceUsd: 0.0011,
    tookProfit: false,
    staleTicks: 0,
    deadTicks: 0,
    solReceived: 0.22,
    usdReceived: 44,
    exitTs: 1_120,
    exitPriceUsd: 0.0011,
    exitReason: 'take profit (10.0%)',
    pnlSol: 0.02,
    pnlUsd: 4,
    pnlPct: 10,
    ...overrides,
  };
}

describe('wilsonCi95', () => {
  it('com amostra pequena o intervalo é largo — é esse o aviso', () => {
    const [lo, hi] = wilsonCi95(1, 3);
    expect(lo).toBeLessThan(20);
    expect(hi).toBeGreaterThan(70);
  });

  it('aperta conforme a amostra cresce, mantendo a mesma proporção', () => {
    const small = wilsonCi95(30, 100);
    const large = wilsonCi95(300, 1000);
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });

  it('n=0 não explode', () => {
    expect(wilsonCi95(0, 0)).toEqual([0, 100]);
  });
});

describe('normalizeExitReason', () => {
  it('agrupa motivos com números diferentes', () => {
    expect(normalizeExitReason('take profit (11.2%)')).toBe('take profit');
    expect(normalizeExitReason('stop loss (-24.6%)')).toBe('stop loss');
    expect(normalizeExitReason(null)).toBe('?');
  });
});

describe('computeTradeStats', () => {
  it('expectativa e breakeven expõem o payoff assimétrico que a win rate esconde', () => {
    // 2 ganhos pequenos e 1 perda grande: win rate 67%, mas PnL negativo —
    // exatamente o padrão que custou dinheiro no live.
    const s = computeTradeStats([
      pos({ pnlSol: 0.022, pnlPct: 9.6, exitReason: 'take profit (11.2%)' }),
      pos({ pnlSol: 0.028, pnlPct: 12.2, exitReason: 'take profit (13.9%)' }),
      pos({ pnlSol: -0.059, pnlPct: -25.7, exitReason: 'stop loss (-24.6%)' }),
    ]);
    expect(s.n).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.winRatePct).toBeCloseTo(66.7, 0);
    expect(s.totalPnlSol).toBeCloseTo(-0.009, 3);
    expect(s.expectancySol).toBeLessThan(0);
    // Precisaria de ~70% de acerto para empatar — acima da win rate observada.
    expect(s.breakevenWrPct!).toBeGreaterThan(66.7);
  });

  it('pedágio de entrada é a mediana da marca contra o fill; sem marca, é null', () => {
    const semMarca = computeTradeStats([pos(), pos()]);
    expect(semMarca.entryTollPct).toBeNull();

    const comMarca = computeTradeStats([
      pos({ entryPriceUsd: 0.001, entryMarkPriceUsd: 0.00092 }), // -8%
      pos({ entryPriceUsd: 0.001, entryMarkPriceUsd: 0.00094 }), // -6%
      pos({ entryPriceUsd: 0.001, entryMarkPriceUsd: 0.0009 }), //  -10%
    ]);
    expect(comMarca.entryTollPct!.n).toBe(3);
    expect(comMarca.entryTollPct!.medianPct).toBeCloseTo(-8, 1);
  });

  it('agrupa PnL por motivo de saída, do pior para o melhor', () => {
    const s = computeTradeStats([
      pos({ pnlSol: -0.05, exitReason: 'stop loss (-20%)' }),
      pos({ pnlSol: -0.03, exitReason: 'stop loss (-14%)' }),
      pos({ pnlSol: 0.02, exitReason: 'take profit (10%)' }),
    ]);
    expect(s.byExitReason[0]!.reason).toBe('stop loss');
    expect(s.byExitReason[0]!.n).toBe(2);
    expect(s.byExitReason[0]!.pnlSol).toBeCloseTo(-0.08);
  });

  it('lista vazia não quebra', () => {
    const s = computeTradeStats([]);
    expect(s.n).toBe(0);
    expect(s.expectancySol).toBe(0);
    expect(s.breakevenWrPct).toBeNull();
  });
});
