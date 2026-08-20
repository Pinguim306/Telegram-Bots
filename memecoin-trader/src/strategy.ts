import type { EntryConfig, ExitConfig } from './config.js';
import type { PairSnapshot } from './types.js';

/**
 * Estratégia de entrada e saída — pura, sem I/O, toda testável offline.
 *
 * Entrada: gates (filtros duros de qualidade de mercado) + score ponderado de
 * sinais de momentum. Gate reprova sozinho; score precisa somar `minScore`.
 *
 * Saída: regras avaliadas em ordem de urgência — proteção de capital primeiro
 * (dreno de liquidez, stop loss), realização de lucro depois, faxina por último.
 */

// ─────────────────────────────────────────────────────────────
//  Entrada
// ─────────────────────────────────────────────────────────────

export interface EntryResult {
  eligible: boolean;
  /** Motivo da reprovação no gate — vai para o log, é o que calibra os filtros. */
  rejection?: string;
  score: number;
  reasons: string[];
}

export function evaluateEntry(
  snap: PairSnapshot,
  sources: string[],
  cfg: EntryConfig,
): EntryResult {
  const rejection = checkGates(snap, cfg);
  if (rejection) return { eligible: false, rejection, score: 0, reasons: [] };

  let score = 0;
  const reasons: string[] = [];

  const txns1h = snap.buys1h + snap.sells1h;
  const buyRatio1h = txns1h > 0 ? snap.buys1h / txns1h : 0;

  // Volume da última hora contra a média horária das 23 horas ANTERIORES.
  // Comparar contra uma base que contém a própria janela dilui o pico — um token
  // que fez todo o volume na última hora pareceria "normal".
  const baselinePerHour = Math.max(0, snap.vol24hUsd - snap.vol1hUsd) / 23;
  const volumeMultiple =
    baselinePerHour > 0 ? snap.vol1hUsd / baselinePerHour : snap.vol1hUsd > 0 ? 999 : 0;

  const turnover =
    snap.liquidityUsd !== null && snap.liquidityUsd > 0 ? snap.vol24hUsd / snap.liquidityUsd : 0;

  for (const rule of cfg.rules) {
    const p = rule.params;
    let passed = false;
    switch (rule.id) {
      case 'momentum_5m':
        passed = snap.change5mPct >= (p.minPct ?? 1.5);
        break;
      case 'momentum_1h':
        passed = snap.change1hPct >= (p.minPct ?? 5);
        break;
      case 'volume_spike':
        passed = volumeMultiple >= (p.minMultiple ?? 3);
        break;
      case 'buy_pressure':
        passed = buyRatio1h >= (p.minRatio ?? 0.6) && snap.buys1h >= (p.minBuys ?? 30);
        break;
      case 'turnover':
        passed = turnover >= (p.minRatio ?? 2);
        break;
      case 'trending':
        passed = sources.includes('gt-trending');
        break;
    }
    if (passed) {
      score += rule.points;
      reasons.push(rule.label);
    }
  }

  return { eligible: true, score, reasons };
}

/** true = o par é de bonding curve (sem pool clássico, sem `liquidity` reportada). */
export function isCurvePair(dexId: string, cfg: EntryConfig): boolean {
  return cfg.gates.curveDexIds.includes(dexId);
}

function checkGates(snap: PairSnapshot, cfg: EntryConfig): string | null {
  const g = cfg.gates;
  if (snap.priceUsd <= 0) return 'sem preço';
  if (g.allowedDexIds.length > 0 && !g.allowedDexIds.includes(snap.dexId)) {
    return `dex ${snap.dexId} fora de allowedDexIds`;
  }

  const curve = isCurvePair(snap.dexId, cfg);
  if (!curve) {
    // Na ENTRADA, liquidez desconhecida reprova (conservador): não se compra o
    // que não se sabe se dá para vender. Na SAÍDA a regra é a oposta — ver evaluateExit.
    if (snap.liquidityUsd === null) return 'liquidez desconhecida';
    if (snap.liquidityUsd < g.minLiquidityUsd) {
      return `liquidez $${snap.liquidityUsd.toFixed(0)} < $${g.minLiquidityUsd}`;
    }
    if (g.maxLiquidityUsd > 0 && snap.liquidityUsd > g.maxLiquidityUsd) {
      return `liquidez $${snap.liquidityUsd.toFixed(0)} > $${g.maxLiquidityUsd}`;
    }
  }
  // Na curve não há gate de liquidez: o DexScreener não reporta `liquidity`
  // para o par da curve (estrutural). A venda de volta na curve é garantida
  // pelo programa; o piso de qualidade vira o minMarketCapUsd abaixo.
  if (snap.vol1hUsd < g.minVolume1hUsd) {
    return `volume 1h $${snap.vol1hUsd.toFixed(0)} < $${g.minVolume1hUsd}`;
  }
  // Idade desconhecida não reprova: rejeitar por não saber silenciaria tokens
  // legítimos que o indexador ainda não datou. As DEMAIS defesas continuam valendo.
  if (snap.ageMin !== null) {
    if (snap.ageMin < g.minAgeMin) {
      return `idade ${snap.ageMin.toFixed(0)}min < ${g.minAgeMin}min`;
    }
    if (g.maxAgeHours > 0 && snap.ageMin > g.maxAgeHours * 60) {
      return `idade ${(snap.ageMin / 60).toFixed(0)}h > ${g.maxAgeHours}h`;
    }
  }
  const txns1h = snap.buys1h + snap.sells1h;
  if (txns1h < g.minTxns1h) return `txns 1h ${txns1h} < ${g.minTxns1h}`;
  const buyRatio = txns1h > 0 ? snap.buys1h / txns1h : 0;
  if (buyRatio < g.minBuyRatio1h) {
    return `buy ratio 1h ${(buyRatio * 100).toFixed(0)}% < ${(g.minBuyRatio1h * 100).toFixed(0)}%`;
  }
  const mcap = snap.marketCapUsd ?? snap.fdvUsd;
  if (g.minMarketCapUsd > 0) {
    // Piso duro na curve: sem mcap conhecido ou abaixo do piso é recém-mintado —
    // o terreno de sniper/bundler onde momentum de 5min ainda é só o deployer.
    if (mcap === null) {
      if (curve) return 'market cap desconhecido';
    } else if (mcap < g.minMarketCapUsd) {
      return `market cap $${mcap.toFixed(0)} < $${g.minMarketCapUsd}`;
    }
  }
  if (g.maxMarketCapUsd > 0 && mcap !== null && mcap > g.maxMarketCapUsd) {
    return `market cap $${mcap.toFixed(0)} > $${g.maxMarketCapUsd}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Saída
// ─────────────────────────────────────────────────────────────

/** O que o avaliador de saída precisa saber de uma posição aberta. */
export interface ExitContext {
  entryPriceUsd: number;
  /** Maior preço visto desde a entrada (sustenta o trailing stop). */
  peakPriceUsd: number;
  entryLiquidityUsd: number;
  entryTs: number;
  tookProfit: boolean;
  /** Ticks seguidos sem dado de preço, ANTES deste tick. */
  staleTicks: number;
}

export type ExitDecision =
  | { action: 'hold' }
  | { action: 'sell'; portionPct: number; reason: string; urgent: boolean };

export function evaluateExit(
  ctx: ExitContext,
  snap: PairSnapshot | null,
  cfg: ExitConfig,
  nowTs: number,
): ExitDecision {
  // Sem dado de preço: espera alguns ticks (indexador pisca), depois desiste.
  // Token que SOME do indexador costuma ser pool drenado — segurar é pior.
  if (!snap) {
    if (ctx.staleTicks + 1 >= cfg.staleTicksToExit) {
      return { action: 'sell', portionPct: 100, reason: 'sem dados de preço', urgent: true };
    }
    return { action: 'hold' };
  }

  const pnlPct = ctx.entryPriceUsd > 0 ? (snap.priceUsd / ctx.entryPriceUsd - 1) * 100 : 0;
  const peak = Math.max(ctx.peakPriceUsd, snap.priceUsd);
  const peakPnlPct = ctx.entryPriceUsd > 0 ? (peak / ctx.entryPriceUsd - 1) * 100 : 0;

  // 1. Liquidez drenando = rug em andamento. Sai antes de qualquer conta de lucro.
  // liquidityUsd null = o indexador não informou NESTA resposta — desconhecido
  // não dispara venda de emergência (stop loss e stale-exit seguem protegendo);
  // já um ZERO lido de verdade é pool vazio e dispara.
  if (
    snap.liquidityUsd !== null &&
    ctx.entryLiquidityUsd > 0 &&
    snap.liquidityUsd < ctx.entryLiquidityUsd * (cfg.liquidityDrainPct / 100)
  ) {
    return {
      action: 'sell',
      portionPct: 100,
      reason: `liquidez caiu para ${((snap.liquidityUsd / ctx.entryLiquidityUsd) * 100).toFixed(0)}% da entrada`,
      urgent: true,
    };
  }

  // 2. Stop loss.
  if (pnlPct <= -cfg.stopLossPct) {
    return { action: 'sell', portionPct: 100, reason: `stop loss (${pnlPct.toFixed(1)}%)`, urgent: true };
  }

  // 3. Trailing stop — só arma depois que o lucro passou do gatilho de ativação.
  if (peakPnlPct >= cfg.trailingActivatePct) {
    const drawdownPct = peak > 0 ? (1 - snap.priceUsd / peak) * 100 : 0;
    if (drawdownPct >= cfg.trailingStopPct) {
      return {
        action: 'sell',
        portionPct: 100,
        reason: `trailing stop (${drawdownPct.toFixed(1)}% do topo, pnl ${pnlPct.toFixed(1)}%)`,
        urgent: false,
      };
    }
  }

  // 4. Take profit parcial — realiza uma vez e deixa o resto correr no trailing.
  if (!ctx.tookProfit && pnlPct >= cfg.takeProfitPct) {
    return {
      action: 'sell',
      portionPct: cfg.takeProfitSellPct,
      reason: `take profit (${pnlPct.toFixed(1)}%)`,
      urgent: false,
    };
  }

  // 5. Tempo máximo de posição: memecoin sem tese não é investimento de longo prazo.
  if ((nowTs - ctx.entryTs) / 60 >= cfg.maxHoldMin) {
    return {
      action: 'sell',
      portionPct: 100,
      reason: `tempo máximo (${cfg.maxHoldMin}min, pnl ${pnlPct.toFixed(1)}%)`,
      urgent: false,
    };
  }

  return { action: 'hold' };
}
