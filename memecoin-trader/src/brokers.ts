import type { ExecutionConfig, SizingConfig } from './config.js';
import { kvGet, kvSet, type Db } from './db.js';
import { JupiterClient } from './chains/solana/jupiter.js';
import { LAMPORTS_PER_SOL, SolanaChain } from './chains/solana/index.js';
import { rawToUi } from './chains/solana/mint.js';
import { fetchTradeLocalTx, isNoRouteError } from './chains/solana/pumpportal-trade.js';
import { WSOL_MINT } from './datasources/dexscreener.js';
import type { Logger } from './log.js';
import type { Broker, BuyFill, PairSnapshot, SellFill } from './types.js';

/**
 * Os dois executores atrás da mesma interface. O engine não distingue —
 * é isso que garante que o modo paper testa o MESMO fluxo do live.
 */

/**
 * A carteira não tem NADA deste token para vender. Erro tipado porque o engine
 * reage a ele: numa venda de 100% isso significa posição-zumbi (crash após a
 * venda confirmar, ou tokens movidos por fora) — fecha e contabiliza, em vez
 * de re-tentar a mesma venda impossível para sempre.
 */
export class NoBalanceError extends Error {
  constructor(mint: string) {
    super(`Sem saldo on-chain de ${mint} para vender`);
    this.name = 'NoBalanceError';
  }
}

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
    return { tokensQty, solSpent: solAmount, usdSpent, priceUsd: effPrice, txSig: null, venue: 'paper' };
  }

  async sell(
    _mint: string,
    tokensQty: number,
    portionPct: number,
    snap: PairSnapshot,
    solPriceUsd: number,
    _urgent = false,
  ): Promise<SellFill> {
    if (solPriceUsd <= 0) throw new Error('Preço do SOL indisponível para o fill simulado');
    const pct = Math.min(100, Math.max(0, portionPct));
    const tokensSold = tokensQty * (pct / 100);
    // Slippage simulada: venda sai mais barata que o preço de tela.
    const effPrice = snap.priceUsd * (1 - this.exec.paperSlippagePct / 100);
    const usdReceived = tokensSold * effPrice;
    const solReceived = usdReceived / solPriceUsd;

    const balance = await this.balanceSol();
    kvSet(this.db, PAPER_BALANCE_KEY, String(balance + solReceived));
    return {
      tokensSold,
      solReceived,
      usdReceived,
      priceUsd: effPrice,
      txSig: null,
      soldAll: pct >= 100,
      venue: 'paper',
    };
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
    let quote;
    try {
      quote = await this.jupiter.quote(WSOL_MINT, mint, lamports, this.exec.slippageBps);
    } catch (err) {
      // Token recém-criado/graduado ainda fora do índice de rotas do Jupiter —
      // a janela exata do scalp. Executa direto no pump.fun via PumpPortal.
      if (this.exec.pumpportalFallback && isNoRouteError(err)) {
        this.log.warn({ mint }, 'Jupiter sem rota — comprando via pump.fun (PumpPortal)');
        return this.buyViaPumpPortal(mint, solAmount, solPriceUsd);
      }
      throw err;
    }
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
    return { tokensQty, solSpent, usdSpent, priceUsd, txSig, venue: 'jupiter' };
  }

  /**
   * Compra via PumpPortal trade-local. O fill é medido pelo DELTA DE SALDO
   * real da carteira — mais honesto que qualquer quote.
   */
  private async buyViaPumpPortal(
    mint: string,
    solAmount: number,
    solPriceUsd: number,
  ): Promise<BuyFill> {
    const wallet = this.chain.walletAddress();
    if (!wallet) throw new Error('Modo live sem carteira carregada');

    const tokensBefore = await this.chain.tokenBalanceUi(mint);
    const txBytes = await fetchTradeLocalTx({
      publicKey: wallet,
      action: 'buy',
      mint,
      amount: solAmount,
      denominatedInSol: true,
      slippagePct: this.exec.slippageBps / 100,
      priorityFeeSol: this.exec.maxPriorityFeeLamports / LAMPORTS_PER_SOL,
    });
    const txSig = await this.chain.signSendAndConfirm(
      Buffer.from(txBytes).toString('base64'),
      null,
      this.exec.confirmTimeoutSec,
    );

    const tokensQty = (await this.chain.tokenBalanceUi(mint)) - tokensBefore;
    if (tokensQty <= 0) {
      throw new Error(`Compra via pump.fun confirmou mas nenhum token chegou — confira ${txSig}`);
    }
    const usdSpent = solAmount * solPriceUsd;
    this.log.info({ mint, txSig, solSpent: solAmount, tokensQty }, 'Compra via pump.fun confirmada');
    return {
      tokensQty,
      solSpent: solAmount,
      usdSpent,
      priceUsd: usdSpent / tokensQty,
      txSig,
      venue: 'pumpportal',
    };
  }

  /** Venda via PumpPortal trade-local, com SOL recebido medido pelo delta de saldo. */
  private async sellViaPumpPortal(
    mint: string,
    tokensSold: number,
    soldAll: boolean,
    snap: PairSnapshot,
    solPriceUsd: number,
  ): Promise<SellFill> {
    const wallet = this.chain.walletAddress();
    if (!wallet) throw new Error('Modo live sem carteira carregada');

    const solBefore = await this.chain.nativeBalanceSol();
    const txBytes = await fetchTradeLocalTx({
      publicKey: wallet,
      action: 'sell',
      mint,
      amount: tokensSold,
      denominatedInSol: false,
      slippagePct: this.exec.emergencySlippageBps / 100,
      priorityFeeSol: this.exec.maxPriorityFeeLamports / LAMPORTS_PER_SOL,
    });
    const txSig = await this.chain.signSendAndConfirm(
      Buffer.from(txBytes).toString('base64'),
      null,
      this.exec.confirmTimeoutSec,
    );

    const solReceived = Math.max(0, (await this.chain.nativeBalanceSol()) - solBefore);
    const usdReceived = solReceived * solPriceUsd;
    const priceUsd = tokensSold > 0 && usdReceived > 0 ? usdReceived / tokensSold : snap.priceUsd;
    this.log.info({ mint, txSig, tokensSold, solReceived }, 'Venda via pump.fun confirmada');
    return { tokensSold, solReceived, usdReceived, priceUsd, txSig, soldAll, venue: 'pumpportal' };
  }

  async sell(
    mint: string,
    tokensQty: number,
    portionPct: number,
    snap: PairSnapshot,
    solPriceUsd: number,
    urgent = false,
  ): Promise<SellFill> {
    // A verdade é o saldo on-chain, não a contabilidade local: airdrop, dust de
    // arredondamento ou uma venda manual fora do bot deixariam o número local errado.
    const { raw, decimals } = await this.chain.tokenBalanceRaw(mint);
    if (raw <= 0n) throw new NoBalanceError(mint);

    const pct = Math.min(100, Math.max(0, portionPct));
    const bookkeepingRaw = BigInt(Math.floor(tokensQty * 10 ** decimals));
    const baseRaw = bookkeepingRaw > 0n && bookkeepingRaw < raw ? bookkeepingRaw : raw;
    const sellRaw = pct >= 100 ? baseRaw : (baseRaw * BigInt(Math.round(pct * 100))) / 10_000n;
    if (sellRaw <= 0n) throw new Error('Quantidade de venda arredondou para zero');

    // Saída urgente (rug/stop): slippage larga. Num pool sendo drenado, a
    // slippage normal faz a venda reverter tick após tick enquanto o preço
    // derrete — preço ruim aceito é melhor que preço nenhum.
    const slippageBps = urgent ? this.exec.emergencySlippageBps : this.exec.slippageBps;
    let quote;
    try {
      quote = await this.jupiter.quote(mint, WSOL_MINT, sellRaw, slippageBps);
    } catch (err) {
      // Sem rota no Jupiter, a SAÍDA não pode ficar presa: vende pela curve/
      // pumpswap direto. Slippage de emergência — sair vale mais que o preço.
      if (this.exec.pumpportalFallback && isNoRouteError(err)) {
        this.log.warn({ mint }, 'Jupiter sem rota — vendendo via pump.fun (PumpPortal)');
        return this.sellViaPumpPortal(
          mint,
          rawToUi(sellRaw, decimals),
          pct >= 100 || sellRaw === raw,
          snap,
          solPriceUsd,
        );
      }
      throw err;
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

    const tokensSold = rawToUi(sellRaw, decimals);
    const solReceived = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    const usdReceived = solReceived * solPriceUsd;
    const priceUsd = tokensSold > 0 && usdReceived > 0 ? usdReceived / tokensSold : snap.priceUsd;

    this.log.info({ mint, txSig, tokensSold, solReceived }, 'Venda live confirmada');
    // soldAll: 100% pedido OU o saldo real foi esvaziado. A contabilidade local
    // pode achar que "sobrou" (fill < quote, taxa de transferência) — se a
    // carteira zerou, não existe mais nada vendível e a posição TEM que fechar.
    return {
      tokensSold,
      solReceived,
      usdReceived,
      priceUsd,
      txSig,
      soldAll: pct >= 100 || sellRaw === raw,
      venue: 'jupiter',
    };
  }
}
