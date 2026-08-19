import { fetchJson } from '../../http.js';

/**
 * Cliente REST do Jupiter (agregador de swap da Solana).
 *
 * Sem SDK de propósito: são duas rotas HTTP (quote e swap) e o SDK oficial
 * arrasta dependências que mudam mais rápido que a API. A URL base é
 * configurável porque o Jupiter já migrou de host uma vez (quote-api.jup.ag →
 * lite-api.jup.ag); quando migrar de novo, é uma linha no .env.
 */

export interface JupiterQuote {
  inAmount: bigint;
  outAmount: bigint;
  /** Impacto de preço estimado da ordem, em % (0.5 = meio por cento). */
  priceImpactPct: number | null;
  /** Resposta crua — o POST /swap exige ela de volta intacta. */
  raw: Record<string, unknown>;
}

export class JupiterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { 'x-api-key': this.apiKey } : {};
  }

  async quote(
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<JupiterQuote> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw.toString(),
      slippageBps: String(slippageBps),
      // Sem tokens intermediários exóticos na rota: menos contas, menos jeitos de falhar.
      restrictIntermediateTokens: 'true',
    });
    const json = await fetchJson<Record<string, unknown>>(`${this.baseUrl}/quote?${params}`, {
      timeoutMs: this.timeoutMs,
      headers: this.headers(),
    });

    const inAmount = toBigInt(json.inAmount);
    const outAmount = toBigInt(json.outAmount);
    if (inAmount === null || outAmount === null || outAmount <= 0n) {
      throw new Error(`Quote do Jupiter sem rota utilizável para ${outputMint}`);
    }
    const impact = Number(json.priceImpactPct);
    return {
      inAmount,
      outAmount,
      priceImpactPct: Number.isFinite(impact) ? impact * 100 : null,
      raw: json,
    };
  }

  /** Monta a transação de swap assinável. Retorna o base64 e o teto de validade. */
  async swapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    maxPriorityFeeLamports: number,
  ): Promise<{ txBase64: string; lastValidBlockHeight: number | null }> {
    const json = await fetchJson<Record<string, unknown>>(`${this.baseUrl}/swap`, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      headers: this.headers(),
      body: {
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: maxPriorityFeeLamports,
            priorityLevel: 'high',
          },
        },
      },
    });

    const txBase64 = json.swapTransaction;
    if (typeof txBase64 !== 'string' || txBase64 === '') {
      throw new Error('Resposta do /swap do Jupiter sem swapTransaction');
    }
    const lvbh = Number(json.lastValidBlockHeight);
    return { txBase64, lastValidBlockHeight: Number.isFinite(lvbh) ? lvbh : null };
  }
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}
