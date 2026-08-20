import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { traderFileSchema, type TraderConfig } from './config.js';
import { getDailyStats, listClosedPositions, listOpenPositions, type Db } from './db.js';
import { DASHBOARD_HTML } from './dashboard-html.js';
import type { TraderEngine } from './engine.js';
import type { Logger } from './log.js';
import type { Broker } from './types.js';

/**
 * Painel web LOCAL do bot: visualização (posições, PnL, funil do tick) e
 * operação (pausar compras, vender posição, editar o config com validação).
 *
 * Segurança: escuta APENAS em 127.0.0.1 — nunca é exposto para a rede. Não
 * existe autenticação porque não existe superfície: só quem está na máquina
 * chega aqui. Nenhum segredo (.env, chave) passa por este servidor.
 */

export interface DashboardDeps {
  db: Db;
  engine: TraderEngine;
  broker: Broker;
  walletAddress: string | null;
  /** Caminho do trader.json — o PUT /api/config valida e grava aqui. */
  configPath: string;
  /** Aplica o config validado em execução (engine + broker). */
  applyConfig: (cfg: TraderConfig) => void;
  log: Logger;
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Corpo grande demais'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function createDashboardServer(deps: DashboardDeps): http.Server {
  const { db, engine, broker, log } = deps;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      log.warn({ err: err.message, url: req.url }, 'Painel: requisição falhou');
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (route === 'GET /api/overview') {
      const nowTs = Math.floor(Date.now() / 1000);
      const open = listOpenPositions(db, broker.mode);
      const closed = listClosedPositions(db, broker.mode, 30);
      sendJson(res, 200, {
        mode: broker.mode,
        wallet: deps.walletAddress,
        paused: engine.isPaused(),
        balanceSol: await broker.balanceSol().catch(() => null),
        daily: getDailyStats(db, nowTs),
        lastTick: engine.lastTick,
        open: open.map((p) => ({
          id: p.id,
          mint: p.mint,
          symbol: p.symbol,
          solSpent: p.solSpent,
          entryPriceUsd: p.entryPriceUsd,
          entryMarkPriceUsd: p.entryMarkPriceUsd,
          lastPriceUsd: p.lastPriceUsd,
          peakPriceUsd: p.peakPriceUsd,
          entryMcapUsd: p.entryMcapUsd,
          entryTs: p.entryTs,
          tookProfit: p.tookProfit,
          entryReasons: p.entryReasons,
        })),
        closed: closed.map((p) => ({
          symbol: p.symbol,
          solSpent: p.solSpent,
          pnlSol: p.pnlSol,
          pnlPct: p.pnlPct,
          exitTs: p.exitTs,
          exitReason: p.exitReason,
        })),
      });
      return;
    }

    if (route === 'POST /api/pause') {
      const body = (await readBody(req)) as { paused?: unknown };
      if (typeof body.paused !== 'boolean') {
        sendJson(res, 400, { error: 'esperado {"paused": true|false}' });
        return;
      }
      engine.setPaused(body.paused);
      sendJson(res, 200, { ok: true, paused: engine.isPaused() });
      return;
    }

    if (route === 'POST /api/sell') {
      const body = (await readBody(req)) as { mint?: unknown; pct?: unknown };
      const mint = typeof body.mint === 'string' ? body.mint : '';
      const pct = typeof body.pct === 'number' ? body.pct : 100;
      if (!mint || pct <= 0 || pct > 100) {
        sendJson(res, 400, { error: 'esperado {"mint": "...", "pct": 1-100}' });
        return;
      }
      await engine.manualSell(mint, pct);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === 'GET /api/config') {
      // Parse pelo schema para as seções novas (com default) aparecerem no
      // editor mesmo num arquivo antigo que não as tem.
      const cfg = traderFileSchema.parse(JSON.parse(readFileSync(deps.configPath, 'utf8')));
      sendJson(res, 200, cfg);
      return;
    }

    if (route === 'PUT /api/config') {
      const body = await readBody(req);
      const parsed = traderFileSchema.safeParse(body);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('\n');
        sendJson(res, 400, { error: issues });
        return;
      }
      // Grava, depois aplica — o arquivo é a fonte de verdade no próximo boot.
      writeFileSync(deps.configPath, JSON.stringify(parsed.data, null, 2) + '\n');
      deps.applyConfig(parsed.data);
      log.info('Painel: config salvo e aplicado');
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'rota desconhecida' });
  }

  return server;
}

/** Sobe o painel em 127.0.0.1:port. Resolve quando estiver escutando. */
export function startDashboard(port: number, deps: DashboardDeps): Promise<http.Server> {
  const server = createDashboardServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      deps.log.info(`Painel web: http://localhost:${port}`);
      resolve(server);
    });
  });
}
