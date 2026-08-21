import { cleanLabel } from '../format.js';
import { fetchJson } from '../http.js';
import type { Candidate, PairSnapshot } from '../types.js';

/**
 * DexScreener — enriquecimento de mercado e uma das fontes de descoberta.
 *
 * API pública, sem chave. Limites documentados: 300 req/min no endpoint de
 * tokens, 60 req/min nos de boosts. Com tick de 30s e lotes de até 30 mints
 * por chamada, o bot fica uma ordem de grandeza abaixo disso.
 */

const BASE = 'https://api.dexscreener.com';

/** Mint do wrapped SOL — o "SOL" dos pares de DEX. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * WBNB — o "BNB" dos pares de DEX da BSC. Minúsculo de propósito: endereço
 * EVM tem casing de checksum variável, e TODO endereço BSC no bot é
 * canonicalizado para minúsculas na ingestão — sem isso, o mesmo token vindo
 * do GeckoTerminal ("0xab...") e do DexScreener ("0xAb...") viraria dois.
 */
export const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

/** Rede na nomenclatura do DexScreener (campo chainId dos pares). */
export type DsChain = 'solana' | 'bsc';

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Normaliza um par cru do DexScreener. Exportada para teste — o formato da API
 * é a parte que quebra em silêncio quando eles mudam alguma coisa.
 */
export function normalizePair(raw: unknown, nowMs: number, chain: DsChain = 'solana'): PairSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, any>;

  // O endpoint de tokens é multi-chain: o MESMO endereço pode existir em
  // outra rede — filtrar pela rede deste processo é obrigatório.
  if (p.chainId !== chain) return null;
  const base = p.baseToken;
  if (typeof base?.address !== 'string' || base.address === '') return null;

  const priceUsd = num(p.priceUsd);
  if (priceUsd <= 0) return null;

  const createdAtMs = numOrNull(p.pairCreatedAt);

  return {
    // EVM: canonicaliza para minúsculas (casing de checksum varia por fonte).
    mint: chain === 'bsc' ? base.address.toLowerCase() : base.address,
    // cleanLabel: nome de token é conteúdo hostil (escapes ANSI reescrevem o
    // terminal por cima do veredito de risco) — sanitiza na ingestão.
    symbol: typeof base.symbol === 'string' ? cleanLabel(base.symbol, 12) : '?',
    name: typeof base.name === 'string' ? cleanLabel(base.name) : '?',
    pairAddress: typeof p.pairAddress === 'string' ? p.pairAddress : '',
    dexId: typeof p.dexId === 'string' ? cleanLabel(p.dexId, 16) : '?',
    quoteSymbol: typeof p.quoteToken?.symbol === 'string' ? cleanLabel(p.quoteToken.symbol, 12) : '?',
    priceUsd,
    priceNative: numOrNull(p.priceNative),
    // numOrNull, não num: liquidez ausente é DESCONHECIDA, não zero — zero
    // dispararia a venda urgente por "dreno de liquidez" numa resposta parcial.
    liquidityUsd: numOrNull(p.liquidity?.usd),
    fdvUsd: numOrNull(p.fdv),
    marketCapUsd: numOrNull(p.marketCap),
    vol5mUsd: num(p.volume?.m5),
    vol1hUsd: num(p.volume?.h1),
    vol24hUsd: num(p.volume?.h24),
    buys5m: num(p.txns?.m5?.buys),
    sells5m: num(p.txns?.m5?.sells),
    buys1h: num(p.txns?.h1?.buys),
    sells1h: num(p.txns?.h1?.sells),
    change5mPct: num(p.priceChange?.m5),
    change1hPct: num(p.priceChange?.h1),
    change6hPct: num(p.priceChange?.h6),
    change24hPct: num(p.priceChange?.h24),
    ageMin: createdAtMs !== null && createdAtMs > 0 ? (nowMs - createdAtMs) / 60_000 : null,
    url: typeof p.url === 'string' ? p.url : null,
  };
}

/**
 * Dentre os pares de um mesmo mint, fica com o de maior liquidez — é onde o
 * swap de verdade vai rotear e onde o preço é menos manipulável.
 */
export function bestPairPerMint(pairs: PairSnapshot[]): Map<string, PairSnapshot> {
  const best = new Map<string, PairSnapshot>();
  for (const pair of pairs) {
    const current = best.get(pair.mint);
    // Liquidez desconhecida (-1) perde de qualquer valor conhecido, inclusive 0.
    if (!current || (pair.liquidityUsd ?? -1) > (current.liquidityUsd ?? -1)) {
      best.set(pair.mint, pair);
    }
  }
  return best;
}

function extractPairs(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const pairs = (json as Record<string, unknown> | null)?.pairs;
  return Array.isArray(pairs) ? pairs : [];
}

/** Busca e normaliza o melhor par de cada mint, em lotes de 30 (limite da API). */
export async function fetchPairsForMints(
  mints: string[],
  nowMs = Date.now(),
  chain: DsChain = 'solana',
): Promise<Map<string, PairSnapshot>> {
  const result = new Map<string, PairSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const json = await fetchJson(`${BASE}/latest/dex/tokens/${chunk.join(',')}`);
    const normalized = extractPairs(json)
      .map((p) => normalizePair(p, nowMs, chain))
      .filter((p): p is PairSnapshot => p !== null)
      // Enriquecendo o mint X, só interessam pares onde X é o base token —
      // um par onde X aparece como quote daria preço do OUTRO token.
      .filter((p) => chunk.includes(p.mint));
    for (const [mint, snap] of bestPairPerMint(normalized)) result.set(mint, snap);
  }
  return result;
}

/** Tokens com boost pago no DexScreener. Sinal fraco sozinho (é comprável), mas indica atividade. */
export async function fetchTopBoosts(chain: DsChain = 'solana'): Promise<Candidate[]> {
  const json = await fetchJson(`${BASE}/token-boosts/top/v1`);
  if (!Array.isArray(json)) return [];
  const out: Candidate[] = [];
  for (const item of json as Record<string, any>[]) {
    if (item?.chainId !== chain || typeof item?.tokenAddress !== 'string') continue;
    const mint = chain === 'bsc' ? item.tokenAddress.toLowerCase() : item.tokenAddress;
    out.push({ mint, symbol: '?', sources: ['ds-boosts'] });
  }
  return out;
}

/**
 * Preço em USD da moeda NATIVA da rede (SOL/BNB), via o par de maior liquidez
 * do wrapped correspondente. É o câmbio de toda a contabilidade do bot.
 */
export async function fetchNativePriceUsd(chain: DsChain = 'solana'): Promise<number | null> {
  const wrapped = chain === 'bsc' ? WBNB_ADDRESS : WSOL_MINT;
  const pairs = await fetchPairsForMints([wrapped], Date.now(), chain);
  const snap = pairs.get(wrapped);
  return snap && snap.priceUsd > 0 ? snap.priceUsd : null;
}

/** Compatibilidade: preço do SOL (o nome antigo, usado pelo caminho Solana). */
export async function fetchSolPriceUsd(): Promise<number | null> {
  return fetchNativePriceUsd('solana');
}
