import { PublicKey, type Connection } from '@solana/web3.js';

/**
 * Ligação entre as carteiras que holdam um token — o detector de BUNDLE.
 *
 * Concentração sozinha não pega o caso real: dez carteiras "diferentes" com
 * 8% cada parecem distribuição saudável, mas se todas compraram no MESMO
 * bloco ou foram fundadas pela MESMA carteira-mãe, é um sniper só, fatiado.
 * Era exatamente o perfil dos tokens que mais custaram nos trades analisados.
 *
 * Dois sinais, ambos bounded em custo de RPC:
 *
 *  1. MESMO BLOCO: a conta de token de um holder nasce na primeira compra —
 *     o slot da transação mais ANTIGA dela diz quando o holder entrou.
 *     Várias contas do topo nascendo no mesmo slot (±tolerância) = bundle.
 *  2. FINANCIADOR COMUM: a primeira transação de uma carteira recém-criada é
 *     paga por quem a fundou (ela não tinha SOL para a taxa). Fee payer da
 *     transação mais antiga = carteira-mãe. Vários holders com a mesma mãe
 *     = cluster.
 *
 * Fail-open por desenho: qualquer falha vira null e o risco pontua "dado
 * indisponível" de leve — a análise nunca derruba o tick.
 */

export interface LinkageReport {
  /** Quantas carteiras do topo foram efetivamente checadas. */
  checkedWallets: number;
  /** Maior nº de carteiras cuja PRIMEIRA compra caiu no mesmo slot (±tolerância). */
  sameSlotCluster: number;
  /** Maior nº de carteiras fundadas pela mesma carteira-mãe. */
  sharedFunderCluster: number;
  /** Carteiras com histórico curto (recém-criadas) entre as checadas. */
  freshWallets: number;
}

/** Maior aglomerado de valores dentro de `tolerance` — exportada para teste. */
export function maxCluster(values: number[], tolerance: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let best = 1;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end]! - sorted[start]! > tolerance) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** Maior contagem de um mesmo valor não-nulo — exportada para teste. */
export function maxSharedCount(values: (string | null)[]): number {
  const tally = new Map<string, number>();
  let best = 0;
  for (const v of values) {
    if (v === null) continue;
    const n = (tally.get(v) ?? 0) + 1;
    tally.set(v, n);
    best = Math.max(best, n);
  }
  return best;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Histórico curto o suficiente para "primeira transação" ser confiável.
 * Sniper de bundle usa carteira descartável — poucas transações por definição.
 * Carteira antiga (histórico >= limite) fica fora dos dois sinais: não dá para
 * saber a origem sem paginar o histórico inteiro, e ela não é o perfil-alvo.
 */
const HISTORY_LIMIT = 25;

export interface LinkageOptions {
  /** Quantas contas do topo checar (teto de custo de RPC). */
  topN: number;
  /** Tolerância de slots para contar como "mesmo bloco" (~0,4s por slot). */
  slotTolerance: number;
}

/**
 * Analisa a ligação entre os maiores holders de um mint.
 * `excludeAccounts` = contas estruturais (vault da curve), fora da análise.
 */
export async function analyzeHolderLinkage(
  conn: Connection,
  mint: string,
  excludeAccounts: string[],
  opts: LinkageOptions,
): Promise<LinkageReport | null> {
  try {
    const largest = await conn.getTokenLargestAccounts(new PublicKey(mint));
    const exclude = new Set(excludeAccounts);
    const tokenAccounts = largest.value
      .filter((a) => !exclude.has(a.address.toBase58()) && a.uiAmount !== null && a.uiAmount > 0)
      .slice(0, opts.topN)
      .map((a) => a.address);
    if (tokenAccounts.length < 3) return null; // pouco a ligar

    // Donos das contas de token (1 chamada para todas).
    const parsed = await conn.getMultipleParsedAccounts(tokenAccounts);
    const owners = parsed.value.map((acc) => {
      const info = (acc?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info;
      return typeof info?.owner === 'string' ? info.owner : null;
    });

    // Sinal 1: slot da PRIMEIRA aquisição de cada conta de token.
    const firstSlots = await mapLimit(tokenAccounts, 4, async (account) => {
      const sigs = await conn.getSignaturesForAddress(account, { limit: HISTORY_LIMIT });
      // Histórico cheio = conta antiga demais para afirmar qual foi a primeira.
      if (sigs.length === 0 || sigs.length >= HISTORY_LIMIT) return null;
      return sigs[sigs.length - 1]!.slot;
    });

    // Sinal 2: quem PAGOU a primeira transação de cada dono (carteira-mãe).
    const uniqueOwners = [...new Set(owners.filter((o): o is string => o !== null))];
    let freshWallets = 0;
    const funders = await mapLimit(uniqueOwners, 4, async (owner) => {
      const ownerPk = new PublicKey(owner);
      const sigs = await conn.getSignaturesForAddress(ownerPk, { limit: HISTORY_LIMIT });
      if (sigs.length === 0 || sigs.length >= HISTORY_LIMIT) return null; // carteira antiga
      freshWallets++;
      const oldest = sigs[sigs.length - 1]!;
      const tx = await conn.getParsedTransaction(oldest.signature, {
        maxSupportedTransactionVersion: 0,
      });
      const keys = tx?.transaction.message.accountKeys;
      if (!keys || keys.length === 0) return null;
      const feePayer = keys[0]!.pubkey.toBase58();
      // A própria carteira pagando a primeira tx = auto-fundada por fora (CEX
      // etc.) — sem mãe rastreável por este caminho.
      return feePayer !== owner ? feePayer : null;
    });

    return {
      checkedWallets: tokenAccounts.length,
      sameSlotCluster: maxCluster(
        firstSlots.filter((s): s is number => s !== null),
        opts.slotTolerance,
      ),
      sharedFunderCluster: maxSharedCount(funders),
      freshWallets,
    };
  } catch {
    return null;
  }
}
