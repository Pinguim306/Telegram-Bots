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
export class ReferralBuilder {
  constructor(private readonly config: ReferralsConfig) {}

  build(ctx: LinkContext): BuiltLink[] {
    const links: BuiltLink[] = [];
    for (const platform of this.config.platforms) {
      if (!platform.enabled) continue;
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
    const url = platform.template
      .replaceAll('{token}', ctx.token)
      .replaceAll('{pool}', ctx.pool ?? '')
      .replaceAll('{chainId}', String(ctx.chainId))
      .replaceAll('{chain}', this.config.chainSlug)
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

    for (const platform of enabled) {
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

    const monetized = enabled.filter((p) => p.ref.trim() !== '').length;
    log.info(
      { habilitadas: enabled.length, monetizadas: monetized },
      'plataformas de link carregadas',
    );
  }
}
