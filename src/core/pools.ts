import { erc20Abi, type Address } from 'viem';
import type { QuoteToken } from '../config/schema.js';
import type { ChainClient } from './chain.js';
import type { Db } from './db.js';
import type { DecodedPoolCreation, PoolKind } from './events.js';
import { fromUnits } from './format.js';
import { logger } from './logger.js';

export interface PoolLiquidity {
  /** Lado quote: o dinheiro que realmente está no pool. */
  quoteUsd: number;
  /** Lado base: valor dos tokens depositados, a preço spot. Não é liquidez de saída. */
  baseUsd: number;
  totalUsd: number;
}

export interface PoolInfo {
  address: Address;
  kind: PoolKind;
  factory: Address | null;
  token0: Address;
  token1: Address;
  fee: number | null;
  /** Token "de interesse" — o que é negociado. */
  baseToken: Address;
  /** Token de precificação (USDC etc.). */
  quoteToken: Address;
  createdBlock: number | null;
  createdTs: number | null;
}

const poolAbi = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  {
    name: 'getReserves',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }],
  },
  {
    name: 'slot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint160' },
      { type: 'int24' },
      { type: 'uint16' },
      { type: 'uint16' },
      { type: 'uint16' },
      { type: 'uint8' },
      { type: 'bool' },
    ],
  },
] as const;

/**
 * Escolhe qual lado do par é o token negociado e qual é a moeda de precificação.
 * Retorna null quando nenhum dos dois lados é um quote conhecido — sem quote não
 * há como converter para USD, e alerta com preço errado é pior do que alerta nenhum.
 */
export function chooseQuote(
  token0: Address,
  token1: Address,
  quoteTokens: QuoteToken[],
): { base: Address; quote: QuoteToken } | null {
  const q0 = quoteTokens.find((q) => q.address === token0);
  const q1 = quoteTokens.find((q) => q.address === token1);
  if (q0 && q1) {
    // Par quote/quote (ex: USDC/WETH): o de maior preferência precifica o outro.
    return q0.preference >= q1.preference
      ? { base: token1, quote: q0 }
      : { base: token0, quote: q1 };
  }
  if (q0) return { base: token1, quote: q0 };
  if (q1) return { base: token0, quote: q1 };
  return null;
}

export class PoolRegistry {
  private readonly cache = new Map<Address, PoolInfo | null>();
  /** Pools cuja data de criação não pôde ser determinada — não tentar de novo. */
  private readonly creationLookupFailed = new Set<Address>();

  constructor(
    private readonly db: Db,
    private readonly chain: ChainClient,
    private readonly quoteTokens: QuoteToken[],
  ) {}

  quoteFor(address: Address): QuoteToken | undefined {
    return this.quoteTokens.find((q) => q.address === address);
  }

  /** Registra um pool a partir do evento de criação da factory. */
  record(creation: DecodedPoolCreation, block: number, ts: number): PoolInfo | null {
    const picked = chooseQuote(creation.token0, creation.token1, this.quoteTokens);
    const info: PoolInfo = {
      address: creation.pool,
      kind: creation.kind,
      factory: creation.factory,
      token0: creation.token0,
      token1: creation.token1,
      fee: creation.fee ?? null,
      baseToken: picked?.base ?? creation.token0,
      quoteToken: picked?.quote.address ?? creation.token1,
      createdBlock: block,
      createdTs: ts,
    };
    this.persist(info);
    this.cache.set(info.address, info);
    return picked ? info : null;
  }

  private persist(info: PoolInfo): void {
    this.db
      .prepare(
        `INSERT INTO pools (address, factory, kind, token0, token1, fee, base_token, quote_token,
                            created_block, created_ts, discovered_ts)
         VALUES (@address, @factory, @kind, @token0, @token1, @fee, @baseToken, @quoteToken,
                 @createdBlock, @createdTs, @discoveredTs)
         ON CONFLICT(address) DO UPDATE SET
           factory       = COALESCE(excluded.factory, pools.factory),
           created_block = COALESCE(pools.created_block, excluded.created_block),
           created_ts    = COALESCE(pools.created_ts, excluded.created_ts)`,
      )
      .run({
        address: info.address,
        factory: info.factory,
        kind: info.kind,
        token0: info.token0,
        token1: info.token1,
        fee: info.fee,
        baseToken: info.baseToken,
        quoteToken: info.quoteToken,
        createdBlock: info.createdBlock,
        createdTs: info.createdTs,
        discoveredTs: Math.floor(Date.now() / 1000),
      });
  }

  /**
   * Resolve um pool que apareceu num swap sem termos visto sua criação.
   *
   * Isso acontece o tempo todo: pools criados antes do bot subir, ou por uma
   * factory com evento de criação fora do padrão. Descobrir pelo swap garante que
   * nenhum volume seja perdido só porque a factory é exótica.
   */
  async resolve(address: Address): Promise<PoolInfo | null> {
    const cached = this.cache.get(address);
    if (cached !== undefined) return cached;

    const row = this.db.prepare('SELECT * FROM pools WHERE address = ?').get(address) as
      | {
          address: string;
          factory: string | null;
          kind: string;
          token0: string;
          token1: string;
          fee: number | null;
          base_token: string | null;
          quote_token: string | null;
          created_block: number | null;
          created_ts: number | null;
        }
      | undefined;

    if (row) {
      const info: PoolInfo = {
        address: row.address as Address,
        kind: row.kind as PoolKind,
        factory: row.factory as Address | null,
        token0: row.token0 as Address,
        token1: row.token1 as Address,
        fee: row.fee,
        baseToken: (row.base_token ?? row.token0) as Address,
        quoteToken: (row.quote_token ?? row.token1) as Address,
        createdBlock: row.created_block,
        createdTs: row.created_ts,
      };
      const usable = this.quoteFor(info.quoteToken) ? info : null;
      this.cache.set(address, usable);
      return usable;
    }

    return this.discoverOnChain(address);
  }

  private async discoverOnChain(address: Address): Promise<PoolInfo | null> {
    try {
      const [t0, t1, fee] = await this.chain.multicall([
        { address, abi: poolAbi, functionName: 'token0' },
        { address, abi: poolAbi, functionName: 'token1' },
        { address, abi: poolAbi, functionName: 'fee' },
      ]);

      if (t0?.status !== 'success' || t1?.status !== 'success') {
        this.cache.set(address, null);
        return null;
      }

      const token0 = String(t0.result).toLowerCase() as Address;
      const token1 = String(t1.result).toLowerCase() as Address;
      const picked = chooseQuote(token0, token1, this.quoteTokens);
      if (!picked) {
        // Pool sem quote conhecido: memoriza como inútil para não reconsultar a cada swap.
        this.cache.set(address, null);
        return null;
      }

      const info: PoolInfo = {
        address,
        // `fee()` só existe em V3; usamos isso para inferir o tipo do pool.
        kind: fee?.status === 'success' ? 'v3' : 'v2',
        factory: null,
        token0,
        token1,
        fee: fee?.status === 'success' ? Number(fee.result) : null,
        baseToken: picked.base,
        quoteToken: picked.quote.address,
        createdBlock: null,
        createdTs: null,
      };
      this.persist(info);
      this.cache.set(address, info);
      return info;
    } catch (err) {
      logger.debug({ err, address }, 'discoverOnChain falhou');
      this.cache.set(address, null);
      return null;
    }
  }

  /**
   * Descobre QUANDO o pool foi criado, para pools que não vimos nascer.
   *
   * Por que isso importa: sem a data de criação, "idade do token" vira "tempo
   * desde que o bot ligou". Aí um token de três meses parece recém-nascido depois
   * de todo restart — e a regra `fresh_launch` premia justamente o que não deveria.
   *
   * Busca binária sobre `eth_getCode`: ~26 chamadas para achar o bloco exato de
   * deploy em uma chain de 50M+ blocos, uma única vez por pool, gravado no SQLite
   * para sempre. Exige nó archive; quando não houver, devolve null e o resto do
   * sistema trata a idade como desconhecida em vez de inventar um número.
   */
  async ensureCreatedAt(info: PoolInfo): Promise<number | null> {
    if (info.createdTs !== null) return info.createdTs;
    if (this.creationLookupFailed.has(info.address)) return null;

    try {
      const head = await this.chain.getBlockNumber();
      const deployBlock = await this.findDeploymentBlock(info.address, head);
      if (deployBlock === null) {
        this.creationLookupFailed.add(info.address);
        return null;
      }
      const ts = await this.chain.getBlockTimestamp(deployBlock);
      this.db
        .prepare('UPDATE pools SET created_block = ?, created_ts = ? WHERE address = ?')
        .run(Number(deployBlock), ts, info.address);
      info.createdBlock = Number(deployBlock);
      info.createdTs = ts;
      return ts;
    } catch (err) {
      logger.debug({ err, pool: info.address }, 'busca do bloco de criação falhou');
      this.creationLookupFailed.add(info.address);
      return null;
    }
  }

  private async findDeploymentBlock(address: Address, head: bigint): Promise<bigint | null> {
    const codeAt = async (block: bigint): Promise<boolean> => {
      const code = await this.chain.client.getCode({ address, blockNumber: block });
      return Boolean(code && code !== '0x');
    };

    // Se o contrato não existe nem na cabeça da chain, não há o que procurar.
    if (!(await codeAt(head))) return null;
    // Nó não-archive costuma responder o estado atual para qualquer bloco antigo:
    // nesse caso o bloco 1 "teria" código e a busca daria um resultado falso.
    if (await codeAt(1n)) return null;

    let low = 1n;
    let high = head;
    while (low < high) {
      const mid = (low + high) / 2n;
      if (await codeAt(mid)) high = mid;
      else low = mid + 1n;
    }
    return low;
  }

  /**
   * Liquidez do pool, separada em dois números que NÃO são a mesma coisa.
   *
   * Isso não é preciosismo — foi medido na Arc. Os launches lá saem de launchpad
   * estilo bonding curve: o pool nasce com token e ZERO USDC, e o USDC só entra
   * conforme as pessoas compram. Um filtro do tipo "liquidez mínima de $500" olhando
   * só o lado quote descartaria todo launch novo — justamente o que o bot existe
   * para pegar. Por outro lado, tratar `baseUsd` como liquidez real também é
   * enganoso: token no pool não é dinheiro, você não consegue vender contra ele.
   *
   *  - `quoteUsd`: dinheiro de verdade no pool. É contra isso que dá para vender.
   *  - `baseUsd`:  valor do token depositado, a preço spot.
   *  - `totalUsd`: soma dos dois — mede "tamanho do pool", não capacidade de saída.
   */
  async liquidity(
    info: PoolInfo,
    quoteUsdPrice: number,
    baseDecimals: number,
  ): Promise<PoolLiquidity> {
    const quote = this.quoteFor(info.quoteToken);
    if (!quote) return { quoteUsd: 0, baseUsd: 0, totalUsd: 0 };

    const [quoteBal, baseBal] = await this.chain.multicall<bigint>([
      { address: info.quoteToken, abi: erc20Abi, functionName: 'balanceOf', args: [info.address] },
      { address: info.baseToken, abi: erc20Abi, functionName: 'balanceOf', args: [info.address] },
    ]);

    const quoteUsd =
      quoteBal?.status === 'success' && typeof quoteBal.result === 'bigint'
        ? fromUnits(quoteBal.result, quote.decimals) * quoteUsdPrice
        : 0;

    let baseUsd = 0;
    if (baseBal?.status === 'success' && typeof baseBal.result === 'bigint' && baseBal.result > 0n) {
      const spot = await this.spotPrice(info, baseDecimals);
      if (spot !== null && spot > 0) {
        baseUsd = fromUnits(baseBal.result, baseDecimals) * spot * quoteUsdPrice;
      }
    }

    return { quoteUsd, baseUsd, totalUsd: quoteUsd + baseUsd };
  }

  /**
   * Preço spot do token base em unidades de quote, lido do estado do pool.
   * Usado quando ainda não houve nenhum swap (alerta de launch).
   */
  async spotPrice(info: PoolInfo, baseDecimals: number): Promise<number | null> {
    const quote = this.quoteFor(info.quoteToken);
    if (!quote) return null;
    const baseIsToken0 = info.baseToken === info.token0;

    if (info.kind === 'v3') {
      const [slot0] = await this.chain.multicall<readonly unknown[]>([
        { address: info.address, abi: poolAbi, functionName: 'slot0' },
      ]);
      if (slot0?.status !== 'success' || !Array.isArray(slot0.result)) return null;
      const sqrtPriceX96 = slot0.result[0] as bigint;
      if (!sqrtPriceX96) return null;
      // preço de token1 em token0 = (sqrtPriceX96 / 2^96)^2
      const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
      const dec0 = baseIsToken0 ? baseDecimals : quote.decimals;
      const dec1 = baseIsToken0 ? quote.decimals : baseDecimals;
      const adjusted = ratio * 10 ** (dec0 - dec1);
      return baseIsToken0 ? adjusted : adjusted > 0 ? 1 / adjusted : null;
    }

    const [reserves] = await this.chain.multicall<readonly unknown[]>([
      { address: info.address, abi: poolAbi, functionName: 'getReserves' },
    ]);
    if (reserves?.status !== 'success' || !Array.isArray(reserves.result)) return null;
    const r0 = reserves.result[0] as bigint;
    const r1 = reserves.result[1] as bigint;
    const baseRaw = baseIsToken0 ? r0 : r1;
    const quoteRaw = baseIsToken0 ? r1 : r0;
    if (!baseRaw || baseRaw === 0n) return null;
    const base = fromUnits(baseRaw, baseDecimals);
    const quoteAmt = fromUnits(quoteRaw, quote.decimals);
    return base > 0 ? quoteAmt / base : null;
  }
}
