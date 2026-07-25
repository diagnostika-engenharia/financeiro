// "Montar prompt" — junta mensagens novas + transações e monta o pedido pro Gemini.
// roda uma vez (runOnceForAllItems).

const msgs = $('Filtrar novas').all().map(i => i.json);

// transações (dedup por id — Postgres pode rodar N vezes)
let txItems = $input.all().map(i => i.json);
const seen = new Set();
let txs = [];
for (const t of txItems) {
  if (t && typeof t === 'object' && ('id' in t)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id); txs.push(t);
  } else if (Array.isArray(t)) {
    for (const r of t) { if (r && !seen.has(r.id)) { seen.add(r.id); txs.push(r); } }
  }
}

const txLines = txs.slice(0, 400).map(t =>
  '#' + t.id + ' ' + t.data + ' ' + t.tipo + ' R$' + t.valor +
  ' [' + (t.categoria || 'sem categoria') + '] ' +
  ((t.historico || '') + ' ' + (t.observacao || '')).replace(/\s+/g, ' ').trim().slice(0, 60)
).join('\n');

const msgLines = msgs.map((m, i) =>
  'MSG' + (i + 1) + ' (de ' + m.sender +
  (m.quoted ? ', respondendo ao aviso: "' + m.quoted.slice(0, 140) + '"' : '') +
  '): ' + m.text
).join('\n');

const sys = [
  'Voce e o assistente financeiro da Diagnostika Engenharia, dentro do grupo de WhatsApp Financeiro. Sua funcao e ajudar Rogerio e Claudemir respondendo perguntas sobre as financas da empresa, usando os DADOS abaixo.',
  '',
  'REGRAS DE NEGOCIO:',
  '- Debito de R$ 108,39 = Taxa de ART (CREA).',
  '- Creditos de ART costumam ser R$ 300 ou R$ 350 e tem condominio/cliente.',
  '- Reembolsos (combustivel do Claudemir, apps/IAs do Rogerio) sao overhead, nao custo de projeto.',
  '- Projetos acumulam varios custos ao longo do tempo.',
  '',
  'TRANSACOES RECENTES (ultimos 45 dias) [#id data tipo valor [categoria] historico/obs]:',
  txLines || '(nenhuma)',
  '',
  'MENSAGENS NOVAS DO GRUPO:',
  msgLines,
  '',
  'INSTRUCOES: Para CADA mensagem nova, decida:',
  '- Se for PERGUNTA ou PEDIDO sobre as financas -> responda de forma curta e direta usando os dados. Some/filtre voce mesmo quando precisar (ex: total por categoria, por periodo, o que falta classificar, saldo aproximado). Se o dado nao estiver na lista, diga que nao encontrou no periodo.',
  '- Se for um COMENTARIO ou FEEDBACK sobre algo que voce respondeu antes (ex: "algumas dessas ja temos a informacao", "pode classificar essas", "isso ja resolvemos aqui") -> responda breve confirmando que entendeu e vai considerar (1 frase curta, tipo "Entendido, vou levar isso em conta." ou "Ok, fico no aguardo dessas informacoes."). Nao precisa ser longo.',
  '- Se for conversa irrelevante, bom-dia, ou claramente nao for pra voce -> NAO responda.',
  '',
  'FORMATO DA RESPOSTA: responda SEMPRE em JSON puro, sem texto fora do JSON:',
  '{"acoes":[{"tipo":"responder","texto":"..."}]}',
  '- Cada "responder" gera uma mensagem no grupo. Texto em portugues, PLANO (sem markdown, sem asteriscos), pode usar emoji.',
  '- Valores em reais com virgula (ex: R$ 1.240,00).',
  '- Se nada precisar de resposta, retorne {"acoes":[]}.'
].join('\n');

const body = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: sys }],
  response_format: { type: 'json_object' },
  temperature: 0.3
};

return [{ json: { body, _msgs: msgs.length, _txs: txs.length } }];
