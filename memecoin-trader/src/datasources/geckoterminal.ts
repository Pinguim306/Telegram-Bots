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

/**
 * Extrai candidatos da resposta de pools. Exportada para teste.
 *
 * O mint vem de `relationships.base_token.data.id` no formato "solana_<mint>".
 * Pools cujo base token não é da Solana (não deveria acontecer com o filtro de
 * rede na URL, mas APIs mentem) são descartados.
 */
export function parsePoolsResponse(json: unknown, source: string): Candidate[] {
  const data = (json as Record<string, unknown> | null)?.data;
  if (!Array.isArray(data)) return [];

  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const pool of data as Record<string, any>[]) {
    const id: unknown = pool?.relationships?.base_token?.data?.id;
    if (typeof id !== 'string' || !id.startsWith('solana_')) continue;
    const mint = id.slice('solana_'.length);
    if (mint === '' || seen.has(mint)) continue;
    seen.add(mint);

    // attributes.name vem como "BONK / SOL" — o lado esquerdo é o símbolo do base.
    const name: unknown = pool?.attributes?.name;
    const symbol = typeof name === 'string' ? (name.split(' / ')[0] ?? '?') : '?';

    out.push({ mint, symbol, sources: [source] });
  }
  return out;
}

export async function fetchTrendingPools(): Promise<Candidate[]> {
  const json = await fetchJson(`${BASE}/networks/solana/trending_pools?page=1`, {
    headers: HEADERS,
  });
  return parsePoolsResponse(json, 'gt-trending');
}

export async function fetchNewPools(): Promise<Candidate[]> {
  const json = await fetchJson(`${BASE}/networks/solana/new_pools?page=1`, { headers: HEADERS });
  return parsePoolsResponse(json, 'gt-new');
}
