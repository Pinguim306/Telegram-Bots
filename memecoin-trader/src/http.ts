/**
 * fetch com timeout, retry e backoff — a única porta de saída HTTP do bot.
 *
 * Todas as fontes externas (DexScreener, GeckoTerminal, RugCheck, Jupiter)
 * rate-limitam e caem de vez em quando. Concentrar o tratamento aqui evita
 * quatro implementações divergentes de retry espalhadas pelos datasources.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} em ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

export interface FetchJsonOpts {
  timeoutMs?: number;
  /** Tentativas ADICIONAIS após a primeira. Só para erro de rede, 429 e 5xx. */
  retries?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, headers = {}, method = 'GET', body } = opts;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Backoff exponencial com jitter: 500ms, 1s, 2s (+ até 250ms de ruído).
      await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
    }
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, text);
        // 4xx (menos 429) é erro de requisição — repetir não muda nada.
        if (res.status !== 429 && res.status < 500) throw err;
        lastError = err;
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error(`Falha ao buscar ${url}`);
}
