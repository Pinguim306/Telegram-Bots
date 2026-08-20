import { describe, expect, it } from 'vitest';
import { CandidateBuffer, parsePumpPortalMessage } from '../src/datasources/pumpportal.js';

describe('parsePumpPortalMessage', () => {
  it('parseia mint novo (create)', () => {
    const event = parsePumpPortalMessage({
      signature: 'abc',
      mint: 'MintNovo1111111111111111111111111111111111',
      txType: 'create',
      name: 'Cow Coin',
      symbol: 'COW',
      traderPublicKey: 'Dev11111111111111111111111111111111111111',
    });
    expect(event).toEqual({ kind: 'new', mint: 'MintNovo1111111111111111111111111111111111', symbol: 'COW' });
  });

  it('parseia graduação (migrate), com símbolo ausente', () => {
    const event = parsePumpPortalMessage({
      mint: 'MintGrad1111111111111111111111111111111111',
      txType: 'migrate',
      pool: 'pump-amm',
    });
    expect(event).toEqual({ kind: 'migration', mint: 'MintGrad1111111111111111111111111111111111', symbol: '?' });
  });

  it('sanitiza símbolo hostil na ingestão', () => {
    const event = parsePumpPortalMessage({
      mint: 'MintX',
      txType: 'create',
      symbol: 'OK\u001b[8A\u001b[0J',
    });
    expect(event!.symbol).toBe('OK[8A[0J');
  });

  it('descarta lixo e tipos desconhecidos', () => {
    expect(parsePumpPortalMessage(null)).toBeNull();
    expect(parsePumpPortalMessage('str')).toBeNull();
    expect(parsePumpPortalMessage({ txType: 'create' })).toBeNull(); // sem mint
    expect(parsePumpPortalMessage({ mint: 'M', txType: 'sell' })).toBeNull(); // trade, não evento
    expect(parsePumpPortalMessage({ message: 'Successfully subscribed' })).toBeNull();
  });
});

describe('CandidateBuffer', () => {
  it('mais novos primeiro — o teto de candidatos por tick corta o fim da lista', () => {
    let clock = 0;
    const buffer = new CandidateBuffer(90, 0, 500, () => clock);
    buffer.add({ kind: 'new', mint: 'A', symbol: 'A' });
    clock = 1_000;
    buffer.add({ kind: 'new', mint: 'B', symbol: 'B' });
    clock = 2_000;
    buffer.add({ kind: 'new', mint: 'C', symbol: 'C' });

    expect(buffer.candidates().map((c) => c.mint)).toEqual(['C', 'B', 'A']);
  });

  it('expira mints fora da janela', () => {
    let clock = 0;
    const buffer = new CandidateBuffer(90, 0, 500, () => clock);
    buffer.add({ kind: 'new', mint: 'Velho', symbol: 'V' });
    clock = 89 * 60_000;
    buffer.add({ kind: 'new', mint: 'Novo', symbol: 'N' });
    clock = 91 * 60_000; // 'Velho' passou dos 90min; 'Novo' tem 2min
    expect(buffer.candidates().map((c) => c.mint)).toEqual(['Novo']);
  });

  it('graduação rejuvenesce o mint e acumula a fonte', () => {
    let clock = 0;
    const buffer = new CandidateBuffer(90, 0, 500, () => clock);
    buffer.add({ kind: 'new', mint: 'A', symbol: 'A' });
    clock = 85 * 60_000; // quase expirando quando gradua
    buffer.add({ kind: 'migration', mint: 'A', symbol: 'A' });
    clock = 100 * 60_000; // 15min após a graduação — segue vivo
    const candidates = buffer.candidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sources).toEqual(['pp-new', 'pp-migration']);
  });

  it('respeita o teto de entradas (o mais velho sai)', () => {
    const buffer = new CandidateBuffer(90, 0, 3, () => 0);
    for (const mint of ['A', 'B', 'C', 'D']) buffer.add({ kind: 'new', mint, symbol: mint });
    expect(buffer.candidates().map((c) => c.mint)).toEqual(['D', 'C', 'B']);
  });
});

describe('CandidateBuffer — incubação', () => {
  it('mint novo só é emitido depois de incubar; graduação fura a fila', () => {
    let clock = 0;
    const buffer = new CandidateBuffer(90, 3, 500, () => clock);
    buffer.add({ kind: 'new', mint: 'Novo', symbol: 'N' });
    // Segundos de vida: ainda incubando, não aparece.
    clock = 60_000;
    expect(buffer.candidates()).toEqual([]);
    // Graduação chega no meio tempo: entra na frente, sem incubar.
    buffer.add({ kind: 'migration', mint: 'Grad', symbol: 'G' });
    expect(buffer.candidates().map((c) => c.mint)).toEqual(['Grad']);
    // Aos 3min o mint novo matura e aparece DEPOIS das graduações.
    clock = 3 * 60_000 + 1;
    expect(buffer.candidates().map((c) => c.mint)).toEqual(['Grad', 'Novo']);
  });

  it('o fluxo de ~19 mints/min não expulsa os maduros: incubando fica fora da lista', () => {
    let clock = 0;
    const buffer = new CandidateBuffer(90, 3, 500, () => clock);
    buffer.add({ kind: 'new', mint: 'Veterano', symbol: 'V' });
    clock = 5 * 60_000;
    // 60 mints recém-nascidos chegam depois.
    for (let i = 0; i < 60; i++) buffer.add({ kind: 'new', mint: 'M' + i, symbol: 'M' });
    const out = buffer.candidates();
    // Só o veterano maturou — os 60 novos estão incubando e não afogam o teto.
    expect(out.map((c) => c.mint)).toEqual(['Veterano']);
  });
});
