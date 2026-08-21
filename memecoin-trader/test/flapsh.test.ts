import { describe, expect, it } from 'vitest';
import { configPathForChain, loadTraderConfig } from '../src/config.js';
import {
  applyFlapTaxes,
  FlapSecurityStore,
  parseFlapBoard,
  parseFlapshSearch,
} from '../src/datasources/flapsh.js';
import { mapGoPlusToken } from '../src/datasources/goplus.js';
import { assessRisk } from '../src/risk.js';

/**
 * Fonte própria da flap.sh: ninguém a indexa direito (o GeckoTerminal não a
 * lista como dex), então a descoberta vem do board do próprio site + busca do
 * DexScreener — e o board ainda entrega as TAXAS do contrato, que o GoPlus
 * não computou para token novo.
 */

/** Item REAL do board (payload SSR de flap.sh/board, campos preservados). */
const realItem = {
  coin: {
    address: '0x06978Cf29057654816AF5BF22ae7b9c15a687777',
    name: 'BNBULL',
    symbol: 'BNBULL',
    image: 'bafkreiafnke7nxnlon7zx265bpqvbii3frg3asgs6bnqaf7vm3nkbbwtwu',
  },
  listed: true,
  price: '0.00012228',
  marketCap: '122280',
  volume24h: '2117000.902217569039983858',
  holders: 1454,
  liquidity: '39019.64237',
  progress: '100',
  change5m: '-0.27',
  change1h: '-24.75',
  change4h: '-66.57',
  change24h: '189.11',
  tax: { hasTax: true, buyTaxBps: 0, sellTaxBps: 100 },
};

/** Token ainda NA CURVE (a população-alvo): progress < 100, sem tax no payload. */
const curveItem = {
  coin: { address: '0xAbCd000000000000000000000000000000007777', name: 'Fresh', symbol: 'FRESH' },
  listed: false,
  price: '0.00000123',
  marketCap: '12300',
  progress: '37.5',
};

describe('parseFlapBoard', () => {
  it('extrai candidatos (minúsculas, dedup) e a segurança com taxas em %', () => {
    const { candidates, security } = parseFlapBoard({
      items: [realItem, curveItem, realItem, { coin: { address: 'não-é-0x' } }, null],
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.mint).toBe('0x06978cf29057654816af5bf22ae7b9c15a687777');
    expect(candidates[0]!.sources).toEqual(['flapsh-board']);

    const sec = security.get('0x06978cf29057654816af5bf22ae7b9c15a687777')!;
    // 100 bps = 1% — a base do board é 10_000.
    expect(sec.buyTaxPct).toBe(0);
    expect(sec.sellTaxPct).toBe(1);
    expect(sec.listed).toBe(true);
    expect(sec.progress).toBe(100);

    // Sem bloco tax: taxa DESCONHECIDA, nunca 0 — a lição do GoPlus.
    const fresh = security.get('0xabcd000000000000000000000000000000007777')!;
    expect(fresh.buyTaxPct).toBeNull();
    expect(fresh.sellTaxPct).toBeNull();
    expect(fresh.listed).toBe(false);
    expect(fresh.progress).toBeCloseTo(37.5);
  });

  it('sobrevive a lixo', () => {
    expect(parseFlapBoard(null).candidates).toEqual([]);
    expect(parseFlapBoard({}).candidates).toEqual([]);
    expect(parseFlapBoard({ items: 'nope' }).security.size).toBe(0);
  });
});

describe('applyFlapTaxes', () => {
  const flapSec = { buyTaxPct: 1, sellTaxPct: 25, progress: 40, listed: false };

  it('preenche a taxa que o GoPlus não computou — e ela chega ao teto do risco', () => {
    // O caso real da BSC: GoPlus responde shallow (sem honeypot, sem taxas)
    // para token de minutos. A flap.sh sabe as taxas desde o bloco zero.
    const shallow = mapGoPlusToken({ is_open_source: '1', buy_tax: '', sell_tax: '' });
    const merged = applyFlapTaxes(shallow, flapSec);
    if (!merged.available) throw new Error('esperava available');
    expect(merged.sellTaxPct).toBe(25);
    expect(merged.buyTaxPct).toBe(1);

    const cfg = loadTraderConfig(configPathForChain('bsc')).risk;
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
        rugcheck: merged,
      },
      cfg,
    );
    // 25% de taxa de venda come o alvo inteiro — o teto (maxSellTaxPct) rejeita.
    expect(report.flags.some((f) => f.id === 'sell_tax')).toBe(true);
    expect(report.verdict).not.toBe('approved');
  });

  it('NUNCA sobrescreve o que o GoPlus mediu — só preenche buraco', () => {
    const measured = mapGoPlusToken({ is_honeypot: '0', is_open_source: '1', buy_tax: '0', sell_tax: '0.05' });
    const merged = applyFlapTaxes(measured, flapSec);
    if (!merged.available) throw new Error('esperava available');
    expect(merged.sellTaxPct).toBeCloseTo(5); // o valor do GoPlus, não os 25 da flap
    expect(merged.buyTaxPct).toBe(0);
  });

  it('resumo indisponível e segurança ausente passam intactos', () => {
    const unavailable = { available: false as const, reason: 'x' };
    expect(applyFlapTaxes(unavailable, flapSec)).toBe(unavailable);
    const shallow = mapGoPlusToken({ is_open_source: '1' });
    expect(applyFlapTaxes(shallow, undefined)).toBe(shallow);
  });
});

describe('parseFlapshSearch', () => {
  const pair = (over: Record<string, unknown>) => ({
    chainId: 'bsc',
    dexId: 'flapsh',
    baseToken: { address: '0xAbCd000000000000000000000000000000000001', symbol: 'KAPI', name: 'Kapi' },
    quoteToken: { symbol: 'WBNB' },
    priceUsd: '0.001',
    liquidity: { usd: 9500 },
    volume: { h1: 4000, h24: 60000, m5: 300 },
    txns: { h1: { buys: 80, sells: 40 }, m5: { buys: 6, sells: 2 } },
    priceChange: { m5: 2, h1: 11 },
    pairCreatedAt: 1_787_200_000_000,
    ...over,
  });

  it('só entra par flapsh DA BSC — e o snapshot vem completo para os gates', () => {
    const { candidates, snaps } = parseFlapshSearch(
      {
        pairs: [
          pair({}),
          // flapsh de OUTRA rede (a flap.sh também roda na Robinhood Chain).
          pair({ chainId: 'robinhood', baseToken: { address: '0xFF00000000000000000000000000000000000002', symbol: 'RH' } }),
          // par da BSC que NÃO é flapsh.
          pair({ dexId: 'pancakeswap', baseToken: { address: '0xFF00000000000000000000000000000000000003', symbol: 'CAKE' } }),
        ],
      },
      1_787_203_600_000,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.mint).toBe('0xabcd000000000000000000000000000000000001');
    expect(candidates[0]!.sources).toEqual(['flapsh-ds']);
    const snap = snaps.get('0xabcd000000000000000000000000000000000001')!;
    expect(snap.dexId).toBe('flapsh');
    expect(snap.liquidityUsd).toBe(9500);
    expect(snap.vol1hUsd).toBe(4000);
    expect(snap.buys1h).toBe(80);
    expect(snap.ageMin).toBeCloseTo(60);
  });

  it('sobrevive a lixo', () => {
    expect(parseFlapshSearch(null, 0).candidates).toEqual([]);
    expect(parseFlapshSearch({ pairs: 'nope' }, 0).snaps.size).toBe(0);
  });
});

describe('o furo que a validação real revelou', () => {
  it('token NÃO-curve sem distribuição também é vetado na BSC (flap.sh reporta liquidez)', () => {
    // Medido em produção: um token da flap.sh de 1h26m passou APROVADO com
    // "distribuição de holders indisponível" — o requireHolderDistribution só
    // valia no ramo de curve, e a flapsh não está em curveDexIds porque
    // reporta liquidez. O princípio vale UNIFORME: não verifica, não compra.
    const cfg = loadTraderConfig(configPathForChain('bsc')).risk;
    const shallow = mapGoPlusToken({ is_honeypot: '0', is_open_source: '1' });
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
        rugcheck: shallow,
        curve: false,
      },
      cfg,
    );
    expect(report.flags.some((f) => f.id === 'holders_missing' && f.severity === 'veto')).toBe(true);
    expect(report.verdict).toBe('vetoed');
  });
});

describe('FlapSecurityStore', () => {
  it('cada resposta substitui a anterior da mesma fonte', () => {
    const store = new FlapSecurityStore();
    const sec = { buyTaxPct: 1, sellTaxPct: 1, progress: 50, listed: false };
    store.put('board', new Map([['0xvelho', sec]]));
    store.put('board', new Map([['0xnovo', sec]]));
    expect(store.get('0xvelho')).toBeUndefined();
    expect(store.get('0xnovo')).toBe(sec);
  });
});
