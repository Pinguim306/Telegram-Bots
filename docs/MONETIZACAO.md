# Monetização

Links de referral são o caminho principal, e na Arc eles têm destino: o **GMGN** suporta a
rede e tem programa de afiliados. Isso já está configurado.

> **Nota de revisão.** Uma versão anterior deste documento afirmava que nenhuma plataforma
> de trade com afiliados rodava na Arc. Estava errado — o GMGN roda, e a correção veio do
> dono do canal, que é VIP na plataforma. O resto do documento foi reescrito a partir disso.

---

## Alavanca 1 — GMGN (configurado, ativa na mainnet)

Cada alerta publica dois links do GMGN, ambos com o referral:

| Superfície | Template |
| --- | --- |
| Página do token | `https://gmgn.ai/{chain}/token/{ref}_{token}` |
| Bot do Telegram | `https://t.me/gmgnaibot?start=i_{ref}_{chain}_{token}` |

Formatos retirados da [documentação oficial](https://docs.gmgn.ai/index/referral-link) e
**confirmados como funcionais pelo dono da conta**, que é VIP no GMGN. Vale manter os dois:
quem lê o canal no celular converte melhor no bot do que abrindo o navegador.

O link de `kind: "trade"` vai como **primeiro botão** do alerta, que é o que mais recebe clique.

### Por que eles não aparecem em testnet

Os dois estão restritos a `arc-mainnet` via `networks` em `config/referrals.json`. O GMGN
indexa mainnet; publicá-los durante a calibração em testnet geraria 404 em todo alerta. Na
testnet o alerta sai só com o explorer, e o `doctor` avisa exatamente por quê.

### Se o GMGN mudar o formato

O modo de falha aqui é traiçoeiro: um formato desatualizado **continua abrindo a página** e
só para de creditar a comissão. Você não veria erro nenhum no canal — só um extrato de
afiliado menor do que deveria, semanas depois.

Por isso `test/config.test.ts` trava a URL exata gerada a partir de `config/referrals.json`.
Editar o template sem atualizar o teste quebra o build de propósito. Se o GMGN anunciar
mudança no formato de referral, ajuste os dois juntos.

## Alavanca 2 — Tier premium (funciona no dia 1, não depende de ninguém)

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

## Alavanca 3 — Afiliado de corretora (funciona hoje, independe da Arc)

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

Complementa bem o GMGN: a comissão é recorrente sobre a taxa, em vez de por trade.

## Adicionar outra plataforma

É só editar `config/referrals.json` — nada de código:

```json
{
  "id": "outra_plataforma",
  "label": "Comprar",
  "template": "https://plataforma.com/swap?chain={chainId}&outputCurrency={token}&ref={ref}",
  "ref": "SEU_CODIGO",
  "enabled": true,
  "verified": true,
  "kind": "trade",
  "networks": ["arc-mainnet"]
}
```

Placeholders: `{token}`, `{pool}`, `{chainId}`, `{chain}`, `{explorer}`, `{ref}`.
`networks` vazio publica em todas as redes.

Quatro proteções que já estão no código:

1. Template com placeholder de exemplo não preenchido (`SUA-PLATAFORMA.com`) **não é
   publicado** — link quebrado no canal custa mais credibilidade do que vale.
2. Link de trade sem `ref` **grita no log no boot**. Esse é o pior cenário possível: você
   entrega o volume e não recebe a comissão.
3. Plataforma restrita a outra rede é **anunciada no boot e no `doctor`**, para você não
   achar que quebrou quando o link não aparece.
4. Link de `kind: "trade"` vai **como primeiro botão**, que é o que mais recebe clique.

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
