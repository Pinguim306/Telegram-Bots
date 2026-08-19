import type { RiskConfig } from './config.js';
import type { HolderStats, OnchainTokenInfo, RugcheckSummary } from './types.js';

/**
 * Motor de risco — puro, sem I/O. Recebe o que as fontes conseguiram levantar
 * e devolve um veredito.
 *
 * Duas camadas, de propósito:
 *   - VETO: condições binárias inegociáveis (freeze authority ativa = o dono
 *     pode congelar sua conta e você nunca mais vende). Nenhum score compensa.
 *   - SCORE 0–100: acúmulo de sinais ruins menores. Acima de `maxScore`, rejeita.
 *
 * Princípio: dado FALTANDO nunca é dado BOM. Não conseguir ler o mint account
 * pontua contra o token (ou rejeita, com requireOnchain) — a alternativa seria
 * comprar às cegas exatamente os tokens mais suspeitos.
 */

export interface RiskInput {
  onchain: OnchainTokenInfo | null;
  holders: HolderStats | null;
  rugcheck: RugcheckSummary;
}

export interface RiskFlag {
  id: string;
  severity: 'veto' | 'high' | 'medium' | 'low';
  label: string;
}

export interface RiskReport {
  /** 0 = limpo, 100 = fuja. */
  score: number;
  verdict: 'approved' | 'rejected' | 'vetoed';
  flags: RiskFlag[];
}

export function assessRisk(input: RiskInput, cfg: RiskConfig): RiskReport {
  const flags: RiskFlag[] = [];
  let score = 0;
  let vetoed = false;

  const add = (id: string, severity: RiskFlag['severity'], label: string, points: number) => {
    flags.push({ id, severity, label });
    if (severity === 'veto') vetoed = true;
    else score += points;
  };

  // ── on-chain ────────────────────────────────────────────────
  const { onchain } = input;
  if (!onchain) {
    if (cfg.requireOnchain) {
      add('onchain_missing', 'veto', 'Não consegui ler o mint account on-chain', 0);
    } else {
      add('onchain_missing', 'high', 'Dados on-chain indisponíveis', 25);
    }
  } else {
    if (onchain.freezeAuthorityActive) {
      if (cfg.vetoFreezeAuthority) {
        add('freeze_authority', 'veto', 'Freeze authority ativa — o dono pode congelar holders', 0);
      } else {
        add('freeze_authority', 'high', 'Freeze authority ativa', 40);
      }
    }
    if (onchain.mintAuthorityActive) {
      if (cfg.vetoMintAuthority) {
        add('mint_authority', 'veto', 'Mint authority ativa — supply pode ser inflado', 0);
      } else {
        add('mint_authority', 'high', 'Mint authority ativa', 30);
      }
    }
    // Token-2022 por si só não é suspeito (o pump.fun minta nele desde 2025) —
    // o que condena são as extensões que travam, confiscam ou taxam o holder.
    if (onchain.dangerousExtensions.length > 0) {
      add(
        'dangerous_extension',
        'veto',
        `Extensões honeypot do Token-2022: ${onchain.dangerousExtensions.join(', ')}`,
        0,
      );
    }
    if (onchain.taxingExtensions.length > 0) {
      add(
        'taxing_extension',
        'high',
        `Token com taxa/juros embutidos: ${onchain.taxingExtensions.join(', ')}`,
        20,
      );
    }
    if (onchain.token2022 && cfg.vetoToken2022) {
      add('token_2022', 'veto', 'Token-2022 vetado pelo config', 0);
    }
  }

  // ── holders ─────────────────────────────────────────────────
  // Preferência: dado do RugCheck (exclui vaults de AMM) > leitura crua do RPC.
  const rug = input.rugcheck;
  const rugTop10 = rug.available ? rug.top10Pct : null;
  const top10 = rugTop10 ?? input.holders?.top10Pct ?? null;
  const top1 = rugTop10 !== null ? null : (input.holders?.top1Pct ?? null);

  if (top10 === null) {
    add('holders_missing', 'medium', 'Distribuição de holders indisponível', 10);
  } else {
    if (top10 > cfg.maxTop10Pct) {
      // Escala com o excesso: 55% concentrado é ruim, 85% é outra categoria de
      // ruim — e concentração extrema tem que rejeitar sozinha.
      const points = Math.min(45, 25 + (top10 - cfg.maxTop10Pct));
      add('top10_concentrated', 'high', `Top 10 holders com ${top10.toFixed(1)}% do supply`, points);
    } else if (top10 > cfg.maxTop10Pct * 0.75) {
      add('top10_elevated', 'low', `Top 10 holders com ${top10.toFixed(1)}% do supply`, 8);
    }
  }
  if (top1 !== null && top1 > cfg.maxTop1Pct) {
    const points = Math.min(35, 20 + (top1 - cfg.maxTop1Pct));
    add('top1_concentrated', 'high', `Maior holder com ${top1.toFixed(1)}% do supply`, points);
  }

  const holderCount = (rug.available ? rug.holderCount : null) ?? input.holders?.holderCount ?? null;
  if (holderCount !== null && holderCount < cfg.minHolderCount) {
    add('few_holders', 'medium', `Só ${holderCount} holders`, 12);
  }

  // ── RugCheck ────────────────────────────────────────────────
  if (!rug.available) {
    if (cfg.requireRugcheck) {
      add('rugcheck_missing', 'veto', `RugCheck indisponível (${rug.reason})`, 0);
    } else {
      add('rugcheck_missing', 'medium', 'RugCheck indisponível — análise só on-chain', 10);
    }
  } else {
    if (rug.rugged) {
      add('rugged', 'veto', 'RugCheck já marcou este token como RUGGED', 0);
    }
    if (rug.dangerFlags.length > 0) {
      const label = `RugCheck danger: ${rug.dangerFlags.join(', ')}`;
      if (cfg.vetoRugcheckDanger) add('rugcheck_danger', 'veto', label, 0);
      else add('rugcheck_danger', 'high', label, Math.min(40, rug.dangerFlags.length * 20));
    }
    // Flags danger de LP pontuam pouco: o sinal real de LP já está em
    // lpLockedPct, e essas flags disparam até em token com liquidez CLMM.
    if (rug.lpDangerFlags.length > 0) {
      add(
        'rugcheck_lp_danger',
        'low',
        `RugCheck LP: ${rug.lpDangerFlags.slice(0, 3).join(', ')}`,
        Math.min(12, rug.lpDangerFlags.length * 6),
      );
    }
    if (rug.warnFlags.length > 0) {
      add(
        'rugcheck_warn',
        'low',
        `RugCheck warn: ${rug.warnFlags.slice(0, 4).join(', ')}`,
        Math.min(15, rug.warnFlags.length * 5),
      );
    }
    if (rug.scoreNormalized !== null && rug.scoreNormalized > cfg.maxRugcheckScore) {
      add('rugcheck_score', 'high', `Score RugCheck ${rug.scoreNormalized.toFixed(0)}/100`, 20);
    }
    if (rug.lpLockedPct !== null && rug.lpLockedPct < cfg.minLpLockedPct) {
      add('lp_unlocked', 'medium', `Só ${rug.lpLockedPct.toFixed(0)}% da LP travada/queimada`, 12);
    }
  }

  score = Math.min(100, Math.round(score));
  const verdict = vetoed ? 'vetoed' : score > cfg.maxScore ? 'rejected' : 'approved';
  return { score, verdict, flags };
}
