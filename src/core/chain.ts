import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ResolvedNetwork } from '../config/schema.js';
import { Limiter } from './limiter.js';
import { logger } from './logger.js';

/**
 * Log cru do `eth_getLogs`.
 *
 * Usamos a chamada crua (e não `client.getLogs` tipado) porque o scanner filtra
 * por topic0 na rede inteira, sem lista de endereços — é assim que ele descobre
 * DEXes que ainda nem existiam quando o bot subiu. `blockTimestamp` é uma
 * extensão que a Arc devolve (confirmado no RPC) e economiza um `eth_getBlockByNumber`
 * por bloco; o código não depende dela.
 */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  blockTimestamp?: Hex;
  removed?: boolean;
}

/**
 * Filtro de tópicos no formato do `eth_getLogs`: posições são combinadas com AND,
 * valores dentro de uma posição com OR, e `null` casa com qualquer coisa.
 * Ex.: [[Transfer], [ZERO_TOPIC]] = "todo mint de qualquer token da rede".
 */
export type TopicFilter = Array<Hex[] | null>;

export interface LogFilter {
  fromBlock: bigint;
  toBlock: bigint;
  topics: TopicFilter;
  address?: Address[];
}

export class ChainClient {
  readonly network: ResolvedNetwork;
  readonly client: PublicClient;
  private readonly limiter: Limiter;
  private readonly blockTimestampCache = new Map<bigint, number>();

  constructor(network: ResolvedNetwork, limiter?: Limiter) {
    this.network = network;
    this.limiter = limiter ?? new Limiter();

    const chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: network.nativeCurrency,
      rpcUrls: { default: { http: network.rpcUrls } },
      ...(network.explorerUrl
        ? { blockExplorers: { default: { name: 'Explorer', url: network.explorerUrl } } }
        : {}),
      ...(network.multicall3
        ? { contracts: { multicall3: { address: network.multicall3 } } }
        : {}),
    });

    this.client = createPublicClient({
      chain,
      transport: fallback(
        network.rpcUrls.map((url) =>
          http(url, {
            // O retry fica no Limiter (com token bucket); aqui só o failover entre RPCs.
            retryCount: 0,
            timeout: 20_000,
            batch: { wait: 16, batchSize: 20 },
          }),
        ),
        { rank: false },
      ),
    });
  }

  async getBlockNumber(): Promise<bigint> {
    return this.limiter.run(() => this.client.getBlockNumber({ cacheTime: 0 }), 'getBlockNumber');
  }

  async getBlockHash(blockNumber: bigint): Promise<Hex | null> {
    try {
      const block = await this.limiter.run(
        () => this.client.getBlock({ blockNumber, includeTransactions: false }),
        'getBlock',
      );
      if (block.timestamp !== undefined) {
        this.blockTimestampCache.set(blockNumber, Number(block.timestamp));
      }
      return block.hash;
    } catch (err) {
      logger.debug({ err, blockNumber }, 'getBlockHash falhou');
      return null;
    }
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<number> {
    const cached = this.blockTimestampCache.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await this.limiter.run(
      () => this.client.getBlock({ blockNumber, includeTransactions: false }),
      'getBlock',
    );
    const ts = Number(block.timestamp);
    this.rememberTimestamp(blockNumber, ts);
    return ts;
  }

  rememberTimestamp(blockNumber: bigint, timestamp: number): void {
    this.blockTimestampCache.set(blockNumber, timestamp);
    // cache limitado: só interessa a janela recente que o scanner está processando
    if (this.blockTimestampCache.size > 5_000) {
      const oldest = [...this.blockTimestampCache.keys()].sort((a, b) => (a < b ? -1 : 1));
      for (const key of oldest.slice(0, 2_000)) this.blockTimestampCache.delete(key);
    }
  }

  async getLogs(filter: LogFilter): Promise<RawLog[]> {
    const params: Record<string, unknown> = {
      fromBlock: `0x${filter.fromBlock.toString(16)}`,
      toBlock: `0x${filter.toBlock.toString(16)}`,
      topics: filter.topics,
    };
    if (filter.address?.length) params.address = filter.address;

    return this.limiter.run(
      () =>
        this.client.request({
          method: 'eth_getLogs',
          params: [params],
        }) as Promise<RawLog[]>,
      'getLogs',
    );
  }

  async getCode(address: Address): Promise<Hex | undefined> {
    return this.limiter.run(() => this.client.getCode({ address }), 'getCode');
  }

  /**
   * multicall3 quando disponível; caso contrário cai para chamadas individuais.
   * `allowFailure` sempre ligado — token quebrado é regra, não exceção.
   */
  async multicall<T = unknown>(
    calls: Array<{ address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }>,
  ): Promise<Array<{ status: 'success' | 'failure'; result?: T; error?: unknown }>> {
    if (calls.length === 0) return [];
    if (this.network.multicall3) {
      try {
        const results = await this.limiter.run(
          () =>
            this.client.multicall({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              contracts: calls as any,
              allowFailure: true,
            }),
          'multicall',
        );
        return results as Array<{ status: 'success' | 'failure'; result?: T; error?: unknown }>;
      } catch (err) {
        logger.warn({ err }, 'multicall3 falhou, caindo para chamadas individuais');
      }
    }
    return Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.limiter.run(
            () =>
              this.client.readContract({
                address: call.address,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                abi: call.abi as any,
                functionName: call.functionName,
                args: call.args ?? [],
              }),
            'readContract',
          );
          return { status: 'success' as const, result: result as T };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );
  }

  txUrl(hash: string): string | undefined {
    return this.network.explorerUrl ? `${this.network.explorerUrl}/tx/${hash}` : undefined;
  }

  addressUrl(address: string): string | undefined {
    return this.network.explorerUrl ? `${this.network.explorerUrl}/address/${address}` : undefined;
  }
}

export const hexToBigInt = (hex: Hex): bigint => BigInt(hex);
export const hexToNumber = (hex: Hex): number => Number(BigInt(hex));
