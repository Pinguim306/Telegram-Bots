import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { BuyFill, SellFill, TradeMode } from './types.js';

export type Db = Database.Database;

/**
 * Estado local em SQLite. Posições, ordens, histórico de avaliação de token e
 * estatística diária (que sustenta o circuit breaker de perda).
 *
 * Posições paper e live convivem no mesmo arquivo, separadas pela coluna `mode` —
 * trocar de modo não faz o bot "enxergar" posições do outro modo.
 */
export function openTraderDb(dataDir: string, chain: 'solana' | 'bsc' = 'solana'): Db {
  mkdirSync(dataDir, { recursive: true });
  // Um ARQUIVO por rede: além das posições (que já têm coluna chain), o kv
  // (caixa paper), a estatística diária do circuit breaker e os cooldowns são
  // globais na tabela — compartilhar o arquivo misturaria o PnL das redes.
  // 'trader.sqlite' fica para a Solana (compatibilidade com o banco existente).
  const file = chain === 'bsc' ? 'trader-bsc.sqlite' : 'trader.sqlite';
  const db = new Database(resolve(dataDir, file));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Adiciona uma coluna se ela ainda não existir. O CREATE TABLE IF NOT EXISTS
 * não altera tabelas de bancos já criados — sem isto, quem atualizasse o bot
 * com um trader.sqlite antigo quebraria no primeiro INSERT.
 */
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      mode                TEXT NOT NULL,
      chain               TEXT NOT NULL,
      mint                TEXT NOT NULL,
      symbol              TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'open',
      entry_ts            INTEGER NOT NULL,
      entry_price_usd     REAL NOT NULL,
      entry_liquidity_usd REAL NOT NULL,
      entry_mcap_usd      REAL,
      exit_mcap_usd       REAL,
      entry_score         REAL NOT NULL DEFAULT 0,
      entry_risk_score    REAL NOT NULL DEFAULT 0,
      entry_reasons       TEXT NOT NULL DEFAULT '',
      sol_spent           REAL NOT NULL,
      usd_spent           REAL NOT NULL,
      tokens_bought       REAL NOT NULL,
      tokens_qty          REAL NOT NULL,
      peak_price_usd      REAL NOT NULL,
      last_price_usd      REAL NOT NULL DEFAULT 0,
      took_profit         INTEGER NOT NULL DEFAULT 0,
      stale_ticks         INTEGER NOT NULL DEFAULT 0,
      sol_received        REAL NOT NULL DEFAULT 0,
      usd_received        REAL NOT NULL DEFAULT 0,
      exit_ts             INTEGER,
      exit_price_usd      REAL,
      exit_reason         TEXT,
      pnl_sol             REAL,
      pnl_usd             REAL,
      pnl_pct             REAL
    );
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(mode, status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint, status);

    CREATE TABLE IF NOT EXISTS orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id  INTEGER,
      ts           INTEGER NOT NULL,
      mode         TEXT NOT NULL,
      side         TEXT NOT NULL,
      mint         TEXT NOT NULL,
      sol_amount   REAL NOT NULL DEFAULT 0,
      token_amount REAL NOT NULL DEFAULT 0,
      price_usd    REAL NOT NULL DEFAULT 0,
      mcap_usd     REAL,
      venue        TEXT,
      tx_sig       TEXT,
      ok           INTEGER NOT NULL,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);

    CREATE TABLE IF NOT EXISTS token_log (
      mint           TEXT PRIMARY KEY,
      symbol         TEXT,
      first_seen_ts  INTEGER NOT NULL,
      last_eval_ts   INTEGER NOT NULL,
      risk_score     REAL,
      verdict        TEXT,
      flags_json     TEXT,
      cooldown_until INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      day              TEXT PRIMARY KEY,
      realized_pnl_sol REAL NOT NULL DEFAULT 0,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      trades           INTEGER NOT NULL DEFAULT 0,
      wins             INTEGER NOT NULL DEFAULT 0,
      losses           INTEGER NOT NULL DEFAULT 0
    );

    -- Cada decisão FINAL do funil sobre um candidato analisado (comprado,
    -- reprovado pelo risco, reprovado pela IA...), com o snapshot da hora.
    -- É o dado que o log jogava fora: sem ele, calibrar limiar é palpite —
    -- o comando replay lê daqui e responde "as reprovações teriam dado lucro?".
    CREATE TABLE IF NOT EXISTS decisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      mode          TEXT NOT NULL,
      mint          TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      stage         TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      entry_score   REAL NOT NULL,
      risk_score    REAL,
      ai_decision   TEXT,
      ai_confidence REAL,
      price_usd     REAL NOT NULL,
      config_hash   TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
  `);

  ensureColumn(db, 'positions', 'entry_mcap_usd', 'REAL');
  ensureColumn(db, 'positions', 'exit_mcap_usd', 'REAL');
  // Preço por token da PRIMEIRA marca executável após a compra (quote real de
  // venda). É o baseline das regras de saída: absorve o custo de entrada
  // (impacto + taxas) que faria todo trade nascer "dentro do stop loss".
  ensureColumn(db, 'positions', 'entry_mark_price_usd', 'REAL');
  // Ticks seguidos com o mercado do token morto (volume/txns 5m ~zero) — a
  // saída "token morto" precisa de persistência para sobreviver a restart.
  ensureColumn(db, 'positions', 'dead_ticks', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'mcap_usd', 'REAL');
  ensureColumn(db, 'orders', 'venue', 'TEXT');
}

// ─────────────────────────────────────────────────────────────
//  kv
// ─────────────────────────────────────────────────────────────

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// ─────────────────────────────────────────────────────────────
//  Posições
// ─────────────────────────────────────────────────────────────

export interface Position {
  id: number;
  mode: TradeMode;
  chain: string;
  mint: string;
  symbol: string;
  status: 'open' | 'closed';
  entryTs: number;
  entryPriceUsd: number;
  /**
   * Preço por token da PRIMEIRA marca executável após a compra (quote real de
   * venda no agregador), ou null enquanto não houver marca. Quando existe, é o
   * baseline das regras de saída no lugar de entryPriceUsd: absorve o custo de
   * entrada (impacto de preço + taxas) que faria todo trade nascer no stop.
   */
  entryMarkPriceUsd: number | null;
  entryLiquidityUsd: number;
  /** Market cap na COMPRA (o "tamanho" do token quando entramos), ou null. */
  entryMcapUsd: number | null;
  /** Market cap na venda que FECHOU a posição, ou null. */
  exitMcapUsd: number | null;
  entryScore: number;
  entryRiskScore: number;
  entryReasons: string;
  solSpent: number;
  usdSpent: number;
  tokensBought: number;
  tokensQty: number;
  peakPriceUsd: number;
  /** Último preço visto no indexador — é o preço usado se o token sumir de lá. */
  lastPriceUsd: number;
  tookProfit: boolean;
  staleTicks: number;
  /** Ticks seguidos com volume/txns de 5m ~zero — alimenta a saída "token morto". */
  deadTicks: number;
  solReceived: number;
  usdReceived: number;
  exitTs: number | null;
  exitPriceUsd: number | null;
  exitReason: string | null;
  pnlSol: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
}

interface PositionRow {
  id: number;
  mode: string;
  chain: string;
  mint: string;
  symbol: string;
  status: string;
  entry_ts: number;
  entry_price_usd: number;
  entry_mark_price_usd: number | null;
  entry_liquidity_usd: number;
  entry_mcap_usd: number | null;
  exit_mcap_usd: number | null;
  entry_score: number;
  entry_risk_score: number;
  entry_reasons: string;
  sol_spent: number;
  usd_spent: number;
  tokens_bought: number;
  tokens_qty: number;
  peak_price_usd: number;
  last_price_usd: number;
  took_profit: number;
  stale_ticks: number;
  dead_ticks: number;
  sol_received: number;
  usd_received: number;
  exit_ts: number | null;
  exit_price_usd: number | null;
  exit_reason: string | null;
  pnl_sol: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
}

function mapPosition(row: PositionRow): Position {
  return {
    id: row.id,
    mode: row.mode as TradeMode,
    chain: row.chain,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status as 'open' | 'closed',
    entryTs: row.entry_ts,
    entryPriceUsd: row.entry_price_usd,
    entryMarkPriceUsd: row.entry_mark_price_usd,
    entryLiquidityUsd: row.entry_liquidity_usd,
    entryMcapUsd: row.entry_mcap_usd,
    exitMcapUsd: row.exit_mcap_usd,
    entryScore: row.entry_score,
    entryRiskScore: row.entry_risk_score,
    entryReasons: row.entry_reasons,
    solSpent: row.sol_spent,
    usdSpent: row.usd_spent,
    tokensBought: row.tokens_bought,
    tokensQty: row.tokens_qty,
    peakPriceUsd: row.peak_price_usd,
    lastPriceUsd: row.last_price_usd,
    tookProfit: row.took_profit === 1,
    staleTicks: row.stale_ticks,
    deadTicks: row.dead_ticks,
    solReceived: row.sol_received,
    usdReceived: row.usd_received,
    exitTs: row.exit_ts,
    exitPriceUsd: row.exit_price_usd,
    exitReason: row.exit_reason,
    pnlSol: row.pnl_sol,
    pnlUsd: row.pnl_usd,
    pnlPct: row.pnl_pct,
  };
}

export interface NewPosition {
  mode: TradeMode;
  chain: string;
  mint: string;
  symbol: string;
  entryTs: number;
  entryLiquidityUsd: number;
  entryMcapUsd: number | null;
  entryScore: number;
  entryRiskScore: number;
  entryReasons: string;
  fill: BuyFill;
}

export function insertPosition(db: Db, p: NewPosition): Position {
  const result = db
    .prepare(
      `INSERT INTO positions (mode, chain, mint, symbol, status, entry_ts, entry_price_usd,
         entry_liquidity_usd, entry_mcap_usd, entry_score, entry_risk_score, entry_reasons,
         sol_spent, usd_spent, tokens_bought, tokens_qty, peak_price_usd, last_price_usd)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.mode,
      p.chain,
      p.mint,
      p.symbol,
      p.entryTs,
      p.fill.priceUsd,
      p.entryLiquidityUsd,
      p.entryMcapUsd,
      p.entryScore,
      p.entryRiskScore,
      p.entryReasons,
      p.fill.solSpent,
      p.fill.usdSpent,
      p.fill.tokensQty,
      p.fill.tokensQty,
      p.fill.priceUsd,
      p.fill.priceUsd,
    );
  return getPosition(db, Number(result.lastInsertRowid))!;
}

export function getPosition(db: Db, id: number): Position | null {
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as PositionRow | undefined;
  return row ? mapPosition(row) : null;
}

export function listOpenPositions(db: Db, mode: TradeMode): Position[] {
  const rows = db
    .prepare("SELECT * FROM positions WHERE mode = ? AND status = 'open' ORDER BY entry_ts")
    .all(mode) as PositionRow[];
  return rows.map(mapPosition);
}

export function getOpenPositionByMint(db: Db, mode: TradeMode, mint: string): Position | null {
  const row = db
    .prepare("SELECT * FROM positions WHERE mode = ? AND mint = ? AND status = 'open' LIMIT 1")
    .get(mode, mint) as PositionRow | undefined;
  return row ? mapPosition(row) : null;
}

export function listClosedPositions(db: Db, mode: TradeMode, limit = 50): Position[] {
  const rows = db
    .prepare(
      "SELECT * FROM positions WHERE mode = ? AND status = 'closed' ORDER BY exit_ts DESC LIMIT ?",
    )
    .all(mode, limit) as PositionRow[];
  return rows.map(mapPosition);
}

/** Atualiza o estado de mercado da posição visto neste tick. */
export function updateTickState(
  db: Db,
  id: number,
  peakPriceUsd: number,
  lastPriceUsd: number,
  staleTicks: number,
  deadTicks = 0,
): void {
  db.prepare(
    'UPDATE positions SET peak_price_usd = ?, last_price_usd = ?, stale_ticks = ?, dead_ticks = ? WHERE id = ?',
  ).run(peakPriceUsd, lastPriceUsd, staleTicks, deadTicks, id);
}

export function markTookProfit(db: Db, id: number): void {
  db.prepare('UPDATE positions SET took_profit = 1 WHERE id = ?').run(id);
}

/** Grava o baseline executável — só a primeira marca conta, as demais são ignoradas. */
export function setEntryMarkPrice(db: Db, id: number, priceUsd: number): void {
  db.prepare(
    'UPDATE positions SET entry_mark_price_usd = ? WHERE id = ? AND entry_mark_price_usd IS NULL',
  ).run(priceUsd, id);
}

/**
 * Aplica uma venda (parcial ou total) e fecha a posição quando ela zera.
 *
 * Fecha por `fill.soldAll` (a venda liquidou tudo que existia de vendível —
 * a contabilidade local pode divergir do fill real por slippage/taxa e não
 * pode segurar a posição aberta) ou por poeira de arredondamento de float.
 *
 * Os UPDATEs exigem status='open': dois processos (o `run` e um `sell` manual)
 * podem decidir vender a mesma posição com objetos obsoletos — o segundo
 * fechamento não pode sobrescrever o primeiro nem contar PnL duas vezes.
 * `applied: false` = a posição já não estava aberta; quem chamou não deve
 * contabilizar nada.
 */
export function applySellFill(
  db: Db,
  position: Position,
  fill: SellFill,
  reason: string,
  nowTs: number,
  exitMcapUsd: number | null = null,
): { position: Position; closed: boolean; applied: boolean } {
  const remaining = Math.max(0, position.tokensQty - fill.tokensSold);
  const dustThreshold = position.tokensBought * 1e-6;
  const closed = fill.soldAll || remaining <= dustThreshold;

  const solReceived = position.solReceived + fill.solReceived;
  const usdReceived = position.usdReceived + fill.usdReceived;

  let changes: number;
  if (closed) {
    const pnlSol = solReceived - position.solSpent;
    const pnlUsd = usdReceived - position.usdSpent;
    const pnlPct = position.solSpent > 0 ? (pnlSol / position.solSpent) * 100 : 0;
    changes = db
      .prepare(
        `UPDATE positions SET tokens_qty = 0, sol_received = ?, usd_received = ?, status = 'closed',
           exit_ts = ?, exit_price_usd = ?, exit_reason = ?, pnl_sol = ?, pnl_usd = ?, pnl_pct = ?,
           exit_mcap_usd = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(solReceived, usdReceived, nowTs, fill.priceUsd, reason, pnlSol, pnlUsd, pnlPct, exitMcapUsd, position.id)
      .changes;
  } else {
    changes = db
      .prepare(
        `UPDATE positions SET tokens_qty = ?, sol_received = ?, usd_received = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(remaining, solReceived, usdReceived, position.id).changes;
  }

  const applied = changes > 0;
  return { position: getPosition(db, position.id)!, closed: closed && applied, applied };
}

// ─────────────────────────────────────────────────────────────
//  Ordens (trilha de auditoria — inclusive as que falharam)
// ─────────────────────────────────────────────────────────────

export interface OrderRecord {
  positionId: number | null;
  ts: number;
  mode: TradeMode;
  side: 'buy' | 'sell';
  mint: string;
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  /** Market cap do token no momento da ordem (tentativa ou execução). */
  mcapUsd: number | null;
  /** Onde executou: 'jupiter' | 'pumpportal' | 'paper' (null = falhou antes). */
  venue: string | null;
  txSig: string | null;
  ok: boolean;
  error?: string;
}

export function recordOrder(db: Db, o: OrderRecord): void {
  db.prepare(
    `INSERT INTO orders (position_id, ts, mode, side, mint, sol_amount, token_amount, price_usd, mcap_usd, venue, tx_sig, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.positionId,
    o.ts,
    o.mode,
    o.side,
    o.mint,
    o.solAmount,
    o.tokenAmount,
    o.priceUsd,
    o.mcapUsd,
    o.venue,
    o.txSig,
    o.ok ? 1 : 0,
    o.error ?? null,
  );
}

// ─────────────────────────────────────────────────────────────
//  token_log (cooldown + última avaliação de risco)
// ─────────────────────────────────────────────────────────────

export function upsertTokenLog(
  db: Db,
  mint: string,
  symbol: string,
  riskScore: number | null,
  verdict: string | null,
  flagsJson: string | null,
  cooldownUntil: number,
  nowTs: number,
): void {
  db.prepare(
    `INSERT INTO token_log (mint, symbol, first_seen_ts, last_eval_ts, risk_score, verdict, flags_json, cooldown_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol,
                                     last_eval_ts = excluded.last_eval_ts,
                                     risk_score = excluded.risk_score,
                                     verdict = excluded.verdict,
                                     flags_json = excluded.flags_json,
                                     cooldown_until = excluded.cooldown_until`,
  ).run(mint, symbol, nowTs, nowTs, riskScore, verdict, flagsJson, cooldownUntil);
}

/**
 * Re-arma só o cooldown de um token, sem sobrescrever a última avaliação.
 * Chamado ao FECHAR uma posição: o cooldown gravado na entrada expira durante
 * o hold, e sem este re-arme uma saída por tempo máximo/trailing seria seguida
 * de recompra do mesmo token no MESMO tick (o token continua trending).
 */
export function setTokenCooldown(
  db: Db,
  mint: string,
  symbol: string,
  cooldownUntil: number,
  nowTs: number,
): void {
  db.prepare(
    `INSERT INTO token_log (mint, symbol, first_seen_ts, last_eval_ts, cooldown_until)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET cooldown_until = MAX(cooldown_until, excluded.cooldown_until)`,
  ).run(mint, symbol, nowTs, nowTs, cooldownUntil);
}

export function isOnCooldown(db: Db, mint: string, nowTs: number): boolean {
  const row = db.prepare('SELECT cooldown_until FROM token_log WHERE mint = ?').get(mint) as
    | { cooldown_until: number }
    | undefined;
  return row !== undefined && row.cooldown_until > nowTs;
}

// ─────────────────────────────────────────────────────────────
//  Estatística diária (sustenta o circuit breaker de perda)
// ─────────────────────────────────────────────────────────────

/** Dia UTC de um timestamp em segundos: "2026-08-19". */
export function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function bumpDailyStats(db: Db, ts: number, pnlSol: number, pnlUsd: number): void {
  const day = dayKey(ts);
  db.prepare(
    `INSERT INTO daily_stats (day, realized_pnl_sol, realized_pnl_usd, trades, wins, losses)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(day) DO UPDATE SET realized_pnl_sol = realized_pnl_sol + excluded.realized_pnl_sol,
                                    realized_pnl_usd = realized_pnl_usd + excluded.realized_pnl_usd,
                                    trades = trades + 1,
                                    wins = wins + excluded.wins,
                                    losses = losses + excluded.losses`,
  ).run(day, pnlSol, pnlUsd, pnlSol >= 0 ? 1 : 0, pnlSol < 0 ? 1 : 0);
}

export interface DailyStats {
  day: string;
  realizedPnlSol: number;
  realizedPnlUsd: number;
  trades: number;
  wins: number;
  losses: number;
}

export function getDailyStats(db: Db, ts: number): DailyStats {
  const day = dayKey(ts);
  const row = db.prepare('SELECT * FROM daily_stats WHERE day = ?').get(day) as
    | {
        day: string;
        realized_pnl_sol: number;
        realized_pnl_usd: number;
        trades: number;
        wins: number;
        losses: number;
      }
    | undefined;
  return row
    ? {
        day: row.day,
        realizedPnlSol: row.realized_pnl_sol,
        realizedPnlUsd: row.realized_pnl_usd,
        trades: row.trades,
        wins: row.wins,
        losses: row.losses,
      }
    : { day, realizedPnlSol: 0, realizedPnlUsd: 0, trades: 0, wins: 0, losses: 0 };
}

// ─────────────────────────────────────────────────────────────
//  decisions — o funil gravado, para o replay calibrar com número
// ─────────────────────────────────────────────────────────────

/** Onde o funil parou para este candidato. */
export type DecisionStage = 'comprado' | 'risco' | 'ia' | 'capacidade';

export interface Decision {
  id: number;
  ts: number;
  mode: TradeMode;
  mint: string;
  symbol: string;
  stage: DecisionStage;
  /** Motivo humano: flags do risco, motivo da IA, "sem tamanho viável"... */
  outcome: string;
  entryScore: number;
  riskScore: number | null;
  aiDecision: string | null;
  aiConfidence: number | null;
  priceUsd: number;
  /** Hash do config vigente (entry/risk/ai) — replay agrupa por era de config. */
  configHash: string;
  /** PairSnapshot completo na hora da decisão (JSON). */
  snapshotJson: string;
}

export function recordDecision(db: Db, d: Omit<Decision, 'id'>): void {
  db.prepare(
    `INSERT INTO decisions (ts, mode, mint, symbol, stage, outcome, entry_score, risk_score,
       ai_decision, ai_confidence, price_usd, config_hash, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.ts,
    d.mode,
    d.mint,
    d.symbol,
    d.stage,
    d.outcome,
    d.entryScore,
    d.riskScore,
    d.aiDecision,
    d.aiConfidence,
    d.priceUsd,
    d.configHash,
    d.snapshotJson,
  );
}

interface DecisionRow {
  id: number;
  ts: number;
  mode: string;
  mint: string;
  symbol: string;
  stage: string;
  outcome: string;
  entry_score: number;
  risk_score: number | null;
  ai_decision: string | null;
  ai_confidence: number | null;
  price_usd: number;
  config_hash: string;
  snapshot_json: string;
}

export function listDecisions(
  db: Db,
  mode: TradeMode,
  sinceTs: number,
  stage?: DecisionStage,
): Decision[] {
  const rows = (
    stage
      ? db
          .prepare(
            'SELECT * FROM decisions WHERE mode = ? AND ts >= ? AND stage = ? ORDER BY ts DESC',
          )
          .all(mode, sinceTs, stage)
      : db.prepare('SELECT * FROM decisions WHERE mode = ? AND ts >= ? ORDER BY ts DESC').all(mode, sinceTs)
  ) as DecisionRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    mode: r.mode as TradeMode,
    mint: r.mint,
    symbol: r.symbol,
    stage: r.stage as DecisionStage,
    outcome: r.outcome,
    entryScore: r.entry_score,
    riskScore: r.risk_score,
    aiDecision: r.ai_decision,
    aiConfidence: r.ai_confidence,
    priceUsd: r.price_usd,
    configHash: r.config_hash,
    snapshotJson: r.snapshot_json,
  }));
}
