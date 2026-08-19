import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Logger } from '../../log.js';
import type { ChainAdapter, ChainKey, OnchainTokenInfo, HolderStats } from '../../types.js';
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
    for (const url of rpcUrls) {
      try {
        const conn = new Connection(url, { commitment: 'confirmed' });
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
  async getTopHolders(mint: string, info: OnchainTokenInfo): Promise<HolderStats | null> {
    if (info.supplyRaw <= 0n) return null;
    const res = await this.conn.getTokenLargestAccounts(new PublicKey(mint));
    const amounts = res.value
      .map((a) => {
        try {
          return BigInt(a.amount);
        } catch {
          return 0n;
        }
      })
      .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    if (amounts.length === 0) return null;

    const pctOf = (raw: bigint) => Number((raw * 10_000n) / info.supplyRaw) / 100;
    const top1Pct = pctOf(amounts[0]!);
    const top10Pct = pctOf(amounts.slice(0, 10).reduce((a, b) => a + b, 0n));
    return { top1Pct, top10Pct, holderCount: null, source: 'onchain' };
  }

  /**
   * Assina, envia e confirma uma transação do Jupiter.
   *
   * A confirmação usa o blockhash da própria transação; se ela expirar sem
   * confirmar, o status é consultado uma última vez antes de desistir — "expirou"
   * e "falhou" são coisas diferentes de "não sei", e quem chama precisa saber qual foi.
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
      // Última chance: a tx pode ter confirmado e o await é que se perdeu.
      const status = await this.conn.getSignatureStatuses([signature]).catch(() => null);
      const st = status?.value?.[0];
      if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        return signature;
      }
      throw err;
    }
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
