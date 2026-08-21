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
    // Derivado do config para o teste sobreviver a recalibrações do piso.
    const belowFloor = cfg.entry.gates.minMarketCapUsd - 1;
    const result = evaluateEntry(
      pumpingSnap({ dexId: 'pumpfun', liquidityUsd: null, marketCapUsd: belowFloor, fdvUsd: belowFloor }),
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

  it('idade desconhecida REPROVA quando há gate de idade mínima — dados reais reverteram a regra antiga', () => {
    // 100% do prejuízo do dia analisado veio de tokens <5min; os "sem data"
    // eram exatamente os mais novos. O engine preenche a idade pelo PumpPortal
    // quando viu o mint nascer — desconhecida de verdade é raro e suspeito.
    const result = evaluateEntry(pumpingSnap({ ageMin: null }), ['gt-trending'], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejectionId).toBe('idade_null');
  });

  it('reprova pressão vendedora', () => {
    // 350 txns em 300min mantém o ritmo acima do gate (5,8/min) para o teste
    // morrer onde deve: na proporção de compras.
    const result = evaluateEntry(pumpingSnap({ buys1h: 100, sells1h: 250 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('buy ratio');
  });

  it('reprova despencada de 5m — pós-dump não é entrada (caso Hashbrown)', () => {
    // Números de 1h ainda quentes (o pump inteiro está na janela), mas o 5m
    // mostra a queda: é exatamente o token que morre no chão logo depois.
    const result = evaluateEntry(
      pumpingSnap({ change5mPct: -(cfg.entry.gates.maxDrop5mPct + 1) }),
      ['gt-trending'],
      cfg.entry,
    );
    expect(result.eligible).toBe(false);
    expect(result.rejectionId).toBe('queda_5m');
  });

  it('reprova market cap alto demais (blue chip não é alvo)', () => {
    const result = evaluateEntry(pumpingSnap({ marketCapUsd: 500_000_000 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
  });


  it('graduação (pp-migration) pontua a regra trending — candidato do PumpPortal não nasce com handicap', () => {
    const viaGt = evaluateEntry(pumpingSnap(), ['gt-trending'], cfg.entry);
    const viaGrad = evaluateEntry(pumpingSnap(), ['pp-new', 'pp-migration'], cfg.entry);
    const semNada = evaluateEntry(pumpingSnap(), ['pp-new'], cfg.entry);
    expect(viaGrad.score).toBe(viaGt.score);
    expect(viaGrad.score).toBeGreaterThan(semNada.score);
  });

  it('reprovação carrega rejectionId estável para o heartbeat agregar', () => {
    expect(evaluateEntry(pumpingSnap({ dexId: 'raydium' }), [], cfg.entry).rejectionId).toBe('dex');
    expect(evaluateEntry(pumpingSnap({ vol1hUsd: 100 }), [], cfg.entry).rejectionId).toBe('volume');
    expect(evaluateEntry(pumpingSnap({ marketCapUsd: 500_000_000 }), [], cfg.entry).rejectionId).toBe('mcap_max');
  });

  it('token morno passa nos gates mas não soma o score mínimo', () => {
    const result = evaluateEntry(
      pumpingSnap({
        ageMin: 40, // ritmo 26k/40 = $650/min — passa no gate de ritmo
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

  it('ritmo é proporcional à idade: jovem com pouco volume absoluto passa, velho com o mesmo volume não', () => {
    // 8 minutos de vida, $6k negociados = $750/min: acima do piso absoluto (2.5k)
    // e do ritmo mínimo (500/min) — o alvo real da estratégia.
    const jovem = evaluateEntry(
      pumpingSnap({ ageMin: 8, vol1hUsd: 6_000, vol24hUsd: 6_000 }),
      ['pp-migration'],
      cfg.entry,
    );
    expect(jovem.eligible).toBe(true);

    // Mesmos $6k mas em 60 minutos = $100/min: morto, e o motivo é o ritmo.
    const velho = evaluateEntry(
      pumpingSnap({ ageMin: 60, vol1hUsd: 6_000, vol24hUsd: 6_000 }),
      [],
      cfg.entry,
    );
    expect(velho.eligible).toBe(false);
    expect(velho.rejection).toContain('ritmo');
  });

  it('piso absoluto de volume segue cortando poeira, mesmo com ritmo alto', () => {
    // 2 minutos e $2k: ritmo $1000/min, mas abaixo do piso de $2.5k... e da idade mínima.
    // Usa 4min/$2k: ritmo 500/min ok, piso 2.5k reprova.
    const result = evaluateEntry(pumpingSnap({ ageMin: 4, vol1hUsd: 2_000, vol24hUsd: 2_000 }), [], cfg.entry);
    expect(result.eligible).toBe(false);
    expect(result.rejection).toContain('volume');
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
      deadTicks: 0,
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

  it('token morto (deadTicks no limiar) vende tudo — caso Hashbrown: preço congelado nunca stopa', () => {
    // Snap com preço estável (nem stop nem TP) — só o mercado morreu.
    const deadSnap = pumpingSnap({ priceUsd: 0.00098, vol5mUsd: 0, buys5m: 0, sells5m: 0 });

    const wait = evaluateExit(
      ctx({ deadTicks: cfg.exit.deadTicksToExit - 1 }),
      deadSnap,
      cfg.exit,
      nowTs,
    );
    expect(wait.action).toBe('hold');

    const sell = evaluateExit(ctx({ deadTicks: cfg.exit.deadTicksToExit }), deadSnap, cfg.exit, nowTs);
    expect(sell).toMatchObject({ action: 'sell', portionPct: 100, urgent: false });
    if (sell.action === 'sell') expect(sell.reason).toContain('morto');
  });

  it('stop loss tem prioridade sobre token morto — proteção antes de faxina', () => {
    const crashed = pumpingSnap({ priceUsd: 0.0005, vol5mUsd: 0, buys5m: 0, sells5m: 0 });
    const sell = evaluateExit(ctx({ deadTicks: 99 }), crashed, cfg.exit, nowTs);
    expect(sell).toMatchObject({ action: 'sell', urgent: true });
    if (sell.action === 'sell') expect(sell.reason).toContain('stop loss');
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

describe('gate de ritmo de transações', () => {
  it('jovem com poucas txns absolutas passa; velho com as mesmas txns morre no ritmo', () => {
    // 10min de vida, 60 txns = 6/min: acima do piso (30) e do ritmo (5/min).
    const jovem = evaluateEntry(
      pumpingSnap({ ageMin: 10, buys1h: 40, sells1h: 20, vol1hUsd: 8_000, vol24hUsd: 8_000 }),
      ['pp-migration'],
      cfg.entry,
    );
    expect(jovem.eligible).toBe(true);

    // Mesmas 60 txns em 60min = 1/min: morto, e o motivo é o ritmo de txns.
    const velho = evaluateEntry(
      pumpingSnap({ ageMin: 60, buys1h: 40, sells1h: 20, vol1hUsd: 31_000, vol24hUsd: 31_000 }),
      [],
      cfg.entry,
    );
    expect(velho.eligible).toBe(false);
    expect(velho.rejection).toContain('txns');
  });
});
