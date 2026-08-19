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
export function normalizePair(raw: unknown, nowMs: number): PairSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, any>;

  if (p.chainId !== 'solana') return null;
  const base = p.baseToken;
  if (typeof base?.address !== 'string' || base.address === '') return null;

  const priceUsd = num(p.priceUsd);
  if (priceUsd <= 0) return null;

  const createdAtMs = numOrNull(p.pairCreatedAt);

  return {
    mint: base.address,
    symbol: typeof base.symbol === 'string' ? base.symbol : '?',
    name: typeof base.name === 'string' ? base.name : '?',
    pairAddress: typeof p.pairAddress === 'string' ? p.pairAddress : '',
    dexId: typeof p.dexId === 'string' ? p.dexId : '?',
    quoteSymbol: typeof p.quoteToken?.symbol === 'string' ? p.quoteToken.symbol : '?',
    priceUsd,
    priceNative: numOrNull(p.priceNative),
    liquidityUsd: num(p.liquidity?.usd),
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
    if (!current || pair.liquidityUsd > current.liquidityUsd) best.set(pair.mint, pair);
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
): Promise<Map<string, PairSnapshot>> {
  const result = new Map<string, PairSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const json = await fetchJson(`${BASE}/latest/dex/tokens/${chunk.join(',')}`);
    const normalized = extractPairs(json)
      .map((p) => normalizePair(p, nowMs))
      .filter((p): p is PairSnapshot => p !== null)
      // Enriquecendo o mint X, só interessam pares onde X é o base token —
      // um par onde X aparece como quote daria preço do OUTRO token.
      .filter((p) => chunk.includes(p.mint));
    for (const [mint, snap] of bestPairPerMint(normalized)) result.set(mint, snap);
  }
  return result;
}

/** Tokens com boost pago no DexScreener. Sinal fraco sozinho (é comprável), mas indica atividade. */
export async function fetchTopBoosts(): Promise<Candidate[]> {
  const json = await fetchJson(`${BASE}/token-boosts/top/v1`);
  if (!Array.isArray(json)) return [];
  const out: Candidate[] = [];
  for (const item of json as Record<string, any>[]) {
    if (item?.chainId !== 'solana' || typeof item?.tokenAddress !== 'string') continue;
    out.push({ mint: item.tokenAddress, symbol: '?', sources: ['ds-boosts'] });
  }
  return out;
}

/** Preço do SOL em USD via o par de maior liquidez do wrapped SOL. */
export async function fetchSolPriceUsd(): Promise<number | null> {
  const pairs = await fetchPairsForMints([WSOL_MINT]);
  const snap = pairs.get(WSOL_MINT);
  return snap && snap.priceUsd > 0 ? snap.priceUsd : null;
}
