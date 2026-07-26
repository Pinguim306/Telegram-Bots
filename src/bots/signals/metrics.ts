import type { Db } from '../../core/db.js';

export interface WindowStats {
  windowSec: number;
  buys: number;
  sells: number;
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  firstPriceUsd: number | null;
  lastPriceUsd: number | null;
}

export const EMPTY_WINDOW = (windowSec: number): WindowStats => ({
  windowSec,
  buys: 0,
  sells: 0,
  volumeUsd: 0,
  buyVolumeUsd: 0,
  sellVolumeUsd: 0,
  uniqueBuyers: 0,
  uniqueSellers: 0,
  firstPriceUsd: null,
  lastPriceUsd: null,
});

interface AggRow {
  buys: number | null;
  sells: number | null;
  volume: number | null;
  buy_volume: number | null;
  sell_volume: number | null;
  unique_buyers: number | null;
  unique_sellers: number | null;
}

/**
 * Agrega os trades de um token numa janela.
 *
 * Tudo em SQL de propósito: puxar milhares de linhas para o Node e somar em JS
 * é a diferença entre o bot acompanhar a chain e ficar para trás no pico de volume,
 * que é exatamente quando o sinal vale alguma coisa.
 */
export function windowStats(db: Db, token: string, nowTs: number, windowSec: number): WindowStats {
  const since = nowTs - windowSec;

  const agg = db
    .prepare(
      `SELECT
         SUM(CASE WHEN side = 'buy'  THEN 1 ELSE 0 END)      AS buys,
         SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END)      AS sells,
         SUM(usd)                                            AS volume,
         SUM(CASE WHEN side = 'buy'  THEN usd ELSE 0 END)    AS buy_volume,
         SUM(CASE WHEN side = 'sell' THEN usd ELSE 0 END)    AS sell_volume,
         COUNT(DISTINCT CASE WHEN side = 'buy'  THEN trader END) AS unique_buyers,
         COUNT(DISTINCT CASE WHEN side = 'sell' THEN trader END) AS unique_sellers
       FROM trades
       WHERE token = ? AND ts >= ?`,
    )
    .get(token, since) as AggRow | undefined;

  const first = db
    .prepare('SELECT price_usd FROM trades WHERE token = ? AND ts >= ? ORDER BY ts ASC, id ASC LIMIT 1')
    .get(token, since) as { price_usd: number } | undefined;
  const last = db
    .prepare('SELECT price_usd FROM trades WHERE token = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1')
    .get(token, since) as { price_usd: number } | undefined;

  return {
    windowSec,
    buys: agg?.buys ?? 0,
    sells: agg?.sells ?? 0,
    volumeUsd: agg?.volume ?? 0,
    buyVolumeUsd: agg?.buy_volume ?? 0,
    sellVolumeUsd: agg?.sell_volume ?? 0,
    uniqueBuyers: agg?.unique_buyers ?? 0,
    uniqueSellers: agg?.unique_sellers ?? 0,
    firstPriceUsd: first?.price_usd ?? null,
    lastPriceUsd: last?.price_usd ?? null,
  };
}

/** Tokens com pelo menos um trade desde `sinceTs` — a lista de candidatos do tick. */
export function activeTokens(db: Db, sinceTs: number): string[] {
  return (
    db
      .prepare('SELECT DISTINCT token FROM trades WHERE ts >= ?')
      .all(sinceTs) as Array<{ token: string }>
  ).map((r) => r.token);
}

/** Variação percentual entre o primeiro e o último preço da janela. */
export function priceChangePct(stats: WindowStats): number {
  if (!stats.firstPriceUsd || !stats.lastPriceUsd || stats.firstPriceUsd <= 0) return 0;
  return ((stats.lastPriceUsd - stats.firstPriceUsd) / stats.firstPriceUsd) * 100;
}

/**
 * Volume por segundo da janela longa EXCLUINDO a janela curta.
 *
 * Comparar a janela curta com uma linha de base que a contém dilui o pico —
 * um token que fez todo o volume nos últimos 3 minutos apareceria como "normal".
 * Tirar a janela curta da base é o que faz o spike aparecer de verdade.
 */
export function baselineVolumePerSec(short: WindowStats, long: WindowStats): number {
  const span = long.windowSec - short.windowSec;
  if (span <= 0) return 0;
  const volume = Math.max(0, long.volumeUsd - short.volumeUsd);
  return volume / span;
}
