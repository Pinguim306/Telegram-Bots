import { cleanLabel } from '../format.js';
import { fetchJson } from '../http.js';
import type { RugcheckSummary } from '../types.js';

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
const pct = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n * 100 : null;
};

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

  // Top 10 holders (% do supply). O GoPlus lista LP/contratos marcados — a
  // soma crua é conservadora; os limiares do risco já são generosos.
  let top10Pct: number | null = null;
  if (Array.isArray(t.holders)) {
    let sum = 0;
    for (const h of (t.holders as Record<string, unknown>[]).slice(0, 10)) {
      sum += pct(h?.percent) ?? 0;
    }
    top10Pct = sum > 0 ? sum : null;
  }

  const holderCountRaw = t.holder_count;
  const holderCount =
    typeof holderCountRaw === 'string' && /^\d+$/.test(holderCountRaw)
      ? Number(holderCountRaw)
      : typeof holderCountRaw === 'number'
        ? holderCountRaw
        : null;

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

  return {
    available: true,
    rugged: honeypot,
    scoreNormalized: null,
    dangerFlags: dangerFlags.map((f) => cleanLabel(f, 80)),
    lpDangerFlags: [],
    warnFlags: warnFlags.map((f) => cleanLabel(f, 80)),
    lpLockedPct,
    holderCount,
    top10Pct,
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
