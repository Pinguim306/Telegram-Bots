import { fetchJson } from '../http.js';
import type { RugcheckSummary } from '../types.js';

/**
 * RugCheck — relatório de risco de rug por token (api.rugcheck.xyz, gratuito).
 *
 * É a melhor fonte pública para o que NÃO dá para ler barato do RPC: LP travada,
 * holders insider, padrões conhecidos de rug. Mas é um serviço de terceiro que
 * pode cair ou rate-limitar — por isso tudo aqui é best-effort e o motor de
 * risco (risk.ts) decide o que fazer quando o relatório não veio.
 */

const BASE = 'https://api.rugcheck.xyz/v1';

/** Flags danger de LP duplicam o lpLockedPct e disparam em liquidez concentrada. */
const LP_FLAG_RE = /\b(lp|liquidity)\b/i;

/**
 * Normaliza o relatório cru. Exportada para teste.
 *
 * Campos usados (todos opcionais na prática — parsing defensivo):
 *   - rugged: o RugCheck já declarou o rug
 *   - score_normalised: 0–100, quanto maior pior
 *   - risks[]: { name, level: 'danger'|'warn'|... }
 *   - markets[].lp: lpLockedUSD e liquidez por mercado (para a média ponderada)
 *   - totalHolders
 *   - topHolders[]: { address, pct } + knownAccounts para excluir vaults de AMM/LP
 *
 * Calibrado contra respostas reais: até o BONK sai com score_normalised 96 e
 * flags danger de "LP Vault unlocked", porque pools CLMM (Orca/Meteora) sempre
 * reportam lpLockedPct 0. Por isso as flags de LP são separadas e a trava de LP
 * é ponderada pela liquidez de cada mercado em vez de olhar um mercado só.
 */
export function normalizeRugcheckReport(json: unknown): RugcheckSummary {
  if (typeof json !== 'object' || json === null) {
    return { available: false, reason: 'resposta vazia' };
  }
  const r = json as Record<string, any>;

  const scoreNormalized =
    typeof r.score_normalised === 'number' && Number.isFinite(r.score_normalised)
      ? Math.max(0, Math.min(100, r.score_normalised))
      : null;

  const dangerFlags: string[] = [];
  const lpDangerFlags: string[] = [];
  const warnFlags: string[] = [];
  if (Array.isArray(r.risks)) {
    for (const risk of r.risks as Record<string, any>[]) {
      const name = typeof risk?.name === 'string' ? risk.name : 'desconhecido';
      if (risk?.level === 'danger') {
        const bucket = LP_FLAG_RE.test(name) ? lpDangerFlags : dangerFlags;
        if (!bucket.includes(name)) bucket.push(name);
      } else if (risk?.level === 'warn') {
        if (!warnFlags.includes(name)) warnFlags.push(name);
      }
    }
  }

  // Trava de LP ponderada: soma do valor travado sobre a liquidez total dos
  // mercados. Um token com 1% da liquidez num pool "travado" e 99% num pool
  // destravável não tem LP travada de verdade.
  let lpLockedPct: number | null = null;
  if (Array.isArray(r.markets) && r.markets.length > 0) {
    let lockedUsd = 0;
    let totalUsd = 0;
    for (const market of r.markets as Record<string, any>[]) {
      const lp = market?.lp;
      const base = typeof lp?.baseUSD === 'number' && Number.isFinite(lp.baseUSD) ? lp.baseUSD : 0;
      const quote = typeof lp?.quoteUSD === 'number' && Number.isFinite(lp.quoteUSD) ? lp.quoteUSD : 0;
      const locked =
        typeof lp?.lpLockedUSD === 'number' && Number.isFinite(lp.lpLockedUSD) ? lp.lpLockedUSD : 0;
      totalUsd += base + quote;
      lockedUsd += locked;
    }
    if (totalUsd > 0) lpLockedPct = Math.max(0, Math.min(100, (lockedUsd / totalUsd) * 100));
  }

  const holderCount =
    typeof r.totalHolders === 'number' && Number.isFinite(r.totalHolders) ? r.totalHolders : null;

  // Contas conhecidas de AMM/LP não são "holders" — são o vault do pool. Sem essa
  // exclusão, todo token com pool concentrado pareceria ter um top holder de 30%.
  const ammAccounts = new Set<string>();
  if (typeof r.knownAccounts === 'object' && r.knownAccounts !== null) {
    for (const [address, info] of Object.entries(r.knownAccounts as Record<string, any>)) {
      const type = typeof info?.type === 'string' ? info.type.toUpperCase() : '';
      if (type.includes('AMM') || type.includes('LP') || type.includes('POOL')) {
        ammAccounts.add(address);
      }
    }
  }

  let top10Pct: number | null = null;
  if (Array.isArray(r.topHolders)) {
    const pcts = (r.topHolders as Record<string, any>[])
      .filter((h) => typeof h?.address !== 'string' || !ammAccounts.has(h.address))
      .map((h) => (typeof h?.pct === 'number' && Number.isFinite(h.pct) ? h.pct : 0))
      .sort((a, b) => b - a)
      .slice(0, 10);
    if (pcts.length > 0) top10Pct = Math.min(100, pcts.reduce((a, b) => a + b, 0));
  }

  return {
    available: true,
    rugged: r.rugged === true,
    scoreNormalized,
    dangerFlags,
    lpDangerFlags,
    warnFlags,
    lpLockedPct,
    holderCount,
    top10Pct,
  };
}

export async function fetchRugcheck(mint: string, timeoutMs: number): Promise<RugcheckSummary> {
  try {
    const json = await fetchJson(`${BASE}/tokens/${mint}/report`, { timeoutMs, retries: 1 });
    return normalizeRugcheckReport(json);
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}
