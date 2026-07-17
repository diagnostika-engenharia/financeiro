'use strict';
/* ===================================================================
 * FEEDER EXTRATO -> PAGAMENTO DE PROJETO
 * -------------------------------------------------------------------
 * Quando um crédito (PIX recebido) cai no extrato e casa com um projeto,
 * dá baixa sozinho: soma em receita_recebida; se quitou o contratado e o
 * projeto estava "aguardando_pagamento", move para "entregue"; grava
 * evento origem='extrato', tipo='pagamento', confirmado=FALSE (revisável)
 * e vincula o lançamento ao projeto (fin_transacoes_bancarias.projeto).
 *
 * Casamento DETERMINÍSTICO (sem IA): nome do pagador (histórico/observação
 * do extrato) casa o cliente do projeto + o valor. Ambíguo (cliente com
 * vários projetos e valor não desambigua) NÃO muda nada — vira evento de
 * revisão. Idempotente por id da transação (projeto_feeder_processados,
 * chave 'txn:<id>').
 *
 * REGRA INVIOLÁVEL: só LÊ o extrato e ESCREVE no projeto. NUNCA fala com
 * cliente, NUNCA envia nada. Todo update entra confirmado=false.
 *
 * Modos: DRY_RUN=1 (só mostra), SINCE=YYYY-MM-DD (default 45 dias).
 * Rodar dry-run: docker exec -e DRY_RUN=1 n8n-n8n-1 node /home/node/.n8n/projeto_pagamento_feeder.js
 * =================================================================== */
const https = require('https');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace(/^https?:\/\//, '');
const SB_KEY = CFG.supabase_key;                 // service_role
const DRY_RUN = process.env.DRY_RUN === '1';
const SINCE = process.env.SINCE || new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
const TOL = parseInt(process.env.TOL_CENT || '100'); // tolerância de casamento de valor (centavos)

function reqJSON(opts, data) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(30000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
function sb(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
  if (data) { h['Content-Type'] = 'application/json'; h['Prefer'] = 'return=representation'; h['Content-Length'] = Buffer.byteLength(data); }
  return reqJSON({ hostname: SB_HOST, port: 443, method, path, headers: h }, data);
}
async function sbGet(table, query) {
  const r = await sb('GET', '/rest/v1/' + table + (query ? '?' + query : ''));
  if (r.status >= 300) throw new Error(table + ' GET ' + r.status + ': ' + r.body.slice(0, 200));
  return JSON.parse(r.body);
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const cents = v => Math.round((+v || 0) * 100);
const brl = c => 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const txNat = t => (t.tipo_categoria === 'Despesa') ? 'Despesa' : (t.tipo_categoria === 'Receita') ? 'Receita' : (t.tipo === 'credito' || t.tipo === 'C') ? 'Receita' : 'Despesa';
// nome do pagador: da observação (enriquecida do WhatsApp, campos separados por ·) ou do histórico
function payerName(t) {
  const parts = String(t.observacao || '').split('·').map(s => s.trim());
  for (const p of parts) { if (/[A-Za-zÀ-ÿ]{3,}/.test(p) && !/pix|recebimento|infinitepay|jim|outra if|\d{3}/i.test(p)) return p; }
  return String(t.historico || '').replace(/PIX|RECEBIDO|RECEB|OUTRA IF|EMITIDO/ig, '').trim();
}
// tokens fortes de um nome (>=3 letras), p/ casar pagador x cliente
// stopwords: conectivos, sobrenomes comuns e termos genéricos de condomínio
// (senão "CONDOMINIO/RESIDENCIAL/EDIFICIO" casam qualquer condomínio entre si)
const NOMESTOP = new Set(['DA', 'DE', 'DO', 'DOS', 'DAS', 'E', 'SILVA', 'SANTOS',
  'CONDOMINIO', 'COND', 'CONDOMINIAL', 'EDIFICIO', 'ED', 'RESIDENCIAL', 'RES',
  'LTDA', 'ME', 'EPP', 'DIAGNOSTIKA']);
function tokens(s) { return norm(s).split(' ').filter(t => t.length >= 3 && !NOMESTOP.has(t)); }
function casaPagadorCliente(pag, cliNome) {
  const a = tokens(pag), b = tokens(cliNome);
  if (!a.length || !b.length) return 0;
  const inter = a.filter(t => b.includes(t));
  return inter.length; // nº de tokens em comum (0 = não casa)
}

(async () => {
  const [projetos, clientes, txns, procRows] = await Promise.all([
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,receita_total_centavos,receita_recebida_centavos,etiqueta_extrato,entrada_percentual,entrada_paga_em'),
    sbGet('fin_projeto_clientes', 'select=id,nome'),
    sbGet('fin_transacoes_bancarias', 'select=id,data,valor,tipo,tipo_categoria,categoria,historico,observacao,projeto&data=gte.' + SINCE + '&order=data.asc&limit=1000'),
    sbGet('projeto_feeder_processados', 'select=msg_id&limit=4000'),
  ]);
  const cliById = {}; clientes.forEach(c => cliById[c.id] = c);
  const proc = new Set(procRows.map(r => r.msg_id));
  const creditos = txns.filter(t => txNat(t) === 'Receita' && cents(t.valor) > 0);

  console.log('===== FEEDER EXTRATO->PAGAMENTO ' + (DRY_RUN ? '(DRY-RUN)' : '(AO VIVO)') + ' =====');
  console.log('Créditos no período (desde ' + SINCE + '): ' + creditos.length);

  let nBaixa = 0, nRev = 0;
  for (const t of creditos) {
    const key = 'txn:' + t.id;
    if (!DRY_RUN && proc.has(key)) continue;
    const val = cents(t.valor);
    const pag = payerName(t);

    // candidatos: projetos cujo cliente casa o pagador
    const cand = projetos.map(p => ({ p, score: casaPagadorCliente(pag, (cliById[p.cliente_id] || {}).nome) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const linha = '[' + String(t.data).slice(0, 10) + '] ' + brl(val) + ' de "' + (pag || '?').slice(0, 34) + '"';

    if (!cand.length) { continue; } // crédito não é de projeto (condomínio/ART/etc) — ignora silencioso

    // desambiguação quando o cliente tem mais de um projeto
    const clientesUnicos = [...new Set(cand.map(x => x.p.cliente_id))];
    let alvo = null, motivo = '';
    const doCliente = cand.filter(x => x.p.cliente_id === clientesUnicos[0]);
    if (clientesUnicos.length === 1 && doCliente.length === 1) {
      alvo = doCliente[0].p; motivo = 'único projeto do cliente';
    } else {
      // vários projetos do mesmo cliente (ou vários clientes): tenta pelo valor a receber, depois por aguardando_pagamento
      const pool = cand.map(x => x.p);
      const porValor = pool.filter(p => { const falta = Math.max(0, (+p.receita_total_centavos || 0) - (+p.receita_recebida_centavos || 0)); return falta > 0 && Math.abs(falta - val) <= TOL; });
      const aguardando = pool.filter(p => p.status === 'aguardando_pagamento');
      if (porValor.length === 1) { alvo = porValor[0]; motivo = 'valor casa o saldo a receber'; }
      else if (aguardando.length === 1) { alvo = aguardando[0]; motivo = 'único aguardando pagamento'; }
    }

    if (!alvo) {
      nRev++;
      console.log(linha + ' -> AMBÍGUO (' + cand.length + ' projeto(s) do(s) cliente(s) ' + clientesUnicos.map(id => (cliById[id] || {}).nome).join(', ') + ') — registra p/ revisão, não dá baixa');
      if (!DRY_RUN) {
        // nota de revisão no projeto mais provável (maior score), sem mudar status/valor
        const pv = cand[0].p;
        await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: pv.id, origem: 'extrato', confirmado: false, tipo: 'pagamento', valor_centavos: val, descricao: '(auto do extrato) possível pagamento ' + brl(val) + ' de "' + pag + '" — confira a qual projeto pertence' });
        await sb('POST', '/rest/v1/projeto_feeder_processados', { msg_id: key, autor: pag, texto: t.historico, relevante: true, n_updates: 0, resultado: { ambiguo: true, candidatos: cand.map(x => x.p.codigo || x.p.id) } });
        proc.add(key);
      }
      continue;
    }

    // aplica baixa
    const total = +alvo.receita_total_centavos || 0;
    const recebidaAntes = +alvo.receita_recebida_centavos || 0;
    const recebidaDepois = recebidaAntes + val;
    const quitou = total > 0 && recebidaDepois >= total - TOL;
    const moveEntregue = quitou && alvo.status === 'aguardando_pagamento';
    // REGRA DA ENTRADA (30% antes de começar): este pagamento atingiu o mínimo?
    const pct = +alvo.entrada_percentual || 30;
    const entradaExigida = total > 0 ? Math.round(total * pct / 100) : 0;
    const fechaEntrada = entradaExigida > 0 && !alvo.entrada_paga_em && recebidaDepois >= entradaExigida - TOL;
    nBaixa++;
    console.log(linha + ' -> BAIXA em ' + (cliById[alvo.cliente_id] || {}).nome + ' / ' + (alvo.codigo || alvo.tipo) + ' (' + motivo + '); recebido ' + brl(recebidaAntes) + ' -> ' + brl(recebidaDepois) + (total ? ' de ' + brl(total) : '') + (fechaEntrada ? ' [ENTRADA ' + pct + '% OK -> pode iniciar]' : '') + (moveEntregue ? ' [QUITADO -> entregue]' : quitou ? ' [quitado]' : '') );

    if (!DRY_RUN) {
      const patch = { receita_recebida_centavos: recebidaDepois, last_movement_at: new Date(String(t.data).slice(0, 10) + 'T12:00:00-03:00').toISOString(), origem_ultimo_update: 'extrato' };
      if (moveEntregue) patch.status = 'entregue';
      if (fechaEntrada) patch.entrada_paga_em = new Date(String(t.data).slice(0, 10) + 'T12:00:00-03:00').toISOString();
      await sb('PATCH', '/rest/v1/fin_projetos?id=eq.' + alvo.id, patch);
      alvo.receita_recebida_centavos = recebidaDepois; if (moveEntregue) alvo.status = 'entregue';
      if (fechaEntrada) alvo.entrada_paga_em = patch.entrada_paga_em;
      await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'extrato', confirmado: false, tipo: 'pagamento', valor_centavos: val, descricao: '(auto do extrato) pagamento recebido ' + brl(val) + ' de "' + pag + '"' + (moveEntregue ? ' — quitado, projeto marcado como entregue' : '') });
      if (fechaEntrada) await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'extrato', confirmado: false, tipo: 'pagamento', valor_centavos: entradaExigida, descricao: '(auto do extrato) ENTRADA de ' + pct + '% (' + brl(entradaExigida) + ') atingida — contrato liberado para iniciar' });
      // vincula o lançamento ao projeto (etiqueta) p/ a conta do projeto
      const etq = alvo.etiqueta_extrato || alvo.codigo;
      if (etq && !t.projeto) await sb('PATCH', '/rest/v1/fin_transacoes_bancarias?id=eq.' + t.id, { projeto: etq });
      await sb('POST', '/rest/v1/projeto_feeder_processados', { msg_id: key, autor: pag, texto: t.historico, relevante: true, n_updates: 1, resultado: { projeto: alvo.codigo || alvo.id, valor_centavos: val, quitou, moveEntregue } });
      proc.add(key);
    }
  }

  console.log('\n===== RESUMO: ' + creditos.length + ' créditos · ' + nBaixa + ' baixas · ' + nRev + ' p/ revisão =====');
  if (DRY_RUN) console.log('(DRY-RUN — nada foi escrito.)');
})().catch(e => { console.error('FALHA pagamento-feeder: ' + (e && e.message || e)); process.exit(1); });
