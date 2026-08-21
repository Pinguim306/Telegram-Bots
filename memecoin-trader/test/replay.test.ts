import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTraderConfig } from '../src/config.js';
import { listDecisions, openTraderDb, recordDecision } from '../src/db.js';
import { simulateExit, type Candle } from '../src/replay.js';

/**
 * O simulador do `replay`: reexecuta stop/trailing/TP parcial/tempo sobre
 * velas de minuto. É ele que transforma "a IA reprovou 11 de 11" em "e isso
 * salvou (ou custou) X%" — calibração com número em vez de palpite.
 */

// Política de saída FIXA no teste: o resultado esperado é aritmética à mão,
// e não pode mudar quando alguém recalibrar o config real.
const exit = {
  ...loadTraderConfig().exit,
  stopLossPct: 10,
  takeProfitPct: 20,
  takeProfitSellPct: 50,
  trailingActivatePct: 10,
  trailingStopPct: 10,
  maxHoldMin: 60,
};

const c = (ts: number, o: number, h: number, l: number, close: number): Candle => ({
  ts,
  o,
  h,
  l,
  c: close,
});

describe('simulateExit', () => {
  it('stop loss: o fundo da vela cruza o stop e a posição sai no preço nominal', () => {
    const r = simulateExit([c(0, 100, 105, 89, 95)], 0, 100, exit)!;
    expect(r.exitReason).toBe('stop loss');
    expect(r.pnlPct).toBeCloseTo(-10);
  });

  it('vela ambígua (fundo E topo cruzam): o PIOR caso vence — stop, não alvo', () => {
    // Dentro de uma vela a ordem dos eventos é desconhecida; assumir o alvo
    // antes do stop inflaria TODO resultado do replay para cima.
    const r = simulateExit([c(0, 100, 130, 89, 120)], 0, 100, exit)!;
    expect(r.exitReason).toBe('stop loss');
    expect(r.pnlPct).toBeCloseTo(-10);
  });

  it('take profit PARCIAL realiza a parcela e o resto sai no trailing', () => {
    const r = simulateExit(
      [
        c(0, 100, 125, 98, 122), // alvo +20 atingido: 50% sai a +20 (realiza +10pp)
        c(60, 122, 124, 110, 110), // trailing armado (pico 125): 125*0.9=112.5 >= 110 -> sai
      ],
      0,
      100,
      exit,
    )!;
    expect(r.exitReason).toBe('trailing stop');
    // 50% a +20% = +10pp; 50% a 112.5 (+12.5%) = +6.25pp.
    expect(r.pnlPct).toBeCloseTo(10 + 6.25);
  });

  it('trailing usa o pico das velas ANTERIORES, não o topo da própria vela', () => {
    // O topo desta vela pode ter vindo DEPOIS do fundo dela — assumir o
    // contrário armaria o trailing num pico que ainda não existia.
    const r = simulateExit(
      [
        c(0, 100, 112, 100, 111), // pico 112: trailing armado (>= +10)
        c(60, 111, 140, 101, 139), // fundo 101 > 112*0.9=100.8 -> NÃO sai; pico vira 140
        c(120, 139, 139, 125, 130), // 140*0.9=126 >= 125 -> sai a 126
      ],
      0,
      100,
      exit,
    )!;
    expect(r.exitReason).toBe('trailing stop');
    // 50% saiu no alvo (+20 -> +10pp) na vela 2 (topo 140 >= 120); resto a +26%.
    expect(r.pnlPct).toBeCloseTo(10 + 0.5 * 26);
  });

  it('tempo máximo: sem stop nem alvo, sai na abertura da vela que passa do prazo', () => {
    const candles = [c(0, 100, 104, 99, 103), c(3600, 102, 103, 100, 101)];
    const r = simulateExit(candles, 0, 100, exit)!;
    expect(r.exitReason).toBe('tempo máximo');
    expect(r.pnlPct).toBeCloseTo(2);
    expect(r.holdMin).toBeCloseTo(60);
  });

  it('fim dos dados: fecha no último close e diz que os dados acabaram', () => {
    const r = simulateExit([c(0, 100, 104, 99, 103)], 0, 100, exit)!;
    expect(r.exitReason).toBe('fim dos dados');
    expect(r.pnlPct).toBeCloseTo(3);
  });

  it('sem velas após a decisão, ou preço de entrada inválido: null, nunca um número inventado', () => {
    expect(simulateExit([], 0, 100, exit)).toBeNull();
    expect(simulateExit([c(0, 100, 104, 99, 103)], 999, 100, exit)).toBeNull();
    expect(simulateExit([c(0, 100, 104, 99, 103)], 0, 0, exit)).toBeNull();
  });
});

describe('decisions no banco', () => {
  it('grava e lê de volta com filtro de estágio e período', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trader-decisions-'));
    const db = openTraderDb(dir);
    const base = {
      mode: 'paper' as const,
      mint: 'MintX',
      symbol: 'X',
      entryScore: 70,
      riskScore: 20,
      aiDecision: null,
      aiConfidence: null,
      priceUsd: 0.001,
      configHash: 'abcd1234',
      snapshotJson: '{"pairAddress":"Pool1"}',
    };
    recordDecision(db, { ...base, ts: 100, stage: 'risco', outcome: 'vetoed: rugcheck_danger' });
    recordDecision(db, {
      ...base,
      ts: 200,
      stage: 'ia',
      outcome: 'topo do pump',
      aiDecision: 'pular',
      aiConfidence: 72,
    });
    recordDecision(db, { ...base, ts: 300, stage: 'comprado', outcome: 'Momentum 5m' });

    expect(listDecisions(db, 'paper', 0)).toHaveLength(3);
    expect(listDecisions(db, 'paper', 150)).toHaveLength(2);
    const ia = listDecisions(db, 'paper', 0, 'ia');
    expect(ia).toHaveLength(1);
    expect(ia[0]!.aiConfidence).toBe(72);
    // Modo é fronteira dura: decisões do paper não vazam para análise do live.
    expect(listDecisions(db, 'live', 0)).toHaveLength(0);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
