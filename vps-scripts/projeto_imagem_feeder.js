'use strict';
/* ===================================================================
 * FEEDER DE IMAGEM DO GRUPO PROJETOS — lê as TABELAS/planilhas que o
 * Claudemir manda como imagem (status, serviço, situação, valor) e as
 * transforma em sugestões revisáveis nos projetos. Par visual do feeder
 * de texto (projeto_feeder.js).
 * -------------------------------------------------------------------
 * Por que existe: o feeder de texto só enxerga texto/legenda. As tabelas
 * de status vêm como imagem SEM legenda -> ficavam invisíveis. A parte
 * técnica que importa (o "resumo dos projetos") estava justamente ali.
 *
 * Fluxo por imagem nova do grupo:
 *   1) baixa os bytes via Evolution getBase64FromMediaMessage
 *   2) gpt-4o (visão, via proxy n8n) classifica e extrai:
 *        - é tabela de status/preço de projetos? -> extrai cada LINHA
 *        - é planta/desenho/foto sem dados?       -> ignora (o pedido do
 *          Rogério: "ler esse tipo de coisa, projeto em si não")
 *   3) para cada linha, casa com um projeto existente (por código/cliente)
 *        - casou  -> grava proximo_passo + evento confirmado=false (nota)
 *        - não casou -> guarda na revisão (não cria projeto às cegas: uma
 *          tabela lista muitos itens, vários históricos/cancelados)
 *
 * REGRA INVIOLÁVEL (igual ao feeder de texto): só LÊ o grupo e ESCREVE
 * nos objetos de projeto. NUNCA fala com cliente, NUNCA envia nada.
 * Todo update entra como confirmado=false. E, de propósito, a imagem
 * NÃO move o status sozinha — só propõe; quem confirma é a equipe no app.
 *
 * Idempotente: projeto_feeder_processados, msg_id = 'img:<id>'.
 *
 * Modos:
 *   DRY_RUN=1  -> só mostra o que faria, não escreve nada.
 *   SINCE=YYYY-MM-DD -> imagens a partir dessa data (default: 5 dias).
 *   MAX=<n>    -> teto de imagens por rodada (default 12).
 *
 * Dry-run: docker exec -e DRY_RUN=1 -e SINCE=2026-07-20 n8n-n8n-1 node /home/node/.n8n/projeto_imagem_feeder.js
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
const GRUPO_PROJETOS = '120363407925288367@g.us';
const AI_URL = '/webhook/sicoob-art-ai';

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX = parseInt(process.env.MAX || '12');
const SINCE = process.env.SINCE ? new Date(process.env.SINCE + 'T00:00:00-03:00')
  : new Date(Date.now() - 5 * 86400000);

// ── HTTP helpers ────────────────────────────────────────────────────
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
async function chamarVisao(messages) {
  const body = JSON.stringify({ model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' }, messages });
  const r = await reqJSON({ _http: true, hostname: 'localhost', port: 5678, path: AI_URL, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  const j = JSON.parse(r.body);
  const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return JSON.parse(txt);
}

// ── utilidades (iguais ao feeder de texto) ──────────────────────────
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// extrai um provável código do rótulo da linha ("K-09 - Casa Sobrado" -> "K-09")
function extrairCodigo(rotulo) {
  const m = String(rotulo || '').match(/\b([A-Z]{1,4}[-\s]?\d{1,3}(?:\/\d{1,3})?)\b/i);
  return m ? m[1] : '';
}
// casa uma linha da tabela contra os projetos: por código, depois por cliente/rótulo
function acharProjeto(projetos, clientesById, rotulo) {
  const codRef = norm(extrairCodigo(rotulo)) || norm(rotulo);
  if (codRef) {
    const porCod = projetos.filter(p => p.codigo && norm(p.codigo) === codRef);
    if (porCod.length === 1) return porCod[0];
    const parcial = projetos.filter(p => p.codigo && (norm(p.codigo).includes(codRef) || codRef.includes(norm(p.codigo))) && norm(p.codigo).length >= 2);
    if (parcial.length === 1) return parcial[0];
  }
  // por cliente OU bairro contidos no rótulo
  const rot = norm(rotulo);
  if (rot) {
    const cands = projetos.filter(p => {
      const nome = norm((clientesById[p.cliente_id] || {}).nome);
      const bairro = norm(p.bairro);
      return (nome && nome.length >= 3 && rot.includes(nome)) || (bairro && bairro.length >= 3 && rot.includes(bairro));
    });
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) return { _ambiguo: true, candidatos: cands };
  }
  return null;
}
function rotuloLinha(l) { return [l.projeto, l.tipo_imovel, l.servico].filter(Boolean).join(' · '); }
function situacaoLinha(l) { return [l.status, l.situacao, l.servico].filter(s => s && s.trim()).join(' | ').slice(0, 400); }

const SYS = [
  'Você lê UMA imagem enviada no grupo interno de WhatsApp de uma engenharia (projetos: averbação, regularização, alvará, habite-se).',
  'Muitas imagens são TABELAS/planilhas de acompanhamento: colunas como PROJETO, TIPO DE IMÓVEL, SERVIÇO A EXECUTAR, VALOR, TIPO DE APROVAÇÃO, STATUS, SITUAÇÃO.',
  'Se a imagem for uma tabela/lista de projetos: extraia CADA linha, uma por projeto. Transcreva o texto fielmente, sem inventar.',
  'Se a imagem for um DESENHO técnico, planta, foto, print de conversa ou qualquer coisa sem dados tabulares de projeto: e_tabela=false e linhas=[].',
  'Responda SÓ JSON: {"e_tabela":bool,"tipo_conteudo":str,"linhas":[{"projeto":str,"tipo_imovel":str,"servico":str,"valor":str,"tipo_aprovacao":str,"status":str,"situacao":str}],"observacao":str}.',
  'Em cada linha preencha só os campos que a imagem mostrar; use "" nos que não existirem. "projeto" é o identificador da linha (código e/ou nome).',
].join(' ');

(async () => {
  const [projetos, clientes] = await Promise.all([
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,proximo_passo,bairro,cidade,descricao'),
    sbGet('fin_projeto_clientes', 'select=id,nome'),
  ]);
  const clientesById = {}; clientes.forEach(c => clientesById[c.id] = c);

  // mensagens do grupo -> só imagens
  const rMsg = await evo('POST', '/chat/findMessages/' + EVO_INSTANCE, { where: { key: { remoteJid: GRUPO_PROJETOS } }, limit: 200 });
  let recs; try { recs = JSON.parse(rMsg.body).messages.records; } catch (e) { throw new Error('findMessages: ' + rMsg.body.slice(0, 200)); }

  let imgs = recs
    .filter(m => m.key && (m.messageType === 'imageMessage' || (m.message && m.message.imageMessage)))
    .map(m => ({ id: m.key.id, key: m.key, ts: m.messageTimestamp || 0, autor: m.pushName || '?', legenda: (m.message && m.message.imageMessage && m.message.imageMessage.caption) || '' }))
    .filter(m => new Date(m.ts * 1000) >= SINCE)
    .sort((a, b) => a.ts - b.ts);

  const jaProc = new Set((await sbGet('projeto_feeder_processados', 'select=msg_id&limit=4000')).map(r => r.msg_id));
  imgs = imgs.filter(m => DRY_RUN || !jaProc.has('img:' + m.id)).slice(0, MAX);

  console.log('===== FEEDER DE IMAGEM ' + (DRY_RUN ? '(DRY-RUN)' : '(AO VIVO)') + ' =====');
  console.log('Imagens a processar: ' + imgs.length + ' (desde ' + SINCE.toISOString().slice(0, 10) + ')');

  let totTab = 0, totLinhas = 0, totCasadas = 0, totRevisao = 0, totIgnoradas = 0;

  for (const im of imgs) {
    const quando = new Date(im.ts * 1000).toISOString().slice(5, 16).replace('T', ' ');
    let media;
    try { media = await evoBase64(im.key); }
    catch (e) { console.log('\n[' + quando + '] ' + im.autor + ' — falha ao baixar imagem: ' + e.message); continue; }
    if (!media.base64) { console.log('\n[' + quando + '] ' + im.autor + ' — imagem vazia, pulo.'); continue; }

    let vis;
    try {
      vis = await chamarVisao([
        { role: 'system', content: SYS },
        { role: 'user', content: [
          { type: 'text', text: 'Imagem enviada por ' + im.autor + ' no grupo Projetos' + (im.legenda ? (' (legenda: "' + im.legenda + '")') : '') + '. Extraia o que houver.' },
          { type: 'image_url', image_url: { url: 'data:' + media.mimetype + ';base64,' + media.base64 } },
        ] },
      ]);
    } catch (e) { console.log('\n[' + quando + '] ' + im.autor + ' — visão falhou: ' + e.message); continue; }

    const linhas = (vis && vis.e_tabela && Array.isArray(vis.linhas)) ? vis.linhas.filter(l => l && (l.projeto || l.servico || l.status)) : [];
    console.log('\n[' + quando + '] ' + im.autor + ' — ' + (vis.tipo_conteudo || '?') + (vis.e_tabela ? (' · ' + linhas.length + ' linha(s)') : ' · NÃO é tabela (ignoro)'));

    if (!vis.e_tabela || !linhas.length) {
      totIgnoradas++;
      if (!DRY_RUN) await sb('POST', '/rest/v1/projeto_feeder_processados', { msg_id: 'img:' + im.id, autor: im.autor, texto: '[imagem] ' + (vis.tipo_conteudo || 'sem tabela'), relevante: false, n_updates: 0, resultado: { e_tabela: !!vis.e_tabela, tipo_conteudo: vis.tipo_conteudo, observacao: vis.observacao } });
      continue;
    }
    totTab++; totLinhas += linhas.length;

    const resultadoLinhas = [];
    for (const l of linhas) {
      const rot = rotuloLinha(l);
      const sit = situacaoLinha(l);
      const alvo = acharProjeto(projetos, clientesById, l.projeto || rot);

      if (alvo && alvo._ambiguo) {
        console.log('   • ' + (l.projeto || '?') + ' -> AMBÍGUO (' + alvo.candidatos.map(c => c.codigo || c.id.slice(0, 4)).join(', ') + ') — revisão');
        resultadoLinhas.push({ projeto: l.projeto, match: 'ambiguo', situacao: sit }); totRevisao++;
        continue;
      }
      if (!alvo) {
        console.log('   • ' + (l.projeto || '?') + ' -> sem projeto correspondente — revisão' + (l.valor ? ' (valor: ' + l.valor + ')' : ''));
        resultadoLinhas.push({ projeto: l.projeto, tipo_imovel: l.tipo_imovel, servico: l.servico, valor: l.valor, status: l.status, situacao: l.situacao, match: 'sem_match' }); totRevisao++;
        continue;
      }

      const nome = (clientesById[alvo.cliente_id] || {}).nome;
      // O "próximo passo" real está no STATUS/SITUAÇÃO (a ação pendente),
      // NÃO na coluna Serviço (que é o tipo do projeto: Alvará, Habite-se...).
      const acao = [l.status, l.situacao].map(s => String(s || '').trim()).filter(Boolean).join(' — ');
      const passo = acao ? acao.slice(0, 180) : null;
      console.log('   • ' + (l.projeto || '?') + ' -> ' + nome + ' / ' + (alvo.codigo || alvo.tipo) + (passo ? (' | passo: ' + passo.slice(0, 50)) : '') + (l.servico ? (' | serviço: ' + l.servico.slice(0, 30)) : ''));
      resultadoLinhas.push({ projeto: l.projeto, match: 'ok', projeto_id: alvo.id, codigo: alvo.codigo, proximo_passo: passo, situacao: sit });
      totCasadas++;

      if (!DRY_RUN) {
        const patch = { last_movement_at: new Date(im.ts * 1000).toISOString(), origem_ultimo_update: 'grupo' };
        if (passo) patch.proximo_passo = passo;
        await sb('PATCH', '/rest/v1/fin_projetos?id=eq.' + alvo.id, patch);
        if (passo) alvo.proximo_passo = passo;
        const desc = '(auto da imagem do grupo · confira) '
          + [l.servico && ('serviço: ' + l.servico), l.tipo_imovel && ('tipo: ' + l.tipo_imovel), l.tipo_aprovacao && ('aprovação: ' + l.tipo_aprovacao), passo && ('situação: ' + passo), l.valor && ('valor na tabela: ' + l.valor)].filter(Boolean).join(' · ');
        await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'grupo', confirmado: false, tipo: 'nota', descricao: desc.slice(0, 600) });
      }
    }

    if (!DRY_RUN) {
      const texto = 'TABELA (' + (vis.tipo_conteudo || 'status') + '): ' + linhas.map(l => rotuloLinha(l)).filter(Boolean).slice(0, 20).join(' ; ');
      await sb('POST', '/rest/v1/projeto_feeder_processados', {
        msg_id: 'img:' + im.id, autor: im.autor, texto: texto.slice(0, 1200),
        relevante: true, n_updates: resultadoLinhas.filter(r => r.match === 'ok').length,
        resultado: { e_tabela: true, tipo_conteudo: vis.tipo_conteudo, linhas: resultadoLinhas },
      });
    }
  }

  console.log('\n===== RESUMO: ' + imgs.length + ' imagens · ' + totTab + ' tabelas · ' + totLinhas + ' linhas · ' + totCasadas + ' casadas · ' + totRevisao + ' p/ revisão · ' + totIgnoradas + ' ignoradas (não-tabela) =====');
  if (DRY_RUN) console.log('(DRY-RUN — nada foi escrito no banco.)');
})().catch(e => { console.error('FALHA feeder-imagem: ' + (e && e.message || e)); process.exit(1); });
