/**
 * Execução direta via PumpPortal trade-local — o FALLBACK quando o Jupiter
 * responde NO_ROUTES_FOUND.
 *
 * Visto em produção: um token recém-graduado (par pumpswap com ~1min de vida)
 * ainda não está no índice de rotas do Jupiter — exatamente a janela em que o
 * scalp quer entrar. O trade-local monta a transação direto contra o programa
 * do pump.fun (curve), pumpswap ou raydium ('auto'), devolve os bytes, e NÓS
 * assinamos localmente e enviamos pelo NOSSO RPC — a chave nunca sai daqui.
 *
 * Custo: 0,5% por trade (taxa do PumpPortal). Por isso é fallback, não padrão:
 * o Jupiter continua primário quando tem rota.
 */

const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';

export interface TradeLocalParams {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  /** SOL (compra com denominatedInSol) ou quantidade de tokens em unidades de UI (venda). */
  amount: number;
  denominatedInSol: boolean;
  /** Slippage em PORCENTAGEM (3 = 3%). */
  slippagePct: number;
  /** Priority fee em SOL. */
  priorityFeeSol: number;
}

/** Corpo da requisição no formato da API (booleans como string, como na doc). Puro, testável. */
export function buildTradeLocalBody(p: TradeLocalParams): Record<string, unknown> {
  return {
    publicKey: p.publicKey,
    action: p.action,
    mint: p.mint,
    denominatedInSol: p.denominatedInSol ? 'true' : 'false',
    amount: p.amount,
    slippage: p.slippagePct,
    priorityFee: p.priorityFeeSol,
    pool: 'auto',
  };
}

/** true = o erro do Jupiter é "sem rota" — o caso que o fallback existe para cobrir. */
export function isNoRouteError(err: unknown): boolean {
  return err instanceof Error && /NO_ROUTES_FOUND|COULD_NOT_FIND_ANY_ROUTE/i.test(err.message);
}

/** Busca a transação serializada pronta para assinar. */
export async function fetchTradeLocalTx(p: TradeLocalParams, timeoutMs = 15_000): Promise<Uint8Array> {
  const res = await fetch(TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildTradeLocalBody(p)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PumpPortal trade-local HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('PumpPortal trade-local devolveu transação vazia');
  return bytes;
}
