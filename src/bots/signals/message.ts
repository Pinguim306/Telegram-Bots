import {
  age,
  emojiBlock,
  escapeHtml,
  pct,
  price,
  sanitizeTokenText,
  usd,
} from '../../core/format.js';
import type { PoolLiquidity } from '../../core/pools.js';
import type { AlertPayload } from '../../core/publisher.js';
import type { BuiltLink } from '../../core/referrals.js';
import type { WindowStats } from './metrics.js';
import type { SignalResult } from './rules.js';

export interface SignalAlertData {
  networkName: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  poolAddress: string;
  dexLabel: string;
  quoteSymbol: string;
  priceUsd: number;
  marketCapUsd: number | null;
  liquidity: PoolLiquidity;
  /** null = não foi possível determinar a idade do pool. */
  ageSec: number | null;
  short: WindowStats;
  medium: WindowStats;
  long: WindowStats;
  result: SignalResult;
  explorerTokenUrl?: string;
  links: BuiltLink[];
  footer?: string | null;
}

/**
 * Alerta de sinal, no espírito do print de referência: bloco visual no topo para
 * o olho pegar a intensidade em meio segundo, e os números logo abaixo.
 *
 * A ordem é deliberada — preço/variação primeiro, contexto depois, aviso por último.
 * Quem lê o canal no celular decide nos dois primeiros segundos.
 */
export function renderSignalAlert(data: SignalAlertData): AlertPayload {
  const symbol = sanitizeTokenText(data.tokenSymbol, 16);
  const name = sanitizeTokenText(data.tokenName, 40);
  const { short, long, result } = data;

  const lines: string[] = [];

  lines.push(`${intensityEmoji(result.score)} <b>SINAL</b> — ${escapeHtml(data.networkName)}`);

  // Uma "célula" por compra, com teto: o bloco mostra intensidade, não contagem exata.
  const block = emojiBlock(short.buys, '🟩', 20, 60);
  if (block) lines.push(block);

  lines.push(
    `<b>Últimos ${Math.round(short.windowSec / 60)} min:</b> ${usd(short.buyVolumeUsd)} em ${short.buys} compras`,
  );
  lines.push('');
  lines.push(`<b>${name}</b> (${symbol})`);
  lines.push(`<code>${escapeHtml(data.tokenAddress)}</code>`);
  lines.push('');

  lines.push(
    `💵 <b>$${price(data.priceUsd)}</b> (${pct(result.priceChangeShortPct)} em ${Math.round(short.windowSec / 60)}m)`,
  );
  if (data.marketCapUsd !== null) {
    const idade = data.ageSec !== null ? age(data.ageSec) : 'idade desconhecida';
    lines.push(`🏦 MCap: <b>${usd(data.marketCapUsd)}</b> · ⏳ ${idade}`);
  }
  lines.push(
    `💧 Liquidez de saída: ${usd(data.liquidity.quoteUsd)} · 🏭 ${escapeHtml(data.dexLabel)}`,
  );
  lines.push(
    `📊 Vol ${Math.round(long.windowSec / 60)}m: ${usd(long.volumeUsd)} · ${pct(result.priceChangeLongPct)}`,
  );
  lines.push(`🅑 ${short.buys} compras · 🅢 ${short.sells} vendas · 👤 ${short.uniqueBuyers} carteiras`);
  lines.push(`💸 Fluxo líquido: <b>${usd(result.netUsd)}</b>`);
  lines.push(`🚀 Volume: ${describeMultiple(result.volumeMultiple)}`);
  lines.push('');

  lines.push(`⭐ <b>Score ${Math.round(result.score)}</b> — ${escapeHtml(result.reasons.join(', '))}`);

  if (data.explorerTokenUrl) {
    lines.push('');
    lines.push(`🔎 <a href="${data.explorerTokenUrl}">Ver no explorer</a>`);
  }

  if (data.footer) {
    lines.push('');
    lines.push(data.footer);
  }

  lines.push('');
  lines.push('<i>Alerta automático. Não é recomendação de investimento — DYOR.</i>');

  return {
    text: lines.join('\n'),
    buttons: buildButtons(data.links),
    // Inclui o minuto: o mesmo token pode alertar de novo mais tarde,
    // mas nunca duas vezes no mesmo minuto por corrida entre ticks.
    dedupeKey: `signal:${data.tokenAddress}:${Math.floor(Date.now() / 60_000)}`,
  };
}

function buildButtons(links: BuiltLink[]): Array<Array<{ label: string; url: string }>> {
  const ordered = [...links].sort((a, b) => rank(a.kind) - rank(b.kind));
  const rows: Array<Array<{ label: string; url: string }>> = [];
  for (let i = 0; i < ordered.length; i += 3) {
    rows.push(ordered.slice(i, i + 3).map((l) => ({ label: l.label, url: l.url })));
  }
  return rows;
}

function rank(kind: BuiltLink['kind']): number {
  return { trade: 0, chart: 1, cex: 2, explorer: 3, other: 4 }[kind];
}

function intensityEmoji(score: number): string {
  if (score >= 90) return '🔥🔥🔥';
  if (score >= 75) return '🔥🔥';
  return '🔥';
}

/**
 * Descreve o múltiplo de volume com a direção correta.
 *
 * Um múltiplo de 0,3 significa volume ABAIXO da média — escrever "0.3x acima da
 * média" é dizer o contrário do que o número mostra, no meio de um alerta em que
 * a pessoa tem dois segundos para decidir.
 */
function describeMultiple(multiple: number): string {
  if (!Number.isFinite(multiple) || multiple <= 0) return 'sem histórico para comparar';
  if (multiple >= 999) return 'sem volume prévio (>999x)';
  if (multiple >= 1) return `${fmt(multiple)}x acima da média`;
  // 0,3x da média = 3,3x abaixo dela. Inverte para não pedir divisão mental.
  return `${fmt(1 / multiple)}x abaixo da média`;
}

function fmt(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1);
}
