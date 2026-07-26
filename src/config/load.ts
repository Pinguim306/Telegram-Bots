import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  dexFileSchema,
  launchesFileSchema,
  networksFileSchema,
  referralsFileSchema,
  signalsFileSchema,
  type DexConfig,
  type LaunchesConfig,
  type ReferralsConfig,
  type ResolvedNetwork,
  type SignalsConfig,
} from './schema.js';

dotenv.config({ quiet: true });

const here = dirname(fileURLToPath(import.meta.url));
/** src/config -> raiz do repo (funciona igual rodando de src/ ou de dist/). */
export const projectRoot = resolve(here, '..', '..');
const configDir = resolve(projectRoot, 'config');

function readJson(file: string): unknown {
  const path = resolve(configDir, file);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Não consegui ler ${path}: ${(err as Error).message}`);
  }
}

function envOrUndefined(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

export function loadNetwork(key = process.env.NETWORK ?? 'arc-testnet'): ResolvedNetwork {
  const parsed = networksFileSchema.parse(readJson('networks.json'));
  const raw = parsed.networks[key];
  if (!raw) {
    const available = Object.keys(parsed.networks).join(', ');
    throw new Error(`Rede "${key}" não existe em config/networks.json. Disponíveis: ${available}`);
  }

  // Env tem precedência sobre o JSON, igual ao que já valia para o RPC. O contrário
  // seria uma armadilha: você define ARC_MAINNET_CHAIN_ID e o valor é ignorado
  // silenciosamente porque o arquivo também traz um.
  const chainIdFromEnv = envOrUndefined(raw.chainIdEnv);
  const chainId = chainIdFromEnv ? Number(chainIdFromEnv) : raw.chainId;

  // O override vale para qualquer rede — é como se aponta para um RPC pago.
  const override = envOrUndefined('RPC_URL_OVERRIDE');
  const rpcFromEnv = envOrUndefined(raw.rpcUrlsEnv);
  const rpcUrls = (override ?? rpcFromEnv)
    ? (override ?? rpcFromEnv)!.split(',').map((u) => u.trim()).filter(Boolean)
    : (raw.rpcUrls ?? []);

  if (!chainId || Number.isNaN(chainId) || rpcUrls.length === 0) {
    // Falhar aqui é intencional: alertar na rede errada é pior que não alertar.
    throw new Error(
      [
        `Rede "${key}" está incompleta.`,
        chainId ? '' : `  • falta chain id (defina ${raw.chainIdEnv ?? 'chainId no JSON'})`,
        rpcUrls.length ? '' : `  • falta RPC (defina ${raw.rpcUrlsEnv ?? 'rpcUrls no JSON'} ou RPC_URL_OVERRIDE)`,
        '',
        key === 'arc-mainnet'
          ? 'A Arc Mainnet ainda não estava no ar quando este projeto foi escrito. Assim que subir, preencha as vars ARC_MAINNET_* no .env — nenhuma mudança de código é necessária.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return {
    key,
    name: raw.name,
    chainId,
    rpcUrls,
    wsUrl: envOrUndefined(raw.wsUrlEnv) ?? raw.wsUrl,
    explorerUrl: (envOrUndefined(raw.explorerUrlEnv) ?? raw.explorerUrl)?.replace(/\/$/, ''),
    nativeCurrency: raw.nativeCurrency,
    multicall3: raw.multicall3 as `0x${string}` | undefined,
    blockTimeMs: raw.blockTimeMs,
    confirmations: raw.confirmations,
    maxBlockRange: raw.maxBlockRange,
    quoteTokens: raw.quoteTokens,
    rateLimit: raw.rateLimit,
  };
}

export function loadReferrals(): ReferralsConfig {
  return referralsFileSchema.parse(readJson('referrals.json'));
}

export function loadDexConfig(): DexConfig {
  return dexFileSchema.parse(readJson('dex.json'));
}

export function loadSignalsConfig(): SignalsConfig {
  return signalsFileSchema.parse(readJson('signals.json'));
}

export function loadLaunchesConfig(): LaunchesConfig {
  return launchesFileSchema.parse(readJson('launches.json'));
}

export interface RuntimeEnv {
  dataDir: string;
  dryRun: boolean;
  startBlock?: bigint;
  freeTierDelaySec: number;
}

export function loadRuntimeEnv(): RuntimeEnv {
  const startBlockRaw = envOrUndefined('START_BLOCK');
  return {
    dataDir: resolve(projectRoot, process.env.DATA_DIR ?? './data'),
    // Default seguro: sem DRY_RUN=false explícito, nada é publicado.
    dryRun: (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
    startBlock: startBlockRaw ? BigInt(startBlockRaw) : undefined,
    freeTierDelaySec: Number(process.env.FREE_TIER_DELAY_SEC ?? '60'),
  };
}

export interface TelegramEnv {
  token?: string;
  channel?: string;
  premiumChannel?: string;
}

export function loadTelegramEnv(bot: 'LAUNCHES' | 'SIGNALS'): TelegramEnv {
  return {
    token: envOrUndefined(`TELEGRAM_${bot}_BOT_TOKEN`),
    channel: envOrUndefined(`TELEGRAM_${bot}_CHANNEL`),
    premiumChannel: envOrUndefined(`TELEGRAM_${bot}_PREMIUM_CHANNEL`),
  };
}
