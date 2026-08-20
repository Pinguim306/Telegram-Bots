import { cleanLabel } from '../format.js';
import type { Logger } from '../log.js';
import type { Candidate } from '../types.js';

/**
 * PumpPortal — feed websocket GRATUITO e em tempo real do pump.fun
 * (wss://pumpportal.fun/api/data). Empurra cada mint novo e cada graduação
 * (migração da curve para o pumpswap) no instante em que acontecem — sem
 * polling, sem rate limit. É a fonte primária da estratégia de curve.
 *
 * Desenho: os eventos entram numa WATCHLIST com janela deslizante. O engine
 * não compra "porque nasceu" — a cada tick os mints da watchlist são
 * enriquecidos no DexScreener e passam pelos MESMOS gates e análise de risco
 * de qualquer candidato. O feed só garante que o bot conhece o token desde o
 * nascimento e o pega assim que ele cruza os critérios.
 *
 * Usa o WebSocket nativo do Node 22 (undici) — nenhuma dependência nova.
 */

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';

export interface ParsedPumpEvent {
  kind: 'new' | 'migration';
  mint: string;
  symbol: string;
}

/**
 * Parse defensivo de uma mensagem do feed. Exportada para teste.
 * Formatos observados: txType 'create' (mint novo, traz name/symbol) e
 * txType 'migrate' (graduação — símbolo pode não vir).
 */
export function parsePumpPortalMessage(raw: unknown): ParsedPumpEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.mint !== 'string' || m.mint === '') return null;

  const symbol = typeof m.symbol === 'string' ? cleanLabel(m.symbol, 12) : '?';
  if (m.txType === 'create') return { kind: 'new', mint: m.mint, symbol };
  if (m.txType === 'migrate') return { kind: 'migration', mint: m.mint, symbol };
  return null;
}

/**
 * Watchlist com janela deslizante: guarda os mints vistos nos últimos
 * `watchWindowMin` minutos, mais novos primeiro (o teto de candidatos por
 * tick corta o FIM da lista — os recém-nascidos não podem ser os cortados).
 */
export class CandidateBuffer {
  private entries = new Map<string, { candidate: Candidate; ts: number }>();

  constructor(
    private readonly watchWindowMin: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  add(event: ParsedPumpEvent): void {
    const source = event.kind === 'migration' ? 'pp-migration' : 'pp-new';
    const existing = this.entries.get(event.mint);
    if (existing) {
      if (!existing.candidate.sources.includes(source)) existing.candidate.sources.push(source);
      // Re-insere para rejuvenescer: graduação renova o interesse no mint.
      this.entries.delete(event.mint);
      this.entries.set(event.mint, { candidate: existing.candidate, ts: this.now() });
      return;
    }
    this.entries.set(event.mint, {
      candidate: { mint: event.mint, symbol: event.symbol, sources: [source] },
      ts: this.now(),
    });
    // Teto duro contra vazamento de memória num fluxo de milhares de mints/dia.
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Mints ainda dentro da janela, mais novos primeiro. */
  candidates(): Candidate[] {
    const cutoff = this.now() - this.watchWindowMin * 60_000;
    const out: Candidate[] = [];
    for (const [mint, entry] of this.entries) {
      if (entry.ts < cutoff) this.entries.delete(mint);
      else out.push(entry.candidate);
    }
    return out.reverse();
  }
}

/** O subconjunto de WebSocket que usamos — tipado à mão porque o global do
 *  Node não está nas libs do tsconfig (ES2023, sem DOM). */
interface WsLike {
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface PumpPortalConfig {
  newMints: boolean;
  migrations: boolean;
  watchWindowMin: number;
  url?: string;
}

export class PumpPortalFeed {
  private readonly buffer: CandidateBuffer;
  private ws: WsLike | null = null;
  private stopped = false;
  private backoffMs = 5_000;

  constructor(
    private readonly cfg: PumpPortalConfig,
    private readonly log: Logger,
  ) {
    this.buffer = new CandidateBuffer(cfg.watchWindowMin);
  }

  start(): void {
    const WS = (globalThis as Record<string, unknown>).WebSocket as
      | (new (url: string) => WsLike)
      | undefined;
    if (!WS) {
      this.log.warn('WebSocket global indisponível (Node < 22?) — fonte PumpPortal desligada');
      return;
    }
    this.connect(WS);
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  candidates(): Candidate[] {
    return this.buffer.candidates();
  }

  private connect(WS: new (url: string) => WsLike): void {
    if (this.stopped) return;
    const url = this.cfg.url ?? DEFAULT_URL;
    let ws: WsLike;
    try {
      ws = new WS(url);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'PumpPortal: falha ao abrir websocket');
      this.scheduleReconnect(WS);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = 5_000;
      if (this.cfg.newMints) ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      if (this.cfg.migrations) ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      this.log.info('PumpPortal conectado — mints e graduações em tempo real');
    });

    ws.addEventListener('message', (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const pumpEvent = parsePumpPortalMessage(parsed);
      if (!pumpEvent) return;
      if (pumpEvent.kind === 'new' && !this.cfg.newMints) return;
      if (pumpEvent.kind === 'migration' && !this.cfg.migrations) return;
      this.buffer.add(pumpEvent);
    });

    ws.addEventListener('close', () => {
      if (this.stopped) return;
      this.log.warn('PumpPortal desconectou — reconectando');
      this.scheduleReconnect(WS);
    });

    ws.addEventListener('error', () => {
      // O evento 'close' vem em seguida e cuida da reconexão.
    });
  }

  private scheduleReconnect(WS: new (url: string) => WsLike): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 120_000);
    setTimeout(() => this.connect(WS), delay);
  }
}
