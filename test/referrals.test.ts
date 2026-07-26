import { describe, expect, it } from 'vitest';
import { referralsFileSchema } from '../src/config/schema.js';
import { ReferralBuilder } from '../src/core/referrals.js';

const ctx = {
  token: '0x00000000000000000000000000000000000000aa',
  pool: '0x00000000000000000000000000000000000000bb',
  chainId: 5_042_002,
};

function builder(platforms: unknown[], footer?: { enabled: boolean; text: string }) {
  return new ReferralBuilder(
    referralsFileSchema.parse({ chainSlug: 'arc', platforms, ...(footer ? { footer } : {}) }),
  );
}

describe('ReferralBuilder', () => {
  it('preenche todos os placeholders do template', () => {
    const links = builder([
      {
        id: 'trade',
        label: 'Comprar',
        template: 'https://dex.example/swap?chain={chain}&id={chainId}&out={token}&pool={pool}&ref={ref}',
        ref: 'MEUCODIGO',
        enabled: true,
        kind: 'trade',
      },
    ]).build(ctx);

    expect(links[0]?.url).toBe(
      `https://dex.example/swap?chain=arc&id=5042002&out=${ctx.token}&pool=${ctx.pool}&ref=MEUCODIGO`,
    );
    expect(links[0]?.monetized).toBe(true);
  });

  it('ignora plataformas desabilitadas', () => {
    const links = builder([
      { id: 'a', label: 'A', template: 'https://x/{token}', enabled: false, kind: 'trade' },
    ]).build(ctx);
    expect(links).toHaveLength(0);
  });

  it('não publica link cujo template exige pool quando não há pool', () => {
    // Publicar isso geraria uma URL quebrada no canal.
    const links = builder([
      { id: 'chart', label: 'Chart', template: 'https://x/{chain}/pools/{pool}', enabled: true, kind: 'chart' },
    ]).build({ token: ctx.token, chainId: ctx.chainId });
    expect(links).toHaveLength(0);
  });

  it('recusa template com placeholder de exemplo não configurado', () => {
    // É melhor não publicar link nenhum do que publicar SUA-PLATAFORMA.com.
    const links = builder([
      {
        id: 'trade',
        label: 'Comprar',
        template: 'https://SUA-PLATAFORMA.com/swap?out={token}&ref={ref}',
        ref: 'X',
        enabled: true,
        kind: 'trade',
      },
    ]).build(ctx);
    expect(links).toHaveLength(0);
  });

  it('marca como não monetizado o link sem código de referral', () => {
    const links = builder([
      { id: 'exp', label: 'Explorer', template: 'https://scan/{token}', enabled: true, kind: 'explorer' },
    ]).build(ctx);
    expect(links[0]?.monetized).toBe(false);
  });

  it('não monetiza quando {ref} está no template mas o código está vazio', () => {
    const links = builder([
      { id: 'trade', label: 'Comprar', template: 'https://x/{token}?ref={ref}', ref: '', enabled: true, kind: 'trade' },
    ]).build(ctx);
    expect(links[0]?.url).toBe(`https://x/${ctx.token}?ref=`);
    expect(links[0]?.monetized).toBe(false);
  });

  it('só devolve rodapé quando habilitado e preenchido', () => {
    expect(builder([], { enabled: false, text: 'oi' }).footer()).toBeNull();
    expect(builder([], { enabled: true, text: '   ' }).footer()).toBeNull();
    expect(builder([], { enabled: true, text: 'assine' }).footer()).toBe('assine');
  });

  it('avisa no log quando um link de trade sai sem referral', () => {
    const avisos: string[] = [];
    const log = {
      warn: (a: unknown, b?: unknown) => avisos.push(String(b ?? a)),
      info: () => {},
    } as never;

    builder([
      { id: 'trade', label: 'Comprar', template: 'https://x/{token}', ref: '', enabled: true, kind: 'trade' },
    ]).audit(log);

    expect(avisos.some((m) => m.includes('SEM código de referral'))).toBe(true);
  });
});
