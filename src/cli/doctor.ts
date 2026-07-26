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

/**
 * Executa com prazo. Um diagnóstico que pendura é pior do que um que falha:
 * medido contra o gateway público da Arc mainnet, o `doctor` ficou 7 minutos sem
 * imprimir nada porque o RPC devolvia 429 e o cliente reentrava em backoff. A
 * pessoa fica olhando um cursor piscando sem saber que o problema é o RPC.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: sem resposta em ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Mensagem acionável quando o RPC está estrangulando as chamadas. */
function explainRpcLimit(network: { rpcUrls: string[] }): void {
  fail('o RPC não está respondendo a tempo — quase sempre é rate limit de gateway público');
  console.log(`
  O endereço em uso é ${network.rpcUrls[0]}

  Se for um gateway público, ele não sustenta os bots: eles fazem eth_getLogs
  contínuo mais multicall. Saídas, da mais simples para a mais robusta:

    1. Chave gratuita da thirdweb:
         RPC_URL_OVERRIDE=https://5042.rpc.thirdweb.com/SEU_CLIENT_ID
    2. RPC dedicado (Alchemy / QuickNode / dRPC):
         RPC_URL_OVERRIDE=https://...    (aceita várias, separadas por vírgula)

  Depois de migrar, suba rateLimit em config/networks.json para 4 / 12.`);
}

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
    const chainId = await withDeadline(chain.client.getChainId(), 30_000, 'eth_chainId');
    if (chainId !== network.chainId) {
      fail(`chainId do RPC (${chainId}) diferente do configurado (${network.chainId})`);
      problems += 1;
    } else {
      ok(`chainId confere: ${chainId}`);
    }
    head = await withDeadline(chain.getBlockNumber(), 30_000, 'eth_blockNumber');
    ok(`bloco atual: ${head}`);
  } catch (err) {
    explainRpcLimit(network);
    console.log(`\n  detalhe: ${String(err)}`);
    process.exit(1);
  }

  // Daqui para baixo nada é fatal: com RPC lento vale entregar diagnóstico parcial
  // em vez de travar. Cada bloco diz o que não deu para medir.
  try {
    const [t0, t1] = await withDeadline(
      Promise.all([chain.getBlockTimestamp(head - 200n), chain.getBlockTimestamp(head)]),
      45_000,
      'medição de tempo de bloco',
    );
    const blockTime = (t1 - t0) / 200;
    ok(`tempo de bloco medido: ${blockTime.toFixed(2)}s (configurado: ${network.blockTimeMs / 1000}s)`);
    if (Math.abs(blockTime * 1000 - network.blockTimeMs) > network.blockTimeMs) {
      warn('blockTimeMs em networks.json está longe do medido — ajuste o intervalo de polling');
    }
  } catch {
    warn('não deu para medir o tempo de bloco (RPC lento) — blockTimeMs segue como está no config');
  }

  section('Multicall3');
  if (!network.multicall3) {
    warn('multicall3 não configurado — leituras de token vão uma a uma (mais lento)');
  } else {
    try {
      const code = await withDeadline(chain.getCode(network.multicall3), 45_000, 'eth_getCode');
      if (code && code !== '0x') ok(`multicall3 presente em ${network.multicall3}`);
      else {
        warn(`multicall3 NÃO existe em ${network.multicall3} — removendo o campo o bot usa fallback`);
      }
    } catch {
      warn('não deu para checar o multicall3 (RPC lento)');
    }
  }

  section('Tokens de quote');
  if (network.quoteTokens.length === 0) {
    fail('nenhum token de quote configurado — sem isso nenhum preço em USD é calculável');
    problems += 1;
  }
  for (const quote of network.quoteTokens) {
    // Esta é a checagem mais importante do doctor inteiro: decimals errado desloca
    // preço, volume e market cap de TODO alerta. Por isso o prazo aqui é generoso —
    // vale esperar, e não conseguir medir conta como problema, não como aviso.
    let res;
    try {
      res = await withDeadline(
        chain.multicall([
          { address: quote.address, abi: erc20Abi, functionName: 'symbol' },
          { address: quote.address, abi: erc20Abi, functionName: 'decimals' },
        ]),
        90_000,
        'leitura do token de quote',
      );
    } catch {
      fail(`${quote.address}: não deu para confirmar decimals on-chain — NÃO suba sem isso`);
      problems += 1;
      continue;
    }
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
  let creations: Awaited<ReturnType<typeof chain.getLogs>> = [];
  let swapsV2: typeof creations = [];
  let swapsV3: typeof creations = [];
  try {
    [creations, swapsV2, swapsV3] = await withDeadline(
      Promise.all([
        chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.pairCreated, TOPIC.poolCreated]] }),
        chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.v2Swap]] }),
        chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.v3Swap]] }),
      ]),
      120_000,
      'varredura de atividade',
    );
    const mints = await withDeadline(
      chain.getLogs({ fromBlock: from, toBlock: head, topics: [[TOPIC.transfer], [ZERO_TOPIC]] }),
      120_000,
      'varredura de mints',
    );

    report('criações de pool', creations.length);
    report('swaps V2', swapsV2.length);
    report('swaps V3', swapsV3.length);
    report('mints (tokens novos)', mints.length);

    if (creations.length === 0 && swapsV2.length + swapsV3.length === 0) {
      warn('nenhuma atividade de DEX nesta janela — normal em rede recém-lançada, mas confirme antes de calibrar thresholds');
    }
  } catch {
    warn('não deu para varrer a atividade on-chain com este RPC (lento demais)');
    warn('sem esse número você está calibrando limiares às cegas — troque de RPC antes de sair do DRY_RUN');
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
  const referralsConfig = loadReferrals();
  const referrals = new ReferralBuilder(referralsConfig, {
    networkKey: network.key,
    explorerUrl: network.explorerUrl,
  });
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

  // Plataforma configurada mas restrita a outra rede não aparece na lista acima.
  // Sem este aviso o usuário configura o referral, não vê o link e acha que quebrou.
  const gated = referralsConfig.platforms.filter(
    (p) => p.enabled && p.networks.length > 0 && !p.networks.includes(network.key),
  );
  for (const platform of gated) {
    warn(
      `${platform.id} está configurado mas restrito a ${platform.networks.join(', ')} — não publica em ${network.key}`,
    );
  }
  if (gated.some((p) => p.kind === 'trade') && monetized === 0) {
    warn(
      'os links que pagam estão restritos a outra rede: nesta rede os alertas saem sem monetização (esperado durante a calibração em testnet)',
    );
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
