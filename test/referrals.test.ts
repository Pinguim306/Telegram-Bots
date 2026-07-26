import { describe, expect, it } from 'vitest';
import { referralsFileSchema } from '../src/config/schema.js';
import { ReferralBuilder } from '../src/core/referrals.js';

const ctx = {
  token: '0x00000000000000000000000000000000000000aa',
  pool: '0x00000000000000000000000000000000000000bb',
  chainId: 5_042_002,
};

function builder(
  platforms: unknown[],
  footer?: { enabled: boolean; text: string },
  env: { networkKey: string; explorerUrl?: string } = {
    networkKey: 'arc-mainnet',
    explorerUrl: 'https://arcscan.app',
  },
) {
  return new ReferralBuilder(
    referralsFileSchema.parse({ chainSlug: 'arc', platforms, ...(footer ? { footer } : {}) }),
    env,
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

  it('não publica plataforma restrita a outra rede', () => {
    // GMGN só indexa mainnet; publicar em testnet daria 404 em todo alerta.
    const links = builder(
      [
        {
          id: 'gmgn_web',
          label: 'GMGN',
          template: 'https://gmgn.ai/{chain}/token/{ref}_{token}',
          ref: 'Pinguim',
          enabled: true,
          kind: 'trade',
          networks: ['arc-mainnet'],
        },
      ],
      undefined,
      { networkKey: 'arc-testnet' },
    ).build(ctx);
    expect(links).toHaveLength(0);
  });

  it('publica plataforma quando a rede ativa está na lista', () => {
    const links = builder([
      {
        id: 'gmgn_web',
        label: 'GMGN',
        template: 'https://gmgn.ai/{chain}/token/{ref}_{token}',
        ref: 'Pinguim',
        enabled: true,
        kind: 'trade',
        networks: ['arc-mainnet'],
      },
    ]).build(ctx);
    expect(links).toHaveLength(1);
    expect(links[0]?.monetized).toBe(true);
  });

  it('lista vazia de redes publica em qualquer rede', () => {
    const platform = {
      id: 'x',
      label: 'X',
      template: 'https://x/{token}',
      enabled: true,
      kind: 'other',
      networks: [],
    };
    expect(builder([platform], undefined, { networkKey: 'qualquer-rede' }).build(ctx)).toHaveLength(1);
  });

  it('resolve {explorer} a partir da rede, não do JSON de links', () => {
    // Host de explorer escrito à mão continuaria apontando para a testnet na migração.
    const links = builder(
      [{ id: 'exp', label: 'Explorer', template: '{explorer}/token/{token}', enabled: true, kind: 'explorer' }],
      undefined,
      { networkKey: 'arc-mainnet', explorerUrl: 'https://arcscan.app' },
    ).build(ctx);
    expect(links[0]?.url).toBe(`https://arcscan.app/token/${ctx.token}`);
  });

  it('omite o link quando a rede não tem explorer configurado', () => {
    const links = builder(
      [{ id: 'exp', label: 'Explorer', template: '{explorer}/token/{token}', enabled: true, kind: 'explorer' }],
      undefined,
      { networkKey: 'arc-mainnet' },
    ).build(ctx);
    expect(links).toHaveLength(0);
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
