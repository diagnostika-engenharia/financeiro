'use strict';
/* ===================================================================
 * DIGEST DE PROJETOS — Fase 2, peça 4 — MODO SOMBRA
 * -------------------------------------------------------------------
 * Lê fin_projetos / fin_projeto_clientes / fin_projeto_docs /
 * fin_projeto_eventos (Supabase REST, service_role do sicoob_config.json)
 * e monta um resumo/cobrança INTERNA da equipe.
 *
 * SOMBRA (MODO_SOMBRA != 'false'): GRAVA o texto em projeto_digest_log
 *   com enviado=false e NÃO chama a Evolution.
 * REAL (MODO_SOMBRA=false): só então enviaria ao grupo Projetos — o
 *   Rogério liga isso depois de validar. O envio fica atrás do guard.
 *
 * REGRA INVIOLÁVEL: só LÊ e resume. NUNCA escreve em fin_projetos,
 * NUNCA muda status, NUNCA fala com cliente. Único destino: grupo
 * "Projetos - Diagnóstika" 120363407925288367@g.us.
 *
 * Rodar manual:  docker exec n8n-n8n-1 node /home/node/.n8n/projeto_digest.js
 * =================================================================== */
const https = require('https');
const http = require('http');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_URL = CFG.supabase_url.replace(/\/$/, '');
const SB_KEY = CFG.supabase_key;                 // service_role (lido do arquivo, nunca inline)
const GRUPO_PROJETOS = '120363407925288367@g.us';
const PARADO_DIAS = parseInt(process.env.PARADO_DIAS || '7');   // limiar "parado há X dias"
const DOC_DIAS = parseInt(process.env.DOC_DIAS || '10');        // limiar doc pendente antigo
const MODO_SOMBRA = process.env.MODO_SOMBRA !== 'false';        // default: SOMBRA
// PREVIEW: só monta e imprime o texto — NÃO grava no log e NÃO envia.
// (útil p/ conferir o texto sem criar registro do dia, que bloquearia o envio das 7h30)
const PREVIEW = process.env.DRY_RUN === '1' || process.env.PREVIEW === '1';

// ── REST helper (Supabase) ──────────────────────────────────────────
function sbREST(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SB_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); h['Prefer'] = 'return=representation'; }
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject); r.setTimeout(30000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
async function sbGet(table, query) {
  const r = await sbREST('GET', '/rest/v1/' + table + (query ? '?' + query : ''));
  if (r.status >= 300) throw new Error(table + ' GET ' + r.status + ': ' + r.body.slice(0, 200));
  return JSON.parse(r.body);
}

// ── Evolution (envio ao grupo Projetos — só quando MODO_SOMBRA=false) ──
// DESTINO É SEMPRE a constante GRUPO_PROJETOS. O texto vai para a EQUIPE,
// nunca para um cliente e nunca para um destino recebido de fora.
const EVO_HOST = (CFG.evo_url || '').replace(/^https?:\/\//, '');
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const EVO_EP = EVO_HOST.split(':');
function evoSendGrupoProjetos(texto) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ number: GRUPO_PROJETOS, text: texto });
    const r = http.request({
      hostname: EVO_EP[0], port: parseInt(EVO_EP[1] || '8080'),
      path: '/message/sendText/' + EVO_INSTANCE, method: 'POST',
      headers: { apikey: EVO_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(30000, () => { r.destroy(); reject(new Error('timeout evolution')); });
    r.write(data); r.end();
  });
}

// ── datas ───────────────────────────────────────────────────────────
const HOJE = new Date();
const diasDesde = iso => iso ? Math.floor((HOJE - new Date(iso)) / 86400000) : null;
const soData = iso => iso ? String(iso).slice(0, 10) : '';
function fmtDataBR(iso) { const d = soData(iso); if (!d) return ''; const [a, m, dd] = d.split('-'); return `${dd}/${m}/${a}`; }
const brl = c => 'R$ ' + ((c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TIPOS = { averbacao: 'Averbação', regularizacao: 'Regularização', anexacao: 'Anexação', habite_se: 'Habite-se',
  alvara_construcao: 'Alvará', ampliacao: 'Ampliação', infraestrutura: 'Infraestrutura', aprovacao_condominio: 'Aprov. condomínio', outro: 'Projeto' };
const ST = { levantamento: 'Levantamento', aguardando_doc: 'Aguardando doc', elaboracao: 'Elaboração', protocolo_prefeitura: 'Protocolo prefeitura',
  analise: 'Em análise', aprovado: 'Aprovado', finalizado: 'Finalizado', aguardando_pagamento: 'Aguard. pagamento', entregue: 'Entregue' };
const ATIVO = p => p.status !== 'entregue';
const rotulo = p => (p.codigo ? p.codigo : (TIPOS[p.tipo] || 'Projeto'));

// data no calendário BRT (YYYY-MM-DD), independente do fuso do host
const dateBRT = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

(async () => {
  // ── AGENDAMENTO (SCHEDULED=1): o cron do SO ignora CRON_TZ nesta máquina
  //    (roda em CEST e ainda muda no horário de verão europeu). Então o cron
  //    dispara com frequência e é ESTE guard, no relógio BRT do container, que
  //    decide a hora certa — 1x por dia útil na 1ª passagem a partir das 07:30 BRT.
  if (process.env.SCHEDULED === '1') {
    const now = new Date();                 // container TZ = America/Sao_Paulo
    const dow = now.getDay(), hh = now.getHours(), mm = now.getMinutes();
    const naJanela = dow >= 1 && dow <= 5 && (hh > 7 || (hh === 7 && mm >= 30)) && hh < 12;
    if (!naJanela) { console.log('Fora da janela (BRT ' + now.toTimeString().slice(0, 5) + ', dow ' + dow + '). Nada a fazer.'); return; }
    const ja = await sbGet('projeto_digest_log', 'select=gerado_em&order=gerado_em.desc&limit=1');
    if (ja.length && dateBRT(new Date(ja[0].gerado_em)) === dateBRT(now)) {
      console.log('Digest de hoje (' + dateBRT(now) + ' BRT) ja existe. Nada a fazer.'); return;
    }
  }

  const [clientes, projetos, docs] = await Promise.all([
    sbGet('fin_projeto_clientes', 'select=id,nome'),
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,proximo_passo,proximo_passo_prazo,last_movement_at,receita_total_centavos,receita_recebida_centavos,entrada_percentual,entrada_paga_em'),
    sbGet('fin_projeto_docs', 'select=id,projeto_id,item,status,pendente_desde&status=eq.pendente'),
  ]);
  const nomeCli = id => (clientes.find(c => c.id === id) || {}).nome || '?';

  // ── regra da entrada (30% antes de começar) ───────────────────────
  const ST_INICIADO = ['elaboracao', 'protocolo_prefeitura', 'analise', 'aprovado', 'finalizado', 'aguardando_pagamento', 'entregue'];
  const entPct = p => (+p.entrada_percentual || 30);
  const semValor = p => !((+p.receita_total_centavos || 0) > 0);
  const entExigida = p => semValor(p) ? 0 : Math.round((+p.receita_total_centavos) * entPct(p) / 100);
  const entOk = p => { const ex = entExigida(p); return ex > 0 && (!!p.entrada_paga_em || (+p.receita_recebida_centavos || 0) >= ex); };
  const entFalta = p => Math.max(0, entExigida(p) - (+p.receita_recebida_centavos || 0));

  // ── categorias ────────────────────────────────────────────────────
  const parados = [], aReceber = [], prazos = [], docPend = [], semEntrada = [], violaEntrada = [], semValorLista = [];
  for (const p of projetos) {
    if (!ATIVO(p)) continue;
    if (semValor(p)) semValorLista.push({ p });
    else if (!entOk(p)) { if (ST_INICIADO.includes(p.status)) violaEntrada.push({ p }); else semEntrada.push({ p }); }
    const dParado = diasDesde(p.last_movement_at);
    if (dParado != null && dParado >= PARADO_DIAS) parados.push({ p, dias: dParado });
    const falta = Math.max(0, (+p.receita_total_centavos || 0) - (+p.receita_recebida_centavos || 0));
    if (p.status === 'aguardando_pagamento' && falta > 0) aReceber.push({ p, falta });
    if (p.proximo_passo_prazo) {
      const dPrazo = Math.floor((new Date(p.proximo_passo_prazo) - HOJE) / 86400000);
      if (dPrazo <= 3) prazos.push({ p, dPrazo });   // vencido, hoje ou até 3 dias
    }
  }
  for (const d of docs) {
    const dias = diasDesde(d.pendente_desde);
    if (dias != null && dias >= DOC_DIAS) {
      const p = projetos.find(x => x.id === d.projeto_id);
      if (p && ATIVO(p)) docPend.push({ p, item: d.item, dias });
    }
  }
  parados.sort((a, b) => b.dias - a.dias);
  docPend.sort((a, b) => b.dias - a.dias);
  prazos.sort((a, b) => a.dPrazo - b.dPrazo);

  const linhaProj = (p, extra) => `- ${nomeCli(p.cliente_id)} · ${rotulo(p)} (${ST[p.status] || p.status})${extra ? ' — ' + extra : ''}`;

  // ── texto (plano, sem markdown) ───────────────────────────────────
  const L = [];
  L.push('Resumo dos Projetos — ' + fmtDataBR(HOJE.toISOString()));
  L.push('(uso interno da equipe · nao enviar a cliente)');
  L.push('');

  if (violaEntrada.length) {
    L.push('*** INICIADO SEM A ENTRADA DE ' + entPct(violaEntrada[0].p) + '% (regra do contrato) ***');
    violaEntrada.forEach(({ p }) => L.push(linhaProj(p, 'entrada exigida ' + brl(entExigida(p)) + ', falta ' + brl(entFalta(p)))));
    L.push('');
  }
  if (semEntrada.length) {
    let tot = 0;
    L.push('AGUARDANDO ENTRADA (nao iniciar antes de receber):');
    semEntrada.forEach(({ p }) => { tot += entFalta(p); L.push(linhaProj(p, 'entrada ' + entPct(p) + '% = ' + brl(entExigida(p)) + ', falta ' + brl(entFalta(p)))); });
    L.push('  Total de entradas a receber: ' + brl(tot));
    L.push('');
  }
  // Os valores faltantes NÃO entram aqui: viram uma mensagem-pergunta separada
  // (projeto_pergunta_valores.js). Pergunta no meio de relatório não é respondida,
  // e repetir a lista todo dia vira ruído. Aqui fica só o contador.
  if (semValorLista.length) {
    L.push(semValorLista.length + ' projeto(s) ainda sem valor de contrato (pergunto em mensagem separada).');
    L.push('');
  }
  if (parados.length) {
    L.push('PARADOS ha ' + PARADO_DIAS + '+ dias (sem movimento):');
    parados.forEach(({ p, dias }) => L.push(linhaProj(p, dias + ' dias parado' + (p.proximo_passo ? ' · proximo: ' + p.proximo_passo : ' · SEM proximo passo'))));
    L.push('');
  }
  if (aReceber.length) {
    let tot = 0;
    L.push('AGUARDANDO PAGAMENTO:');
    aReceber.forEach(({ p, falta }) => { tot += falta; L.push(linhaProj(p, 'receber ' + brl(falta))); });
    L.push('  Total a receber: ' + brl(tot));
    L.push('');
  }
  if (docPend.length) {
    L.push('DOCUMENTO pendente ha ' + DOC_DIAS + '+ dias:');
    docPend.forEach(({ p, item, dias }) => L.push(linhaProj(p, 'falta ' + item + ' (ha ' + dias + ' dias)')));
    L.push('');
  }
  if (prazos.length) {
    L.push('PRAZOS (vencidos/proximos):');
    prazos.forEach(({ p, dPrazo }) => {
      const q = dPrazo < 0 ? ('venceu ha ' + (-dPrazo) + 'd') : dPrazo === 0 ? 'vence HOJE' : ('vence em ' + dPrazo + 'd');
      L.push(linhaProj(p, (p.proximo_passo || 'proximo passo') + ' — ' + q + ' (' + fmtDataBR(p.proximo_passo_prazo) + ')'));
    });
    L.push('');
  }

  const nada = !parados.length && !aReceber.length && !docPend.length && !prazos.length && !semEntrada.length && !violaEntrada.length && !semValorLista.length;
  if (nada) L.push('Nenhum projeto parado, a receber ou com prazo/doc/entrada pendente. Tudo em dia.');

  const ativos = projetos.filter(ATIVO).length;
  L.push('---');
  L.push('Projetos ativos: ' + ativos + ' · parados: ' + parados.length + ' · a receber: ' + aReceber.length + ' · docs pendentes: ' + docPend.length
    + ' · sem entrada: ' + (semEntrada.length + violaEntrada.length) + (violaEntrada.length ? ' (' + violaEntrada.length + ' ja iniciado)' : '') + ' · sem valor: ' + semValorLista.length);

  const conteudo = L.join('\n');
  const resumo = { ativos, parados: parados.length, a_receber: aReceber.length, docs_pendentes: docPend.length, prazos: prazos.length,
    a_receber_centavos: aReceber.reduce((s, x) => s + x.falta, 0),
    sem_entrada: semEntrada.length, viola_entrada: violaEntrada.length, sem_valor: semValorLista.length,
    entrada_a_receber_centavos: semEntrada.concat(violaEntrada).reduce((s, x) => s + entFalta(x.p), 0) };

  console.log('===== DIGEST GERADO (' + (PREVIEW ? 'PREVIEW' : MODO_SOMBRA ? 'SOMBRA' : 'REAL') + ') =====');
  console.log(conteudo);
  console.log('=====================================');

  if (PREVIEW) { console.log('(PREVIEW — nada gravado no log, nada enviado ao grupo.)'); return; }

  // ── grava sempre no log de auditoria ──────────────────────────────
  const ins = await sbREST('POST', '/rest/v1/projeto_digest_log', {
    conteudo, resumo, destino_jid: GRUPO_PROJETOS, enviado: false,
    origem: MODO_SOMBRA ? 'digest_sombra' : 'digest'
  });
  if (ins.status >= 300) throw new Error('insert log ' + ins.status + ': ' + ins.body.slice(0, 300));
  const rowId = (JSON.parse(ins.body)[0] || {}).id;
  console.log('Gravado em projeto_digest_log id=' + rowId + '.');

  if (MODO_SOMBRA) {
    console.log('MODO SOMBRA: gravado com enviado=false. Nada enviado ao grupo.');
    return;
  }

  // ── ENVIO REAL ────────────────────────────────────────────────────
  // Destino é SEMPRE a constante GRUPO_PROJETOS (a equipe). NUNCA um
  // cliente, NUNCA um destino externo. O script continua só LENDO
  // fin_projetos — não muda status de nenhum projeto.
  const snd = await evoSendGrupoProjetos(conteudo);
  if (snd.status >= 300) throw new Error('Evolution sendText ' + snd.status + ': ' + snd.body.slice(0, 300));
  if (rowId) {
    await sbREST('PATCH', '/rest/v1/projeto_digest_log?id=eq.' + rowId,
      { enviado: true, enviado_em: new Date().toISOString() });
  }
  console.log('ENVIADO ao grupo Projetos (' + GRUPO_PROJETOS + '). Evolution status ' + snd.status + '.');
})().catch(e => { console.error('FALHA digest: ' + (e && e.message || e)); process.exit(1); });
