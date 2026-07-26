# Telegram-Bots — alertas de cripto na Arc

Dois bots de Telegram para a **Arc**, a L1 da Circle que usa USDC como token de gás:

| Bot | O que faz | Entrada |
| --- | --- | --- |
| **Arc New Launches** | Alerta cada novo token que ganha um pool negociável | `npm run bot:launches` |
| **Arc Signals** | Alerta tokens com pressão compradora, spike de volume e valorização | `npm run bot:signals` |

Os dois compartilham o mesmo núcleo (scanner de chain, precificação, monetização) e
publicam alertas com **links de referral configuráveis** — a camada de receita.

---

## Estado da Arc (importante, leia antes)

**A Arc Mainnet ainda não está no ar.** Em julho de 2026 a rede segue em testnet
pública; a Circle indica beta de mainnet ainda em 2026. Este projeto foi construído e
**testado contra o RPC real da Arc testnet**, e trocar para a mainnet é preencher quatro
variáveis no `.env` — nenhuma linha de código muda.

O que foi verificado direto no RPC (não copiado de documentação):

| Item | Valor |
| --- | --- |
| Chain ID (testnet) | `5042002` |
| RPC | `https://rpc.testnet.arc.network` (é nó **archive**) |
| Tempo de bloco | **0,51s** medido |
| USDC (ERC-20) | `0x3600…0000`, **6 decimals** |
| USDC nativo (gás) | 18 decimals |
| Multicall3 | presente no endereço canônico |
| DEX ativa | factory estilo Uniswap V3 em `0xba27c71b…`, com swaps V2 **e** V3 no ar |

Rodando o `npm run doctor` numa janela de 2.000 blocos: 23 criações de pool, 750 swaps V2,
179 swaps V3 e 1.574 mints de token. **Já existe atividade de memecoin na Arc testnet** —
tokens como `Fluffy`, `moloch`, `Grok` e `PROTEIN` saem de um launchpad ativo.

### Uma ressalva honesta sobre monetização

A Arc é uma L1 institucional focada em liquidação de stablecoin. Hoje **não existe**
plataforma de trade com programa de afiliados rodando nela — nem Photon, nem BullX, nem
Axiom, nem DexScreener indexando a rede. Por isso `config/referrals.json` vem com
templates marcados como `verified: false` e placeholders explícitos: o código está pronto
para monetizar, mas **os links precisam ser preenchidos quando as plataformas existirem**.
O bot avisa no boot toda vez que um link de trade sai sem código de referral.

Veja [`docs/MONETIZACAO.md`](docs/MONETIZACAO.md) para as alternativas que **já** funcionam.

---

## Começando

```bash
npm install
cp .env.example .env     # edite: tokens do bot, canais, códigos de referral
npm run doctor           # valida config + conectividade + monetização
npm run bot:launches     # em um terminal
npm run bot:signals      # em outro
```

`DRY_RUN=true` é o padrão: os alertas vão para o log, nada é publicado. Rode assim por
alguns dias, veja o que sairia, calibre os limiares — e só então mude para `false`.

### `npm run doctor`

Verifica o que dá para verificar de verdade contra o RPC: chain id, avanço de blocos,
tempo de bloco medido, presença do multicall3, **decimals do token de quote conferidos
on-chain** (errar isso desloca todo preço por 10¹²), volume de cada tipo de evento,
factories ativas, validade dos tokens do Telegram e se os links carregam referral.

---

## Como funciona

### Descoberta sem lista de endereços

O scanner filtra logs **por assinatura de evento na rede inteira**, não por uma lista de
factories conhecidas. Isso é proposital: a Arc é nova e ninguém sabe quais DEXes vão subir
nela. Quando uma DEX nova aparecer, os bots pegam sozinhos — sem redeploy, sem editar
config. Pools que já existiam antes do bot subir são descobertos pelo primeiro swap
(`token0()`/`token1()` on-chain).

### Bot 1 — New Launches

`PoolCreated`/`PairCreated` → registra o pool → lê metadados ERC-20 → avalia risco →
publica.

O detalhe que faz diferença: **criação e financiamento do pool são transações separadas**.
Na Arc, o pool nasce vazio e o dinheiro entra depois. Um filtro ingênuo de "liquidez
mínima" descartaria todo launch no instante em que ele é criado. Por isso pools sem
liquidez não são descartados — entram numa fila e são reavaliados a cada 20s por até
30 minutos.

Também rastreia todo `Transfer` vindo do endereço zero (o mint que cria o supply), para
saber a idade real do token no alerta.

### Bot 2 — Signals

`Swap` (V2 e V3) → normaliza para trade assinado → grava em SQLite → agrega em janelas
móveis (3min / 15min / 1h) → pontua → publica.

Regras pontuadas (todas em `config/signals.json`): pressão compradora, spike de volume,
compradores únicos, valorização, fluxo líquido e token recém-lançado. O alerta sai quando
a soma passa de `minScore`, respeitando cooldown por token e teto por hora.

O spike de volume compara a janela curta contra uma linha de base que **exclui** a janela
curta — comparar contra uma base que a contém dilui o pico e faz o sinal sumir.

### Duas medidas de liquidez, não uma

Isso foi medido, não suposto. Os launches da Arc saem de launchpad estilo bonding curve: o
pool nasce com token e **zero USDC**, e o USDC só entra conforme as pessoas compram. Então:

- **liquidez de saída** (lado quote) — o dinheiro real, o único contra o qual dá para vender;
- **tamanho do pool** (os dois lados a preço spot) — mede se é um pool de verdade.

O alerta mostra os dois e avisa explicitamente quando não há contraparte: *"dá para
comprar, não dá para vender"*. Um bot que esconde isso queima a audiência em uma semana.

---

## Configuração

| Arquivo | Para quê |
| --- | --- |
| `config/networks.json` | Redes, RPCs, tokens de quote. `arc-mainnet` já existe, lendo do `.env` |
| `config/referrals.json` | **Monetização.** Plataformas, templates e seus códigos de referral |
| `config/launches.json` | Limiares do bot de launches |
| `config/signals.json` | Janelas, regras, pontos e cortes do bot de sinais |
| `config/dex.json` | Rótulos de factory, listas de permissão/bloqueio |

### Migrar para a mainnet

```bash
NETWORK=arc-mainnet
ARC_MAINNET_RPC_URL=https://...
ARC_MAINNET_CHAIN_ID=...
ARC_MAINNET_EXPLORER=https://...
```

Sem essas variáveis, `NETWORK=arc-mainnet` **falha no boot com mensagem explícita**. É
intencional: alertar na rede errada é pior do que não alertar.

---

## Operação

```bash
npm test            # 108 testes unitários
npm run typecheck
npm run build       # -> dist/
docker compose up -d
```

O CI (GitHub Actions) roda typecheck, testes, build, um smoke test de que os dois
entrypoints compilados carregam, e o build da imagem Docker verificando que ela enxerga
`config/`.

Rodando direto com `npm`, o estado fica em `data/*.sqlite` (um arquivo por bot). No Docker
fica em volume nomeado — bind mount de `./data` daria erro de permissão, já que o container
roda como usuário `node`. Para backup: `docker cp arc-signals:/app/data ./backup`.

O checkpoint só avança **depois** que
o lote é processado, então um crash reprocessa em vez de pular alertas — os índices únicos
garantem que reprocessar não duplique nada. Reorgs são detectados por hash e revertidos.

O RPC público da Arc responde `-32011 request limit reached` sob carga; o cliente tem token
bucket, limite de concorrência, backoff com jitter e failover entre RPCs.

### Throughput medido

Os dois bots rodando **ao mesmo tempo**, contra o **RPC público gratuito**, partindo 4.000
blocos atrás da cabeça da chain:

| | Launches | Signals |
| --- | --- | --- |
| Taxa média | **34,4 blocos/s** | **33,8 blocos/s** |
| Atraso inicial → final | 4.003 → **0** | 4.003 → **0** |
| Tempo para zerar o atraso | ~10s | ~10s |
| Erros de rate limit | 0 | 0 |

A Arc produz 2 blocos/s, então há **~17× de folga**. Os dois alcançaram a cabeça da chain em
três lotes e ficaram com atraso zero pelo resto da medição (186s). Um RPC pago em
`RPC_URL_OVERRIDE` é recomendável para produção séria — redundância e cotas garantidas —
mas **não é requisito para acompanhar a chain em tempo real**.

---

## Limitações (ditas na cara)

- **A heurística de risco não detecta honeypot.** Ela lê o bytecode atrás de `mint`,
  `pause`, `blacklist`, proxy atualizável e owner ativo. Honeypot de verdade se esconde na
  lógica de transferência, não em seletor exposto. O `Risco: N/100` é triagem, não auditoria.
- **"Compradores únicos" é aproximado por padrão.** O trader vem do destinatário do evento
  de swap, que erra em rota multi-hop. Ligue `resolveTradersFromTx` (custa uma chamada RPC
  por transação) para o número exato.
- **Liquidez em V3 concentrado é aproximada** — é saldo do pool, não liquidez por tick.
- **Idade do token pode ser desconhecida** se o RPC não for archive. Nesse caso ela aparece
  como "desconhecida" e as regras de idade não se aplicam — em vez de o bot inventar um número.
- Os limiares padrão foram calibrados contra a **testnet**. Revise no primeiro dia de mainnet.

---

## Documentação

- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — desenho, decisões e por quê
- [`docs/MONETIZACAO.md`](docs/MONETIZACAO.md) — como esses alertas viram receita

## Aviso

Software de informação, não de investimento. Os alertas são automáticos e podem conter
erros. Nada aqui é recomendação de compra ou venda.
