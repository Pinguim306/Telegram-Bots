import { describe, expect, it } from 'vitest';
import { TOPIC, decodeMint, decodeSwap, decodePoolCreation } from '../src/core/events.js';

/**
 * Os hashes abaixo não vieram de documentação: são os topic0 que retornaram logs
 * de verdade quando consultados contra o RPC da Arc. Se uma assinatura de evento
 * for editada por engano, o scanner passaria a não encontrar nada — silenciosamente.
 * Este teste transforma esse bug silencioso em falha de build.
 */
describe('topic0 dos eventos', () => {
  it('bate com os hashes observados na Arc', () => {
    expect(TOPIC.transfer).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
    expect(TOPIC.pairCreated).toBe(
      '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
    );
    expect(TOPIC.poolCreated).toBe(
      '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
    );
    expect(TOPIC.v2Swap).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
    expect(TOPIC.v3Swap).toBe('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  });
});

/** Log real de PoolCreated capturado na Arc testnet. */
const REAL_POOL_CREATED = {
  address: '0xba27c71bf06ab69723d9bd7c96f13d591fd53a93',
  topics: [
    TOPIC.poolCreated,
    '0x0000000000000000000000003600000000000000000000000000000000000000',
    '0x000000000000000000000000bede2758ecd1a276392e4f68c75a43dc2838051f',
    '0x0000000000000000000000000000000000000000000000000000000000000bb8',
  ],
  data: '0x000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000009b96401f55a1f212bc00cf6a7e595e049ab2cbf2',
} as const;

describe('decodePoolCreation', () => {
  it('decodifica um PoolCreated real da Arc', () => {
    const decoded = decodePoolCreation({ ...REAL_POOL_CREATED } as never);
    expect(decoded).toEqual({
      kind: 'v3',
      factory: '0xba27c71bf06ab69723d9bd7c96f13d591fd53a93',
      pool: '0x9b96401f55a1f212bc00cf6a7e595e049ab2cbf2',
      token0: '0x3600000000000000000000000000000000000000',
      token1: '0xbede2758ecd1a276392e4f68c75a43dc2838051f',
      fee: 3000,
    });
  });

  it('devolve null para um evento desconhecido em vez de lançar', () => {
    expect(
      decodePoolCreation({ address: '0x1', topics: ['0xdead'], data: '0x' } as never),
    ).toBeNull();
  });

  it('devolve null quando o payload não bate com a assinatura', () => {
    // Fork exótico com a mesma assinatura e layout diferente: ignorar é melhor
    // do que derrubar o scanner.
    expect(
      decodePoolCreation({
        address: '0xba27c71bf06ab69723d9bd7c96f13d591fd53a93',
        topics: [TOPIC.poolCreated],
        data: '0x00',
      } as never),
    ).toBeNull();
  });
});

describe('decodeSwap', () => {
  const pool = '0x00000000000000000000000000000000000000aa';
  const sender = '0x00000000000000000000000000000000000000bb';
  const recipient = '0x00000000000000000000000000000000000000cc';
  const topicOf = (addr: string) => `0x000000000000000000000000${addr.slice(2)}`;

  it('reconstrói deltas assinados a partir do formato V2 (in/out separados)', () => {
    const data = `0x${[
      0n, // amount0In
      500n, // amount1In
      100n, // amount0Out
      0n, // amount1Out
    ]
      .map((v) => v.toString(16).padStart(64, '0'))
      .join('')}`;

    const decoded = decodeSwap({
      address: pool,
      topics: [TOPIC.v2Swap, topicOf(sender), topicOf(recipient)],
      data,
    } as never);

    // Pool recebeu token1 e entregou token0.
    expect(decoded?.delta0).toBe(-100n);
    expect(decoded?.delta1).toBe(500n);
    expect(decoded?.recipient).toBe(recipient);
  });

  it('lê deltas já assinados do formato V3', () => {
    const negative = (1n << 256n) - 100n; // -100 em complemento de dois
    const data = `0x${[negative, 500n, 0n, 0n, 0n]
      .map((v) => v.toString(16).padStart(64, '0'))
      .join('')}`;

    const decoded = decodeSwap({
      address: pool,
      topics: [TOPIC.v3Swap, topicOf(sender), topicOf(recipient)],
      data,
    } as never);

    expect(decoded?.kind).toBe('v3');
    expect(decoded?.delta0).toBe(-100n);
    expect(decoded?.delta1).toBe(500n);
  });
});

describe('decodeMint', () => {
  const zero = `0x${'0'.repeat(64)}`;
  const to = '0x00000000000000000000000000000000000000dd';

  it('reconhece Transfer vindo do endereço zero', () => {
    const decoded = decodeMint({
      address: '0x00000000000000000000000000000000000000ee',
      topics: [TOPIC.transfer, zero, `0x000000000000000000000000${to.slice(2)}`],
      data: `0x${(1000n).toString(16).padStart(64, '0')}`,
    } as never);
    expect(decoded).toEqual({
      token: '0x00000000000000000000000000000000000000ee',
      to,
      value: 1000n,
    });
  });

  it('ignora Transfer comum entre carteiras', () => {
    const from = `0x000000000000000000000000${to.slice(2)}`;
    expect(
      decodeMint({
        address: '0x00000000000000000000000000000000000000ee',
        topics: [TOPIC.transfer, from, from],
        data: `0x${(1n).toString(16).padStart(64, '0')}`,
      } as never),
    ).toBeNull();
  });
});
