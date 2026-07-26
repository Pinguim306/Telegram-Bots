import type { Address } from 'viem';
import type { QuoteToken } from '../config/schema.js';
import type { DecodedSwap } from './events.js';
import { fromUnits } from './format.js';
import type { PoolInfo } from './pools.js';

export type TradeSide = 'buy' | 'sell';

export interface Trade {
  pool: Address;
  token: Address;
  side: TradeSide;
  /** quantidade do token base, já em unidades humanas */
  tokenAmount: number;
  /** quantidade do token de quote, já em unidades humanas */
  quoteAmount: number;
  usd: number;
  priceUsd: number;
  trader: Address;
  ts: number;
  block: number;
  txHash: string;
  logIndex: number;
}

export interface NormalizeContext {
  pool: PoolInfo;
  quote: QuoteToken;
  quoteUsdPrice: number;
  baseDecimals: number;
  ts: number;
  block: number;
  txHash: string;
  logIndex: number;
}

/**
 * Converte um Swap decodificado em um trade normalizado.
 *
 * Convenção de sinal: os deltas são da perspectiva do POOL.
 * Pool ENTREGOU o token base (delta negativo) => o usuário COMPROU.
 *
 * Isso unifica V2 e V3: no V2 os deltas são reconstruídos de
 * (amountIn - amountOut) em events.ts, no V3 já vêm assinados.
 */
/**
 * Piso de poeira, em unidades humanas de token.
 *
 * Um swap de 1 wei contra 1 USDC é aritmeticamente válido e implica um preço de
 * 10^18 dólares por token. Isso não é trade: é ruído de arredondamento — ou uma
 * tentativa deliberada de envenenar o preço, já que o último preço da janela vira
 * market cap e variação percentual no alerta. Qualquer trade real está ordens de
 * grandeza acima deste piso.
 */
const DUST_THRESHOLD = 1e-9;

export function normalizeSwap(swap: DecodedSwap, ctx: NormalizeContext): Trade | null {
  const baseIsToken0 = ctx.pool.baseToken === ctx.pool.token0;
  const baseDelta = baseIsToken0 ? swap.delta0 : swap.delta1;
  const quoteDelta = baseIsToken0 ? swap.delta1 : swap.delta0;

  if (baseDelta === 0n || quoteDelta === 0n) return null;
  // Deltas com o mesmo sinal não são um swap (flash loan, doação, evento malformado).
  if (baseDelta > 0n === quoteDelta > 0n) return null;

  const side: TradeSide = baseDelta < 0n ? 'buy' : 'sell';
  const tokenAmount = fromUnits(baseDelta < 0n ? -baseDelta : baseDelta, ctx.baseDecimals);
  const quoteAmount = fromUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, ctx.quote.decimals);

  if (tokenAmount < DUST_THRESHOLD || quoteAmount < DUST_THRESHOLD) return null;

  const usd = quoteAmount * ctx.quoteUsdPrice;
  const priceUsd = usd / tokenAmount;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  return {
    pool: ctx.pool.address,
    token: ctx.pool.baseToken,
    side,
    tokenAmount,
    quoteAmount,
    usd,
    priceUsd,
    trader: swap.recipient,
    ts: ctx.ts,
    block: ctx.block,
    txHash: ctx.txHash,
    logIndex: ctx.logIndex,
  };
}
