/**
 * Página do painel web local — um arquivo só, zero dependências, embutida como
 * string para o build nunca depender de cópia de assets. Todo dado dinâmico
 * entra no DOM via textContent (nunca innerHTML) — símbolo de token é entrada
 * hostil por definição.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>memecoin-trader</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
    --dim: #8b949e; --green: #3fb950; --red: #f85149; --accent: #58a6ff;
    --amber: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0; }
  .badge { padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .badge.paper { background: #1f6feb33; color: var(--accent); }
  .badge.live { background: #f8514933; color: var(--red); }
  .badge.paused { background: #d2992233; color: var(--amber); }
  .spacer { flex: 1; }
  button { background: var(--panel); color: var(--text); border: 1px solid var(--border);
           border-radius: 6px; padding: 6px 14px; cursor: pointer; font: inherit; }
  button:hover { border-color: var(--accent); }
  button.danger { color: var(--red); }
  button.primary { background: #238636; border-color: #238636; color: #fff; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
           gap: 12px; margin-bottom: 16px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .card .label { color: var(--dim); font-size: 12px; }
  .card .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
            padding: 14px; margin-bottom: 16px; }
  section h2 { font-size: 14px; margin: 0 0 10px; color: var(--accent); }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 10px 4px 0; white-space: nowrap; }
  td { padding: 5px 10px 5px 0; border-top: 1px solid var(--border); white-space: nowrap; }
  .pos { color: var(--green); } .neg { color: var(--red); } .dim { color: var(--dim); }
  .funnel { color: var(--dim); font-size: 13px; }
  .funnel b { color: var(--text); }
  #cfgform fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 0 0 12px; padding: 10px 14px; }
  #cfgform legend { color: var(--accent); padding: 0 6px; }
  .cfgrow { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
  .cfgrow label { flex: 0 0 300px; color: var(--dim); font-size: 13px; }
  .cfgrow input[type=text], .cfgrow input[type=number] {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 8px; font: inherit; width: 100%; max-width: 420px; }
  #cfgmsg { margin: 8px 0; white-space: pre-wrap; }
  #cfgmsg.ok { color: var(--green); } #cfgmsg.err { color: var(--red); }
  .muted { color: var(--dim); font-size: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>memecoin-trader</h1>
    <span id="mode" class="badge paper">…</span>
    <span id="pausedBadge" class="badge paused" style="display:none">PAUSADO</span>
    <span id="wallet" class="muted"></span>
    <div class="spacer"></div>
    <button id="pauseBtn">…</button>
  </header>

  <div class="cards">
    <div class="card"><div class="label">Saldo</div><div class="value" id="balance">…</div></div>
    <div class="card"><div class="label">SOL/USD</div><div class="value" id="solusd">…</div></div>
    <div class="card"><div class="label">PnL hoje (UTC)</div><div class="value" id="dailyPnl">…</div></div>
    <div class="card"><div class="label">Trades hoje</div><div class="value" id="dailyTrades">…</div></div>
    <div class="card"><div class="label">Posições abertas</div><div class="value" id="openCount">…</div></div>
  </div>

  <section>
    <h2>Último tick</h2>
    <div id="funnel" class="funnel">aguardando o primeiro tick…</div>
  </section>

  <section>
    <h2>Posições abertas</h2>
    <div class="tablewrap"><table id="openTable"></table></div>
  </section>

  <section>
    <h2>Últimos trades fechados</h2>
    <div class="tablewrap"><table id="closedTable"></table></div>
  </section>

  <section>
    <h2>Configuração</h2>
    <p class="muted">Salvar aplica na hora (gates, saídas, sizing, IA, slippage). Seções
    <b>discovery.pumpportal</b> e <b>dashboard</b> só valem após reiniciar o bot.</p>
    <form id="cfgform"></form>
    <div class="toolbar">
      <button id="cfgsave" class="primary" type="button">Salvar configuração</button>
      <button id="cfgreload" type="button">Recarregar</button>
    </div>
    <div id="cfgmsg"></div>
  </section>
</div>

<script>
'use strict';
const $ = (id) => document.getElementById(id);
const fmtSol = (v) => (v == null ? '?' : Number(v).toFixed(4));
const fmtUsd = (v) => (v == null ? '?' : '$' + Math.round(Number(v)).toLocaleString('pt-BR'));
const fmtPct = (v) => (v == null ? '?' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%');
const fmtPrice = (v) => (v == null ? '?' : '$' + Number(v).toPrecision(4));
const shortMint = (m) => m.slice(0, 4) + '…' + m.slice(-4);
const ago = (ts) => {
  const min = (Date.now() / 1000 - ts) / 60;
  return min < 60 ? min.toFixed(0) + 'min' : (min / 60).toFixed(1) + 'h';
};

function cell(row, text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  row.appendChild(td);
  return td;
}

function renderTable(el, headers, rows) {
  el.replaceChildren();
  const tr = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    tr.appendChild(th);
  }
  el.appendChild(tr);
  for (const build of rows) {
    const r = document.createElement('tr');
    build(r);
    el.appendChild(r);
  }
  if (rows.length === 0) {
    const r = document.createElement('tr');
    cell(r, 'nada por aqui', 'dim');
    el.appendChild(r);
  }
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function sell(mint, pct) {
  if (!confirm('Vender ' + pct + '% de ' + shortMint(mint) + '?')) return;
  try { await api('/api/sell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mint, pct }) }); }
  catch (e) { alert('Venda falhou: ' + e.message); }
  refresh();
}

let paused = false;
async function refresh() {
  let o;
  try { o = await api('/api/overview'); } catch { return; }
  paused = o.paused;
  const mode = $('mode');
  mode.textContent = o.mode.toUpperCase();
  mode.className = 'badge ' + o.mode;
  $('pausedBadge').style.display = paused ? '' : 'none';
  $('pauseBtn').textContent = paused ? '▶ Retomar compras' : '⏸ Pausar compras';
  $('wallet').textContent = o.wallet ? shortMint(o.wallet) : '';
  $('balance').textContent = fmtSol(o.balanceSol) + ' SOL';
  $('solusd').textContent = o.lastTick ? fmtUsd(o.lastTick.solUsd) : '?';
  const pnl = $('dailyPnl');
  pnl.textContent = fmtSol(o.daily.realizedPnlSol) + ' SOL';
  pnl.className = 'value ' + (o.daily.realizedPnlSol >= 0 ? 'pos' : 'neg');
  $('dailyTrades').textContent = o.daily.trades + ' (' + o.daily.wins + 'W/' + o.daily.losses + 'L)';
  $('openCount').textContent = o.open.length;

  const f = $('funnel');
  if (o.lastTick) {
    const t = o.lastTick;
    f.replaceChildren();
    const strong = (txt) => { const b = document.createElement('b'); b.textContent = txt; return b; };
    const time = new Date(t.ts * 1000).toLocaleTimeString('pt-BR');
    if (t.blocked) {
      f.append(time + ' — sem novas entradas: ');
      f.append(strong(t.blocked));
    } else {
      f.append(time + ' — candidatos ', strong(t.candidates), ' → com par ', strong(t.withPair),
        ' → aptos ', strong(t.eligible), ' → analisados ', strong(t.analyzed), ' → compras ', strong(t.bought));
      const gates = Object.entries(t.gateTally || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (gates.length) f.append(' · gates: ' + gates.map(([k, v]) => k + '=' + v).join(', '));
    }
  }

  renderTable($('openTable'),
    ['Token', 'Mint', 'Gasto', 'Baseline', 'Preço atual', 'PnL', 'MC entr.', 'Tempo', 'IA/motivos', ''],
    o.open.map((p) => (r) => {
      const base = p.entryMarkPriceUsd ?? p.entryPriceUsd;
      const pnlPct = base > 0 ? (p.lastPriceUsd / base - 1) * 100 : null;
      cell(r, p.symbol);
      cell(r, shortMint(p.mint), 'dim');
      cell(r, fmtSol(p.solSpent));
      cell(r, fmtPrice(base) + (p.entryMarkPriceUsd == null ? ' (tela)' : ''));
      cell(r, fmtPrice(p.lastPriceUsd));
      cell(r, fmtPct(pnlPct), pnlPct != null && pnlPct >= 0 ? 'pos' : 'neg');
      cell(r, fmtUsd(p.entryMcapUsd));
      cell(r, ago(p.entryTs), 'dim');
      const motivo = cell(r, p.entryReasons || '', 'dim');
      motivo.style.whiteSpace = 'normal'; motivo.style.minWidth = '180px';
      const td = document.createElement('td');
      for (const pct of [50, 100]) {
        const b = document.createElement('button');
        b.className = 'danger';
        b.textContent = 'Vender ' + pct + '%';
        b.onclick = () => sell(p.mint, pct);
        td.appendChild(b);
        td.appendChild(document.createTextNode(' '));
      }
      r.appendChild(td);
    }));

  renderTable($('closedTable'),
    ['Saída', 'Token', 'Gasto', 'PnL SOL', 'PnL %', 'Motivo'],
    o.closed.map((p) => (r) => {
      cell(r, p.exitTs ? new Date(p.exitTs * 1000).toLocaleString('pt-BR') : '?', 'dim');
      cell(r, p.symbol);
      cell(r, fmtSol(p.solSpent));
      cell(r, fmtSol(p.pnlSol), (p.pnlSol ?? 0) >= 0 ? 'pos' : 'neg');
      cell(r, fmtPct(p.pnlPct), (p.pnlPct ?? 0) >= 0 ? 'pos' : 'neg');
      const m = cell(r, p.exitReason || '?', 'dim');
      m.style.whiteSpace = 'normal';
    }));
}

$('pauseBtn').onclick = async () => {
  try { await api('/api/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: !paused }) }); }
  catch (e) { alert(e.message); }
  refresh();
};

// ── Editor de configuração ──────────────────────────────────
// Achata o JSON em caminhos (entry.gates.minLiquidityUsd) e gera um input por
// folha. Arrays viram JSON numa linha. Reconstrói o objeto no salvar.
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$comment') continue;
    const path = prefix ? prefix + '.' + k : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out.push([path, v]);
  }
  return out;
}

function renderConfig(cfg) {
  const form = $('cfgform');
  form.replaceChildren();
  const bySection = new Map();
  for (const [path, value] of flatten(cfg, '', [])) {
    const section = path.split('.')[0];
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push([path, value]);
  }
  for (const [section, fields] of bySection) {
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend');
    lg.textContent = section;
    fs.appendChild(lg);
    for (const [path, value] of fields) {
      const row = document.createElement('div');
      row.className = 'cfgrow';
      const label = document.createElement('label');
      label.textContent = path.slice(section.length + 1) || path;
      row.appendChild(label);
      const input = document.createElement('input');
      input.dataset.path = path;
      if (typeof value === 'boolean') {
        input.type = 'checkbox';
        input.checked = value;
        input.dataset.kind = 'boolean';
      } else if (typeof value === 'number') {
        input.type = 'number';
        input.step = 'any';
        input.value = String(value);
        input.dataset.kind = 'number';
      } else if (Array.isArray(value)) {
        input.type = 'text';
        input.value = JSON.stringify(value);
        input.dataset.kind = 'json';
      } else {
        input.type = 'text';
        input.value = String(value);
        input.dataset.kind = 'string';
      }
      row.appendChild(input);
      fs.appendChild(row);
    }
    form.appendChild(fs);
  }
}

function collectConfig() {
  const cfg = {};
  for (const input of $('cfgform').querySelectorAll('input')) {
    const parts = input.dataset.path.split('.');
    let node = cfg;
    for (const p of parts.slice(0, -1)) node = node[p] ?? (node[p] = {});
    const leaf = parts[parts.length - 1];
    if (input.dataset.kind === 'boolean') node[leaf] = input.checked;
    else if (input.dataset.kind === 'number') node[leaf] = Number(input.value);
    else if (input.dataset.kind === 'json') node[leaf] = JSON.parse(input.value);
    else node[leaf] = input.value;
  }
  return cfg;
}

async function loadConfig() {
  try { renderConfig(await api('/api/config')); }
  catch (e) { $('cfgmsg').textContent = 'Falha ao carregar config: ' + e.message; $('cfgmsg').className = 'err'; }
}

$('cfgsave').onclick = async () => {
  const msg = $('cfgmsg');
  let cfg;
  try { cfg = collectConfig(); }
  catch (e) { msg.textContent = 'Campo com JSON inválido: ' + e.message; msg.className = 'err'; return; }
  try {
    await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
    msg.textContent = 'Salvo e aplicado. (pumpportal/dashboard valem no próximo boot)';
    msg.className = 'ok';
  } catch (e) {
    msg.textContent = 'Config recusado:\\n' + e.message;
    msg.className = 'err';
  }
};
$('cfgreload').onclick = loadConfig;

refresh();
loadConfig();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
