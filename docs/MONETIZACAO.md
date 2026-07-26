# Monetização

Você pediu que todo bot tivesse uma forma de gerar receita, e apontou links de referral
como o caminho. Concordo que é o caminho principal — mas ele tem um problema de timing na
Arc que precisa ser dito antes de qualquer coisa.

---

## O problema de timing

Links de referral só pagam se existir uma plataforma com programa de afiliados **naquela
rede**. Hoje, na Arc:

- Photon, BullX, Axiom, Trojan, Maestro, Banana Gun — todos operam em Solana e nas EVMs
  grandes. **Nenhum anunciou suporte à Arc.**
- DexScreener, DEXTools, GeckoTerminal ainda **não indexam a Arc**, então nem link de
  gráfico existe (e esses, de qualquer forma, não pagam comissão).
- A Arc é uma L1 institucional da Circle, desenhada para liquidação de stablecoin. É
  plausível que o ecossistema de trading bot de memecoin chegue lá — a testnet já tem
  launchpad e tokens como `Fluffy` e `Grok` — mas **não dá para afirmar que chegará**, nem
  quando.

Isso não invalida o plano. Significa que a receita não começa pelos links de referral, e o
projeto foi construído para isso: **quatro alavancas, ordenadas por quando cada uma passa a
funcionar.**

---

## Alavanca 1 — Tier premium (funciona no dia 1, não depende de ninguém)

A mais subestimada e a única que não depende de terceiros. Já está implementada.

Dois canais. O premium recebe o alerta **na hora**; o gratuito recebe **com atraso**.

```bash
TELEGRAM_SIGNALS_CHANNEL=@arc_signals            # gratuito, vitrine
TELEGRAM_SIGNALS_PREMIUM_CHANNEL=-1001234567890  # pago
FREE_TIER_DELAY_SEC=60
```

Por que funciona: em alerta de launch, 60 segundos é a diferença entre entrar cedo e ser
saída de liquidez de quem entrou antes. O canal gratuito não é caridade — é a prova pública
e contínua de que o sinal chega antes, o que é o argumento de venda do premium.

Comece com 30–60s. Atraso muito curto não vende; muito longo faz o canal gratuito virar
histórico inútil e você perde o funil.

Cobrança é manual no começo (Pix/cripto + adicionar ao canal). Só automatize quando o
volume justificar — automatizar cobrança de dez assinantes é queimar semana de trabalho.

## Alavanca 2 — Afiliado de corretora (funciona hoje, independe da Arc)

Programas de afiliados de CEX (Binance, Bybit, OKX, Bitget) pagam percentual **vitalício**
sobre a taxa de quem se cadastra pelo seu link, e não dependem de a Arc existir.

```json
{
  "id": "cex_generic",
  "label": "CEX",
  "template": "https://SUA-CEX.com/join?ref={ref}",
  "ref": "SEU_CODIGO",
  "enabled": true,
  "kind": "cex"
}
```

Ou como rodapé fixo em todo alerta:

```json
"footer": { "enabled": true, "text": "📈 Opere com taxa reduzida: https://..." }
```

Costuma render mais que referral de DEX, porque a comissão é recorrente em vez de por trade.

## Alavanca 3 — Links de referral de trade (pronto, esperando plataforma)

Toda a mecânica está feita. Quando uma plataforma com afiliados subir na Arc, você edita
`config/referrals.json` e pronto — nada de código:

```json
{
  "id": "trade_generic",
  "label": "Comprar",
  "template": "https://plataforma.com/swap?chain={chainId}&outputCurrency={token}&ref={ref}",
  "ref": "SEU_CODIGO",
  "enabled": true,
  "verified": true,
  "kind": "trade"
}
```

Placeholders: `{token}`, `{pool}`, `{chainId}`, `{chain}`, `{ref}`.

Três proteções que já estão no código:

1. Template com placeholder não preenchido (`SUA-PLATAFORMA.com`) **não é publicado** — link
   quebrado no canal custa mais credibilidade do que vale.
2. Link de trade sem `ref` **grita no log no boot**. Esse é o pior cenário possível: você
   entrega o volume e não recebe a comissão.
3. Link de `kind: "trade"` vai **como primeiro botão**, que é o que mais recebe clique.

`npm run doctor` mostra as URLs finais, já preenchidas, para você conferir antes de publicar.

## Alavanca 4 — Slots patrocinados

Quando o canal tiver audiência, projeto paga para aparecer. Use o rodapé:

```json
"footer": { "enabled": true, "text": "🔸 Patrocinado: <a href=\"...\">PROJETO</a>" }
```

Regra prática: separe visualmente do conteúdo e marque como patrocinado. Canal que mistura
sinal com anúncio pago sem avisar perde a audiência de uma vez — e ela não volta.

---

## Medindo o que funciona

O Telegram não informa cliques em botão inline. Sem medição você não sabe qual alavanca
paga, e vai otimizar no escuro.

Solução barata: um redirecionador seu no meio do caminho.

```
https://seu-dominio.com/r/trade?to=<url-real>&t=<token>
```

Registra o clique e faz 302 para o destino. Aí `template` aponta para o seu redirecionador,
e você passa a ver quais tokens, horários e formatos de alerta geram clique. Um Cloudflare
Worker resolve isso em algumas dezenas de linhas.

---

## O que não fazer

- **Não alerte token que não dá para vender sem dizer isso.** Os bots já exibem liquidez de
  saída separada e avisam quando o pool não tem contraparte. É tentador esconder — o alerta
  fica mais bonito e gera mais clique. Também destrói o canal em uma semana.
- **Não afrouxe os limiares para publicar mais.** O teto de alertas por hora existe por
  causa disso: canal que dispara demais é silenciado, e canal silenciado não gera clique
  nem comissão. Mais alerta ≠ mais receita.
- **Não omita que os links são afiliados.** Uma linha no `/start` e na descrição do canal
  basta. Além de ser o certo, é o que evita o problema no dia em que alguém percebe.
- **Não prometa retorno.** Todo alerta já sai com "Não é recomendação de investimento".
  Mantenha.
