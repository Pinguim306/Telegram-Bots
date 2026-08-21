import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LiveBroker } from '../src/brokers.js';
import { loadTraderConfig } from '../src/config.js';
import type { JupiterClient } from '../src/chains/solana/jupiter.js';
import type { SolanaChain } from '../src/chains/solana/index.js';
import type { PairSnapshot } from '../src/types.js';

/**
 * Guardas de custo/segurança da COMPRA no LiveBroker. O ponto central: uma
 * guarda que não consegue rodar não pode virar "pode comprar" em silêncio.
 */

const cfg = loadTraderConfig();
const log = pino({ level: 'silent' });

const snap = {
  mint: 'MintX',
  symbol: 'X',
  name: 'X',
  pairAddress: '',
  dexId: 'pumpfun',
  quoteSymbol: 'SOL',
  priceUsd: 0.001,
  priceNative: null,
  liquidityUsd: null,
  fdvUsd: 20_000,
  marketCapUsd: 20_000,
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
  ageMin: 10,
  url: null,
} satisfies PairSnapshot;

const fakeChain = {
  getOnchainTokenInfo: async () => ({
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    token2022: false,
    dangerousExtensions: [],
    taxingExtensions: [],
    decimals: 6,
    supplyRaw: 1_000_000_000_000n,
    supplyUi: 1_000_000,
  }),
  walletAddress: () => 'Wallet1111111111111111111111111111111111111',
} as unknown as SolanaChain;

/** Jupiter falso: a quote de COMPRA funciona; a de VENDA falha como pedido. */
function jupiterWithSellError(sellError: Error) {
  return {
    quote: async (inputMint: string) => {
      const WSOL = 'So11111111111111111111111111111111111111112';
      if (inputMint === WSOL) {
        // compra: rota existe, impacto baixo
        return { inAmount: 100_000_000n, outAmount: 1_000_000n, priceImpactPct: 1 };
      }
      throw sellError; // venda
    },
  } as unknown as JupiterClient;
}

describe('LiveBroker.buy — guardas que não podem falhar abertas', () => {
  it('SEM ROTA DE VENDA (com rota de compra) aborta: é assinatura de honeypot', async () => {
    const broker = new LiveBroker(
      fakeChain,
      jupiterWithSellError(new Error('COULD_NOT_FIND_ANY_ROUTE')),
      cfg.execution,
      log,
    );
    await expect(broker.buy('MintX', 0.1, snap, 200)).rejects.toThrow(/honeypot/i);
  });

  it('NO_ROUTES_FOUND na venda também aborta', async () => {
    const broker = new LiveBroker(
      fakeChain,
      jupiterWithSellError(new Error('NO_ROUTES_FOUND')),
      cfg.execution,
      log,
    );
    await expect(broker.buy('MintX', 0.1, snap, 200)).rejects.toThrow(/honeypot/i);
  });

  it('falha de REDE na quote de venda não é honeypot — segue, sem medir o custo', async () => {
    // Aqui a compra prossegue e morre adiante (sem carteira/RPC de verdade);
    // o que importa é NÃO ter sido barrada como honeypot.
    const broker = new LiveBroker(
      fakeChain,
      jupiterWithSellError(new Error('fetch failed: ETIMEDOUT')),
      cfg.execution,
      log,
    );
    await expect(broker.buy('MintX', 0.1, snap, 200)).rejects.not.toThrow(/honeypot/i);
  });

  it('custo round-trip acima do teto aborta com a conta explícita', async () => {
    const jupiter = {
      quote: async (inputMint: string) => {
        const WSOL = 'So11111111111111111111111111111111111111112';
        if (inputMint === WSOL) return { inAmount: 100_000_000n, outAmount: 1_000_000n, priceImpactPct: 1 };
        // Vender de volta devolve só 80% do que entrou → 20% de pedágio.
        return { inAmount: 1_000_000n, outAmount: 80_000_000n, priceImpactPct: 1 };
      },
    } as unknown as JupiterClient;
    const broker = new LiveBroker(fakeChain, jupiter, cfg.execution, log);
    await expect(broker.buy('MintX', 0.1, snap, 200)).rejects.toThrow(/round-trip/i);
  });
});
