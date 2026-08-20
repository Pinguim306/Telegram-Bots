import { describe, expect, it } from 'vitest';
import {
  buildTradeLocalBody,
  isNoRouteError,
} from '../src/chains/solana/pumpportal-trade.js';

describe('buildTradeLocalBody', () => {
  it('monta o corpo no formato da API (booleans como string)', () => {
    const body = buildTradeLocalBody({
      publicKey: 'Wallet111',
      action: 'buy',
      mint: 'MintA',
      amount: 0.25,
      denominatedInSol: true,
      slippagePct: 3,
      priorityFeeSol: 0.002,
    });
    expect(body).toEqual({
      publicKey: 'Wallet111',
      action: 'buy',
      mint: 'MintA',
      denominatedInSol: 'true',
      amount: 0.25,
      slippage: 3,
      priorityFee: 0.002,
      pool: 'auto',
    });
  });

  it('venda denomina em tokens', () => {
    const body = buildTradeLocalBody({
      publicKey: 'W',
      action: 'sell',
      mint: 'M',
      amount: 12345.6,
      denominatedInSol: false,
      slippagePct: 15,
      priorityFeeSol: 0.002,
    });
    expect(body.denominatedInSol).toBe('false');
    expect(body.action).toBe('sell');
    expect(body.amount).toBe(12345.6);
  });
});

describe('isNoRouteError', () => {
  it('reconhece o NO_ROUTES_FOUND do Jupiter (o caso real de produção)', () => {
    expect(
      isNoRouteError(
        new Error(
          'HTTP 400 em https://lite-api.jup.ag/swap/v1/quote?...: {"error":"No routes found","errorCode":"NO_ROUTES_FOUND"}',
        ),
      ),
    ).toBe(true);
    expect(isNoRouteError(new Error('COULD_NOT_FIND_ANY_ROUTE'))).toBe(true);
  });

  it('não dispara em outros erros — fallback não pode mascarar falha real', () => {
    expect(isNoRouteError(new Error('HTTP 429 rate limit'))).toBe(false);
    expect(isNoRouteError(new Error('Transação X falhou on-chain'))).toBe(false);
    expect(isNoRouteError('string')).toBe(false);
    expect(isNoRouteError(null)).toBe(false);
  });
});
