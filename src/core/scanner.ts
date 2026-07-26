import type { Address } from 'viem';
import type { ChainClient, RawLog, TopicFilter } from './chain.js';
import { getCheckpoint, setCheckpoint, type Db } from './db.js';
import { isRetryableError } from './limiter.js';
import type { Logger } from './logger.js';

export interface ScanBatch {
  fromBlock: bigint;
  toBlock: bigint;
  logs: RawLog[];
  /** Timestamp do bloco, vindo do log quando o RPC o inclui (a Arc inclui). */
  timestampOf: (log: RawLog) => Promise<number>;
}

export interface ScannerOptions {
  scope: string;
  /**
   * Uma ou mais consultas de log por lote. Cada entrada vira um `eth_getLogs`;
   * os resultados são unidos e ordenados. Existe porque "criação de pool" e
   * "mint de token" são filtros de formato diferente e não cabem numa chamada só.
   */
  filters: Array<{ topics: TopicFilter; address?: Address[] }>;
  /** Bloco inicial quando não há checkpoint. Ausente = começa da cabeça da chain. */
  startBlock?: bigint;
  pollIntervalMs?: number;
  /** Quantos blocos voltar quando um reorg é detectado. */
  reorgRewind?: number;
  idleCallback?: (head: bigint) => void | Promise<void>;
}

/**
 * Varredura de logs com checkpoint durável e tolerância a reorg.
 *
 * Escolhas que importam:
 *  - filtra por topic0 SEM lista de endereços, então descobre DEX nova sem redeploy;
 *  - o checkpoint só avança depois que o handler termina, então um crash reprocessa
 *    o lote em vez de pular alertas (o handler precisa ser idempotente — os índices
 *    únicos no SQLite garantem isso);
 *  - a janela de blocos encolhe sozinha quando o RPC reclama do tamanho.
 */
export class LogScanner {
  private running = false;
  private currentRange: number;

  constructor(
    private readonly chain: ChainClient,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly opts: ScannerOptions,
  ) {
    this.currentRange = chain.network.maxBlockRange;
  }

  stop(): void {
    this.running = false;
  }

  async run(handler: (batch: ScanBatch) => Promise<void>): Promise<void> {
    this.running = true;
    const { confirmations, blockTimeMs } = this.chain.network;
    const pollMs = this.opts.pollIntervalMs ?? Math.max(1_000, blockTimeMs * 4);

    let cursor = await this.resolveStart();
    this.log.info({ startBlock: cursor.toString(), scope: this.opts.scope }, 'scanner iniciado');

    while (this.running) {
      try {
        const head = await this.chain.getBlockNumber();
        const safeHead = head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n;

        if (safeHead <= cursor) {
          await this.opts.idleCallback?.(head);
          await sleep(pollMs);
          continue;
        }

        cursor = await this.handleReorg(cursor);

        const from = cursor + 1n;
        const to = min(from + BigInt(this.currentRange) - 1n, safeHead);

        const logs = await this.fetchLogs(from, to);
        await handler({
          fromBlock: from,
          toBlock: to,
          logs,
          timestampOf: (l) => this.timestampOf(l),
        });

        const hash = await this.chain.getBlockHash(to);
        setCheckpoint(this.db, this.opts.scope, to, hash);
        cursor = to;

        this.log.debug(
          { from: from.toString(), to: to.toString(), logs: logs.length, lag: (safeHead - to).toString() },
          'lote processado',
        );

        // Se ainda há atraso, não dorme — puxa o próximo lote imediatamente.
        if (to < safeHead) continue;
        await sleep(pollMs);
      } catch (err) {
        if (isRetryableError(err)) {
          this.log.warn({ err: String(err) }, 'erro transitório no scanner, retentando');
          await sleep(pollMs * 2);
        } else {
          this.log.error({ err }, 'erro no scanner');
          await sleep(pollMs * 4);
        }
      }
    }
  }

  private async resolveStart(): Promise<bigint> {
    const checkpoint = getCheckpoint(this.db, this.opts.scope);
    if (checkpoint) return checkpoint.block;
    if (this.opts.startBlock !== undefined) return this.opts.startBlock - 1n;
    const head = await this.chain.getBlockNumber();
    return head > BigInt(this.chain.network.confirmations)
      ? head - BigInt(this.chain.network.confirmations)
      : 0n;
  }

  /**
   * Se o hash do último bloco processado mudou, a chain reorganizou:
   * volta `reorgRewind` blocos e reprocessa. O handler é idempotente, então
   * reprocessar é seguro; perder blocos não seria.
   */
  private async handleReorg(cursor: bigint): Promise<bigint> {
    const checkpoint = getCheckpoint(this.db, this.opts.scope);
    if (!checkpoint?.hash || checkpoint.block !== cursor) return cursor;

    const currentHash = await this.chain.getBlockHash(cursor);
    if (currentHash === null || currentHash === checkpoint.hash) return cursor;

    const rewind = BigInt(this.opts.reorgRewind ?? 32);
    const rewound = cursor > rewind ? cursor - rewind : 0n;
    this.log.warn(
      { at: cursor.toString(), rewindTo: rewound.toString(), expected: checkpoint.hash, got: currentHash },
      'reorg detectado, voltando o cursor',
    );
    setCheckpoint(this.db, this.opts.scope, rewound, null);
    return rewound;
  }

  private async fetchLogs(from: bigint, to: bigint): Promise<RawLog[]> {
    try {
      const batches = await Promise.all(
        this.opts.filters.map((filter) =>
          this.chain.getLogs({
            fromBlock: from,
            toBlock: to,
            topics: filter.topics,
            ...(filter.address ? { address: filter.address } : {}),
          }),
        ),
      );
      // Sucesso: volta devagar para a janela cheia.
      if (this.currentRange < this.chain.network.maxBlockRange) {
        this.currentRange = Math.min(this.chain.network.maxBlockRange, Math.ceil(this.currentRange * 1.5));
      }
      return batches.flat().sort(compareLogs);
    } catch (err) {
      const span = Number(to - from) + 1;
      if (span > 1 && isRangeError(err)) {
        this.currentRange = Math.max(1, Math.floor(span / 2));
        this.log.warn({ newRange: this.currentRange }, 'RPC recusou a janela de blocos, reduzindo');
        return this.fetchLogs(from, from + BigInt(this.currentRange) - 1n);
      }
      throw err;
    }
  }

  private async timestampOf(log: RawLog): Promise<number> {
    const blockNumber = BigInt(log.blockNumber);
    if (log.blockTimestamp) {
      const ts = Number(BigInt(log.blockTimestamp));
      this.chain.rememberTimestamp(blockNumber, ts);
      return ts;
    }
    return this.chain.getBlockTimestamp(blockNumber);
  }
}

function isRangeError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes('range') ||
    msg.includes('too many') ||
    msg.includes('limit exceeded') ||
    msg.includes('query returned more than')
  );
}

/** Ordem cronológica real: bloco, depois posição do log dentro do bloco. */
function compareLogs(a: RawLog, b: RawLog): number {
  const blockDiff = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (blockDiff !== 0n) return blockDiff < 0n ? -1 : 1;
  return Number(BigInt(a.logIndex) - BigInt(b.logIndex));
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
