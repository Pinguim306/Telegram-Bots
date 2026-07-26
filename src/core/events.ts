import { decodeEventLog, parseAbiItem, toEventSelector, type Address, type Hex } from 'viem';

/**
 * Assinaturas de evento.
 *
 * Os topic0 são DERIVADOS das assinaturas (toEventSelector), nunca hardcoded —
 * hash copiado errado é um bug silencioso: o scanner simplesmente nunca acha nada.
 * O teste em test/events.test.ts fixa os valores esperados contra os hashes que
 * foram observados de verdade nos logs da Arc.
 */

export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/** Uniswap V2 / forks (PancakeSwap, SushiSwap, ...). */
export const PAIR_CREATED_EVENT = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
);

/** Uniswap V3 / forks. */
export const POOL_CREATED_EVENT = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);

export const V2_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

export const V3_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

export const V2_SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');

export const TOPIC = {
  transfer: toEventSelector(TRANSFER_EVENT),
  pairCreated: toEventSelector(PAIR_CREATED_EVENT),
  poolCreated: toEventSelector(POOL_CREATED_EVENT),
  v2Swap: toEventSelector(V2_SWAP_EVENT),
  v3Swap: toEventSelector(V3_SWAP_EVENT),
  v2Sync: toEventSelector(V2_SYNC_EVENT),
} as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
/** topic com o endereço zero, para filtrar mints direto no `eth_getLogs`. */
export const ZERO_TOPIC = `0x${'0'.repeat(64)}` as Hex;

export type PoolKind = 'v2' | 'v3';

export interface DecodedPoolCreation {
  kind: PoolKind;
  factory: Address;
  pool: Address;
  token0: Address;
  token1: Address;
  fee?: number;
}

/** Decodifica PairCreated (V2) ou PoolCreated (V3). Retorna null se não for nenhum dos dois. */
export function decodePoolCreation(log: {
  address: Address;
  topics: Hex[];
  data: Hex;
}): DecodedPoolCreation | null {
  const topic0 = log.topics[0];
  try {
    if (topic0 === TOPIC.pairCreated) {
      const { args } = decodeEventLog({
        abi: [PAIR_CREATED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return {
        kind: 'v2',
        factory: lower(log.address),
        pool: lower(args.pair),
        token0: lower(args.token0),
        token1: lower(args.token1),
      };
    }
    if (topic0 === TOPIC.poolCreated) {
      const { args } = decodeEventLog({
        abi: [POOL_CREATED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return {
        kind: 'v3',
        factory: lower(log.address),
        pool: lower(args.pool),
        token0: lower(args.token0),
        token1: lower(args.token1),
        fee: Number(args.fee),
      };
    }
  } catch {
    // Evento com a mesma assinatura mas layout diferente (fork exótico). Ignorar é o certo:
    // melhor perder um pool obscuro do que derrubar o scanner.
    return null;
  }
  return null;
}

/** Deltas de um swap na perspectiva do pool: positivo = pool recebeu. */
export interface DecodedSwap {
  kind: PoolKind;
  pool: Address;
  /** quem recebeu o output — usado como proxy de "trader" */
  recipient: Address;
  sender: Address;
  delta0: bigint;
  delta1: bigint;
}

export function decodeSwap(log: {
  address: Address;
  topics: Hex[];
  data: Hex;
}): DecodedSwap | null {
  const topic0 = log.topics[0];
  try {
    if (topic0 === TOPIC.v2Swap) {
      const { args } = decodeEventLog({
        abi: [V2_SWAP_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return {
        kind: 'v2',
        pool: lower(log.address),
        sender: lower(args.sender),
        recipient: lower(args.to),
        // V2 reporta entradas e saídas separadas; normalizamos para um delta assinado
        delta0: args.amount0In - args.amount0Out,
        delta1: args.amount1In - args.amount1Out,
      };
    }
    if (topic0 === TOPIC.v3Swap) {
      const { args } = decodeEventLog({
        abi: [V3_SWAP_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return {
        kind: 'v3',
        pool: lower(log.address),
        sender: lower(args.sender),
        recipient: lower(args.recipient),
        // V3 já é assinado na perspectiva do pool
        delta0: args.amount0,
        delta1: args.amount1,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export interface DecodedMint {
  token: Address;
  to: Address;
  value: bigint;
}

/** Transfer com from == address(0) — a criação de supply de um token novo. */
export function decodeMint(log: { address: Address; topics: Hex[]; data: Hex }): DecodedMint | null {
  if (log.topics[0] !== TOPIC.transfer) return null;
  if (log.topics[1] !== ZERO_TOPIC) return null;
  try {
    const { args } = decodeEventLog({
      abi: [TRANSFER_EVENT],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    return { token: lower(log.address), to: lower(args.to), value: args.value };
  } catch {
    return null;
  }
}

function lower(value: string): Address {
  return value.toLowerCase() as Address;
}
