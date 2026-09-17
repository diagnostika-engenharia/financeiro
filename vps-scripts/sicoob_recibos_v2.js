'use strict';
/* ===================================================================
 * RECIBOS DO GRUPO v2 — o grupo Financeiro como 3ª FONTE do livro razão
 * (plano de consistência, etapa 5)
 *
 * O que faz:
 *   1) Lê as mensagens do grupo Financeiro dos últimos DIAS dias (default 30)
 *      e separa o que PARECE comprovante: imagem (com ou sem legenda),
 *      PDF e texto de pagamento/recebimento com valor.
 *   2) ENTENDE sozinho (sem exigir legenda/"ref" de ninguém):
 *        - imagem  -> gpt-4o visão lê o comprovante (valor, data, quem, sentido)
 *        - PDF     -> miniatura (jpegThumbnail) + nome do arquivo + legenda
 *        - texto   -> gpt-4o-mini extrai valor/data/quem/sentido
 *      A legenda e a mensagem SEGUINTE do mesmo remetente (até 10 min)
 *      entram como contexto ("é do Jardins", "ref 08/2026").
 *   3) CORRELACIONA com as duas fontes já existentes, por valor exato e
 *      janela de ±30 dias em torno da data do comprovante:
 *        - banco (fin_transacoes_bancarias, valor em REAIS)
 *        - cofre (fin_livro_caixa_cofre,     valor em CENTAVOS)
 *      Achou 1 par -> grava a EVIDÊNCIA (evidencia_msg_id / evidencia_url,
 *      colunas criadas pela _migra_ledger.sql; se ainda não existirem,
 *      só registra no log e segue).
 *      Achou 0 par -> é candidato a "fora do banco": PERGUNTA no grupo
 *      (janela 07–22h BRT) se deve entrar no cofre. NUNCA cria lançamento
 *      sozinho (o cofre tem saldo encadeado; quem lança é o app).
 *      Achou 2+ pares -> ambíguo: só loga (o humano decide no app).
 *
 * O que NÃO faz (para não duplicar robôs que já existem):
 *   - relatos de texto "paguei/gastei/comprei… R$" já são do
 *     sicoob_grupo_despesa.js -> ignorados aqui.
 *   - a correlação legenda×débito do workflow n8n "Sicoob — Recibos grupo"
 *     continua valendo; aqui a novidade é LER o comprovante e gravar prova.
 *
 * Variáveis:
 *   REAL=1         -> grava evidência e pergunta no grupo (default: simulação)
 *   DRY_RUN=1      -> força simulação (equivale a REAL ausente)
 *   DIAS=30        -> janela de leitura do grupo
 *   MAX=15         -> teto de comprovantes analisados por rodada (custo de IA)
 *   IGNORA_JANELA=1-> pergunta fora de 07–22h BRT (só p/ teste)
 *
 * Estado: /home/node/.n8n/sicoob_recibos_v2_estado.json
 *   { "<msg_id>": { "quando": iso, "resultado": "evidencia|perguntado|ambiguo|ignorado", ... } }
 *
 * Teste: docker exec -e DRY_RUN=1 -e DIAS=30 n8n-n8n-1 node /home/node/.n8n/sicoob_recibos_v2.js
 * =================================================================== */
const https = require('https');
const http = require('http');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace(/^https?:\/\//, '');
const SB_KEY = CFG.supabase_key;
const EVO_EP = (CFG.evo_url || '').replace(/^https?:\/\//, '').split(':');
const EVO_HOST = EVO_EP[0], EVO_PORT = parseInt(EVO_EP[1] || '8080');
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const GRUPO = CFG.grupo_financeiro;
const AI_URL = '/webhook/sicoob-art-ai';

const REAL = process.env.REAL === '1' && process.env.DRY_RUN !== '1';
const DIAS = parseInt(process.env.DIAS || '30');
const MAX = parseInt(process.env.MAX || '15');
const ESTADO = '/home/node/.n8n/sicoob_recibos_v2_estado.json';
const NL = String.fromCharCode(10);
const JANELA_DIAS = 30; // ±30 dias para casar com banco/cofre

// ── HTTP helpers (mesmos dos demais robôs) ───────────────────────────
function reqJSON(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const r = lib.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(90000, () => { r.destroy(); reject(new Error('timeout')); });
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
function evo(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const h = { apikey: EVO_KEY };
  if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
  return reqJSON({ _http: true, hostname: EVO_HOST, port: EVO_PORT, method, path, headers: h }, data);
}
async function evoBase64(key) {
  const r = await evo('POST', '/chat/getBase64FromMediaMessage/' + EVO_INSTANCE, { message: { key } });
  if (r.status >= 300) throw new Error('getBase64 ' + r.status + ': ' + r.body.slice(0, 150));
  const j = JSON.parse(r.body);
  return { base64: j.base64 || (j.media && j.media.base64) || '', mimetype: j.mimetype || 'image/jpeg' };
}
async function chamarIA(model, messages) {
  const body = JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages });
  const r = await reqJSON({ _http: true, hostname: 'localhost', port: 5678, path: AI_URL, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  const j = JSON.parse(r.body);
  const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return JSON.parse(txt);
}
async function enviarWhatsapp(linhas) { return evo('POST', '/message/sendText/' + EVO_INSTANCE, { number: GRUPO, text: linhas.join(NL) }); }

// ── leitura de mensagens ─────────────────────────────────────────────
function msgText(m) { const mm = m.message || {}; return mm.conversation || (mm.extendedTextMessage && mm.extendedTextMessage.text) || (mm.imageMessage && mm.imageMessage.caption) || (mm.documentMessage && mm.documentMessage.caption) || (mm.videoMessage && mm.videoMessage.caption) || ''; }
function ehBot(t) { return /^\s*[🔴🔵✅🔎🔗🤖⚠️🟢🟠📎]|Sicoob|classificad|a vincular|a identificar|a confirmar|Entrada —|Saida —|Saída —|Recebido e|Pago e|ART classificada|IA sugere|Vinculado ao|Taxa de ART a pagar|Localizador|Sacado:|Comprovante lido/i.test(t); }
// já coberto pelo sicoob_grupo_despesa.js (ask-only de gasto do bolso)
function ehRelatoDespesaBolso(t) { return /\b(paguei|gastei|comprei|adiantei|custou|em dinheiro|em esp[eé]cie|do bolso|de bolso)\b/i.test(t) && /R\$\s*\d|\d+\s*reais/i.test(t); }
// texto que parece comprovante/pagamento com valor
function ehTextoComprovante(t) { return /R\$\s*[\d.]+|\d+\s*reais\b/i.test(t) && /\b(comprovante|recibo|pix|transfer|ted|boleto|pagamento|pago|recebi|recebemos|recebido|caiu|deposit|nota fiscal|nf)\b/i.test(t); }
const brl = v => 'R$ ' + (+v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dataBRT = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const SYS = [
  'Você lê comprovantes financeiros enviados no grupo interno de WhatsApp de uma empresa de engenharia (Diagnóstika Engenharia, Campinas/SP).',
  'Pode ser: comprovante de PIX/TED/boleto, recibo, nota fiscal, print de app de banco, foto de cupom, ou texto descrevendo um pagamento/recebimento.',
  'Extraia SOMENTE o que estiver visível/escrito; nunca invente. Valor em número (reais, ponto decimal). Data no formato AAAA-MM-DD (se só houver dia/mês, use o ano da mensagem).',
  'sentido: "saida" se a Diagnóstika PAGOU (pagador = Diagnóstika/Rogério/Claudemir), "entrada" se a Diagnóstika RECEBEU (beneficiário = Diagnóstika), "desconhecido" se não der para saber.',
  'Responda SÓ JSON: {"e_comprovante":bool,"sentido":"saida|entrada|desconhecido","valor":number|null,"data":"AAAA-MM-DD"|null,"contraparte":str,"descricao":str,"meio":str,"confianca":0-1,"observacao":str}.',
  'e_comprovante=false para plantas, fotos de obra, prints de conversa, memes ou qualquer coisa sem valor financeiro.',
].join(' ');

(async () => {
  const horaBRT = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
  const podePerguntar = !!process.env.IGNORA_JANELA || (horaBRT >= 7 && horaBRT <= 22);

  let estado = {};
  try { estado = JSON.parse(fs.readFileSync(ESTADO, 'utf8')) || {}; } catch (e) {}
  const salvar = () => { if (REAL) { try { fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 1)); } catch (e) {} } };

  const rMsg = await evo('POST', '/chat/findMessages/' + EVO_INSTANCE, { where: { key: { remoteJid: GRUPO } }, limit: 600 });
  let recs; try { recs = JSON.parse(rMsg.body).messages.records; } catch (e) { throw new Error('findMessages: ' + rMsg.body.slice(0, 200)); }
  const cutoff = Math.floor(Date.now() / 1000) - DIAS * 86400;
  const msgs = recs.filter(m => m.key && +m.messageTimestamp >= cutoff).sort((a, b) => a.messageTimestamp - b.messageTimestamp);

  // candidatos
  const cand = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]; const mm = m.message || {};
    if (m.key.fromMe) continue; // mensagens da própria instância = robôs
    const texto = msgText(m).trim();
    if (texto && ehBot(texto)) continue;
    let tipo = null;
    if (mm.imageMessage) tipo = 'imagem';
    else if (mm.documentMessage && /pdf/i.test(mm.documentMessage.mimetype || mm.documentMessage.fileName || '')) tipo = 'pdf';
    else if (texto && ehTextoComprovante(texto) && !ehRelatoDespesaBolso(texto)) tipo = 'texto';
    if (!tipo) continue;
    // contexto: mensagem seguinte do mesmo remetente em até 10 min (legenda "atrasada")
    let seguinte = '';
    const nx = msgs[i + 1];
    if (nx && !nx.key.fromMe && nx.key.participant === m.key.participant && +nx.messageTimestamp - +m.messageTimestamp <= 600) {
      const t2 = msgText(nx).trim(); if (t2 && !ehBot(t2) && !(nx.message || {}).imageMessage) seguinte = t2;
    }
    cand.push({ id: m.key.id, key: m.key, ts: +m.messageTimestamp, autor: m.pushName || '?', tipo, texto, seguinte, doc: mm.documentMessage || null });
  }
  const novos = cand.filter(c => !estado[c.id]).slice(0, MAX);
  console.log('===== RECIBOS GRUPO v2 ' + (REAL ? '(REAL)' : '(SIMULAÇÃO)') + ' — ' + msgs.length + ' msgs/' + DIAS + 'd · ' + cand.length + ' candidatos · ' + novos.length + ' novos =====');

  let nEvid = 0, nPerg = 0, nAmb = 0, nIgn = 0;
  for (const c of novos) {
    const quando = new Date(c.ts * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).slice(0, 16);
    const contexto = [c.texto && ('Legenda/texto: ' + c.texto), c.seguinte && ('Mensagem seguinte do mesmo remetente: ' + c.seguinte), c.doc && ('Arquivo: ' + (c.doc.fileName || '')), 'Remetente: ' + c.autor, 'Data da mensagem: ' + dataBRT(c.ts)].filter(Boolean).join(NL);

    let ia;
    try {
      if (c.tipo === 'imagem') {
        const media = await evoBase64(c.key);
        if (!media.base64) throw new Error('imagem vazia');
        ia = await chamarIA('gpt-4o', [{ role: 'system', content: SYS }, { role: 'user', content: [{ type: 'text', text: contexto }, { type: 'image_url', image_url: { url: 'data:' + media.mimetype + ';base64,' + media.base64 } }] }]);
      } else if (c.tipo === 'pdf' && c.doc.jpegThumbnail) {
        const th = typeof c.doc.jpegThumbnail === 'string' ? c.doc.jpegThumbnail : Buffer.from(c.doc.jpegThumbnail.data || c.doc.jpegThumbnail).toString('base64');
        ia = await chamarIA('gpt-4o', [{ role: 'system', content: SYS }, { role: 'user', content: [{ type: 'text', text: 'É a MINIATURA de um PDF (baixa resolução).' + NL + contexto }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + th } }] }]);
      } else {
        ia = await chamarIA('gpt-4o-mini', [{ role: 'system', content: SYS }, { role: 'user', content: contexto }]);
      }
    } catch (e) { console.log('[' + quando + '] ' + c.autor + ' (' + c.tipo + ') — falha IA/mídia: ' + e.message); continue; }

    const val = ia && ia.e_comprovante ? Math.round((+ia.valor || 0) * 100) / 100 : 0;
    if (!val) {
      nIgn++; console.log('[' + quando + '] ' + c.autor + ' (' + c.tipo + ') -> não é comprovante (' + ((ia && ia.observacao) || '').slice(0, 60) + ')');
      estado[c.id] = { quando: new Date().toISOString(), resultado: 'ignorado', tipo: c.tipo }; salvar(); continue;
    }
    const dref = (ia.data && /^\d{4}-\d{2}-\d{2}$/.test(ia.data)) ? ia.data : dataBRT(c.ts);
    const di = addDias(dref, -JANELA_DIAS), df = addDias(dref, JANELA_DIAS);
    const sentido = ia.sentido === 'entrada' ? 'entrada' : ia.sentido === 'saida' ? 'saida' : null;

    // correlação: banco (reais) e cofre (centavos), valor exato, ±30 dias
    let banco = [], cofre = [];
    try {
      banco = await sbGet('fin_transacoes_bancarias', 'select=id,data,tipo,valor,historico,categoria&valor=eq.' + val + '&data=gte.' + di + '&data=lte.' + df + (sentido ? '&tipo=eq.' + (sentido === 'entrada' ? 'credito' : 'debito') : ''));
      cofre = await sbGet('fin_livro_caixa_cofre', 'select=id,data,tipo,valor,descricao&valor=eq.' + Math.round(val * 100) + '&data=gte.' + di + '&data=lte.' + df + (sentido ? '&tipo=eq.' + encodeURIComponent(sentido === 'entrada' ? 'Entrada' : 'Saída') : ''));
    } catch (e) { console.log('   consulta falhou: ' + e.message); }
    // não reaproveita um lançamento que já é evidência de outro comprovante (dois almoços de 43,41 ≠ um só)
    const usados = new Set(Object.values(estado).filter(s => s.resultado === 'evidencia').map(s => s.fonte + '#' + s.ref_id));
    let pares = banco.map(b => ({ fonte: 'banco', id: b.id, data: b.data, rot: b.historico })).concat(cofre.map(k => ({ fonte: 'cofre', id: k.id, data: k.data, rot: k.descricao })))
      .filter(p => !usados.has(p.fonte + '#' + p.id))
      .map(p => Object.assign(p, { dist: Math.abs((new Date(p.data) - new Date(dref)) / 86400000) }))
      .sort((a, b) => a.dist - b.dist);
    // desempate por proximidade: se só um par está a ≤3 dias do comprovante, é ele
    if (pares.length > 1 && pares[0].dist <= 3 && pares[1].dist > 3) pares = [pares[0]];
    const resumo = brl(val) + ' · ' + (sentido || '?') + ' · ' + dref + ' · ' + (ia.contraparte || '') + ' · ' + (ia.descricao || '').slice(0, 50);
    console.log('[' + quando + '] ' + c.autor + ' (' + c.tipo + ') -> ' + resumo);

    if (pares.length === 1) {
      const p = pares[0];
      console.log('   ✔ par único: ' + p.fonte + ' #' + p.id + ' ' + p.data + ' "' + String(p.rot || '').slice(0, 40) + '" -> evidência');
      nEvid++;
      estado[c.id] = { quando: new Date().toISOString(), resultado: 'evidencia', fonte: p.fonte, ref_id: p.id, valor: val };
      if (REAL) {
        const tb = p.fonte === 'banco' ? 'fin_transacoes_bancarias' : 'fin_livro_caixa_cofre';
        const r = await sb('PATCH', '/rest/v1/' + tb + '?id=eq.' + p.id + '&evidencia_msg_id=is.null', { evidencia_msg_id: c.id, evidencia_url: 'whatsapp://' + GRUPO + '/' + c.id });
        if (r.status >= 300) { console.log('   (evidência não gravada: ' + r.status + ' ' + r.body.slice(0, 80) + ' — provável migração _migra_ledger.sql pendente)'); estado[c.id].gravado = false; }
        else estado[c.id].gravado = true;
      }
      salvar(); continue;
    }
    if (pares.length > 1) {
      nAmb++; console.log('   ~ ambíguo: ' + pares.map(p => p.fonte + '#' + p.id).join(', ') + ' — humano decide no app');
      estado[c.id] = { quando: new Date().toISOString(), resultado: 'ambiguo', pares: pares.map(p => p.fonte + '#' + p.id), valor: val }; salvar(); continue;
    }
    // sem par em banco nem cofre -> fora do banco? pergunta
    nPerg++;
    console.log('   ? sem par no banco/cofre -> ' + (podePerguntar ? 'perguntar no grupo' : 'perguntar depois (fora da janela BRT)'));
    if (REAL && podePerguntar) {
      const linhas = ['📎 Comprovante lido, mas não achei no extrato nem no cofre.', '💰 ' + brl(val) + ' · ' + (sentido === 'entrada' ? 'recebimento' : sentido === 'saida' ? 'pagamento' : 'sentido?') + ' · ' + dref.split('-').reverse().join('/'), '👤 ' + (ia.contraparte || '?') + (ia.descricao ? ' — ' + ia.descricao.slice(0, 60) : ''), 'Foi fora do banco (cofre/dinheiro)? Se sim, lanço no cofre; responda "sim", "não" ou corrija o valor.', 'Responda em cima desta mensagem, por favor.'];
      try { await enviarWhatsapp(linhas); await new Promise(s => setTimeout(s, 1200)); } catch (e) { console.log('   envio falhou: ' + e.message); }
      estado[c.id] = { quando: new Date().toISOString(), resultado: 'perguntado', valor: val, sentido, data: dref, contraparte: ia.contraparte || '' }; salvar();
    }
  }
  console.log('===== RESUMO: ' + novos.length + ' analisados · ' + nEvid + ' evidências · ' + nPerg + (REAL ? ' perguntas' : ' perguntaria') + ' · ' + nAmb + ' ambíguos · ' + nIgn + ' não-comprovante =====');
  if (!REAL) console.log('(SIMULAÇÃO — nada gravado, nada enviado.)');
})().catch(e => { console.error('FALHA recibos-v2: ' + (e && e.message || e)); process.exit(1); });
