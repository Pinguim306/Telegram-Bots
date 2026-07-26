import { Bot } from 'grammy';
import { erc20Abi, type Address } from 'viem';
import {
  loadDexConfig,
  loadLaunchesConfig,
  loadNetwork,
  loadReferrals,
  loadRuntimeEnv,
  loadSignalsConfig,
  loadTelegramEnv,
} from '../config/load.js';
import { ChainClient } from '../core/chain.js';
import { TOPIC, ZERO_TOPIC, decodePoolCreation } from '../core/events.js';
import { ReferralBuilder } from '../core/referrals.js';

/**
 * Diagnóstico antes de subir os bots.
 *
 * Faz o que dá para verificar de verdade contra o RPC: chain id bate com o
 * configurado, blocos avançam, multicall3 existe, cada tipo de evento aparece,
 * quais factories estão ativas, e se o token de quote é mesmo um ERC-20.
 * É o teste que separa "configurei" de "funciona".
 */

const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const fail = (msg: string) => console.log(`  ❌ ${msg}`);
const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

let problems = 0;

async function main(): Promise<void> {
  section('Configuração');
  const network = loadNetwork();
  const env = loadRuntimeEnv();
  ok(`rede: ${network.name} (chainId ${network.chainId})`);
  ok(`RPC: ${network.rpcUrls.join(', ')}`);
  ok(`explorer: ${network.explorerUrl ?? '(não configurado)'}`);
  ok(`DRY_RUN: ${env.dryRun}`);
  if (env.dryRun) warn('DRY_RUN ativo — nada será publicado no Telegram');

  loadLaunchesConfig();
  const signals = loadSignalsConfig();
  const dex = loadDexConfig();
  ok('todos os arquivos de config/ são válidos');

  const chain = new ChainClient(network);

  section('Conectividade');
  let head: bigint;
  try {
    const chainId = await chain.client.getChainId();
    if (chainId !== network.chainId) {
      fail(`chainId do RPC (${chainId}) diferente do configurado (${network.chainId})`);
      problems += 1;
    } else {
      ok(`chainId confere: ${chainId}`);
    }
    head = await chain.getBlockNumber();
    ok(`bloco atual: ${head}`);
  } catch (err) {
    fail(`não consegui falar com o RPC: ${String(err)}`);
    process.exit(1);
  }

  const [t0, t1] = await Promise.all([
    chain.getBlockTimestamp(head - 200n),
    chain.getBlockTimestamp(head),
  ]);
  const blockTime = (t1 - t0) / 200;
  ok(`tempo de bloco medido: ${blockTime.toFixed(2)}s (configurado: ${network.blockTimeMs / 1000}s)`);
  if (Math.abs(blockTime * 1000 - network.blockTimeMs) > network.blockTimeMs) {
    warn('blockTimeMs em networks.json está longe do medido — ajuste o intervalo de polling');
  }

  section('Multicall3');
  if (!network.multicall3) {
    warn('multicall3 não configurado — leituras de token vão uma a uma (mais lento)');
  } else {
    const code = await chain.getCode(network.multicall3);
    if (code && code !== '0x') ok(`multicall3 presente em ${network.multicall3}`);
    else {
      warn(`multicall3 NÃO existe em ${network.multicall3} — removendo o campo o bot usa fallback`);
    }
  }

  section('Tokens de quote');
  if (network.quoteTokens.length === 0) {
    fail('nenhum token de quote configurado — sem isso nenhum preço em USD é calculável');
    problems += 1;
  }
  for (const quote of network.quoteTokens) {
    const res = await chain.multicall([
      { address: quote.address, abi: erc20Abi, functionName: 'symbol' },
      { address: quote.address, abi: erc20Abi, functionName: 'decimals' },
    ]);
    const symbol = res[0]?.status === 'success' ? String(res[0].result) : null;
    const decimals = res[1]?.status === 'success' ? Number(res[1].result) : null;
    if (symbol === null || decimals === null) {
      fail(`${quote.address} não responde como ERC-20`);
      problems += 1;
      continue;
    }
    if (decimals !== quote.decimals) {
      fail(`${symbol}: decimals on-chain é ${decimals}, config diz ${quote.decimals} — preço sairia errado por 10^${Math.abs(decimals - quote.decimals)}`);
      problems += 1;
    } else {
      ok(`${symbol} (${quote.address}) — ${decimals} decimals`);
    }
  }

  section('Atividade on-chain (últimos ~2000 blocos)');
  const from = head > 2000n ? head - 2000n : 0n;
  const [creations, swapsV2, swapsV3, mints] = await Promise.all([
    chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.pairCreated, TOPIC.poolCreated]] }),
    chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.v2Swap]] }),
    chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.v3Swap]] }),
    chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.transfer], [ZERO_TOPIC]] }),
  ]);

  report('criações de pool', creations.length);
  report('swaps V2', swapsV2.length);
  report('swaps V3', swapsV3.length);
  report('mints (tokens novos)', mints.length);

  if (creations.length === 0 && swapsV2.length + swapsV3.length === 0) {
    warn('nenhuma atividade de DEX nesta janela — normal em rede recém-lançada, mas confirme antes de calibrar thresholds');
  }

  const factories = new Map<string, number>();
  for (const log of [...creations, ...swapsV2, ...swapsV3]) {
    const decoded = decodePoolCreation(log);
    const key = decoded ? decoded.factory : null;
    if (key) factories.set(key, (factories.get(key) ?? 0) + 1);
  }
  if (factories.size > 0) {
    section('Factories detectadas');
    for (const [address, count] of [...factories].sort((a, b) => b[1] - a[1])) {
      const label = dex.factoryLabels[address as Address];
      ok(`${address} — ${count} pools${label ? ` (${label})` : ' (sem rótulo em config/dex.json)'}`);
    }
  }

  section('Monetização');
  const referrals = new ReferralBuilder(loadReferrals());
  const sample = referrals.build({
    token: '0x0000000000000000000000000000000000000dead',
    pool: '0x000000000000000000000000000000000000beef',
    chainId: network.chainId,
  });
  if (sample.length === 0) {
    warn('nenhum link seria publicado — habilite ao menos uma plataforma em config/referrals.json');
  }
  for (const link of sample) {
    if (link.monetized) ok(`${link.label} (com referral): ${link.url}`);
    else warn(`${link.label} SEM referral: ${link.url}`);
  }
  const monetized = sample.filter((l) => l.monetized).length;
  if (sample.length > 0 && monetized === 0) {
    warn('nenhum link carrega código de referral — os alertas não vão gerar receita');
  }

  section('Telegram');
  for (const bot of ['LAUNCHES', 'SIGNALS'] as const) {
    const tg = loadTelegramEnv(bot);
    if (!tg.token) {
      warn(`${bot}: sem token configurado`);
      continue;
    }
    try {
      const me = await new Bot(tg.token).api.getMe();
      ok(`${bot}: conectado como @${me.username}`);
    } catch (err) {
      fail(`${bot}: token inválido (${String(err)})`);
      problems += 1;
    }
    if (!tg.channel && !tg.premiumChannel) warn(`${bot}: nenhum canal configurado`);
    if (tg.premiumChannel && tg.channel) {
      ok(`${bot}: tier premium ativo — canal free com ${env.freeTierDelaySec}s de atraso`);
    }
  }

  section('Parâmetros de sinal');
  ok(`janelas: ${signals.windows.shortSec}s / ${signals.windows.mediumSec}s / ${signals.windows.longSec}s`);
  ok(`score mínimo: ${signals.minScore} (soma máxima possível: ${signals.rules.reduce((s, r) => s + r.points, 0) + 5})`);
  if (signals.minScore > signals.rules.reduce((s, r) => s + r.points, 0) + 5) {
    fail('score mínimo é maior que a soma de todas as regras — nenhum alerta jamais sairá');
    problems += 1;
  }

  console.log(
    problems === 0
      ? '\n\x1b[32mDiagnóstico concluído sem erros.\x1b[0m'
      : `\n\x1b[31m${problems} problema(s) encontrado(s).\x1b[0m`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

function report(label: string, count: number): void {
  if (count > 0) ok(`${label}: ${count}`);
  else warn(`${label}: 0`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
