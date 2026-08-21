import { describe, expect, it } from 'vitest';
import { configPathForChain, loadTraderConfig } from '../src/config.js';
import {
  GtSnapshotStore,
  normalizeDexId,
  parseGtPools,
  parsePoolsResponse,
  poolToSnapshot,
} from '../src/datasources/geckoterminal.js';
import { evaluateEntry } from '../src/strategy.js';
import type { PairSnapshot } from '../src/types.js';

/** Resposta crua no formato JSON:API do GeckoTerminal. */
const fixture = {
  data: [
    {
      id: 'solana_PoolAddr1',
      type: 'pool',
      attributes: { name: 'WIF / SOL', address: 'PoolAddr1' },
      relationships: {
        base_token: { data: { id: 'solana_MintWif1111111111111111111111111111111111', type: 'token' } },
        quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112', type: 'token' } },
      },
    },
    {
      id: 'solana_PoolAddr2',
      type: 'pool',
      attributes: { name: 'BODEN / USDC' },
      relationships: {
        base_token: { data: { id: 'solana_MintBoden111111111111111111111111111111111' } },
      },
    },
    // Duplicata do primeiro mint em outro pool — não pode gerar candidato repetido.
    {
      attributes: { name: 'WIF / USDC' },
      relationships: {
        base_token: { data: { id: 'solana_MintWif1111111111111111111111111111111111' } },
      },
    },
    // Base token de outra chain (defensivo — não deveria vir, mas APIs mentem).
    {
      attributes: { name: 'PEPE / WETH' },
      relationships: { base_token: { data: { id: 'eth_0xabc' } } },
    },
    // Sem relationships.
    { attributes: { name: 'BROKEN / SOL' } },
  ],
};

describe('parsePoolsResponse', () => {
  it('extrai mint e símbolo, deduplicando', () => {
    const candidates = parsePoolsResponse(fixture, 'gt-trending');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      mint: 'MintWif1111111111111111111111111111111111',
      symbol: 'WIF',
      sources: ['gt-trending'],
    });
    expect(candidates[1]!.symbol).toBe('BODEN');
  });

  it('sobrevive a lixo', () => {
    expect(parsePoolsResponse(null, 'gt-new')).toEqual([]);
    expect(parsePoolsResponse({}, 'gt-new')).toEqual([]);
    expect(parsePoolsResponse({ data: 'nope' }, 'gt-new')).toEqual([]);
  });
});

describe('normalizeDexId', () => {
  it('traduz os nomes do GeckoTerminal para os do DexScreener', () => {
    // O config tem UMA lista de allowedDexIds. Sem a tradução, o mesmo token
    // passaria ou não no gate de DEX conforme a fonte que o viu primeiro.
    expect(normalizeDexId('four-meme')).toBe('fourmeme');
    expect(normalizeDexId('pump-fun')).toBe('pumpfun');
    expect(normalizeDexId('pancakeswap_v3')).toBe('pancakeswap');
    // Nome já comum às duas fontes passa intacto.
    expect(normalizeDexId('pumpswap')).toBe('pumpswap');
  });
});

/**
 * Payload REAL de `/networks/bsc/dexes/four-meme/pools` (campos preservados,
 * endereços encurtados). É a população-alvo da estratégia da BSC.
 */
const fourMemePool = {
  id: 'bsc_0x0a5bbacb1e8725b3a50cc0d2e534207e45d8ffff',
  type: 'pool',
  attributes: {
    base_token_price_usd: '0.00000477773346474224',
    base_token_price_native_currency: '0.00000000723416731988104',
    address: '0x0a5bbacb1e8725b3a50cc0d2e534207e45d8ffff',
    name: 'MEME / BNB',
    pool_created_at: '2026-08-21T01:30:35Z',
    fdv_usd: '14777.733465',
    market_cap_usd: null,
    price_change_percentage: { m5: '0', h1: '2.485', h6: '7.495', h24: '7.495' },
    transactions: {
      m5: { buys: 3, sells: 1 },
      h1: { buys: 90, sells: 40 },
      h6: { buys: 1524, sells: 1139 },
    },
    volume_usd: { m5: '515.83', h1: '5984.41', h24: '151721.21' },
    reserve_in_usd: '9761.0077',
  },
  relationships: {
    // O GT devolve o endereço EVM em checksum; o bot trabalha em minúsculas.
    base_token: { data: { id: 'bsc_0x0A5bBACB1E8725B3a50cc0D2e534207E45d8FFFF', type: 'token' } },
    dex: { data: { id: 'four-meme', type: 'dex' } },
  },
};

/** 90 minutos depois da criação do pool acima. */
const NOW = Date.parse('2026-08-21T03:00:35Z');

describe('poolToSnapshot', () => {
  it('monta o snapshot completo a partir do payload de descoberta', () => {
    const snap = poolToSnapshot(fourMemePool, 'bsc', NOW)!;
    expect(snap.mint).toBe('0x0a5bbacb1e8725b3a50cc0d2e534207e45d8ffff');
    expect(snap.dexId).toBe('fourmeme');
    expect(snap.symbol).toBe('MEME');
    expect(snap.priceUsd).toBeCloseTo(4.77773346474224e-6, 12);
    // `reserve_in_usd` é a liquidez do pool — e EXISTE na curve, onde o
    // DexScreener manda null.
    expect(snap.liquidityUsd).toBeCloseTo(9761.0077);
    expect(snap.vol5mUsd).toBeCloseTo(515.83);
    expect(snap.vol1hUsd).toBeCloseTo(5984.41);
    expect(snap.buys1h).toBe(90);
    expect(snap.sells1h).toBe(40);
    expect(snap.buys5m).toBe(3);
    expect(snap.change1hPct).toBeCloseTo(2.485);
    expect(snap.ageMin).toBeCloseTo(90);
    // Sem market_cap_usd, o FDV é quem responde pelo gate de mcap.
    expect(snap.marketCapUsd).toBeNull();
    expect(snap.fdvUsd).toBeCloseTo(14777.73, 1);
  });

  it('descarta pool sem preço, de outra rede, ou que não é pool', () => {
    const noPrice = { ...fourMemePool, attributes: { ...fourMemePool.attributes, base_token_price_usd: '0' } };
    expect(poolToSnapshot(noPrice, 'bsc', NOW)).toBeNull();
    expect(poolToSnapshot(fourMemePool, 'solana', NOW)).toBeNull();
    expect(poolToSnapshot(null, 'bsc', NOW)).toBeNull();
    expect(poolToSnapshot({ attributes: null }, 'bsc', NOW)).toBeNull();
  });

  it('idade fica null quando o GT não sabe a data de criação — o gate reprova, não chuta', () => {
    const noDate = { ...fourMemePool, attributes: { ...fourMemePool.attributes, pool_created_at: null } };
    expect(poolToSnapshot(noDate, 'bsc', NOW)!.ageMin).toBeNull();
  });
});

describe('parseGtPools', () => {
  it('devolve candidatos e snapshots da MESMA resposta, mais líquido ganha', () => {
    const thin = {
      ...fourMemePool,
      attributes: { ...fourMemePool.attributes, reserve_in_usd: '12.5', name: 'MEME / USDT' },
    };
    const { candidates, snaps } = parseGtPools({ data: [thin, fourMemePool] }, 'gt-dex:four-meme', 'bsc', NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sources).toEqual(['gt-dex:four-meme']);
    expect(snaps.size).toBe(1);
    expect(snaps.get('0x0a5bbacb1e8725b3a50cc0d2e534207e45d8ffff')!.liquidityUsd).toBeCloseTo(9761.0077);
  });

  it('sobrevive a lixo', () => {
    expect(parseGtPools(null, 'gt-new').snaps.size).toBe(0);
    expect(parseGtPools({ data: 'nope' }, 'gt-new').candidates).toEqual([]);
  });
});

/** Snapshot mínimo para exercitar o store sem depender do parser. */
const snapOf = (mint: string, liquidityUsd: number | null): PairSnapshot =>
  ({ mint, liquidityUsd }) as PairSnapshot;

describe('GtSnapshotStore', () => {
  it('só preenche buracos — o DexScreener continua sendo a fonte de verdade', () => {
    const store = new GtSnapshotStore();
    store.put('dex', new Map([['a', snapOf('a', 100)], ['b', snapOf('b', 200)]]));

    const found = new Map<string, PairSnapshot>([['a', snapOf('a', 999)]]);
    const filled = store.fill(found, ['a', 'b', 'c']);

    expect(filled).toBe(1);
    expect(found.get('a')!.liquidityUsd).toBe(999); // não sobrescreveu
    expect(found.get('b')!.liquidityUsd).toBe(200); // preencheu o buraco
    expect(found.has('c')).toBe(false); // ninguém tem: continua sem par
  });

  it('cada fetch SUBSTITUI a resposta anterior da sua fonte — nada velho sobrevive', () => {
    // É o que impede o mapa de crescer com todo mint já visto e, pior, de
    // servir preço de minutos atrás como se fosse do tick.
    const store = new GtSnapshotStore();
    store.put('trending', new Map([['velho', snapOf('velho', 100)]]));
    store.put('trending', new Map([['novo', snapOf('novo', 100)]]));

    expect(store.get('velho')).toBeNull();
    expect(store.get('novo')).not.toBeNull();
    // Fontes diferentes convivem.
    store.put('new', new Map([['outro', snapOf('outro', 100)]]));
    expect(store.get('novo')).not.toBeNull();
    expect(store.get('outro')).not.toBeNull();
  });

  it('entre fontes, vence a mais líquida', () => {
    const store = new GtSnapshotStore();
    store.put('trending', new Map([['a', snapOf('a', 50)]]));
    store.put('dex', new Map([['a', snapOf('a', 5000)]]));
    expect(store.get('a')!.liquidityUsd).toBe(5000);
  });
});

describe('enriquecimento pelo GeckoTerminal (o que destrava a estratégia da BSC)', () => {
  it('um pool four-meme vindo SÓ do GT passa nos gates reais da BSC', () => {
    // Medido em produção: o DexScreener leva minutos para indexar um par novo
    // de curve, e esses tokens viravam "candidato sem par" — nunca avaliados.
    // Este é o caminho que abre: descoberta e enriquecimento no mesmo payload.
    const cfg = loadTraderConfig(configPathForChain('bsc')).entry;
    const snap = poolToSnapshot(fourMemePool, 'bsc', NOW)!;
    const result = evaluateEntry(snap, ['gt-dex:four-meme'], cfg);
    expect(result.rejectionId).toBeUndefined();
    expect(result.eligible).toBe(true);
  });
});
