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
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_URL = CFG.supabase_url.replace(/\/$/, '');
const SB_KEY = CFG.supabase_key;                 // service_role (lido do arquivo, nunca inline)
const GRUPO_PROJETOS = '120363407925288367@g.us';
const PARADO_DIAS = parseInt(process.env.PARADO_DIAS || '7');   // limiar "parado há X dias"
const DOC_DIAS = parseInt(process.env.DOC_DIAS || '10');        // limiar doc pendente antigo
const MODO_SOMBRA = process.env.MODO_SOMBRA !== 'false';        // default: SOMBRA

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

(async () => {
  const [clientes, projetos, docs] = await Promise.all([
    sbGet('fin_projeto_clientes', 'select=id,nome'),
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,proximo_passo,proximo_passo_prazo,last_movement_at,receita_total_centavos,receita_recebida_centavos'),
    sbGet('fin_projeto_docs', 'select=id,projeto_id,item,status,pendente_desde&status=eq.pendente'),
  ]);
  const nomeCli = id => (clientes.find(c => c.id === id) || {}).nome || '?';

  // ── categorias ────────────────────────────────────────────────────
  const parados = [], aReceber = [], prazos = [], docPend = [];
  for (const p of projetos) {
    if (!ATIVO(p)) continue;
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

  const nada = !parados.length && !aReceber.length && !docPend.length && !prazos.length;
  if (nada) L.push('Nenhum projeto parado, a receber ou com prazo/doc pendente. Tudo em dia.');

  const ativos = projetos.filter(ATIVO).length;
  L.push('---');
  L.push('Projetos ativos: ' + ativos + ' · parados: ' + parados.length + ' · a receber: ' + aReceber.length + ' · docs pendentes: ' + docPend.length);

  const conteudo = L.join('\n');
  const resumo = { ativos, parados: parados.length, a_receber: aReceber.length, docs_pendentes: docPend.length, prazos: prazos.length,
    a_receber_centavos: aReceber.reduce((s, x) => s + x.falta, 0) };

  console.log('===== DIGEST GERADO (' + (MODO_SOMBRA ? 'SOMBRA' : 'REAL') + ') =====');
  console.log(conteudo);
  console.log('=====================================');

  // ── grava sempre no log de auditoria (enviado=false em sombra) ─────
  const ins = await sbREST('POST', '/rest/v1/projeto_digest_log', {
    conteudo, resumo, destino_jid: GRUPO_PROJETOS, enviado: false, origem: 'digest_sombra'
  });
  if (ins.status >= 300) throw new Error('insert log ' + ins.status + ': ' + ins.body.slice(0, 300));
  const rowId = (JSON.parse(ins.body)[0] || {}).id;
  console.log('Gravado em projeto_digest_log id=' + rowId + ' (enviado=false).');

  if (!MODO_SOMBRA) {
    // GUARD: envio real só quando o Rogério ligar (MODO_SOMBRA=false).
    // Nesta entrega NÃO ligamos — deixado explicitamente inerte para não
    // arriscar postar no grupo antes da validação. Quando for ligar,
    // implementar aqui a chamada à Evolution (sendText p/ GRUPO_PROJETOS)
    // e dar update em projeto_digest_log set enviado=true, enviado_em=now.
    console.log('[AVISO] MODO_SOMBRA=false, mas o envio real ainda nao foi ativado nesta versao. Nada enviado.');
  }
})().catch(e => { console.error('FALHA digest: ' + (e && e.message || e)); process.exit(1); });
