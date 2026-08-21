# memecoin-trader

Bot **pessoal** de trading de memecoins na Solana, operado pelo terminal. Ele olha o que
está em tendência, analisa o risco de rug de cada candidato, decide entrada por score,
dimensiona a posição com travas de perda e executa compra e venda via Jupiter — em modo
**paper por padrão**: simula tudo com preço real de mercado sem gastar um lamport.

Projeto autocontido: tem `package.json`, testes e configuração próprios e não depende de
nada fora desta pasta.

```
PumpPortal (websocket: mints novos     GeckoTerminal (trending + new pools)
e graduações do pump.fun, tempo real)  DexScreener (boosts)
              └──────────────┬──────────────┘
                             ▼
                  candidatos (dedupe + cooldown)
                             ▼
              DexScreener: preço, volume, liquidez, txns
                             ▼
        gates de entrada ──► score de sinais (momentum, spike, pressão)
                             ▼
                    ANÁLISE DE RISCO por token
        ┌─────────────────────┼─────────────────────────┐
        ▼                     ▼                         ▼
  mint account on-chain   top holders (RPC)        RugCheck
  (mint/freeze authority,                     (rugged, dangers,
   extensões Token-2022)                       LP travada, insiders)
        └─────────────────────┼─────────────────────────┘
                             ▼
                 veto / score 0–100 / aprovado
                             ▼
              sizing (% do saldo, teto, circuit breaker)
                             ▼
                  Jupiter (live)  ou  simulação (paper)
                             ▼
        gestão contínua: stop loss · trailing · take profit ·
        dreno de liquidez · tempo máximo · token sumido do indexador
```

---

## Começando

```bash
cd memecoin-trader
npm install
cp .env.example .env      # revise; o padrão já é paper
npm run doctor            # valida config, RPC, Jupiter e fontes de dados
npm run trader -- run     # liga o bot (Ctrl+C para parar)
```

Comece **sempre** em paper. Deixe rodando alguns dias, acompanhe com `status` e
`history`, calibre os limiares em `config/trader.json` — e só então considere o live.

### Comandos

```bash
npm run trader -- run          # loop contínuo
npm run trader -- tick         # um ciclo único (ótimo para testar calibração)
npm run trader -- status       # saldo, posições abertas com PnL ao vivo, dia
npm run trader -- check <mint> # relatório de risco + sinal de entrada de um token
npm run trader -- buy <mint> <sol> [--force]
npm run trader -- sell <mint|all> [pct]
npm run trader -- history [n]  # posições fechadas + win rate
npm run trader -- replay [h]   # simula o que as decisões do funil teriam rendido
npm run trader -- paper-reset  # zera o caixa simulado
npm run trader -- doctor
```

`check` funciona para qualquer token, mesmo fora das tendências — cole um mint e veja o
que o bot pensaria dele.

`history` não mostra só o PnL. Mostra o que decide se a estratégia é viável:

- **Intervalo de confiança da win rate** (Wilson, 95%). Com 20 trades, 40% de acerto
  significa "algo entre 20% e 64%" — nenhuma calibração feita em cima disso é real.
  `MIN_SAMPLE_FOR_DECISION` é 100 trades.
- **Win rate de breakeven** para o payoff observado: com o ganho médio e a perda média
  atuais, qual acerto seria preciso para empatar. Nos trades reais analisados era 81% —
  ou seja, a estratégia estava matematicamente perdida, e nenhum gate conserta isso.
- **Pedágio de entrada**: quanto a posição valia *executável* (quote real de venda) no
  primeiro tick contra o que ela custou — impacto de mercado mais taxas. Se o pedágio é
  da ordem do alvo de lucro, o trade nasce perdido. É o número que estava escondido.
- **PnL por motivo de saída**, que mostra onde a banca vaza (foi assim que apareceu que
  `sniper_dump` respondia por 89% do prejuízo).

### `replay` — calibração com número, não com palpite

Toda decisão FINAL do funil (comprado, reprovado pelo risco, reprovado pela IA, barrado
por capacidade) fica gravada na tabela `decisions` com o snapshot do momento e um hash
do config vigente. O `replay` busca as velas de minuto reais (GeckoTerminal) de cada
pool decidido e reexecuta as regras de saída a partir do preço da decisão:

```
reprovadas pela IA: 11 decisões, 9 simuladas, 2 sem dados
   PnL simulado: mediana -12% · soma -74% · 2 teriam dado lucro, 7 prejuízo
✅ O filtro de IA está SALVANDO dinheiro: as reprovações teriam somado -74%.
```

É a resposta direta a "esse filtro está me salvando ou me custando dinheiro?". Limites
declarados: os números são o **teto otimista** (o stop simula no preço nominal; medido
em produção ele executa ~2x pior), dentro de uma mesma vela o pior caso vence (stop
antes de alvo), e as saídas de liquidez/token-morto não são simuladas (precisam de
volume por tick, que vela não tem).

### O veto da IA é simétrico

`ai.minConfidence` filtra as aprovações e `ai.minSkipConfidence` (default 75) filtra os
vetos. Antes, qualquer "pular" bloqueava — enquanto o prompt manda a IA, na dúvida,
pular com confiança baixa. Medido em produção: 11 de 11 candidatos que sobreviveram a
gates+risco morreram num "pular" de confiança 66–78. Abaixo do limiar, a dúvida da IA
vira nota nos motivos da posição (e no `decisions`), não veto — e o `replay` diz depois
se ela tinha razão.

---

## Como o bot decide

### O perfil padrão: scalp na pump.fun

O config que vem no repositório mira **tokens do pump.fun** — na bonding curve
(dexId `pumpfun`) e recém-graduados (`pumpswap`) — com trades rápidos: alvo de
+25% vendendo 60% (o resto corre no trailing de 8%), stop de −12%, tempo máximo
de 45min e tick de 15s. O alvo era +10% vendendo tudo — mas a perda média REAL
medida foi −26% (o stop nominal executa ~2x pior), o que exigia 71% de acerto só
para empatar; com o payoff atual, acertar metade já paga. Os
números foram calibrados contra tokens reais na curve (mcap ~$35k, 9 minutos de
vida, +342% em 5m, 1.400 txns/h — e o mesmo token caiu −55% meia hora depois,
que é exatamente o motivo dos stops apertados).

Particularidades da curve que o código trata explicitamente:

- **O par da curve não reporta `liquidity`** no DexScreener — é estrutural, não
  dado faltando. Para DEXes em `curveDexIds` os gates de liquidez são pulados e
  o piso de qualidade vira `minMarketCapUsd` (a venda de volta na curve é
  garantida pelo programa — não existe LP para o dev puxar);
- **A "maior holder" da curve é o vault da própria curve** — as checagens de
  concentração são desligadas para curve. Mint/freeze authority e extensões
  Token-2022 continuam vetando integralmente: essas são a defesa real ali;
- `allowedDexIds` restringe as compras ao pump.fun; esvazie a lista para operar
  qualquer DEX.

Honestidade sobre velocidade: o bot descobre por **indexadores (polling)**, não
por stream on-chain. Ele compra o **momentum já visível** da curve — não snipa o
mint no bloco zero (isso é território de bots com websocket dedicado e é onde
vivem os bundlers). Entrar no minuto 3–10 de um token subindo é o que este
desenho faz bem.

### 1. Descoberta — redundante por desenho

Quatro fontes gratuitas e independentes, todas configuráveis em `discovery`; qualquer
uma pode cair sem derrubar as outras:

| Fonte | O que traz | Como |
| --- | --- | --- |
| **PumpPortal** (primária) | Cada mint novo e cada **graduação** do pump.fun, no instante em que acontecem | Websocket push — sem polling, sem rate limit |
| GeckoTerminal `trending_pools` | O que o mercado inteiro está olhando | HTTP, cacheado por `sourceTtlSec` |
| GeckoTerminal `new_pools` | Lançamentos recentes fora do pump.fun | HTTP, cacheado |
| DexScreener `token-boosts` | Boosts pagos (sinal fraco sozinho, mas indica atividade) | HTTP, cacheado |

O PumpPortal alimenta uma **watchlist** com janela de `watchWindowMin` (90min): o mint
entra ao nascer e é reavaliado pelos gates a cada tick — o bot não compra "porque
nasceu", compra quando o token cruza os critérios (market cap, volume, momentum) dentro
da janela. Graduação (curve → pumpswap) rejuvenesce o mint na watchlist, porque é o
momento clássico de entrada. Se o websocket cair, reconecta com backoff; enquanto isso
as fontes HTTP seguem descobrindo. As fontes HTTP, por sua vez, servem o último
resultado quando rate-limitadas (`sourceTtlSec`) — candidato de um minuto atrás é
melhor que descoberta nenhuma.

WSOL, stablecoins e LSTs estão em `excludeMints`. Token avaliado entra em cooldown
(`tokenCooldownMin`) para não gastar RugCheck/RPC reanalisando a cada tick.

### 2. Gates de entrada (config `entry.gates`)

Filtros duros de qualidade de mercado: DEX permitida (`allowedDexIds`), liquidez
mínima/máxima (fora da curve), volume 1h mínimo, idade mínima e máxima, mínimo de
transações, buy ratio, piso/teto de market cap (nem recém-mintado, nem blue chip) e
queda máxima de 5m (`maxDrop5mPct` — pós-dump os números de 1h ainda parecem quentes,
mas o fluxo real já virou). Reprovou em um, acabou.

Sobre a idade: a análise on-chain de um dia inteiro de trades reais mostrou que **100%
do prejuízo veio de tokens com menos de 5 minutos de vida** — o "momentum" dos primeiros
minutos é o pump do sniper, e comprá-lo é ser a liquidez de saída dele. Por isso
`minAgeMin` é 5, e idade **desconhecida reprova** (`idade_null`): quando o indexador
ainda não datou o par, o bot usa o timestamp em que VIU o mint nascer no PumpPortal
(piso da idade real — conservador); sem nem isso, não compra.

### 3. Score de sinais (config `entry.rules`)

Regras ponderadas: momentum 5m/1h, spike de volume (última hora contra a média das 23
**anteriores** — comparar contra uma base que contém a própria janela dilui o pico),
pressão compradora, giro sobre a liquidez e presença nas fontes de tendência. Compra
exige `minScore`.

### 4. Risco (config `risk`) — duas camadas

**Vetos** (nenhum score compensa):

- **freeze authority ativa** — o dono congela sua conta e você nunca mais vende;
- **mint authority ativa** — supply infinito;
- **extensões honeypot do Token-2022** — `permanentDelegate` (confisca seus tokens),
  `transferHook` (código arbitrário decide se o transfer passa), `nonTransferable`,
  `defaultAccountState`, `pausable`;
- **`rugged: true` no RugCheck** — o rug já aconteceu;
- **flags danger do RugCheck** não relacionadas a LP (copycat, insider etc.);
- mint account ilegível (`requireOnchain`) — comprar às cegas é o oposto de análise.

**Score 0–100** (acima de `maxScore` rejeita): concentração de holders (top 1 / top 10),
LP pouco travada, score alto no RugCheck, poucos holders, taxa de transferência embutida,
dados indisponíveis (dado faltando **nunca** é dado bom).

Detalhes de calibração que vieram de dados reais, não de teoria:

- O pump.fun minta em **Token-2022** desde 2025 — vetar o programa inteiro tiraria o bot
  do próprio mercado que ele opera. O que se veta são as extensões perigosas, parseadas
  do TLV do mint account.
- Flags "LP unlocked" do RugCheck disparam **até no BONK**, porque pools CLMM
  (Orca/Meteora) não têm trava clássica de LP. Por isso elas pontuam pouco e separado, e
  a trava de LP é **ponderada pela liquidez de cada mercado** em vez de olhar um pool só.
- Top holders lidos do RPC incluem os vaults dos pools (o RPC não sabe o que é AMM). O
  dado do RugCheck, que marca contas conhecidas de AMM, tem preferência; o do RPC é
  fallback com limiar generoso.
- **Token na bonding curve**: a concentração é medida sobre o supply **circulante** — o
  vault da curve é excluído da conta (`curveMaxTop1Pct`/`curveMaxTop10Pct`). Sem isso a
  checagem era pulada por inteiro e token com o circulante todo em meia dúzia de
  carteiras passava sem análise de distribuição.
- **Ligação entre carteiras** (`linkage*`): dez carteiras "diferentes" com 8% cada
  parecem distribuição saudável — até se ver que compraram no **mesmo bloco** (bundle)
  ou foram fundadas pela **mesma carteira-mãe** (fee payer da primeira transação de cada
  uma). Os dois sinais são lidos on-chain (~20–30 chamadas de RPC, só no último degrau
  do funil, com timeout e fail-open) e pontuam alto o suficiente para rejeitar sozinhos.

### 5. Segunda opinião da IA (config `ai`) — opcional

Com `ai.enabled=true` **e** `ANTHROPIC_API_KEY` no `.env`, cada candidato que passou nos
gates, no score e no risco ainda enfrenta um último filtro: o Claude (modelo em
`ai.model`) recebe o dossiê completo — idade, market cap, volume, compras/vendas,
variações, fontes, score, flags de risco, holders — e julga o que números isolados não
dizem: **o momentum está nascendo ou é o topo do pump? A pressão parece orgânica ou
bot?** A compra só prossegue com veredito `comprar` e confiança ≥ `ai.minConfidence`.

Regras do desenho:

- **Fail-open**: IA fora do ar (sem chave, timeout, rate limit) **nunca** trava o bot —
  a compra segue pelos critérios quantitativos, como sempre;
- **Trava de custo**: no máximo `ai.maxCallsPerHour` chamadas/hora — excedeu, segue sem IA;
- O veredito aprovado fica gravado nos motivos da posição (`IA 88%: momentum nascendo`)
  e as reprovações aparecem no funil do heartbeat como gate `ia`;
- A resposta é **estruturada** (schema forçado na API) — nada de interpretar prosa.

### 6. Sizing (config `sizing`)

- posição = `positionPctOfBalance`% do saldo, com teto `maxPositionSol`;
- token mais arriscado → posição menor (`riskScaling`);
- `reserveSol` nunca entra em posição — paga o gás da **saída**;
- máximo `maxOpenPositions` simultâneas;
- **circuit breaker**: perda realizada de `maxDailyLossSol` no dia (UTC) desliga compras
  até o dia virar. Vendas continuam funcionando — trava de perda não pode impedir saída.

### 7. Saídas (config `exit`), em ordem de prioridade

1. **Dreno de liquidez** — liquidez atual abaixo de `liquidityDrainPct`% da liquidez de
   entrada é rug em andamento; sai antes de qualquer conta de lucro;
2. **Stop loss** (`stopLossPct`);
3. **Trailing stop** — arma depois de `trailingActivatePct` de lucro e vende se cair
   `trailingStopPct` do topo;
4. **Take profit parcial** — realiza `takeProfitSellPct`% em `takeProfitPct` de lucro,
   uma vez, e deixa o resto correr no trailing;
5. **Token morto no chão** — volume 5m abaixo de `deadVolume5mUsd` e até `deadTxns5m`
   transações por `deadTicksToExit` ticks seguidos (após `deadMinHoldMin` min de
   carência) vende tudo. Existe porque um token que morre APÓS a compra não dispara o
   stop loss — o preço não cai, simplesmente ninguém negocia — e ficava preso até o
   tempo máximo, capital parado num defunto;
6. **Tempo máximo** (`maxHoldMin`) — memecoin sem tese não é posição de longo prazo;
7. **Token sumiu do indexador** — espera `staleTicksToExit` ticks e sai. No live a venda
   sai via Jupiter pelo preço que realmente houver; no **paper a posição é contabilizada
   como perda total** — token que some do indexador costuma ser pool drenado, e creditar
   o último preço visto transformaria um rug de −100% em −1,5%, inflando a estatística
   exatamente nos piores trades.

As saídas de emergência (dreno, stop, sem dados) usam `emergencySlippageBps` (padrão
15%) em vez da slippage normal: num pool sendo drenado, a slippage de 3% faz toda venda
reverter tick após tick enquanto o preço derrete — preço ruim aceito é melhor que preço
nenhum.

---

## Modo live

Três travas independentes, todas obrigatórias:

1. `TRADER_MODE=live` no `.env`;
2. `LIVE_TRADING_ACK=eu-aceito-o-risco` — a frase exata, digitada por você;
3. uma chave em `SOLANA_PRIVATE_KEY` (base58 da Phantom/Solflare ou array JSON do
   solana-keygen) ou `SOLANA_KEYPAIR_FILE`.

Regras de sobrevivência:

- **Carteira dedicada ao bot**, com só o saldo que você aceita perder. Nunca a principal.
- A chave nunca é logada nem re-gravada em disco pelo bot; mensagens de erro de parsing
  não incluem o valor. Ainda assim: `.env` está no `.gitignore` — deixe assim.
- **RPC dedicado** (Helius/QuickNode/Triton têm tier gratuito). O RPC público responde
  429 sob qualquer carga; o bot faz retry, mas em live latência é dinheiro.
- No live, quantidades são registradas a partir da **quote** do Jupiter (o fill real pode
  variar dentro da slippage). A assinatura da transação fica gravada em `orders` para
  auditoria fina no Solscan. Vendas de 100% fecham a posição pelo que a carteira
  **realmente** tinha (`soldAll`) — divergência contábil não deixa posição-zumbi.
- Timeout de confirmação **não** é tratado como falha: uma transação transmitida continua
  válida até o blockhash vencer, então o bot resolve o destino de verdade (confirmada,
  falhada ou expirada) antes de reportar qualquer coisa. Se nem isso der resposta, o
  saldo real da carteira decide a reconciliação — compra que aterrissou vira posição
  (com stop loss), venda que aterrissou é contabilizada, e nada é re-executado às cegas.
- Compra é abortada se o impacto de preço da própria ordem passar de 10% — pool raso
  demais para o seu tamanho.

## Painel web

Com `dashboard.enabled=true` (padrão), o `run` sobe um painel em
**http://localhost:3877** (porta em `dashboard.port`) — escutando **apenas em
127.0.0.1**, nunca exposto para a rede, sem nenhum segredo passando por ele.

O que dá para fazer por lá:

- **ver** saldo, PnL do dia, posições abertas (com PnL sobre o baseline executável),
  histórico de trades e o funil do último tick (candidatos → gates → compras);
- **pausar/retomar** novas compras (a gestão das posições abertas continua);
- **vender** qualquer posição aberta (50% ou 100%) com um clique;
- **editar a configuração inteira** com validação: salvar grava o `trader.json` e aplica
  em execução na hora (gates, saídas, sizing, IA, slippage). Só as seções
  `discovery.pumpportal` e `dashboard` pedem restart. Config inválido é recusado com a
  lista de erros — nada é gravado.

No WSL2 o `localhost` do Windows enxerga o painel normalmente (forwarding automático).

## Configuração

Tudo em [`config/trader.json`](config/trader.json), validado por schema no boot
(`src/config.ts`) e travado por testes (`test/config.test.ts` — por exemplo: o score
mínimo de entrada tem que ser alcançável pelas regras, senão o bot nunca compraria e
ninguém perceberia). Edite, rode `npm test`, e o build avisa se algo ficou incoerente.

Estado em `data/trader.sqlite`: posições, ordens (inclusive as que falharam — trilha de
auditoria), histórico de avaliação por token e estatística diária. Posições paper e live
convivem separadas pela coluna `mode`.

## Arquitetura

| Arquivo | Responsabilidade |
| --- | --- |
| `src/engine.ts` | O loop: gerenciar posições abertas **antes** de procurar entrada nova |
| `src/strategy.ts` | Entrada e saída — puro, sem I/O, todo testável offline |
| `src/risk.ts` | Vetos + score — puro |
| `src/sizing.ts` | Tamanho de posição e circuit breakers — puro |
| `src/brokers.ts` | PaperBroker e LiveBroker atrás da mesma interface: o paper exercita o mesmo caminho de código do live |
| `src/chains/solana/` | RPC, parse do mint account e extensões TLV do Token-2022, Jupiter |
| `src/datasources/` | DexScreener, GeckoTerminal, RugCheck — parsing defensivo e testado |
| `src/db.ts` | SQLite (WAL): posições, ordens, cooldown, estatística diária |
| `src/cli.ts` | Comandos de terminal |

O engine recebe fontes, chain e broker por injeção — os testes rodam o laço completo
(descoberta → risco → compra → stop loss) sem rede nenhuma.

### BSC (BNB Chain) — fase 1: paper

O bot roda na BSC com `TRADER_CHAIN=bsc` no `.env` (ou na frente do comando):

```bash
TRADER_CHAIN=bsc npm run trader -- doctor   # valida RPC, DexScreener, GeckoTerminal e GoPlus
TRADER_CHAIN=bsc npm run trader -- run      # paper trading (painel em http://localhost:3878)
```

Um **processo por rede**, de propósito: config próprio
([`config/trader.bsc.json`](config/trader.bsc.json)), banco próprio
(`data/trader-bsc.sqlite`) e painel em porta própria — dá para rodar Solana live e BSC
paper lado a lado em dois terminais, e falha numa rede não derruba a outra. O
`TRADER_MODE` do `.env` é global: com ele em `live`, o processo da BSC **se rebaixa
para paper** e avisa no boot, em vez de recusar a subir (degradar sempre para o lado
seguro; esconder isso, nunca).

O que muda de mundo na BSC:

- **Segurança é análise de CONTRATO**, não de flags SPL: honeypot, taxa alterável,
  blacklist e trading pausável são a norma. A leitura vem do **GoPlus** (o RugCheck da
  EVM), mapeada para o mesmo motor de risco — e `requireRugcheck=true` no config da BSC:
  sem GoPlus, rejeita. Taxa de venda acima de `maxSellTaxPct` (10%) rejeita sozinha — ela
  come o alvo de lucro inteiro.
- Endereços EVM são **canonicalizados para minúsculas** na ingestão (o casing de
  checksum varia por fonte).
- PumpPortal é pump.fun (Solana) — desligado; a descoberta usa GeckoTerminal e
  DexScreener parametrizados por rede.
- Só se compra **bonding curve**: `allowedDexIds` é `["fourmeme", "flapsh"]`. A
  **four.meme** entra também em `curveDexIds` (é curve pura e não reporta liquidez);
  a **flap.sh** reporta (~US$ 8k) e passa pelos gates normais. Medindo o universo real,
  esses tokens aparecem com US$ 3–30k e minutos de vida — o alvo da estratégia.
- A descoberta usa `discovery.gtDexes` (`["four-meme"]`): o endpoint de pools **por
  plataforma** do GeckoTerminal entrega direto a população que interessa. Com as fontes
  genéricas da rede, 17 de 17 candidatos com par eram reprovados no gate de DEX.
- **O GeckoTerminal também enriquece.** O DexScreener leva minutos para indexar um par
  de curve recém-criado — exatamente a janela da estratégia —, e o payload de descoberta
  do GT já traz preço, volume 5m/1h, txns, reserva e idade. Medido: sem esse fallback,
  15 de 56 candidatos tinham par e **nenhum** chegava a ser avaliado; com ele, 52 de 52.
  Custo: zero requisições a mais.
- **Concentração de holders é medida sobre o CIRCULANTE.** Na four.meme o contrato da
  curve (`0x5c95…762b`) é o maior holder em 10 de 11 tokens amostrados, com 84–99,9% do
  supply — somar o supply cru dá "top10 = 99%" em todo token e o número não discrimina
  nada. Excluídas as contas estruturais (curve, par de AMM, queima) e renormalizando, o
  top1 do circulante vai de 15% a 96%: aí separa token distribuído de token bundlado.
  Na EVM não dá para listar holders pelo RPC sem indexar `Transfer`, então a lista vem
  do próprio GoPlus.
- `requireHolderDistribution: true` no config da BSC: token de curve cuja distribuição
  **não pôde ser verificada** é rejeitado, em vez de só pontuar. O GoPlus ainda não
  computou os holders dos tokens mais novos — justamente onde o bundle é mais provável.
  Na Solana o default é `false` (lá a distribuição vem do RPC e faltar é raro).
- Os campos `*Sol` do config/banco valem como "moeda NATIVA" (BNB na BSC).
- **Live na BSC é a fase 2** (PancakeSwap router, approve, nonce).

### Expansão para outras redes

A próxima rede alvo é a **Robinhood Chain** (L2 EVM baseada em Arbitrum Orbit). O desenho
já separa o que muda do que fica:

- `ChainAdapter` (leituras de segurança on-chain) e `Broker` (execução) são interfaces —
  uma rede EVM implementa as duas com viem/ethers e um agregador local;
- descoberta e enriquecimento via DexScreener/GeckoTerminal já são multi-chain (é trocar
  o filtro de `chainId`);
- estratégia, risco genérico, sizing, engine, db e CLI não mudam.

O que **não** transfere: RugCheck (só Solana — o equivalente EVM seria honeypot.is/GoPlus)
e o parse de mint account (em EVM a análise equivalente é de bytecode do contrato).

## Limitações (ditas na cara)

- **A análise de risco é triagem, não auditoria.** Honeypot sofisticado pode passar:
  lógica maliciosa pode viver num programa externo que o mint referencia, em controle de
  metadata, ou simplesmente no dono despejando supply que não aparece nos top 20.
- **Estratégia de momentum em memecoin perde dinheiro na maioria dos dias.** O desenho
  inteiro (stop apertado, posição pequena, circuit breaker) existe para sobreviver à
  taxa base de -100% desse mercado, não para prometer lucro. **Espere perder** o que
  colocar; opere com o que pode perder.
- **Paper é otimista.** O fill simulado aplica slippage fixa e ignora MEV, latência e
  falha de transação. Resultado bom em paper é condição necessária, nem de longe
  suficiente.
- **Indexadores atrasam e erram.** Preço/volume do DexScreener têm segundos de atraso;
  em pico de volatilidade o stop sai pior do que a tela mostrava.
- **`buys/sells` são contagens de transação**, não de carteiras únicas — wash trading
  infla os dois lados e o bot não distingue.
- Os limiares padrão foram calibrados numa tarde contra o mercado real, mas **o mercado
  de memecoin muda de regime toda semana**. Recalibre com `tick` + `check` regularmente.

## Aviso

Software pessoal e experimental, fornecido como está. Nada aqui é recomendação de
investimento. Trading de memecoins é especulação de altíssimo risco; automatizá-la não
reduz o risco — só a velocidade com que ele se realiza.
