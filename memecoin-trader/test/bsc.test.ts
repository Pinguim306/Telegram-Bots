import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPathForChain, loadTraderConfig } from '../src/config.js';
import { normalizePair, WBNB_ADDRESS } from '../src/datasources/dexscreener.js';
import { parsePoolsResponse } from '../src/datasources/geckoterminal.js';
import { mapGoPlusToken } from '../src/datasources/goplus.js';
import { openTraderDb } from '../src/db.js';
import { assessRisk } from '../src/risk.js';

/** Fundação multi-chain (fase 0) + BSC em paper (fase 1). */

describe('config por chain', () => {
  it('trader.bsc.json existe, parseia no schema e é coerente com a fase 1', () => {
    const cfg = loadTraderConfig(configPathForChain('bsc'));
    // GoPlus é a espinha dorsal da segurança EVM — sem ele, rejeita.
    expect(cfg.risk.requireRugcheck).toBe(true);
    // PumpPortal é pump.fun (Solana) — desligado na BSC.
    expect(cfg.discovery.pumpportal.enabled).toBe(false);
    expect(cfg.entry.gates.allowedDexIds).toContain('pancakeswap');
    // Painéis das duas redes convivem: portas diferentes.
    const solana = loadTraderConfig(configPathForChain('solana'));
    expect(cfg.dashboard.port).not.toBe(solana.dashboard.port);
    // Exclusões da BSC canonicalizadas (minúsculas) — inclui WBNB.
    expect(cfg.discovery.excludeMints).toContain(WBNB_ADDRESS);
    for (const m of cfg.discovery.excludeMints) expect(m).toBe(m.toLowerCase());
  });
});

describe('banco por chain', () => {
  it('cada rede tem o próprio arquivo — caixa paper e breaker não se misturam', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trader-chains-'));
    const sol = openTraderDb(dir, 'solana');
    const bsc = openTraderDb(dir, 'bsc');
    sol.close();
    bsc.close();
    expect(existsSync(join(dir, 'trader.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'trader-bsc.sqlite'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fontes parametrizadas por rede', () => {
  it('GeckoTerminal: pool da bsc entra com endereço canonicalizado; de outra rede é descartado', () => {
    const json = {
      data: [
        {
          attributes: { name: 'DOGE2 / WBNB' },
          relationships: { base_token: { data: { id: 'bsc_0xAbCd000000000000000000000000000000000001' } } },
        },
        {
          attributes: { name: 'PUMP / SOL' },
          relationships: { base_token: { data: { id: 'solana_MintPump111' } } },
        },
      ],
    };
    const bsc = parsePoolsResponse(json, 'gt-trending', 'bsc');
    expect(bsc).toHaveLength(1);
    expect(bsc[0]!.mint).toBe('0xabcd000000000000000000000000000000000001');

    const solana = parsePoolsResponse(json, 'gt-trending', 'solana');
    expect(solana).toHaveLength(1);
    expect(solana[0]!.mint).toBe('MintPump111');
  });

  it('DexScreener: normalizePair filtra pela rede pedida e canonicaliza endereço EVM', () => {
    const rawBsc = {
      chainId: 'bsc',
      baseToken: { address: '0xAbCd000000000000000000000000000000000001', symbol: 'DOGE2', name: 'Doge 2' },
      quoteToken: { symbol: 'WBNB' },
      dexId: 'pancakeswap',
      priceUsd: '0.001',
      liquidity: { usd: 50000 },
      volume: { h1: 10000 },
      txns: { h1: { buys: 100, sells: 50 } },
      priceChange: {},
      pairCreatedAt: 1_700_000_000_000,
    };
    expect(normalizePair(rawBsc, Date.now(), 'solana')).toBeNull();
    const snap = normalizePair(rawBsc, Date.now(), 'bsc')!;
    expect(snap.mint).toBe('0xabcd000000000000000000000000000000000001');
    expect(snap.dexId).toBe('pancakeswap');
  });
});

describe('GoPlus → RugcheckSummary', () => {
  it('honeypot vira rugged; funções perigosas do contrato viram dangerFlags que o risco veta', () => {
    const summary = mapGoPlusToken({
      is_honeypot: '1',
      is_mintable: '1',
      transfer_pausable: '1',
      is_open_source: '1',
      buy_tax: '0.05',
      sell_tax: '0.25',
      holder_count: '850',
      holders: [{ percent: '0.30' }, { percent: '0.10' }],
      lp_holders: [
        { percent: '0.8', is_locked: 1 },
        { percent: '0.2', is_locked: 0 },
      ],
    });
    if (!summary.available) throw new Error('esperava available');
    expect(summary.rugged).toBe(true);
    expect(summary.dangerFlags.join(' ')).toContain('honeypot');
    expect(summary.dangerFlags.join(' ')).toContain('mintable');
    expect(summary.sellTaxPct).toBeCloseTo(25);
    expect(summary.holderCount).toBe(850);
    expect(summary.top10Pct).toBeCloseTo(40);
    expect(summary.lpLockedPct).toBeCloseTo(80);

    // O motor de risco (inalterado) veta pelo rugged + dangers.
    const report = assessRisk(
      {
        onchain: {
          mintAuthorityActive: false,
          freezeAuthorityActive: false,
          token2022: false,
          dangerousExtensions: [],
          taxingExtensions: [],
          decimals: 18,
          supplyRaw: 10n ** 27n,
          supplyUi: 1e9,
        },
        holders: null,
        rugcheck: summary,
      },
      loadTraderConfig(configPathForChain('bsc')).risk,
    );
    expect(report.verdict).toBe('vetoed');
  });

  it('token limpo passa; taxa de venda acima do teto pontua alto', () => {
    const clean = mapGoPlusToken({
      is_honeypot: '0',
      is_open_source: '1',
      buy_tax: '0',
      sell_tax: '0',
      holder_count: '5000',
      holders: [{ percent: '0.04' }],
      lp_holders: [{ percent: '1', is_locked: 1 }],
    });
    if (!clean.available) throw new Error('esperava available');
    expect(clean.rugged).toBe(false);
    expect(clean.dangerFlags).toHaveLength(0);

    const taxed = mapGoPlusToken({
      is_honeypot: '0',
      is_open_source: '1',
      sell_tax: '0.18',
      holder_count: '5000',
      holders: [{ percent: '0.04' }],
      lp_holders: [{ percent: '1', is_locked: 1 }],
    });
    if (!taxed.available) throw new Error('esperava available');
    const cfg = loadTraderConfig(configPathForChain('bsc')).risk;
    const onchain = {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      token2022: false,
      dangerousExtensions: [],
      taxingExtensions: [],
      decimals: 18,
      supplyRaw: 10n ** 27n,
      supplyUi: 1e9,
    };
    const cleanReport = assessRisk({ onchain, holders: null, rugcheck: clean }, cfg);
    expect(cleanReport.verdict).toBe('approved');
    const taxedReport = assessRisk({ onchain, holders: null, rugcheck: taxed }, cfg);
    expect(taxedReport.flags.some((f) => f.id === 'sell_tax')).toBe(true);
    expect(taxedReport.verdict).toBe('rejected');
  });

  it('resposta vazia vira available:false — e requireRugcheck da BSC rejeita', () => {
    const missing = mapGoPlusToken(null);
    expect(missing.available).toBe(false);
  });
});
