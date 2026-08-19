import { NoBalanceError } from './brokers.js';
import { UnknownTxOutcomeError } from './chains/solana/index.js';
import type { TraderConfig } from './config.js';
import {
  applySellFill,
  bumpDailyStats,
  getDailyStats,
  getOpenPositionByMint,
  getPosition,
  insertPosition,
  isOnCooldown,
  kvGet,
  kvSet,
  listOpenPositions,
  markTookProfit,
  recordOrder,
  setTokenCooldown,
  updateTickState,
  upsertTokenLog,
  type Db,
  type Position,
} from './db.js';
import type { Logger } from './log.js';
import { assessRisk, type RiskReport } from './risk.js';
import { blockReason, positionSizeSol } from './sizing.js';
import { evaluateEntry, evaluateExit, type EntryResult, type ExitContext } from './strategy.js';
import type {
  Broker,
  BuyFill,
  Candidate,
  ChainAdapter,
  HolderStats,
  OnchainTokenInfo,
  PairSnapshot,
  RugcheckSummary,
  SellFill,
} from './types.js';

/**
 * O laço principal. Cada tick faz duas coisas, nesta ordem:
 *
 *   1. GERENCIA as posições abertas (atualiza preço, avalia saída, vende) —
 *      proteger o que já está em risco vem antes de procurar risco novo;
 *   2. DESCOBRE candidatos, analisa risco e compra, se houver capacidade.
 *
 * Todas as fontes externas são injetadas (interface Sources) — o engine inteiro
 * roda em teste sem rede nenhuma.
 */

export interface Sources {
  trending(): Promise<Candidate[]>;
  newPools(): Promise<Candidate[]>;
  boosts(): Promise<Candidate[]>;
  pairs(mints: string[]): Promise<Map<string, PairSnapshot>>;
  rugcheck(mint: string): Promise<RugcheckSummary>;
  solPriceUsd(): Promise<number | null>;
}

export interface TokenAnalysis {
  onchain: OnchainTokenInfo | null;
  holders: HolderStats | null;
  rugcheck: RugcheckSummary;
  report: RiskReport;
}

const LAST_SOL_USD_KEY = 'last_sol_usd';

export class TraderEngine {
  private stopped = false;

  constructor(
    private readonly cfg: TraderConfig,
    private readonly db: Db,
    private readonly broker: Broker,
    private readonly chain: ChainAdapter,
    private readonly sources: Sources,
    private readonly log: Logger,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async runLoop(): Promise<void> {
    this.log.info(
      { mode: this.broker.mode, tickSec: this.cfg.loop.tickSec },
      'Engine iniciado — Ctrl+C para parar',
    );
    while (!this.stopped) {
      const started = Date.now();
      try {
        await this.tick();
      } catch (err) {
        // Um tick que explode não pode matar o processo: a posição aberta
        // continua lá e o próximo tick é a chance de sair dela.
        this.log.error({ err: (err as Error).message }, 'Tick falhou');
      }
      const elapsed = Date.now() - started;
      const waitMs = Math.max(1000, this.cfg.loop.tickSec * 1000 - elapsed);
      await interruptibleSleep(waitMs, () => this.stopped);
    }
    this.log.info('Engine parado');
  }

  async tick(nowTs = Math.floor(Date.now() / 1000)): Promise<void> {
    const solUsd = await this.solPriceUsd();
    if (solUsd === null) {
      this.log.warn('Sem preço do SOL neste tick — pulando (nem compra nem venda cega)');
      return;
    }
    await this.managePositions(solUsd, nowTs);
    await this.scanForEntries(solUsd, nowTs);
  }

  /** Preço do SOL com fallback para o último visto — e nunca um número inventado. */
  private async solPriceUsd(): Promise<number | null> {
    try {
      const price = await this.sources.solPriceUsd();
      if (price !== null && price > 0) {
        kvSet(this.db, LAST_SOL_USD_KEY, String(price));
        return price;
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Falha ao buscar preço do SOL');
    }
    const last = Number(kvGet(this.db, LAST_SOL_USD_KEY));
    return Number.isFinite(last) && last > 0 ? last : null;
  }

  // ───────────────────────────────────────────────────────────
  //  Gestão de posições abertas
  // ───────────────────────────────────────────────────────────

  private async managePositions(solUsd: number, nowTs: number): Promise<void> {
    const open = listOpenPositions(this.db, this.broker.mode);
    if (open.length === 0) return;

    let snaps: Map<string, PairSnapshot>;
    try {
      snaps = await this.sources.pairs(open.map((p) => p.mint));
    } catch (err) {
      // Indexador fora do ar ≠ token morto. Não conta como tick "stale" — venda
      // por falta de dados só quando o indexador responde e o token não está lá.
      this.log.warn({ err: (err as Error).message }, 'Enriquecimento indisponível neste tick');
      return;
    }

    for (const pos of open) {
      const snap = snaps.get(pos.mint) ?? null;

      if (snap) {
        updateTickState(this.db, pos.id, Math.max(pos.peakPriceUsd, snap.priceUsd), snap.priceUsd, 0);
      } else {
        updateTickState(this.db, pos.id, pos.peakPriceUsd, pos.lastPriceUsd, pos.staleTicks + 1);
      }

      const ctx: ExitContext = {
        entryPriceUsd: pos.entryPriceUsd,
        peakPriceUsd: Math.max(pos.peakPriceUsd, snap?.priceUsd ?? 0),
        entryLiquidityUsd: pos.entryLiquidityUsd,
        entryTs: pos.entryTs,
        tookProfit: pos.tookProfit,
        staleTicks: pos.staleTicks,
      };
      const decision = evaluateExit(ctx, snap, this.cfg.exit, nowTs);
      if (decision.action === 'hold') continue;

      // Venda sem snapshot (token sumiu do indexador). No live o valor de
      // verdade sai da quote do Jupiter. No PAPER, o fill simulado vale ZERO:
      // token que some do indexador costuma ser pool drenado, e creditar o
      // último preço visto transformaria um rug de -100% em -1,5% — inflando a
      // estatística paper exatamente nos piores trades e cegando o circuit
      // breaker diário, que é a base da decisão de ir para live.
      const sellSnap =
        snap ??
        (this.broker.mode === 'paper'
          ? { ...this.syntheticSnap(pos), priceUsd: 0 }
          : this.syntheticSnap(pos));
      await this.sellPosition(
        pos,
        decision.portionPct,
        sellSnap,
        solUsd,
        decision.reason,
        nowTs,
        decision.urgent,
      );
    }
  }

  private syntheticSnap(pos: Position): PairSnapshot {
    return {
      mint: pos.mint,
      symbol: pos.symbol,
      name: pos.symbol,
      pairAddress: '',
      dexId: '?',
      quoteSymbol: '?',
      priceUsd: pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.entryPriceUsd,
      priceNative: null,
      liquidityUsd: null,
      fdvUsd: null,
      marketCapUsd: null,
      vol5mUsd: 0,
      vol1hUsd: 0,
      vol24hUsd: 0,
      buys5m: 0,
      sells5m: 0,
      buys1h: 0,
      sells1h: 0,
      change5mPct: 0,
      change1hPct: 0,
      change6hPct: 0,
      change24hPct: 0,
      ageMin: null,
      url: null,
    };
  }

  async sellPosition(
    pos: Position,
    portionPct: number,
    snap: PairSnapshot,
    solUsd: number,
    reason: string,
    nowTs: number,
    urgent = false,
  ): Promise<void> {
    // Relê a posição: outro processo (um `sell` manual com o `run` ligado) pode
    // ter vendido/fechado entre a leitura do tick e agora. Vender de novo com o
    // objeto obsoleto creditaria o caixa paper em dobro e dobraria a estatística.
    const fresh = getPosition(this.db, pos.id);
    if (!fresh || fresh.status !== 'open') {
      this.log.debug({ mint: pos.mint }, 'Posição já não está aberta — venda ignorada');
      return;
    }

    try {
      const fill = await this.broker.sell(
        fresh.mint,
        fresh.tokensQty,
        portionPct,
        snap,
        solUsd,
        urgent,
      );
      recordOrder(this.db, {
        positionId: fresh.id,
        ts: nowTs,
        mode: this.broker.mode,
        side: 'sell',
        mint: fresh.mint,
        solAmount: fill.solReceived,
        tokenAmount: fill.tokensSold,
        priceUsd: fill.priceUsd,
        txSig: fill.txSig,
        ok: true,
      });
      this.settleSell(fresh, fill, reason, nowTs);
    } catch (err) {
      await this.handleSellFailure(fresh, portionPct, snap, solUsd, reason, nowTs, err as Error);
    }
  }

  /** Contabiliza um fill de venda: fecha/parcial, estatística diária, cooldown. */
  private settleSell(fresh: Position, fill: SellFill, reason: string, nowTs: number): void {
    const { position, closed, applied } = applySellFill(this.db, fresh, fill, reason, nowTs);
    if (!applied) {
      this.log.warn(
        { mint: fresh.mint, reason },
        'Fill não contabilizado: a posição foi fechada por outro processo no meio da venda',
      );
      return;
    }
    if (closed) {
      bumpDailyStats(this.db, nowTs, position.pnlSol ?? 0, position.pnlUsd ?? 0);
      // Re-arma o cooldown NA SAÍDA: o da entrada expira durante o hold, e sem
      // isso uma saída por tempo máximo/trailing recompra o token no mesmo tick.
      setTokenCooldown(
        this.db,
        fresh.mint,
        fresh.symbol,
        nowTs + this.cfg.loop.tokenCooldownMin * 60,
        nowTs,
      );
      this.log.info(
        {
          mint: fresh.mint,
          symbol: fresh.symbol,
          reason,
          pnlSol: position.pnlSol?.toFixed(4),
          pnlPct: position.pnlPct?.toFixed(1),
        },
        'Posição fechada',
      );
    } else {
      // Só a venda parcial do TAKE PROFIT desarma o take profit futuro — uma
      // venda manual parcial não pode roubar o TP da posição que continua.
      if (reason.startsWith('take profit')) markTookProfit(this.db, fresh.id);
      this.log.info(
        { mint: fresh.mint, symbol: fresh.symbol, reason },
        'Venda parcial executada',
      );
    }
  }

  /**
   * Falha de venda não é tudo igual — dois casos exigem RECONCILIAÇÃO em vez
   * de retry cego:
   *   - NoBalanceError numa venda total: a carteira já está vazia (crash após
   *     a venda confirmar, ou tokens movidos por fora). Re-tentar para sempre
   *     mantém uma posição-zumbi ocupando slot e escondendo a perda do circuit
   *     breaker. Fecha com fill zero e contabiliza.
   *   - UnknownTxOutcomeError: a tx PODE ter executado. O saldo real decide:
   *     carteira vazia = a venda aterrissou (contabiliza pelo preço de tela);
   *     carteira com token = não aterrissou, o próximo tick tenta de novo.
   */
  private async handleSellFailure(
    fresh: Position,
    portionPct: number,
    snap: PairSnapshot,
    solUsd: number,
    reason: string,
    nowTs: number,
    err: Error,
  ): Promise<void> {
    recordOrder(this.db, {
      positionId: fresh.id,
      ts: nowTs,
      mode: this.broker.mode,
      side: 'sell',
      mint: fresh.mint,
      solAmount: 0,
      tokenAmount: 0,
      priceUsd: snap.priceUsd,
      txSig: err instanceof UnknownTxOutcomeError ? err.signature : null,
      ok: false,
      error: err.message,
    });

    if (err instanceof NoBalanceError && portionPct >= 100) {
      this.log.warn(
        { mint: fresh.mint, symbol: fresh.symbol },
        'Carteira sem saldo do token numa venda total — fechando a posição como perda (reconciliação)',
      );
      this.settleSell(
        fresh,
        { tokensSold: fresh.tokensQty, solReceived: 0, usdReceived: 0, priceUsd: 0, txSig: null, soldAll: true },
        `${reason} (reconciliado: carteira sem saldo)`,
        nowTs,
      );
      return;
    }

    if (err instanceof UnknownTxOutcomeError) {
      const balance = await this.chain.tokenBalanceUi(fresh.mint).catch(() => null);
      if (balance !== null && balance <= fresh.tokensBought * 1e-6) {
        this.log.warn(
          { mint: fresh.mint, txSig: err.signature },
          'Venda com destino desconhecido, mas a carteira zerou — contabilizando pelo preço de tela',
        );
        const tokensSold = fresh.tokensQty;
        const usdReceived = tokensSold * snap.priceUsd;
        this.settleSell(
          fresh,
          {
            tokensSold,
            solReceived: solUsd > 0 ? usdReceived / solUsd : 0,
            usdReceived,
            priceUsd: snap.priceUsd,
            txSig: err.signature,
            soldAll: true,
          },
          `${reason} (reconciliado pós-timeout)`,
          nowTs,
        );
        return;
      }
    }

    this.log.error(
      { mint: fresh.mint, symbol: fresh.symbol, err: err.message },
      'Venda FALHOU — vou tentar de novo no próximo tick',
    );
  }

  // ───────────────────────────────────────────────────────────
  //  Descoberta e entrada
  // ───────────────────────────────────────────────────────────

  private async scanForEntries(solUsd: number, nowTs: number): Promise<void> {
    const balance = await this.broker.balanceSol();
    const daily = getDailyStats(this.db, nowTs);
    const open = listOpenPositions(this.db, this.broker.mode);

    const blocked = blockReason(
      {
        balanceSol: balance,
        openPositions: open.length,
        dailyRealizedPnlSol: daily.realizedPnlSol,
        riskScore: 0,
      },
      this.cfg.sizing,
    );
    if (blocked) {
      this.log.debug({ blocked }, 'Sem capacidade para novas entradas');
      return;
    }

    const candidates = await this.discover(open, nowTs);
    if (candidates.length === 0) return;

    const snaps = await this.sources.pairs(candidates.map((c) => c.mint));
    const scored: { cand: Candidate; snap: PairSnapshot; entry: EntryResult }[] = [];
    for (const cand of candidates) {
      const snap = snaps.get(cand.mint);
      if (!snap) continue;
      const entry = evaluateEntry(snap, cand.sources, this.cfg.entry);
      if (!entry.eligible) {
        this.log.debug({ mint: cand.mint, symbol: snap.symbol, gate: entry.rejection }, 'Gate reprovou');
        continue;
      }
      if (entry.score < this.cfg.entry.minScore) continue;
      scored.push({ cand, snap, entry });
    }
    scored.sort((a, b) => b.entry.score - a.entry.score);

    for (const { cand, snap, entry } of scored.slice(0, this.cfg.loop.candidatesPerTick)) {
      await this.tryEnter(cand, snap, entry, solUsd, daily.realizedPnlSol, nowTs);
    }
  }

  private async discover(open: Position[], nowTs: number): Promise<Candidate[]> {
    const d = this.cfg.discovery;
    const tasks: Promise<Candidate[]>[] = [];
    if (d.geckoTrending) tasks.push(this.sources.trending());
    if (d.geckoNew) tasks.push(this.sources.newPools());
    if (d.dexscreenerBoosts) tasks.push(this.sources.boosts());

    const settled = await Promise.allSettled(tasks);
    const merged = new Map<string, Candidate>();
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.log.warn({ err: (result.reason as Error).message }, 'Fonte de descoberta falhou');
        continue;
      }
      for (const cand of result.value) {
        const existing = merged.get(cand.mint);
        if (existing) {
          for (const s of cand.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
        } else {
          merged.set(cand.mint, { ...cand, sources: [...cand.sources] });
        }
      }
    }

    const exclude = new Set(d.excludeMints);
    const openMints = new Set(open.map((p) => p.mint));
    const out: Candidate[] = [];
    for (const cand of merged.values()) {
      if (exclude.has(cand.mint) || openMints.has(cand.mint)) continue;
      if (isOnCooldown(this.db, cand.mint, nowTs)) continue;
      out.push(cand);
      if (out.length >= d.maxCandidatesPerTick) break;
    }
    return out;
  }

  /** Análise completa de segurança de um token. Também usada pelo `check` do CLI. */
  async analyzeToken(mint: string): Promise<TokenAnalysis> {
    const onchain = await this.chain.getOnchainTokenInfo(mint).catch((err: Error) => {
      this.log.warn({ mint, err: err.message }, 'Leitura on-chain falhou');
      return null;
    });
    const holders = onchain
      ? await this.chain.getTopHolders(mint, onchain).catch(() => null)
      : null;
    const rugcheck = await this.sources.rugcheck(mint);
    const report = assessRisk({ onchain, holders, rugcheck }, this.cfg.risk);
    return { onchain, holders, rugcheck, report };
  }

  private async tryEnter(
    cand: Candidate,
    snap: PairSnapshot,
    entry: EntryResult,
    solUsd: number,
    dailyPnlSol: number,
    nowTs: number,
  ): Promise<void> {
    const analysis = await this.analyzeToken(cand.mint);
    const { report } = analysis;

    upsertTokenLog(
      this.db,
      cand.mint,
      snap.symbol,
      report.score,
      report.verdict,
      JSON.stringify(report.flags),
      nowTs + this.cfg.loop.tokenCooldownMin * 60,
      nowTs,
    );

    if (report.verdict !== 'approved') {
      this.log.info(
        {
          mint: cand.mint,
          symbol: snap.symbol,
          verdict: report.verdict,
          riskScore: report.score,
          flags: report.flags.map((f) => f.id),
        },
        'Risco reprovou o token',
      );
      return;
    }

    // Capacidade reavaliada AQUI: compras anteriores deste mesmo tick já podem
    // ter consumido saldo ou o teto de posições.
    const balanceNow = await this.broker.balanceSol();
    const openNow = listOpenPositions(this.db, this.broker.mode).length;
    const size = positionSizeSol(
      {
        balanceSol: balanceNow,
        openPositions: openNow,
        dailyRealizedPnlSol: dailyPnlSol,
        riskScore: report.score,
      },
      this.cfg.sizing,
    );
    if (size === null) {
      this.log.debug({ mint: cand.mint }, 'Sem tamanho de posição viável');
      return;
    }

    try {
      const fill = await this.broker.buy(cand.mint, size, snap, solUsd);
      this.settleBuy(cand.mint, snap, entry.score, report.score, entry.reasons.join(', '), fill, nowTs);
    } catch (err) {
      recordOrder(this.db, {
        positionId: null,
        ts: nowTs,
        mode: this.broker.mode,
        side: 'buy',
        mint: cand.mint,
        solAmount: size,
        tokenAmount: 0,
        priceUsd: snap.priceUsd,
        txSig: err instanceof UnknownTxOutcomeError ? err.signature : null,
        ok: false,
        error: (err as Error).message,
      });
      // Compra com destino desconhecido: a tx PODE ter executado. Se os tokens
      // chegaram na carteira, adotá-los como posição é obrigatório — sem isso
      // eles ficam órfãos, fora do stop loss e de toda gestão de saída.
      if (err instanceof UnknownTxOutcomeError) {
        const balance = await this.chain.tokenBalanceUi(cand.mint).catch(() => 0);
        if (balance > 0) {
          this.log.warn(
            { mint: cand.mint, txSig: err.signature, tokensQty: balance },
            'Compra com destino desconhecido ATERRISSOU — adotando os tokens como posição',
          );
          this.settleBuy(
            cand.mint,
            snap,
            entry.score,
            report.score,
            `${entry.reasons.join(', ')} (adotada pós-timeout)`,
            {
              tokensQty: balance,
              solSpent: size,
              usdSpent: size * solUsd,
              priceUsd: balance > 0 ? (size * solUsd) / balance : snap.priceUsd,
              txSig: err.signature,
            },
            nowTs,
          );
          return;
        }
      }
      this.log.error({ mint: cand.mint, err: (err as Error).message }, 'Compra falhou');
    }
  }

  /** Grava posição + ordem de uma compra que (comprovadamente) aconteceu. */
  private settleBuy(
    mint: string,
    snap: PairSnapshot,
    entryScore: number,
    riskScore: number,
    entryReasons: string,
    fill: BuyFill,
    nowTs: number,
  ): void {
    const position = insertPosition(this.db, {
      mode: this.broker.mode,
      chain: this.chain.key,
      mint,
      symbol: snap.symbol,
      entryTs: nowTs,
      entryLiquidityUsd: snap.liquidityUsd ?? 0,
      entryScore,
      entryRiskScore: riskScore,
      entryReasons,
      fill,
    });
    recordOrder(this.db, {
      positionId: position.id,
      ts: nowTs,
      mode: this.broker.mode,
      side: 'buy',
      mint,
      solAmount: fill.solSpent,
      tokenAmount: fill.tokensQty,
      priceUsd: fill.priceUsd,
      txSig: fill.txSig,
      ok: true,
    });
    this.log.info(
      {
        mint,
        symbol: snap.symbol,
        solSpent: fill.solSpent.toFixed(4),
        entryScore,
        riskScore,
      },
      'ENTRADA executada',
    );
  }

  // ───────────────────────────────────────────────────────────
  //  Operações manuais (CLI)
  // ───────────────────────────────────────────────────────────

  async manualBuy(mint: string, solAmount: number, force: boolean): Promise<void> {
    const nowTs = Math.floor(Date.now() / 1000);
    const solUsd = await this.solPriceUsd();
    if (solUsd === null) throw new Error('Sem preço do SOL — tente de novo em instantes');

    if (getOpenPositionByMint(this.db, this.broker.mode, mint)) {
      throw new Error('Já existe posição aberta neste token');
    }
    const snap = (await this.sources.pairs([mint])).get(mint);
    if (!snap) throw new Error('Token sem par negociável no indexador');

    const analysis = await this.analyzeToken(mint);
    if (analysis.report.verdict !== 'approved' && !force) {
      const flags = analysis.report.flags.map((f) => `  - [${f.severity}] ${f.label}`).join('\n');
      throw new Error(
        `Risco reprovou (${analysis.report.verdict}, score ${analysis.report.score}):\n${flags}\nUse --force para comprar mesmo assim.`,
      );
    }

    const fill = await this.broker.buy(mint, solAmount, snap, solUsd);
    this.settleBuy(
      mint,
      snap,
      0,
      analysis.report.score,
      force ? 'manual (--force)' : 'manual',
      fill,
      nowTs,
    );
  }

  async manualSell(mint: string, portionPct: number): Promise<void> {
    const nowTs = Math.floor(Date.now() / 1000);
    const solUsd = await this.solPriceUsd();
    if (solUsd === null) throw new Error('Sem preço do SOL — tente de novo em instantes');

    const pos = getOpenPositionByMint(this.db, this.broker.mode, mint);
    if (!pos) throw new Error(`Nenhuma posição aberta em ${mint} no modo ${this.broker.mode}`);

    const snap = (await this.sources.pairs([mint])).get(mint) ?? this.syntheticSnap(pos);
    await this.sellPosition(pos, portionPct, snap, solUsd, 'manual', nowTs);
  }

  async manualSellAll(): Promise<void> {
    const open = listOpenPositions(this.db, this.broker.mode);
    for (const pos of open) {
      await this.manualSell(pos.mint, 100);
    }
  }
}

async function interruptibleSleep(ms: number, isStopped: () => boolean): Promise<void> {
  const step = 500;
  for (let waited = 0; waited < ms; waited += step) {
    if (isStopped()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}
