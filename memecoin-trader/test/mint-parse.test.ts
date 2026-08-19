import { describe, expect, it } from 'vitest';
import {
  MINT_ACCOUNT_MIN_SIZE,
  parseMintAccount,
  parseToken2022Extensions,
  rawToUi,
} from '../src/chains/solana/mint.js';

/** Monta um mint account sintético com o layout real do SPL Token. */
function mintData(opts: {
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  supply?: bigint;
  decimals?: number;
  initialized?: boolean;
}): Uint8Array {
  const data = new Uint8Array(MINT_ACCOUNT_MIN_SIZE);
  const view = new DataView(data.buffer);
  view.setUint32(0, opts.mintAuthority ? 1 : 0, true);
  view.setBigUint64(36, opts.supply ?? 1_000_000_000_000n, true);
  data[44] = opts.decimals ?? 6;
  data[45] = opts.initialized === false ? 0 : 1;
  view.setUint32(46, opts.freezeAuthority ? 1 : 0, true);
  return data;
}

describe('parseMintAccount', () => {
  it('lê um mint renunciado (sem authorities) — o caso saudável', () => {
    const parsed = parseMintAccount(mintData({ supply: 123_456n, decimals: 9 }));
    expect(parsed).not.toBeNull();
    expect(parsed!.mintAuthorityActive).toBe(false);
    expect(parsed!.freezeAuthorityActive).toBe(false);
    expect(parsed!.supplyRaw).toBe(123_456n);
    expect(parsed!.decimals).toBe(9);
  });

  it('detecta mint authority ativa', () => {
    const parsed = parseMintAccount(mintData({ mintAuthority: true }));
    expect(parsed!.mintAuthorityActive).toBe(true);
    expect(parsed!.freezeAuthorityActive).toBe(false);
  });

  it('detecta freeze authority ativa', () => {
    const parsed = parseMintAccount(mintData({ freezeAuthority: true }));
    expect(parsed!.freezeAuthorityActive).toBe(true);
  });

  it('rejeita conta menor que o layout', () => {
    expect(parseMintAccount(new Uint8Array(81))).toBeNull();
  });

  it('rejeita mint não inicializado', () => {
    expect(parseMintAccount(mintData({ initialized: false }))).toBeNull();
  });

  it('aceita dados maiores que 82 bytes (Token-2022 com extensões)', () => {
    const base = mintData({ freezeAuthority: true });
    const extended = new Uint8Array(200);
    extended.set(base);
    const parsed = parseMintAccount(extended);
    expect(parsed).not.toBeNull();
    expect(parsed!.freezeAuthorityActive).toBe(true);
  });
});

/** Monta um mint Token-2022 com entradas TLV a partir do byte 166. */
function token2022Data(extensions: { type: number; length: number }[]): Uint8Array {
  const totalLen = 166 + extensions.reduce((a, e) => a + 4 + e.length, 0) + 8;
  const data = new Uint8Array(totalLen);
  data.set(mintData({}));
  data[165] = 1; // account type: Mint
  const view = new DataView(data.buffer);
  let offset = 166;
  for (const ext of extensions) {
    view.setUint16(offset, ext.type, true);
    view.setUint16(offset + 2, ext.length, true);
    offset += 4 + ext.length;
  }
  return data;
}

describe('parseToken2022Extensions', () => {
  it('mint clássico (82 bytes) não tem extensões', () => {
    const result = parseToken2022Extensions(mintData({}));
    expect(result.all).toEqual([]);
  });

  it('extensões de metadata (o padrão do pump.fun) são benignas', () => {
    const result = parseToken2022Extensions(
      token2022Data([
        { type: 18, length: 64 }, // metadataPointer
        { type: 19, length: 128 }, // tokenMetadata
      ]),
    );
    expect(result.all).toEqual(['metadataPointer', 'tokenMetadata']);
    expect(result.dangerous).toEqual([]);
    expect(result.taxing).toEqual([]);
  });

  it('detecta as extensões honeypot', () => {
    const result = parseToken2022Extensions(
      token2022Data([
        { type: 18, length: 64 },
        { type: 12, length: 32 }, // permanentDelegate
        { type: 14, length: 64 }, // transferHook
      ]),
    );
    expect(result.dangerous).toEqual(['permanentDelegate', 'transferHook']);
  });

  it('detecta taxa de transferência', () => {
    const result = parseToken2022Extensions(token2022Data([{ type: 1, length: 108 }]));
    expect(result.taxing).toEqual(['transferFeeConfig']);
  });

  it('tipo desconhecido não explode e ganha nome genérico', () => {
    const result = parseToken2022Extensions(token2022Data([{ type: 99, length: 4 }]));
    expect(result.all).toEqual(['ext_99']);
    expect(result.dangerous).toEqual([]);
  });
});

describe('rawToUi', () => {
  it('converte com decimals', () => {
    expect(rawToUi(1_500_000n, 6)).toBe(1.5);
    expect(rawToUi(1n, 9)).toBe(1e-9);
    expect(rawToUi(0n, 6)).toBe(0);
  });

  it('não estoura com supply gigante', () => {
    // 1 trilhão de tokens com 9 decimals — comum em memecoin.
    const raw = 1_000_000_000_000n * 1_000_000_000n;
    expect(rawToUi(raw, 9)).toBe(1_000_000_000_000);
  });
});
