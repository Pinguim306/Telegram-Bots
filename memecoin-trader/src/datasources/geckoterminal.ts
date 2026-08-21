import { cleanLabel } from '../format.js';
import { fetchJson } from '../http.js';
import type { Candidate } from '../types.js';

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

export async function fetchTrendingPools(network: GtNetwork = 'solana'): Promise<Candidate[]> {
  const json = await fetchJson(`${BASE}/networks/${network}/trending_pools?page=1`, {
    headers: HEADERS,
  });
  return parsePoolsResponse(json, 'gt-trending', network);
}

export async function fetchNewPools(network: GtNetwork = 'solana'): Promise<Candidate[]> {
  const json = await fetchJson(`${BASE}/networks/${network}/new_pools?page=1`, {
    headers: HEADERS,
  });
  return parsePoolsResponse(json, 'gt-new', network);
}
