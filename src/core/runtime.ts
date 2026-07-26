import {
  loadNetwork,
  loadReferrals,
  loadRuntimeEnv,
  loadTelegramEnv,
  type RuntimeEnv,
} from '../config/load.js';
import type { ResolvedNetwork } from '../config/schema.js';
import { ChainClient } from './chain.js';
import { openDb, prune, type Db } from './db.js';
import { childLogger, type Logger } from './logger.js';
import { Publisher } from './publisher.js';
import { ReferralBuilder } from './referrals.js';

export interface Runtime {
  network: ResolvedNetwork;
  chain: ChainClient;
  db: Db;
  log: Logger;
  publisher: Publisher;
  referrals: ReferralBuilder;
  env: RuntimeEnv;
  /** Registra o encerramento gracioso e resolve quando o processo deve morrer. */
  onShutdown: (fn: () => void | Promise<void>) => void;
}

export function createRuntime(bot: 'LAUNCHES' | 'SIGNALS', dbName: string): Runtime {
  const log = childLogger(dbName);
  const env = loadRuntimeEnv();
  const network = loadNetwork();
  const chain = new ChainClient(network);
  const db = openDb(env.dataDir, dbName);
  const telegram = loadTelegramEnv(bot);
  const referrals = new ReferralBuilder(loadReferrals(), {
    networkKey: network.key,
    explorerUrl: network.explorerUrl,
  });

  log.info(
    {
      rede: network.name,
      chainId: network.chainId,
      rpc: network.rpcUrls[0],
      dryRun: env.dryRun,
      canal: telegram.channel ?? '(nenhum)',
      premium: telegram.premiumChannel ?? '(nenhum)',
    },
    'runtime iniciado',
  );
  referrals.audit(log);

  const publisher = new Publisher({
    token: telegram.token,
    channel: telegram.channel,
    premiumChannel: telegram.premiumChannel,
    freeTierDelaySec: env.freeTierDelaySec,
    dryRun: env.dryRun,
    log,
  });

  const shutdownHooks: Array<() => void | Promise<void>> = [];
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'encerrando');
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (err) {
        log.error({ err }, 'erro no shutdown');
      }
    }
    try {
      await publisher.close();
      db.close();
    } catch (err) {
      log.error({ err }, 'erro ao fechar recursos');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));

  // Limpeza periódica: sem isso o SQLite cresce indefinidamente com trades antigos.
  const pruneTimer = setInterval(
    () => {
      try {
        const removed = prune(db, 7 * 24 * 3_600);
        if (removed > 0) log.debug({ removed }, 'trades antigos removidos');
      } catch (err) {
        log.warn({ err }, 'prune falhou');
      }
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref();

  return {
    network,
    chain,
    db,
    log,
    publisher,
    referrals,
    env,
    onShutdown: (fn) => shutdownHooks.push(fn),
  };
}
