import type { ExecutionConfig, SizingConfig } from './config.js';

/**
 * Tipos compartilhados entre descoberta, risco, estratégia e execução.
 *
 * O desenho separa três preocupações que costumam virar um bolo só:
 *   - PairSnapshot  -> o MERCADO do token (preço, volume, liquidez) — vem de indexadores
 *   - OnchainTokenInfo / HolderStats / RugcheckSummary -> a SEGURANÇA do token
 *   - Broker        -> a EXECUÇÃO (paper ou live), atrás da mesma interface
 */

/** Rede suportada. 'solana' hoje; a expansão para a Robinhood Chain (EVM) entra aqui. */
export type ChainKey = 'solana';

export type TradeMode = 'paper' | 'live';

/** Foto do melhor par de um token num dado momento, normalizada do DexScreener. */
export interface PairSnapshot {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  quoteSymbol: string;
  priceUsd: number;
  /** Preço no token de cotação do par (SOL na maioria dos pares de memecoin). */
  priceNative: number | null;
  /**
   * null = o indexador não informou. null NÃO é zero: tratar liquidez
   * desconhecida como 0 dispararia a venda de emergência por "dreno de
   * liquidez" em cima de uma resposta parcial da API.
   */
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  vol5mUsd: number;
  vol1hUsd: number;
  vol24hUsd: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  change5mPct: number;
  change1hPct: number;
  change6hPct: number;
  change24hPct: number;
  /**
   * Idade do par em minutos, ou null quando o indexador não informa.
   * null NÃO é zero: tratar desconhecido como "recém-criado" faria as regras de
   * idade aprovarem/reprovarem token errado — o gate de idade só se aplica quando
   * a idade é conhecida.
   */
  ageMin: number | null;
  url: string | null;
}

/** Token candidato descoberto pelas fontes de tendência, antes do enriquecimento. */
export interface Candidate {
  mint: string;
  symbol: string;
  /** De onde veio: 'gt-trending' | 'gt-new' | 'ds-boosts'. Um token pode vir de várias. */
  sources: string[];
  /**
   * Quando o bot viu o mint NASCER (ms, evento do PumpPortal). Fallback de
   * idade para o gate quando o indexador ainda não datou o par — é um piso da
   * idade real, o que torna o gate de idade mínima conservador, nunca frouxo.
   */
  firstSeenTs?: number;
}

/** O que dá para ler do mint account direto do RPC, sem indexador. */
export interface OnchainTokenInfo {
  /** true = alguém ainda pode emitir supply novo (diluição infinita). */
  mintAuthorityActive: boolean;
  /** true = alguém pode congelar as contas dos holders (ninguém mais vende). */
  freezeAuthorityActive: boolean;
  /** Token-2022 (o padrão do pump.fun desde 2025 — não é suspeito por si só). */
  token2022: boolean;
  /** Extensões honeypot do Token-2022: permanentDelegate, transferHook, etc. */
  dangerousExtensions: string[];
  /** Extensões de taxa/juros: reduzem o que se recebe na venda. */
  taxingExtensions: string[];
  decimals: number;
  supplyRaw: bigint;
  supplyUi: number;
}

export interface HolderStats {
  /** % do supply na maior conta de token. Pode incluir o vault do pool — ver docs. */
  top1Pct: number;
  /** % do supply somando as 10 maiores contas. */
  top10Pct: number;
  holderCount: number | null;
  source: 'rugcheck' | 'onchain';
}

export type RugcheckSummary =
  | {
      available: true;
      /** true = o RugCheck já marcou o token como rugged. Fim de conversa. */
      rugged: boolean;
      /** 0–100, quanto maior pior (score_normalised do RugCheck). */
      scoreNormalized: number | null;
      /**
       * Flags danger NÃO relacionadas a LP (freeze, copycat, insider...).
       * As de LP ficam separadas porque duplicam o sinal de lpLockedPct e
       * disparam falso positivo em qualquer token com liquidez concentrada.
       */
      dangerFlags: string[];
      lpDangerFlags: string[];
      warnFlags: string[];
      /** % da liquidez travada/queimada, PONDERADA pela liquidez de cada mercado. */
      lpLockedPct: number | null;
      holderCount: number | null;
      /** Top 10 holders (%) já excluindo contas conhecidas de AMM/LP. */
      top10Pct: number | null;
    }
  | { available: false; reason: string };

/** Resultado de uma compra, no formato comum a paper e live. */
export interface BuyFill {
  tokensQty: number;
  solSpent: number;
  usdSpent: number;
  priceUsd: number;
  txSig: string | null;
  /** Onde executou: 'jupiter' | 'pumpportal' | 'paper'. */
  venue?: string;
}

/** Resultado de uma venda (parcial ou total). */
export interface SellFill {
  tokensSold: number;
  solReceived: number;
  usdReceived: number;
  priceUsd: number;
  txSig: string | null;
  /**
   * true = esta venda liquidou TUDO que havia de vendível (100% pedido, ou o
   * saldo real on-chain foi esvaziado). É o que fecha a posição — a
   * contabilidade local pode divergir do fill real (slippage, taxa de
   * transferência) e "remaining > 0" local não pode segurar a posição aberta.
   */
  soldAll: boolean;
  /** Onde executou: 'jupiter' | 'pumpportal' | 'paper'. */
  venue?: string;
}

/**
 * Execução de ordens. PaperBroker simula com preço real; LiveBroker manda swap
 * de verdade via Jupiter. O engine não sabe a diferença — é assim que o modo
 * paper exercita exatamente o mesmo caminho de código que o live.
 */
export interface Broker {
  readonly mode: TradeMode;
  /** Saldo em SOL disponível para operar (paper: saldo simulado persistido). */
  balanceSol(): Promise<number>;
  /**
   * Aplica um config salvo pelo painel em execução (slippage, sizing...).
   * Opcional: implementações de teste podem ignorar.
   */
  updateConfig?(exec: ExecutionConfig, sizing: SizingConfig): void;
  /**
   * Valor EXECUTÁVEL da posição agora, em SOL — a quote real de venda no
   * agregador, não o preço de tela. null = indisponível (paper, sem rota,
   * timeout); o chamador cai para o preço de indexador.
   *
   * Existe porque o preço de indexador MENTE na escala de segundos em que
   * memecoin recém-nascida vive — visto em produção: "stop loss -47%" que
   * vendeu com +10% real, "take profit +41%" que devolveu -39%.
   */
  markValueSol(mint: string, tokensQty: number): Promise<number | null>;
  buy(mint: string, solAmount: number, snap: PairSnapshot, solPriceUsd: number): Promise<BuyFill>;
  /**
   * Vende `portionPct`% da posição. `tokensQty` é a quantidade que o BOT acha
   * que tem; o live broker confere o saldo real on-chain e vende o menor dos dois.
   * `urgent` = saída de emergência (rug/stop): o live usa a slippage de
   * emergência para não ficar preso revertendo enquanto o pool esvazia.
   */
  sell(
    mint: string,
    tokensQty: number,
    portionPct: number,
    snap: PairSnapshot,
    solPriceUsd: number,
    urgent?: boolean,
  ): Promise<SellFill>;
}

/**
 * Leitura de segurança on-chain de uma rede. A Solana implementa hoje; uma rede
 * EVM (Robinhood Chain) implementa a mesma interface com viem no futuro.
 */
export interface ChainAdapter {
  readonly key: ChainKey;
  walletAddress(): string | null;
  nativeBalanceSol(): Promise<number>;
  /** Saldo do token na carteira, em unidades de UI. 0 quando não há carteira. */
  tokenBalanceUi(mint: string): Promise<number>;
  getOnchainTokenInfo(mint: string): Promise<OnchainTokenInfo | null>;
  getTopHolders(mint: string, info: OnchainTokenInfo): Promise<HolderStats | null>;
}
