import { describe, expect, it } from 'vitest';
import {
  buildBrief,
  buildSystemPrompt,
  SlidingWindowLimiter,
  verdictSchema,
  type AdvisorInput,
} from '../src/advisor.js';
import { loadTraderConfig } from '../src/config.js';
import type { PairSnapshot } from '../src/types.js';

function snap(overrides: Partial<PairSnapshot> = {}): PairSnapshot {
  return {
    mint: 'MintPump11111111111111111111111111111111111',
    symbol: 'PUMP',
    name: 'Pumping',
    pairAddress: 'Pair1111111111111111111111111111111111111111',
    dexId: 'pumpfun',
    quoteSymbol: 'SOL',
    priceUsd: 0.00002,
    priceNative: null,
    liquidityUsd: null,
    fdvUsd: 22_000,
    marketCapUsd: 22_000,
    vol5mUsd: 6_000,
    vol1hUsd: 18_000,
    vol24hUsd: 18_000,
    buys5m: 50,
    sells5m: 20,
    buys1h: 150,
    sells1h: 60,
    change5mPct: 12,
    change1hPct: 40,
    change6hPct: 40,
    change24hPct: 40,
    ageMin: 22,
    url: null,
    ...overrides,
  };
}

function input(): AdvisorInput {
  return {
    snap: snap(),
    sources: ['pp-migration', 'gt-trending'],
    entryScore: 75,
    entryReasons: ['Momentum 5m', 'Pressão compradora'],
    report: {
      score: 15,
      verdict: 'approved',
      flags: [{ id: 'x', severity: 'info', label: 'LP 95% travada' }],
    } as AdvisorInput['report'],
    holderCount: 240,
    top10Pct: 18,
    lpLockedPct: 95,
    curve: true,
  };
}

describe('buildBrief', () => {
  it('inclui os dados que a IA precisa para julgar timing e organicidade', () => {
    const brief = buildBrief(input());
    for (const needle of [
      'PUMP',
      'bonding curve',
      'idadeMin: 22',
      'marketCapUsd: 22000',
      'compras5m: 50',
      'vendas5m: 20',
      'variacao5mPct: 12',
      'pp-migration',
      'scoreEntrada: 75',
      'holders: 240',
      'LP 95% travada',
    ]) {
      expect(brief).toContain(needle);
    }
  });

  it('marca dados ausentes como desconhecidos em vez de inventar zero', () => {
    const i = input();
    i.snap = snap({ ageMin: null, marketCapUsd: null, fdvUsd: null });
    i.holderCount = null;
    const brief = buildBrief(i);
    expect(brief).toContain('idadeMin: desconhecida');
    expect(brief).toContain('marketCapUsd: desconhecido');
    expect(brief).toContain('holders: desconhecido');
  });
});

describe('buildSystemPrompt', () => {
  it('descreve a estratégia com os números do config VIGENTE — nunca fixos no texto', () => {
    // Visto em produção: faixa de mcap escrita à mão no prompt fez a IA
    // reprovar token dentro da faixa nova depois que o operador mudou os
    // gates pelo painel ("Mcap 4.3k está fora da faixa alvo (15-30k)").
    const cfg = loadTraderConfig();
    cfg.entry.gates.minMarketCapUsd = 4000;
    cfg.entry.gates.maxMarketCapUsd = 30000;
    cfg.exit.takeProfitPct = 12;
    cfg.exit.stopLossPct = 9;
    cfg.exit.maxHoldMin = 30;

    const prompt = buildSystemPrompt(cfg);
    expect(prompt).toContain('US$ 4.000');
    expect(prompt).toContain('US$ 30.000');
    expect(prompt).toContain('+12%');
    expect(prompt).toContain('-9%');
    expect(prompt).toContain('30 minutos');
    expect(prompt).not.toContain('15k');

    // 0 = sem piso/teto tem que virar texto, não "US$ 0".
    cfg.entry.gates.minMarketCapUsd = 0;
    cfg.entry.gates.maxMarketCapUsd = 0;
    const openEnded = buildSystemPrompt(cfg);
    expect(openEnded).toContain('sem piso');
    expect(openEnded).toContain('sem teto');
  });

  it('avisa que o top10 de token de curve pode incluir o vault', () => {
    const brief = buildBrief(input());
    expect(brief).toContain('vault da bonding curve');
  });
});

describe('verdictSchema', () => {
  it('aceita o formato do veredito e rejeita fora do range', () => {
    expect(
      verdictSchema.parse({ decision: 'comprar', confidence: 80, reason: 'momentum nascendo' }),
    ).toBeTruthy();
    expect(() =>
      verdictSchema.parse({ decision: 'talvez', confidence: 80, reason: 'x' }),
    ).toThrow();
    expect(() =>
      verdictSchema.parse({ decision: 'pular', confidence: 120, reason: 'x' }),
    ).toThrow();
  });
});

describe('SlidingWindowLimiter', () => {
  it('trava no teto e libera quando a janela de 1h desliza', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter(() => clock);
    expect(limiter.tryAcquire(3)).toBe(true);
    expect(limiter.tryAcquire(3)).toBe(true);
    expect(limiter.tryAcquire(3)).toBe(true);
    expect(limiter.tryAcquire(3)).toBe(false);

    // 59 minutos depois: as 3 chamadas continuam dentro da janela.
    clock = 59 * 60_000;
    expect(limiter.tryAcquire(3)).toBe(false);

    // 61 minutos depois da primeira: a janela deslizou, libera de novo.
    clock = 61 * 60_000;
    expect(limiter.tryAcquire(3)).toBe(true);

    // Teto mudado pelo painel em execução vale na hora.
    expect(limiter.tryAcquire(1)).toBe(false);
  });
});
