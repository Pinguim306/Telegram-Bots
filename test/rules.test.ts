import { describe, expect, it } from 'vitest';
import { signalsFileSchema, type SignalsConfig } from '../src/config/schema.js';
import { EMPTY_WINDOW, type WindowStats } from '../src/bots/signals/metrics.js';
import { evaluateSignal, shouldAlert, type SignalInput } from '../src/bots/signals/rules.js';

const cfg: SignalsConfig = signalsFileSchema.parse({
  windows: { shortSec: 180, mediumSec: 900, longSec: 3600 },
  eligibility: {
    minLiquidityUsd: 2000,
    maxMarketCapUsd: 5_000_000,
    minAgeSec: 60,
    maxAgeSec: 604_800,
    minBuysShort: 5,
    minVolumeUsdShort: 300,
    minUniqueBuyersShort: 3,
  },
  rules: [
    { id: 'buy_pressure', label: 'Pressão compradora', points: 25, params: { minBuyRatio: 0.7, minBuys: 8 } },
    { id: 'volume_spike', label: 'Spike de volume', points: 30, params: { minMultiple: 4, minVolumeUsd: 1000 } },
    { id: 'unique_buyers', label: 'Compradores únicos', points: 20, params: { minUniqueBuyers: 12 } },
    { id: 'price_change', label: 'Valorização', points: 15, params: { minPctShort: 25 } },
    { id: 'net_inflow', label: 'Fluxo líquido', points: 10, params: { minNetUsd: 1500 } },
    { id: 'fresh_launch', label: 'Recém-lançado', points: 10, params: { maxAgeSec: 3600 } },
  ],
  minScore: 55,
  cooldownSec: 1800,
  reAlertScoreDelta: 20,
  maxAlertsPerHour: 12,
});

function window(overrides: Partial<WindowStats> & { windowSec: number }): WindowStats {
  return { ...EMPTY_WINDOW(overrides.windowSec), ...overrides };
}

/** Token em alta clara: muita compra, pouca venda, preço subindo, volume explodindo. */
function pumpingInput(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    ageSec: 600,
    liquidityUsd: 25_000,
    marketCapUsd: 250_000,
    short: window({
      windowSec: 180,
      buys: 40,
      sells: 5,
      volumeUsd: 9_000,
      buyVolumeUsd: 8_000,
      sellVolumeUsd: 1_000,
      uniqueBuyers: 20,
      firstPriceUsd: 0.000_001,
      lastPriceUsd: 0.000_002,
    }),
    medium: window({ windowSec: 900, buys: 50, sells: 10, volumeUsd: 11_000, uniqueBuyers: 25 }),
    long: window({
      windowSec: 3_600,
      buys: 60,
      sells: 20,
      volumeUsd: 12_000,
      firstPriceUsd: 0.000_000_5,
      lastPriceUsd: 0.000_002,
    }),
    ...overrides,
  };
}

describe('elegibilidade', () => {
  it('aceita um token que passa em todos os mínimos', () => {
    expect(evaluateSignal(pumpingInput(), cfg).eligible).toBe(true);
  });

  it('rejeita liquidez insuficiente', () => {
    const r = evaluateSignal(pumpingInput({ liquidityUsd: 100 }), cfg);
    expect(r.eligible).toBe(false);
    expect(r.rejection).toContain('liquidez');
    expect(r.score).toBe(0);
  });

  it('rejeita token jovem demais', () => {
    const r = evaluateSignal(pumpingInput({ ageSec: 10 }), cfg);
    expect(r.eligible).toBe(false);
    expect(r.rejection).toContain('idade');
  });

  it('NÃO rejeita por idade quando a idade é desconhecida', () => {
    // Idade null acontece quando o RPC não é archive. Rejeitar aí calaria o bot inteiro.
    expect(evaluateSignal(pumpingInput({ ageSec: null }), cfg).eligible).toBe(true);
  });

  it('rejeita token grande demais', () => {
    // Caso real observado na Arc: 20 compras de US$ 600 em USDT (US$ 46M de mcap).
    const r = evaluateSignal(pumpingInput({ marketCapUsd: 46_600_000 }), cfg);
    expect(r.eligible).toBe(false);
    expect(r.rejection).toContain('market cap');
  });

  it('não aplica o teto de mcap quando o supply não é legível', () => {
    expect(evaluateSignal(pumpingInput({ marketCapUsd: null }), cfg).eligible).toBe(true);
  });

  it('rejeita quando há poucos compradores únicos', () => {
    const short = window({
      windowSec: 180,
      buys: 40,
      sells: 0,
      volumeUsd: 9_000,
      buyVolumeUsd: 9_000,
      uniqueBuyers: 1,
    });
    const r = evaluateSignal(pumpingInput({ short }), cfg);
    expect(r.eligible).toBe(false);
    expect(r.rejection).toContain('compradores');
  });
});

describe('pontuação', () => {
  it('soma os pontos das regras que passam', () => {
    const r = evaluateSignal(pumpingInput(), cfg);
    // pressão + spike + compradores + valorização + fluxo + recente + sustentado
    expect(r.score).toBe(25 + 30 + 20 + 15 + 10 + 10 + 5);
    expect(r.reasons).toContain('Pressão compradora');
    expect(r.reasons).toContain('Spike de volume');
  });

  it('não dá o bônus de recém-lançado quando a idade é desconhecida', () => {
    const comIdade = evaluateSignal(pumpingInput({ ageSec: 600 }), cfg);
    const semIdade = evaluateSignal(pumpingInput({ ageSec: null }), cfg);
    expect(comIdade.score - semIdade.score).toBe(10);
    expect(semIdade.reasons).not.toContain('Recém-lançado');
  });

  it('calcula a pressão compradora como fração das operações', () => {
    const short = window({
      windowSec: 180,
      buys: 30,
      sells: 30,
      volumeUsd: 5_000,
      buyVolumeUsd: 2_500,
      sellVolumeUsd: 2_500,
      uniqueBuyers: 15,
    });
    const r = evaluateSignal(pumpingInput({ short }), cfg);
    expect(r.buyRatio).toBe(0.5);
    expect(r.reasons).not.toContain('Pressão compradora');
  });

  it('compara o volume contra a base que EXCLUI a janela curta', () => {
    // 9.000 em 180s = 50/s. Base = (12.000-9.000)/(3.600-180) ≈ 0,877/s.
    const r = evaluateSignal(pumpingInput(), cfg);
    expect(r.volumeMultiple).toBeCloseTo(50 / (3_000 / 3_420), 1);
  });

  it('limita o múltiplo quando não há histórico em vez de estourar', () => {
    const long = window({ windowSec: 3_600, volumeUsd: 9_000 });
    const r = evaluateSignal(pumpingInput({ long }), cfg);
    expect(r.volumeMultiple).toBe(999);
    expect(Number.isFinite(r.volumeMultiple)).toBe(true);
  });

  it('mede o fluxo líquido como compras menos vendas', () => {
    expect(evaluateSignal(pumpingInput(), cfg).netUsd).toBe(7_000);
  });
});

describe('shouldAlert', () => {
  const strong = evaluateSignal(pumpingInput(), cfg);

  it('alerta na primeira vez', () => {
    expect(shouldAlert(strong, cfg, null, 10_000)).toBe(true);
  });

  it('segura durante o cooldown', () => {
    expect(shouldAlert(strong, cfg, { ts: 9_500, score: strong.score }, 10_000)).toBe(false);
  });

  it('alerta depois do cooldown', () => {
    expect(shouldAlert(strong, cfg, { ts: 1_000, score: strong.score }, 10_000)).toBe(true);
  });

  it('re-alerta dentro do cooldown quando o score sobe bastante', () => {
    // O movimento acelerou de verdade — isso é informação nova, não repetição.
    expect(shouldAlert(strong, cfg, { ts: 9_500, score: strong.score - 30 }, 10_000)).toBe(true);
  });

  it('nunca alerta abaixo do score mínimo', () => {
    const weak = { ...strong, score: 10 };
    expect(shouldAlert(weak, cfg, null, 10_000)).toBe(false);
  });

  it('nunca alerta token inelegível', () => {
    const rejected = evaluateSignal(pumpingInput({ liquidityUsd: 0 }), cfg);
    expect(shouldAlert(rejected, cfg, null, 10_000)).toBe(false);
  });
});
