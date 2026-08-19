import { describe, expect, it } from 'vitest';
import { loadTraderConfig, LIVE_ACK_PHRASE, assertLiveAllowed } from '../src/config.js';

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

  it('a posição padrão é pequena — memecoin não é lugar de all-in', () => {
    expect(cfg.sizing.positionPctOfBalance).toBeLessThanOrEqual(10);
    expect(cfg.sizing.maxDailyLossSol).toBeGreaterThan(0);
  });

  it('take profit dispara antes de o trailing engolir o lucro todo', () => {
    expect(cfg.exit.takeProfitPct).toBeGreaterThan(cfg.exit.trailingStopPct);
  });

  it('WSOL e stablecoins estão fora da lista de compra', () => {
    expect(cfg.discovery.excludeMints).toContain('So11111111111111111111111111111111111111112');
    expect(cfg.discovery.excludeMints).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
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
        jupiterBaseUrl: '',
        dataDir: '',
      }),
    ).toThrow('SOLANA_PRIVATE_KEY');
  });
});
