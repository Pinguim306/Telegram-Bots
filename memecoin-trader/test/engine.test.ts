import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/brokers.js';
import { loadTraderConfig } from '../src/config.js';
import { getDailyStats, listClosedPositions, listOpenPositions, openTraderDb, type Db } from '../src/db.js';
import { TraderEngine, type Sources } from '../src/engine.js';
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
    dexId: 'raydium',
    quoteSymbol: 'SOL',
    priceUsd: 0.001,
    priceNative: 0.000005,
    liquidityUsd: 80_000,
    fdvUsd: 900_000,
    marketCapUsd: 900_000,
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

  it('take profit vende com urgent=false; dreno de liquidez vende com urgent=true', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new UrgentSpyBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    const entryPrice = listOpenPositions(db, 'paper')[0]!.entryPriceUsd;

    // Preço no take profit (sem drawdown do topo) -> venda parcial NÃO urgente.
    state.snap = snap({ priceUsd: entryPrice * (1 + cfg.exit.takeProfitPct / 100 + 0.02) });
    await engine.tick(T0 + 60);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    expect(broker.urgentSeen).toEqual([false]);

    // Liquidez despenca abaixo de liquidityDrainPct da entrada -> saída urgente.
    state.snap = snap({ priceUsd: entryPrice, liquidityUsd: 10_000 });
    await engine.tick(T0 + 120);
    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(broker.urgentSeen).toEqual([false, true]);
  });

  it('fechar por tempo máximo re-arma o cooldown — sem recompra no MESMO tick', async () => {
    const state = { snap: snap() as PairSnapshot | null };
    const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
    const engine = new TraderEngine(cfg, db, broker, new FakeChain(), fakeSources(state), log);

    await engine.tick(T0);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);

    // Muito depois do cooldown de análise (90min) expirar: o tempo máximo vende.
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
