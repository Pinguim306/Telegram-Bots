import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AiConfig } from './config.js';
import type { Logger } from './log.js';
import type { RiskReport } from './risk.js';
import type { PairSnapshot } from './types.js';

/**
 * Segunda opinião por IA — o ÚLTIMO filtro antes de uma compra. O candidato já
 * passou nos gates quantitativos, no score de sinal e na análise de risco; o
 * que a IA acrescenta é o julgamento que números isolados não dão: o momentum
 * está começando ou já é o topo do pump? A pressão de compra parece orgânica
 * ou padrão de bot? O conjunto (idade × mcap × ritmo × distribuição) conta uma
 * história coerente?
 *
 * Regras de ouro do desenho:
 *   - FAIL-OPEN: IA indisponível (sem chave, timeout, rate limit, erro) NUNCA
 *     trava o bot — a compra segue pelos critérios quantitativos, como antes.
 *   - O veredito é ESTRUTURADO (schema forçado na API) — nada de parsear prosa.
 *   - Teto de chamadas/hora — trava de custo independente do funil.
 */

export const verdictSchema = z.object({
  decision: z.enum(['comprar', 'pular']),
  /** 0–100. Compra só prossegue se decision=comprar E confidence >= minConfidence. */
  confidence: z.number().min(0).max(100),
  /** Uma frase, em português — vai para o log e para o histórico do trade. */
  reason: z.string().max(300),
});

export type AdvisorVerdict = z.infer<typeof verdictSchema>;

/** O que o engine entrega para a IA julgar. Tudo já coletado no funil — zero rede extra. */
export interface AdvisorInput {
  snap: PairSnapshot;
  sources: string[];
  entryScore: number;
  entryReasons: string[];
  report: RiskReport;
  holderCount: number | null;
  top10Pct: number | null;
  lpLockedPct: number | null;
  curve: boolean;
}

/** Interface que o engine enxerga — o teste injeta um fake sem tocar rede. */
export interface Advisor {
  /** null = IA indisponível neste momento (fail-open — o chamador segue sem ela). */
  judge(input: AdvisorInput): Promise<AdvisorVerdict | null>;
}

/**
 * Janela deslizante de 1h — trava de custo. Exportada para teste.
 */
export class SlidingWindowLimiter {
  private calls: number[] = [];

  constructor(
    private readonly maxPerHour: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  tryAcquire(): boolean {
    const cutoff = this.now() - 3_600_000;
    this.calls = this.calls.filter((t) => t > cutoff);
    if (this.calls.length >= this.maxPerHour) return false;
    this.calls.push(this.now());
    return true;
  }
}

const SYSTEM_PROMPT = `Você é o analista final de um bot de scalp de memecoins recém-nascidas na Solana (bonding curve do pump.fun e recém-graduadas no pumpswap).

A estratégia: entrar em tokens de market cap baixo (US$ 15k–30k) com volume acelerando, alvo de +10%, stop de -12%, segurando no máximo 45 minutos. Trades pequenos, giro alto.

O candidato que você recebe JÁ passou por gates quantitativos (liquidez, volume, ritmo, idade, market cap), por um score de momentum e por uma análise de risco de rug (authorities, extensões, holders, RugCheck). Seu papel NÃO é repetir esses filtros — é julgar o que os números isolados não dizem:

1. TIMING: o momentum está NASCENDO ou você está vendo o topo de um pump? Variação de 5m muito alta com 1h achatada = chegando tarde. O erro histórico deste bot foi comprar picos e devolver no stop.
2. ORGANICIDADE: a razão compras/vendas e o padrão de volume parecem demanda real ou wash trading/bots? Volume enorme com poucos holders é suspeito.
3. COERÊNCIA: idade × market cap × volume × holders contam uma história plausível? Um token de 5 minutos com mcap de 25k e 300 holders é diferente de um com 12 holders.
4. ASSIMETRIA: no preço atual, ainda existe espaço realista para +10% antes da multidão sair?

Seja seletivo: pular custa pouco (sempre haverá outro candidato em minutos); comprar tarde custa o stop. Em dúvida real, pule com confiança baixa. Responda APENAS no formato estruturado pedido, com reason curta em português.`;

/** Monta o resumo compacto que a IA julga. Exportada para teste. */
export function buildBrief(input: AdvisorInput): string {
  const { snap, report } = input;
  const lines = {
    token: `${snap.symbol} (${snap.name})`,
    dex: snap.dexId + (input.curve ? ' [bonding curve]' : ''),
    idadeMin: snap.ageMin ?? 'desconhecida',
    marketCapUsd: snap.marketCapUsd ?? snap.fdvUsd ?? 'desconhecido',
    liquidezUsd: snap.liquidityUsd ?? 'não informada (normal na curve)',
    precoUsd: snap.priceUsd,
    volume5mUsd: snap.vol5mUsd,
    volume1hUsd: snap.vol1hUsd,
    compras5m: snap.buys5m,
    vendas5m: snap.sells5m,
    compras1h: snap.buys1h,
    vendas1h: snap.sells1h,
    variacao5mPct: snap.change5mPct,
    variacao1hPct: snap.change1hPct,
    fontesDescoberta: input.sources.join(', '),
    scoreEntrada: `${input.entryScore} (${input.entryReasons.join('; ') || 'sem regras pontuando'})`,
    scoreRisco: `${report.score}/100 (quanto menor, melhor)`,
    flagsRisco: report.flags.map((f) => `[${f.severity}] ${f.label}`).join('; ') || 'nenhuma',
    holders: input.holderCount ?? 'desconhecido',
    top10Pct: input.top10Pct ?? 'desconhecido',
    lpLockedPct: input.lpLockedPct ?? 'desconhecido',
  };
  return Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export class ClaudeAdvisor implements Advisor {
  private readonly client: Anthropic;
  private readonly limiter: SlidingWindowLimiter;

  constructor(
    private readonly cfg: AiConfig,
    apiKey: string,
    private readonly log: Logger,
  ) {
    this.client = new Anthropic({
      apiKey,
      timeout: cfg.timeoutSec * 1000,
      maxRetries: 1,
    });
    this.limiter = new SlidingWindowLimiter(cfg.maxCallsPerHour);
  }

  async judge(input: AdvisorInput): Promise<AdvisorVerdict | null> {
    if (!this.limiter.tryAcquire()) {
      this.log.warn(
        { maxCallsPerHour: this.cfg.maxCallsPerHour },
        'IA: teto de chamadas/hora atingido — seguindo sem segunda opinião',
      );
      return null;
    }
    try {
      const response = await this.client.messages.parse({
        model: this.cfg.model,
        max_tokens: 4000,
        // System estável com cache: só o brief varia entre chamadas.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        output_config: {
          effort: this.cfg.effort,
          format: zodOutputFormat(verdictSchema),
        },
        messages: [{ role: 'user', content: `Candidato a compra AGORA:\n\n${buildBrief(input)}` }],
      });
      const verdict = response.parsed_output;
      if (!verdict) {
        this.log.warn({ mint: input.snap.mint }, 'IA: resposta sem parse — seguindo sem ela');
        return null;
      }
      return verdict;
    } catch (err) {
      this.log.warn(
        { mint: input.snap.mint, err: (err as Error).message },
        'IA indisponível — seguindo sem segunda opinião',
      );
      return null;
    }
  }
}
