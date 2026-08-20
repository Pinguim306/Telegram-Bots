import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import type { TradeMode } from './types.js';

dotenv.config({ quiet: true });

const here = dirname(fileURLToPath(import.meta.url));
/** src/ -> raiz do projeto (funciona igual rodando de src/ ou de dist/). */
export const projectRoot = resolve(here, '..');

// ─────────────────────────────────────────────────────────────
//  Schema do config/trader.json
// ─────────────────────────────────────────────────────────────

const loopSchema = z.object({
  tickSec: z.number().int().min(5),
  candidatesPerTick: z.number().int().min(1).max(20),
  /** Quanto tempo um token avaliado fica fora de nova análise (poupa RugCheck/RPC). */
  tokenCooldownMin: z.number().min(1),
});

const discoverySchema = z.object({
  geckoTrending: z.boolean(),
  geckoNew: z.boolean(),
  dexscreenerBoosts: z.boolean(),
  /**
   * Feed websocket do PumpPortal (pump.fun em tempo real) — fonte primária da
   * estratégia de curve: cada mint novo e cada graduação entram numa watchlist
   * e são reavaliados pelos gates a cada tick enquanto durar a janela.
   */
  pumpportal: z.object({
    enabled: z.boolean(),
    /** Assinar mints novos (milhares/dia — os gates filtram). */
    newMints: z.boolean(),
    /** Assinar graduações (curve → pumpswap) — o momento clássico de entrada. */
    migrations: z.boolean(),
    /** Quantos minutos um mint fica na watchlist sendo reavaliado. */
    watchWindowMin: z.number().int().min(1),
  }),
  /**
   * Idade máxima do cache das fontes de DESCOBERTA, em segundos (0 = sem cache).
   * Com tick curto, consultar trending a cada tick estoura o rate limit do
   * GeckoTerminal (30 req/min) — e trending não muda a cada 15s de qualquer
   * jeito. O enriquecimento (preço/volume via DexScreener) continua fresco por
   * tick; só a LISTA de candidatos é cacheada.
   */
  sourceTtlSec: z.number().int().min(0),
  maxCandidatesPerTick: z.number().int().min(1).max(60),
  excludeMints: z.array(z.string()),
});

export const entryRuleIds = [
  'momentum_5m',
  'momentum_1h',
  'volume_spike',
  'buy_pressure',
  'turnover',
  'trending',
] as const;

const entryRuleSchema = z.object({
  id: z.enum(entryRuleIds),
  label: z.string(),
  points: z.number().min(0),
  params: z.record(z.string(), z.number()).default({}),
});

const entrySchema = z.object({
  gates: z.object({
    /**
     * DEXes onde o bot pode comprar (dexId do DexScreener). Vazio = todas.
     * ["pumpfun", "pumpswap"] = só bonding curve do pump.fun e graduados.
     */
    allowedDexIds: z.array(z.string()),
    /**
     * DEXes de bonding curve (sem pool clássico). Nelas o DexScreener não
     * reporta `liquidity` — isso é ESTRUTURAL, não dado faltando — então os
     * gates de liquidez são pulados e o piso vira o market cap.
     */
    curveDexIds: z.array(z.string()),
    minLiquidityUsd: z.number().min(0),
    /** 0 = sem teto. */
    maxLiquidityUsd: z.number().min(0),
    minVolume1hUsd: z.number().min(0),
    minAgeMin: z.number().min(0),
    /** 0 = sem teto. */
    maxAgeHours: z.number().min(0),
    minTxns1h: z.number().int().min(0),
    minBuyRatio1h: z.number().min(0).max(1),
    /** Piso de market cap (0 = sem piso). Na curve, é a defesa contra recém-mintado. */
    minMarketCapUsd: z.number().min(0),
    /** 0 = sem teto. */
    maxMarketCapUsd: z.number().min(0),
  }),
  minScore: z.number().min(0),
  rules: z.array(entryRuleSchema).min(1),
});

const riskSchema = z.object({
  /** Score acima disso rejeita, mesmo sem veto individual. */
  maxScore: z.number().min(0).max(100),
  vetoMintAuthority: z.boolean(),
  vetoFreezeAuthority: z.boolean(),
  vetoToken2022: z.boolean(),
  vetoRugcheckDanger: z.boolean(),
  /** true = sem relatório do RugCheck o token é rejeitado. */
  requireRugcheck: z.boolean(),
  /** true = sem leitura on-chain do mint o token é rejeitado (recomendado). */
  requireOnchain: z.boolean(),
  maxTop1Pct: z.number().min(0).max(100),
  maxTop10Pct: z.number().min(0).max(100),
  minLpLockedPct: z.number().min(0).max(100),
  maxRugcheckScore: z.number().min(0).max(100),
  minHolderCount: z.number().int().min(0),
  rugcheckTimeoutMs: z.number().int().min(1000),
});

const sizingSchema = z.object({
  positionPctOfBalance: z.number().min(0.1).max(100),
  maxPositionSol: z.number().min(0),
  minPositionSol: z.number().min(0),
  maxOpenPositions: z.number().int().min(1),
  /** SOL que nunca entra em posição — paga as taxas e o gás da saída. */
  reserveSol: z.number().min(0),
  /** Perda realizada no dia (UTC) que desliga novas compras até o dia virar. */
  maxDailyLossSol: z.number().min(0),
  riskScaling: z.boolean(),
  paperStartBalanceSol: z.number().min(0),
});

const exitSchema = z.object({
  stopLossPct: z.number().min(1).max(100),
  takeProfitPct: z.number().min(1),
  /** Quanto da posição vender no take profit. 100 = tudo. */
  takeProfitSellPct: z.number().min(1).max(100),
  trailingActivatePct: z.number().min(0),
  trailingStopPct: z.number().min(1).max(100),
  maxHoldMin: z.number().min(1),
  /** Liquidez atual abaixo desta % da liquidez de entrada = rug em andamento, sai. */
  liquidityDrainPct: z.number().min(1).max(100),
  /** Ticks seguidos sem dado de preço até desistir e vender. */
  staleTicksToExit: z.number().int().min(1),
});

const executionSchema = z.object({
  slippageBps: z.number().int().min(10).max(5000),
  /**
   * Slippage das saídas URGENTES (rug/stop/sem dados). Num pool sendo drenado,
   * a slippage normal faz toda venda reverter e o bot fica preso dentro do
   * token — aceitar um preço pior é o que tira o dinheiro de lá.
   */
  emergencySlippageBps: z.number().int().min(10).max(10000),
  maxPriorityFeeLamports: z.number().int().min(0),
  confirmTimeoutSec: z.number().int().min(10),
  paperSlippagePct: z.number().min(0).max(50),
});

export const traderFileSchema = z.object({
  $comment: z.string().optional(),
  loop: loopSchema,
  discovery: discoverySchema,
  entry: entrySchema,
  risk: riskSchema,
  sizing: sizingSchema,
  exit: exitSchema,
  execution: executionSchema,
});

export type TraderConfig = z.infer<typeof traderFileSchema>;
export type EntryConfig = TraderConfig['entry'];
export type RiskConfig = TraderConfig['risk'];
export type SizingConfig = TraderConfig['sizing'];
export type ExitConfig = TraderConfig['exit'];
export type ExecutionConfig = TraderConfig['execution'];

export function loadTraderConfig(path = resolve(projectRoot, 'config', 'trader.json')): TraderConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Não consegui ler ${path}: ${(err as Error).message}`);
  }
  return traderFileSchema.parse(raw);
}

// ─────────────────────────────────────────────────────────────
//  Ambiente (.env)
// ─────────────────────────────────────────────────────────────

export interface TraderEnv {
  mode: TradeMode;
  liveAck: boolean;
  privateKey?: string;
  keypairFile?: string;
  rpcUrls: string[];
  jupiterBaseUrl: string;
  jupiterApiKey?: string;
  dataDir: string;
}

function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

/** Frase exigida no .env para o modo live ligar. Digitá-la é o "sim, eu li o aviso". */
export const LIVE_ACK_PHRASE = 'eu-aceito-o-risco';

export function loadEnv(): TraderEnv {
  const modeRaw = (process.env.TRADER_MODE ?? 'paper').toLowerCase();
  if (modeRaw !== 'paper' && modeRaw !== 'live') {
    throw new Error(`TRADER_MODE inválido: "${modeRaw}". Use "paper" ou "live".`);
  }
  return {
    mode: modeRaw,
    liveAck: envOrUndefined('LIVE_TRADING_ACK') === LIVE_ACK_PHRASE,
    privateKey: envOrUndefined('SOLANA_PRIVATE_KEY'),
    keypairFile: envOrUndefined('SOLANA_KEYPAIR_FILE'),
    rpcUrls: (envOrUndefined('SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    jupiterBaseUrl: (envOrUndefined('JUPITER_BASE_URL') ?? 'https://lite-api.jup.ag/swap/v1').replace(
      /\/$/,
      '',
    ),
    jupiterApiKey: envOrUndefined('JUPITER_API_KEY'),
    dataDir: resolve(projectRoot, process.env.DATA_DIR ?? './data'),
  };
}

/**
 * Valida a combinação modo × carteira × ack. Falha ALTO e CEDO: o pior bug
 * possível aqui seria descobrir no primeiro trade que o modo live subiu sem
 * a pessoa ter pedido de verdade.
 */
export function assertLiveAllowed(env: TraderEnv): void {
  if (env.mode !== 'live') return;
  if (!env.liveAck) {
    throw new Error(
      [
        'TRADER_MODE=live exige LIVE_TRADING_ACK no .env com a frase exata:',
        `  LIVE_TRADING_ACK=${LIVE_ACK_PHRASE}`,
        'Isso é intencional: o modo live gasta SOL de verdade em tokens de altíssimo risco.',
        'Rode em paper primeiro e confira o histórico com `npm run trader -- history`.',
      ].join('\n'),
    );
  }
  if (!env.privateKey && !env.keypairFile) {
    throw new Error(
      'TRADER_MODE=live exige SOLANA_PRIVATE_KEY ou SOLANA_KEYPAIR_FILE no .env.',
    );
  }
}
