import type { AlertPayload } from '../../core/publisher.js';
import type { BuiltLink } from '../../core/referrals.js';
import { age, escapeHtml, price, sanitizeTokenText, shortAddr, usd } from '../../core/format.js';
import type { PoolLiquidity } from '../../core/pools.js';
import type { TokenRisk } from '../../core/tokens.js';

export interface LaunchAlertData {
  networkName: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  totalSupply: number;
  poolAddress: string;
  poolKind: 'v2' | 'v3';
  dexLabel: string;
  feePct: number | null;
  quoteSymbol: string;
  liquidity: PoolLiquidity;
  priceUsd: number | null;
  marketCapUsd: number | null;
  ageSec: number;
  risk: TokenRisk;
  explorerTokenUrl?: string;
  explorerPoolUrl?: string;
  links: BuiltLink[];
  footer?: string | null;
}

const YES = '✅';
const NO = '❌';

/**
 * Monta o alerta de novo launch.
 *
 * Função pura para ser testável: formatação de preço com 10 zeros à esquerda e
 * nome de token com HTML injetado são exatamente o tipo de coisa que só aparece
 * em produção, às 3 da manhã, no meio de um pump.
 */
export function renderLaunchAlert(data: LaunchAlertData): AlertPayload {
  const symbol = sanitizeTokenText(data.tokenSymbol, 16);
  const name = sanitizeTokenText(data.tokenName, 40);
  const lines: string[] = [];

  lines.push(`🚀 <b>NOVO LAUNCH</b> — ${escapeHtml(data.networkName)}`);
  lines.push('');
  lines.push(`<b>${name}</b> (${symbol})`);
  lines.push(`<code>${escapeHtml(data.tokenAddress)}</code>`);
  lines.push('');

  // Os dois lados aparecem separados de propósito: o número que importa para
  // conseguir SAIR é o lado quote, e num launch novo ele costuma ser perto de zero.
  lines.push(
    `💧 Liquidez de saída (${escapeHtml(data.quoteSymbol)}): <b>${usd(data.liquidity.quoteUsd)}</b>`,
  );
  lines.push(`📦 Tamanho do pool: ${usd(data.liquidity.totalUsd)}`);
  if (data.liquidity.quoteUsd < 100 && data.liquidity.totalUsd > 0) {
    lines.push('⚠️ <b>Pool sem contraparte ainda</b> — dá para comprar, não dá para vender.');
  }
  if (data.priceUsd !== null) lines.push(`💵 Preço: <b>$${price(data.priceUsd)}</b>`);
  if (data.marketCapUsd !== null) lines.push(`🏦 MCap: <b>${usd(data.marketCapUsd)}</b>`);
  lines.push(`🧪 Supply: ${compactSupply(data.totalSupply)} ${symbol}`);
  // `pct()` prefixa sinal (+/−) porque serve para variação. Taxa não tem sinal:
  // "taxa +1.00%" sugere que a taxa subiu 1%, que não é o que o número diz.
  lines.push(
    `🏭 DEX: ${escapeHtml(data.dexLabel)}${data.feePct !== null ? ` · taxa ${data.feePct.toFixed(2)}%` : ''}`,
  );
  lines.push(`🪙 Par: ${symbol}/${escapeHtml(data.quoteSymbol)}`);
  lines.push(`⏱ Idade: ${age(data.ageSec)}`);
  lines.push('');

  lines.push(`${riskEmoji(data.risk.score)} <b>Segurança</b> — risco ${data.risk.score}/100`);
  lines.push(`├ Owner: ${data.risk.renounced ? `renunciado ${YES}` : ownerText(data.risk)}`);
  lines.push(
    `├ Mint: ${flag(data.risk, 'mint')} · Pause: ${flag(data.risk, 'pausable')} · Blacklist: ${flag(data.risk, 'blacklist')}`,
  );
  lines.push(`└ Proxy atualizável: ${flag(data.risk, 'upgradeable')}`);

  const infoLinks: string[] = [];
  if (data.explorerTokenUrl) infoLinks.push(`<a href="${data.explorerTokenUrl}">Token</a>`);
  if (data.explorerPoolUrl) infoLinks.push(`<a href="${data.explorerPoolUrl}">Pool</a>`);
  if (infoLinks.length) {
    lines.push('');
    lines.push(`🔎 ${infoLinks.join(' · ')} · <code>${shortAddr(data.poolAddress)}</code>`);
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
    dedupeKey: `launch:${data.poolAddress}`,
  };
}

export interface NewTokenAlertData {
  networkName: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  totalSupply: number;
  creator?: string | null;
  risk: TokenRisk;
  explorerTokenUrl?: string;
  links: BuiltLink[];
  footer?: string | null;
}

/**
 * Alerta de contrato criado, ainda SEM pool.
 *
 * Desligado por padrão (alertOnNewToken). Serve para quem quer caçar pré-launch e
 * aceita o ruído: a esmagadora maioria dos ERC-20 criados nunca recebe liquidez.
 */
export function renderNewTokenAlert(data: NewTokenAlertData): AlertPayload {
  const symbol = sanitizeTokenText(data.tokenSymbol, 16);
  const name = sanitizeTokenText(data.tokenName, 40);
  const lines: string[] = [];

  lines.push(`🧬 <b>NOVO CONTRATO</b> — ${escapeHtml(data.networkName)}`);
  lines.push('');
  lines.push(`<b>${name}</b> (${symbol})`);
  lines.push(`<code>${escapeHtml(data.tokenAddress)}</code>`);
  lines.push('');
  lines.push(`🧪 Supply: ${compactSupply(data.totalSupply)} ${symbol}`);
  if (data.creator) lines.push(`👤 Criador: <code>${shortAddr(data.creator)}</code>`);
  lines.push(`${riskEmoji(data.risk.score)} Risco: ${data.risk.score}/100`);
  lines.push('');
  lines.push('<i>Sem pool ainda — token não é negociável neste momento.</i>');
  if (data.explorerTokenUrl) lines.push(`🔎 <a href="${data.explorerTokenUrl}">Ver no explorer</a>`);
  if (data.footer) {
    lines.push('');
    lines.push(data.footer);
  }

  return {
    text: lines.join('\n'),
    buttons: buildButtons(data.links),
    dedupeKey: `token:${data.tokenAddress}`,
  };
}

/** Botões em linhas de até 3 — mais que isso o Telegram encolhe o label. */
function buildButtons(links: BuiltLink[]): Array<Array<{ label: string; url: string }>> {
  const ordered = [...links].sort((a, b) => rank(a.kind) - rank(b.kind));
  const rows: Array<Array<{ label: string; url: string }>> = [];
  for (let i = 0; i < ordered.length; i += 3) {
    rows.push(ordered.slice(i, i + 3).map((l) => ({ label: l.label, url: l.url })));
  }
  return rows;
}

/** Link que paga vem primeiro — é o que recebe mais clique. */
function rank(kind: BuiltLink['kind']): number {
  return { trade: 0, chart: 1, cex: 2, explorer: 3, other: 4 }[kind];
}

/**
 * `owner === null` significa que a chamada a `owner()` reverteu — ou seja, o
 * contrato não expõe essa função. Isso NÃO é "dono desconhecido e perigoso";
 * na prática costuma ser um token sem Ownable. Dizer o que se sabe, e só isso.
 * (Ressalva: o controle pode existir sob outro nome, como AccessControl.)
 */
function ownerText(risk: TokenRisk): string {
  if (!risk.owner) return 'não expõe owner()';
  return `<code>${shortAddr(risk.owner)}</code> ⚠️ ativo`;
}

function flag(risk: TokenRisk, name: TokenRisk['flags'][number]): string {
  return risk.flags.includes(name) ? `${YES} presente` : NO;
}

function riskEmoji(score: number): string {
  if (score >= 60) return '🔴';
  if (score >= 30) return '🟡';
  return '🟢';
}

function compactSupply(supply: number): string {
  if (!Number.isFinite(supply)) return '?';
  if (supply >= 1e12) return `${(supply / 1e12).toFixed(2).replace(/\.?0+$/, '')}T`;
  if (supply >= 1e9) return `${(supply / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (supply >= 1e6) return `${(supply / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (supply >= 1e3) return `${(supply / 1e3).toFixed(2).replace(/\.?0+$/, '')}K`;
  return supply.toFixed(0);
}
