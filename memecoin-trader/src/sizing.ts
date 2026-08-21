import type { SizingConfig } from './config.js';

/**
 * Dimensionamento de posição e circuit breakers — puro, sem I/O.
 *
 * A pergunta que este módulo responde não é "quanto dá para ganhar", é
 * "quanto dá para perder sem quebrar a banca". Memecoin tem taxa alta de -100%;
 * o sizing é o que transforma isso de ruína em custo operacional.
 */

export interface SizingInput {
  balanceSol: number;
  openPositions: number;
  /** PnL realizado no dia UTC corrente (negativo = perdendo). */
  dailyRealizedPnlSol: number;
  /**
   * PnL NÃO-realizado das posições abertas (marca executável). Só a parte
   * NEGATIVA conta no breaker: buraco aberto é perda para a trava diária —
   * no dia analisado, uma posição afundando -0,34 SOL "não existia" para o
   * breaker até a venda sair, e o bot seguiu abrindo posições novas. Lucro
   * não-realizado NÃO destrava compras (pode evaporar num candle).
   */
  openUnrealizedSol?: number;
  /** Score de risco 0–100 do token que se quer comprar. */
  riskScore: number;
}

/** Motivo pelo qual NÃO se pode abrir posição agora, ou null se pode. */
export function blockReason(input: SizingInput, cfg: SizingConfig): string | null {
  if (input.openPositions >= cfg.maxOpenPositions) {
    return `já existem ${input.openPositions}/${cfg.maxOpenPositions} posições abertas`;
  }
  const effectiveLoss = input.dailyRealizedPnlSol + Math.min(0, input.openUnrealizedSol ?? 0);
  if (cfg.maxDailyLossSol > 0 && effectiveLoss <= -cfg.maxDailyLossSol) {
    return `perda diária de ${effectiveLoss.toFixed(3)} SOL (realizada ${input.dailyRealizedPnlSol.toFixed(3)} + aberta) atingiu o limite de ${cfg.maxDailyLossSol} SOL — sem novas compras até o dia (UTC) virar`;
  }
  const available = input.balanceSol - cfg.reserveSol;
  if (available < cfg.minPositionSol) {
    return `saldo disponível ${available.toFixed(4)} SOL (reserva de ${cfg.reserveSol}) abaixo da posição mínima de ${cfg.minPositionSol}`;
  }
  return null;
}

/**
 * Tamanho da posição em SOL, ou null quando não cabe uma posição mínima.
 *
 * Base: % do saldo, com teto absoluto. Com `riskScaling`, o tamanho encolhe
 * linearmente com o score de risco (score 0 = 100% do tamanho; score no teto
 * aprovável ~40 = ~60% do tamanho) — token mais arriscado, aposta menor.
 */
export function positionSizeSol(input: SizingInput, cfg: SizingConfig): number | null {
  if (blockReason(input, cfg)) return null;

  const available = input.balanceSol - cfg.reserveSol;
  let size = Math.min(
    cfg.maxPositionSol > 0 ? cfg.maxPositionSol : Number.POSITIVE_INFINITY,
    input.balanceSol * (cfg.positionPctOfBalance / 100),
    available,
  );

  if (cfg.riskScaling) {
    const factor = Math.max(0.25, 1 - input.riskScore / 100);
    size *= factor;
  }

  if (size < cfg.minPositionSol) return null;
  return size;
}
