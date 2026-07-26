import type { Db } from './db.js';

/** Histórico durável de alertas: sustenta cooldown e teto por hora entre reinícios. */

export function recordAlert(db: Db, kind: string, subject: string, score = 0): void {
  db.prepare('INSERT INTO alerts (kind, subject, score, ts) VALUES (?, ?, ?, ?)').run(
    kind,
    subject,
    score,
    Math.floor(Date.now() / 1000),
  );
}

export function alertsSince(db: Db, kind: string, sinceSec: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM alerts WHERE kind = ? AND ts >= ?')
    .get(kind, Math.floor(Date.now() / 1000) - sinceSec) as { n: number };
  return row.n;
}

export function lastAlertFor(
  db: Db,
  kind: string,
  subject: string,
): { ts: number; score: number } | null {
  const row = db
    .prepare('SELECT ts, score FROM alerts WHERE kind = ? AND subject = ? ORDER BY ts DESC LIMIT 1')
    .get(kind, subject) as { ts: number; score: number } | undefined;
  return row ?? null;
}

/**
 * Teto de alertas por hora.
 *
 * Não é sobre custo de API — é sobre retenção: canal que dispara 200 alertas por
 * hora é mutado no primeiro dia, e canal mutado não gera clique nem comissão.
 */
export function underHourlyCap(db: Db, kind: string, maxPerHour: number): boolean {
  return alertsSince(db, kind, 3_600) < maxPerHour;
}
