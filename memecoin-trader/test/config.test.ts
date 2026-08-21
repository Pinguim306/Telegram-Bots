import { describe, expect, it } from 'vitest';
import {
  loadTraderConfig,
  traderFileSchema,
  LIVE_ACK_PHRASE,
  assertLiveAllowed,
} from '../src/config.js';

/**
 * Lê o config REAL do repositório. Este teste trava valores incoerentes:
 * editar o trader.json para algo que não faz sentido quebra o build em vez de
 * quebrar a banca em silêncio.
 */
const cfg = loadTraderConfig();

describe('config/trader.json', () => {
  it('parseia no schema', () => {
    expect(cfg.loop.tickSec).toBeGreaterThanOrEqual(5);
  });

  it('o score mínimo de entrada é alcançável pelas regras', () => {
    const maxPossible = cfg.entry.rules.reduce((a, r) => a + r.points, 0);
    expect(maxPossible).toBeGreaterThanOrEqual(cfg.entry.minScore);
  });

  it('sizing é internamente consistente', () => {
    expect(cfg.sizing.minPositionSol).toBeLessThanOrEqual(cfg.sizing.maxPositionSol);
    // O caixa paper inicial precisa comportar reserva + pelo menos uma posição.
    expect(cfg.sizing.paperStartBalanceSol).toBeGreaterThanOrEqual(
      cfg.sizing.reserveSol + cfg.sizing.minPositionSol,
    );
  });

  it('a posição não vira all-in — teto de 25% do saldo por trade', () => {
    // 20% é escolha do operador (posições de ~0.2 SOL numa carteira de ~1 SOL);
    // acima de 25% uma sequência de 4 stops zera a banca — a trava fica.
    expect(cfg.sizing.positionPctOfBalance).toBeLessThanOrEqual(25);
    expect(cfg.sizing.maxDailyLossSol).toBeGreaterThan(0);
  });

  it('take profit dispara antes de o trailing engolir o lucro todo', () => {
    expect(cfg.exit.takeProfitPct).toBeGreaterThan(cfg.exit.trailingStopPct);
  });

  it('slippage de emergência é mais larga que a normal — é a razão de ela existir', () => {
    expect(cfg.execution.emergencySlippageBps).toBeGreaterThan(cfg.execution.slippageBps);
  });

  it('perfil pump.fun: curve permitida e coerente com allowedDexIds', () => {
    expect(cfg.entry.gates.allowedDexIds).toContain('pumpfun');
    expect(cfg.entry.gates.allowedDexIds).toContain('pumpswap');
    // Toda DEX de curve precisa estar na lista de permitidas, senão o flag é inútil.
    for (const dex of cfg.entry.gates.curveDexIds) {
      expect(cfg.entry.gates.allowedDexIds).toContain(dex);
    }
    expect(cfg.entry.gates.minMarketCapUsd).toBeLessThan(cfg.entry.gates.maxMarketCapUsd);
  });

  it('WSOL e stablecoins estão fora da lista de compra', () => {
    expect(cfg.discovery.excludeMints).toContain('So11111111111111111111111111111111111111112');
    expect(cfg.discovery.excludeMints).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('seções ai e dashboard são coerentes', () => {
    expect(cfg.ai.minConfidence).toBeGreaterThanOrEqual(0);
    expect(cfg.ai.minConfidence).toBeLessThanOrEqual(100);
    expect(cfg.ai.maxCallsPerHour).toBeGreaterThan(0);
    expect(cfg.dashboard.port).toBeGreaterThan(0);
  });

  it('config antigo (sem ai/dashboard) continua válido — as seções ganham default', () => {
    const raw = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
    delete raw.ai;
    delete raw.dashboard;
    const parsed = traderFileSchema.parse(raw);
    expect(parsed.ai.enabled).toBe(true);
    expect(parsed.ai.model).toBe('claude-opus-5');
    expect(parsed.dashboard.port).toBe(3877);
  });

  it('análise de holders da curve e de ligação de carteiras: coerente e com defaults', () => {
    expect(cfg.risk.curveMaxTop10Pct).toBeGreaterThan(cfg.risk.curveMaxTop1Pct);
    expect(cfg.risk.linkageTopN).toBeGreaterThanOrEqual(3);
    // Config antigo (sem os campos novos) continua válido via defaults.
    const raw = JSON.parse(JSON.stringify(cfg)) as { risk: Record<string, unknown> };
    delete raw.risk.curveMaxTop1Pct;
    delete raw.risk.curveMaxTop10Pct;
    delete raw.risk.linkageEnabled;
    delete raw.risk.linkageTopN;
    delete raw.risk.linkageSlotTolerance;
    delete raw.risk.maxSameSlotCluster;
    delete raw.risk.maxSharedFunderCluster;
    const parsed = traderFileSchema.parse(raw);
    expect(parsed.risk.linkageEnabled).toBe(true);
    expect(parsed.risk.curveMaxTop10Pct).toBe(70);
  });

  it('as travas de segurança default estão ligadas', () => {
    expect(cfg.risk.vetoFreezeAuthority).toBe(true);
    expect(cfg.risk.vetoMintAuthority).toBe(true);
    expect(cfg.risk.requireOnchain).toBe(true);
  });
});

describe('trava do modo live', () => {
  it('paper passa sem chave nem ack', () => {
    expect(() =>
      assertLiveAllowed({
        mode: 'paper',
        liveAck: false,
        rpcUrls: [],
        bscRpcUrls: [],
        chain: 'solana',
        liveDowngraded: false,
        jupiterBaseUrl: '',
        dataDir: '',
      }),
    ).not.toThrow();
  });

  it('live sem ack é recusado', () => {
    expect(() =>
      assertLiveAllowed({
        mode: 'live',
        liveAck: false,
        privateKey: 'x',
        rpcUrls: [],
        bscRpcUrls: [],
        chain: 'solana',
        liveDowngraded: false,
        jupiterBaseUrl: '',
        dataDir: '',
      }),
    ).toThrow(LIVE_ACK_PHRASE);
  });

  it('live com ack mas sem chave é recusado', () => {
    expect(() =>
      assertLiveAllowed({
        mode: 'live',
        liveAck: true,
        rpcUrls: [],
        bscRpcUrls: [],
        chain: 'solana',
        liveDowngraded: false,
        jupiterBaseUrl: '',
        dataDir: '',
      }),
    ).toThrow('SOLANA_PRIVATE_KEY');
  });
});
