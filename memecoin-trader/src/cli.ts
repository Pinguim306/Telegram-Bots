import { resolve } from 'node:path';
import {
  assertLiveAllowed,
  loadEnv,
  loadTraderConfig,
  projectRoot,
  type TraderConfig,
  type TraderEnv,
} from './config.js';
import { ClaudeAdvisor, type Advisor } from './advisor.js';
import { LiveBroker, PaperBroker } from './brokers.js';
import { JupiterClient } from './chains/solana/jupiter.js';
import { SolanaChain } from './chains/solana/index.js';
import {
  getDailyStats,
  listClosedPositions,
  listOpenPositions,
  openTraderDb,
  type Db,
} from './db.js';
import {
  fetchPairsForMints,
  fetchSolPriceUsd,
  fetchTopBoosts,
} from './datasources/dexscreener.js';
import { fetchNewPools, fetchTrendingPools } from './datasources/geckoterminal.js';
import { PumpPortalFeed } from './datasources/pumpportal.js';
import { fetchRugcheck } from './datasources/rugcheck.js';
import { cachedSource, TraderEngine, type Sources } from './engine.js';
import { startDashboard } from './server.js';
import { ageMin, cleanLabel, pct, price, shortAddr, sol, table, usd } from './format.js';
import { logger } from './log.js';
import { loadKeypair } from './wallet.js';
import type { Broker } from './types.js';

const HELP = `
memecoin-trader — bot pessoal de trading de memecoins na Solana

Uso: npm run trader -- <comando> [args]

Comandos:
  run                     Liga o bot (loop contínuo; Ctrl+C para parar)
  tick                    Executa UM ciclo de análise/gestão e sai (bom p/ testar)
  status                  Saldo, posições abertas com PnL e estatística do dia
  check <mint>            Relatório completo de risco + sinal de entrada de um token
  buy <mint> <sol> [--force]
                          Compra manual (passa pela análise de risco; --force ignora)
  sell <mint|all> [pct]   Vende posição aberta (padrão: 100%)
  history [n]             Últimas n posições fechadas (padrão: 20) e totais
  paper-reset             Zera o caixa simulado do modo paper
  doctor                  Valida config, RPC, Jupiter, fontes de dados e carteira

Modo: definido por TRADER_MODE no .env (paper é o padrão — e é onde se começa).
`.trim();

interface Ctx {
  cfg: TraderConfig;
  env: TraderEnv;
  db: Db;
  chain: SolanaChain;
  broker: Broker;
  engine: TraderEngine;
  /** Feed websocket do pump.fun — só é ligado no `run` (processos one-shot não têm o que ouvir). */
  pumpportal: PumpPortalFeed | null;
}

function buildSources(cfg: TraderConfig, pumpportal: PumpPortalFeed | null): Sources {
  // As fontes de DESCOBERTA por HTTP são cacheadas (rate limit do GeckoTerminal);
  // enriquecimento e preço do SOL continuam frescos a cada tick. O PumpPortal é
  // push (websocket) — a watchlist dele já é o "cache".
  const ttlMs = cfg.discovery.sourceTtlSec * 1000;
  return {
    pumpportal: async () => pumpportal?.candidates() ?? [],
    trending: cachedSource(fetchTrendingPools, ttlMs),
    newPools: cachedSource(fetchNewPools, ttlMs),
    boosts: cachedSource(fetchTopBoosts, ttlMs),
    pairs: (mints) => fetchPairsForMints(mints),
    rugcheck: (mint) => fetchRugcheck(mint, cfg.risk.rugcheckTimeoutMs),
    solPriceUsd: fetchSolPriceUsd,
  };
}

async function buildCtx(): Promise<Ctx> {
  const cfg = loadTraderConfig();
  const env = loadEnv();
  assertLiveAllowed(env);

  const db = openTraderDb(env.dataDir);
  const keypair = loadKeypair(env);
  const chain = await SolanaChain.connect(env.rpcUrls, keypair, logger);
  const jupiter = new JupiterClient(env.jupiterBaseUrl, env.jupiterApiKey);
  const broker: Broker =
    env.mode === 'live'
      ? new LiveBroker(chain, jupiter, cfg.execution, logger)
      : new PaperBroker(db, cfg.execution, cfg.sizing);
  const pumpportal = cfg.discovery.pumpportal.enabled
    ? new PumpPortalFeed(cfg.discovery.pumpportal, logger)
    : null;

  // Filtro de IA: só liga com a seção ai.enabled E a chave no .env. Sem chave,
  // avisa uma vez e segue — o bot nunca depende da IA para operar.
  let advisor: Advisor | null = null;
  if (cfg.ai.enabled) {
    if (env.anthropicApiKey) {
      advisor = new ClaudeAdvisor(cfg.ai, env.anthropicApiKey, logger);
      logger.info(
        { model: cfg.ai.model, minConfidence: cfg.ai.minConfidence },
        'Filtro de IA ligado — segunda opinião do Claude antes de cada compra',
      );
    } else {
      logger.warn(
        'ai.enabled=true mas ANTHROPIC_API_KEY não está no .env — seguindo SEM o filtro de IA',
      );
    }
  }

  const engine = new TraderEngine(
    cfg,
    db,
    broker,
    chain,
    buildSources(cfg, pumpportal),
    logger,
    advisor,
  );
  return { cfg, env, db, chain, broker, engine, pumpportal };
}

// ─────────────────────────────────────────────────────────────
//  Comandos
// ─────────────────────────────────────────────────────────────

async function cmdRun(): Promise<void> {
  const ctx = await buildCtx();
  printModeBanner(ctx);
  ctx.pumpportal?.start();

  if (ctx.cfg.dashboard.enabled) {
    try {
      await startDashboard(ctx.cfg.dashboard.port, {
        db: ctx.db,
        engine: ctx.engine,
        broker: ctx.broker,
        walletAddress: ctx.chain.walletAddress(),
        configPath: resolve(projectRoot, 'config', 'trader.json'),
        applyConfig: (cfg) => {
          ctx.engine.updateConfig(cfg);
          ctx.broker.updateConfig?.(cfg.execution, cfg.sizing);
        },
        log: logger,
      });
    } catch (err) {
      // Painel indisponível (porta ocupada?) não pode impedir o bot de operar.
      logger.warn({ err: (err as Error).message }, 'Painel web não subiu — bot segue sem ele');
    }
  }

  // 1º Ctrl+C: gracioso (termina o tick em andamento e sai).
  // 2º Ctrl+C: forçado — um tick preso numa espera de rede longa (confirmação
  // de tx, retry de RPC) seguraria o gracioso por minutos; ninguém deve
  // precisar de pkill para desligar o próprio bot.
  let interrupts = 0;
  const shutdown = (signal: string) => {
    interrupts++;
    if (interrupts === 1) {
      logger.info(`${signal} — encerrando após o tick atual (Ctrl+C de novo força a saída)`);
      ctx.pumpportal?.stop();
      ctx.engine.stop();
    } else {
      logger.warn(
        'Saída FORÇADA. Posições seguem salvas no banco; ordem em voo (se houver) é reconciliada pelo saldo real no próximo boot.',
      );
      process.exit(130);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await ctx.engine.runLoop();
  // Saída explícita: websocket/timers residuais não podem segurar o processo
  // depois que o loop terminou.
  process.exit(0);
}

async function cmdTick(): Promise<void> {
  const ctx = await buildCtx();
  printModeBanner(ctx);
  await ctx.engine.tick();
  logger.info('Tick único concluído');
}

function printModeBanner(ctx: Ctx): void {
  if (ctx.env.mode === 'live') {
    logger.warn(
      { wallet: ctx.chain.walletAddress() },
      '🔴 MODO LIVE — as ordens gastam SOL de verdade',
    );
  } else {
    logger.info('🟢 Modo paper — ordens simuladas com preço real de mercado');
  }
}

async function cmdStatus(): Promise<void> {
  const ctx = await buildCtx();
  const nowTs = Math.floor(Date.now() / 1000);
  const balance = await ctx.broker.balanceSol();
  const open = listOpenPositions(ctx.db, ctx.broker.mode);
  const daily = getDailyStats(ctx.db, nowTs);

  console.log(`\nModo: ${ctx.broker.mode}`);
  if (ctx.chain.walletAddress()) console.log(`Carteira: ${ctx.chain.walletAddress()}`);
  console.log(`Saldo: ${sol(balance)} SOL`);
  console.log(
    `Hoje (${daily.day} UTC): ${sol(daily.realizedPnlSol)} SOL realizados em ${daily.trades} trades (${daily.wins}W/${daily.losses}L)\n`,
  );

  if (open.length === 0) {
    console.log('Nenhuma posição aberta.');
    return;
  }

  const snaps = await fetchPairsForMints(open.map((p) => p.mint)).catch(
    () => new Map<string, never>(),
  );
  const rows = open.map((p) => {
    const current = snaps.get(p.mint)?.priceUsd ?? p.lastPriceUsd;
    const pnlPct = p.entryPriceUsd > 0 ? (current / p.entryPriceUsd - 1) * 100 : 0;
    const holdMin = (nowTs - p.entryTs) / 60;
    return [
      // cleanLabel de novo na saída: linhas antigas do banco podem ter sido
      // gravadas antes da sanitização na ingestão existir.
      cleanLabel(p.symbol, 12),
      shortAddr(p.mint),
      sol(p.solSpent),
      p.entryMcapUsd !== null ? usd(p.entryMcapUsd) : '?',
      `$${price(p.entryPriceUsd)}`,
      `$${price(current)}`,
      pct(pnlPct),
      ageMin(holdMin),
      p.tookProfit ? 'TP✓' : '',
    ];
  });
  console.log(
    table(rows, ['Token', 'Mint', 'Entrada(SOL)', 'MC entr.', 'Preço entr.', 'Preço atual', 'PnL', 'Tempo', '']),
  );
}

async function cmdCheck(mint: string | undefined): Promise<void> {
  if (!mint) throw new Error('Uso: check <mint>');
  const ctx = await buildCtx();

  console.log(`\nAnalisando ${mint}...\n`);
  const snap = (await fetchPairsForMints([mint])).get(mint);
  if (snap) {
    console.log(`Token:      ${snap.symbol} (${snap.name}) na ${snap.dexId}`);
    console.log(`Preço:      $${price(snap.priceUsd)}  (5m ${pct(snap.change5mPct)} · 1h ${pct(snap.change1hPct)} · 24h ${pct(snap.change24hPct)})`);
    console.log(
      `Liquidez:   ${snap.liquidityUsd !== null ? usd(snap.liquidityUsd) : '?'}   Volume 24h: ${usd(snap.vol24hUsd)}`,
    );
    console.log(`Market cap: ${snap.marketCapUsd !== null ? usd(snap.marketCapUsd) : '?'}   Idade: ${ageMin(snap.ageMin)}`);
    console.log(`Txns 1h:    ${snap.buys1h} compras / ${snap.sells1h} vendas\n`);
  } else {
    console.log('Sem par negociável no DexScreener (token muito novo ou sem pool).\n');
  }

  const curve = snap ? ctx.cfg.entry.gates.curveDexIds.includes(snap.dexId) : false;
  if (curve) console.log('(bonding curve — gates de liquidez e concentração não se aplicam)\n');
  const analysis = await ctx.engine.analyzeToken(mint, curve);
  const { report } = analysis;
  const emoji = report.verdict === 'approved' ? '🟢' : report.verdict === 'rejected' ? '🟡' : '🔴';
  console.log(`${emoji} Risco: ${report.score}/100 — ${report.verdict.toUpperCase()}`);
  for (const flag of report.flags) {
    console.log(`   [${flag.severity}] ${flag.label}`);
  }
  if (report.flags.length === 0) console.log('   (nenhuma flag)');

  if (snap) {
    const entry = ctx.cfg.entry;
    const result = (await import('./strategy.js')).evaluateEntry(snap, ['gt-trending'], entry);
    console.log(
      result.eligible
        ? `\nSinal de entrada: ${result.score}/${entry.minScore} pts — ${result.reasons.join(', ') || 'nenhuma regra pontuou'}`
        : `\nSinal de entrada: reprovado no gate (${result.rejection})`,
    );
  }
}

async function cmdBuy(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const positional = args.filter((a) => a !== '--force');
  const [mint, solStr] = positional;
  const solAmount = Number(solStr);
  if (!mint || !Number.isFinite(solAmount) || solAmount <= 0) {
    throw new Error('Uso: buy <mint> <quantidade-em-SOL> [--force]');
  }
  const ctx = await buildCtx();
  printModeBanner(ctx);
  await ctx.engine.manualBuy(mint, solAmount, force);
  console.log('Compra registrada. Veja `status`.');
}

async function cmdSell(args: string[]): Promise<void> {
  const [target, pctStr] = args;
  if (!target) throw new Error('Uso: sell <mint|all> [porcentagem]');
  const portion = pctStr !== undefined ? Number(pctStr) : 100;
  if (!Number.isFinite(portion) || portion <= 0 || portion > 100) {
    throw new Error('Porcentagem inválida (1–100)');
  }
  const ctx = await buildCtx();
  printModeBanner(ctx);
  if (target === 'all') {
    await ctx.engine.manualSellAll();
  } else {
    await ctx.engine.manualSell(target, portion);
  }
  console.log('Venda processada. Veja `status` e `history`.');
}

async function cmdHistory(args: string[]): Promise<void> {
  const limit = args[0] ? Number(args[0]) : 20;
  const ctx = await buildCtx();
  const closed = listClosedPositions(ctx.db, ctx.broker.mode, Number.isFinite(limit) ? limit : 20);
  if (closed.length === 0) {
    console.log('Nenhuma posição fechada ainda.');
    return;
  }
  const rows = closed.map((p) => [
    p.exitTs ? new Date(p.exitTs * 1000).toISOString().slice(5, 16).replace('T', ' ') : '?',
    cleanLabel(p.symbol, 12),
    sol(p.solSpent),
    p.entryMcapUsd !== null ? usd(p.entryMcapUsd) : '?',
    p.exitMcapUsd !== null ? usd(p.exitMcapUsd) : '?',
    sol(p.pnlSol ?? 0),
    pct(p.pnlPct ?? 0),
    p.exitReason ?? '?',
  ]);
  console.log(
    table(rows, ['Saída (UTC)', 'Token', 'Gasto(SOL)', 'MC entr.', 'MC saída', 'PnL(SOL)', 'PnL%', 'Motivo']),
  );

  const totalPnl = closed.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  const wins = closed.filter((p) => (p.pnlSol ?? 0) >= 0).length;
  console.log(
    `\nTotal (${closed.length} trades): ${sol(totalPnl)} SOL · ${wins}W/${closed.length - wins}L (${((wins / closed.length) * 100).toFixed(0)}% win rate)`,
  );
}

async function cmdPaperReset(): Promise<void> {
  const ctx = await buildCtx();
  if (ctx.broker.mode !== 'paper') throw new Error('paper-reset só faz sentido com TRADER_MODE=paper');
  const open = listOpenPositions(ctx.db, 'paper');
  if (open.length > 0) {
    throw new Error(`Existem ${open.length} posições paper abertas — venda com \`sell all\` antes de resetar.`);
  }
  await (ctx.broker as PaperBroker).reset();
  console.log(`Caixa paper resetado para ${ctx.cfg.sizing.paperStartBalanceSol} SOL.`);
}

async function cmdDoctor(): Promise<void> {
  let failures = 0;
  const ok = (label: string, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  const bad = (label: string, detail: string) => {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  };

  console.log('\nConfig e ambiente:');
  let cfg: TraderConfig;
  let env: TraderEnv;
  try {
    cfg = loadTraderConfig();
    ok('config/trader.json válido');
  } catch (err) {
    bad('config/trader.json', (err as Error).message);
    process.exitCode = 1;
    return;
  }
  try {
    env = loadEnv();
    assertLiveAllowed(env);
    ok(`modo ${env.mode}`, env.mode === 'live' ? 'com LIVE_TRADING_ACK confirmado' : 'ordens simuladas');
  } catch (err) {
    bad('modo de operação', (err as Error).message);
    process.exitCode = 1;
    return;
  }

  console.log('\nCarteira:');
  let keypair = null;
  try {
    keypair = loadKeypair(env);
    if (keypair) ok('keypair carregada', keypair.publicKey.toBase58());
    else if (env.mode === 'paper') ok('sem carteira (opcional no modo paper)');
    else bad('carteira', 'modo live sem chave');
  } catch (err) {
    bad('keypair', (err as Error).message);
  }

  console.log('\nRPC da Solana:');
  let chain: SolanaChain | null = null;
  try {
    chain = await SolanaChain.connect(env.rpcUrls, keypair, logger);
    ok('RPC respondendo');
    if (keypair) {
      const balance = await chain.nativeBalanceSol();
      const enough = balance >= cfg.sizing.reserveSol + cfg.sizing.minPositionSol;
      if (env.mode === 'live' && !enough) {
        bad('saldo', `${sol(balance)} SOL não cobre reserva (${cfg.sizing.reserveSol}) + posição mínima (${cfg.sizing.minPositionSol})`);
      } else {
        ok('saldo', `${sol(balance)} SOL`);
      }
    }
  } catch (err) {
    bad('RPC', (err as Error).message);
  }

  console.log('\nFontes de dados:');
  // BONK: token estabelecido — se as fontes não acham nem ele, estão fora do ar.
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  try {
    const solPrice = await fetchSolPriceUsd();
    if (solPrice) ok('DexScreener', `SOL a ${usd(solPrice)}`);
    else bad('DexScreener', 'sem preço do SOL');
  } catch (err) {
    bad('DexScreener', (err as Error).message);
  }
  try {
    const trending = await fetchTrendingPools();
    ok('GeckoTerminal trending', `${trending.length} pools`);
  } catch (err) {
    bad('GeckoTerminal', (err as Error).message);
  }
  const rug = await fetchRugcheck(BONK, cfg.risk.rugcheckTimeoutMs);
  if (rug.available) ok('RugCheck', `BONK score ${rug.scoreNormalized ?? '?'} — quanto menor, melhor`);
  else if (cfg.risk.requireRugcheck) bad('RugCheck', `${rug.reason} (e requireRugcheck=true bloqueia tudo sem ele)`);
  else console.log(`  ~ RugCheck indisponível (${rug.reason}) — análise segue só on-chain, com penalidade de score`);

  console.log('\nJupiter:');
  try {
    const jupiter = new JupiterClient(env.jupiterBaseUrl, env.jupiterApiKey);
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const WSOL = 'So11111111111111111111111111111111111111112';
    const quote = await jupiter.quote(WSOL, USDC, 10_000_000n, cfg.execution.slippageBps);
    ok('quote SOL→USDC', `0.01 SOL ≈ ${(Number(quote.outAmount) / 1e6).toFixed(2)} USDC`);
  } catch (err) {
    bad('Jupiter', (err as Error).message);
  }

  console.log(
    failures === 0
      ? '\nTudo pronto. Rode `npm run trader -- run` para ligar o bot.'
      : `\n${failures} problema(s) acima precisam de atenção antes de rodar.`,
  );
  if (failures > 0) process.exitCode = 1;
}

// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case 'run':
      return cmdRun();
    case 'tick':
      return cmdTick();
    case 'status':
      return cmdStatus();
    case 'check':
      return cmdCheck(rest[0]);
    case 'buy':
      return cmdBuy(rest);
    case 'sell':
      return cmdSell(rest);
    case 'history':
      return cmdHistory(rest);
    case 'paper-reset':
      return cmdPaperReset();
    case 'doctor':
      return cmdDoctor();
    default:
      console.error(`Comando desconhecido: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  console.error(`\nErro: ${err.message}`);
  process.exitCode = 1;
});
