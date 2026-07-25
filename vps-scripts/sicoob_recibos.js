#!/usr/bin/env node
// sicoob_recibos.js — Leitura inteligente do grupo Financeiro
//
// Le mensagens recentes do grupo (texto + legendas de fotos) e
// correlaciona com transacoes nao-classificadas por:
//   1. Valor exato (centavos)
//   2. Tokens de local/estabelecimento
//   3. Proximidade temporal (msg perto da transacao)
//   4. Palavras-chave de categoria
//
// Custo: ZERO (Evolution API local + texto simples)
// Cron: */15 7-23 * * *
// Env: REAL=1 grava | sem = simulacao

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE = '/home/node/.n8n';
const CFG  = JSON.parse(fs.readFileSync(path.join(BASE, 'sicoob_config.json'), 'utf8'));
const DONE_FILE = path.join(BASE, 'sicoob_recibos_feitos.json');
const REAL = process.env.REAL === '1';

// ── helpers ──────────────────────────────────────────────

function loadDone() {
  try { return JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')); }
  catch { return []; }
}
function saveDone(arr) {
  fs.writeFileSync(DONE_FILE, JSON.stringify(arr.slice(-500)));
}

function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toks(s) {
  const STOP = new Set(['de','do','da','dos','das','em','no','na','nos','nas','para','por','com','pix','bra','ltda','eireli','me','sa','epp','the']);
  return norm(s).split(' ').filter(t => t.length > 2 && !STOP.has(t));
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const hit = a.filter(t => setB.has(t)).length;
  return hit / Math.min(a.length, b.length);
}

// ── categoria por palavras-chave ─────────────────────────

const CATS = {
  'Refeição/Alimentação': ['almoco','almoço','jantar','cafe','café','lanche','refeicao','refeição',
    'restaurante','padaria','lanchonete','pizza','sushi','churrasco','marmita','comida','alimentacao','alimentação','sorvete','acai','açaí'],
  'Combustível':          ['gasolina','etanol','combustivel','combustível','posto','abastecimento','abasteci','shell','ipiranga','br distribuidora'],
  'Material/Papelaria':   ['material','papelaria','impressao','impressão','copia','cópia','xerox','cartuchos','toner'],
  'Cartório/Taxas':       ['cartorio','cartório','taxa','registro','averbacao','averbação','certidao','certidão'],
  'Transporte':           ['uber','99','taxi','táxi','estacionamento','pedagio','pedágio','passagem','onibus'],
  'Software/Assinatura':  ['megazap','software','assinatura','plano','licenca','licença','openai','chatgpt'],
};

function detectCat(text) {
  const n = norm(text);
  for (const [cat, kws] of Object.entries(CATS)) {
    for (const kw of kws) {
      if (n.includes(norm(kw))) return cat;
    }
  }
  return null;
}

// ── pessoas da equipe ────────────────────────────────────

function detectPeople(text) {
  const n = norm(text);
  const found = new Set();
  if (n.includes('rogerio') || n.includes('rogério') || n.includes('rog ')) found.add('Rogério');
  if (n.includes('claudemir') || n.includes('clau '))                       found.add('Claudemir');
  return [...found];
}

// ── valor mencionado no texto ────────────────────────────

function extractVal(text) {
  const m = text.match(/R\$\s*([\d.,]+)/i);
  if (!m) return null;
  return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
}

// ── HTTP helpers (mesmo padrao dos outros scripts) ───────

function req(url, opts, body) {
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return fail(new Error(res.statusCode + ' ' + d.substring(0, 300)));
        try { ok(JSON.parse(d)); } catch { ok(d); }
      });
    });
    r.on('error', fail);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ── Evolution: buscar mensagens do grupo ─────────────────

async function fetchGroupMsgs(maxPages) {
  const all = [];
  const cutoff = Date.now() - 12 * 3600 * 1000; // ultimas 12h

  for (let pg = 1; pg <= (maxPages || 5); pg++) {
    const url = CFG.evo_url + '/chat/findMessages/' + CFG.evo_instance;
    const data = await req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.evo_apikey }
    }, JSON.stringify({
      where: { key: { remoteJid: CFG.grupo_financeiro } },
      page: pg, offset: 50
    }));

    const msgs = Array.isArray(data) ? data : (data.messages || data.records || []);
    if (!msgs.length) break;

    for (const m of msgs) {
      const ts = (m.messageTimestamp || 0) * 1000;
      if (ts < cutoff) continue;
      if (m.key && m.key.fromMe) continue; // ignorar msgs do bot

      // extrair texto (mensagem simples, legenda de foto, texto formatado)
      const text =
        (m.message && m.message.conversation) ||
        (m.message && m.message.imageMessage && m.message.imageMessage.caption) ||
        (m.message && m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
        (m.message && m.message.videoMessage && m.message.videoMessage.caption) ||
        (m.message && m.message.documentMessage && m.message.documentMessage.caption) ||
        '';

      if (!text || text.length < 4) continue;

      all.push({
        id:     m.key && m.key.id,
        sender: m.pushName || '?',
        ts,
        text
      });
    }
  }
  return all;
}

// ── Supabase: transacoes nao-classificadas ───────────────

async function fetchUnclassified() {
  const d = new Date();
  d.setDate(d.getDate() - 3); // ultimos 3 dias
  const desde = d.toISOString().slice(0, 10);

  const qs = new URLSearchParams({
    select: 'id,data,historico,valor,tipo,categoria,observacao,hora',
    tipo:   'eq.debito',
    or:     '(categoria.eq.Não classificado,categoria.is.null)',
    'data': 'gte.' + desde,
    order:  'data.desc'
  });

  const url = CFG.supabase_url + '/rest/v1/fin_transacoes_bancarias?' + qs;
  return req(url, {
    method: 'GET',
    headers: {
      apikey:        CFG.supabase_key,
      Authorization: 'Bearer ' + CFG.supabase_key,
      'Content-Type': 'application/json'
    }
  });
}

// ── correlacao ───────────────────────────────────────────

function correlate(msgs, txs) {
  const matches = [];

  for (const msg of msgs) {
    const cat    = detectCat(msg.text);
    const people = detectPeople(msg.text);
    const val    = extractVal(msg.text);
    const mToks  = toks(msg.text);

    // precisa ter pelo menos uma categoria OU um valor detectado
    if (!cat && val === null && people.length === 0) continue;

    for (const tx of txs) {
      let score = 0;
      const reasons = [];

      // 1) valor exato (centavos)
      if (val !== null && Math.abs(val - Math.abs(tx.valor)) < 0.02) {
        score += 5;
        reasons.push('valor=' + val);
      }

      // 2) tokens de local/estabelecimento
      const txText = [tx.observacao || '', tx.historico || ''].join(' ');
      const tToks  = toks(txText);
      const ov     = overlap(mToks, tToks);
      if (ov >= 0.25) {
        score += Math.round(ov * 4);
        reasons.push('tokens=' + ov.toFixed(2));
      }

      // 3) proximidade temporal (msg dentro de 6h da transacao)
      const txDate = new Date(tx.data + 'T' + (tx.hora || '12:00') + ':00-03:00').getTime();
      const diffH  = Math.abs(msg.ts - txDate) / 3600000;
      if (diffH <= 6) {
        score += 2;
        reasons.push('tempo=' + diffH.toFixed(1) + 'h');
      } else if (diffH <= 12) {
        score += 1;
        reasons.push('tempo=' + diffH.toFixed(1) + 'h');
      }

      // 4) categoria detectada = bonus
      if (cat) {
        score += 1;
        reasons.push('cat=' + cat);
      }

      // limiar: score >= 4 = match confiavel
      if (score >= 4) {
        matches.push({ tx, msg, cat, people, score, reasons: reasons.join(', ') });
      }
    }
  }

  // melhor match por transacao
  matches.sort((a, b) => b.score - a.score);
  const used = new Set();
  return matches.filter(m => {
    if (used.has(m.tx.id)) return false;
    used.add(m.tx.id);
    return true;
  });
}

// ── classificar transacao ────────────────────────────────

async function classify(match) {
  const { tx, cat, people, msg } = match;
  const categoria = cat || 'Despesa operacional';
  const nota = msg.text.substring(0, 120);
  const quem = people.length ? people.join(' e ') : msg.sender;

  const body = {
    categoria,
    tipo_categoria: 'Despesa',
    status: 'classificado'
  };

  const url = CFG.supabase_url + '/rest/v1/fin_transacoes_bancarias?id=eq.' + tx.id;
  await req(url, {
    method: 'PATCH',
    headers: {
      apikey:        CFG.supabase_key,
      Authorization: 'Bearer ' + CFG.supabase_key,
      'Content-Type': 'application/json',
      Prefer:        'return=minimal'
    }
  }, JSON.stringify(body));

  return { categoria, quem, nota };
}

// ── enviar confirmacao no grupo ──────────────────────────

async function sendMsg(text) {
  const url = CFG.evo_url + '/message/sendText/' + CFG.evo_instance;
  return req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CFG.evo_apikey }
  }, JSON.stringify({ number: CFG.grupo_financeiro, text }));
}

// ── main ─────────────────────────────────────────────────

async function main() {
  console.log('[recibos] inicio ' + new Date().toISOString() + ' REAL=' + REAL);

  const done = loadDone();
  const doneSet = new Set(done);

  // 1. buscar mensagens do grupo (ultimas 12h)
  let msgs;
  try {
    msgs = await fetchGroupMsgs(5);
  } catch (e) {
    console.error('[recibos] erro Evolution:', e.message);
    return;
  }
  console.log('[recibos] ' + msgs.length + ' msgs do grupo');

  // filtrar ja processadas
  msgs = msgs.filter(m => m.id && !doneSet.has(m.id));
  console.log('[recibos] ' + msgs.length + ' msgs novas');
  if (!msgs.length) return;

  // 2. buscar debitos nao-classificados
  let txs;
  try {
    txs = await fetchUnclassified();
  } catch (e) {
    console.error('[recibos] erro Supabase:', e.message);
    return;
  }
  if (!Array.isArray(txs)) txs = [];
  console.log('[recibos] ' + txs.length + ' debitos nao-classificados');
  if (!txs.length) { msgs.forEach(m => done.push(m.id)); saveDone(done); return; }

  // 3. correlacionar
  const matches = correlate(msgs, txs);
  console.log('[recibos] ' + matches.length + ' matches encontrados');

  for (const m of matches) {
    const v = Math.abs(m.tx.valor);
    const vFmt = 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    if (REAL) {
      const r = await classify(m);
      console.log('[recibos] CLASSIFICADO tx ' + m.tx.id + ' ' + vFmt + ' -> ' + r.categoria);

      const txt = [
        '📋 Classificado pelo grupo',
        '💰 ' + vFmt + ' (' + m.tx.data + ')',
        '📝 ' + m.tx.historico,
        '🏷️ ' + r.categoria,
        '👤 Justificado por ' + r.quem,
        '💬 "' + r.nota + '"'
      ].join('\n');

      try { await sendMsg(txt); } catch (e) { console.error('[recibos] erro envio:', e.message); }
    } else {
      console.log('[SIMUL] tx ' + m.tx.id + ' ' + vFmt + ' -> ' + (m.cat || 'Despesa op.') +
        ' (score=' + m.score + ', ' + m.reasons + ')');
    }
  }

  // marcar todas as msgs como processadas (mesmo sem match, para nao reprocessar)
  for (const m of msgs) { if (m.id) done.push(m.id); }
  saveDone(done);

  console.log('[recibos] fim');
}

main().catch(e => console.error('[recibos] FATAL:', e));
