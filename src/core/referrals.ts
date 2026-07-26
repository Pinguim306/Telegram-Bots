import type { ReferralPlatform, ReferralsConfig } from '../config/schema.js';
import type { Logger } from './logger.js';

export interface LinkContext {
  token: string;
  pool?: string;
  chainId: number;
}

export interface BuiltLink {
  label: string;
  url: string;
  kind: ReferralPlatform['kind'];
  /** true quando o link carrega o seu código de referral */
  monetized: boolean;
}

/**
 * Constrói a linha de links de cada alerta.
 *
 * Esta é a camada que gera receita: todo alerta publicado é uma impressão, e cada
 * clique num link `kind: "trade"` com `ref` preenchido é uma comissão. Por isso
 * nada aqui é hardcoded — trocar de plataforma ou de código é editar um JSON.
 */
export interface ReferralEnv {
  /** Chave da rede ativa (ex: arc-mainnet) — decide quais plataformas publicam. */
  networkKey: string;
  /** Base do explorer da rede ativa, para o placeholder {explorer}. */
  explorerUrl?: string;
}

export class ReferralBuilder {
  constructor(
    private readonly config: ReferralsConfig,
    private readonly env: ReferralEnv,
  ) {}

  /** A plataforma publica na rede ativa? Lista vazia = publica em todas. */
  private appliesHere(platform: ReferralPlatform): boolean {
    return platform.networks.length === 0 || platform.networks.includes(this.env.networkKey);
  }

  build(ctx: LinkContext): BuiltLink[] {
    const links: BuiltLink[] = [];
    for (const platform of this.config.platforms) {
      if (!platform.enabled) continue;
      if (!this.appliesHere(platform)) continue;
      // Template que exige pool não pode ser publicado sem pool: viraria URL quebrada.
      if (platform.template.includes('{pool}') && !ctx.pool) continue;

      const url = this.render(platform, ctx);
      if (!url) continue;
      links.push({
        label: platform.label,
        url,
        kind: platform.kind,
        monetized: platform.ref.trim() !== '' && platform.template.includes('{ref}'),
      });
    }
    return links;
  }

  private render(platform: ReferralPlatform, ctx: LinkContext): string | null {
    // {explorer} sai da config da rede, não do JSON de links: um host de explorer
    // escrito à mão aqui apontaria para a testnet depois da migração para a mainnet.
    if (platform.template.includes('{explorer}') && !this.env.explorerUrl) return null;

    const url = platform.template
      .replaceAll('{token}', ctx.token)
      .replaceAll('{pool}', ctx.pool ?? '')
      .replaceAll('{chainId}', String(ctx.chainId))
      .replaceAll('{chain}', this.config.chainSlug)
      .replaceAll('{explorer}', this.env.explorerUrl ?? '')
      .replaceAll('{ref}', platform.ref);

    if (url.includes('{') || url.includes('SUA-PLATAFORMA') || url.includes('SEU_TRADING_BOT')) {
      // Sobrou placeholder: a plataforma foi habilitada sem ser configurada.
      return null;
    }
    return url;
  }

  footer(): string | null {
    return this.config.footer.enabled && this.config.footer.text.trim() !== ''
      ? this.config.footer.text
      : null;
  }

  /**
   * Diagnóstico de boot. Publicar alerta com link de trade SEM ref é o pior caso
   * possível: você entrega o volume e não recebe a comissão. Isso precisa gritar no log.
   */
  audit(log: Logger): void {
    const enabled = this.config.platforms.filter((p) => p.enabled);
    if (enabled.length === 0) {
      log.warn('Nenhuma plataforma de link habilitada — os alertas sairão sem links.');
      return;
    }

    // Plataforma habilitada porém restrita a outra rede é a pegadinha mais provável:
    // o usuário configura o referral, não vê link nenhum no alerta e acha que quebrou.
    const gated = enabled.filter((p) => !this.appliesHere(p));
    for (const platform of gated) {
      log.info(
        { platform: platform.id, redes: platform.networks, redeAtual: this.env.networkKey },
        'plataforma configurada mas restrita a outra rede — não publica aqui',
      );
    }

    const active = enabled.filter((p) => this.appliesHere(p));
    if (active.length === 0) {
      log.warn(
        { redeAtual: this.env.networkKey },
        'nenhuma plataforma publica nesta rede — os alertas sairão só com o explorer',
      );
    }

    for (const platform of active) {
      if (!platform.verified) {
        log.warn(
          { platform: platform.id },
          'plataforma habilitada mas marcada como NÃO VERIFICADA — confirme o formato da URL antes de publicar em produção',
        );
      }
      if (platform.kind === 'trade' && platform.ref.trim() === '') {
        log.warn(
          { platform: platform.id },
          'link de trade SEM código de referral — você está entregando volume de graça',
        );
      }
      if (platform.template.includes('{ref}') && platform.ref.trim() === '') {
        log.warn({ platform: platform.id }, 'template usa {ref} mas o código está vazio');
      }
    }

    const monetized = active.filter((p) => p.ref.trim() !== '').length;
    log.info(
      {
        rede: this.env.networkKey,
        ativas: active.length,
        monetizadas: monetized,
        restritasAOutraRede: gated.length,
      },
      'plataformas de link carregadas',
    );
  }
}
