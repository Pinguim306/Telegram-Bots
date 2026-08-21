import type { Position } from './db.js';

/**
 * Estatística de trades — pura, sem I/O.
 *
 * Existe porque as decisões de calibração vinham sendo tomadas sobre um único
 * número (win rate) que, sozinho, não diz nada com alvo e stop assimétricos. E
 * porque o dado mais importante do bot já estava gravado e nunca era mostrado:
 * o PEDÁGIO DE ENTRADA (impacto + taxas), medido pela primeira marca executável
 * contra o preço do fill. Se ele for da ordem do alvo de lucro, nenhum ajuste
 * de gate ou de saída salva a estratégia — e é isso que precisa aparecer.
 */

export interface ExitReasonStat {
  reason: string;
  n: number;
  pnlSol: number;
}

export interface TradeStats {
  n: number;
  wins: number;
  losses: number;
  totalPnlSol: number;
  /** PnL médio POR TRADE — o número que decide se a estratégia paga as contas. */
  expectancySol: number;
  winRatePct: number;
  /** Intervalo de confiança 95% (Wilson) da win rate — a régua da amostra. */
  winRateCi95: [number, number];
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Win rate necessária para empatar com o payoff REALIZADO. null = sem os dois lados. */
  breakevenWrPct: number | null;
  medianHoldMin: number | null;
  /**
   * Pedágio de entrada: mediana de (primeira marca executável / preço do fill − 1).
   * Negativo = a posição já nasce valendo menos do que custou. null = nenhuma
   * posição tem marca (é o caso do modo paper, que não cota o agregador).
   */
  entryTollPct: { n: number; medianPct: number } | null;
  byExitReason: ExitReasonStat[];
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
};

/**
 * Intervalo de Wilson (95%) para uma proporção. Exportado para teste.
 * Escolhido em vez do intervalo normal porque não degenera com n pequeno —
 * exatamente o regime em que este bot opera (dezenas de trades).
 */
export function wilsonCi95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 100];
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, (centre - half) * 100), Math.min(100, (centre + half) * 100)];
};

/** Normaliza "take profit (11.2%)" → "take profit" para agrupar. */
export function normalizeExitReason(reason: string | null): string {
  if (!reason) return '?';
  return reason.split('(')[0]!.trim() || '?';
}

export function computeTradeStats(closed: Position[]): TradeStats {
  const n = closed.length;
  const winList = closed.filter((p) => (p.pnlSol ?? 0) > 0);
  const lossList = closed.filter((p) => (p.pnlSol ?? 0) <= 0);
  const totalPnlSol = closed.reduce((a, p) => a + (p.pnlSol ?? 0), 0);

  const avgWinPct = winList.length
    ? winList.reduce((a, p) => a + (p.pnlPct ?? 0), 0) / winList.length
    : null;
  const avgLossPct = lossList.length
    ? lossList.reduce((a, p) => a + (p.pnlPct ?? 0), 0) / lossList.length
    : null;

  // Breakeven pelo payoff em SOL (não em %): é o que de fato paga as contas.
  const avgWinSol = winList.length
    ? winList.reduce((a, p) => a + (p.pnlSol ?? 0), 0) / winList.length
    : null;
  const avgLossSol = lossList.length
    ? Math.abs(lossList.reduce((a, p) => a + (p.pnlSol ?? 0), 0) / lossList.length)
    : null;
  const breakevenWrPct =
    avgWinSol !== null && avgLossSol !== null && avgWinSol + avgLossSol > 0
      ? (avgLossSol / (avgWinSol + avgLossSol)) * 100
      : null;

  const holds = closed
    .filter((p) => p.exitTs !== null)
    .map((p) => (p.exitTs! - p.entryTs) / 60);

  const tolls = closed
    .filter((p) => p.entryMarkPriceUsd !== null && p.entryPriceUsd > 0)
    .map((p) => (p.entryMarkPriceUsd! / p.entryPriceUsd - 1) * 100);
  const tollMedian = median(tolls);

  const grouped = new Map<string, ExitReasonStat>();
  for (const p of closed) {
    const reason = normalizeExitReason(p.exitReason);
    const acc = grouped.get(reason) ?? { reason, n: 0, pnlSol: 0 };
    acc.n++;
    acc.pnlSol += p.pnlSol ?? 0;
    grouped.set(reason, acc);
  }

  return {
    n,
    wins: winList.length,
    losses: lossList.length,
    totalPnlSol,
    expectancySol: n > 0 ? totalPnlSol / n : 0,
    winRatePct: n > 0 ? (winList.length / n) * 100 : 0,
    winRateCi95: wilsonCi95(winList.length, n),
    avgWinPct,
    avgLossPct,
    breakevenWrPct,
    medianHoldMin: median(holds),
    entryTollPct: tollMedian !== null ? { n: tolls.length, medianPct: tollMedian } : null,
    byExitReason: [...grouped.values()].sort((a, b) => a.pnlSol - b.pnlSol),
  };
}

/** Amostra abaixo disto não distingue uma config da outra — só ruído. */
export const MIN_SAMPLE_FOR_DECISION = 100;
