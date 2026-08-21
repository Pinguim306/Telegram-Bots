import type { Advisor } from './advisor.js';
import { NoBalanceError } from './brokers.js';
import { UnknownTxOutcomeError } from './chains/solana/index.js';
import type { LinkageReport } from './chains/solana/linkage.js';
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
  setEntryMarkPrice,
  setTokenCooldown,
  updateTickState,
  upsertTokenLog,
  type Db,
  type Position,
} from './db.js';
import type { Logger } from './log.js';
import { assessRisk, type RiskReport } from './risk.js';
import { blockReason, positionSizeSol } from './sizing.js';
import {
  evaluateEntry,
  evaluateExit,
  isCurvePair,
  type EntryResult,
  type ExitContext,
} from './strategy.js';
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
  /** Watchlist do PumpPortal (tempo real). Vem PRIMEIRO na descoberta. */
  pumpportal(): Promise<Candidate[]>;
  trending(): Promise<Candidate[]>;
  newPools(): Promise<Candidate[]>;
  boosts(): Promise<Candidate[]>;
  /** Pools das plataformas de `discovery.gtDexes` (ex.: four-meme na BSC). */
  dexPools(): Promise<Candidate[]>;
  pairs(mints: string[]): Promise<Map<string, PairSnapshot>>;
  rugcheck(mint: string): Promise<RugcheckSummary>;
  solPriceUsd(): Promise<number | null>;
}

/**
 * Cacheia uma fonte de descoberta por `ttlMs`. Existe porque com tick curto
 * (15s) consultar o GeckoTerminal a cada tick estoura o rate limit gratuito e
 * a descoberta morre inteira em 429 — trending não muda a cada 15s mesmo.
 * Se a fonte falhar, serve o resultado anterior por até 5×TTL antes de
 * propagar o erro: candidato de 1 minuto atrás é melhor que nenhum.
 */
export function cachedSource<T>(
  fn: () => Promise<T>,
  ttlMs: number,
  now: () => number = () => Date.now(),
): () => Promise<T> {
  let last: T | null = null;
  let lastAt = 0;
  return async () => {
    if (ttlMs > 0 && last !== null && now() - lastAt < ttlMs) return last;
    try {
      const fresh = await fn();
      last = fresh;
      lastAt = now();
      return fresh;
    } catch (err) {
      if (ttlMs > 0 && last !== null && now() - lastAt < ttlMs * 5) return last;
      throw err;
    }
  };
}

export interface TokenAnalysis {
  onchain: OnchainTokenInfo | null;
  holders: HolderStats | null;
  linkage: LinkageReport | null;
  rugcheck: RugcheckSummary;
  report: RiskReport;
}

/** Corrida contra o relógio que NUNCA rejeita — timeout vira null (fail-open). */
function withTimeoutNull<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      timer.unref?.();
    }),
  ]);
}


/** Market cap "melhor esforço" de um snapshot (mcap, senão FDV, senão null). */
function snapMcap(snap: PairSnapshot | null): number | null {
  return snap?.marketCapUsd ?? snap?.fdvUsd ?? null;
}

const LAST_SOL_USD_KEY = 'last_sol_usd';

/** Foto do último tick — o que o painel web mostra sem refazer trabalho nenhum. */
export interface TickSummary {
  ts: number;
  solUsd: number;
  blocked: string | null;
  candidates: number;
  withPair: number;
  eligible: number;
  analyzed: number;
  bought: number;
  gateTally: Record<string, number>;
}

export class TraderEngine {
  private stopped = false;
  private paused = false;
  /** Última foto do funil — consumida pelo painel web. */
  lastTick: TickSummary | null = null;
  /**
   * PnL NÃO-realizado das posições abertas (marca executável), atualizado a
   * cada gestão. Alimenta o circuit breaker: uma posição afundando -0,3 SOL
   * "não existia" para a trava diária até virar venda — dia de cauda gorda
   * continuava comprando com o buraco já aberto.
   */
  private openUnrealizedSol = 0;
  /** Vendas FALHADAS consecutivas por posição — arma o watchdog de posição presa. */
  private readonly sellFailures = new Map<number, number>();

  constructor(
    private cfg: TraderConfig,
    private readonly db: Db,
    private readonly broker: Broker,
    private readonly chain: ChainAdapter,
    private readonly sources: Sources,
    private readonly log: Logger,
    private readonly advisor: Advisor | null = null,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  /**
   * PnL NÃO-realizado das posições abertas, pela marca executável. Alimenta o
   * circuit breaker e agora também o painel — era calculado a cada tick e
   * nunca exibido, então um buraco aberto ficava invisível para o operador.
   */
  get unrealizedSol(): number {
    return this.openUnrealizedSol;
  }

  /** Pausa NOVAS entradas (painel web). A gestão das posições abertas continua. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.log.info(paused ? 'PAUSADO pelo painel — sem novas compras' : 'Retomado pelo painel');
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Troca o config em execução (salvamento pelo painel). O objeto inteiro é
   * substituído — o próximo tick já lê os valores novos. O chamador é
   * responsável por também atualizar o broker (seções execution/sizing).
   */
  updateConfig(cfg: TraderConfig): void {
    this.cfg = cfg;
    this.log.info('Config recarregado em execução (via painel)');
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
    const scan = await this.scanForEntries(solUsd, nowTs);
    this.lastTick = { ts: nowTs, solUsd, ...scan };

    // Heartbeat: uma linha por tick SEMPRE, mesmo sem nenhuma ação. Sem isso,
    // minutos de gates reprovando tudo (normal no perfil de scalp) ficam
    // indistinguíveis de um bot travado.
    const abertas = listOpenPositions(this.db, this.broker.mode).length;
    if (scan.blocked) {
      this.log.info({ abertas, motivo: scan.blocked }, 'Tick: gestão ok — sem novas entradas');
    } else {
      // Os 4 gates que mais reprovaram — a resposta permanente para
      // "por que o bot não está comprando?".
      const gates = Object.fromEntries(
        Object.entries(scan.gateTally)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4),
      );
      this.log.info(
        {
          abertas,
          candidatos: scan.candidates,
          comPar: scan.withPair,
          aptosNosGates: scan.eligible,
          analisados: scan.analyzed,
          compras: scan.bought,
          ...(Object.keys(gates).length > 0 ? { gates } : {}),
        },
        'Tick concluído',
      );
    }
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
    this.openUnrealizedSol = 0;
    if (open.length === 0) return;

    // Contribuição de cada posição para o PnL não-realizado, consolidada só no
    // FIM do laço e apenas sobre o que continuar aberto. Somar direto num
    // acumulador contava DUAS vezes a posição que fechasse durante o próprio
    // laço: o não-realizado dela ficava no total e o realizado já entrava na
    // estatística diária — a trava diária disparava com metade do drawdown.
    const unrealized = new Map<number, number>();

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

      // Marca EXECUTÁVEL: o que uma venda real pagaria agora (quote no
      // agregador). Na escala de segundos de uma memecoin recém-nascida o
      // preço de indexador atrasa e mente — visto em produção: "stop loss
      // -47%" que vendeu com +10% real, "take profit +41%" que devolveu -39%.
      // Quando a marca existe, TODAS as decisões de saída usam ela; o preço
      // de tela vira só o fallback (e o modo paper, que não tem agregador,
      // segue por ele).
      const markSol = await this.broker.markValueSol(pos.mint, pos.tokensQty).catch(() => null);
      let effSnap = snap;

      // PnL não-realizado desta posição, ANTES de qualquer `continue`: o tick
      // de baseline também precisa contar, senão a posição fica um tick
      // invisível para o circuit breaker. `solReceived` (vendas PARCIAIS já
      // realizadas) entra na conta — sem ele, uma posição lucrativa que vendeu
      // metade lia como buraco (custo total contra o valor de metade) e o
      // buraco fantasma desligava as compras do dia inteiro.
      const snapPriceSol =
        snap !== null && solUsd > 0 ? (snap.priceUsd * pos.tokensQty) / solUsd : null;
      const valueSol = markSol !== null && markSol > 0 ? markSol : snapPriceSol;
      if (valueSol !== null) {
        unrealized.set(pos.id, valueSol + pos.solReceived - pos.solSpent);
      }

      if (markSol !== null && markSol > 0 && pos.tokensQty > 0 && solUsd > 0) {
        const markPriceUsd = (markSol * solUsd) / pos.tokensQty;
        effSnap = effSnap
          ? { ...effSnap, priceUsd: markPriceUsd }
          : { ...this.syntheticSnap(pos), priceUsd: markPriceUsd };

        if (pos.entryMarkPriceUsd === null) {
          // Primeira marca pós-compra: vira o BASELINE das saídas. Comparar a
          // marca com o preço de tela da entrada faria todo trade nascer
          // "dentro do stop": o custo de entrada (impacto + taxas, 5–10%)
          // apareceria como queda. O pico também RESETA para a marca — o pico
          // antigo está em unidades de preço de tela e armaria o trailing num
          // topo que a posição nunca teve em valor executável.
          setEntryMarkPrice(this.db, pos.id, markPriceUsd);
          updateTickState(this.db, pos.id, markPriceUsd, markPriceUsd, 0);
          this.log.info(
            {
              symbol: pos.symbol,
              entradaTela: pos.entryPriceUsd,
              baselineExecutavel: markPriceUsd,
              custoEntradaPct: Number(((markPriceUsd / pos.entryPriceUsd - 1) * 100).toFixed(1)),
            },
            'Baseline executável definido — saídas passam a medir contra ele',
          );
          continue;
        }
      }

      const tickPrice = effSnap?.priceUsd ?? null;

      // Mercado MORTO: volume e transações de 5m ~zero. O engine só CONTA os
      // ticks seguidos (com carência pós-compra — a janela de 5m do indexador
      // ainda contém o hype da entrada); a decisão de sair é do evaluateExit.
      // Visto em produção: compra pós-dump e o token congelou no chão — sem
      // uma transação sequer, o stop loss nunca dispararia.
      // Exige o snapshot REAL do indexador (`snap`), nunca o sintético: quando
      // o indexador falha mas a marca funciona, effSnap vira syntheticSnap com
      // vol5m/txns FABRICADOS em zero — que satisfazem esta condição
      // trivialmente e liquidariam em 45s uma posição com volume de verdade.
      // Dado que nunca foi observado não pode virar sinal de venda.
      const exitCfg = this.cfg.exit;
      const isDead =
        snap !== null &&
        (nowTs - pos.entryTs) / 60 >= exitCfg.deadMinHoldMin &&
        snap.vol5mUsd < exitCfg.deadVolume5mUsd &&
        snap.buys5m + snap.sells5m <= exitCfg.deadTxns5m;
      const deadTicks = isDead ? pos.deadTicks + 1 : 0;

      if (tickPrice !== null) {
        updateTickState(
          this.db,
          pos.id,
          Math.max(pos.peakPriceUsd, tickPrice),
          tickPrice,
          0,
          deadTicks,
        );
      } else {
        updateTickState(
          this.db,
          pos.id,
          pos.peakPriceUsd,
          pos.lastPriceUsd,
          pos.staleTicks + 1,
          pos.deadTicks,
        );
      }

      const ctx: ExitContext = {
        entryPriceUsd: pos.entryMarkPriceUsd ?? pos.entryPriceUsd,
        peakPriceUsd: Math.max(pos.peakPriceUsd, tickPrice ?? 0),
        entryLiquidityUsd: pos.entryLiquidityUsd,
        entryTs: pos.entryTs,
        tookProfit: pos.tookProfit,
        staleTicks: pos.staleTicks,
        deadTicks: tickPrice !== null ? deadTicks : pos.deadTicks,
      };
      const decision = evaluateExit(ctx, effSnap, this.cfg.exit, nowTs);
      if (decision.action === 'hold') continue;

      // Venda sem snapshot (token sumiu do indexador e sem marca). No live o
      // valor de verdade sai da quote do Jupiter. No PAPER, o fill simulado
      // vale ZERO: token que some do indexador costuma ser pool drenado, e
      // creditar o último preço visto transformaria um rug de -100% em -1,5%
      // — inflando a estatística paper exatamente nos piores trades e cegando
      // o circuit breaker diário, que é a base da decisão de ir para live.
      const sellSnap =
        effSnap ??
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

    // Consolida só o que continua ABERTO: posição fechada durante o laço já
    // virou PnL realizado na estatística diária e não pode contar de novo aqui.
    const stillOpen = new Set(listOpenPositions(this.db, this.broker.mode).map((p) => p.id));
    this.openUnrealizedSol = 0;
    for (const [id, value] of unrealized) {
      if (stillOpen.has(id)) this.openUnrealizedSol += value;
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

    // Watchdog de posição PRESA (visto em produção: venda que nunca executa e
    // a posição assiste ao token derreter): depois de 3 vendas totais falhadas
    // seguidas, escala para TRANCHES de 50% com slippage de emergência — lote
    // menor tem impacto menor e passa onde a venda cheia reverte.
    const fails = this.sellFailures.get(fresh.id) ?? 0;
    let effPortion = portionPct;
    let effUrgent = urgent;
    if (fails >= 3 && portionPct >= 100) {
      effPortion = 50;
      effUrgent = true;
      this.log.warn(
        { mint: fresh.mint, symbol: fresh.symbol, falhas: fails },
        'Posição presa — escalando para venda em tranche de 50% com slippage de emergência',
      );
    }

    try {
      const fill = await this.broker.sell(
        fresh.mint,
        fresh.tokensQty,
        effPortion,
        snap,
        solUsd,
        effUrgent,
      );
      this.sellFailures.delete(fresh.id);
      recordOrder(this.db, {
        positionId: fresh.id,
        ts: nowTs,
        mode: this.broker.mode,
        side: 'sell',
        mint: fresh.mint,
        solAmount: fill.solReceived,
        tokenAmount: fill.tokensSold,
        priceUsd: fill.priceUsd,
        mcapUsd: snapMcap(snap),
        venue: fill.venue ?? null,
        txSig: fill.txSig,
        ok: true,
      });
      this.settleSell(fresh, fill, reason, nowTs, snapMcap(snap));
    } catch (err) {
      this.sellFailures.set(fresh.id, fails + 1);
      if (fails + 1 >= 6) {
        this.log.error(
          { mint: fresh.mint, symbol: fresh.symbol, falhas: fails + 1, err: (err as Error).message },
          'POSIÇÃO PRESA: 6+ vendas falhadas seguidas — verifique o token no explorer; o bot segue tentando em tranches',
        );
      }
      // `portionPct` (a INTENÇÃO original), não `effPortion`: a reconciliação
      // de posição-zumbi exige "isto era uma saída total". Passar a tranche de
      // 50% do watchdog desligava exatamente a reconciliação que ele deveria
      // destravar — a posição ficava aberta para sempre, ocupando slot e
      // escondendo a perda do circuit breaker.
      await this.handleSellFailure(fresh, portionPct, snap, solUsd, reason, nowTs, err as Error);
    }
  }

  /** Contabiliza um fill de venda: fecha/parcial, estatística diária, cooldown. */
  private settleSell(
    fresh: Position,
    fill: SellFill,
    reason: string,
    nowTs: number,
    exitMcapUsd: number | null = null,
  ): void {
    const { position, closed, applied } = applySellFill(this.db, fresh, fill, reason, nowTs, exitMcapUsd);
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
      mcapUsd: snapMcap(snap),
      venue: null,
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
        snapMcap(snap),
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
          snapMcap(snap),
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

  private async scanForEntries(
    solUsd: number,
    nowTs: number,
  ): Promise<{
    blocked: string | null;
    candidates: number;
    withPair: number;
    eligible: number;
    analyzed: number;
    bought: number;
    gateTally: Record<string, number>;
  }> {
    const stats = {
      blocked: null as string | null,
      candidates: 0,
      withPair: 0,
      eligible: 0,
      analyzed: 0,
      bought: 0,
      gateTally: {} as Record<string, number>,
    };
    if (this.paused) {
      stats.blocked = 'pausado pelo painel';
      return stats;
    }
    const balance = await this.broker.balanceSol();
    const daily = getDailyStats(this.db, nowTs);
    const open = listOpenPositions(this.db, this.broker.mode);

    stats.blocked = blockReason(
      {
        balanceSol: balance,
        openPositions: open.length,
        dailyRealizedPnlSol: daily.realizedPnlSol,
        openUnrealizedSol: this.openUnrealizedSol,
        riskScore: 0,
      },
      this.cfg.sizing,
    );
    if (stats.blocked) return stats;

    const candidates = await this.discover(open, nowTs);
    stats.candidates = candidates.length;
    if (candidates.length === 0) return stats;

    const snaps = await this.sources.pairs(candidates.map((c) => c.mint));
    const scored: { cand: Candidate; snap: PairSnapshot; entry: EntryResult }[] = [];
    for (const cand of candidates) {
      let snap = snaps.get(cand.mint);
      if (!snap) continue;
      stats.withPair++;
      // Indexador ainda sem data de criação, mas NÓS vimos o mint nascer no
      // PumpPortal: a idade vira (agora - nascimento). É um piso da idade real
      // — conservador para o gate de idade mínima, nunca frouxo.
      if (snap.ageMin === null && cand.firstSeenTs !== undefined) {
        snap = { ...snap, ageMin: Math.max(0, (nowTs * 1000 - cand.firstSeenTs) / 60_000) };
      }
      const entry = evaluateEntry(snap, cand.sources, this.cfg.entry);
      if (!entry.eligible) {
        const id = entry.rejectionId ?? '?';
        stats.gateTally[id] = (stats.gateTally[id] ?? 0) + 1;
        this.log.debug({ mint: cand.mint, symbol: snap.symbol, gate: entry.rejection }, 'Gate reprovou');
        continue;
      }
      if (entry.score < this.cfg.entry.minScore) {
        // Passou nos gates mas não somou sinal suficiente — contar separado é o
        // que distingue "mercado frio" de "filtros errados" na calibração.
        stats.gateTally['score'] = (stats.gateTally['score'] ?? 0) + 1;
        continue;
      }
      scored.push({ cand, snap, entry });
    }
    stats.eligible = scored.length;
    scored.sort((a, b) => b.entry.score - a.entry.score);

    for (const { cand, snap, entry } of scored.slice(0, this.cfg.loop.candidatesPerTick)) {
      stats.analyzed++;
      const bought = await this.tryEnter(
        cand,
        snap,
        entry,
        solUsd,
        daily.realizedPnlSol,
        nowTs,
        stats.gateTally,
      );
      if (bought) stats.bought++;
    }
    return stats;
  }

  private async discover(open: Position[], nowTs: number): Promise<Candidate[]> {
    const d = this.cfg.discovery;
    // Ordem importa: o teto maxCandidatesPerTick corta o FIM da lista mesclada,
    // então a fonte em tempo real (PumpPortal) entra primeiro — um mint recém-
    // graduado não pode ser o cortado em favor de um trending genérico.
    const tasks: Promise<Candidate[]>[] = [];
    if (d.pumpportal.enabled) tasks.push(this.sources.pumpportal());
    // Plataformas específicas primeiro (é a população que a estratégia caça).
    if (d.gtDexes.length > 0) tasks.push(this.sources.dexPools());
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

  /**
   * Análise completa de segurança de um token. Também usada pelo `check` do CLI.
   * `curve` = token ainda na bonding curve: a leitura de top holders EXCLUI o
   * vault da curve e mede a concentração sobre o CIRCULANTE — antes ela era
   * pulada por inteiro, e token com o circulante todo na mão de snipers passava
   * sem nenhuma checagem de distribuição (visto nos trades reais).
   */
  async analyzeToken(mint: string, curve = false): Promise<TokenAnalysis> {
    const onchain = await this.chain.getOnchainTokenInfo(mint).catch((err: Error) => {
      this.log.warn({ mint, err: err.message }, 'Leitura on-chain falhou');
      return null;
    });
    // Quem sabe quais contas são estruturais é a REDE, não o engine: derivar
    // aqui um endereço de bonding curve da Solana derrubaria o tick inteiro
    // num token EVM marcado como curve (a fourmeme, na BSC).
    const structural = onchain ? (this.chain.structuralAccounts?.(mint, onchain, curve) ?? []) : [];
    const holders = onchain
      ? await this.chain.getTopHolders(mint, onchain, structural).catch(() => null)
      : null;
    // Ligação entre carteiras do topo — só na curve (é onde mora o bundle) e
    // só como ÚLTIMO custo do funil: ~20-30 chamadas de RPC. Timeout de 12s
    // vira null — a análise nunca segura o tick.
    const linkage =
      curve && this.cfg.risk.linkageEnabled && this.chain.getHolderLinkage
        ? await withTimeoutNull(
            this.chain.getHolderLinkage(mint, structural, {
              topN: this.cfg.risk.linkageTopN,
              slotTolerance: this.cfg.risk.linkageSlotTolerance,
            }),
            12_000,
          )
        : null;
    if (linkage && (linkage.sameSlotCluster > 1 || linkage.sharedFunderCluster > 1)) {
      this.log.info(
        {
          mint,
          carteirasChecadas: linkage.checkedWallets,
          mesmoBloco: linkage.sameSlotCluster,
          mesmaMae: linkage.sharedFunderCluster,
          recemCriadas: linkage.freshWallets,
        },
        'Ligação entre carteiras do topo',
      );
    }
    const rugcheck = await this.sources.rugcheck(mint);
    // Na EVM não há como listar os maiores holders pelo RPC sem indexar
    // Transfer — mas a fonte de segurança já traz a lista. Sem este fallback,
    // TODO token de curve da BSC caía em "distribuição indisponível" e a
    // checagem de concentração simplesmente não existia naquela rede.
    const distribution = holders ?? (rugcheck.available ? (rugcheck.distribution ?? null) : null);
    const report = assessRisk(
      { onchain, holders: distribution, rugcheck, curve, linkage },
      this.cfg.risk,
    );
    return { onchain, holders: distribution, linkage, rugcheck, report };
  }

  private async tryEnter(
    cand: Candidate,
    snap: PairSnapshot,
    entry: EntryResult,
    solUsd: number,
    dailyPnlSol: number,
    nowTs: number,
    tally?: Record<string, number>,
  ): Promise<boolean> {
    const curve = isCurvePair(snap.dexId, this.cfg.entry);
    const analysis = await this.analyzeToken(cand.mint, curve);
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
      // Sem esta linha a camada de risco inteira (RugCheck/GoPlus, holders,
      // bundle) era INVISÍVEL no funil do heartbeat e do painel: o operador
      // via só os gates e não sabia quantos tokens o risco matou.
      if (tally) tally['risco'] = (tally['risco'] ?? 0) + 1;
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
      return false;
    }

    // ÚLTIMO filtro: segunda opinião da IA, com o dossiê completo já coletado.
    // Veredito null = IA indisponível → fail-open, a compra segue pelos
    // critérios quantitativos (o bot nunca depende da IA para operar).
    let aiNote = '';
    if (this.advisor) {
      const rc = analysis.rugcheck;
      const verdict = await this.advisor.judge({
        snap,
        sources: cand.sources,
        entryScore: entry.score,
        entryReasons: entry.reasons,
        report,
        holderCount:
          (rc.available ? rc.holderCount : null) ?? analysis.holders?.holderCount ?? null,
        top10Pct: (rc.available ? rc.top10Pct : null) ?? analysis.holders?.top10Pct ?? null,
        lpLockedPct: rc.available ? rc.lpLockedPct : null,
        curve,
      });
      if (verdict) {
        const approved =
          verdict.decision === 'comprar' && verdict.confidence >= this.cfg.ai.minConfidence;
        this.log.info(
          {
            mint: cand.mint,
            symbol: snap.symbol,
            decisao: verdict.decision,
            confianca: verdict.confidence,
            motivo: verdict.reason,
          },
          approved ? 'IA aprovou a entrada' : 'IA reprovou a entrada',
        );
        if (!approved) {
          if (tally) tally['ia'] = (tally['ia'] ?? 0) + 1;
          return false;
        }
        aiNote = ` · IA ${verdict.confidence}%: ${verdict.reason}`;
      }
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
        openUnrealizedSol: this.openUnrealizedSol,
        riskScore: report.score,
      },
      this.cfg.sizing,
    );
    if (size === null) {
      this.log.debug({ mint: cand.mint }, 'Sem tamanho de posição viável');
      return false;
    }

    try {
      const fill = await this.broker.buy(cand.mint, size, snap, solUsd);
      this.settleBuy(
        cand.mint,
        snap,
        entry.score,
        report.score,
        entry.reasons.join(', ') + aiNote,
        fill,
        nowTs,
      );
      return true;
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
        mcapUsd: snapMcap(snap),
        venue: null,
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
            `${entry.reasons.join(', ')}${aiNote} (adotada pós-timeout)`,
            {
              tokensQty: balance,
              solSpent: size,
              usdSpent: size * solUsd,
              priceUsd: balance > 0 ? (size * solUsd) / balance : snap.priceUsd,
              txSig: err.signature,
            },
            nowTs,
          );
          return true;
        }
      }
      this.log.error({ mint: cand.mint, err: (err as Error).message }, 'Compra falhou');
    }
    return false;
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
      entryMcapUsd: snapMcap(snap),
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
      mcapUsd: snapMcap(snap),
      venue: fill.venue ?? null,
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

    const analysis = await this.analyzeToken(mint, isCurvePair(snap.dexId, this.cfg.entry));
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
