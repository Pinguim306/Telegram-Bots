import { describe, expect, it } from 'vitest';
import { loadTraderConfig } from '../src/config.js';
import { assessRisk, type RiskInput } from '../src/risk.js';
import type { OnchainTokenInfo, RugcheckSummary } from '../src/types.js';

const cfg = loadTraderConfig().risk;

const cleanOnchain: OnchainTokenInfo = {
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  token2022: false,
  dangerousExtensions: [],
  taxingExtensions: [],
  decimals: 6,
  supplyRaw: 1_000_000_000_000n,
  supplyUi: 1_000_000,
};

const cleanRugcheck: RugcheckSummary = {
  available: true,
  rugged: false,
  scoreNormalized: 5,
  dangerFlags: [],
  lpDangerFlags: [],
  warnFlags: [],
  lpLockedPct: 95,
  holderCount: 5_000,
  top10Pct: 22,
};

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    onchain: cleanOnchain,
    holders: { top1Pct: 4, top10Pct: 25, holderCount: null, source: 'onchain' },
    rugcheck: cleanRugcheck,
    ...overrides,
  };
}

describe('assessRisk', () => {
  it('aprova token limpo', () => {
    const report = assessRisk(input(), cfg);
    expect(report.verdict).toBe('approved');
    expect(report.score).toBe(0);
    expect(report.flags).toHaveLength(0);
  });

  it('veta freeze authority ativa — nenhum score compensa honeypot', () => {
    const report = assessRisk(
      input({ onchain: { ...cleanOnchain, freezeAuthorityActive: true } }),
      cfg,
    );
    expect(report.verdict).toBe('vetoed');
    expect(report.flags.some((f) => f.id === 'freeze_authority' && f.severity === 'veto')).toBe(true);
  });

  it('veta mint authority ativa', () => {
    const report = assessRisk(input({ onchain: { ...cleanOnchain, mintAuthorityActive: true } }), cfg);
    expect(report.verdict).toBe('vetoed');
  });

  it('veta quando o mint account não pôde ser lido (requireOnchain)', () => {
    const report = assessRisk(input({ onchain: null }), cfg);
    expect(report.verdict).toBe('vetoed');
    expect(report.flags[0]!.id).toBe('onchain_missing');
  });

  it('veta danger do RugCheck (não relacionado a LP)', () => {
    const report = assessRisk(
      input({ rugcheck: { ...cleanRugcheck, dangerFlags: ['Copycat token'] } }),
      cfg,
    );
    expect(report.verdict).toBe('vetoed');
  });

  it('veta token já marcado como rugged', () => {
    const report = assessRisk(input({ rugcheck: { ...cleanRugcheck, rugged: true } }), cfg);
    expect(report.verdict).toBe('vetoed');
    expect(report.flags.some((f) => f.id === 'rugged')).toBe(true);
  });

  it('flag danger de LP NÃO veta — pontua pouco (duplica o sinal de lpLockedPct)', () => {
    const report = assessRisk(
      input({ rugcheck: { ...cleanRugcheck, lpDangerFlags: ['LP Vault unlocked'] } }),
      cfg,
    );
    expect(report.verdict).toBe('approved');
    expect(report.score).toBeLessThanOrEqual(12);
  });

  it('Token-2022 sem extensões perigosas é limpo — é o padrão do pump.fun', () => {
    const report = assessRisk(input({ onchain: { ...cleanOnchain, token2022: true } }), cfg);
    expect(report.verdict).toBe('approved');
    expect(report.score).toBe(0);
  });

  it('extensão honeypot (permanentDelegate/transferHook) veta', () => {
    const report = assessRisk(
      input({
        onchain: { ...cleanOnchain, token2022: true, dangerousExtensions: ['permanentDelegate'] },
      }),
      cfg,
    );
    expect(report.verdict).toBe('vetoed');
    expect(report.flags.some((f) => f.id === 'dangerous_extension')).toBe(true);
  });

  it('extensão de taxa pontua alto mas não veta sozinha', () => {
    const report = assessRisk(
      input({
        onchain: { ...cleanOnchain, token2022: true, taxingExtensions: ['transferFeeConfig'] },
      }),
      cfg,
    );
    expect(report.verdict).toBe('approved');
    expect(report.score).toBe(20);
  });

  it('rejeita concentração de holders acima do teto', () => {
    const report = assessRisk(
      input({
        rugcheck: { ...cleanRugcheck, top10Pct: 80, warnFlags: ['High ownership'] },
        holders: { top1Pct: 40, top10Pct: 85, holderCount: null, source: 'onchain' },
      }),
      cfg,
    );
    expect(report.verdict).toBe('rejected');
    expect(report.flags.some((f) => f.id === 'top10_concentrated')).toBe(true);
  });

  it('bonding curve: concentração de holders não se aplica — a "maior conta" é o vault da curve', () => {
    const report = assessRisk(
      input({
        curve: true,
        rugcheck: { ...cleanRugcheck, top10Pct: null, holderCount: null },
        holders: { top1Pct: 85, top10Pct: 97, holderCount: null, source: 'onchain' },
      }),
      cfg,
    );
    expect(report.verdict).toBe('approved');
    expect(
      report.flags.filter((f) => f.id.startsWith('top') || f.id === 'holders_missing'),
    ).toHaveLength(0);
  });

  it('na curve, mint/freeze/extensões continuam vetando — são a defesa real', () => {
    const report = assessRisk(
      input({ curve: true, onchain: { ...cleanOnchain, freezeAuthorityActive: true } }),
      cfg,
    );
    expect(report.verdict).toBe('vetoed');
  });

  it('prefere o top10 do RugCheck (que exclui vaults) ao do RPC cru', () => {
    // RPC cru mostra 60% (inclui o vault do pool); RugCheck mostra 20%.
    const report = assessRisk(
      input({
        rugcheck: { ...cleanRugcheck, top10Pct: 20 },
        holders: { top1Pct: 45, top10Pct: 60, holderCount: null, source: 'onchain' },
      }),
      cfg,
    );
    expect(report.flags.some((f) => f.id === 'top10_concentrated')).toBe(false);
    // E o top1 do RPC não é usado quando o RugCheck cobre a concentração.
    expect(report.flags.some((f) => f.id === 'top1_concentrated')).toBe(false);
  });

  it('RugCheck fora do ar penaliza score mas não bloqueia (requireRugcheck=false)', () => {
    const report = assessRisk(input({ rugcheck: { available: false, reason: 'timeout' } }), cfg);
    expect(report.verdict).toBe('approved');
    expect(report.score).toBeGreaterThan(0);
  });

  it('acumula sinais médios até rejeitar', () => {
    const report = assessRisk(
      input({
        onchain: { ...cleanOnchain, taxingExtensions: ['transferFeeConfig'] },
        holders: null,
        rugcheck: {
          available: true,
          rugged: false,
          scoreNormalized: 70,
          dangerFlags: [],
          lpDangerFlags: [],
          warnFlags: ['Mutable metadata', 'New token'],
          lpLockedPct: 10,
          holderCount: 50,
          top10Pct: null,
        },
      }),
      cfg,
    );
    // 10 (t22) + 10 (holders) + 20 (score alto) + 10 (warns) + 12 (LP) + 12 (poucos holders) > 40
    expect(report.verdict).toBe('rejected');
    expect(report.score).toBeGreaterThan(cfg.maxScore);
  });
});
