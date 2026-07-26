import { describe, expect, it } from 'vitest';
import { renderLaunchAlert } from '../src/bots/launches/message.js';
import { renderSignalAlert } from '../src/bots/signals/message.js';
import { EMPTY_WINDOW, type WindowStats } from '../src/bots/signals/metrics.js';
import type { SignalResult } from '../src/bots/signals/rules.js';
import type { BuiltLink } from '../src/core/referrals.js';

const links: BuiltLink[] = [
  { label: 'Explorer', url: 'https://scan/token', kind: 'explorer', monetized: false },
  { label: 'Comprar', url: 'https://dex/swap?ref=X', kind: 'trade', monetized: true },
  { label: 'Chart', url: 'https://chart/pool', kind: 'chart', monetized: false },
];

const window = (o: Partial<WindowStats> & { windowSec: number }): WindowStats => ({
  ...EMPTY_WINDOW(o.windowSec),
  ...o,
});

const result: SignalResult = {
  eligible: true,
  score: 80,
  reasons: ['Pressão compradora', 'Spike de volume'],
  volumeMultiple: 6,
  buyRatio: 0.9,
  priceChangeShortPct: 104,
  priceChangeLongPct: 115,
  netUsd: 7_000,
};

function signal(overrides: Partial<Parameters<typeof renderSignalAlert>[0]> = {}) {
  return renderSignalAlert({
    networkName: 'Arc',
    tokenAddress: '0x00000000000000000000000000000000000000aa',
    tokenName: 'Dream',
    tokenSymbol: 'DREAM',
    poolAddress: '0x00000000000000000000000000000000000000bb',
    dexLabel: 'ArcSwap V3',
    quoteSymbol: 'USDC',
    priceUsd: 0.000_000_637,
    marketCapUsd: 67_300,
    liquidity: { quoteUsd: 12_400, baseUsd: 11_000, totalUsd: 23_400 },
    ageSec: 53,
    short: window({ windowSec: 180, buys: 96, sells: 12, buyVolumeUsd: 20_900, uniqueBuyers: 34 }),
    medium: window({ windowSec: 900 }),
    long: window({ windowSec: 3_600, volumeUsd: 41_000 }),
    result,
    links,
    ...overrides,
  });
}

describe('renderSignalAlert', () => {
  it('inclui preço, mcap e contagens no texto', () => {
    const text = signal().text;
    expect(text).toContain('0.000000637');
    expect(text).toContain('$67.3K');
    expect(text).toContain('96 compras');
    expect(text).toContain('34 carteiras');
  });

  it('descreve volume ACIMA da média corretamente', () => {
    expect(signal().text).toContain('6.0x acima da média');
  });

  it('descreve volume ABAIXO da média sem inverter o sentido', () => {
    // O bug original escrevia "0.3x acima da média" — o oposto do que o número diz.
    const text = signal({ result: { ...result, volumeMultiple: 0.3 } }).text;
    expect(text).toContain('abaixo da média');
    expect(text).not.toContain('0.3x acima');
  });

  it('não afirma múltiplo quando não há histórico', () => {
    const text = signal({ result: { ...result, volumeMultiple: 999 } }).text;
    expect(text).toContain('sem volume prévio');
  });

  it('diz que a idade é desconhecida em vez de mostrar zero', () => {
    expect(signal({ ageSec: null }).text).toContain('idade desconhecida');
  });

  it('coloca o link que paga como primeiro botão', () => {
    const buttons = signal().buttons!;
    expect(buttons[0]?.[0]?.label).toBe('Comprar');
  });

  it('escapa HTML vindo do nome do token', () => {
    const text = signal({ tokenName: '<b>x</b>', tokenSymbol: '<i>y</i>' }).text;
    expect(text).not.toContain('<b>x</b>');
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('cabe no limite de 4096 caracteres do Telegram', () => {
    const enorme = signal({
      short: window({ windowSec: 180, buys: 100_000, uniqueBuyers: 99_999 }),
      tokenName: 'A'.repeat(500),
    });
    expect(enorme.text.length).toBeLessThan(4_096);
  });
});

function launch(overrides: Partial<Parameters<typeof renderLaunchAlert>[0]> = {}) {
  return renderLaunchAlert({
    networkName: 'Arc',
    tokenAddress: '0x00000000000000000000000000000000000000aa',
    tokenName: 'Dream',
    tokenSymbol: 'DREAM',
    decimals: 18,
    totalSupply: 1_000_000_000,
    poolAddress: '0x00000000000000000000000000000000000000bb',
    poolKind: 'v3',
    dexLabel: 'ArcSwap V3',
    feePct: 0.3,
    quoteSymbol: 'USDC',
    liquidity: { quoteUsd: 5_000, baseUsd: 5_000, totalUsd: 10_000 },
    priceUsd: 0.000_004_5,
    marketCapUsd: 4_500,
    ageSec: 53,
    risk: { owner: null, renounced: true, flags: [], score: 0 },
    links,
    ...overrides,
  });
}

describe('renderLaunchAlert', () => {
  it('mostra liquidez de saída e tamanho do pool separadamente', () => {
    const text = launch().text;
    expect(text).toContain('Liquidez de saída');
    expect(text).toContain('Tamanho do pool');
  });

  it('avisa quando não há contraparte para vender', () => {
    // Launch de bonding curve: dá para comprar, não dá para sair. Omitir isso
    // seria empurrar o seguidor do canal para uma posição sem saída.
    const text = launch({ liquidity: { quoteUsd: 0, baseUsd: 8_000, totalUsd: 8_000 } }).text;
    expect(text).toContain('não dá para vender');
  });

  it('não mostra o aviso quando há liquidez de saída de verdade', () => {
    expect(launch().text).not.toContain('não dá para vender');
  });

  it('sinaliza owner renunciado', () => {
    expect(launch().text).toContain('renunciado');
  });

  it('mostra a taxa da pool sem sinal de variação', () => {
    // "taxa +1.00%" sugere que a taxa subiu 1% — não é o que o número significa.
    const text = launch({ feePct: 1 }).text;
    expect(text).toContain('taxa 1.00%');
    expect(text).not.toContain('taxa +');
  });

  it('diz que o contrato não expõe owner() em vez de "desconhecido"', () => {
    const text = launch({
      risk: { owner: null, renounced: false, flags: [], score: 0 },
    }).text;
    expect(text).toContain('não expõe owner()');
  });

  it('lista as flags de risco encontradas no bytecode', () => {
    const text = launch({
      risk: { owner: '0x00000000000000000000000000000000000000cc', renounced: false, flags: ['mint', 'blacklist'], score: 65 },
    }).text;
    expect(text).toContain('risco 65/100');
    expect(text).toContain('Mint: ✅ presente');
    expect(text).toContain('Blacklist: ✅ presente');
  });

  it('deduplica pelo endereço do pool', () => {
    expect(launch().dedupeKey).toBe('launch:0x00000000000000000000000000000000000000bb');
  });
});
