import { describe, expect, it } from 'vitest';
import { loadTraderConfig } from '../src/config.js';
import { evaluateEntry, evaluateExit, type ExitContext } from '../src/strategy.js';
import type { PairSnapshot } from '../src/types.js';

const cfg = loadTraderConfig();

/** Token em alta clara: passa em todos os gates e pontua em todas as regras. */
function pumpingSnap(overrides: Partial<PairSnapshot> = {}): PairSnapshot {
  return {
    mint: 'MintPumping111111111111111111111111111111111',
    symbol: 'PUMP',
    name: 'Pumping',
    pairAddress: 'Pair1111111111111111111111111111111111111111',
    dexId: 'pumpswap',
    quoteSymbol: 'SOL',
    priceUsd: 0.001,
    priceNative: 0.000005,
    liquidityUsd: 80_000,
    fdvUsd: 25_000,
    marketCapUsd: 25_000,
    vol5mUsd: 8_000,
    vol1hUsd: 60_000,
    vol24hUsd: 200_000,
    buys5m: 40,
    sells5m: 15,
    buys1h: 220,
    sells1h: 90,
    change5mPct: 4,
    change1hPct: 18,
    change6hPct: 35,
    change24hPct: 60,
    ageMin: 300,
    url: null,
    ...overrides,
  };
}

describe('evaluateEntry — gates', () => {
  it('aprova e pontua o token em alta', () => {
    const result = evaluateEntry(pumpingSnap(), ['gt-trending'], cfg.entry);
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(cfg.entry.minScore);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('reprova liquidez abaixo do mínimo', () => {
    const result = evaluateEntry(pumpingSnap({ liquidityUsd: 5_000 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('liquidez');
  });

  it('reprova liquidez DESCONHECIDA na entrada — não se compra o que não se sabe vender', () => {
    const result = evaluateEntry(pumpingSnap({ liquidityUsd: null }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('desconhecida');
  });

  it('reprova volume 1h abaixo do mínimo', () => {
    const result = evaluateEntry(pumpingSnap({ vol1hUsd: 1_000 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('volume');
  });

  it('reprova token novo demais — os primeiros minutos são dos snipers', () => {
    const result = evaluateEntry(pumpingSnap({ ageMin: 1 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('idade');
  });

  it('reprova DEX fora de allowedDexIds — o perfil é pump.fun', () => {
    const result = evaluateEntry(pumpingSnap({ dexId: 'raydium' }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('dex');
  });

  it('bonding curve (pumpfun): liquidez ausente é estrutural e NÃO reprova', () => {
    // O DexScreener não reporta `liquidity` para o par da curve — visto em
    // token real (liquidity ausente, minutos de vida, +342% em 5m). O mcap do
    // fixture fica dentro da banda [minMarketCapUsd, maxMarketCapUsd] do config.
    const result = evaluateEntry(
      pumpingSnap({ dexId: 'pumpfun', liquidityUsd: null, marketCapUsd: 25_000, fdvUsd: 25_000 }),
      ['gt-trending'],
      cfg.entry,
    );
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(cfg.entry.minScore);
  });

  it('curve com market cap abaixo do piso reprova — recém-mintado é terreno de sniper', () => {
    const result = evaluateEntry(
      pumpingSnap({ dexId: 'pumpfun', liquidityUsd: null, marketCapUsd: 8_000, fdvUsd: 8_000 }),
      [],
      cfg.entry,
    );
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('market cap');
  });

  it('curve sem market cap conhecido reprova — sem liquidez E sem mcap não há piso nenhum', () => {
    const result = evaluateEntry(
      pumpingSnap({ dexId: 'pumpfun', liquidityUsd: null, marketCapUsd: null, fdvUsd: null }),
      [],
      cfg.entry,
    );
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('desconhecido');
  });

  it('reprova token velho demais', () => {
    const result = evaluateEntry(pumpingSnap({ ageMin: 800 * 60 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
  });

  it('idade desconhecida NÃO reprova (o resto das defesas segue valendo)', () => {
    const result = evaluateEntry(pumpingSnap({ ageMin: null }), ['gt-trending'], cfg.entry);
    expect(result.eligible).toBe(true);
  });

  it('reprova pressão vendedora', () => {
    const result = evaluateEntry(pumpingSnap({ buys1h: 40, sells1h: 120 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('buy ratio');
  });

  it('reprova market cap alto demais (blue chip não é alvo)', () => {
    const result = evaluateEntry(pumpingSnap({ marketCapUsd: 500_000_000 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
  });

  it('token morno passa nos gates mas não soma o score mínimo', () => {
    const result = evaluateEntry(
      pumpingSnap({
        change5mPct: 0.1,
        change1hPct: 0.5,
        vol1hUsd: 26_000,
        vol24hUsd: 620_000, // baseline alta -> sem spike
        buys1h: 120,
        sells1h: 95,
      }),
      [],
      cfg.entry,
    );
    expect(result.eligible).toBe(true);
    expect(result.score).toBeLessThan(cfg.entry.minScore);
  });
});

describe('evaluateExit', () => {
  const nowTs = 1_700_000_000;
  function ctx(overrides: Partial<ExitContext> = {}): ExitContext {
    return {
      entryPriceUsd: 0.001,
      peakPriceUsd: 0.001,
      entryLiquidityUsd: 80_000,
      entryTs: nowTs - 600,
      tookProfit: false,
      staleTicks: 0,
      ...overrides,
    };
  }

  it('segura posição saudável', () => {
    const decision = evaluateExit(ctx(), pumpingSnap({ priceUsd: 0.00105 }), cfg.exit, nowTs);
    expect(decision.action).toBe('hold');
  });

  it('stop loss vende tudo', () => {
    const decision = evaluateExit(ctx(), pumpingSnap({ priceUsd: 0.00079 }), cfg.exit, nowTs);
    expect(decision).toMatchObject({ action: 'sell', portionPct: 100, urgent: true });
    if (decision.action === 'sell') expect(decision.reason).toContain('stop loss');
  });

  it('dreno de liquidez vende tudo, mesmo com preço de tela positivo', () => {
    const decision = evaluateExit(
      ctx(),
      pumpingSnap({ priceUsd: 0.0012, liquidityUsd: 20_000 }),
      cfg.exit,
      nowTs,
    );
    expect(decision).toMatchObject({ action: 'sell', portionPct: 100, urgent: true });
    if (decision.action === 'sell') expect(decision.reason).toContain('liquidez');
  });

  it('take profit vende a fração configurada, uma vez só', () => {
    const price = 0.001 * (1 + cfg.exit.takeProfitPct / 100 + 0.01);
    const first = evaluateExit(ctx({ peakPriceUsd: price }), pumpingSnap({ priceUsd: price }), cfg.exit, nowTs);
    // peak == preço atual -> drawdown 0 -> trailing não dispara; TP dispara.
    expect(first).toMatchObject({ action: 'sell', portionPct: cfg.exit.takeProfitSellPct });

    const again = evaluateExit(
      ctx({ tookProfit: true, peakPriceUsd: price }),
      pumpingSnap({ priceUsd: price }),
      cfg.exit,
      nowTs,
    );
    expect(again.action).toBe('hold');
  });

  it('trailing stop trava lucro depois da ativação', () => {
    // Subiu 60% (peak), caiu 20% do topo -> ainda +28% da entrada.
    const peak = 0.0016;
    const current = peak * (1 - (cfg.exit.trailingStopPct + 5) / 100);
    const decision = evaluateExit(
      ctx({ peakPriceUsd: peak, tookProfit: true }),
      pumpingSnap({ priceUsd: current }),
      cfg.exit,
      nowTs,
    );
    expect(decision).toMatchObject({ action: 'sell', portionPct: 100 });
    if (decision.action === 'sell') expect(decision.reason).toContain('trailing');
  });

  it('tempo máximo encerra a posição', () => {
    const decision = evaluateExit(
      ctx({ entryTs: nowTs - (cfg.exit.maxHoldMin + 1) * 60 }),
      pumpingSnap({ priceUsd: 0.001 }),
      cfg.exit,
      nowTs,
    );
    expect(decision).toMatchObject({ action: 'sell', portionPct: 100 });
  });

  it('sem dados: espera staleTicksToExit ticks, depois vende', () => {
    const wait = evaluateExit(ctx({ staleTicks: 0 }), null, cfg.exit, nowTs);
    expect(wait.action).toBe('hold');

    const sell = evaluateExit(ctx({ staleTicks: cfg.exit.staleTicksToExit - 1 }), null, cfg.exit, nowTs);
    expect(sell).toMatchObject({ action: 'sell', portionPct: 100, urgent: true });
  });

  it('liquidez DESCONHECIDA na resposta não dispara venda por dreno (mas zero real dispara)', () => {
    // Resposta parcial da API (liquidity ausente) não pode vender uma posição
    // saudável em pânico — desconhecido não é zero.
    const unknown = evaluateExit(ctx(), pumpingSnap({ liquidityUsd: null }), cfg.exit, nowTs);
    expect(unknown.action).toBe('hold');

    // Já um ZERO lido de verdade é pool vazio: dispara.
    const drained = evaluateExit(ctx(), pumpingSnap({ liquidityUsd: 0 }), cfg.exit, nowTs);
    expect(drained).toMatchObject({ action: 'sell', portionPct: 100, urgent: true });
  });

  it('dreno de liquidez tem prioridade sobre take profit', () => {
    const decision = evaluateExit(
      ctx(),
      pumpingSnap({ priceUsd: 0.0016, liquidityUsd: 10_000 }),
      cfg.exit,
      nowTs,
    );
    if (decision.action === 'sell') expect(decision.reason).toContain('liquidez');
    else expect.fail('deveria vender');
  });
});
