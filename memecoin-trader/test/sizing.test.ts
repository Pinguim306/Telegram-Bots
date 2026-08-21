import { describe, expect, it } from 'vitest';
import { loadTraderConfig } from '../src/config.js';
import { blockReason, positionSizeSol, type SizingInput } from '../src/sizing.js';

const cfg = loadTraderConfig().sizing;

describe('breaker com mark-to-market', () => {
  it('buraco ABERTO soma na trava diária; lucro aberto não destrava', () => {
    // Realizado -0,2 + aberto -0,35 = -0,55 <= -0,5: trava (antes, a posição
    // afundando "não existia" para o breaker até a venda sair).
    const blocked = blockReason(
      { balanceSol: 5, openPositions: 0, dailyRealizedPnlSol: -0.2, openUnrealizedSol: -0.35, riskScore: 0 },
      cfg,
    );
    expect(blocked).toContain('perda diária');

    // Lucro não-realizado NÃO compensa perda realizada — pode evaporar.
    const stillBlocked = blockReason(
      { balanceSol: 5, openPositions: 0, dailyRealizedPnlSol: -0.6, openUnrealizedSol: 1, riskScore: 0 },
      cfg,
    );
    expect(stillBlocked).toContain('perda diária');

    // Sem o campo (chamadas antigas), comportamento idêntico ao anterior.
    const ok = blockReason(
      { balanceSol: 5, openPositions: 0, dailyRealizedPnlSol: -0.2, riskScore: 0 },
      cfg,
    );
    expect(ok).toBeNull();
  });
});

function input(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    balanceSol: 5,
    openPositions: 0,
    dailyRealizedPnlSol: 0,
    riskScore: 0,
    ...overrides,
  };
}

describe('blockReason', () => {
  it('libera com saldo e capacidade', () => {
    expect(blockReason(input(), cfg)).toBeNull();
  });

  it('bloqueia no teto de posições abertas', () => {
    expect(blockReason(input({ openPositions: cfg.maxOpenPositions }), cfg)).toContain('posições');
  });

  it('circuit breaker: perda diária no limite desliga compras', () => {
    const reason = blockReason(input({ dailyRealizedPnlSol: -cfg.maxDailyLossSol }), cfg);
    expect(reason).toContain('perda diária');
  });

  it('lucro diário não bloqueia', () => {
    expect(blockReason(input({ dailyRealizedPnlSol: cfg.maxDailyLossSol * 2 }), cfg)).toBeNull();
  });

  it('bloqueia quando o saldo líquido da reserva não cobre a posição mínima', () => {
    const reason = blockReason(
      input({ balanceSol: cfg.reserveSol + cfg.minPositionSol / 2 }),
      cfg,
    );
    expect(reason).toContain('saldo');
  });
});

describe('positionSizeSol', () => {
  it('usa % do saldo com teto absoluto', () => {
    const size = positionSizeSol(input({ balanceSol: 100 }), cfg);
    // 5% de 100 = 5 SOL, mas o teto é maxPositionSol.
    expect(size).toBe(cfg.maxPositionSol);
  });

  it('saldo pequeno: % do saldo manda', () => {
    const size = positionSizeSol(input({ balanceSol: 1 }), cfg);
    expect(size).toBeCloseTo(1 * (cfg.positionPctOfBalance / 100), 10);
  });

  it('risco maior encolhe a posição (riskScaling)', () => {
    const clean = positionSizeSol(input({ balanceSol: 100, riskScore: 0 }), cfg)!;
    const risky = positionSizeSol(input({ balanceSol: 100, riskScore: 40 }), cfg)!;
    expect(risky).toBeLessThan(clean);
    expect(risky).toBeCloseTo(clean * 0.6, 10);
  });

  it('devolve null quando o tamanho cai abaixo do mínimo', () => {
    const size = positionSizeSol(
      input({ balanceSol: cfg.reserveSol + cfg.minPositionSol * 1.05, riskScore: 90 }),
      cfg,
    );
    expect(size).toBeNull();
  });

  it('nunca invade a reserva', () => {
    const balance = cfg.reserveSol + 0.02;
    const size = positionSizeSol(input({ balanceSol: balance }), cfg);
    if (size !== null) expect(size).toBeLessThanOrEqual(balance - cfg.reserveSol + 1e-12);
  });
});
