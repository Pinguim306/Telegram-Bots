/**
 * Formatação para o terminal. Tudo puro (sem I/O) — é a parte que mais quebra
 * na prática (preço com 10 zeros à esquerda, supply gigante) e a mais barata
 * de testar.
 */

/** Abrevia um valor em USD: 1234 -> "$1.23K", 67300 -> "$67.3K". */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return '$?';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${price(abs)}`;
}

function trim(n: number): string {
  const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.?0+$/, '');
}

/**
 * Preço de token, que em memecoin é quase sempre minúsculo. Mantém 4 algarismos
 * significativos em vez de casas fixas — senão 0.0000006 vira "0.00".
 */
export function price(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1) return value.toFixed(Math.min(4, Math.max(2, 6 - Math.floor(Math.log10(value)))));
  const exp = Math.floor(Math.log10(value));
  const decimals = Math.min(18, -exp + 3);
  return value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** Variação percentual com sinal: 104.2 -> "+104%". */
export function pct(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '?';
  const sign = value > 0 ? '+' : '';
  const abs = Math.abs(value);
  const d = abs < 10 && decimals === 0 ? 1 : decimals;
  return `${sign}${value.toFixed(d)}%`;
}

/** Quantidade de SOL com precisão útil: 0.05 -> "0.0500", 12.3456789 -> "12.346". */
export function sol(value: number): string {
  if (!Number.isFinite(value)) return '?';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

/**
 * Nome/símbolo de token é conteúdo HOSTIL: qualquer um minta um token cujo nome
 * carrega escapes ANSI (reescrevem a tela do terminal por cima do veredito de
 * risco), marcas bidirecionais ou 300 chars de lixo. Remove todos os code
 * points de controle/formato e limita o tamanho — aplicado na fronteira de
 * ingestão (datasources), antes de logar, gravar ou imprimir.
 */
export function cleanLabel(text: string, maxLen = 32): string {
  const cleaned = [...text.replace(/\p{C}/gu, '')].slice(0, maxLen).join('').trim();
  return cleaned || '?';
}

/** Endereço encurtado: So1111..1112. */
export function shortAddr(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}..${address.slice(-tail)}`;
}

/** Idade legível a partir de minutos: 53 -> "53m", 90 -> "1h 30m", 2900 -> "2d 0h". */
export function ageMin(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return '?';
  const m = Math.floor(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Alinha colunas de uma tabela simples de terminal. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return '';
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const line = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  const out: string[] = [];
  if (header) {
    out.push(line(header));
    out.push(widths.map((w) => '─'.repeat(w)).join('──'));
  }
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}
