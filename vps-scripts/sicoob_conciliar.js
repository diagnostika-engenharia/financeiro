'use strict';
// ====== FASE R — CONCILIACAO: credito do extrato -> baixa em contas a receber ======
// Fecha o furo entre CLASSIFICAR (sicoob_classify/ai ja fazem) e CONCILIAR (ninguem fazia):
// um PIX podia estar classificado no condominio certo e as contas continuarem "Vencido" no app.
//
// Casa (a) 1 credito <-> 1 conta de valor exato e (b) 1 credito <-> N contas do MESMO cliente
// cuja SOMA bate o valor (pagamento agrupado: 4x 2.950 = 11.800 do Monte Carlo, 23/07/2026).
// (c) soma nao bate -> NAO baixa, pergunta no grupo. (d) combinacoes ambiguas -> pergunta.
//
// ATENCAO AOS DOIS FORMATOS DE VALOR:
//   fin_transacoes_bancarias.valor  = REAIS   (11800.00)
//   fin_contas_receber.valor        = CENTAVOS (295000)
// Tudo aqui e comparado em CENTAVOS.
//
// Roda em SIMULACAO por padrao; so grava/avisa com REAL=1.
// Estorno: node sicoob_conciliar.js --estornar <id_transacao>  (REAL=1 para efetivar)
const https = require('https');
const http = require('http');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace('https://', '');
const SB_KEY = CFG.supabase_key;
const EVO_HOST = (CFG.evo_url || '').replace('http://', '').replace('https://', '');
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const GRUPO = CFG.grupo_financeiro;
const REAL = process.env.REAL === '1';
const DIAS = parseInt(process.env.DIAS || '90');
const MAX_CONTAS_COMB = 20; // acima disso nao tenta combinar (explosao) -> pergunta
const ONLY_ID = process.env.ONLY_ID ? parseInt(process.env.ONLY_ID) : null; // limita a 1 credito (1a rodada supervisionada)

function reqJSON(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const r = lib.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(25000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
function sb(method, path, body) {
  const h = { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY };
  if (body) { h['Content-Type'] = 'application/json'; h['Prefer'] = 'return=representation'; h['Content-Length'] = Buffer.byteLength(body); }
  return reqJSON({ hostname: SB_HOST, port: 443, method, path, headers: h }, body);
}
async function enviarWhatsapp(texto) {
  const p = EVO_HOST.split(':'); const payload = JSON.stringify({ number: GRUPO, text: texto });
  return reqJSON({ _http: true, hostname: p[0], port: parseInt(p[1] || '8080'), method: 'POST', path: '/message/sendText/' + EVO_INSTANCE, headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload);
}
function fmtBR(n) { return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtCent(c) { return fmtBR(c / 100); }
function fmtDataBR(d) { const p = String(d).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

// mesmo vocabulario da Fase A (sicoob_classify.js) para casar cliente pelo texto do extrato
const STOP = new Set(['RESIDENCIAL', 'EDIFICIO', 'CONDOMINIO', 'COND', 'ED', 'RECEBIMENTO', 'PIX', 'OUTRA', 'IF', 'TRANSFERENCIA', 'REM', 'CRED', 'TRANSF', 'CONTAS', 'INTERCREDIS', 'RECEB', 'EMIT', 'DA', 'DE', 'DO', 'DOS', 'DAS', 'E', 'PAGAMENTO', 'EMITIDO', 'REEMBOLSO', 'JUNHO', 'JULHO', 'MAIO', 'ABRIL', 'MARCO', 'JANEIRO', 'FEVEREIRO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO']);
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function toks(s) { return norm(s).split(' ').filter(t => t.length >= 3 && !STOP.has(t)); }
function score(clienteTokens, textoTokens) {
  if (!clienteTokens.length) return 0;
  return clienteTokens.filter(t => textoTokens.includes(t)).length / clienteTokens.length;
}
// competencia (MARCO/2026) extraida da descricao — e o que distingue 4 contas de mesmo valor
function competencia(r) {
  const m = String(r.descricao || '').match(/Compet[eê]ncia de refer[eê]ncia:\s*([^\n(]+)/i);
  return m ? m[1].trim().replace(/\.$/, '') : (r.data_vencimento ? 'venc ' + fmtDataBR(r.data_vencimento) : '');
}

// ====== combinacao de contas que soma o valor do credito ======
// Solucoes sao consideradas DISTINTAS pelo MULTISET DE VALORES, nao pelas linhas.
// 4 contas de 2.950 somando 5.900 = 6 subconjuntos, mas 1 so multiset {2950,2950}:
// isso NAO e ambiguidade (a regra "mais antigas primeiro" resolve qual instancia baixar).
// Ja {2950+1750} vs {4700} sao multisets diferentes -> ambiguo -> pergunta.
function solucoes(contas, alvoCent) {
  const porValor = new Map();
  for (const r of contas) { const v = Math.round(+r.valor); if (!porValor.has(v)) porValor.set(v, []); porValor.get(v).push(r); }
  // cada grupo ordenado da mais antiga p/ mais nova (vencimento, depois id)
  for (const arr of porValor.values()) arr.sort((a, b) => String(a.data_vencimento || '').localeCompare(String(b.data_vencimento || '')) || (a.id - b.id));
  const valores = [...porValor.keys()].sort((a, b) => a - b);
  const out = [];
  (function rec(i, resto, escolha) {
    if (out.length > 8) return;               // ja e ambiguo demais, nao precisa enumerar tudo
    if (resto === 0) { out.push(escolha.slice()); return; }
    if (i >= valores.length || resto < 0) return;
    const v = valores[i], max = Math.min(porValor.get(v).length, Math.floor(resto / v));
    for (let q = max; q >= 0; q--) {          // maior quantidade primeiro: prefere quitar mais parcelas
      escolha.push([v, q]);
      rec(i + 1, resto - v * q, escolha);
      escolha.pop();
    }
  })(0, alvoCent, []);
  // materializa cada solucao nas linhas concretas (as mais antigas de cada valor)
  return out.map(sol => sol.filter(([, q]) => q > 0).flatMap(([v, q]) => porValor.get(v).slice(0, q)))
            .filter(linhas => linhas.length > 0);
}
function chaveMultiset(linhas) { return linhas.map(r => Math.round(+r.valor)).sort((a, b) => a - b).join('+'); }

// ====== ESTORNO ======
async function estornar(txId) {
  const cr = JSON.parse((await sb('GET', '/rest/v1/fin_contas_receber?select=id,cliente,valor,descricao&transacao_id=eq.' + txId)).body) || [];
  console.log('=== ESTORNO da transacao ' + txId + ' ' + (REAL ? '(REAL)' : '(SIMULACAO)') + ' — contas vinculadas: ' + cr.length + ' ===');
  for (const r of cr) console.log('  - conta ' + r.id + ' | ' + r.cliente + ' | R$ ' + fmtCent(+r.valor) + ' | ' + competencia(r));
  if (!cr.length) { console.log('  nada a estornar.'); return; }
  if (!REAL) { console.log('SIMULACAO: nada gravado.'); return; }
  await sb('PATCH', '/rest/v1/fin_contas_receber?transacao_id=eq.' + txId, JSON.stringify({ status: 'Pendente', data_recebimento: null, transacao_id: null }));
  await sb('PATCH', '/rest/v1/fin_transacoes_bancarias?id=eq.' + txId, JSON.stringify({ status: 'classificado', conta_receber_id: null }));
  console.log('  estornado: ' + cr.length + ' conta(s) voltaram a Pendente.');
}

(async () => {
  const argEst = process.argv.indexOf('--estornar');
  if (argEst > -1) return estornar(parseInt(process.argv[argEst + 1]));

  const now = new Date();
  const desde = new Date(now.getTime() - DIAS * 86400 * 1000).toISOString().slice(0, 10);
  const ASKED_FILE = '/home/node/.n8n/sicoob_conciliar_perguntados.json';
  let _asked = []; try { _asked = JSON.parse(fs.readFileSync(ASKED_FILE, 'utf8')) || []; } catch (e) {}
  const askedSet = new Set(_asked);

  // Creditos ainda NAO conciliados — de proposito SEM filtrar por categoria:
  // e justamente o credito ja classificado (status='classificado') que a Fase A deixava passar.
  const creditos = JSON.parse((await sb('GET',
    '/rest/v1/fin_transacoes_bancarias?select=id,data,hora,valor,historico,observacao,categoria,condominio,status,conta_receber_id' +
    '&origem_arquivo=eq.sicoob_api&tipo=eq.credito&conta_receber_id=is.null&status=neq.conciliado&data=gte.' + desde + '&order=data')).body) || [];
  const receber = JSON.parse((await sb('GET',
    '/rest/v1/fin_contas_receber?select=id,cliente,categoria,descricao,valor,data_vencimento,status,estornado' +
    '&status=eq.Pendente&estornado=eq.false&order=data_vencimento')).body) || [];

  console.log('=== FASE R: CONCILIACAO ' + (REAL ? '(REAL)' : '(SIMULACAO)') + ' — creditos em aberto: ' + creditos.length + ' | contas a receber pendentes: ' + receber.length + ' ===');

  const usadas = new Set();
  let baixados = 0, contasBaixadas = 0, perguntas = 0;

  for (const c of creditos) {
    if (ONLY_ID && c.id !== ONLY_ID) continue;
    const alvo = Math.round((+c.valor) * 100);
    const texto = toks((c.observacao || '') + ' ' + (c.historico || ''));
    const desc = (c.observacao || c.historico || '').replace(/\s+/g, ' ').slice(0, 60);

    // ART nao entra aqui: quem casa ART e a Fase A2 (valor+tempo contra robo_art_estado).
    // Sem este corte, um PIX de ART de morador herda o condominio gravado pela A2 e o
    // conciliador tenta casa-lo com a assessoria do condominio (falso positivo).
    if (/ART/i.test(c.tipo_servico || '') || /ART/i.test(c.categoria || '')) continue;

    // --- 1. identificar o CLIENTE ---
    // preferencia: condominio ja classificado na transacao; senao, nome do pagador no texto do extrato
    const disp = receber.filter(r => !usadas.has(r.id));
    const grupos = new Map();
    for (const r of disp) { if (!grupos.has(r.cliente)) grupos.set(r.cliente, []); grupos.get(r.cliente).push(r); }
    let cliente = null, via = null;
    if (c.condominio) {
      for (const nome of grupos.keys()) {
        const a = toks(nome), b = toks(c.condominio);
        if (a.length && b.length && (score(a, b) >= 0.6 || score(b, a) >= 0.6)) { cliente = nome; via = 'condominio classificado'; break; }
      }
    }
    if (!cliente) {
      let best = null;
      for (const nome of grupos.keys()) { const s = score(toks(nome), texto); if (s >= 0.6 && (!best || s > best.s)) best = { nome, s }; }
      if (best) { cliente = best.nome; via = 'nome no extrato (score ' + best.s.toFixed(2) + ')'; }
    }
    if (!cliente) { console.log('  · R$ ' + fmtBR(+c.valor) + ' | ' + desc + ' -> cliente nao identificado, ignoro'); continue; }

    const contas = grupos.get(cliente);
    if (contas.length > MAX_CONTAS_COMB) { console.log('  ! ' + cliente + ' tem ' + contas.length + ' contas pendentes, acima do limite de combinacao'); continue; }

    // --- 2/3. combinacao exata (1<->1 e 1<->N) ---
    const sols = solucoes(contas, alvo);
    const chaves = new Set(sols.map(chaveMultiset));

    if (sols.length === 1 || (sols.length > 1 && chaves.size === 1)) {
      // solucao unica (ou varias instancias do MESMO multiset) -> baixa as mais antigas
      const linhas = sols[0];
      baixados++; contasBaixadas += linhas.length;
      console.log('  ✓ R$ ' + fmtBR(+c.valor) + ' ' + fmtDataBR(c.data) + (c.hora ? ' ' + c.hora : '') + ' | ' + desc);
      console.log('      => ' + cliente + ' (' + via + ') · ' + linhas.length + ' conta(s):');
      for (const r of linhas) console.log('         #' + r.id + ' R$ ' + fmtCent(+r.valor) + ' · venc ' + fmtDataBR(r.data_vencimento) + ' · ' + competencia(r));
      if (REAL) {
        for (const r of linhas) {
          await sb('PATCH', '/rest/v1/fin_contas_receber?id=eq.' + r.id, JSON.stringify({ status: 'Recebido', data_recebimento: c.data, forma_pagamento: 'PIX', transacao_id: c.id }));
          usadas.add(r.id);
        }
        await sb('PATCH', '/rest/v1/fin_transacoes_bancarias?id=eq.' + c.id, JSON.stringify({ status: 'conciliado', conta_receber_id: linhas[0].id }));
        const det = linhas.map(r => '   • R$ ' + fmtCent(+r.valor) + ' — ' + competencia(r));
        const msg = ['✅ Baixa automática em contas a receber',
          '🏢 ' + cliente,
          '💰 R$ ' + fmtBR(+c.valor) + ' · ' + fmtDataBR(c.data) + (c.hora ? ' ' + c.hora : ''),
          (linhas.length > 1 ? '🧾 Pagamento agrupado — ' + linhas.length + ' contas quitadas:' : '🧾 Conta quitada:')]
          .concat(det, ['(soma exata; transação conciliada)']).join('\n');
        try { await enviarWhatsapp(msg); await new Promise(s => setTimeout(s, 1200)); } catch (e) { console.error('  msg falhou: ' + e.message); }
      } else {
        for (const r of linhas) usadas.add(r.id); // simulacao: evita reusar a mesma conta em 2 creditos
      }
      continue;
    }

    // --- 4/5. nao bate (c) ou ambiguo (d) -> NUNCA baixa, pergunta no grupo ---
    // Filtro de ruido: credito MENOR que a menor conta em aberto nao paga nem a mais barata
    // delas — quase sempre e outra receita (ART, vistoria, reembolso). Fica em silencio.
    const menorConta = Math.min(...contas.map(r => Math.round(+r.valor)));
    if (!sols.length && alvo < menorConta) {
      console.log('  · R$ ' + fmtBR(+c.valor) + ' | ' + desc + ' -> abaixo da menor conta de ' + cliente + ' (R$ ' + fmtCent(menorConta) + '), nao e assessoria; ignoro');
      continue;
    }
    perguntas++;
    let linhasMsg;
    if (!sols.length) {
      const total = contas.reduce((s, r) => s + Math.round(+r.valor), 0);
      console.log('  ? R$ ' + fmtBR(+c.valor) + ' | ' + desc + ' => ' + cliente + ': nenhuma combinacao soma exato (pendente total R$ ' + fmtCent(total) + ') -> perguntar');
      const cands = contas.slice(0, 5).map(r => '   • #' + r.id + ' R$ ' + fmtCent(+r.valor) + ' — ' + competencia(r));
      linhasMsg = ['🔎 Recebimento a conciliar (não dei baixa)',
        '🏢 ' + cliente, '💰 R$ ' + fmtBR(+c.valor) + ' · ' + fmtDataBR(c.data) + (c.hora ? ' ' + c.hora : ''),
        'Nenhuma combinação das contas em aberto soma esse valor exato (total pendente R$ ' + fmtCent(total) + '). Contas em aberto:']
        .concat(cands, ['Quais devo baixar? Responda em cima desta mensagem.']);
    } else {
      console.log('  ? R$ ' + fmtBR(+c.valor) + ' | ' + desc + ' => ' + cliente + ': ' + chaves.size + ' combinacoes possiveis -> perguntar');
      const opts = [...chaves].slice(0, 4).map((k, i) => '   ' + (i + 1) + ') ' + k.split('+').map(v => 'R$ ' + fmtCent(+v)).join(' + '));
      linhasMsg = ['🔎 Recebimento a conciliar (não dei baixa)',
        '🏢 ' + cliente, '💰 R$ ' + fmtBR(+c.valor) + ' · ' + fmtDataBR(c.data) + (c.hora ? ' ' + c.hora : ''),
        'Mais de uma combinação de contas fecha esse valor — qual é?']
        .concat(opts, ['Responda em cima desta mensagem.']);
    }
    if (REAL) {
      if (askedSet.has(c.id)) { perguntas--; continue; }   // idempotente: nao repete a pergunta
      try { await enviarWhatsapp(linhasMsg.join('\n')); await new Promise(s => setTimeout(s, 1200)); } catch (e) {}
      askedSet.add(c.id); try { fs.writeFileSync(ASKED_FILE, JSON.stringify([...askedSet])); } catch (e) {}
    }
  }

  console.log((REAL ? 'Creditos conciliados' : 'Creditos conciliariam') + ': ' + baixados + ' | contas baixadas: ' + contasBaixadas + ' | perguntas: ' + perguntas);
  if (!REAL) console.log('SIMULACAO: nada gravado nem enviado.');
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });
