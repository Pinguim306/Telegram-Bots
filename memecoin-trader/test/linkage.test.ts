import { describe, expect, it } from 'vitest';
import { computeHolderStats } from '../src/chains/solana/index.js';
import { maxCluster, maxSharedCount } from '../src/chains/solana/linkage.js';
import { curveTokenAccount } from '../src/chains/solana/pumpcurve.js';

const MINT = '8pvFk4RnLBBWvQTnc246aAydWCTRHemL5A1RpvMWpump';

describe('computeHolderStats — concentração sobre o circulante', () => {
  const supply = 1_000_000n;

  it('sem exclusão: percentuais sobre o supply total', () => {
    const stats = computeHolderStats(
      [
        { address: 'A', raw: 200_000n },
        { address: 'B', raw: 100_000n },
      ],
      supply,
    )!;
    expect(stats.top1Pct).toBeCloseTo(20);
    expect(stats.top10Pct).toBeCloseTo(30);
  });

  it('excluindo o vault da curve, a base vira o CIRCULANTE — o sinal real aparece', () => {
    // Curve com 90% do supply; 3 carteiras têm 80% do que circula (8% do total
    // cada) — sobre o supply total pareceria "24%", saudável. Não é.
    const stats = computeHolderStats(
      [
        { address: 'VAULT', raw: 900_000n },
        { address: 'S1', raw: 27_000n },
        { address: 'S2', raw: 27_000n },
        { address: 'S3', raw: 26_000n },
      ],
      supply,
      ['VAULT'],
    )!;
    expect(stats.top1Pct).toBeCloseTo(27, 0);
    expect(stats.top10Pct).toBeCloseTo(80, 0);
  });

  it('base zerada ou lista vazia devolve null em vez de inventar número', () => {
    expect(computeHolderStats([], 1000n)).toBeNull();
    expect(computeHolderStats([{ address: 'V', raw: 1000n }], 1000n, ['V'])).toBeNull();
  });
});

describe('maxCluster / maxSharedCount — os detectores de bundle', () => {
  it('maxCluster acha o maior aglomerado dentro da tolerância de slots', () => {
    // 4 compras nos slots 100-102 (bundle), 2 dispersas.
    expect(maxCluster([100, 101, 102, 100, 500, 900], 2)).toBe(4);
    expect(maxCluster([100, 200, 300], 2)).toBe(1);
    expect(maxCluster([], 2)).toBe(0);
    // Tolerância zero = exatamente o mesmo slot.
    expect(maxCluster([7, 7, 7, 8], 0)).toBe(3);
  });

  it('maxSharedCount conta a maior repetição de carteira-mãe, ignorando nulls', () => {
    expect(maxSharedCount(['mae1', 'mae1', 'mae1', 'mae2', null, null])).toBe(3);
    expect(maxSharedCount([null, null])).toBe(0);
    expect(maxSharedCount(['a', 'b', 'c'])).toBe(1);
  });
});

describe('curveTokenAccount', () => {
  it('derivação é determinística e muda com o token program', () => {
    const legacy = curveTokenAccount(MINT, false);
    const t2022 = curveTokenAccount(MINT, true);
    expect(legacy.toBase58()).toBe(curveTokenAccount(MINT, false).toBase58());
    expect(legacy.toBase58()).not.toBe(t2022.toBase58());
  });
});
