import { describe, expect, it } from 'vitest';
import { parsePoolsResponse } from '../src/datasources/geckoterminal.js';

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
