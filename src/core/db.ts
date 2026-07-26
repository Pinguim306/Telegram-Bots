import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Estado local em SQLite. Um arquivo por bot, para que um bot possa ser reiniciado,
 * migrado ou apagado sem afetar o outro.
 *
 * WAL ligado porque o loop de scan escreve em rajada (centenas de trades por tick)
 * enquanto o publisher lê para decidir cooldown.
 */
export function openDb(dataDir: string, name: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(resolve(dataDir, `${name}.sqlite`));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      scope       TEXT PRIMARY KEY,
      last_block  INTEGER NOT NULL,
      last_hash   TEXT,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      address          TEXT PRIMARY KEY,
      symbol           TEXT,
      name             TEXT,
      decimals         INTEGER,
      total_supply     TEXT,
      first_seen_block INTEGER NOT NULL,
      first_seen_ts    INTEGER NOT NULL,
      creator          TEXT,
      is_erc20         INTEGER NOT NULL DEFAULT 0,
      risk_json        TEXT,
      launch_alerted   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pools (
      address       TEXT PRIMARY KEY,
      factory       TEXT,
      kind          TEXT NOT NULL,
      token0        TEXT NOT NULL,
      token1        TEXT NOT NULL,
      fee           INTEGER,
      base_token    TEXT,
      quote_token   TEXT,
      created_block INTEGER,
      created_ts    INTEGER,
      discovered_ts INTEGER NOT NULL,
      alerted       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pools_base ON pools(base_token);

    CREATE TABLE IF NOT EXISTS trades (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pool         TEXT NOT NULL,
      token        TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      block        INTEGER NOT NULL,
      tx_hash      TEXT NOT NULL,
      log_index    INTEGER NOT NULL,
      side         TEXT NOT NULL,
      token_amount REAL NOT NULL,
      quote_amount REAL NOT NULL,
      usd          REAL NOT NULL,
      price_usd    REAL NOT NULL,
      trader       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_unique ON trades(tx_hash, log_index);
    CREATE INDEX IF NOT EXISTS idx_trades_token_ts ON trades(token, ts);
    CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);

    CREATE TABLE IF NOT EXISTS pool_state (
      pool          TEXT PRIMARY KEY,
      liquidity_usd REAL,
      price_usd     REAL,
      updated_ts    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      kind    TEXT NOT NULL,
      subject TEXT NOT NULL,
      score   REAL NOT NULL DEFAULT 0,
      ts      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_subject ON alerts(kind, subject, ts);
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
  `);
}

export function getCheckpoint(db: Db, scope: string): { block: bigint; hash: string | null } | null {
  const row = db
    .prepare('SELECT last_block, last_hash FROM checkpoints WHERE scope = ?')
    .get(scope) as { last_block: number; last_hash: string | null } | undefined;
  return row ? { block: BigInt(row.last_block), hash: row.last_hash } : null;
}

export function setCheckpoint(db: Db, scope: string, block: bigint, hash: string | null): void {
  db.prepare(
    `INSERT INTO checkpoints (scope, last_block, last_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET last_block = excluded.last_block,
                                      last_hash = excluded.last_hash,
                                      updated_at = excluded.updated_at`,
  ).run(scope, Number(block), hash, Math.floor(Date.now() / 1000));
}

/** Remove trades e alertas antigos. Sem isso o arquivo cresce sem limite. */
export function prune(db: Db, retentionSec: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - retentionSec;
  const trades = db.prepare('DELETE FROM trades WHERE ts < ?').run(cutoff).changes;
  // alertas ficam o dobro do tempo: são o histórico que sustenta cooldown e auditoria
  db.prepare('DELETE FROM alerts WHERE ts < ?').run(cutoff - retentionSec);
  return trades;
}
