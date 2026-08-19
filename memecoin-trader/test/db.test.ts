import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(listOpenPositions(db, 'paper')).toHaveLength(1);
    // Modo live não enxerga posição paper.
    expect(listOpenPositions(db, 'live')).toHaveLength(0);

    // Vende metade com lucro.
    const half = applySellFill(
      db,
      pos,
      { tokensSold: 5_000, solReceived: 0.15, usdReceived: 30, priceUsd: 0.006, txSig: null },
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
      { tokensSold: 5_000, solReceived: 0.12, usdReceived: 24, priceUsd: 0.0048, txSig: null },
      'trailing stop',
      NOW + 1200,
    );
    expect(rest.closed).toBe(true);
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
      { tokensSold: 10_000 - 1e-9, solReceived: 0.2, usdReceived: 40, priceUsd: 0.004, txSig: null },
      'stop loss',
      NOW + 60,
    );
    expect(result.closed).toBe(true);
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
