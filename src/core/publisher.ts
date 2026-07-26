import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import type { Logger } from './logger.js';

export interface AlertPayload {
  /** HTML já escapado (parse_mode: HTML). */
  text: string;
  /** Botões inline: cada sub-array é uma linha. */
  buttons?: Array<Array<{ label: string; url: string }>>;
  /** Chave de deduplicação — a mesma chave não é publicada duas vezes. */
  dedupeKey?: string;
}

export interface PublisherOptions {
  token?: string;
  channel?: string;
  premiumChannel?: string;
  /** Atraso do canal gratuito, em segundos. É o produto do tier pago. */
  freeTierDelaySec: number;
  dryRun: boolean;
  log: Logger;
  /** Intervalo mínimo entre mensagens no mesmo canal (limite do Telegram). */
  minIntervalMs?: number;
}

interface QueueItem {
  chatId: string;
  payload: AlertPayload;
  tier: 'free' | 'premium';
}

/**
 * Publica alertas no Telegram.
 *
 * Duas coisas não óbvias:
 *  1. `dryRun` é o padrão do .env.example. Nos primeiros dias você quer ver os
 *     alertas no log e calibrar os thresholds antes de queimar a audiência do canal.
 *  2. O canal premium recebe na hora e o gratuito com atraso. Esse atraso É o
 *     produto — em alerta de launch, 60s é a diferença entre entrar cedo e ser exit
 *     liquidity. Veja docs/MONETIZACAO.md.
 */
export class Publisher {
  private readonly bot: Bot | null;
  private readonly queue: QueueItem[] = [];
  private readonly lastSentAt = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private draining = false;
  private closed = false;

  constructor(private readonly opts: PublisherOptions) {
    this.bot = opts.token && !opts.dryRun ? new Bot(opts.token) : null;
    if (opts.dryRun) {
      opts.log.warn('DRY_RUN ativo — os alertas vão só para o log, nada é publicado no Telegram');
    } else if (!opts.token) {
      opts.log.warn('sem token de bot no .env — os alertas vão só para o log');
    }
    if (!opts.channel && !opts.premiumChannel) {
      opts.log.warn('nenhum canal configurado — os alertas vão só para o log');
    }
  }

  /** Enfileira um alerta: premium na hora, gratuito depois do atraso configurado. */
  publish(payload: AlertPayload): void {
    if (this.closed) return;

    if (payload.dedupeKey) {
      if (this.seen.has(payload.dedupeKey)) {
        this.opts.log.debug({ key: payload.dedupeKey }, 'alerta duplicado ignorado');
        return;
      }
      this.seen.add(payload.dedupeKey);
      // Limite de memória: o histórico durável de dedupe fica no SQLite.
      if (this.seen.size > 20_000) {
        for (const key of [...this.seen].slice(0, 10_000)) this.seen.delete(key);
      }
    }

    this.opts.log.info({ alerta: payload.text.replace(/<[^>]+>/g, '') }, 'ALERTA');

    const { channel, premiumChannel, freeTierDelaySec } = this.opts;

    if (premiumChannel) {
      this.enqueue({ chatId: premiumChannel, payload, tier: 'premium' });
    }

    if (channel) {
      const delayMs = premiumChannel ? Math.max(0, freeTierDelaySec) * 1000 : 0;
      if (delayMs === 0) {
        this.enqueue({ chatId: channel, payload, tier: 'free' });
      } else {
        const timer = setTimeout(() => {
          this.pendingTimers.delete(timer);
          if (!this.closed) this.enqueue({ chatId: channel, payload, tier: 'free' });
        }, delayMs);
        // unref: um alerta pendente não deve segurar o processo no shutdown
        timer.unref?.();
        this.pendingTimers.add(timer);
      }
    }
  }

  private enqueue(item: QueueItem): void {
    this.queue.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.throttle(item.chatId);
        await this.send(item);
      }
    } finally {
      this.draining = false;
    }
  }

  private async throttle(chatId: string): Promise<void> {
    // Telegram permite ~20 mensagens/minuto por canal; 3s de intervalo fica folgado.
    const minInterval = this.opts.minIntervalMs ?? 3_000;
    const last = this.lastSentAt.get(chatId) ?? 0;
    const wait = last + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSentAt.set(chatId, Date.now());
  }

  private async send(item: QueueItem, attempt = 1): Promise<void> {
    if (!this.bot) return;

    const keyboard = new InlineKeyboard();
    for (const row of item.payload.buttons ?? []) {
      for (const button of row) keyboard.url(button.label, button.url);
      keyboard.row();
    }

    try {
      await this.bot.api.sendMessage(item.chatId, item.payload.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(item.payload.buttons?.length ? { reply_markup: keyboard } : {}),
      });
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = (err.parameters?.retry_after ?? 5) + 1;
        this.opts.log.warn({ retryAfter, chatId: item.chatId }, 'rate limit do Telegram');
        await sleep(retryAfter * 1000);
        if (attempt < 3) return this.send(item, attempt + 1);
      }
      // Erro de config (canal errado, bot sem permissão) não adianta retentar:
      // registra alto e segue, para não travar a fila inteira.
      this.opts.log.error(
        { err: String(err), chatId: item.chatId, tier: item.tier },
        'falha ao publicar alerta',
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    // Deixa a fila esvaziar para não perder um alerta já disparado.
    const deadline = Date.now() + 10_000;
    while (this.queue.length > 0 && Date.now() < deadline) await sleep(200);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
