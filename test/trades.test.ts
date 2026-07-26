import { describe, expect, it } from 'vitest';
import type { DecodedSwap } from '../src/core/events.js';
import type { PoolInfo } from '../src/core/pools.js';
import { normalizeSwap } from '../src/core/trades.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as const;
const USDC = '0x3600000000000000000000000000000000000000' as const;

/** Pool com o token como token0 e USDC como token1. */
const poolBaseIsToken0: PoolInfo = {
  address: '0x00000000000000000000000000000000000000ff',
  kind: 'v3',
  factory: null,
  token0: TOKEN,
  token1: USDC,
  fee: 3000,
  baseToken: TOKEN,
  quoteToken: USDC,
  createdBlock: null,
  createdTs: null,
};

/** Mesmo pool, ordem invertida — a ordem dos tokens é ditada pelo endereço. */
const poolBaseIsToken1: PoolInfo = {
  ...poolBaseIsToken0,
  token0: USDC,
  token1: TOKEN,
};

const quote = { address: USDC, symbol: 'USDC', decimals: 6, usdPrice: 1, isStable: true, preference: 100 };

const ctx = (pool: PoolInfo) => ({
  pool,
  quote,
  quoteUsdPrice: 1,
  baseDecimals: 18,
  ts: 1_000,
  block: 10,
  txHash: '0xabc',
  logIndex: 1,
});

const swap = (delta0: bigint, delta1: bigint): DecodedSwap => ({
  kind: 'v3',
  pool: poolBaseIsToken0.address,
  sender: '0x00000000000000000000000000000000000000bb',
  recipient: '0x00000000000000000000000000000000000000cc',
  delta0,
  delta1,
});

describe('normalizeSwap', () => {
  it('classifica como COMPRA quando o pool entrega o token base', () => {
    // Pool entregou 100 tokens (delta negativo) e recebeu 250 USDC.
    const trade = normalizeSwap(swap(-100n * 10n ** 18n, 250_000_000n), ctx(poolBaseIsToken0));
    expect(trade?.side).toBe('buy');
    expect(trade?.tokenAmount).toBe(100);
    expect(trade?.quoteAmount).toBe(250);
    expect(trade?.usd).toBe(250);
    expect(trade?.priceUsd).toBe(2.5);
  });

  it('classifica como VENDA quando o pool recebe o token base', () => {
    const trade = normalizeSwap(swap(100n * 10n ** 18n, -250_000_000n), ctx(poolBaseIsToken0));
    expect(trade?.side).toBe('sell');
    expect(trade?.usd).toBe(250);
  });

  it('inverte corretamente quando o token base é token1', () => {
    // Agora delta0 é o USDC e delta1 é o token. Pool recebeu USDC, entregou token.
    const trade = normalizeSwap(swap(250_000_000n, -100n * 10n ** 18n), ctx(poolBaseIsToken1));
    expect(trade?.side).toBe('buy');
    expect(trade?.tokenAmount).toBe(100);
    expect(trade?.quoteAmount).toBe(250);
  });

  it('respeita os 6 decimals do USDC da Arc', () => {
    // Se o código assumisse 18 decimals, o volume sairia 10^12 vezes menor
    // e todo filtro de volume ficaria inútil.
    const trade = normalizeSwap(swap(-1n * 10n ** 18n, 1_500_000n), ctx(poolBaseIsToken0));
    expect(trade?.usd).toBe(1.5);
  });

  it('converte com o preço do quote quando ele não é dólar', () => {
    const trade = normalizeSwap(swap(-10n * 10n ** 18n, 2_000_000n), {
      ...ctx(poolBaseIsToken0),
      quoteUsdPrice: 3,
    });
    expect(trade?.usd).toBe(6);
    expect(trade?.priceUsd).toBeCloseTo(0.6);
  });

  it('descarta deltas de mesmo sinal — não é swap', () => {
    // Flash loan, doação ou evento malformado: os dois lados entram no pool.
    expect(normalizeSwap(swap(100n, 100n), ctx(poolBaseIsToken0))).toBeNull();
  });

  it('descarta swap com um lado zerado', () => {
    expect(normalizeSwap(swap(0n, 100n), ctx(poolBaseIsToken0))).toBeNull();
    expect(normalizeSwap(swap(-100n, 0n), ctx(poolBaseIsToken0))).toBeNull();
  });

  it('descarta swap de poeira que envenenaria o preço', () => {
    // 1 wei de token por 1 USDC implica preço de 10^18 por token. Aceitar isso
    // deixaria o market cap e a variação percentual do alerta absurdos — e é um
    // vetor barato de manipulação, já que o último preço da janela vai pro alerta.
    expect(normalizeSwap(swap(-1n, 1_000_000n), ctx(poolBaseIsToken0))).toBeNull();
  });

  it('aceita normalmente um trade pequeno porém real', () => {
    // O piso de poeira não pode engolir trade legítimo de valor baixo.
    const trade = normalizeSwap(swap(-(10n ** 15n), 1_000n), ctx(poolBaseIsToken0));
    expect(trade?.side).toBe('buy');
    expect(trade?.usd).toBeCloseTo(0.001);
  });
});
