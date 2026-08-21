import { cleanLabel } from '../format.js';
import { fetchJson } from '../http.js';
import { bestPairPerMint, normalizePair } from './dexscreener.js';
import type { Candidate, PairSnapshot, RugcheckSummary } from '../types.js';

/**
 * flap.sh — a segunda bonding curve da BSC no escopo da estratégia.
 *
 * Ninguém indexa a flap.sh direito: o GeckoTerminal não a lista como dex e os
 * tokens dela só chegariam por acaso (boosts). A fonte aqui é DUPLA, e as duas
 * pernas caem de forma independente:
 *
 *  1. A API do próprio site (engenharia reversa do board): `/v3/board` no
 *     backend da BSC. Traz os tokens que a plataforma está mostrando AGORA —
 *     inclusive os em curve — e, de graça, as TAXAS do contrato (buy/sell em
 *     bps), que o GoPlus ainda não computou para token novo. O endpoint
 *     responde 429 "public_read_busy" sob carga: falha vira lista vazia e a
 *     perna 2 segura a descoberta.
 *  2. A busca do DexScreener por `flapsh`: todo resultado é um par da
 *     plataforma, com snapshot COMPLETO (volume, txns, idade) — serve de
 *     descoberta e de enriquecimento ao mesmo tempo.
 *
 * A perna 1 usa headers de navegador porque o backend fica atrás de Cloudflare
 * que recusa clientes "não-browser" (403) — com eles, responde JSON.
 */

/** Backend da BSC mainnet (extraído do bundle do site: config da chain "bnb"). */
const FLAP_BOARD_BASE = 'https://bnb.taxed.fun';

/** Sem estes headers o Cloudflare devolve 403 em vez de JSON. */
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  origin: 'https://flap.sh',
  referer: 'https://flap.sh/',
};

/** O que o board da flap.sh sabe de segurança e que o GoPlus (ainda) não. */
export interface FlapTokenSecurity {
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  /** % da bonding curve completada (100 = graduado/listado). */
  progress: number | null;
  listed: boolean;
}

export interface FlapBoard {
  candidates: Candidate[];
  /** Por mint (minúsculas) — consumido na fusão com o GoPlus. */
  security: Map<string, FlapTokenSecurity>;
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Converte a resposta do `/v3/board` em candidatos + segurança. Exportada para teste. */
export function parseFlapBoard(json: unknown, source = 'flapsh-board'): FlapBoard {
  const items = (json as Record<string, unknown> | null)?.items;
  const candidates: Candidate[] = [];
  const security = new Map<string, FlapTokenSecurity>();
  if (!Array.isArray(items)) return { candidates, security };

  const seen = new Set<string>();
  for (const item of items as Record<string, any>[]) {
    const address: unknown = item?.coin?.address;
    if (typeof address !== 'string' || !address.startsWith('0x')) continue;
    const mint = address.toLowerCase();
    if (seen.has(mint)) continue;
    seen.add(mint);

    // Símbolo de token é conteúdo hostil (ver format.ts).
    const symbol = typeof item.coin?.symbol === 'string' ? cleanLabel(item.coin.symbol, 12) : '?';
    candidates.push({ mint, symbol, sources: [source] });

    // tax.buyTaxBps/sellTaxBps: base 10_000. Ausente é DESCONHECIDO, nunca 0 —
    // a mesma lição do GoPlus (o vetor de morte nº 1 da BSC é taxa).
    const tax = item.tax as Record<string, unknown> | undefined;
    const bps = (v: unknown): number | null => {
      const n = numOrNull(v);
      return n === null ? null : n / 100;
    };
    security.set(mint, {
      buyTaxPct: tax ? bps(tax.buyTaxBps) : null,
      sellTaxPct: tax ? bps(tax.sellTaxBps) : null,
      progress: numOrNull(item.progress),
      listed: item.listed === true,
    });
  }
  return { candidates, security };
}

/**
 * Uma categoria do board (`trending`, `graduating_hot`...). A categoria
 * "trending" mora na raiz; as demais são segmento de path — formato observado
 * no cliente do site.
 */
export async function fetchFlapBoard(category = 'trending'): Promise<FlapBoard> {
  const path = category === 'trending' ? '/v3/board' : `/v3/board/${encodeURIComponent(category)}`;
  const json = await fetchJson(`${FLAP_BOARD_BASE}${path}`, {
    headers: BROWSER_HEADERS,
    timeoutMs: 8000,
    retries: 1,
  });
  return parseFlapBoard(json, category === 'trending' ? 'flapsh-board' : `flapsh-${category}`);
}

/** Descoberta + snapshots da flap.sh via busca do DexScreener. */
export interface FlapDexPairs {
  candidates: Candidate[];
  snaps: Map<string, PairSnapshot>;
}

/** Filtra a resposta da busca para pares flapsh da BSC. Exportada para teste. */
export function parseFlapshSearch(json: unknown, nowMs: number): FlapDexPairs {
  const raw = (json as Record<string, unknown> | null)?.pairs;
  const candidates: Candidate[] = [];
  const snaps = new Map<string, PairSnapshot>();
  if (!Array.isArray(raw)) return { candidates, snaps };

  const flapshOnly = raw.filter(
    (p) => (p as Record<string, unknown>)?.dexId === 'flapsh',
  );
  // normalizePair já filtra a rede (bsc) e canonicaliza o endereço.
  const pairs: PairSnapshot[] = [];
  for (const p of flapshOnly) {
    const snap = normalizePair(p, nowMs, 'bsc');
    if (snap) pairs.push(snap);
  }
  for (const [mint, snap] of bestPairPerMint(pairs)) {
    snaps.set(mint, snap);
    candidates.push({ mint, symbol: snap.symbol, sources: ['flapsh-ds'] });
  }
  return { candidates, snaps };
}

export async function fetchFlapshDexPairs(nowMs = Date.now()): Promise<FlapDexPairs> {
  const json = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=flapsh', {
    timeoutMs: 8000,
  });
  return parseFlapshSearch(json, nowMs);
}

/**
 * Funde as taxas conhecidas pela flap.sh num RugcheckSummary do GoPlus.
 *
 * O caso real: token de minutos de vida, o GoPlus responde `shallow` (sem
 * honeypot e sem taxas) e o teto de taxa de venda do risco não tinha o que
 * checar. A plataforma que CRIOU o token sabe as taxas desde o bloco zero —
 * este merge só PREENCHE o que falta, nunca sobrescreve o que o GoPlus mediu.
 * Exportada para teste.
 */
export function applyFlapTaxes(
  summary: RugcheckSummary,
  sec: FlapTokenSecurity | undefined,
): RugcheckSummary {
  if (!sec || !summary.available) return summary;
  const buyTaxPct = summary.buyTaxPct ?? sec.buyTaxPct;
  const sellTaxPct = summary.sellTaxPct ?? sec.sellTaxPct;
  if (buyTaxPct === summary.buyTaxPct && sellTaxPct === summary.sellTaxPct) return summary;
  return { ...summary, buyTaxPct, sellTaxPct };
}

/** Guarda a segurança vinda do board entre a descoberta e a análise de risco. */
export class FlapSecurityStore {
  private bySource = new Map<string, Map<string, FlapTokenSecurity>>();

  /** Cada resposta SUBSTITUI a anterior da mesma fonte — nada velho sobrevive. */
  put(source: string, security: Map<string, FlapTokenSecurity>): void {
    this.bySource.set(source, security);
  }

  get(mint: string): FlapTokenSecurity | undefined {
    for (const m of this.bySource.values()) {
      const sec = m.get(mint);
      if (sec) return sec;
    }
    return undefined;
  }
}
