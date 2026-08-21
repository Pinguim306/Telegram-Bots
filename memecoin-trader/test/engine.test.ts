import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/brokers.js';
import { loadTraderConfig } from '../src/config.js';
import { getDailyStats, listClosedPositions, listOpenPositions, openTraderDb, type Db } from '../src/db.js';
import type { Advisor, AdvisorVerdict } from '../src/advisor.js';
import { cachedSource, TraderEngine, type Sources } from '../src/engine.js';
import type {
  Candidate,
  ChainAdapter,
  HolderStats,
  OnchainTokenInfo,
  PairSnapshot,
  RugcheckSummary,
} from '../src/types.js';

/**
 * Teste de integração do laço completo — descoberta → risco → compra → gestão →
 * venda — sem tocar rede nenhuma: fontes, chain e preço são falsos; o broker é
 * o PaperBroker real e o banco é um SQLite de verdade em diretório temporário.
 */

const MINT = 'MintPump11111111111111111111111111111111111';
const T0 = 1_755_600_000;

const cfg = loadTraderConfig();
const log = pino({ level: 'silent' });

function snap(overrides: Partial<PairSnapshot> = {}): PairSnapshot {
  return {
    mint: MINT,
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

class FakeChain implements ChainAdapter {
  readonly key = 'solana' as const;
  walletAddress(): string | null {
    return null;
  }
  async nativeBalanceSol(): Promise<number> {
    return 0;
  }
  async getOnchainTokenInfo(): Promise<OnchainTokenInfo | null> {
    return {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      token2022: true,
      dangerousExtensions: [],
      taxingExtensions: [],
      decimals: 6,
      supplyRaw: 1_000_000_000_000n,
      supplyUi: 1_000_000,
    };
  }
  async getTopHolders(): Promise<HolderStats | null> {
    return { top1Pct: 4, top10Pct: 22, holderCount: null, source: 'onchain' };
  }
  async tokenBalanceUi(): Promise<number> {
    return 0;
  }
}

/** PaperBroker que grava o flag `urgent` recebido em cada venda. */
class UrgentSpyBroker extends PaperBroker {
  urgentSeen: boolean[] = [];
  override async sell(
    mint: string,
    tokensQty: number,
    portionPct: number,
    snap: PairSnapshot,
    solPriceUsd: number,
    urgent = false,
  ) {
    this.urgentSeen.push(urgent);
    return super.sell(mint, tokensQty, portionPct, snap, solPriceUsd, urgent);
  }
}

/** PaperBroker com marca executável controlável — simula o live, cuja marca vem da quote real. */
class MarkSpyBroker extends PaperBroker {
  markSol: number | null = null;
  override async markValueSol(_mint: string, _tokensQty: number): Promise<number | null> {
    return this.markSol;
  }
}

/** Advisor de teste: devolve sempre o mesmo veredito (ou null = IA fora do ar). */
class FakeAdvisor implements Advisor {
  calls = 0;
  constructor(private readonly verdict: AdvisorVerdict | null) {}
  async judge(): Promise<AdvisorVerdict | null> {
    this.calls++;
    return this.verdict;
  }
}

const cleanRugcheck: RugcheckSummary = {
  available: true,
  rugged: false,
  scoreNormalized: 5,
  dangerFlags: [],
  lpDangerFlags: [],
  warnFlags: [],
  lpLockedPct: 95,
  holderCount: 5_000,
  top10Pct: 20,
};

function fakeSources(state: { snap: PairSnapshot | null }): Sources {
  return {
    pumpportal: async () => [],
    trending: async (): Promise<Candidate[]> => [{ mint: MINT, symbol: 'PUMP', sources: ['gt-trending'] }],
    newPools: async () => [],
    boosts: async () => [],
    pairs: async (mints) => {
      const map = new Map<string, PairSnapshot>();
      if (state.snap && mints.includes(MINT)) map.set(MINT, state.snap);
      return map;
    },
    rugcheck: async () => cleanRugcheck,
    solPriceUsd: async () => 200,
  };
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trader-engine-'));
  db = openTraderDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TraderEngine', () => {
  it('descobre, aprova no risco, compra — e o stop loss fecha no crash', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    // Tick 1: token em alta -> entra.
    await engine.tick(T0);
    const open = listOpenPositions(db, 'paper');
    expect(open).toHaveLength(1);
    expect(open[0]!.mint).toBe(MINT);
    expect(open[0]!.solSpent).toBeCloseTo(cfg.sizing.maxPositionSol, 5);
    expect(await broker.balanceSol()).toBeCloseTo(
      cfg.sizing.paperStartBalanceSol - cfg.sizing.maxPositionSol,
      5,
    );

    // Tick 2: -30% -> stop loss fecha tudo.
    state.snap = snap({ priceUsd: 0.0007 });
    await engine.tick(T0 + 60);

    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    const closed = listClosedPositions(db, 'paper');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toContain('stop loss');
    expect(closed[0]!.pnlSol!).toBeLessThan(0);

    const daily = getDailyStats(db, T0 + 60);
    expect(daily.trades).toBe(1);
    expect(daily.losses).toBe(1);
    expect(daily.realizedPnlSol).toBeCloseTo(closed[0]!.pnlSol!, 10);

    // O SOL da venda voltou para o caixa simulado.
    const expectedBalance =
      cfg.sizing.paperStartBalanceSol - closed[0]!.solSpent + closed[0]!.solReceived;
    expect(await broker.balanceSol()).toBeCloseTo(expectedBalance, 5);

    // Tick 3: o token está em cooldown — não recompra.
    state.snap = snap();
    await engine.tick(T0 + 120);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
  });

  it('token vetado no risco nunca vira posição', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const sources = fakeSources(state);
    sources.rugcheck = async () => ({
      ...cleanRugcheck,
      dangerFlags: ['Freeze Authority still enabled'],
    });
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), sources, log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(await broker.balanceSol()).toBe(cfg.sizing.paperStartBalanceSol);
  });

  it('token que some do indexador: sai após N ticks e o paper contabiliza PERDA TOTAL', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    const open = listOpenPositions(db, 'paper');
    expect(open).toHaveLength(1);
    const solSpent = open[0]!.solSpent;

    // O indexador responde, mas o token não está mais lá.
    state.snap = null;
    for (let i = 0; i < cfg.exit.staleTicksToExit; i++) {
      await engine.tick(T0 + 60 * (i + 1));
    }

    const closed = listClosedPositions(db, 'paper');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toContain('sem dados');
    // Token sumido do indexador costuma ser pool drenado: o paper NÃO pode
    // creditar o último preço visto — seria transformar rug de -100% em -1,5%
    // e inflar a estatística que decide a ida para o live.
    expect(closed[0]!.pnlSol!).toBeCloseTo(-solSpent, 5);
    expect(getDailyStats(db, T0 + 600).realizedPnlSol).toBeCloseTo(-solSpent, 5);
  });

  it('take profit (scalp) fecha a posição inteira com urgent=false e realiza o lucro', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new UrgentSpyBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    const entryPrice = listOpenPositions(db, 'paper')[0]!.entryPriceUsd;

    // Preço no alvo do scalp (sem drawdown do topo) -> vende TUDO, não urgente.
    state.snap = snap({ priceUsd: entryPrice * (1 + cfg.exit.takeProfitPct / 100 + 0.02) });
    await engine.tick(T0 + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(broker.urgentSeen).toEqual([false]);

    const closed = listClosedPositions(db, 'paper');
    expect(closed[0]!.exitReason).toContain('take profit');
    expect(closed[0]!.pnlSol!).toBeGreaterThan(0);
  });

  it('dreno de liquidez sai com urgent=true', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new UrgentSpyBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);

    // Liquidez despenca abaixo de liquidityDrainPct da entrada -> saída urgente.
    state.snap = snap({ liquidityUsd: 10_000 });
    await engine.tick(T0 + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(broker.urgentSeen).toEqual([true]);
  });

  it('IA reprovando ("pular") bloqueia a compra e aparece no funil como gate "ia"', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const advisor = new FakeAdvisor({ decision: 'pular', confidence: 90, reason: 'topo do pump' });
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log, advisor);

    await engine.tick(T0);
    expect(advisor.calls).toBe(1);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(engine.lastTick!.gateTally['ia']).toBe(1);
    expect(await broker.balanceSol()).toBe(cfg.sizing.paperStartBalanceSol);
  });

  it('IA "comprar" com confiança abaixo do mínimo também bloqueia', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const advisor = new FakeAdvisor({
      decision: 'comprar',
      confidence: cfg.ai.minConfidence - 1,
      reason: 'sinal fraco',
    });
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log, advisor);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
  });

  it('IA aprovando compra — e o veredito fica gravado nos motivos da posição', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const advisor = new FakeAdvisor({ decision: 'comprar', confidence: 88, reason: 'momentum nascendo' });
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log, advisor);

    await engine.tick(T0);
    const open = listOpenPositions(db, 'paper');
    expect(open).toHaveLength(1);
    expect(open[0]!.entryReasons).toContain('IA 88%: momentum nascendo');
  });

  it('IA fora do ar (veredito null) é FAIL-OPEN: a compra segue pelos critérios quantitativos', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const advisor = new FakeAdvisor(null);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log, advisor);

    await engine.tick(T0);
    expect(advisor.calls).toBe(1);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
  });

  it('pausado pelo painel: gestão continua, novas entradas não acontecem', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    engine.setPaused(true);
    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(engine.lastTick!.blocked).toContain('pausado');

    engine.setPaused(false);
    await engine.tick(T0 + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
  });

  it('marca executável manda nas saídas: tela mentindo -60% não vende; marca -20% vende', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new MarkSpyBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    // Tick 1: compra (sem marca ainda — markValueSol só roda na gestão).
    await engine.tick(T0);
    const pos = listOpenPositions(db, 'paper')[0]!;
    const solUsd = 200;
    // Marca 7% abaixo do preço de entrada: o custo real de entrar (impacto + taxas).
    const baselinePrice = pos.entryPriceUsd * 0.93;
    broker.markSol = (baselinePrice * pos.tokensQty) / solUsd;

    // Tick 2: o indexador MENTE -60% (cenário BALDCHUA real). Com marca
    // disponível, este tick só define o baseline — nada de stop loss.
    state.snap = snap({ priceUsd: pos.entryPriceUsd * 0.4 });
    await engine.tick(T0 + 15);
    const afterBaseline = listOpenPositions(db, 'paper');
    expect(afterBaseline).toHaveLength(1);
    expect(afterBaseline[0]!.entryMarkPriceUsd!).toBeCloseTo(baselinePrice, 10);
    // O pico RESETA para a marca: o pico antigo (preço de tela da entrada)
    // armaria o trailing num topo que nunca existiu em valor executável.
    expect(afterBaseline[0]!.peakPriceUsd).toBeCloseTo(baselinePrice, 10);

    // Tick 3: o token some do indexador, mas a marca segue estável -> HOLD,
    // sem acumular tick "stale" — a quote real é dado de preço de verdade.
    state.snap = null;
    await engine.tick(T0 + 30);
    const held = listOpenPositions(db, 'paper');
    expect(held).toHaveLength(1);
    expect(held[0]!.staleTicks).toBe(0);

    // Tick 4: a marca cai 20% do baseline -> stop loss real fecha, e o fill
    // sai pela marca (não é a perda total do caminho "sumiu do indexador").
    broker.markSol = (baselinePrice * 0.8 * pos.tokensQty) / solUsd;
    await engine.tick(T0 + 45);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    const closed = listClosedPositions(db, 'paper')[0]!;
    expect(closed.exitReason).toContain('stop loss');
    expect(closed.pnlSol!).toBeLessThan(0);
    expect(closed.solReceived).toBeGreaterThan(pos.solSpent * 0.5);
  });

  it('token que morre no chão após a compra sai por "morto" — sem esperar o tempo máximo', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    // Tick 1: compra com o mercado quente.
    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    const entryPrice = listOpenPositions(db, 'paper')[0]!.entryPriceUsd;

    // O mercado MORRE: preço congela perto da entrada (nunca stopa), volume e
    // txns de 5m zeram — o caso Hashbrown real ($23k de volume na 1ª hora,
    // depois zero absoluto).
    state.snap = snap({
      priceUsd: entryPrice * 0.99,
      vol5mUsd: 0,
      buys5m: 0,
      sells5m: 0,
    });

    // Dentro da carência pós-compra: ainda não conta como morto.
    await engine.tick(T0 + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    expect(listOpenPositions(db, 'paper')[0]!.deadTicks).toBe(0);

    // Passada a carência, cada tick morto conta — e no limiar, vende tudo.
    const afterGrace = T0 + (cfg.exit.deadMinHoldMin + 1) * 60;
    for (let i = 0; i < cfg.exit.deadTicksToExit; i++) {
      await engine.tick(afterGrace + i * 15);
    }
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    const closed = listClosedPositions(db, 'paper')[0]!;
    expect(closed.exitReason).toContain('morto');
    // Saiu pelo preço que ainda havia (-1% e slippage) — NÃO é a perda total
    // do caminho "sumiu do indexador".
    expect(closed.solReceived).toBeGreaterThan(closed.solSpent * 0.9);
  });

  it('volume 5m voltando zera a contagem de morto — mercado vivo não sai por faxina', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    const entryPrice = listOpenPositions(db, 'paper')[0]!.entryPriceUsd;
    const afterGrace = T0 + (cfg.exit.deadMinHoldMin + 1) * 60;

    // Alguns ticks mortos (abaixo do limiar)...
    state.snap = snap({ priceUsd: entryPrice, vol5mUsd: 0, buys5m: 0, sells5m: 0 });
    for (let i = 0; i < cfg.exit.deadTicksToExit - 1; i++) {
      await engine.tick(afterGrace + i * 15);
    }
    // ...o volume volta: contagem zera.
    state.snap = snap({ priceUsd: entryPrice, vol5mUsd: 5_000, buys5m: 30, sells5m: 10 });
    await engine.tick(afterGrace + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    expect(listOpenPositions(db, 'paper')[0]!.deadTicks).toBe(0);
  });

  it('fechar por tempo máximo re-arma o cooldown — sem recompra no MESMO tick', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);

    // Muito depois do cooldown de análise (tokenCooldownMin) expirar: o tempo máximo vende.
    // O token continua trending e passando nos gates — sem o re-arme do cooldown
    // na SAÍDA, o scanForEntries do MESMO tick recompraria na sequência.
    const exitTick = T0 + (cfg.exit.maxHoldMin + 1) * 60;
    await engine.tick(exitTick);

    const closed = listClosedPositions(db, 'paper');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toContain('tempo máximo');
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);

    // E também não recompra no tick seguinte.
    await engine.tick(exitTick + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
  });

  it('venda manual parcial não desarma o take profit da posição', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);

    await engine.manualSell(MINT, 30);
    const after = listOpenPositions(db, 'paper');
    expect(after).toHaveLength(1);
    expect(after[0]!.tookProfit).toBe(false);
    expect(after[0]!.tokensQty).toBeLessThan(after[0]!.tokensBought);
  });

  it('sem preço do SOL (e sem fallback), o tick inteiro é pulado', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const sources = fakeSources(state);
    sources.solPriceUsd = async () => null;
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), sources, log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
  });
});

describe('cachedSource', () => {
  it('serve do cache dentro do TTL e revalida depois', async () => {
    let clock = 0;
    let calls = 0;
    const source = cachedSource(
      async () => {
        calls++;
        return [calls];
      },
      60_000,
      () => clock,
    );

    expect(await source()).toEqual([1]);
    clock = 15_000;
    expect(await source()).toEqual([1]); // dentro do TTL: não chama de novo
    clock = 45_000;
    expect(await source()).toEqual([1]);
    expect(calls).toBe(1);

    clock = 61_000;
    expect(await source()).toEqual([2]); // TTL vencido: revalida
    expect(calls).toBe(2);
  });

  it('em falha, serve o resultado anterior (até 5×TTL) em vez de derrubar a descoberta', async () => {
    let clock = 0;
    let fail = false;
    const source = cachedSource(
      async () => {
        if (fail) throw new Error('429');
        return ['ok'];
      },
      60_000,
      () => clock,
    );

    expect(await source()).toEqual(['ok']);
    fail = true;
    clock = 61_000;
    expect(await source()).toEqual(['ok']); // stale é melhor que nada
    clock = 400_000; // além de 5×TTL: o erro passa a propagar
    await expect(source()).rejects.toThrow('429');
  });

  it('ttl 0 desliga o cache', async () => {
    let calls = 0;
    const source = cachedSource(
      async () => {
        calls++;
        return [calls];
      },
      0,
      () => 0,
    );
    await source();
    await source();
    expect(calls).toBe(2);
  });
});
