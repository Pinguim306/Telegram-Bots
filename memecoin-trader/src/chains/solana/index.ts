import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Logger } from '../../log.js';
import type { ChainAdapter, ChainKey, OnchainTokenInfo, HolderStats } from '../../types.js';
import { analyzeHolderLinkage } from './linkage.js';
import {
  MINT_ACCOUNT_MIN_SIZE,
  parseMintAccount,
  parseToken2022Extensions,
  rawToUi,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './mint.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * O destino da transação NÃO pôde ser determinado: ela foi transmitida, mas o
 * RPC não respondeu se confirmou nem se expirou. Quem captura este erro sabe
 * que pode haver tokens/SOL em trânsito e deve reconciliar pelo saldo real.
 */
export class UnknownTxOutcomeError extends Error {
  constructor(readonly signature: string, detail: string) {
    super(
      `Destino da transação ${signature} DESCONHECIDO (${detail}). ` +
        'Ela pode ter executado — confira o saldo/explorer antes de repetir a ordem.',
    );
    this.name = 'UnknownTxOutcomeError';
  }
}

/**
 * Matemática pura da concentração de holders — exportada para teste.
 * Base do percentual = supply MENOS as contas excluídas (circulante).
 */
export function computeHolderStats(
  entries: { address: string; raw: bigint }[],
  supplyRaw: bigint,
  excludeAccounts: string[] = [],
): HolderStats | null {
  const exclude = new Set(excludeAccounts);
  let excludedRaw = 0n;
  const held: bigint[] = [];
  for (const e of entries) {
    if (exclude.has(e.address)) excludedRaw += e.raw;
    else held.push(e.raw);
  }
  const base = supplyRaw - excludedRaw;
  if (base <= 0n || held.length === 0) return null;

  held.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const pctOf = (raw: bigint) => Number((raw * 10_000n) / base) / 100;
  return {
    top1Pct: pctOf(held[0]!),
    top10Pct: pctOf(held.slice(0, 10).reduce((a, b) => a + b, 0n)),
    holderCount: null,
    source: 'onchain',
  };
}

/**
 * Adapter da Solana: leitura de segurança on-chain + envio de transação.
 *
 * A keypair é opcional de propósito — o modo paper roda a análise de risco
 * on-chain inteira sem nenhuma chave configurada.
 */
export class SolanaChain implements ChainAdapter {
  readonly key: ChainKey = 'solana';

  constructor(
    readonly conn: Connection,
    private readonly keypair: Keypair | null,
    private readonly log: Logger,
  ) {}

  /**
   * Conecta na primeira URL que responder um getLatestBlockhash. Failover de
   * boot, não de runtime: RPC que morre no meio do loop vira erro de tick, e o
   * tick seguinte tenta de novo.
   */
  static async connect(rpcUrls: string[], keypair: Keypair | null, log: Logger): Promise<SolanaChain> {
    let lastErr: Error | null = null;
    // Toda requisição HTTP do web3.js ganha um teto: sem isso, um RPC que
    // aceita a conexão e trava pendura o tick por minutos — com o stop loss
    // parado enquanto a memecoin despenca. 10s por requisição; o polling de
    // confirmação faz várias requisições curtas, então isso não conflita com
    // o confirmTimeoutSec.
    const rpcFetch = ((input: any, init?: any) =>
      fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) })) as typeof fetch;
    for (const url of rpcUrls) {
      try {
        const conn = new Connection(url, { commitment: 'confirmed', fetch: rpcFetch });
        await withTimeout(conn.getLatestBlockhash(), 6_000, `RPC ${url} não respondeu`);
        log.info({ rpc: url }, 'RPC da Solana conectado');
        return new SolanaChain(conn, keypair, log);
      } catch (err) {
        lastErr = err as Error;
        log.warn({ rpc: url, err: (err as Error).message }, 'RPC falhou, tentando o próximo');
      }
    }
    throw new Error(`Nenhum RPC da Solana respondeu (${rpcUrls.join(', ')}): ${lastErr?.message}`);
  }

  walletAddress(): string | null {
    return this.keypair ? this.keypair.publicKey.toBase58() : null;
  }

  requireKeypair(): Keypair {
    if (!this.keypair) {
      throw new Error('Operação exige carteira configurada (SOLANA_PRIVATE_KEY no .env).');
    }
    return this.keypair;
  }

  async nativeBalanceSol(): Promise<number> {
    if (!this.keypair) return 0;
    const lamports = await this.conn.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /** Saldo do token em unidades de UI. 0 sem carteira (modo paper). */
  async tokenBalanceUi(mint: string): Promise<number> {
    if (!this.keypair) return 0;
    const { raw, decimals } = await this.tokenBalanceRaw(mint);
    return rawToUi(raw, decimals);
  }

  /** Saldo total de um token na carteira (somando todas as token accounts). */
  async tokenBalanceRaw(mint: string): Promise<{ raw: bigint; decimals: number }> {
    const owner = this.requireKeypair().publicKey;
    const res = await this.conn.getParsedTokenAccountsByOwner(owner, {
      mint: new PublicKey(mint),
    });
    let raw = 0n;
    let decimals = 0;
    for (const { account } of res.value) {
      const info = (account.data as { parsed?: { info?: Record<string, any> } }).parsed?.info;
      const amount = info?.tokenAmount?.amount;
      if (typeof amount === 'string' && /^\d+$/.test(amount)) raw += BigInt(amount);
      if (typeof info?.tokenAmount?.decimals === 'number') decimals = info.tokenAmount.decimals;
    }
    return { raw, decimals };
  }

  /**
   * Lê o mint account cru e extrai o que interessa para risco: authorities
   * ativas, decimals, supply e se é Token-2022.
   */
  async getOnchainTokenInfo(mint: string): Promise<OnchainTokenInfo | null> {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(mint);
    } catch {
      return null;
    }
    const account = await this.conn.getAccountInfo(pubkey);
    if (!account || account.data.length < MINT_ACCOUNT_MIN_SIZE) return null;

    const owner = account.owner.toBase58();
    const token2022 = owner === TOKEN_2022_PROGRAM_ID;
    if (owner !== TOKEN_PROGRAM_ID && !token2022) return null;

    const data = new Uint8Array(account.data);
    const parsed = parseMintAccount(data);
    if (!parsed) return null;

    const extensions = token2022
      ? parseToken2022Extensions(data)
      : { all: [], dangerous: [], taxing: [] };

    return {
      mintAuthorityActive: parsed.mintAuthorityActive,
      freezeAuthorityActive: parsed.freezeAuthorityActive,
      token2022,
      dangerousExtensions: extensions.dangerous,
      taxingExtensions: extensions.taxing,
      decimals: parsed.decimals,
      supplyRaw: parsed.supplyRaw,
      supplyUi: rawToUi(parsed.supplyRaw, parsed.decimals),
    };
  }

  /**
   * Concentração de holders pelas 20 maiores token accounts.
   *
   * Heurística com limitação conhecida: vaults de pool APARECEM na lista (o RPC
   * não sabe o que é AMM). O risco usa o dado do RugCheck quando disponível —
   * este é o fallback, e os limiares do config devem ser mais frouxos por isso.
   */
  /**
   * Concentração dos maiores holders. `excludeAccounts` remove contas
   * ESTRUTURAIS (o vault da bonding curve) e muda a base do percentual para o
   * supply CIRCULANTE — é o que transforma "a curve tem 90%" (inútil) em
   * "3 carteiras têm 80% do que circula" (o sinal de sniper que importa).
   */
  async getTopHolders(
    mint: string,
    info: OnchainTokenInfo,
    excludeAccounts: string[] = [],
  ): Promise<HolderStats | null> {
    if (info.supplyRaw <= 0n) return null;
    const res = await this.conn.getTokenLargestAccounts(new PublicKey(mint));
    const entries = res.value.map((a) => {
      let raw = 0n;
      try {
        raw = BigInt(a.amount);
      } catch {
        // conta ilegível conta como zero
      }
      return { address: a.address.toBase58(), raw };
    });
    return computeHolderStats(entries, info.supplyRaw, excludeAccounts);
  }

  /** Ligação entre carteiras do topo — ver src/chains/solana/linkage.ts. */
  async getHolderLinkage(
    mint: string,
    excludeAccounts: string[],
    opts: { topN: number; slotTolerance: number },
  ) {
    return analyzeHolderLinkage(this.conn, mint, excludeAccounts, opts);
  }

  /**
   * Assina, envia e confirma uma transação do Jupiter.
   *
   * O envio é irrevogável: depois do sendRawTransaction a tx segue válida até
   * lastValidBlockHeight, MESMO que o await de confirmação estoure o timeout.
   * Tratar "timeout" como "não executou" faria o chamador repetir uma ordem
   * que já aconteceu (compra órfã sem stop loss, ou venda dupla). Por isso um
   * timeout aqui nunca vira erro genérico — o destino é resolvido de verdade:
   * confirmada (retorna), falhada, expirada (seguro repetir) ou, no pior caso,
   * UnknownTxOutcomeError, que manda o chamador reconciliar pelo saldo real.
   */
  async signSendAndConfirm(
    txBase64: string,
    lastValidBlockHeight: number | null,
    confirmTimeoutSec: number,
  ): Promise<string> {
    const keypair = this.requireKeypair();
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
    tx.sign([keypair]);

    const signature = await this.conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    this.log.info({ signature }, 'Transação enviada, aguardando confirmação');

    const blockhash = tx.message.recentBlockhash;
    const lvbh =
      lastValidBlockHeight ?? (await this.conn.getLatestBlockhash()).lastValidBlockHeight;

    try {
      const result = await withTimeout(
        this.conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight: lvbh },
          'confirmed',
        ),
        confirmTimeoutSec * 1000,
        `Confirmação de ${signature} estourou ${confirmTimeoutSec}s`,
      );
      if (result.value.err) {
        throw new Error(`Transação ${signature} falhou on-chain: ${JSON.stringify(result.value.err)}`);
      }
      return signature;
    } catch (err) {
      if (err instanceof Error && err.message.includes('falhou on-chain')) throw err;
      return this.resolveOutcome(signature, lvbh);
    }
  }

  /**
   * Resolve o destino de uma tx já transmitida cujo confirm falhou/estourou.
   * Só sai daqui com uma resposta VERDADEIRA: confirmada, falhada on-chain,
   * expirada sem executar (blockhash vencido = nunca mais entra) — ou, se o
   * RPC não colaborar em 120s, UnknownTxOutcomeError, nunca um falso "falhou".
   */
  private async resolveOutcome(signature: string, lastValidBlockHeight: number): Promise<string> {
    const deadline = Date.now() + 120_000;
    let expiredSince: number | null = null;

    while (Date.now() < deadline) {
      let status: { err: unknown; confirmationStatus?: string | null } | null = null;
      let height: number | null = null;
      try {
        status = (await this.conn.getSignatureStatuses([signature])).value[0] ?? null;
        height = await this.conn.getBlockHeight('confirmed');
      } catch {
        // RPC piscou durante o poll — tenta de novo até o deadline.
      }

      if (status?.err) {
        throw new Error(`Transação ${signature} falhou on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        this.log.info({ signature }, 'Transação confirmou depois do timeout inicial');
        return signature;
      }
      if (height !== null && height > lastValidBlockHeight && status === null) {
        // Blockhash vencido e nenhum sinal da tx. Margem de 10s porque o status
        // de uma inclusão no último bloco válido pode demorar a aparecer.
        if (expiredSince === null) expiredSince = Date.now();
        else if (Date.now() - expiredSince > 10_000) {
          throw new Error(
            `Transação ${signature} expirou sem executar (blockhash vencido) — seguro repetir a ordem`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new UnknownTxOutcomeError(signature, 'sem resposta definitiva do RPC em 120s');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
