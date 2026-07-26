import type { SignalsConfig } from '../../config/schema.js';
import { baselineVolumePerSec, priceChangePct, type WindowStats } from './metrics.js';

export interface SignalInput {
  /**
   * Idade do pool em segundos, ou null quando não foi possível determinar.
   *
   * null NÃO é zero. Tratar desconhecido como "recém-nascido" faria todo token
   * antigo parecer um launch a cada restart do bot, e a regra `fresh_launch`
   * distribuiria pontos para quem não merece.
   */
  ageSec: number | null;
  liquidityUsd: number;
  /** Market cap a preço spot, ou null quando o supply não é legível. */
  marketCapUsd: number | null;
  short: WindowStats;
  medium: WindowStats;
  long: WindowStats;
}

export interface SignalResult {
  eligible: boolean;
  /** Motivo da inelegibilidade — vai para o log, ajuda a calibrar os filtros. */
  rejection?: string;
  score: number;
  reasons: string[];
  /** Quantas vezes o volume da janela curta supera a linha de base. */
  volumeMultiple: number;
  buyRatio: number;
  priceChangeShortPct: number;
  priceChangeLongPct: number;
  netUsd: number;
}

/** Teto para o múltiplo de volume: token sem histórico daria divisão por zero. */
const MAX_MULTIPLE = 999;

export function evaluateSignal(input: SignalInput, cfg: SignalsConfig): SignalResult {
  const { short, medium, long } = input;
  const trades = short.buys + short.sells;
  const buyRatio = trades > 0 ? short.buys / trades : 0;
  const netUsd = short.buyVolumeUsd - short.sellVolumeUsd;
  const priceChangeShortPct = priceChangePct(short);
  const priceChangeLongPct = priceChangePct(long);

  const baseline = baselineVolumePerSec(short, long);
  const shortRate = short.windowSec > 0 ? short.volumeUsd / short.windowSec : 0;
  const volumeMultiple =
    baseline > 0 ? Math.min(MAX_MULTIPLE, shortRate / baseline) : shortRate > 0 ? MAX_MULTIPLE : 0;

  const base: Omit<SignalResult, 'eligible' | 'rejection' | 'score' | 'reasons'> = {
    volumeMultiple,
    buyRatio,
    priceChangeShortPct,
    priceChangeLongPct,
    netUsd,
  };

  const rejection = checkEligibility(input, cfg);
  if (rejection) {
    return { eligible: false, rejection, score: 0, reasons: [], ...base };
  }

  let score = 0;
  const reasons: string[] = [];

  for (const rule of cfg.rules) {
    const p = rule.params;
    let passed = false;

    switch (rule.id) {
      case 'buy_pressure':
        passed = buyRatio >= (p.minBuyRatio ?? 0.7) && short.buys >= (p.minBuys ?? 8);
        break;
      case 'volume_spike':
        passed =
          volumeMultiple >= (p.minMultiple ?? 4) && short.volumeUsd >= (p.minVolumeUsd ?? 1000);
        break;
      case 'unique_buyers':
        passed = short.uniqueBuyers >= (p.minUniqueBuyers ?? 12);
        break;
      case 'price_change':
        passed = priceChangeShortPct >= (p.minPctShort ?? 25);
        break;
      case 'net_inflow':
        passed = netUsd >= (p.minNetUsd ?? 1500);
        break;
      case 'fresh_launch':
        // Idade desconhecida não ganha o bônus — na dúvida, não pontua.
        passed = input.ageSec !== null && input.ageSec <= (p.maxAgeSec ?? 3600);
        break;
    }

    if (passed) {
      score += rule.points;
      reasons.push(rule.label);
    }
  }

  // A janela média entra como confirmação: sinal que só existe em 3 minutos e
  // some em 15 costuma ser wash trade de uma carteira só.
  if (medium.buys > short.buys && medium.uniqueBuyers > short.uniqueBuyers) {
    score += 5;
    reasons.push('Sustentado na janela média');
  }

  return { eligible: true, score, reasons, ...base };
}

function checkEligibility(input: SignalInput, cfg: SignalsConfig): string | null {
  const e = cfg.eligibility;
  const { short } = input;

  if (input.liquidityUsd < e.minLiquidityUsd) {
    return `liquidez ${input.liquidityUsd.toFixed(0)} < ${e.minLiquidityUsd}`;
  }
  // Trava contra alertar blue chip. Sem isso, 20 compras de US$ 600 em USDT viram
  // "sinal" — aconteceu de verdade nos testes contra a Arc. Um canal de sinais de
  // micro cap que alerta stablecoin de US$ 46M perde a razão de existir.
  if (e.maxMarketCapUsd > 0 && input.marketCapUsd !== null && input.marketCapUsd > e.maxMarketCapUsd) {
    return `market cap ${input.marketCapUsd.toFixed(0)} > ${e.maxMarketCapUsd}`;
  }
  // Filtros de idade só se aplicam quando a idade é conhecida. Rejeitar por idade
  // desconhecida silenciaria o bot inteiro sempre que o nó não for archive.
  if (input.ageSec !== null) {
    // Token novo demais ainda não tem preço confiável: os primeiros swaps de um pool
    // recém-criado costumam ser do próprio deployer montando a posição.
    if (input.ageSec < e.minAgeSec) return `idade ${input.ageSec}s < ${e.minAgeSec}s`;
    if (e.maxAgeSec > 0 && input.ageSec > e.maxAgeSec) {
      return `idade ${input.ageSec}s > ${e.maxAgeSec}s`;
    }
  }
  if (short.buys < e.minBuysShort) return `compras ${short.buys} < ${e.minBuysShort}`;
  if (short.volumeUsd < e.minVolumeUsdShort) {
    return `volume ${short.volumeUsd.toFixed(0)} < ${e.minVolumeUsdShort}`;
  }
  if (short.uniqueBuyers < e.minUniqueBuyersShort) {
    return `compradores ${short.uniqueBuyers} < ${e.minUniqueBuyersShort}`;
  }
  return null;
}

/**
 * Decide se o alerta pode sair, considerando o histórico.
 *
 * Regra: um token não repete alerta dentro do cooldown, A NÃO SER que o score
 * tenha subido bastante — nesse caso é informação nova de verdade (o move
 * acelerou), não repetição.
 */
export function shouldAlert(
  result: SignalResult,
  cfg: SignalsConfig,
  previous: { ts: number; score: number } | null,
  nowTs: number,
): boolean {
  if (!result.eligible || result.score < cfg.minScore) return false;
  if (!previous) return true;
  const elapsed = nowTs - previous.ts;
  if (elapsed >= cfg.cooldownSec) return true;
  return result.score - previous.score >= cfg.reAlertScoreDelta;
}
