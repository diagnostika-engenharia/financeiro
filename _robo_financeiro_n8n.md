# Robô financeiro no WhatsApp — como ligar no n8n

O robô responde perguntas sobre o financeiro consultando 2 funções no Supabase
(criadas por `_setup_robo_financeiro.sql`). Ele NÃO acessa as tabelas direto —
usa as funções, que já entregam tudo em reais e mastigado.

## Funções disponíveis (RPC)

Endpoint base: `https://fimmjgdwhifsrrbreche.supabase.co/rest/v1/rpc/<funcao>`

Headers (em TODAS as chamadas):
```
apikey: <SERVICE_ROLE_KEY>           ← a chave service_role (fica só no n8n)
Authorization: Bearer <SERVICE_ROLE_KEY>
Content-Type: application/json
```

### 1. fin_snapshot — visão geral do mês
`POST /rpc/fin_snapshot`  body: `{ "p_competencia": null }`  (null = mês atual; ou "2026-06")

Retorna: a_receber (pendente/vencido/próximos), a_pagar, recebido/pago do mês,
DRE por categoria (receitas, despesas, resultado), conciliação (conciliados/pendentes)
e as 20 últimas transações. → responde "como está o caixa?", "quanto tenho a receber?",
"qual o resultado de junho?", "quem está vencido?".

### 2. fin_busca_transacoes — procurar lançamento
`POST /rpc/fin_busca_transacoes`  body: `{ "p_termo": "energia", "p_limite": 30 }`

Retorna as transações que batem com o termo (no histórico ou categoria).
→ responde "quanto paguei de energia?", "recebi do Matisse?", "teve tarifa esse mês?".

## Montagem no fluxo n8n (agente de IA)

1. No workflow do WhatsApp, no nó do **AI Agent** (OpenAI), adicione 2 **Tools** do tipo
   *HTTP Request Tool*:
   - Tool `consultar_financeiro` → POST em `/rpc/fin_snapshot`, parâmetro opcional `p_competencia`.
   - Tool `buscar_lancamento` → POST em `/rpc/fin_busca_transacoes`, parâmetros `p_termo`, `p_limite`.
2. Guarde a `SERVICE_ROLE_KEY` como **Credential** do n8n (Header Auth), nunca inline.
3. System prompt sugerido para o agente:
   > Você é o assistente financeiro da Diagnóstika. Quando perguntarem sobre caixa,
   > contas a receber/pagar, resultado, DRE ou vencimentos, chame `consultar_financeiro`.
   > Para um gasto/recebimento específico, chame `buscar_lancamento`. Responda em
   > português, valores em R$, de forma curta e direta. Nunca invente números —
   > use só o que as ferramentas retornarem.

## Pendência para ativar
- Chave da **OpenAI** (já mapeada como pendente no motor n8n) — sem ela o agente de IA
  não roda. As funções do banco já estão prontas e podem ser testadas no SQL Editor:
  `select public.fin_snapshot(null);`
