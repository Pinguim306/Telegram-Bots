import { fetchJson } from './http.js';
import type { GtNetwork } from './datasources/geckoterminal.js';
import type { TraderConfig } from './config.js';

/**
 * Replay: reexecuta as regras de SAÍDA sobre as velas reais (OHLCV por minuto
 * do GeckoTerminal) a partir de cada decisão gravada no funil. Responde a
 * pergunta que calibração nenhuma responde sem dado: "os tokens que o risco ou
 * a IA reprovaram teriam dado lucro se comprados?".
 *
 * Limites assumidos e declarados:
 *  - Simula stop, trailing, take profit parcial e tempo máximo — as saídas de
 *    liquidez/token-morto precisam de volume por tick, que a vela não tem.
 *  - O stop executa no PREÇO NOMINAL do stop. Medido em produção o stop
 *    executa ~2x pior — os números daqui são o teto OTIMISTA do que a compra
 *    teria rendido; se nem o teto dá lucro, a reprovação estava certa.
 *  - Dentro de uma mesma vela a ordem dos eventos é desconhecida: o simulador
 *    processa o PIOR caso primeiro (stop antes de trailing antes de alvo).
 */

/** Vela OHLC por minuto (ts em segundos, ordem crescente). */
export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface SimResult {
  /** PnL % combinado da posição inteira (venda parcial ponderada). */
  pnlPct: number;
  exitReason: string;
  holdMin: number;
}

/** Simula as regras de saída sobre velas. Pura — exportada para teste. */
export function simulateExit(
  candles: Candle[],
  entryTs: number,
  entryPriceUsd: number,
  exit: TraderConfig['exit'],
): SimResult | null {
  const path = candles.filter((c) => c.ts >= entryTs);
  if (path.length === 0 || entryPriceUsd <= 0) return null;

  const stopPrice = entryPriceUsd * (1 - exit.stopLossPct / 100);
  const tpPrice = entryPriceUsd * (1 + exit.takeProfitPct / 100);
  const activatePrice = entryPriceUsd * (1 + exit.trailingActivatePct / 100);
  const deadlineTs = entryTs + exit.maxHoldMin * 60;

  let remaining = 1;
  let realizedPct = 0; // soma ponderada do que já saiu
  let tookProfit = false;
  let peak = entryPriceUsd;

  const holdMin = (ts: number): number => Math.max(0, (ts - entryTs) / 60);
  const finish = (portionExitPrice: number, reason: string, ts: number): SimResult => {
    const exitPct = (portionExitPrice / entryPriceUsd - 1) * 100;
    return { pnlPct: realizedPct + remaining * exitPct, exitReason: reason, holdMin: holdMin(ts) };
  };

  for (const candle of path) {
    if (candle.ts >= deadlineTs) return finish(candle.o, 'tempo máximo', candle.ts);

    // PIOR caso primeiro: o fundo da vela pode ter vindo antes do topo.
    if (candle.l <= stopPrice) return finish(stopPrice, 'stop loss', candle.ts);

    // Trailing sobre o pico das velas ANTERIORES — o pico desta vela pode ter
    // acontecido depois do fundo dela, e assumir o contrário infla o resultado.
    if (peak >= activatePrice) {
      const trailPrice = peak * (1 - exit.trailingStopPct / 100);
      if (candle.l <= trailPrice) return finish(trailPrice, 'trailing stop', candle.ts);
    }

    if (!tookProfit && candle.h >= tpPrice) {
      const portion = exit.takeProfitSellPct / 100;
      realizedPct += portion * exit.takeProfitPct;
      remaining -= portion;
      tookProfit = true;
      if (remaining <= 0.0001) {
        return { pnlPct: realizedPct, exitReason: 'take profit', holdMin: holdMin(candle.ts) };
      }
    }

    peak = Math.max(peak, candle.h);
  }

  const last = path[path.length - 1]!;
  return finish(last.c, 'fim dos dados', last.ts);
}

const GT_BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * Velas de minuto de um pool a partir de `sinceTs`. O endpoint devolve velas
 * ANTES de before_timestamp — pedimos a janela [sinceTs, sinceTs + limit min].
 * Pool novo demais/removido devolve null (o chamador conta como "sem dados").
 */
export async function fetchMinuteCandles(
  network: GtNetwork,
  poolAddress: string,
  sinceTs: number,
  limitMin = 120,
): Promise<Candle[] | null> {
  try {
    const before = sinceTs + limitMin * 60;
    const json = (await fetchJson(
      `${GT_BASE}/networks/${network}/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute` +
        `?aggregate=1&limit=${limitMin}&currency=usd&before_timestamp=${before}`,
      { headers: { accept: 'application/json;version=20230302' } },
    )) as Record<string, any> | null;
    const list: unknown = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return null;
    const candles: Candle[] = [];
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const [ts, o, h, l, c] = row as number[];
      if (![ts, o, h, l, c].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      candles.push({ ts: ts!, o: o!, h: h!, l: l!, c: c! });
    }
    candles.sort((a, b) => a.ts - b.ts);
    return candles.length > 0 ? candles : null;
  } catch {
    return null;
  }
}
