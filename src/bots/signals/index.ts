import type { Address } from 'viem';
import { loadDexConfig, loadSignalsConfig } from '../../config/load.js';
import { lastAlertFor, recordAlert, underHourlyCap } from '../../core/alerts.js';
import { TOPIC, decodeSwap } from '../../core/events.js';
import { fromUnits } from '../../core/format.js';
import { PoolRegistry, type PoolInfo, type PoolLiquidity } from '../../core/pools.js';
import { createRuntime } from '../../core/runtime.js';
import { LogScanner, type ScanBatch } from '../../core/scanner.js';
import { readTokenMetas, type TokenMeta } from '../../core/tokens.js';
import { normalizeSwap, type Trade } from '../../core/trades.js';
import { activeTokens, windowStats } from './metrics.js';
import { renderSignalAlert } from './message.js';
import { evaluateSignal, shouldAlert } from './rules.js';

const KIND = 'signal';

async function main(): Promise<void> {
  const rt = createRuntime('SIGNALS', 'arc-signals');
  const cfg = loadSignalsConfig();
  const dex = loadDexConfig();
  const registry = new PoolRegistry(rt.db, rt.chain, rt.network.quoteTokens);

  const denyTokens = new Set(dex.tokenDenylist);
  const metaCache = new Map<Address, TokenMeta>();
  const liquidityCache = new Map<string, { value: PoolLiquidity; ts: number }>();
  let lastEvaluation = 0;

  const insertTrade = rt.db.prepare(
    `INSERT INTO trades (pool, token, ts, block, tx_hash, log_index, side,
                         token_amount, quote_amount, usd, price_usd, trader)
     VALUES (@pool, @token, @ts, @block, @txHash, @logIndex, @side,
             @tokenAmount, @quoteAmount, @usd, @priceUsd, @trader)
     ON CONFLICT(tx_hash, log_index) DO NOTHING`,
  );
  const insertTrades = rt.db.transaction((trades: Trade[]) => {
    for (const trade of trades) insertTrade.run(trade);
  });

  const scanner = new LogScanner(rt.chain, rt.db, rt.log, {
    scope: 'signals',
    filters: [{ topics: [[TOPIC.v2Swap, TOPIC.v3Swap]] }],
    startBlock: rt.env.startBlock,
    idleCallback: () => evaluate(),
  });

  rt.onShutdown(() => scanner.stop());

  await scanner.run(async (batch) => {
    await ingest(batch);
    await evaluate();
  });

  /** Converte os Swap do lote em trades normalizados e grava. */
  async function ingest(batch: ScanBatch): Promise<void> {
    const trades: Trade[] = [];

    for (const log of batch.logs) {
      const swap = decodeSwap(log);
      if (!swap) continue;

      const pool = await registry.resolve(swap.pool);
      // Pool sem quote conhecido: não dá para precificar em USD, então é ignorado.
      if (!pool) continue;
      if (denyTokens.has(pool.baseToken)) continue;

      const quote = registry.quoteFor(pool.quoteToken);
      if (!quote) continue;
      const quoteUsd = quote.usdPrice ?? (quote.isStable ? 1 : 0);
      if (quoteUsd <= 0) continue;

      const meta = await tokenMeta(pool.baseToken);
      if (!meta?.isErc20) continue;

      const trade = normalizeSwap(swap, {
        pool,
        quote,
        quoteUsdPrice: quoteUsd,
        baseDecimals: meta.decimals,
        ts: await batch.timestampOf(log),
        block: Number(BigInt(log.blockNumber)),
        txHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
      });
      if (trade) trades.push(trade);
    }

    if (trades.length === 0) return;

    if (cfg.advanced.resolveTradersFromTx) await resolveTraders(trades);
    else discardHopRecipients(trades);

    insertTrades(trades);
    rt.log.debug({ trades: trades.length }, 'trades ingeridos');
  }

  /**
   * Em swap multi-hop o destinatário do evento é o próximo pool, não a pessoa.
   * Buscar tx.from resolve isso e deixa "compradores únicos" exato — ao custo de
   * uma chamada RPC por transação. Só transações distintas são consultadas.
   */
  async function resolveTraders(trades: Trade[]): Promise<void> {
    const byTx = new Map<string, Address>();
    for (const trade of trades) byTx.set(trade.txHash, trade.trader);

    await Promise.all(
      [...byTx.keys()].map(async (hash) => {
        try {
          const tx = await rt.chain.client.getTransaction({ hash: hash as `0x${string}` });
          byTx.set(hash, tx.from.toLowerCase() as Address);
        } catch {
          // Falha na busca: mantém o destinatário do evento como aproximação.
        }
      }),
    );

    for (const trade of trades) {
      trade.trader = byTx.get(trade.txHash) ?? trade.trader;
    }
  }

  /**
   * Alternativa barata: se o "trader" é um pool conhecido, o swap é um hop
   * intermediário. Contar o pool como comprador inflaria carteiras únicas.
   */
  function discardHopRecipients(trades: Trade[]): void {
    for (const trade of trades) {
      const row = rt.db.prepare('SELECT 1 AS hit FROM pools WHERE address = ?').get(trade.trader) as
        | { hit: number }
        | undefined;
      if (row) trade.trader = `hop:${trade.txHash}` as Address;
    }
  }

  async function tokenMeta(address: Address): Promise<TokenMeta | null> {
    const cached = metaCache.get(address);
    if (cached) return cached;

    const row = rt.db.prepare('SELECT * FROM tokens WHERE address = ?').get(address) as
      | {
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          total_supply: string;
          is_erc20: number;
        }
      | undefined;

    if (row) {
      const meta: TokenMeta = {
        address: row.address as Address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        totalSupply: BigInt(row.total_supply),
        isErc20: row.is_erc20 === 1,
      };
      metaCache.set(address, meta);
      return meta;
    }

    const metas = await readTokenMetas(rt.chain, [address]);
    const meta = metas.get(address);
    if (!meta) return null;

    rt.db
      .prepare(
        `INSERT INTO tokens (address, symbol, name, decimals, total_supply,
                             first_seen_block, first_seen_ts, is_erc20)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(address) DO NOTHING`,
      )
      .run(
        meta.address,
        meta.symbol,
        meta.name,
        meta.decimals,
        meta.totalSupply.toString(),
        Math.floor(Date.now() / 1000),
        meta.isErc20 ? 1 : 0,
      );

    metaCache.set(address, meta);
    return meta;
  }

  /** Pool com mais volume do token na janela longa — é dele que sai preço e liquidez. */
  function primaryPool(token: string, sinceTs: number): string | null {
    const row = rt.db
      .prepare(
        `SELECT pool, SUM(usd) AS volume FROM trades
          WHERE token = ? AND ts >= ?
          GROUP BY pool ORDER BY volume DESC LIMIT 1`,
      )
      .get(token, sinceTs) as { pool: string } | undefined;
    return row?.pool ?? null;
  }

  async function poolLiquidity(
    pool: PoolInfo,
    quoteUsd: number,
    baseDecimals: number,
  ): Promise<PoolLiquidity> {
    const now = Date.now();
    const cached = liquidityCache.get(pool.address);
    if (cached && now - cached.ts < cfg.advanced.liquidityCacheSec * 1000) return cached.value;
    const value = await registry.liquidity(pool, quoteUsd, baseDecimals);
    liquidityCache.set(pool.address, { value, ts: now });
    return value;
  }

  /**
   * Avalia os tokens que negociaram recentemente e publica os que passam.
   * Roda em intervalo fixo, não a cada lote: no pico, lotes chegam a cada segundo
   * e reavaliar tudo toda vez só queima RPC sem mudar o resultado.
   */
  async function evaluate(): Promise<void> {
    const nowTs = Math.floor(Date.now() / 1000);
    if (nowTs - lastEvaluation < cfg.advanced.evaluateIntervalSec) return;
    lastEvaluation = nowTs;

    const candidates = activeTokens(rt.db, nowTs - cfg.windows.shortSec).slice(
      0,
      cfg.advanced.maxTokensPerEvaluation,
    );
    if (candidates.length === 0) return;

    for (const token of candidates) {
      try {
        await evaluateToken(token as Address, nowTs);
      } catch (err) {
        rt.log.warn({ err, token }, 'falha ao avaliar token');
      }
    }
  }

  async function evaluateToken(token: Address, nowTs: number): Promise<void> {
    const short = windowStats(rt.db, token, nowTs, cfg.windows.shortSec);
    const medium = windowStats(rt.db, token, nowTs, cfg.windows.mediumSec);
    const long = windowStats(rt.db, token, nowTs, cfg.windows.longSec);

    // Corte barato antes de qualquer chamada RPC: a esmagadora maioria dos tokens
    // ativos não chega nem perto do mínimo, e liquidez custa uma chamada.
    if (short.buys < cfg.eligibility.minBuysShort) return;

    const poolAddress = primaryPool(token, nowTs - cfg.windows.longSec);
    if (!poolAddress) return;
    const pool = await registry.resolve(poolAddress as Address);
    if (!pool) return;

    const quote = registry.quoteFor(pool.quoteToken);
    if (!quote) return;
    const quoteUsd = quote.usdPrice ?? (quote.isStable ? 1 : 0);
    if (quoteUsd <= 0) return;

    const meta = await tokenMeta(token);
    if (!meta) return;

    const liquidity = await poolLiquidity(pool, quoteUsd, meta.decimals);

    // Idade real do pool, por busca binária no bloco de deploy quando não vimos
    // a criação. Se não der para determinar, fica null — e as regras de idade
    // simplesmente não se aplicam, em vez de usar um número inventado.
    const bornAt = await registry.ensureCreatedAt(pool);
    const ageSec = bornAt !== null ? Math.max(0, nowTs - bornAt) : null;

    const priceUsd = short.lastPriceUsd ?? 0;
    const supply = fromUnits(meta.totalSupply, meta.decimals);
    const marketCapUsd = priceUsd > 0 && supply > 0 ? priceUsd * supply : null;

    // Sinal usa o lado QUOTE como liquidez: é o dinheiro contra o qual dá para
    // vender. Alertar compra em pool onde não há como sair é armar cilada para
    // quem segue o canal — e canal com essa fama não sobrevive.
    const result = evaluateSignal(
      { ageSec, liquidityUsd: liquidity.quoteUsd, marketCapUsd, short, medium, long },
      cfg,
    );

    if (!result.eligible) {
      rt.log.debug({ token, motivo: result.rejection }, 'token inelegível');
      return;
    }

    const previous = lastAlertFor(rt.db, KIND, token);
    if (!shouldAlert(result, cfg, previous, nowTs)) {
      rt.log.debug({ token, score: result.score }, 'sinal abaixo do corte ou em cooldown');
      return;
    }

    if (!underHourlyCap(rt.db, KIND, cfg.maxAlertsPerHour)) {
      rt.log.warn('teto de alertas por hora atingido, sinal suprimido');
      return;
    }

    rt.publisher.publish(
      renderSignalAlert({
        networkName: rt.network.name,
        tokenAddress: token,
        tokenName: meta.name,
        tokenSymbol: meta.symbol,
        poolAddress: pool.address,
        dexLabel: dexLabel(pool),
        quoteSymbol: quote.symbol,
        priceUsd,
        marketCapUsd,
        liquidity,
        ageSec,
        short,
        medium,
        long,
        result,
        explorerTokenUrl: rt.chain.addressUrl(token),
        links: rt.referrals.build({
          token,
          pool: pool.address,
          chainId: rt.network.chainId,
        }),
        footer: rt.referrals.footer(),
      }),
    );

    recordAlert(rt.db, KIND, token, result.score);
    rt.log.info(
      { token: meta.symbol, score: result.score, motivos: result.reasons },
      'sinal alertado',
    );
  }

  function dexLabel(pool: PoolInfo): string {
    const known = pool.factory ? dex.factoryLabels[pool.factory] : undefined;
    if (known) return known;
    return pool.kind === 'v3' ? 'DEX V3' : 'DEX V2';
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
