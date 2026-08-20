import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applySellFill,
  bumpDailyStats,
  dayKey,
  getDailyStats,
  getOpenPositionByMint,
  insertPosition,
  isOnCooldown,
  kvGet,
  kvSet,
  listClosedPositions,
  listOpenPositions,
  openTraderDb,
  setEntryMarkPrice,
  setTokenCooldown,
  updateTickState,
  upsertTokenLog,
  type Db,
} from '../src/db.js';

const NOW = 1_755_600_000; // 2025-08-19 ~UTC

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trader-test-'));
  db = openTraderDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function openPosition() {
  return insertPosition(db, {
    mode: 'paper',
    chain: 'solana',
    mint: 'MintA',
    symbol: 'TKA',
    entryTs: NOW,
    entryLiquidityUsd: 50_000,
    entryMcapUsd: 40_000,
    entryScore: 70,
    entryRiskScore: 10,
    entryReasons: 'Momentum 1h',
    fill: { tokensQty: 10_000, solSpent: 0.2, usdSpent: 40, priceUsd: 0.004, txSig: null },
  });
}

describe('posições', () => {
  it('ciclo completo: abre, vende parcial, fecha com PnL', () => {
    const pos = openPosition();
    expect(pos.status).toBe('open');
    expect(pos.tokensQty).toBe(10_000);
    expect(pos.entryMcapUsd).toBe(40_000);
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    // Modo live não enxerga posição paper.
    expect(listOpenPositions(db, 'live')).toHaveLength(0);

    // Vende metade com lucro.
    const half = applySellFill(
      db,
      pos,
      { tokensSold: 5_000, solReceived: 0.15, usdReceived: 30, priceUsd: 0.006, txSig: null, soldAll: false },
      'take profit',
      NOW + 600,
    );
    expect(half.closed).toBe(false);
    expect(half.position.tokensQty).toBe(5_000);
    expect(half.position.solReceived).toBeCloseTo(0.15);

    // Vende o resto com preço menor.
    const rest = applySellFill(
      db,
      half.position,
      { tokensSold: 5_000, solReceived: 0.12, usdReceived: 24, priceUsd: 0.0048, txSig: null, soldAll: true },
      'trailing stop',
      NOW + 1200,
      55_000,
    );
    expect(rest.closed).toBe(true);
    expect(rest.position.exitMcapUsd).toBe(55_000);
    expect(rest.position.status).toBe('closed');
    // PnL total: recebeu 0.27, gastou 0.2.
    expect(rest.position.pnlSol).toBeCloseTo(0.07);
    expect(rest.position.pnlPct).toBeCloseTo(35);
    expect(rest.position.exitReason).toBe('trailing stop');

    expect(listOpenPositions(db, 'paper')).toHaveLength(0);
    expect(listClosedPositions(db, 'paper')).toHaveLength(1);
  });

  it('poeira de arredondamento fecha a posição', () => {
    const pos = openPosition();
    const result = applySellFill(
      db,
      pos,
      // Vendeu "tudo" menos um resíduo de float minúsculo.
      { tokensSold: 10_000 - 1e-9, solReceived: 0.2, usdReceived: 40, priceUsd: 0.004, txSig: null, soldAll: false },
      'stop loss',
      NOW + 60,
    );
    expect(result.closed).toBe(true);
  });

  it('soldAll fecha mesmo com sobra contábil grande (fill live < quote)', () => {
    // Live: a contabilidade achava 10.000 tokens (quote), a carteira tinha 9.700
    // (slippage/taxa). A venda de 100% esvaziou a carteira: soldAll=true TEM que
    // fechar — sem isso a posição vira zumbi, re-tenta venda para sempre e o
    // prejuízo nunca chega ao circuit breaker diário.
    const pos = openPosition();
    const result = applySellFill(
      db,
      pos,
      { tokensSold: 9_700, solReceived: 0.15, usdReceived: 30, priceUsd: 0.0031, txSig: 'sig', soldAll: true },
      'stop loss',
      NOW + 60,
    );
    expect(result.closed).toBe(true);
    expect(result.position.status).toBe('closed');
    expect(result.position.pnlSol).toBeCloseTo(-0.05);
  });

  it('fechamento duplo é bloqueado: o segundo fill não sobrescreve nem conta de novo', () => {
    const pos = openPosition();
    const first = applySellFill(
      db,
      pos,
      { tokensSold: 10_000, solReceived: 0.3, usdReceived: 60, priceUsd: 0.006, txSig: null, soldAll: true },
      'take profit',
      NOW + 60,
    );
    expect(first.closed).toBe(true);
    expect(first.applied).toBe(true);

    // Outro processo tenta aplicar venda com o objeto OBSOLETO da mesma posição.
    const second = applySellFill(
      db,
      pos,
      { tokensSold: 10_000, solReceived: 0.28, usdReceived: 56, priceUsd: 0.0056, txSig: null, soldAll: true },
      'manual',
      NOW + 61,
    );
    expect(second.applied).toBe(false);
    expect(second.closed).toBe(false);
    // O registro no banco continua o do PRIMEIRO fechamento.
    expect(second.position.pnlSol).toBeCloseTo(first.position.pnlSol!);
    expect(second.position.exitReason).toBe('take profit');
  });

  it('baseline executável: só a PRIMEIRA marca conta', () => {
    const pos = openPosition();
    expect(pos.entryMarkPriceUsd).toBeNull();

    setEntryMarkPrice(db, pos.id, 0.0037);
    expect(getOpenPositionByMint(db, 'paper', 'MintA')!.entryMarkPriceUsd).toBeCloseTo(0.0037);

    // Uma segunda marca NÃO move o baseline — senão o stop loss viraria um
    // alvo móvel que persegue o preço para baixo e nunca dispara.
    setEntryMarkPrice(db, pos.id, 0.002);
    expect(getOpenPositionByMint(db, 'paper', 'MintA')!.entryMarkPriceUsd).toBeCloseTo(0.0037);
  });

  it('atualiza estado de tick (pico, último preço, stale)', () => {
    const pos = openPosition();
    updateTickState(db, pos.id, 0.009, 0.0085, 0);
    const updated = getOpenPositionByMint(db, 'paper', 'MintA')!;
    expect(updated.peakPriceUsd).toBe(0.009);
    expect(updated.lastPriceUsd).toBe(0.0085);
  });
});

describe('kv e cooldown', () => {
  it('kv persiste e sobrescreve', () => {
    expect(kvGet(db, 'x')).toBeNull();
    kvSet(db, 'x', '1.5');
    kvSet(db, 'x', '2.5');
    expect(kvGet(db, 'x')).toBe('2.5');
  });

  it('cooldown de token', () => {
    expect(isOnCooldown(db, 'MintZ', NOW)).toBe(false);
    upsertTokenLog(db, 'MintZ', 'TKZ', 55, 'rejected', '[]', NOW + 3600, NOW);
    expect(isOnCooldown(db, 'MintZ', NOW)).toBe(true);
    expect(isOnCooldown(db, 'MintZ', NOW + 3601)).toBe(false);
  });

  it('setTokenCooldown re-arma sem sobrescrever para trás (MAX)', () => {
    upsertTokenLog(db, 'MintZ', 'TKZ', 10, 'approved', '[]', NOW + 7200, NOW);
    // Re-arme com prazo MENOR não pode encurtar o cooldown vigente.
    setTokenCooldown(db, 'MintZ', 'TKZ', NOW + 3600, NOW);
    expect(isOnCooldown(db, 'MintZ', NOW + 7000)).toBe(true);
    // Re-arme com prazo maior estende.
    setTokenCooldown(db, 'MintZ', 'TKZ', NOW + 10_000, NOW);
    expect(isOnCooldown(db, 'MintZ', NOW + 9_000)).toBe(true);
    // E funciona para mint que nunca foi avaliado.
    setTokenCooldown(db, 'MintNovo', 'NEW', NOW + 100, NOW);
    expect(isOnCooldown(db, 'MintNovo', NOW + 50)).toBe(true);
  });
});

describe('estatística diária', () => {
  it('acumula PnL, wins e losses por dia UTC', () => {
    bumpDailyStats(db, NOW, 0.1, 20);
    bumpDailyStats(db, NOW, -0.04, -8);
    const stats = getDailyStats(db, NOW);
    expect(stats.realizedPnlSol).toBeCloseTo(0.06);
    expect(stats.trades).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);

    // Outro dia começa zerado.
    const nextDay = getDailyStats(db, NOW + 86_400);
    expect(nextDay.trades).toBe(0);
  });

  it('dayKey vira na meia-noite UTC', () => {
    expect(dayKey(NOW)).not.toBe(dayKey(NOW + 86_400));
  });
});

describe('migração de banco antigo', () => {
  it('adiciona as colunas novas num trader.sqlite criado antes delas', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'trader-old-'));
    // Banco no formato ANTIGO (sem entry_mcap_usd/exit_mcap_usd/mcap_usd/venue).
    const raw = new Database(join(oldDir, 'trader.sqlite'));
    raw.exec(`
      CREATE TABLE positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, chain TEXT NOT NULL,
        mint TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        entry_ts INTEGER NOT NULL, entry_price_usd REAL NOT NULL, entry_liquidity_usd REAL NOT NULL,
        entry_score REAL NOT NULL DEFAULT 0, entry_risk_score REAL NOT NULL DEFAULT 0,
        entry_reasons TEXT NOT NULL DEFAULT '', sol_spent REAL NOT NULL, usd_spent REAL NOT NULL,
        tokens_bought REAL NOT NULL, tokens_qty REAL NOT NULL, peak_price_usd REAL NOT NULL,
        last_price_usd REAL NOT NULL DEFAULT 0, took_profit INTEGER NOT NULL DEFAULT 0,
        stale_ticks INTEGER NOT NULL DEFAULT 0, sol_received REAL NOT NULL DEFAULT 0,
        usd_received REAL NOT NULL DEFAULT 0, exit_ts INTEGER, exit_price_usd REAL,
        exit_reason TEXT, pnl_sol REAL, pnl_usd REAL, pnl_pct REAL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, position_id INTEGER, ts INTEGER NOT NULL,
        mode TEXT NOT NULL, side TEXT NOT NULL, mint TEXT NOT NULL,
        sol_amount REAL NOT NULL DEFAULT 0, token_amount REAL NOT NULL DEFAULT 0,
        price_usd REAL NOT NULL DEFAULT 0, tx_sig TEXT, ok INTEGER NOT NULL, error TEXT
      );
    `);
    raw.close();

    // Reabrir pelo caminho oficial roda a migração — e o INSERT novo funciona.
    const migrated = openTraderDb(oldDir);
    const pos = insertPosition(migrated, {
      mode: 'paper',
      chain: 'solana',
      mint: 'MintMigrado',
      symbol: 'MIG',
      entryTs: NOW,
      entryLiquidityUsd: 1000,
      entryMcapUsd: 22_000,
      entryScore: 60,
      entryRiskScore: 5,
      entryReasons: 'teste',
      fill: { tokensQty: 100, solSpent: 0.1, usdSpent: 10, priceUsd: 0.1, txSig: null },
    });
    expect(pos.entryMcapUsd).toBe(22_000);
    // Posição de banco antigo nasce sem baseline executável — e aceita um.
    expect(pos.entryMarkPriceUsd).toBeNull();
    setEntryMarkPrice(migrated, pos.id, 0.09);
    migrated.close();
    rmSync(oldDir, { recursive: true, force: true });
  });
});
