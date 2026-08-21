import { describe, expect, it } from 'vitest';
import {
  curveBuyTokensOut,
  curveRoundTripCostPct,
  curveSellSolOut,
  parseCurveAccount,
  type CurveState,
} from '../src/chains/solana/pumpcurve.js';

/** Curve recém-nascida do pump.fun: ~30 SOL virtuais, ~1,073B tokens (6 dec). */
function freshCurve(overrides: Partial<CurveState> = {}): CurveState {
  return {
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    realSolReserves: 2_000_000_000n,
    complete: false,
    ...overrides,
  };
}

describe('matemática da bonding curve', () => {
  it('round-trip pequeno custa ~2% (as duas taxas) + impacto pequeno', () => {
    // 0,05 SOL numa curve de 30 SOL virtuais: impacto ~0,3%, taxas 2%.
    const cost = curveRoundTripCostPct(freshCurve(), 50_000_000n);
    expect(cost).toBeGreaterThan(1.9);
    expect(cost).toBeLessThan(3.5);
  });

  it('round-trip imediato custa só as taxas, independente do tamanho — x·y=k cancela o impacto', () => {
    // Este teste DOCUMENTA o fato que derrubou a ideia de "limitar tamanho
    // pelo impacto do próprio giro": não existe esse impacto num round-trip
    // imediato. A perda real vem do fluxo dos outros — e é combatida por
    // gate de idade + teto de posição, não por matemática de curve.
    const small = curveRoundTripCostPct(freshCurve(), 50_000_000n); // 0,05 SOL
    const big = curveRoundTripCostPct(freshCurve(), 3_000_000_000n); // 3 SOL
    expect(small).toBeCloseTo(2, 0);
    expect(big).toBeCloseTo(2, 0);
  });

  it('a venda nunca paga mais SOL do que a curve realmente tem', () => {
    // Curve com muito valor virtual mas só 0,5 SOL real depositado.
    const drained = freshCurve({ realSolReserves: 500_000_000n });
    const out = curveSellSolOut(drained, 500_000_000_000_000n);
    expect(out).toBeLessThanOrEqual((500_000_000n * 9_900n) / 10_000n);
  });

  it('compra e venda são consistentes (vender o que se comprou devolve menos, nunca mais)', () => {
    const curve = freshCurve();
    const solIn = 200_000_000n; // 0,2 SOL
    const tokens = curveBuyTokensOut(curve, solIn);
    expect(tokens).toBeGreaterThan(0n);
    const after: CurveState = {
      ...curve,
      virtualSolReserves: curve.virtualSolReserves + (solIn * 9_900n) / 10_000n,
      virtualTokenReserves: curve.virtualTokenReserves - tokens,
      realSolReserves: curve.realSolReserves + (solIn * 9_900n) / 10_000n,
    };
    expect(curveSellSolOut(after, tokens)).toBeLessThan(solIn);
  });

  it('parseCurveAccount lê o layout (discriminator + 5×u64 + bool)', () => {
    const buf = Buffer.alloc(49);
    buf.writeBigUInt64LE(1_073_000_000_000_000n, 8);
    buf.writeBigUInt64LE(30_000_000_000n, 16);
    buf.writeBigUInt64LE(793_100_000_000_000n, 24);
    buf.writeBigUInt64LE(2_000_000_000n, 32);
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
    buf.writeUInt8(1, 48);
    const curve = parseCurveAccount(buf)!;
    expect(curve.virtualSolReserves).toBe(30_000_000_000n);
    expect(curve.realSolReserves).toBe(2_000_000_000n);
    expect(curve.complete).toBe(true);
    // Conta curta demais = ilegível, nunca lixo interpretado.
    expect(parseCurveAccount(Buffer.alloc(20))).toBeNull();
  });
});
