import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeTokens,
  baselineVolumePerSec,
  priceChangePct,
  windowStats,
  EMPTY_WINDOW,
} from '../src/bots/signals/metrics.js';

const TOKEN = '0xaa';
const NOW = 10_000;

let db: Database.Database;

function seed(
  trades: Array<{ ts: number; side: 'buy' | 'sell'; usd: number; price: number; trader: string }>,
) {
  const stmt = db.prepare(
    `INSERT INTO trades (pool, token, ts, block, tx_hash, log_index, side,
                         token_amount, quote_amount, usd, price_usd, trader)
     VALUES ('0xpool', ?, ?, 1, ?, ?, ?, 1, 1, ?, ?, ?)`,
  );
  trades.forEach((t, i) => stmt.run(TOKEN, t.ts, `0x${i}`, i, t.side, t.usd, t.price, t.trader));
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool TEXT, token TEXT, ts INTEGER, block INTEGER, tx_hash TEXT, log_index INTEGER,
      side TEXT, token_amount REAL, quote_amount REAL, usd REAL, price_usd REAL, trader TEXT
    );
  `);
});

describe('windowStats', () => {
  it('agrega compras, vendas, volume e carteiras únicas na janela', () => {
    seed([
      { ts: NOW - 10, side: 'buy', usd: 100, price: 1, trader: '0x1' },
      { ts: NOW - 20, side: 'buy', usd: 200, price: 2, trader: '0x2' },
      { ts: NOW - 30, side: 'buy', usd: 50, price: 1.5, trader: '0x1' },
      { ts: NOW - 40, side: 'sell', usd: 80, price: 1.2, trader: '0x3' },
    ]);

    const stats = windowStats(db, TOKEN, NOW, 180);
    expect(stats.buys).toBe(3);
    expect(stats.sells).toBe(1);
    expect(stats.volumeUsd).toBe(430);
    expect(stats.buyVolumeUsd).toBe(350);
    expect(stats.sellVolumeUsd).toBe(80);
    // 0x1 comprou duas vezes e conta uma só.
    expect(stats.uniqueBuyers).toBe(2);
    expect(stats.uniqueSellers).toBe(1);
  });

  it('exclui trades fora da janela', () => {
    seed([
      { ts: NOW - 10, side: 'buy', usd: 100, price: 1, trader: '0x1' },
      { ts: NOW - 5_000, side: 'buy', usd: 999, price: 1, trader: '0x2' },
    ]);
    expect(windowStats(db, TOKEN, NOW, 180).volumeUsd).toBe(100);
  });

  it('pega o primeiro e o último preço em ordem cronológica', () => {
    seed([
      { ts: NOW - 100, side: 'buy', usd: 10, price: 1, trader: '0x1' },
      { ts: NOW - 50, side: 'buy', usd: 10, price: 3, trader: '0x2' },
      { ts: NOW - 10, side: 'buy', usd: 10, price: 2, trader: '0x3' },
    ]);
    const stats = windowStats(db, TOKEN, NOW, 180);
    expect(stats.firstPriceUsd).toBe(1);
    expect(stats.lastPriceUsd).toBe(2);
    expect(priceChangePct(stats)).toBe(100);
  });

  it('devolve zeros quando não há trade nenhum', () => {
    const stats = windowStats(db, TOKEN, NOW, 180);
    expect(stats.buys).toBe(0);
    expect(stats.volumeUsd).toBe(0);
    expect(stats.firstPriceUsd).toBeNull();
    expect(priceChangePct(stats)).toBe(0);
  });
});

describe('activeTokens', () => {
  it('lista apenas tokens com trade recente', () => {
    seed([{ ts: NOW - 10, side: 'buy', usd: 1, price: 1, trader: '0x1' }]);
    db.prepare(
      `INSERT INTO trades (pool, token, ts, block, tx_hash, log_index, side,
                           token_amount, quote_amount, usd, price_usd, trader)
       VALUES ('0xpool', '0xbb', ?, 1, '0xzz', 99, 'buy', 1, 1, 1, 1, '0x9')`,
    ).run(NOW - 9_000);

    expect(activeTokens(db, NOW - 180)).toEqual([TOKEN]);
  });
});

describe('baselineVolumePerSec', () => {
  it('remove a janela curta da linha de base', () => {
    const short = { ...EMPTY_WINDOW(180), volumeUsd: 9_000 };
    const long = { ...EMPTY_WINDOW(3_600), volumeUsd: 12_000 };
    // (12.000 - 9.000) / (3.600 - 180)
    expect(baselineVolumePerSec(short, long)).toBeCloseTo(3_000 / 3_420);
  });

  it('devolve zero quando a janela longa não é maior que a curta', () => {
    expect(baselineVolumePerSec(EMPTY_WINDOW(180), EMPTY_WINDOW(180))).toBe(0);
  });

  it('nunca devolve negativo, mesmo com janelas inconsistentes', () => {
    const short = { ...EMPTY_WINDOW(180), volumeUsd: 5_000 };
    const long = { ...EMPTY_WINDOW(3_600), volumeUsd: 1_000 };
    expect(baselineVolumePerSec(short, long)).toBe(0);
  });
});
