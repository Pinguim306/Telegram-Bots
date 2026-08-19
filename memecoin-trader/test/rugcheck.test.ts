import { describe, expect, it } from 'vitest';
import { normalizeRugcheckReport } from '../src/datasources/rugcheck.js';

const fixture = {
  mint: 'MintA11111111111111111111111111111111111111',
  score: 1543,
  score_normalised: 23,
  rugged: false,
  risks: [
    { name: 'Low amount of LP Providers', level: 'warn', score: 400 },
    { name: 'Mutable metadata', level: 'warn', score: 100 },
    { name: 'Freeze Authority still enabled', level: 'danger', score: 1000 },
    { name: 'LP Vault unlocked', level: 'danger', score: 900 },
    // Duplicata — o RugCheck emite uma por mercado; não pode contar duas vezes.
    { name: 'LP Vault unlocked', level: 'danger', score: 800 },
  ],
  totalHolders: 4321,
  markets: [
    // 20k de liquidez sem trava + 80k com 60k travados => 60% ponderado.
    { lp: { baseUSD: 10_000, quoteUSD: 10_000, lpLockedUSD: 0, lpLockedPct: 0 } },
    { lp: { baseUSD: 40_000, quoteUSD: 40_000, lpLockedUSD: 60_000, lpLockedPct: 75 } },
  ],
  knownAccounts: {
    RaydiumVault11111111111111111111111111111111: { name: 'Raydium Vault', type: 'AMM' },
  },
  topHolders: [
    { address: 'RaydiumVault11111111111111111111111111111111', pct: 42.0 },
    { address: 'Holder1', pct: 8.5 },
    { address: 'Holder2', pct: 4.2 },
    { address: 'Holder3', pct: 2.0 },
  ],
};

describe('normalizeRugcheckReport', () => {
  it('extrai score, separa flags de LP das demais e pondera a trava de LP', () => {
    const summary = normalizeRugcheckReport(fixture);
    if (!summary.available) throw new Error('deveria estar disponível');
    expect(summary.scoreNormalized).toBe(23);
    expect(summary.rugged).toBe(false);
    expect(summary.dangerFlags).toEqual(['Freeze Authority still enabled']);
    expect(summary.lpDangerFlags).toEqual(['LP Vault unlocked']);
    expect(summary.warnFlags).toHaveLength(2);
    expect(summary.lpLockedPct).toBeCloseTo(60);
    expect(summary.holderCount).toBe(4321);
  });

  it('propaga rugged=true', () => {
    const summary = normalizeRugcheckReport({ ...fixture, rugged: true });
    if (!summary.available) throw new Error('deveria estar disponível');
    expect(summary.rugged).toBe(true);
  });

  it('exclui vaults de AMM do top 10 — o pool não é um "holder"', () => {
    const summary = normalizeRugcheckReport(fixture);
    if (!summary.available) throw new Error('deveria estar disponível');
    // 8.5 + 4.2 + 2.0, sem os 42% do vault da Raydium.
    expect(summary.top10Pct).toBeCloseTo(14.7);
  });

  it('resposta vazia ou lixo vira indisponível', () => {
    expect(normalizeRugcheckReport(null).available).toBe(false);
    expect(normalizeRugcheckReport('x').available).toBe(false);
  });

  it('relatório mínimo não explode', () => {
    const summary = normalizeRugcheckReport({ mint: 'abc' });
    if (!summary.available) throw new Error('deveria estar disponível');
    expect(summary.scoreNormalized).toBeNull();
    expect(summary.rugged).toBe(false);
    expect(summary.dangerFlags).toEqual([]);
    expect(summary.lpDangerFlags).toEqual([]);
    expect(summary.lpLockedPct).toBeNull();
    expect(summary.top10Pct).toBeNull();
  });

  it('mercados sem liquidez não geram divisão por zero', () => {
    const summary = normalizeRugcheckReport({
      markets: [{ lp: { baseUSD: 0, quoteUSD: 0, lpLockedUSD: 0 } }],
    });
    if (!summary.available) throw new Error('deveria estar disponível');
    expect(summary.lpLockedPct).toBeNull();
  });

  it('score_normalised fora da faixa é grampeado em 0–100', () => {
    const summary = normalizeRugcheckReport({ score_normalised: 250 });
    if (!summary.available) throw new Error('deveria estar disponível');
    expect(summary.scoreNormalized).toBe(100);
  });
});
