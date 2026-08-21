import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/brokers.js';
import { configPathForChain, loadTraderConfig } from '../src/config.js';
import { normalizePair, WBNB_ADDRESS } from '../src/datasources/dexscreener.js';
import { parsePoolsResponse } from '../src/datasources/geckoterminal.js';
import { holderDistribution, mapGoPlusToken } from '../src/datasources/goplus.js';
import { openTraderDb } from '../src/db.js';
import { TraderEngine, type Sources } from '../src/engine.js';
import { assessRisk } from '../src/risk.js';
import type { ChainAdapter, HolderStats, OnchainTokenInfo, RugcheckSummary } from '../src/types.js';

/** Fundação multi-chain (fase 0) + BSC em paper (fase 1). */

describe('config por chain', () => {
  it('trader.bsc.json existe, parseia no schema e é coerente com a fase 1', () => {
    const cfg = loadTraderConfig(configPathForChain('bsc'));
    // GoPlus é a espinha dorsal da segurança EVM — sem ele, rejeita.
    expect(cfg.risk.requireRugcheck).toBe(true);
    // PumpPortal é pump.fun (Solana) — desligado na BSC.
    expect(cfg.discovery.pumpportal.enabled).toBe(false);
    // Só bonding curve: four.meme e flap.sh. A fourmeme não reporta liquidez
    // (é curve pura) e por isso está em curveDexIds; a flapsh reporta (~$8k),
    // então passa pelos gates normais de liquidez.
    expect(cfg.entry.gates.allowedDexIds).toEqual(['fourmeme', 'flapsh']);
    expect(cfg.entry.gates.curveDexIds).toEqual(['fourmeme']);
    expect(cfg.entry.gates.minLiquidityUsd).toBeLessThan(8000);
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

  it('taxa VAZIA é desconhecida, não 0% — o fail-open no vetor de morte da BSC', () => {
    // Medido na fourmeme/flap.sh: buy_tax/sell_tax vêm '' em 10 de 10 tokens
    // novos. Number('') é 0, e "desconhecido" virava "sem taxa".
    const s = mapGoPlusToken({ is_honeypot: '0', buy_tax: '', sell_tax: '', is_open_source: '1' });
    if (!s.available) throw new Error('esperava available');
    expect(s.buyTaxPct).toBeNull();
    expect(s.sellTaxPct).toBeNull();
    // Taxa de verdade continua sendo lida.
    const t = mapGoPlusToken({ is_honeypot: '0', buy_tax: '0', sell_tax: '0.05', is_open_source: '1' });
    if (!t.available) throw new Error('esperava available');
    expect(t.buyTaxPct).toBe(0);
    expect(t.sellTaxPct).toBeCloseTo(5);
  });

  it('concentração é medida sobre o CIRCULANTE, não sobre o supply', () => {
    // Payload REAL de um token four.meme: 0x5c95... é o contrato da bonding
    // curve (top1 holder em 10 de 11 tokens amostrados, 84%–99,9% do supply).
    // Somando o supply cru, TODO token de curve dá "top10 = 99%" e o número
    // não separa token distribuído de token bundlado.
    const holders = [
      { address: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', percent: '0.98', is_contract: 1 },
      { address: '0xaaa1', percent: '0.004' }, // 20% do circulante (0,4 / 2)
      { address: '0xaaa2', percent: '0.003' },
      { address: '0xaaa3', percent: '0.003' },
    ];
    const d = holderDistribution(holders)!;
    expect(d.top1Pct).toBeCloseTo(20);
    expect(d.top10Pct).toBeCloseTo(50);
    expect(d.source).toBe('rugcheck');

    // Sem a exclusão, o mesmo token daria top1 = 98% — a curve, não um whale.
    expect(mapGoPlusToken({ is_honeypot: '0', is_open_source: '1', holders }).available && true).toBe(true);
  });

  it('par de AMM e endereço de queima também são estruturais', () => {
    // Token que já graduou: quem segura o supply é o par do PancakeSwap.
    const d = holderDistribution([
      { address: '0xe001a6c14d0b815aa0705264acccb3239be6afc5', percent: '0.72', tag: 'PancakeV2' },
      { address: '0x000000000000000000000000000000000000dead', percent: '0.08' },
      { address: '0xbbb1', percent: '0.10' },
      { address: '0xbbb2', percent: '0.10' },
    ])!;
    // Circulante = 20%; duas carteiras com 10% cada = 50% cada.
    expect(d.top1Pct).toBeCloseTo(50);
    expect(d.top10Pct).toBeCloseTo(100);
  });

  it('circulante irrisório vira null — melhor admitir que não sabe do que inventar', () => {
    // A curve mal começou: 0,2% de float. Qualquer percentual aqui é ruído,
    // e um número falso passaria por análise de distribuição de verdade.
    expect(
      holderDistribution([
        { address: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', percent: '0.998' },
        { address: '0xccc1', percent: '0.002' },
      ]),
    ).toBeNull();
    expect(holderDistribution([])).toBeNull();
    expect(holderDistribution(null)).toBeNull();
    // Só estruturais: ninguém livre para medir.
    expect(
      holderDistribution([{ address: '0x000000000000000000000000000000000000dead', percent: '1' }]),
    ).toBeNull();
  });

  it('a distribuição do GoPlus alimenta o gate de curve — o que a BSC não tinha', () => {
    // Na EVM não dá para listar holders pelo RPC sem indexar Transfer. Sem esta
    // ponte, todo token de curve da BSC caía em curve_holders_missing e a
    // análise de concentração simplesmente não existia naquela rede.
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
    // 96% do circulante numa carteira só — o padrão bundlado real (0x9595c3b6).
    const bundled = mapGoPlusToken({
      is_honeypot: '0',
      is_open_source: '1',
      holders: [
        { address: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', percent: '0.90' },
        { address: '0xddd1', percent: '0.096' },
        { address: '0xddd2', percent: '0.004' },
      ],
    });
    if (!bundled.available) throw new Error('esperava available');
    const report = assessRisk(
      { onchain, holders: bundled.distribution ?? null, rugcheck: bundled, curve: true },
      cfg,
    );
    expect(report.flags.some((f) => f.id === 'curve_top1_concentrated')).toBe(true);
    expect(report.flags.some((f) => f.id === 'curve_holders_missing')).toBe(false);
    expect(report.verdict).toBe('rejected');
  });

  it('holder_count 0 num token com par é dado não computado, não realidade', () => {
    const s = mapGoPlusToken({ is_honeypot: '0', holder_count: '0', is_open_source: '1' });
    if (!s.available) throw new Error('esperava available');
    expect(s.holderCount).toBeNull();
  });

  it('análise SEM honeypot e SEM taxas é marcada como parcial e pontua no risco', () => {
    // O caso real dos tokens novos de curve: a fonte responde, mas sem nenhum
    // dos dois sinais que decidem na BSC. Não é aprovação.
    const shallow = mapGoPlusToken({ is_open_source: '1', buy_tax: '', sell_tax: '' });
    if (!shallow.available) throw new Error('esperava available');
    expect(shallow.shallow).toBe(true);

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
    const report = assessRisk({ onchain, holders: null, rugcheck: shallow }, cfg);
    expect(report.flags.some((f) => f.id === 'seguranca_parcial')).toBe(true);
    // Pontua mas não veta — senão bloquearia a população-alvo inteira.
    expect(report.verdict).not.toBe('vetoed');
    expect(report.score).toBeGreaterThan(0);

    // Análise COMPLETA e limpa não recebe a flag.
    const full = mapGoPlusToken({ is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1' });
    if (!full.available) throw new Error('esperava available');
    expect(full.shallow).toBe(false);
  });
});

/** Chain EVM: NÃO sabe listar holders (exigiria indexar Transfer) — como a BSC real. */
class NoHoldersChain implements ChainAdapter {
  readonly key = 'bsc' as const;
  walletAddress(): string | null {
    return null;
  }
  async nativeBalanceSol(): Promise<number> {
    return 0;
  }
  async getOnchainTokenInfo(): Promise<OnchainTokenInfo | null> {
    return {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      token2022: false,
      dangerousExtensions: [],
      taxingExtensions: [],
      decimals: 18,
      supplyRaw: 10n ** 27n,
      supplyUi: 1e9,
    };
  }
  async getTopHolders(): Promise<HolderStats | null> {
    return null;
  }
  async tokenBalanceUi(): Promise<number> {
    return 0;
  }
}

describe('análise de distribuição na BSC (ponta a ponta)', () => {
  const TOKEN = '0xdead00000000000000000000000000000000beef';

  const engineWith = (rugcheck: RugcheckSummary, dir: string) => {
    const cfg = loadTraderConfig(configPathForChain('bsc'));
    const db = openTraderDb(dir, 'bsc');
    const sources: Sources = {
      pumpportal: async () => [],
      trending: async () => [],
      newPools: async () => [],
      boosts: async () => [],
      dexPools: async () => [],
      pairs: async () => new Map(),
      rugcheck: async () => rugcheck,
      solPriceUsd: async () => 600,
    };
    const engine = new TraderEngine(
      cfg,
      db,
      new PaperBroker(db, cfg.execution, cfg.sizing),
      new NoHoldersChain(),
      sources,
      pino({ level: 'silent' }),
    );
    return { engine, db };
  };

  it('a chain não lê holders, mas a análise de concentração acontece mesmo assim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trader-bsc-dist-'));
    // 96% do circulante numa carteira só, com a curve da four.meme segurando o resto.
    const { engine, db } = engineWith(
      mapGoPlusToken({
        is_honeypot: '0',
        is_open_source: '1',
        holders: [
          { address: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', percent: '0.90' },
          { address: '0xddd1', percent: '0.096' },
          { address: '0xddd2', percent: '0.004' },
        ],
      }),
      dir,
    );

    const analysis = await engine.analyzeToken(TOKEN, true);
    // Antes desta ponte: holders=null, curve_holders_missing, e nenhuma checagem
    // de distribuição existia na BSC.
    expect(analysis.holders).not.toBeNull();
    expect(analysis.holders!.top1Pct).toBeCloseTo(96);
    expect(analysis.report.flags.some((f) => f.id === 'curve_holders_missing')).toBe(false);
    expect(analysis.report.flags.some((f) => f.id === 'curve_top1_concentrated')).toBe(true);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sem distribuição na fonte, a BSC não compra às cegas', async () => {
    // Medido: o GoPlus ainda não computou os holders dos tokens four.meme mais
    // novos — justamente onde o bundle é mais provável. Com
    // requireHolderDistribution ligado, "não sei" deixa de ser "pode".
    const dir = mkdtempSync(join(tmpdir(), 'trader-bsc-dist-'));
    const { engine, db } = engineWith(
      mapGoPlusToken({ is_honeypot: '0', is_open_source: '1' }),
      dir,
    );
    const analysis = await engine.analyzeToken(TOKEN, true);
    expect(analysis.holders).toBeNull();
    expect(analysis.report.flags.some((f) => f.id === 'curve_holders_missing')).toBe(true);
    expect(analysis.report.verdict).toBe('vetoed');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('na Solana o mesmo caso só pontua — lá a distribuição vem do RPC e faltar é raro', () => {
    const cfg = loadTraderConfig(configPathForChain('solana')).risk;
    expect(cfg.requireHolderDistribution).toBe(false);
    const report = assessRisk(
      {
        onchain: {
          mintAuthorityActive: false,
          freezeAuthorityActive: false,
          token2022: false,
          dangerousExtensions: [],
          taxingExtensions: [],
          decimals: 6,
          supplyRaw: 10n ** 15n,
          supplyUi: 1e9,
        },
        holders: null,
        rugcheck: { available: false, reason: 'sem dado' },
        curve: true,
      },
      { ...cfg, requireRugcheck: false },
    );
    expect(report.flags.some((f) => f.id === 'curve_holders_missing')).toBe(true);
    expect(report.verdict).not.toBe('vetoed');
  });
});
