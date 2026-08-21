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
    /**
     * Minutos de incubação antes de um mint novo ser avaliado. Sem isso, os
     * ~19 mints/min do pump.fun afogam o teto de candidatos com tokens de
     * segundos de vida que nenhum gate aprova. Graduações furam a incubação.
     */
    incubationMin: z.number().int().min(0),
  }),
  /**
   * Idade máxima do cache das fontes de DESCOBERTA, em segundos (0 = sem cache).
   * Com tick curto, consultar trending a cada tick estoura o rate limit do
   * GeckoTerminal (30 req/min) — e trending não muda a cada 15s de qualquer
   * jeito. O enriquecimento (preço/volume via DexScreener) continua fresco por
   * tick; só a LISTA de candidatos é cacheada.
   */
  sourceTtlSec: z.number().int().min(0),
  maxCandidatesPerTick: z.number().int().min(1).max(300),
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
    /** Piso ABSOLUTO de volume 1h — só corta poeira. O filtro real é o ritmo abaixo. */
    minVolume1hUsd: z.number().min(0),
    /**
     * Ritmo mínimo de negociação: volume 1h dividido pelos minutos de vida
     * (teto 60). Um token de 10min com $8k negociados ($800/min) está mais
     * quente que um de 60min com $25k ($417/min) — volume absoluto pune
     * exatamente os recém-nascidos que a estratégia caça. 0 = desligado.
     */
    minVolumePaceUsdPerMin: z.number().min(0),
    minAgeMin: z.number().min(0),
    /** 0 = sem teto. */
    maxAgeHours: z.number().min(0),
    /** Piso ABSOLUTO de transações 1h — corte de poeira; o filtro real é o ritmo. */
    minTxns1h: z.number().int().min(0),
    /** Ritmo mínimo de transações por minuto de vida (teto 60). 0 = desligado. */
    minTxnsPerMin: z.number().min(0),
    minBuyRatio1h: z.number().min(0).max(1),
    /**
     * Reprova token que caiu mais que isto (%) nos últimos 5 minutos.
     * Comprar logo após um dump é pegar faca: os números de 1h ainda parecem
     * quentes (todo o volume aconteceu no pump), mas o fluxo já morreu — visto
     * em produção com um token que despencou e ficou sem NENHUMA transação.
     * 0 = desligado.
     */
    maxDrop5mPct: z.number().min(0).default(15),
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
  /**
   * Limiares de concentração para token NA BONDING CURVE, medidos sobre o
   * supply CIRCULANTE (o vault da curve é excluído na leitura). São mais
   * frouxos que os de token graduado porque a base é menor — num token de
   * minutos, os primeiros compradores naturalmente dominam o circulante; o
   * que se caça é o extremo: uma ou poucas carteiras com quase tudo.
   * .default para config antigo continuar válido.
   */
  curveMaxTop1Pct: z.number().min(0).max(100).default(30),
  curveMaxTop10Pct: z.number().min(0).max(100).default(70),
  /**
   * Análise de LIGAÇÃO entre as carteiras do topo (token na curve): compra no
   * mesmo bloco (bundle) e financiador comum (carteira-mãe). Concentração
   * sozinha não pega 10 carteiras "diferentes" que são um sniper só fatiado.
   * Custa ~20-30 chamadas de RPC por token analisado — só roda no último
   * degrau do funil, e falha vira null (nunca trava a análise).
   */
  /**
   * Taxa máxima (%) de compra/venda embutida no contrato do token (EVM). Na
   * BSC taxa é norma — acima disso pontua alto. Irrelevante na Solana
   * (o RugCheck não reporta taxas). .default para config antigo.
   */
  maxSellTaxPct: z.number().min(0).max(100).default(10),
  linkageEnabled: z.boolean().default(true),
  /** Quantas contas do topo checar (teto de custo de RPC). */
  linkageTopN: z.number().int().min(3).max(20).default(10),
  /** Tolerância em slots (~0,4s cada) para contar como "mesmo bloco". */
  linkageSlotTolerance: z.number().int().min(0).max(20).default(2),
  /** Acima disso, carteiras comprando no mesmo bloco pontuam alto contra. */
  maxSameSlotCluster: z.number().int().min(1).default(3),
  /** Acima disso, carteiras com a mesma carteira-mãe pontuam alto contra. */
  maxSharedFunderCluster: z.number().int().min(1).default(2),
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
  /**
   * Saída "token morto no chão": volume 5m abaixo de deadVolume5mUsd E
   * transações 5m até deadTxns5m, por deadTicksToExit ticks seguidos, depois
   * de deadMinHoldMin minutos de posição → vende tudo. Existe porque um token
   * que morre APÓS a compra não dispara stop loss (o preço não cai — ninguém
   * negocia) e ficava preso até o tempo máximo, capital parado num defunto.
   * Todos com .default() para config antigo continuar válido.
   */
  deadVolume5mUsd: z.number().min(0).default(250),
  deadTxns5m: z.number().int().min(0).default(6),
  deadTicksToExit: z.number().int().min(1).default(3),
  /** Carência pós-compra: a janela de 5m do indexador ainda contém o hype da entrada. */
  deadMinHoldMin: z.number().min(0).default(5),
});

const executionSchema = z.object({
  slippageBps: z.number().int().min(10).max(5000),
  /**
   * Slippage das saídas URGENTES (rug/stop/sem dados) e das operações de
   * FALLBACK via pump.fun (janela pós-graduação). Nos dois casos o preço está
   * em movimento violento e a slippage normal faz a transação reverter — na
   * saída isso prende o bot dentro do token; na entrada, perde a janela.
   */
  emergencySlippageBps: z.number().int().min(10).max(10000),
  /**
   * Quando o Jupiter responde NO_ROUTES_FOUND (token novo demais para o índice
   * dele), executa direto no pump.fun via PumpPortal trade-local (taxa 0,5%).
   */
  pumpportalFallback: z.boolean(),
  maxPriorityFeeLamports: z.number().int().min(0),
  confirmTimeoutSec: z.number().int().min(10),
  paperSlippagePct: z.number().min(0).max(50),
  /**
   * Custo máximo (%) de COMPRAR e VENDER de volta imediatamente — impacto de
   * ida + volta + taxas, medido ANTES da compra (curve on-chain ou dupla quote
   * Jupiter). Análise dos trades reais: 17 de 22 perdas fecharam além do stop
   * de -12% (média -26%) — boa parte era este pedágio, pago sem ser medido.
   * 0 = desligado.
   */
  maxRoundTripCostPct: z.number().min(0).default(6),
  /**
   * Teto de posição da COMPRA via fallback pump.fun (sem rota Jupiter) — a
   * ponta mais rasa e perigosa. O pior trade do dia analisado (-0,34 SOL) foi
   * uma compra de 0,5 SOL nesta via, sem nenhuma checagem.
   */
  fallbackMaxPositionSol: z.number().min(0).default(0.1),
  /** Slippage da compra via fallback — a de emergência (15%) é só para SAÍDA. */
  fallbackBuySlippageBps: z.number().int().min(10).max(10000).default(500),
});

/**
 * Segunda opinião por IA (Claude) como ÚLTIMO filtro antes da compra: o
 * candidato já passou nos gates, no score e no risco — a IA julga a qualidade
 * da entrada (momentum cedo ou tarde? pressão orgânica ou bot?) com o contexto
 * completo. Fail-open: IA indisponível NUNCA trava o bot — segue sem ela.
 */
const aiSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  /** Profundidade de raciocínio (low = mais rápido/barato). Janela de scalp é curta. */
  effort: z.enum(['low', 'medium', 'high']),
  /** Confiança mínima (0–100) do veredito "comprar" para a compra prosseguir. */
  minConfidence: z.number().min(0).max(100),
  /** Teto de chamadas por hora — trava de custo. Excedeu = segue sem IA. */
  maxCallsPerHour: z.number().int().min(1),
  timeoutSec: z.number().int().min(5),
});

/** Painel web local (só 127.0.0.1 — nunca exposto para a rede). */
const dashboardSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
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
  // .default: config antigo (sem as seções novas) continua válido.
  ai: aiSchema.default({
    enabled: true,
    model: 'claude-opus-5',
    effort: 'low',
    minConfidence: 65,
    maxCallsPerHour: 60,
    timeoutSec: 30,
  }),
  dashboard: dashboardSchema.default({ enabled: true, port: 3877 }),
});

export type TraderConfig = z.infer<typeof traderFileSchema>;
export type EntryConfig = TraderConfig['entry'];
export type RiskConfig = TraderConfig['risk'];
export type SizingConfig = TraderConfig['sizing'];
export type ExitConfig = TraderConfig['exit'];
export type ExecutionConfig = TraderConfig['execution'];
export type AiConfig = TraderConfig['ai'];

/**
 * Um arquivo de config POR REDE: trader.json (Solana, o original) e
 * trader.bsc.json. Cada rede tem calibração própria — liquidez, mcap e taxas
 * de memecoin da BSC vivem em outra escala.
 */
export function configPathForChain(chain: 'solana' | 'bsc'): string {
  return resolve(projectRoot, 'config', chain === 'bsc' ? 'trader.bsc.json' : 'trader.json');
}

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
  /** Rede deste PROCESSO (TRADER_CHAIN). Uma rede por processo, de propósito. */
  chain: 'solana' | 'bsc';
  liveAck: boolean;
  privateKey?: string;
  keypairFile?: string;
  rpcUrls: string[];
  /** RPCs da BSC (BSC_RPC_URL, separados por vírgula). Só usados com TRADER_CHAIN=bsc. */
  bscRpcUrls: string[];
  jupiterBaseUrl: string;
  jupiterApiKey?: string;
  /** Chave da API da Anthropic — liga o filtro de IA quando ai.enabled=true. */
  anthropicApiKey?: string;
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
  const chainRaw = (process.env.TRADER_CHAIN ?? 'solana').toLowerCase();
  if (chainRaw !== 'solana' && chainRaw !== 'bsc') {
    throw new Error(`TRADER_CHAIN inválido: "${chainRaw}". Use "solana" ou "bsc".`);
  }
  return {
    mode: modeRaw,
    chain: chainRaw,
    liveAck: envOrUndefined('LIVE_TRADING_ACK') === LIVE_ACK_PHRASE,
    privateKey: envOrUndefined('SOLANA_PRIVATE_KEY'),
    keypairFile: envOrUndefined('SOLANA_KEYPAIR_FILE'),
    rpcUrls: (envOrUndefined('SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    bscRpcUrls: (envOrUndefined('BSC_RPC_URL') ?? 'https://bsc-dataseed.bnbchain.org')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    jupiterBaseUrl: (envOrUndefined('JUPITER_BASE_URL') ?? 'https://lite-api.jup.ag/swap/v1').replace(
      /\/$/,
      '',
    ),
    jupiterApiKey: envOrUndefined('JUPITER_API_KEY'),
    anthropicApiKey: envOrUndefined('ANTHROPIC_API_KEY'),
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
  if (env.chain === 'bsc') {
    throw new Error(
      'TRADER_CHAIN=bsc ainda não suporta modo LIVE (fase 2 do plano) — rode em paper: TRADER_MODE=paper.',
    );
  }
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
