// Conteudo do no Code "Executar recibos" (workflow nativo n8n)
// Le config no servidor, busca mensagens do grupo (Evolution), busca debitos
// nao-classificados (Supabase), correlaciona e (se REAL) classifica + notifica.
// Retorna um resumo SEM segredos. Custo: ZERO.
//
// REAL: false = simulacao (nao grava, nao envia) | true = producao

const REAL = false;

const http  = require('http');
const https = require('https');
const fs    = require('fs');

const BASE = '/home/node/.n8n';
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(BASE + '/sicoob_config.json', 'utf8'));
} catch (e) {
  return [{ json: { erro: 'nao_leu_config: ' + e.message } }];
}
const DONE_FILE = BASE + '/sicoob_recibos_feitos.json';

function loadDone() { try { return JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')); } catch { return []; } }
function saveDone(arr) { try { fs.writeFileSync(DONE_FILE, JSON.stringify(arr.slice(-500))); } catch {} }

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function toks(s) {
  const STOP = new Set(['de','do','da','dos','das','em','no','na','nos','nas','para','por','com','pix','bra','ltda','eireli','me','sa','epp','the']);
  return norm(s).split(' ').filter(t => t.length > 2 && !STOP.has(t));
}
function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  return a.filter(t => setB.has(t)).length / Math.min(a.length, b.length);
}

const CATS = {
  'Refeição/Alimentação': ['almoco','almoço','jantar','cafe','café','lanche','refeicao','refeição','restaurante','padaria','panificad','panificadora','lanchonete','pizza','sushi','churrasco','marmita','comida','alimentacao','alimentação','sorvete','acai','açaí'],
  'Combustível': ['gasolina','etanol','combustivel','combustível','posto','abastecimento','abasteci','shell','ipiranga'],
  'Material/Papelaria': ['material','papelaria','impressao','impressão','copia','cópia','xerox','cartuchos','toner'],
  'Cartório/Taxas': ['cartorio','cartório','taxa','registro','averbacao','averbação','certidao','certidão'],
  'Transporte': ['uber','taxi','táxi','estacionamento','pedagio','pedágio','passagem','onibus'],
  'Software/Assinatura': ['megazap','software','assinatura','plano','licenca','licença','openai','chatgpt'],
};
function detectCat(text) {
  const n = norm(text);
  for (const [cat, kws] of Object.entries(CATS))
    for (const kw of kws) if (n.includes(norm(kw))) return cat;
  return null;
}
function detectPeople(text) {
  const n = norm(text); const f = new Set();
  if (n.includes('rogerio') || n.includes('rogério') || n.includes('rog ')) f.add('Rogério');
  if (n.includes('claudemir') || n.includes('clau ')) f.add('Claudemir');
  return [...f];
}
function extractVal(text) {
  const m = text.match(/R\$\s*([\d.,]+)/i);
  if (!m) return null;
  return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
}

function req(url, opts, body) {
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return fail(new Error(res.statusCode + ' ' + d.substring(0, 200)));
        try { ok(JSON.parse(d)); } catch { ok(d); }
      });
    });
    r.on('error', fail);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function fetchGroupMsgs(maxPages) {
  const all = [];
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (let pg = 1; pg <= (maxPages || 5); pg++) {
    const url = CFG.evo_url + '/chat/findMessages/' + CFG.evo_instance;
    const data = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.evo_apikey } },
      JSON.stringify({ where: { key: { remoteJid: CFG.grupo_financeiro } }, page: pg, offset: 50 }));
    const msgs = Array.isArray(data) ? data : (data.messages || data.records || []);
    if (!msgs.length) break;
    for (const m of msgs) {
      const ts = (m.messageTimestamp || 0) * 1000;
      if (ts < cutoff) continue;
      if (m.key && m.key.fromMe) continue;
      const text =
        (m.message && m.message.conversation) ||
        (m.message && m.message.imageMessage && m.message.imageMessage.caption) ||
        (m.message && m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
        (m.message && m.message.videoMessage && m.message.videoMessage.caption) ||
        (m.message && m.message.documentMessage && m.message.documentMessage.caption) || '';
      if (!text || text.length < 4) continue;
      all.push({ id: m.key && m.key.id, sender: m.pushName || '?', ts, text });
    }
  }
  return all;
}

async function fetchUnclassified() {
  const d = new Date(); d.setDate(d.getDate() - 3);
  const desde = d.toISOString().slice(0, 10);
  const qs = new URLSearchParams({
    select: 'id,data,historico,valor,tipo,categoria,observacao,hora',
    tipo: 'eq.debito',
    or: '(categoria.eq.Não classificado,categoria.is.null)',
    'data': 'gte.' + desde, order: 'data.desc'
  });
  const url = CFG.supabase_url + '/rest/v1/fin_transacoes_bancarias?' + qs;
  return req(url, { method: 'GET', headers: { apikey: CFG.supabase_key, Authorization: 'Bearer ' + CFG.supabase_key, 'Content-Type': 'application/json' } });
}

function correlate(msgs, txs) {
  const matches = [];
  for (const msg of msgs) {
    const cat = detectCat(msg.text), people = detectPeople(msg.text);
    const val = extractVal(msg.text), mToks = toks(msg.text);
    if (!cat && val === null && people.length === 0) continue;
    for (const tx of txs) {
      let score = 0; const reasons = [];
      if (val !== null && Math.abs(val - Math.abs(tx.valor)) < 0.02) { score += 5; reasons.push('valor'); }
      const tToks = toks([tx.observacao || '', tx.historico || ''].join(' '));
      const ov = overlap(mToks, tToks);
      if (ov >= 0.25) { score += Math.round(ov * 4); reasons.push('local=' + ov.toFixed(2)); }
      const txDate = new Date(tx.data + 'T' + (tx.hora || '12:00') + ':00-03:00').getTime();
      const diffH = Math.abs(msg.ts - txDate) / 3600000;
      if (diffH <= 6) { score += 2; reasons.push('tempo'); } else if (diffH <= 12) { score += 1; reasons.push('tempo'); }
      if (cat) { score += 1; reasons.push('cat'); }
      if (score >= 4) matches.push({ tx, msg, cat, people, score, reasons: reasons.join(',') });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const used = new Set();
  return matches.filter(m => { if (used.has(m.tx.id)) return false; used.add(m.tx.id); return true; });
}

async function classify(match) {
  const { tx, cat, people, msg } = match;
  const categoria = cat || 'Despesa operacional';
  const quem = people.length ? people.join(' e ') : msg.sender;
  const body = { categoria, tipo_categoria: 'Despesa', status: 'classificado' };
  const url = CFG.supabase_url + '/rest/v1/fin_transacoes_bancarias?id=eq.' + tx.id;
  await req(url, { method: 'PATCH', headers: { apikey: CFG.supabase_key, Authorization: 'Bearer ' + CFG.supabase_key, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }, JSON.stringify(body));
  return { categoria, quem, nota: msg.text.substring(0, 120) };
}

async function sendMsg(text) {
  const url = CFG.evo_url + '/message/sendText/' + CFG.evo_instance;
  return req(url, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.evo_apikey } },
    JSON.stringify({ number: CFG.grupo_financeiro, text }));
}

async function main() {
  const out = { real: REAL, ts: new Date().toISOString(), msgsTotal: 0, msgsNovas: 0, txsNaoClassif: 0, matches: [], erros: [] };
  const done = loadDone(); const doneSet = new Set(done);

  let msgs;
  try { msgs = await fetchGroupMsgs(5); } catch (e) { out.erros.push('evolution: ' + e.message); return out; }
  out.msgsTotal = msgs.length;
  msgs = msgs.filter(m => m.id && !doneSet.has(m.id));
  out.msgsNovas = msgs.length;
  if (!msgs.length) return out;

  let txs;
  try { txs = await fetchUnclassified(); } catch (e) { out.erros.push('supabase: ' + e.message); return out; }
  if (!Array.isArray(txs)) txs = [];
  out.txsNaoClassif = txs.length;
  if (!txs.length) { msgs.forEach(m => done.push(m.id)); saveDone(done); return out; }

  const matches = correlate(msgs, txs);
  for (const m of matches) {
    const v = Math.abs(m.tx.valor);
    const rec = { txId: m.tx.id, valor: v, data: m.tx.data, hist: m.tx.historico, obs: m.tx.observacao,
      categoria: m.cat || 'Despesa operacional', quem: (m.people.length ? m.people.join(' e ') : m.msg.sender),
      legenda: m.msg.text.substring(0, 80), score: m.score, motivos: m.reasons, gravado: false };
    if (REAL) {
      try {
        const r = await classify(m);
        rec.gravado = true;
        const txt = ['📋 Classificado pelo grupo', '💰 R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ' (' + m.tx.data + ')',
          '📝 ' + (m.tx.historico || m.tx.observacao || ''), '🏷️ ' + r.categoria, '👤 Justificado por ' + r.quem, '💬 "' + r.nota + '"'].join('\n');
        try { await sendMsg(txt); } catch (e) { out.erros.push('envio: ' + e.message); }
      } catch (e) { out.erros.push('classify tx ' + m.tx.id + ': ' + e.message); }
    }
    out.matches.push(rec);
  }
  for (const m of msgs) { if (m.id) done.push(m.id); }
  saveDone(done);
  return out;
}

return [{ json: await main() }];
