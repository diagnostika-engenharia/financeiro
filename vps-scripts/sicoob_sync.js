'use strict';
const https = require('https');
const fs = require('fs');
const querystring = require('querystring');
const http = require('http');

// ---- Config (lida de arquivos, nunca inline) ----
const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const cert = fs.readFileSync('/home/node/.n8n/sicoob_cert.pem');
const key = fs.readFileSync('/home/node/.n8n/sicoob_key.pem');
const CLIENT_ID = CFG.client_id;
const CONTA = CFG.conta;
const CONTA_LABEL = CFG.conta_label;
const SB_HOST = CFG.supabase_url.replace('https://', '');
const SB_KEY = CFG.supabase_key;
const EVO_HOST = (CFG.evo_url || '').replace('http://', '').replace('https://', ''); // ex evolution:8080
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const GRUPO = CFG.grupo_financeiro;
// Corte por data do AVISO no grupo: transacoes com data ANTERIOR ao corte continuam
// sincronizando/entrando no banco normalmente, mas NAO geram mensagem no grupo (evita
// re-postar o backlog antigo enquanto o financeiro organiza os lancamentos). Override por
// env NOTIFY_CUTOFF ou CFG.notify_cutoff. Formato ISO 'YYYY-MM-DD' (comparacao lexicografica).
const NOTIFY_CUTOFF = process.env.NOTIFY_CUTOFF || CFG.notify_cutoff || '2026-08-28';

const DRY_RUN = process.env.DRY_RUN === '1';   // nao grava, nao envia
const SILENT = process.env.SILENT === '1';     // grava, mas NAO envia WhatsApp
const TESTMSG = process.env.TESTMSG === '1';   // so envia 1 mensagem de teste e sai
const BACKFILL = process.env.BACKFILL === '1'; // so atualiza 'observacao' das ja existentes e sai

function httpsReq(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const req = lib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout ' + opts.hostname)); });
    if (data) req.write(data);
    req.end();
  });
}

function exHash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return 'sic' + (h >>> 0).toString(16); }
function fmtBR(n) { return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtData(d) { const p = d.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
// "Recebimento Pix|@NOME|@DOC|@" -> "Recebimento Pix · NOME · DOC"
function parseDetalhe(s) { if (!s) return ''; return String(s).split('|').map(x => x.replace(/^@/, '').trim()).filter(Boolean).join(' · '); }

async function enviarWhatsapp(texto) {
  const parts = EVO_HOST.split(':');
  const payload = JSON.stringify({ number: GRUPO, text: texto });
  const r = await httpsReq({
    _http: true, hostname: parts[0], port: parseInt(parts[1] || '8080'), method: 'POST',
    path: '/message/sendText/' + EVO_INSTANCE,
    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, payload);
  return r.status;
}

const PENDQ = '/home/node/.n8n/sicoob_msgs_pendentes.json';
function loadQ() { try { return JSON.parse(fs.readFileSync(PENDQ, 'utf8')) || []; } catch (e) { return []; } }
function saveQ(q) { try { fs.writeFileSync(PENDQ, JSON.stringify(q)); } catch (e) {} }
async function flushQ() {
  const q = loadQ(); if (!q.length) return;
  const rest = [];
  for (const m of q) { try { const st = await enviarWhatsapp(m); if (st >= 300) rest.push(m); else await new Promise(s => setTimeout(s, 1200)); } catch (e) { rest.push(m); } }
  saveQ(rest);
  console.log('Fila de avisos: reenviados ' + (q.length - rest.length) + ', pendentes ' + rest.length);
}

function montarMensagem(r) {
  const entrada = r.tipo === 'credito';
  const linhas = [
    (entrada ? '🟢 Entrada — Sicoob' : '🔴 Saida — Sicoob'),
    '📅 ' + fmtData(r.data) + (r.hora ? ' às ' + r.hora : ''),
    '💰 R$ ' + fmtBR(r.valor),
    '📝 ' + r.historico
  ];
  if (r.observacao) linhas.push('👤 ' + r.observacao);
  linhas.push('🏷️ A classificar no sistema');
  return linhas.join('\n');
}

async function getToken() {
  const tokenBody = querystring.stringify({ grant_type: 'client_credentials', client_id: CLIENT_ID, scope: 'cco_consulta' });
  const tr = await httpsReq({
    hostname: 'auth.sicoob.com.br', port: 443, method: 'POST',
    path: '/auth/realms/cooperado/protocol/openid-connect/token',
    cert, key,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) }
  }, tokenBody);
  if (tr.status !== 200) throw new Error('token status ' + tr.status + ': ' + tr.body.slice(0, 200));
  return JSON.parse(tr.body).access_token;
}

async function getExtrato(token, mes, ano) {
  const er = await httpsReq({
    hostname: 'api.sicoob.com.br', port: 443, method: 'GET',
    path: '/conta-corrente/v4/extrato/' + mes + '/' + ano + '?numeroContaCorrente=' + CONTA + '&pagina=0&tamanhoPagina=100',
    cert, key,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'client_id': CLIENT_ID }
  });
  if (er.status !== 200) throw new Error('extrato status ' + er.status + ': ' + er.body.slice(0, 200));
  return (JSON.parse(er.body).resultado) || {};
}

// Chave natural DETERMINISTICA de uma transacao (SO campos IMUTAVEIS do extrato).
// NAO usa transactionId: o Sicoob REGENERA o transactionId a cada poll, entao usa-lo
// como identidade fazia a mesma transacao entrar de novo com hash diferente => duplicatas.
// NAO usa observacao: os scripts de classificacao (classify/ai) ENRIQUECEM a observacao
// depois ("Baixa NF...", "Classificado: ...") — incluir esse campo mutavel na chave faria
// a mesma transacao "mudar de identidade" apos enriquecida e ser reinserida => duplicatas.
function natKeyStr(data, hora, valor, tipoCD, historico) {
  return data + '|' + (hora || '') + '|' + Number(valor).toFixed(2) + '|' + tipoCD + '|' + (historico || '').trim();
}

function mapRow(t) {
  const data = String(t.data || '').split('T')[0];
  const tipoCD = String(t.tipo).toUpperCase() === 'CREDITO' ? 'C' : 'D';
  const tipo = tipoCD === 'C' ? 'credito' : 'debito';
  const valor = parseFloat(String(t.valor).replace(',', '.'));
  const historico = String(t.descricao || '').trim();
  const hora = (String(t.data).split('T')[1] || '').slice(0, 5);
  const observacao = parseDetalhe(t.descInfComplementar);
  const idUnico = natKeyStr(data, hora, valor, tipoCD, historico);
  return {
    conta: CONTA_LABEL, data, historico, descricao: historico, valor, tipo,
    categoria: 'Não classificado', tipo_categoria: tipoCD === 'C' ? 'Receita' : 'Despesa',
    status: 'classificado', competencia: data.slice(0, 7), origem_arquivo: 'sicoob_api',
    observacao, hora, hash: exHash(idUnico)
  };
}

(async () => {
  if (TESTMSG) {
    const st = await enviarWhatsapp('✅ Sincronizacao automatica do extrato Sicoob ativada.\nA partir de agora cada nova transacao sera avisada aqui.');
    console.log('Teste WhatsApp status: ' + st);
    return;
  }

  await flushQ();  // reenvia avisos que falharam em execucoes anteriores

  const now = new Date();
  const mes = parseInt(process.env.MES || (now.getMonth() + 1));
  const ano = parseInt(process.env.ANO || now.getFullYear());
  const token = await getToken();
  const _res = await getExtrato(token, mes, ano);
  // busca TAMBEM o mes anterior: compras de cartao liquidam com atraso e entram no extrato do mes da compra
  const pm = mes === 1 ? 12 : mes - 1, pa = mes === 1 ? ano - 1 : ano;
  let _prevTx = [];
  try { _prevTx = ((await getExtrato(token, pm, pa)).transacoes) || []; } catch (e) { console.error('aviso: extrato mes anterior falhou: ' + e.message); }
  const transacoes = _prevTx.concat(_res.transacoes || []);
  // atualiza saldo do banco (fin_contas_bancarias, em centavos)
  try {
    const saldoCent = Math.round(parseFloat(_res.saldoAtual || '0') * 100);
    const _g = await httpsReq({ hostname: SB_HOST, port: 443, method: 'GET', path: '/rest/v1/fin_contas_bancarias?select=id&nome=eq.Sicoob%20-%20Diagn%C3%B3stika', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY } });
    const _ex = JSON.parse(_g.body);
    const _b = JSON.stringify({ saldo: saldoCent });
    if (_ex && _ex.length) { await httpsReq({ hostname: SB_HOST, port: 443, method: 'PATCH', path: '/rest/v1/fin_contas_bancarias?id=eq.' + _ex[0].id, headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal', 'Content-Length': Buffer.byteLength(_b) } }, _b); }
    else { const _i = JSON.stringify({ nome: 'Sicoob - Diagnóstika', banco: 'Sicoob', conta: CONTA_LABEL, saldo: saldoCent, ativa: true }); await httpsReq({ hostname: SB_HOST, port: 443, method: 'POST', path: '/rest/v1/fin_contas_bancarias', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal', 'Content-Length': Buffer.byteLength(_i) } }, _i); }
  } catch (e) {}
  const rows = transacoes.map(mapRow);

  // BACKFILL: atualiza 'observacao' das transacoes ja existentes (match por hash) e sai
  if (BACKFILL) {
    let ok = 0;
    for (const r of rows) {
      if (!r.observacao && !r.hora) continue;
      const body = JSON.stringify({ observacao: r.observacao, hora: r.hora });
      const up = await httpsReq({
        hostname: SB_HOST, port: 443, method: 'PATCH',
        path: '/rest/v1/fin_transacoes_bancarias?hash=eq.' + r.hash,
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal', 'Content-Length': Buffer.byteLength(body) }
      }, body);
      if (up.status < 300) ok++;
    }
    console.log('BACKFILL observacao: ' + ok + '/' + rows.length + ' atualizadas');
    return;
  }

  // Dedup em 2 camadas
  const mesIni = pa + '-' + String(pm).padStart(2, '0') + '-01';  // janela de dedup cobre mes anterior + atual
  const proxMes = mes === 12 ? (ano + 1) + '-01-01' : ano + '-' + String(mes + 1).padStart(2, '0') + '-01';
  const existResp = await httpsReq({
    hostname: SB_HOST, port: 443, method: 'GET',
    path: '/rest/v1/fin_transacoes_bancarias?select=data,hora,valor,tipo,historico,observacao,hash,origem_arquivo&data=gte.' + mesIni + '&data=lt.' + proxMes,
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  });
  const existentes = existResp.status === 200 ? JSON.parse(existResp.body) : [];
  const hashesNoDb = new Set(existentes.map(r => r.hash));
  // Chave natural de uma linha JA gravada (tipo vem como 'credito'/'debito' -> C/D).
  const natKeyRow = r => natKeyStr(r.data, r.hora, r.valor, r.tipo === 'credito' ? 'C' : 'D', r.historico);
  // Multiset por chave natural de TODAS as existentes (qualquer origem): protege as linhas
  // legadas da API (hash volatil antigo) de serem reinseridas, e preserva repeticoes legitimas
  // (2 transacoes iguais em horarios diferentes tem chave diferente -> ambas ficam) via contagem.
  const natMultiset = {};
  existentes.forEach(r => { const k = natKeyRow(r); natMultiset[k] = (natMultiset[k] || 0) + 1; });

  const novas = [];
  let pulHash = 0, pulNat = 0;
  for (const r of rows) {
    if (hashesNoDb.has(r.hash)) { pulHash++; continue; }   // caminho rapido: hash determinista ja no banco
    const k = natKeyRow(r);
    if (natMultiset[k] > 0) { natMultiset[k]--; pulNat++; continue; }  // ja existe (legado/qualquer origem)
    novas.push(r);
  }

  console.log('=== SICOOB SYNC ' + (DRY_RUN ? '(SIMULACAO)' : SILENT ? '(REAL/SILENCIOSO)' : '(REAL)') + ' — ' + mes + '/' + ano + ' ===');
  console.log('API: ' + rows.length + ' | ja nossas (hash): ' + pulHash + ' | ja no banco (chave natural): ' + pulNat + ' | NOVAS: ' + novas.length);

  if (DRY_RUN) { novas.slice(0, 5).forEach(r => console.log('  ' + r.data + ' | ' + r.tipo + ' | R$ ' + fmtBR(r.valor) + ' | ' + r.historico + (r.observacao ? ' [' + r.observacao + ']' : ''))); console.log('SIMULACAO: nada gravado.'); return; }
  if (!novas.length) { console.log('Nada novo.'); return; }

  // Grava. Dedup ja feito acima; ainda assim usa UPSERT idempotente com on_conflict=hash
  // (indice unico ux_fin_transacoes_hash) + resolution=ignore-duplicates: se por corrida/regressao
  // um hash ja existir, o banco IGNORA em vez de estourar 409 e quebrar o lote. A resposta
  // (return=representation) traz SO as linhas realmente inseridas -> avisos so p/ transacao nova.
  const payload = JSON.stringify(novas);
  const ins = await httpsReq({
    hostname: SB_HOST, port: 443, method: 'POST',
    path: '/rest/v1/fin_transacoes_bancarias?on_conflict=hash',
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=representation', 'Content-Length': Buffer.byteLength(payload) }
  }, payload);
  if (ins.status >= 300) throw new Error('insert status ' + ins.status + ': ' + ins.body.slice(0, 300));
  const inseridas = JSON.parse(ins.body);
  console.log('Inseridas: ' + inseridas.length);

  // WhatsApp (1 msg por transacao REALMENTE inserida) — pulado em modo silencioso.
  // Notifica a partir da resposta do INSERT (linhas que de fato entraram), nunca reavisa linha ja existente.
  if (SILENT) { console.log('Modo silencioso: sem WhatsApp.'); return; }
  let enviadas = 0, suprimidas = 0;
  for (const r of inseridas) {
    // CORTE POR DATA: backlog antigo (data < corte) entra no banco mas NAO posta no grupo.
    if (r.data < NOTIFY_CUTOFF) { suprimidas++; console.log('  suprimido (data ' + r.data + ' < corte ' + NOTIFY_CUTOFF + '): R$ ' + fmtBR(r.valor) + ' | ' + r.historico); continue; }
    const m = montarMensagem(r);
    try {
      const st = await enviarWhatsapp(m);
      if (st < 300) { enviadas++; } else { const q = loadQ(); q.push(m); saveQ(q); console.error('WhatsApp status ' + st + ' -> aviso enfileirado'); }
      await new Promise(res => setTimeout(res, 1200));
    }
    catch (e) { const q = loadQ(); q.push(m); saveQ(q); console.error('WhatsApp falhou (' + e.message + ') -> aviso enfileirado'); }
  }
  console.log('Mensagens enviadas: ' + enviadas + ' | suprimidas (data < ' + NOTIFY_CUTOFF + '): ' + suprimidas + ' | inseridas: ' + inseridas.length);
})().then(() => {
  try { fs.writeFileSync('/home/node/.n8n/sicoob_fails.json', '0'); } catch (e) {}
}).catch(async e => {
  console.error('FALHA: ' + e.message);
  try {
    const F = '/home/node/.n8n/sicoob_fails.json';
    let n = 0; try { n = parseInt(fs.readFileSync(F, 'utf8')) || 0; } catch (e2) {}
    n++; fs.writeFileSync(F, String(n));
    if (n === 6) { await enviarWhatsapp('⚠️ Atencao: a sincronizacao com o Sicoob esta falhando ha ~30 minutos (' + e.message + '). Vou continuar tentando e recupero as transacoes quando normalizar.'); }
  } catch (e3) {}
  process.exit(1);
});
