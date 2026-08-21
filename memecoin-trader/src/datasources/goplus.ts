import { cleanLabel } from '../format.js';
import { fetchJson } from '../http.js';
import type { HolderStats, RugcheckSummary } from '../types.js';

/**
 * GoPlus Security — o "RugCheck" da EVM. Na BSC, cada token é um CONTRATO
 * arbitrário: honeypot (compra mas não vende), taxa alterável pelo dono,
 * blacklist, trading pausável. É o modo de morte nº 1 da rede — por isso o
 * config da BSC roda com requireRugcheck=true: sem esta análise, rejeita.
 *
 * A resposta é mapeada para o MESMO RugcheckSummary do RugCheck da Solana —
 * o motor de risco (assessRisk) funciona inalterado nas duas redes.
 *
 * API pública, sem chave no tier básico. Endpoint:
 * https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=0x...
 */

const BASE = 'https://api.gopluslabs.io/api/v1';
const BSC_CHAIN_ID = '56';

const flag = (v: unknown): boolean => v === '1' || v === 1 || v === true;

/**
 * Fração do GoPlus para %. String VAZIA e ausência viram `null` (desconhecido),
 * nunca 0: medido na fourmeme/flap.sh, `buy_tax`/`sell_tax` vêm `''` em 10 de
 * 10 tokens — e `Number('')` é 0, o que transformava "taxa desconhecida" em
 * "sem taxa" exatamente no vetor de morte nº 1 da BSC.
 */
const pct = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n * 100 : null;
};

/**
 * Contas ESTRUTURAIS: seguram supply mas não são ninguém. Sem excluí-las, a
 * "concentração" de qualquer token de bonding curve é 99% — o número não
 * discrimina nada e a checagem de distribuição vira decoração.
 *
 * Medido na four.meme: o contrato abaixo é o top1 holder em 10 de 11 tokens
 * amostrados, com 84%–99,9% do supply. É a curve, não um whale.
 */
const STRUCTURAL_ADDRESSES = new Set([
  '0x5c952063c7fc8610ffdb798152d69f0b9550762b', // bonding curve da four.meme
  '0x000000000000000000000000000000000000dead', // burn
  '0x0000000000000000000000000000000000000000', // zero
]);

/** Como o GoPlus rotula pares de AMM em `holders[].tag`. */
const AMM_TAGS = ['pancake', 'uniswap', 'biswap', 'apeswap', 'sushi', 'thena'];

const isStructuralHolder = (h: Record<string, unknown>): boolean => {
  const address = typeof h.address === 'string' ? h.address.toLowerCase() : '';
  if (STRUCTURAL_ADDRESSES.has(address)) return true;
  const tag = typeof h.tag === 'string' ? h.tag.toLowerCase() : '';
  return tag !== '' && AMM_TAGS.some((t) => tag.includes(t));
};

/**
 * Distribuição do CIRCULANTE a partir dos holders do GoPlus.
 *
 * `holders[].percent` é fração do supply TOTAL, que numa curve está quase todo
 * no contrato da plataforma. O que interessa é a fatia de quem realmente pode
 * vender: renormaliza sobre o circulante depois de tirar as contas estruturais.
 * Medido na four.meme, o top1 do circulante vai de 15% a 96% — aí sim separa
 * token distribuído de token bundlado.
 *
 * Devolve null quando não dá para afirmar nada: sem lista de holders, ou com
 * circulante irrisório (a curve mal começou — qualquer percentual é ruído, e
 * inventar um número aqui seria pior que admitir que não se sabe).
 */
export function holderDistribution(raw: unknown): HolderStats | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const holders = raw as Record<string, unknown>[];

  let structuralPct = 0;
  const free: number[] = [];
  for (const h of holders) {
    const p = pct(h?.percent);
    if (p === null) continue;
    if (isStructuralHolder(h)) structuralPct += p;
    else free.push(p);
  }

  const circulatingPct = 100 - structuralPct;
  if (circulatingPct < 0.5 || free.length === 0) return null;

  free.sort((a, b) => b - a);
  const share = (slice: number[]): number =>
    Math.min(100, (slice.reduce((s, p) => s + p, 0) / circulatingPct) * 100);

  return {
    top1Pct: share(free.slice(0, 1)),
    top10Pct: share(free.slice(0, 10)),
    holderCount: null,
    source: 'rugcheck',
  };
}

/**
 * Mapeia a resposta crua do GoPlus para RugcheckSummary. Exportada para teste.
 *
 * Tradução de mundos: o que na Solana é "authority ativa" aqui é função de
 * contrato — is_mintable vira o equivalente da mint authority, blacklist e
 * pausable viram o da freeze authority. Todos entram como dangerFlags, que o
 * config veta (vetoRugcheckDanger).
 */
export function mapGoPlusToken(raw: unknown): RugcheckSummary {
  if (typeof raw !== 'object' || raw === null) {
    return { available: false, reason: 'resposta vazia do GoPlus' };
  }
  const t = raw as Record<string, unknown>;

  const dangerFlags: string[] = [];
  const warnFlags: string[] = [];
  const danger = (label: string) => dangerFlags.push(label);
  const warn = (label: string) => warnFlags.push(label);

  // Honeypot e variantes: compra que não volta. É O golpe da BSC.
  const honeypot = flag(t.is_honeypot) || flag(t.cannot_sell_all);
  if (flag(t.is_honeypot)) danger('honeypot: venda bloqueada pelo contrato');
  if (flag(t.cannot_sell_all)) danger('cannot_sell_all: contrato limita a venda');
  if (flag(t.is_blacklisted)) danger('blacklist ativa: o dono pode banir carteiras');
  if (flag(t.transfer_pausable)) danger('transferências pausáveis pelo dono');
  if (flag(t.is_mintable)) danger('mintable: o dono pode inflar o supply');
  if (flag(t.owner_change_balance)) danger('o dono pode ALTERAR saldos de carteiras');
  if (flag(t.selfdestruct)) danger('contrato com selfdestruct');
  if (flag(t.hidden_owner)) danger('dono oculto (hidden_owner)');
  if (flag(t.slippage_modifiable)) danger('taxas alteráveis pelo dono a qualquer momento');
  if (t.is_open_source !== undefined && !flag(t.is_open_source)) {
    danger('contrato de código fechado');
  }
  if (flag(t.is_proxy)) warn('contrato proxy (atualizável)');
  if (flag(t.trading_cooldown)) warn('cooldown de trading entre operações');
  if (flag(t.is_anti_whale) && flag(t.anti_whale_modifiable)) warn('anti-whale modificável');

  const buyTaxPct = pct(t.buy_tax);
  const sellTaxPct = pct(t.sell_tax);
  if (sellTaxPct !== null && sellTaxPct >= 3 && sellTaxPct < 10) {
    warn(`taxa de venda de ${sellTaxPct.toFixed(1)}%`);
  }

  // Distribuição sobre o CIRCULANTE (contas estruturais fora) — é o contrato
  // que `top10Pct` sempre prometeu e que a soma crua do supply não cumpria.
  const distribution = holderDistribution(t.holders);
  const top10Pct = distribution?.top10Pct ?? null;

  const holderCountRaw = t.holder_count;
  const holderCountParsed =
    typeof holderCountRaw === 'string' && /^\d+$/.test(holderCountRaw)
      ? Number(holderCountRaw)
      : typeof holderCountRaw === 'number'
        ? holderCountRaw
        : null;
  // ZERO holders num token que tem par e negociação é dado NÃO COMPUTADO, não
  // realidade (visto em 7 de 10 tokens novos de curve). Tratar como 0 gerava a
  // flag "poucos holders" em toda a população-alvo — ruído que não discrimina.
  const holderCount = holderCountParsed === 0 ? null : holderCountParsed;

  // % da LP travada/queimada, ponderada pelo tamanho de cada posição de LP.
  let lpLockedPct: number | null = null;
  if (Array.isArray(t.lp_holders)) {
    let total = 0;
    let locked = 0;
    for (const h of t.lp_holders as Record<string, unknown>[]) {
      const p = pct(h?.percent) ?? 0;
      total += p;
      if (flag(h?.is_locked)) locked += p;
    }
    if (total > 0) lpLockedPct = (locked / total) * 100;
  }

  // A resposta veio, mas sem NENHUM dos dois sinais que decidem na BSC.
  // Token novo de bonding curve cai aqui quase sempre — e o operador precisa
  // saber que a rede de segurança não cobriu este caso.
  const shallow =
    t.is_honeypot === undefined ||
    (t.is_honeypot === null && buyTaxPct === null && sellTaxPct === null);

  return {
    available: true,
    shallow,
    rugged: honeypot,
    scoreNormalized: null,
    dangerFlags: dangerFlags.map((f) => cleanLabel(f, 80)),
    lpDangerFlags: [],
    warnFlags: warnFlags.map((f) => cleanLabel(f, 80)),
    lpLockedPct,
    holderCount,
    top10Pct,
    distribution: distribution && { ...distribution, holderCount },
    buyTaxPct,
    sellTaxPct,
  };
}

/** Análise de segurança de um token da BSC via GoPlus. */
export async function fetchGoPlusSecurity(
  address: string,
  timeoutMs: number,
): Promise<RugcheckSummary> {
  try {
    const json = (await fetchJson(
      `${BASE}/token_security/${BSC_CHAIN_ID}?contract_addresses=${address.toLowerCase()}`,
      { timeoutMs },
    )) as Record<string, unknown> | null;
    const result = json?.result as Record<string, unknown> | undefined;
    const entry = result?.[address.toLowerCase()];
    if (!entry) return { available: false, reason: 'token ainda não indexado pelo GoPlus' };
    return mapGoPlusToken(entry);
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}
