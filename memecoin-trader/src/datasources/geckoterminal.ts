import { cleanLabel } from '../format.js';
import { fetchJson } from '../http.js';
import type { Candidate, PairSnapshot } from '../types.js';

/**
 * GeckoTerminal — fonte principal de descoberta de tendência.
 *
 * `trending_pools` é o que mais se aproxima de "o que o mercado está olhando
 * agora" numa API gratuita; `new_pools` pega lançamentos recentes. Limite
 * público: 30 chamadas/min — o bot faz 2 por tick de 30s.
 */

const BASE = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { accept: 'application/json;version=20230302' };

/** Rede na nomenclatura do GeckoTerminal. */
export type GtNetwork = 'solana' | 'bsc';

/**
 * O GeckoTerminal e o DexScreener nomeiam a mesma plataforma de formas
 * diferentes (`four-meme` vs `fourmeme`). O config fala UMA língua — a do
 * DexScreener, que é quem enriquece na maioria dos casos — e a tradução mora
 * aqui, para o gate de DEX não depender de qual fonte viu o token primeiro.
 */
const DEX_ALIASES: Record<string, string> = {
  'four-meme': 'fourmeme',
  'pump-fun': 'pumpfun',
  pancakeswap_v2: 'pancakeswap',
  pancakeswap_v3: 'pancakeswap',
};

export const normalizeDexId = (id: string): string => DEX_ALIASES[id] ?? id;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Candidatos + o snapshot que veio JUNTO na mesma resposta. */
export interface GtPools {
  candidates: Candidate[];
  /** Snapshot por mint — enriquecimento de graça, sem requisição extra. */
  snaps: Map<string, PairSnapshot>;
}

/**
 * Converte um pool do GeckoTerminal em PairSnapshot. Exportada para teste.
 *
 * Existe porque o DexScreener LEVA MINUTOS para indexar um par recém-criado na
 * BSC — exatamente a janela da estratégia de bonding curve. Sem este fallback,
 * os lançamentos frescos que a descoberta encontra nunca chegam a ser
 * avaliados: viram candidato sem par e somem.
 */
export function poolToSnapshot(
  pool: unknown,
  network: GtNetwork,
  nowMs: number,
): PairSnapshot | null {
  if (typeof pool !== 'object' || pool === null) return null;
  const p = pool as Record<string, any>;
  const a = p.attributes;
  if (typeof a !== 'object' || a === null) return null;

  const id: unknown = p.relationships?.base_token?.data?.id;
  const prefix = `${network}_`;
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const raw = id.slice(prefix.length);
  const mint = network === 'bsc' ? raw.toLowerCase() : raw;

  const priceUsd = num(a.base_token_price_usd);
  if (priceUsd <= 0) return null;

  const createdMs = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  const tx = a.transactions ?? {};
  const vol = a.volume_usd ?? {};
  const chg = a.price_change_percentage ?? {};
  const name = typeof a.name === 'string' ? a.name : '?';

  return {
    mint,
    symbol: cleanLabel(name.split(' / ')[0] ?? '?', 12),
    name: cleanLabel(name),
    pairAddress: typeof a.address === 'string' ? a.address : '',
    dexId: normalizeDexId(
      typeof p.relationships?.dex?.data?.id === 'string' ? p.relationships.dex.data.id : '?',
    ),
    quoteSymbol: cleanLabel(name.split(' / ')[1] ?? '?', 12),
    priceUsd,
    priceNative: numOrNull(a.base_token_price_native_currency),
    // `reserve_in_usd` é a liquidez do pool. Em bonding curve o GT reporta a
    // reserva, então aqui ela EXISTE mesmo onde o DexScreener manda null — e
    // os gates de liquidez passam a valer. Não é o mesmo dado, e o comentário
    // fica para quem for calibrar depois.
    liquidityUsd: numOrNull(a.reserve_in_usd),
    fdvUsd: numOrNull(a.fdv_usd),
    marketCapUsd: numOrNull(a.market_cap_usd),
    vol5mUsd: num(vol.m5),
    vol1hUsd: num(vol.h1),
    vol24hUsd: num(vol.h24),
    buys5m: num(tx.m5?.buys),
    sells5m: num(tx.m5?.sells),
    buys1h: num(tx.h1?.buys),
    sells1h: num(tx.h1?.sells),
    change5mPct: num(chg.m5),
    change1hPct: num(chg.h1),
    change6hPct: num(chg.h6),
    change24hPct: num(chg.h24),
    ageMin: Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 60_000) : null,
    url: null,
  };
}

/** Candidatos E snapshots de uma resposta de pools. Exportada para teste. */
export function parseGtPools(
  json: unknown,
  source: string,
  network: GtNetwork = 'solana',
  nowMs = Date.now(),
): GtPools {
  const candidates = parsePoolsResponse(json, source, network);
  const snaps = new Map<string, PairSnapshot>();
  const data = (json as Record<string, unknown> | null)?.data;
  if (Array.isArray(data)) {
    for (const pool of data) {
      const snap = poolToSnapshot(pool, network, nowMs);
      // Mais líquido ganha, como no DexScreener: o preço menos manipulável.
      if (snap && (snap.liquidityUsd ?? -1) > (snaps.get(snap.mint)?.liquidityUsd ?? -1)) {
        snaps.set(snap.mint, snap);
      }
    }
  }
  return { candidates, snaps };
}

/**
 * Extrai candidatos da resposta de pools. Exportada para teste.
 *
 * O mint vem de `relationships.base_token.data.id` no formato "<rede>_<mint>".
 * Pools cujo base token não é da rede pedida (não deveria acontecer com o
 * filtro na URL, mas APIs mentem) são descartados.
 */
export function parsePoolsResponse(
  json: unknown,
  source: string,
  network: GtNetwork = 'solana',
): Candidate[] {
  const data = (json as Record<string, unknown> | null)?.data;
  if (!Array.isArray(data)) return [];

  const prefix = `${network}_`;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const pool of data as Record<string, any>[]) {
    const id: unknown = pool?.relationships?.base_token?.data?.id;
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    // EVM: canonicaliza para minúsculas (casing de checksum varia por fonte).
    const mint = network === 'bsc' ? id.slice(prefix.length).toLowerCase() : id.slice(prefix.length);
    if (mint === '' || seen.has(mint)) continue;
    seen.add(mint);

    // attributes.name vem como "BONK / SOL" — o lado esquerdo é o símbolo do base.
    // cleanLabel: símbolo de token é conteúdo hostil (ver format.ts).
    const name: unknown = pool?.attributes?.name;
    const symbol = typeof name === 'string' ? cleanLabel(name.split(' / ')[0] ?? '?', 12) : '?';

    out.push({ mint, symbol, sources: [source] });
  }
  return out;
}

export async function fetchTrendingPools(network: GtNetwork = 'solana'): Promise<GtPools> {
  const json = await fetchJson(`${BASE}/networks/${network}/trending_pools?page=1`, {
    headers: HEADERS,
  });
  return parseGtPools(json, 'gt-trending', network);
}

export async function fetchNewPools(network: GtNetwork = 'solana'): Promise<GtPools> {
  const json = await fetchJson(`${BASE}/networks/${network}/new_pools?page=1`, {
    headers: HEADERS,
  });
  return parseGtPools(json, 'gt-new', network);
}

/**
 * Pools de UMA plataforma específica (ex.: `four-meme` na BSC).
 *
 * Existe porque `trending_pools`/`new_pools` da rede trazem o mercado inteiro —
 * na BSC, tokens estabelecidos de PancakeSwap — enquanto a estratégia só compra
 * bonding curve. Medido: com as fontes genéricas, 17 de 17 candidatos com par
 * eram reprovados pelo gate de DEX; este endpoint entrega direto a população
 * que interessa (tokens de horas, mcap de milhares, volume real).
 */
export async function fetchDexPools(network: GtNetwork, dexId: string): Promise<GtPools> {
  const json = await fetchJson(
    `${BASE}/networks/${network}/dexes/${encodeURIComponent(dexId)}/pools?page=1`,
    { headers: HEADERS },
  );
  return parseGtPools(json, `gt-dex:${dexId}`, network);
}

/**
 * Guarda os snapshots que vieram junto com a descoberta, separados por fonte.
 *
 * Separados por fonte, e não num mapa único, porque cada resposta SUBSTITUI a
 * anterior da mesma fonte: a memória fica do tamanho da última resposta de cada
 * endpoint em vez de crescer com todo mint já visto, e nenhum dado velho
 * sobrevive ao próximo fetch de quem o trouxe.
 */
export class GtSnapshotStore {
  private readonly bySource = new Map<string, Map<string, PairSnapshot>>();

  put(source: string, snaps: Map<string, PairSnapshot>): void {
    this.bySource.set(source, snaps);
  }

  /** O snapshot mais líquido entre as fontes — o preço menos manipulável. */
  get(mint: string): PairSnapshot | null {
    let best: PairSnapshot | null = null;
    for (const snaps of this.bySource.values()) {
      const snap = snaps.get(mint);
      if (snap && (best === null || (snap.liquidityUsd ?? -1) > (best.liquidityUsd ?? -1))) {
        best = snap;
      }
    }
    return best;
  }

  /**
   * Completa `found` com os mints que o enriquecimento primário não trouxe.
   * Devolve quantos preencheu. Não sobrescreve nada: o DexScreener, quando tem
   * o par, continua sendo a fonte de verdade.
   */
  fill(found: Map<string, PairSnapshot>, mints: readonly string[]): number {
    let filled = 0;
    for (const mint of mints) {
      if (found.has(mint)) continue;
      const snap = this.get(mint);
      if (snap === null) continue;
      found.set(mint, snap);
      filled += 1;
    }
    return filled;
  }
}
