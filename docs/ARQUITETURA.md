# Arquitetura

## Fluxo

```
                       ┌──────────────────────────────┐
                       │  RPC da Arc (JSON-RPC HTTP)  │
                       └──────────────┬───────────────┘
                                      │  Limiter: token bucket + backoff + failover
                       ┌──────────────▼───────────────┐
                       │  ChainClient                 │
                       │  getLogs / multicall / code  │
                       └──────────────┬───────────────┘
                                      │
                       ┌──────────────▼───────────────┐
                       │  LogScanner                  │
                       │  checkpoint · reorg · janela │
                       └───────┬──────────────┬───────┘
                               │              │
        ┌──────────────────────▼───┐     ┌────▼───────────────────────┐
        │  Bot: New Launches       │     │  Bot: Signals              │
        │  PoolCreated / Mint      │     │  Swap V2 + V3              │
        │  → risco → fila pendente │     │  → trades → janelas → score│
        └──────────────┬───────────┘     └────────────┬───────────────┘
                       │                              │
                       └───────────┬──────────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  ReferralBuilder → Publisher │
                    │  premium agora · free depois │
                    └──────────────────────────────┘
```

## Módulos

| Arquivo | Responsabilidade |
| --- | --- |
| `core/limiter.ts` | Concorrência, taxa e retry. Existe porque o RPC público responde `-32011` sob carga |
| `core/chain.ts` | Cliente viem, `eth_getLogs` cru por tópicos, multicall com fallback |
| `core/scanner.ts` | Laço de varredura, checkpoint durável, reorg, janela adaptativa |
| `core/events.ts` | Assinaturas de evento e decodificação. Topic0 **derivado**, nunca hardcoded |
| `core/tokens.ts` | Metadados ERC-20 (inclui bytes32 legado) e heurística de risco |
| `core/pools.ts` | Registro de pools, escolha do quote, liquidez, preço spot, bloco de deploy |
| `core/trades.ts` | Normalização de swap para trade assinado, com filtro de poeira |
| `core/db.ts` | SQLite: checkpoints, tokens, pools, trades, alertas |
| `core/referrals.ts` | Construção dos links monetizados + auditoria no boot |
| `core/publisher.ts` | Fila, throttle, retry 429, dedupe, atraso do tier gratuito |
| `bots/signals/metrics.ts` | Agregação por janela, em SQL |
| `bots/signals/rules.ts` | Elegibilidade e pontuação — puro, sem I/O |

## Decisões e o porquê

### Filtrar por topic0, não por lista de factories

A Arc não tem ecossistema DEX consolidado. Um bot que exige lista de factories precisa de
redeploy toda vez que uma DEX nova sobe — justamente quando os primeiros launches
acontecem. Filtrando pela assinatura do evento na rede inteira, qualquer fork de Uniswap V2
ou V3 é detectado automaticamente, e a factory emissora fica registrada.

Custo: alguns logs de contratos irrelevantes que reusam a mesma assinatura. Eles caem no
`decode`, que retorna `null`, e são descartados.

### Descoberta preguiçosa de pools

Pools criados antes do bot subir nunca emitem `PoolCreated` de novo. Quando um `Swap` chega
de um endereço desconhecido, o registro consulta `token0()`/`token1()`/`fee()` on-chain e
aprende o pool. Pools sem quote conhecido são memorizados como inúteis para não gerar
consulta repetida a cada swap.

### Duas medidas de liquidez

Medido contra a Arc: os pools de launchpad nascem com token e **zero USDC**. Um filtro de
"liquidez mínima" olhando só o lado quote descartaria todo launch novo. Um filtro olhando a
soma dos dois lados trataria "US$ 8 mil em token e nada de USDC" como pool saudável, o que
também é falso — não há contra quem vender.

Então os dois números existem separados: `quoteUsd` (dinheiro real, liquidez de saída) e
`totalUsd` (tamanho do pool). O alerta mostra ambos e avisa quando não há contraparte.

### Idade pode ser `null`

Para pools que não vimos nascer, o bloco de deploy é achado por **busca binária sobre
`eth_getCode`** — ~26 chamadas em uma chain de 50M+ blocos, uma vez por pool, gravado no
SQLite. O RPC da Arc é archive e isso funciona.

Quando não funciona (nó sem archive), a idade fica `null` — e as regras de idade
simplesmente não se aplicam. A alternativa, tratar desconhecido como "recém-criado", faria
todo token antigo parecer launch depois de cada restart, e a regra `fresh_launch`
distribuiria pontos para quem não merece. **Isso foi um bug real durante o desenvolvimento:**
tokens de 121 dias apareciam como "26s".

### Linha de base de volume exclui a janela curta

`baseline = (volume_longo − volume_curto) / (duração_longa − duração_curta)`.

Comparar a janela curta contra uma base que a contém dilui o pico: um token que fez todo o
volume nos últimos 3 minutos apareceria como normal, que é exatamente o caso que o sinal
deveria pegar.

### Filtro de poeira nos trades

Um swap de 1 wei contra 1 USDC implica preço de 10¹⁸ dólares por token. Como o último preço
da janela vira market cap e variação percentual no alerta, isso é um vetor barato de
manipulação além de ruído de arredondamento. Trades abaixo de `1e-9` unidades em qualquer
lado são descartados.

### Checkpoint depois do processamento

O checkpoint só avança quando o handler termina. Um crash reprocessa o lote em vez de pular
alertas. Reprocessar é seguro porque a gravação é idempotente: índice único em
`(tx_hash, log_index)` para trades, `ON CONFLICT DO NOTHING` para tokens, flag `alerted`
para pools.

### Agregação em SQL, não em JavaScript

Puxar milhares de linhas para o Node e somar em memória é a diferença entre acompanhar a
chain e ficar para trás no pico de volume — que é quando o sinal vale alguma coisa. Com
0,5s de bloco, o orçamento por tick é curto.

## Esquema do banco

```sql
checkpoints (scope PK, last_block, last_hash, updated_at)
tokens      (address PK, symbol, name, decimals, total_supply,
             first_seen_block, first_seen_ts, creator, is_erc20, launch_alerted)
pools       (address PK, factory, kind, token0, token1, fee,
             base_token, quote_token, created_block, created_ts, discovered_ts, alerted)
trades      (id PK, pool, token, ts, block, tx_hash, log_index, side,
             token_amount, quote_amount, usd, price_usd, trader)
             UNIQUE(tx_hash, log_index) · INDEX(token, ts)
pool_state  (pool PK, liquidity_usd, price_usd, updated_ts)
alerts      (id PK, kind, subject, score, ts)
```

Um arquivo por bot: reiniciar, migrar ou apagar o estado de um não afeta o outro. Trades com
mais de 7 dias são removidos periodicamente.

## Como estender

**Nova rede EVM** — adicione a entrada em `config/networks.json` com `chainId`, `rpcUrls` e
os `quoteTokens` (atenção aos `decimals`; o `doctor` confere on-chain). Nenhum código muda.

**Novo tipo de DEX** — adicione a assinatura em `core/events.ts` e trate no `decodeSwap`.
Tudo depois disso já é agnóstico.

**Nova regra de sinal** — adicione o `id` ao enum em `config/schema.ts`, um `case` em
`rules.ts` e a entrada em `config/signals.json`. `rules.ts` é puro, então a regra nova
ganha teste unitário sem precisar de chain nem banco.

**Nova plataforma de link** — só `config/referrals.json`.
