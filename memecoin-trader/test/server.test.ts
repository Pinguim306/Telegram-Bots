import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/brokers.js';
import { loadTraderConfig, type TraderConfig } from '../src/config.js';
import { openTraderDb, type Db } from '../src/db.js';
import { TraderEngine, type Sources } from '../src/engine.js';
import { startDashboard } from '../src/server.js';
import type {
  ChainAdapter,
  HolderStats,
  OnchainTokenInfo,
  PairSnapshot,
  RugcheckSummary,
} from '../src/types.js';

/**
 * Teste de integração do painel: servidor HTTP real numa porta efêmera de
 * 127.0.0.1, banco SQLite real em diretório temporário, engine real com
 * fontes falsas. O que se testa é o CONTRATO da API que a página consome.
 */

const cfg = loadTraderConfig();
const log = pino({ level: 'silent' });

class FakeChain implements ChainAdapter {
  readonly key = 'solana' as const;
  walletAddress(): string | null {
    return 'Wallet111111111111111111111111111111111111';
  }
  async nativeBalanceSol(): Promise<number> {
    return 0;
  }
  async getOnchainTokenInfo(): Promise<OnchainTokenInfo | null> {
    return null;
  }
  async getTopHolders(): Promise<HolderStats | null> {
    return null;
  }
  async tokenBalanceUi(): Promise<number> {
    return 0;
  }
}

const emptySources: Sources = {
  pumpportal: async () => [],
  trending: async () => [],
  newPools: async () => [],
  boosts: async () => [],
  pairs: async () => new Map<string, PairSnapshot>(),
  rugcheck: async (): Promise<RugcheckSummary> => ({ available: false, reason: 'teste' }),
  solPriceUsd: async () => 200,
};

let dir: string;
let db: Db;
let server: http.Server;
let base: string;
let configPath: string;
let applied: TraderConfig | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'trader-server-'));
  db = openTraderDb(dir);
  configPath = join(dir, 'trader.json');
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  applied = null;

  const broker = new PaperBroker(db, cfg.execution, cfg.sizing);
  const engine = new TraderEngine(cfg, db, broker, new FakeChain(), emptySources, log);
  server = await startDashboard(0, {
    db,
    engine,
    broker,
    walletAddress: 'Wallet111111111111111111111111111111111111',
    configPath,
    applyConfig: (c) => {
      applied = c;
      engine.updateConfig(c);
    },
    log,
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('painel web', () => {
  it('serve a página e o overview com o formato que a página consome', async () => {
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('memecoin-trader');

    const res = await fetch(base + '/api/overview');
    expect(res.status).toBe(200);
    const o = (await res.json()) as Record<string, unknown>;
    expect(o.mode).toBe('paper');
    expect(o.paused).toBe(false);
    expect(o.balanceSol).toBe(cfg.sizing.paperStartBalanceSol);
    expect(Array.isArray(o.open)).toBe(true);
    expect(Array.isArray(o.closed)).toBe(true);
  });

  it('pausa e retoma pelo POST /api/pause', async () => {
    const post = (paused: boolean) =>
      fetch(base + '/api/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
    expect((await post(true)).status).toBe(200);
    const o = (await (await fetch(base + '/api/overview')).json()) as { paused: boolean };
    expect(o.paused).toBe(true);
    expect((await post(false)).status).toBe(200);

    const bad = await fetch(base + '/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: 'sim' }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET /api/config devolve o config com as seções novas preenchidas', async () => {
    const res = await fetch(base + '/api/config');
    const c = (await res.json()) as TraderConfig;
    expect(c.ai.model).toBe(cfg.ai.model);
    expect(c.dashboard.port).toBe(cfg.dashboard.port);
  });

  it('PUT /api/config recusa config inválido com os erros do schema — e nada é gravado', async () => {
    const before = readFileSync(configPath, 'utf8');
    const broken = structuredClone(cfg) as Record<string, unknown>;
    (broken.exit as Record<string, unknown>).stopLossPct = -5;
    const res = await fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(broken),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('stopLossPct');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(applied).toBeNull();
  });

  it('PUT /api/config válido grava o arquivo e aplica em execução', async () => {
    const next = structuredClone(cfg);
    next.exit.takeProfitPct = 14;
    const res = await fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    expect(res.status).toBe(200);
    expect(applied).not.toBeNull();
    expect(applied!.exit.takeProfitPct).toBe(14);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as TraderConfig;
    expect(onDisk.exit.takeProfitPct).toBe(14);
  });

  it('POST /api/sell sem posição aberta devolve erro legível (não 500 mudo)', async () => {
    const res = await fetch(base + '/api/sell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mint: 'MintInexistente', pct: 100 }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Nenhuma posição aberta');
  });
});
