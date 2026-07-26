/**
 * Limitador de concorrência + taxa, com retry/backoff.
 *
 * Existe porque o RPC público da Arc responde `-32011 request limit reached`
 * sob carga (confirmado na prática). Sem isso o scanner perde blocos justamente
 * no momento de pico — que é exatamente quando o alerta vale dinheiro.
 */

export interface LimiterOptions {
  /** Requisições simultâneas. */
  concurrency: number;
  /** Teto de requisições por segundo (token bucket). */
  ratePerSec: number;
  /** Tentativas totais por chamada (1 = sem retry). */
  maxAttempts: number;
  /** Backoff inicial em ms; dobra a cada tentativa. */
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULTS: LimiterOptions = {
  concurrency: 4,
  ratePerSec: 12,
  maxAttempts: 5,
  baseDelayMs: 300,
  maxDelayMs: 8_000,
};

const RATE_LIMIT_PATTERNS = [
  'request limit',
  'rate limit',
  'too many requests',
  '429',
  '-32011',
  '-32005',
  'exceeded',
  'capacity',
];

const TRANSIENT_PATTERNS = [
  'timeout',
  'timed out',
  'socket hang up',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'fetch failed',
  'network',
  'service unavailable',
  '502',
  '503',
  '504',
];

export function isRateLimitError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => msg.includes(p));
}

export function isRetryableError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Limiter {
  private readonly opts: LimiterOptions;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private tokens: number;
  private lastRefill = Date.now();

  constructor(options: Partial<LimiterOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.tokens = this.opts.ratePerSec;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.opts.ratePerSec, this.tokens + elapsed * this.opts.ratePerSec);
    this.lastRefill = now;
  }

  private async acquireToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await sleep(Math.ceil((deficit / this.opts.ratePerSec) * 1000) + 5);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Executa `fn` respeitando concorrência, taxa e política de retry. */
  async run<T>(fn: () => Promise<T>, label = 'rpc'): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt += 1) {
      await this.acquireSlot();
      try {
        await this.acquireToken();
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt === this.opts.maxAttempts) {
          throw err;
        }
        const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempt - 1));
        // jitter evita que várias chamadas voltem em sincronia e estourem o limite de novo
        await sleep(delay + Math.floor(Math.random() * 250));
      } finally {
        this.releaseSlot();
      }
    }
    throw new Error(`${label} falhou após ${this.opts.maxAttempts} tentativas: ${String(lastError)}`);
  }
}
