import type { ExecutionConfig, SizingConfig } from './config.js';
import { kvGet, kvSet, type Db } from './db.js';
import { JupiterClient } from './chains/solana/jupiter.js';
import { LAMPORTS_PER_SOL, SolanaChain } from './chains/solana/index.js';
import { rawToUi } from './chains/solana/mint.js';
import { WSOL_MINT } from './datasources/dexscreener.js';
import type { Logger } from './log.js';
import type { Broker, BuyFill, PairSnapshot, SellFill } from './types.js';

/**
 * Os dois executores atrás da mesma interface. O engine não distingue —
 * é isso que garante que o modo paper testa o MESMO fluxo do live.
 */

// ─────────────────────────────────────────────────────────────
//  Paper: simula fills com o preço real de mercado
// ─────────────────────────────────────────────────────────────

const PAPER_BALANCE_KEY = 'paper_balance_sol';

export class PaperBroker implements Broker {
  readonly mode = 'paper' as const;

  constructor(
    private readonly db: Db,
    private readonly exec: ExecutionConfig,
    private readonly sizing: SizingConfig,
  ) {}

  async balanceSol(): Promise<number> {
    const stored = kvGet(this.db, PAPER_BALANCE_KEY);
    if (stored === null) {
      kvSet(this.db, PAPER_BALANCE_KEY, String(this.sizing.paperStartBalanceSol));
      return this.sizing.paperStartBalanceSol;
    }
    const value = Number(stored);
    return Number.isFinite(value) ? value : 0;
  }

  /** Zera o caixa simulado de volta ao valor inicial do config. */
  async reset(): Promise<void> {
    kvSet(this.db, PAPER_BALANCE_KEY, String(this.sizing.paperStartBalanceSol));
  }

  async buy(
    _mint: string,
    solAmount: number,
    snap: PairSnapshot,
    solPriceUsd: number,
  ): Promise<BuyFill> {
    if (solPriceUsd <= 0) throw new Error('Preço do SOL indisponível para o fill simulado');
    const balance = await this.balanceSol();
    if (solAmount > balance) {
      throw new Error(`Saldo paper insuficiente: ${balance.toFixed(4)} SOL < ${solAmount.toFixed(4)}`);
    }
    // Slippage simulada: compra sai mais cara que o preço de tela.
    const effPrice = snap.priceUsd * (1 + this.exec.paperSlippagePct / 100);
    const usdSpent = solAmount * solPriceUsd;
    const tokensQty = usdSpent / effPrice;

    kvSet(this.db, PAPER_BALANCE_KEY, String(balance - solAmount));
    return { tokensQty, solSpent: solAmount, usdSpent, priceUsd: effPrice, txSig: null };
  }

  async sell(
    _mint: string,
    tokensQty: number,
    portionPct: number,
    snap: PairSnapshot,
    solPriceUsd: number,
  ): Promise<SellFill> {
    if (solPriceUsd <= 0) throw new Error('Preço do SOL indisponível para o fill simulado');
    const tokensSold = tokensQty * (Math.min(100, Math.max(0, portionPct)) / 100);
    // Slippage simulada: venda sai mais barata que o preço de tela.
    const effPrice = snap.priceUsd * (1 - this.exec.paperSlippagePct / 100);
    const usdReceived = tokensSold * effPrice;
    const solReceived = usdReceived / solPriceUsd;

    const balance = await this.balanceSol();
    kvSet(this.db, PAPER_BALANCE_KEY, String(balance + solReceived));
    return { tokensSold, solReceived, usdReceived, priceUsd: effPrice, txSig: null };
  }
}

// ─────────────────────────────────────────────────────────────
//  Live: swaps reais via Jupiter
// ─────────────────────────────────────────────────────────────

export class LiveBroker implements Broker {
  readonly mode = 'live' as const;

  /** Cache de decimals por mint — não muda nunca, não precisa reler do RPC. */
  private readonly decimalsCache = new Map<string, number>();

  constructor(
    private readonly chain: SolanaChain,
    private readonly jupiter: JupiterClient,
    private readonly exec: ExecutionConfig,
    private readonly log: Logger,
  ) {}

  async balanceSol(): Promise<number> {
    return this.chain.nativeBalanceSol();
  }

  private async mintDecimals(mint: string): Promise<number> {
    const cached = this.decimalsCache.get(mint);
    if (cached !== undefined) return cached;
    const info = await this.chain.getOnchainTokenInfo(mint);
    if (!info) throw new Error(`Não consegui ler decimals do mint ${mint}`);
    this.decimalsCache.set(mint, info.decimals);
    return info.decimals;
  }

  async buy(
    mint: string,
    solAmount: number,
    snap: PairSnapshot,
    solPriceUsd: number,
  ): Promise<BuyFill> {
    const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
    if (lamports <= 0n) throw new Error('Valor de compra zerado');

    const decimals = await this.mintDecimals(mint);
    const quote = await this.jupiter.quote(WSOL_MINT, mint, lamports, this.exec.slippageBps);
    if (quote.priceImpactPct !== null && quote.priceImpactPct > 10) {
      throw new Error(
        `Impacto de preço de ${quote.priceImpactPct.toFixed(1)}% na compra — pool raso demais para esta ordem`,
      );
    }

    const wallet = this.chain.walletAddress();
    if (!wallet) throw new Error('Modo live sem carteira carregada');
    const { txBase64, lastValidBlockHeight } = await this.jupiter.swapTransaction(
      quote,
      wallet,
      this.exec.maxPriorityFeeLamports,
    );
    const txSig = await this.chain.signSendAndConfirm(
      txBase64,
      lastValidBlockHeight,
      this.exec.confirmTimeoutSec,
    );

    // Quantidades vêm da QUOTE (o fill real pode variar dentro da slippage).
    // Preciso o suficiente para a contabilidade; a assinatura fica registrada
    // para auditoria fina no explorer.
    const solSpent = Number(quote.inAmount) / LAMPORTS_PER_SOL;
    const tokensQty = rawToUi(quote.outAmount, decimals);
    const usdSpent = solSpent * solPriceUsd;
    const priceUsd = tokensQty > 0 ? usdSpent / tokensQty : snap.priceUsd;

    this.log.info({ mint, txSig, solSpent, tokensQty }, 'Compra live confirmada');
    return { tokensQty, solSpent, usdSpent, priceUsd, txSig };
  }

  async sell(
    mint: string,
    tokensQty: number,
    portionPct: number,
    snap: PairSnapshot,
    solPriceUsd: number,
  ): Promise<SellFill> {
    // A verdade é o saldo on-chain, não a contabilidade local: airdrop, dust de
    // arredondamento ou uma venda manual fora do bot deixariam o número local errado.
    const { raw, decimals } = await this.chain.tokenBalanceRaw(mint);
    if (raw <= 0n) throw new Error(`Sem saldo on-chain de ${mint} para vender`);

    const pct = Math.min(100, Math.max(0, portionPct));
    const bookkeepingRaw = BigInt(Math.floor(tokensQty * 10 ** decimals));
    const baseRaw = bookkeepingRaw > 0n && bookkeepingRaw < raw ? bookkeepingRaw : raw;
    const sellRaw = pct >= 100 ? baseRaw : (baseRaw * BigInt(Math.round(pct * 100))) / 10_000n;
    if (sellRaw <= 0n) throw new Error('Quantidade de venda arredondou para zero');

    const quote = await this.jupiter.quote(mint, WSOL_MINT, sellRaw, this.exec.slippageBps);
    const wallet = this.chain.walletAddress();
    if (!wallet) throw new Error('Modo live sem carteira carregada');
    const { txBase64, lastValidBlockHeight } = await this.jupiter.swapTransaction(
      quote,
      wallet,
      this.exec.maxPriorityFeeLamports,
    );
    const txSig = await this.chain.signSendAndConfirm(
      txBase64,
      lastValidBlockHeight,
      this.exec.confirmTimeoutSec,
    );

    const tokensSold = rawToUi(sellRaw, decimals);
    const solReceived = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    const usdReceived = solReceived * solPriceUsd;
    const priceUsd = tokensSold > 0 && usdReceived > 0 ? usdReceived / tokensSold : snap.priceUsd;

    this.log.info({ mint, txSig, tokensSold, solReceived }, 'Venda live confirmada');
    return { tokensSold, solReceived, usdReceived, priceUsd, txSig };
  }
}
