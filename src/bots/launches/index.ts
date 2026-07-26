import type { Address } from 'viem';
import { loadDexConfig, loadLaunchesConfig } from '../../config/load.js';
import { recordAlert, underHourlyCap } from '../../core/alerts.js';
import type { RawLog } from '../../core/chain.js';
import { TOPIC, ZERO_TOPIC, decodeMint, decodePoolCreation } from '../../core/events.js';
import { fromUnits } from '../../core/format.js';
import { PoolRegistry, type PoolInfo } from '../../core/pools.js';
import { createRuntime } from '../../core/runtime.js';
import { LogScanner, type ScanBatch } from '../../core/scanner.js';
import { assessRisk, readTokenMetas, type TokenMeta } from '../../core/tokens.js';
import { renderLaunchAlert, renderNewTokenAlert } from './message.js';

const KIND = 'launch';

async function main(): Promise<void> {
  const rt = createRuntime('LAUNCHES', 'arc-launches');
  const cfg = loadLaunchesConfig();
  const dex = loadDexConfig();
  const registry = new PoolRegistry(rt.db, rt.chain, rt.network.quoteTokens);

  const denyFactories = new Set(dex.factoryDenylist);
  const allowFactories = new Set(dex.factoryAllowlist);
  const denyTokens = new Set(dex.tokenDenylist);
  const quoteAddresses = new Set(rt.network.quoteTokens.map((q) => q.address));

  let lastRecheck = 0;

  const scanner = new LogScanner(rt.chain, rt.db, rt.log, {
    scope: 'launches',
    // Duas consultas por lote: criação de pool (V2+V3) e mint de token novo.
    filters: [
      { topics: [[TOPIC.pairCreated, TOPIC.poolCreated]] },
      { topics: [[TOPIC.transfer], [ZERO_TOPIC]] },
    ],
    startBlock: rt.env.startBlock,
    idleCallback: () => recheckPending(),
  });

  rt.onShutdown(() => scanner.stop());

  await scanner.run(async (batch) => {
    await handleBatch(batch);
    await recheckPending();
  });

  async function handleBatch(batch: ScanBatch): Promise<void> {
    const creations: Array<{ log: RawLog; ts: number }> = [];
    const mintedTokens = new Map<Address, { ts: number; block: number; to: Address }>();

    for (const log of batch.logs) {
      const topic0 = log.topics[0];
      if (topic0 === TOPIC.pairCreated || topic0 === TOPIC.poolCreated) {
        creations.push({ log, ts: await batch.timestampOf(log) });
        continue;
      }
      const mint = decodeMint(log);
      if (mint && !mintedTokens.has(mint.token)) {
        mintedTokens.set(mint.token, {
          ts: await batch.timestampOf(log),
          block: Number(BigInt(log.blockNumber)),
          to: mint.to,
        });
      }
    }

    if (mintedTokens.size > 0) await handleMints(mintedTokens);
    for (const creation of creations) await handleCreation(creation.log, creation.ts);
  }

  /**
   * Todo token visto pela primeira vez é registrado, mesmo sem alerta.
   * Esse registro é o que permite, no alerta de pool, dizer "token criado há 40s"
   * — e distinguir launch de verdade de pool novo em token antigo.
   */
  async function handleMints(
    mints: Map<Address, { ts: number; block: number; to: Address }>,
  ): Promise<void> {
    const known = new Set(
      (
        rt.db
          .prepare(
            `SELECT address FROM tokens WHERE address IN (${placeholders(mints.size)})`,
          )
          .all(...mints.keys()) as Array<{ address: string }>
      ).map((r) => r.address),
    );

    const fresh = [...mints.keys()].filter((address) => !known.has(address));
    if (fresh.length === 0) return;

    // Lotes de 40 para não estourar o gas limit do multicall3 nem o payload do RPC.
    for (const chunk of chunks(fresh, 40)) {
      const metas = await readTokenMetas(rt.chain, chunk);
      const insert = rt.db.prepare(
        `INSERT INTO tokens (address, symbol, name, decimals, total_supply,
                             first_seen_block, first_seen_ts, creator, is_erc20)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO NOTHING`,
      );

      const tx = rt.db.transaction((rows: Array<[TokenMeta, { ts: number; block: number; to: Address }]>) => {
        for (const [meta, mint] of rows) {
          insert.run(
            meta.address,
            meta.symbol,
            meta.name,
            meta.decimals,
            meta.totalSupply.toString(),
            mint.block,
            mint.ts,
            mint.to,
            meta.isErc20 ? 1 : 0,
          );
        }
      });

      const rows = chunk
        .map((address) => [metas.get(address), mints.get(address)] as const)
        .filter((pair): pair is [TokenMeta, { ts: number; block: number; to: Address }] =>
          Boolean(pair[0] && pair[1]),
        );
      tx(rows);

      if (cfg.alertOnNewToken) {
        for (const [meta, mint] of rows) {
          if (!meta.isErc20 || denyTokens.has(meta.address) || quoteAddresses.has(meta.address)) continue;
          if (!underHourlyCap(rt.db, KIND, cfg.maxAlertsPerHour)) break;
          const risk = await assessRisk(rt.chain, meta.address);
          if (risk.score > cfg.maxRiskScore) continue;
          rt.publisher.publish(
            renderNewTokenAlert({
              networkName: rt.network.name,
              tokenAddress: meta.address,
              tokenName: meta.name,
              tokenSymbol: meta.symbol,
              totalSupply: fromUnits(meta.totalSupply, meta.decimals),
              creator: mint.to,
              risk,
              explorerTokenUrl: rt.chain.addressUrl(meta.address),
              links: rt.referrals.build({ token: meta.address, chainId: rt.network.chainId }),
              footer: rt.referrals.footer(),
            }),
          );
          recordAlert(rt.db, KIND, `token:${meta.address}`);
        }
      }
    }
  }

  async function handleCreation(log: RawLog, ts: number): Promise<void> {
    const decoded = decodePoolCreation(log);
    if (!decoded) return;

    if (denyFactories.has(decoded.factory)) return;
    if (allowFactories.size > 0 && !allowFactories.has(decoded.factory)) return;

    const block = Number(BigInt(log.blockNumber));
    const info = registry.record(decoded, block, ts);
    // record() devolve null quando nenhum lado do par é um quote conhecido —
    // sem quote não há preço em USD, então não há alerta possível.
    if (!info) return;
    if (denyTokens.has(info.baseToken)) return;
    if (!cfg.alertOnNewPool) return;

    await evaluatePool(info);
  }

  /**
   * Avalia um pool e alerta se ele estiver pronto. "Pronto" = tem liquidez.
   * Se ainda não tiver, não descarta: o pool fica na fila e volta a ser avaliado
   * (veja recheckPending) até pendingWindowSec.
   */
  async function evaluatePool(info: PoolInfo): Promise<void> {
    const alreadyAlerted = rt.db
      .prepare('SELECT alerted FROM pools WHERE address = ?')
      .get(info.address) as { alerted: number } | undefined;
    if (alreadyAlerted?.alerted === 1) return;

    const quote = registry.quoteFor(info.quoteToken);
    if (!quote) return;
    const quoteUsd = quote.usdPrice ?? (quote.isStable ? 1 : 0);
    if (quoteUsd <= 0) return;

    // Metadados vêm antes da liquidez porque `liquidity` precisa dos decimals
    // do token base para converter o lado base a preço spot.
    const metas = await readTokenMetas(rt.chain, [info.baseToken]);
    const meta = metas.get(info.baseToken);
    if (!meta) return;
    if (cfg.requireMetadata && !meta.isErc20) {
      markAlerted(info.address);
      return;
    }

    const liquidity = await registry.liquidity(info, quoteUsd, meta.decimals);
    if (
      liquidity.totalUsd < cfg.minPoolValueUsd ||
      liquidity.quoteUsd < cfg.minQuoteLiquidityUsd
    ) {
      // Pool criado mas ainda não financiado: fica na fila e volta a ser avaliado.
      // Na Arc, criação e funding são transações separadas — descartar aqui
      // significaria perder praticamente todo launch.
      rt.log.debug(
        { pool: info.address, ...liquidity },
        'pool ainda sem liquidez suficiente, mantido na fila',
      );
      return;
    }

    if (!underHourlyCap(rt.db, KIND, cfg.maxAlertsPerHour)) {
      rt.log.warn('teto de alertas por hora atingido, alerta de launch suprimido');
      return;
    }

    const risk = await assessRisk(rt.chain, info.baseToken);
    if (risk.score > cfg.maxRiskScore) {
      rt.log.info({ token: info.baseToken, risk: risk.score }, 'launch suprimido por risco');
      markAlerted(info.address);
      return;
    }

    const spot = await registry.spotPrice(info, meta.decimals);
    const priceUsd = spot !== null ? spot * quoteUsd : null;
    const supply = fromUnits(meta.totalSupply, meta.decimals);
    const marketCapUsd = priceUsd !== null && supply > 0 ? priceUsd * supply : null;

    const tokenRow = rt.db
      .prepare('SELECT first_seen_ts FROM tokens WHERE address = ?')
      .get(info.baseToken) as { first_seen_ts: number } | undefined;
    const bornAt = tokenRow?.first_seen_ts ?? info.createdTs ?? Math.floor(Date.now() / 1000);

    rt.publisher.publish(
      renderLaunchAlert({
        networkName: rt.network.name,
        tokenAddress: info.baseToken,
        tokenName: meta.name,
        tokenSymbol: meta.symbol,
        decimals: meta.decimals,
        totalSupply: supply,
        poolAddress: info.address,
        poolKind: info.kind,
        dexLabel: dexLabel(info),
        feePct: info.fee !== null ? info.fee / 10_000 : null,
        quoteSymbol: quote.symbol,
        liquidity,
        priceUsd,
        marketCapUsd,
        ageSec: Math.max(0, Math.floor(Date.now() / 1000) - bornAt),
        risk,
        explorerTokenUrl: rt.chain.addressUrl(info.baseToken),
        explorerPoolUrl: rt.chain.addressUrl(info.address),
        links: rt.referrals.build({
          token: info.baseToken,
          pool: info.address,
          chainId: rt.network.chainId,
        }),
        footer: rt.referrals.footer(),
      }),
    );

    recordAlert(rt.db, KIND, info.address);
    markAlerted(info.address);
    rt.log.info({ token: meta.symbol, pool: info.address, ...liquidity }, 'launch alertado');
  }

  function markAlerted(pool: string): void {
    rt.db.prepare('UPDATE pools SET alerted = 1 WHERE address = ?').run(pool);
  }

  function dexLabel(info: PoolInfo): string {
    const known = info.factory ? dex.factoryLabels[info.factory] : undefined;
    if (known) return known;
    return info.kind === 'v3' ? 'DEX V3 (desconhecida)' : 'DEX V2 (desconhecida)';
  }

  /** Reavalia pools que foram criados mas ainda não tinham liquidez no momento da criação. */
  async function recheckPending(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (now - lastRecheck < cfg.pendingRecheckSec) return;
    lastRecheck = now;

    const rows = rt.db
      .prepare(
        `SELECT address FROM pools
          WHERE alerted = 0
            AND COALESCE(created_ts, discovered_ts) >= ?
          ORDER BY COALESCE(created_ts, discovered_ts) DESC
          LIMIT 50`,
      )
      .all(now - cfg.pendingWindowSec) as Array<{ address: string }>;

    for (const row of rows) {
      const info = await registry.resolve(row.address as Address);
      if (!info) continue;
      try {
        await evaluatePool(info);
      } catch (err) {
        rt.log.warn({ err, pool: row.address }, 'falha ao reavaliar pool pendente');
      }
    }
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
