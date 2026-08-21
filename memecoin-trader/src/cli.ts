import {
  assertLiveAllowed,
  configPathForChain,
  loadEnv,
  loadTraderConfig,
  type TraderConfig,
  type TraderEnv,
} from './config.js';
import { CHAIN_DESCRIPTIONS, ClaudeAdvisor, type Advisor } from './advisor.js';
import { LiveBroker, PaperBroker } from './brokers.js';
import { BscChain } from './chains/bsc/index.js';
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
  fetchNativePriceUsd,
  fetchPairsForMints,
  fetchTopBoosts,
} from './datasources/dexscreener.js';
import {
  fetchDexPools,
  fetchNewPools,
  fetchTrendingPools,
  GtSnapshotStore,
  type GtPools,
} from './datasources/geckoterminal.js';
import { fetchGoPlusSecurity } from './datasources/goplus.js';
import { PumpPortalFeed } from './datasources/pumpportal.js';
import { fetchRugcheck } from './datasources/rugcheck.js';
import { cachedSource, TraderEngine, type Sources } from './engine.js';
import { startDashboard } from './server.js';
import { ageMin, cleanLabel, pct, price, shortAddr, sol, table, usd } from './format.js';
import { logger } from './log.js';
import { computeTradeStats, MIN_SAMPLE_FOR_DECISION } from './stats.js';
import { loadKeypair } from './wallet.js';
import type { Broker, Candidate, ChainAdapter, PairSnapshot } from './types.js';

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
  /**
   * Config VIVO: o painel troca `cfgBox.current` ao salvar, e quem precisa dos
   * valores vigentes (o advisor de IA monta o prompt a cada chamada) lê daqui.
   */
  cfgBox: { current: TraderConfig };
  env: TraderEnv;
  db: Db;
  chain: ChainAdapter;
  broker: Broker;
  engine: TraderEngine;
  /** Feed websocket do pump.fun — só é ligado no `run` (processos one-shot não têm o que ouvir). */
  pumpportal: PumpPortalFeed | null;
}

/**
 * As fontes da rede deste processo. Solana e BSC compartilham DexScreener e
 * GeckoTerminal (parametrizados); a análise de segurança muda de mundo:
 * RugCheck na Solana, GoPlus na BSC (honeypot/taxas de contrato).
 */
function buildSources(
  cfg: TraderConfig,
  pumpportal: PumpPortalFeed | null,
  chain: 'solana' | 'bsc',
): Sources {
  // As fontes de DESCOBERTA por HTTP são cacheadas (rate limit do GeckoTerminal);
  // enriquecimento e preço do nativo continuam frescos a cada tick. O PumpPortal
  // é push (websocket, só Solana) — a watchlist dele já é o "cache".
  const ttlMs = cfg.discovery.sourceTtlSec * 1000;

  // O GeckoTerminal devolve preço, volume 5m/1h, txns, reserva e idade no MESMO
  // payload da descoberta. O DexScreener leva minutos para indexar um par
  // recém-criado — exatamente a janela da estratégia de bonding curve —, então
  // guardamos o que já veio e usamos como enriquecimento de fallback. Medido na
  // BSC: sem isso, os four-meme frescos viravam "candidato sem par" e nunca
  // chegavam a ser avaliados. Custo: zero requisições a mais.
  const gtSnaps = new GtSnapshotStore();
  const gtSource = (source: string, fetch: () => Promise<GtPools>): (() => Promise<Candidate[]>) => {
    const cached = cachedSource(fetch, ttlMs);
    return async () => {
      const pools = await cached();
      gtSnaps.put(source, pools.snaps);
      return pools.candidates;
    };
  };

  return {
    pumpportal: async () => pumpportal?.candidates() ?? [],
    trending: gtSource('trending', () => fetchTrendingPools(chain)),
    newPools: gtSource('new', () => fetchNewPools(chain)),
    dexPools: gtSource('dex', async () => {
      // Uma falha de plataforma não pode derrubar as outras.
      const settled = await Promise.allSettled(
        cfg.discovery.gtDexes.map((dex) => fetchDexPools(chain, dex)),
      );
      const candidates: Candidate[] = [];
      const snaps = new Map<string, PairSnapshot>();
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        candidates.push(...r.value.candidates);
        for (const [mint, snap] of r.value.snaps) {
          if ((snap.liquidityUsd ?? -1) > (snaps.get(mint)?.liquidityUsd ?? -1)) snaps.set(mint, snap);
        }
      }
      return { candidates, snaps };
    }),
    boosts: cachedSource(() => fetchTopBoosts(chain), ttlMs),
    pairs: async (mints) => {
      const found = await fetchPairsForMints(mints, Date.now(), chain);
      gtSnaps.fill(found, mints);
      return found;
    },
    rugcheck:
      chain === 'bsc'
        ? (mint) => fetchGoPlusSecurity(mint, cfg.risk.rugcheckTimeoutMs)
        : (mint) => fetchRugcheck(mint, cfg.risk.rugcheckTimeoutMs),
    solPriceUsd: () => fetchNativePriceUsd(chain),
  };
}

async function buildCtx(): Promise<Ctx> {
  const env = loadEnv();
  const cfg = loadTraderConfig(configPathForChain(env.chain));
  assertLiveAllowed(env);

  const db = openTraderDb(env.dataDir, env.chain);

  let chain: ChainAdapter;
  let broker: Broker;
  let pumpportal: PumpPortalFeed | null = null;

  if (env.chain === 'bsc') {
    // FASE 1: BSC roda só em paper (assertLiveAllowed já barrou o live).
    chain = await BscChain.connect(env.bscRpcUrls, logger);
    broker = new PaperBroker(db, cfg.execution, cfg.sizing);
  } else {
    const keypair = loadKeypair(env);
    const solana = await SolanaChain.connect(env.rpcUrls, keypair, logger);
    const jupiter = new JupiterClient(env.jupiterBaseUrl, env.jupiterApiKey);
    chain = solana;
    broker =
      env.mode === 'live'
        ? new LiveBroker(solana, jupiter, cfg.execution, logger)
        : new PaperBroker(db, cfg.execution, cfg.sizing);
    pumpportal = cfg.discovery.pumpportal.enabled
      ? new PumpPortalFeed(cfg.discovery.pumpportal, logger)
      : null;
  }

  const cfgBox = { current: cfg };

  // Filtro de IA: só liga com a seção ai.enabled E a chave no .env. Sem chave,
  // avisa uma vez e segue — o bot nunca depende da IA para operar.
  let advisor: Advisor | null = null;
  if (cfg.ai.enabled) {
    if (env.anthropicApiKey) {
      advisor = new ClaudeAdvisor(
        () => cfgBox.current,
        env.anthropicApiKey,
        logger,
        CHAIN_DESCRIPTIONS[env.chain],
      );
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
    buildSources(cfg, pumpportal, env.chain),
    logger,
    advisor,
  );
  return { cfg, cfgBox, env, db, chain, broker, engine, pumpportal };
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
        configPath: configPathForChain(ctx.env.chain),
        applyConfig: (cfg) => {
          ctx.cfgBox.current = cfg;
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
  const rede = ctx.env.chain === 'bsc' ? 'BSC' : 'Solana';
  if (ctx.env.liveDowngraded) {
    logger.warn(
      `⚠️  TRADER_MODE=live no .env, mas a ${rede} ainda não executa ao vivo (fase 2) — ` +
        'este processo foi rebaixado para PAPER. Nenhuma ordem real será enviada nesta rede.',
    );
  }
  if (ctx.env.mode === 'live') {
    logger.warn(
      { wallet: ctx.chain.walletAddress(), rede },
      `🔴 MODO LIVE (${rede}) — as ordens gastam dinheiro de verdade`,
    );
  } else {
    logger.info(`🟢 Modo paper (${rede}) — ordens simuladas com preço real de mercado`);
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

  const snaps = await fetchPairsForMints(open.map((p) => p.mint), Date.now(), ctx.env.chain).catch(
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
  const canonical = ctx.env.chain === 'bsc' ? mint.toLowerCase() : mint;
  const snap = (await fetchPairsForMints([canonical], Date.now(), ctx.env.chain)).get(canonical);
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
  if (curve) console.log('(bonding curve — concentração medida sobre o circulante)\n');
  const analysis = await ctx.engine.analyzeToken(canonical, curve);
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
    // Pedágio de entrada por trade: o que a posição valia executável no
    // primeiro tick contra o que ela custou.
    p.entryMarkPriceUsd !== null && p.entryPriceUsd > 0
      ? pct((p.entryMarkPriceUsd / p.entryPriceUsd - 1) * 100)
      : '—',
    p.entryMcapUsd !== null ? usd(p.entryMcapUsd) : '?',
    sol(p.pnlSol ?? 0),
    pct(p.pnlPct ?? 0),
    p.exitReason ?? '?',
  ]);
  console.log(
    table(rows, ['Saída (UTC)', 'Token', 'Gasto(SOL)', 'Pedágio entr.', 'MC entr.', 'PnL(SOL)', 'PnL%', 'Motivo']),
  );

  const s = computeTradeStats(closed);
  console.log(
    `\nTotal (${s.n} trades): ${sol(s.totalPnlSol)} SOL · ${s.wins}W/${s.losses}L · ` +
      `win rate ${s.winRatePct.toFixed(0)}% (IC95% ${s.winRateCi95[0].toFixed(0)}–${s.winRateCi95[1].toFixed(0)}%)`,
  );
  console.log(
    `Expectativa por trade: ${sol(s.expectancySol)} SOL` +
      (s.avgWinPct !== null && s.avgLossPct !== null
        ? ` · ganho médio ${pct(s.avgWinPct)} vs perda média ${pct(s.avgLossPct)}`
        : '') +
      (s.medianHoldMin !== null ? ` · hold mediano ${ageMin(s.medianHoldMin)}` : ''),
  );
  if (s.breakevenWrPct !== null) {
    const veredito = s.winRatePct >= s.breakevenWrPct ? 'acima' : 'ABAIXO';
    console.log(
      `Win rate de breakeven com este payoff: ${s.breakevenWrPct.toFixed(0)}% — você está ${veredito} dela.`,
    );
  }

  // O número mais importante e o que estava escondido: se o pedágio de entrada
  // é da ordem do alvo de lucro, o trade nasce perdido e nenhum gate salva.
  if (s.entryTollPct) {
    const alvo = ctx.cfg.exit.takeProfitPct;
    const t = s.entryTollPct;
    console.log(
      `\nPedágio de ENTRADA (impacto + taxas), mediana de ${t.n} trades: ${pct(t.medianPct)} ` +
        `— contra um alvo de lucro de +${alvo}%.`,
    );
    if (Math.abs(t.medianPct) >= alvo * 0.5) {
      console.log(
        `  ⚠️  O pedágio já consome ${((Math.abs(t.medianPct) / alvo) * 100).toFixed(0)}% do alvo. ` +
          'Reduza o tamanho da posição, exija pool mais fundo ou aumente o alvo — ajustar gates não resolve isto.',
      );
    }
  } else {
    console.log(
      '\nPedágio de entrada: sem medição (nenhuma posição tem marca executável — normal no modo paper).',
    );
  }

  console.log('\nPnL por motivo de saída (o que drena a banca):');
  for (const r of s.byExitReason) {
    console.log(`   ${r.reason.padEnd(22)} ${String(r.n).padStart(3)} trades  ${sol(r.pnlSol)} SOL`);
  }

  if (s.n < MIN_SAMPLE_FOR_DECISION) {
    console.log(
      `\n⚠️  Amostra de ${s.n} trades é pequena demais para decidir mudança de config ` +
        `(o IC95% da win rate vai de ${s.winRateCi95[0].toFixed(0)}% a ${s.winRateCi95[1].toFixed(0)}%). ` +
        `Abaixo de ${MIN_SAMPLE_FOR_DECISION} trades, ajustar parâmetros é ajustar ruído.`,
    );
  }
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
    env = loadEnv();
    assertLiveAllowed(env);
    ok(`rede ${env.chain} · modo ${env.mode}`, env.mode === 'live' ? 'com LIVE_TRADING_ACK confirmado' : 'ordens simuladas');
  } catch (err) {
    bad('modo de operação', (err as Error).message);
    process.exitCode = 1;
    return;
  }
  try {
    cfg = loadTraderConfig(configPathForChain(env.chain));
    ok(`config ${env.chain === 'bsc' ? 'trader.bsc.json' : 'trader.json'} válido`);
  } catch (err) {
    bad('config', (err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (env.chain === 'bsc') {
    console.log('\nRPC da BSC:');
    try {
      await BscChain.connect(env.bscRpcUrls, logger);
      ok('RPC respondendo');
    } catch (err) {
      bad('RPC', (err as Error).message);
    }

    console.log('\nFontes de dados:');
    try {
      const bnb = await fetchNativePriceUsd('bsc');
      if (bnb) ok('DexScreener', `BNB a ${usd(bnb)}`);
      else bad('DexScreener', 'sem preço do BNB');
    } catch (err) {
      bad('DexScreener', (err as Error).message);
    }
    try {
      const trending = await fetchTrendingPools('bsc');
      ok('GeckoTerminal trending (bsc)', `${trending.candidates.length} pools`);
    } catch (err) {
      bad('GeckoTerminal', (err as Error).message);
    }
    // CAKE: token estabelecido — se o GoPlus não analisa nem ele, está fora do ar.
    const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
    const gp = await fetchGoPlusSecurity(CAKE, cfg.risk.rugcheckTimeoutMs);
    if (gp.available) ok('GoPlus', `CAKE analisado (${gp.dangerFlags.length} danger flags)`);
    else bad('GoPlus', `${gp.reason} — e requireRugcheck=true bloqueia tudo sem ele`);

    console.log(
      failures === 0
        ? '\nTudo pronto. Rode `TRADER_CHAIN=bsc npm run trader -- run` (paper — live é a fase 2).'
        : `\n${failures} problema(s) acima precisam de atenção antes de rodar.`,
    );
    if (failures > 0) process.exitCode = 1;
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
    const solPrice = await fetchNativePriceUsd('solana');
    if (solPrice) ok('DexScreener', `SOL a ${usd(solPrice)}`);
    else bad('DexScreener', 'sem preço do SOL');
  } catch (err) {
    bad('DexScreener', (err as Error).message);
  }
  try {
    const trending = await fetchTrendingPools();
    ok('GeckoTerminal trending', `${trending.candidates.length} pools`);
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
