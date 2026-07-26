import { z } from 'zod';

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'endereço EVM inválido')
  // Normaliza para minúsculas: todo endereço no projeto circula assim, então
  // comparação e chave de Map/Set funcionam sem checksum no meio do caminho.
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const quoteTokenSchema = z.object({
  address: addressSchema,
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
  /** Preço fixo em USD. Só faz sentido para stables; os demais são derivados on-chain. */
  usdPrice: z.number().positive().optional(),
  isStable: z.boolean().default(false),
  /** Quando um pool tem dois candidatos a quote, ganha o de maior preferência. */
  preference: z.number().default(0),
});

export type QuoteToken = z.infer<typeof quoteTokenSchema>;

const nativeCurrencySchema = z.object({
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
});

/** Formato bruto no networks.json — campos podem vir direto ou via `*Env`. */
export const rawNetworkSchema = z.object({
  name: z.string(),
  chainId: z.number().int().positive().optional(),
  chainIdEnv: z.string().optional(),
  rpcUrls: z.array(z.string().url()).optional(),
  rpcUrlsEnv: z.string().optional(),
  wsUrl: z.string().optional(),
  wsUrlEnv: z.string().optional(),
  explorerUrl: z.string().optional(),
  explorerUrlEnv: z.string().optional(),
  nativeCurrency: nativeCurrencySchema,
  multicall3: addressSchema.optional(),
  blockTimeMs: z.number().int().positive().default(2000),
  confirmations: z.number().int().min(0).default(3),
  maxBlockRange: z.number().int().positive().default(2000),
  quoteTokens: z.array(quoteTokenSchema).default([]),
  /**
   * Teto de requisições ao RPC desta rede.
   *
   * Existe porque RPC público não é tudo igual: o gateway público da thirdweb na
   * Arc mainnet responde 429 depois de poucas chamadas, enquanto o RPC da testnet
   * aguenta bem mais. Sem poder afrouxar ou apertar por rede, ou o bot fica lento
   * onde não precisa, ou apanha de 429 onde precisa ir devagar.
   */
  rateLimit: z
    .object({
      concurrency: z.number().int().positive().default(4),
      ratePerSec: z.number().positive().default(12),
    })
    .optional(),
});

export const networksFileSchema = z.object({
  networks: z.record(z.string(), rawNetworkSchema),
});

/** Rede já resolvida (env aplicado, campos obrigatórios garantidos). */
export interface ResolvedNetwork {
  key: string;
  name: string;
  chainId: number;
  rpcUrls: string[];
  wsUrl?: string;
  explorerUrl?: string;
  nativeCurrency: z.infer<typeof nativeCurrencySchema>;
  multicall3?: `0x${string}`;
  blockTimeMs: number;
  confirmations: number;
  maxBlockRange: number;
  quoteTokens: QuoteToken[];
  rateLimit?: { concurrency: number; ratePerSec: number };
}

export const referralPlatformSchema = z.object({
  id: z.string(),
  label: z.string(),
  template: z.string(),
  ref: z.string().default(''),
  enabled: z.boolean().default(false),
  verified: z.boolean().default(false),
  kind: z.enum(['trade', 'chart', 'explorer', 'cex', 'other']).default('other'),
  /**
   * Redes em que esta plataforma publica. Vazio = todas.
   *
   * Existe porque agregador só indexa mainnet: publicar o link dele enquanto o bot
   * roda em testnet gera 404 em todo alerta. Assim a plataforma fica configurada
   * uma vez e só entra no ar quando o bot aponta para a rede certa.
   */
  networks: z.array(z.string()).default([]),
});

export type ReferralPlatform = z.infer<typeof referralPlatformSchema>;

export const referralsFileSchema = z.object({
  chainSlug: z.string().default('arc'),
  platforms: z.array(referralPlatformSchema).default([]),
  footer: z
    .object({ enabled: z.boolean().default(false), text: z.string().default('') })
    .default({ enabled: false, text: '' }),
});

export type ReferralsConfig = z.infer<typeof referralsFileSchema>;

export const dexFileSchema = z.object({
  factoryLabels: z.record(addressSchema, z.string()).default({}),
  factoryAllowlist: z.array(addressSchema).default([]),
  factoryDenylist: z.array(addressSchema).default([]),
  tokenDenylist: z.array(addressSchema).default([]),
});

export type DexConfig = z.infer<typeof dexFileSchema>;

export const launchesFileSchema = z.object({
  alertOnNewPool: z.boolean().default(true),
  alertOnNewToken: z.boolean().default(false),
  /** Tamanho mínimo do pool (token + quote a preço spot) — filtro anti-lixo. */
  minPoolValueUsd: z.number().min(0).default(250),
  /** Mínimo do lado quote — dinheiro real contra o qual dá para vender. */
  minQuoteLiquidityUsd: z.number().min(0).default(0),
  /** Acima disso o token é considerado arriscado demais para ir ao canal. */
  maxRiskScore: z.number().min(0).max(100).default(100),
  /** Ignora contratos sem name/symbol/decimals legíveis (não são ERC-20 de verdade). */
  requireMetadata: z.boolean().default(true),
  maxAlertsPerHour: z.number().int().min(1).default(30),
  trackedTokenMaxAgeSec: z.number().int().min(0).default(604_800),
  /** De quanto em quanto tempo reavaliar pools que ainda não tinham liquidez. */
  pendingRecheckSec: z.number().int().min(1).default(20),
  /** Por quanto tempo um pool sem liquidez continua na fila de reavaliação. */
  pendingWindowSec: z.number().int().min(0).default(1_800),
});

export type LaunchesConfig = z.infer<typeof launchesFileSchema>;

export const signalRuleSchema = z.object({
  id: z.enum([
    'buy_pressure',
    'volume_spike',
    'unique_buyers',
    'price_change',
    'net_inflow',
    'fresh_launch',
  ]),
  label: z.string(),
  points: z.number(),
  params: z.record(z.string(), z.number()).default({}),
});

export type SignalRule = z.infer<typeof signalRuleSchema>;

export const signalsFileSchema = z.object({
  windows: z.object({
    shortSec: z.number().int().positive().default(180),
    mediumSec: z.number().int().positive().default(900),
    longSec: z.number().int().positive().default(3600),
  }),
  eligibility: z.object({
    minLiquidityUsd: z.number().min(0).default(2000),
    /** Teto de market cap; 0 desliga. Evita alertar token grande demais. */
    maxMarketCapUsd: z.number().min(0).default(0),
    minAgeSec: z.number().min(0).default(60),
    maxAgeSec: z.number().min(0).default(604800),
    minBuysShort: z.number().min(0).default(5),
    minVolumeUsdShort: z.number().min(0).default(300),
    minUniqueBuyersShort: z.number().min(0).default(3),
  }),
  rules: z.array(signalRuleSchema).default([]),
  minScore: z.number().default(55),
  cooldownSec: z.number().int().min(0).default(1800),
  /** Re-alerta o mesmo token antes do cooldown se o score subir tanto quanto isso. */
  reAlertScoreDelta: z.number().default(20),
  maxAlertsPerHour: z.number().int().min(1).default(12),
  advanced: z
    .object({
      /** Resolve tx.from por transação — exato, porém caro. Veja o comentário no JSON. */
      resolveTradersFromTx: z.boolean().default(false),
      evaluateIntervalSec: z.number().int().min(1).default(20),
      maxTokensPerEvaluation: z.number().int().min(1).default(40),
      liquidityCacheSec: z.number().int().min(0).default(120),
    })
    .default({
      resolveTradersFromTx: false,
      evaluateIntervalSec: 20,
      maxTokensPerEvaluation: 40,
      liquidityCacheSec: 120,
    }),
});

export type SignalsConfig = z.infer<typeof signalsFileSchema>;
