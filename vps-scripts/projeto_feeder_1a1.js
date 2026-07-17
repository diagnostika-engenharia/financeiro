'use strict';
/* ===================================================================
 * FEEDER 1:1 — conversas com CLIENTE / PRESTADOR / PARCEIRO de projeto
 * -------------------------------------------------------------------
 * Lê as conversas diretas (mensagens_wa) SÓ dos contatos mapeados em
 * projeto_contatos (ativo + confirmado) e atualiza os projetos.
 *
 * A DESCOBERTA QUE DEFINE ESTE SCRIPT (testado em 17/07/2026):
 *   • Marcus (cadista) mandou "Pode fazer a ART para 270,95m2".
 *     -> Sozinha, a IA respondeu relevante=false: não tinha como saber de quê.
 *     -> COM o contexto do grupo ("Luis N-09 — aguardando metragem para gerar
 *        ART"), a IA acertou o N-09 com confiança 0.9.
 *   Ou seja: o que resolve NÃO é o arquivo nem o número sozinho — é a
 *   JANELA DE CONTEXTO. Por isso todo prompt aqui leva junto:
 *     (a) os projetos do cliente daquele contato (ou todos, p/ prestador),
 *     (b) as mensagens recentes do grupo Projetos,
 *     (c) as mensagens recentes da própria conversa 1:1.
 *
 * POR QUE WHITELIST: as conversas 1:1 misturam condomínio, ART e reforma.
 *   • "Erika" (5519995028804) fala de pintar sacada -> condomínio, NÃO é a
 *     "Erica (Doni)" dos projetos (5519992058702). Mapear por nome quebra.
 *   Só lemos quem foi mapeado e confirmado por um humano.
 *
 * REGRA INVIOLÁVEL: só LÊ e escreve nos objetos de projeto. NUNCA responde,
 * NUNCA envia nada a cliente/prestador. Tudo entra confirmado=false.
 * Ambíguo NÃO chuta. Idempotente (projeto_feeder_processados, chave 'wa:<id>').
 *
 * Modos: DRY_RUN=1 · SINCE=YYYY-MM-DD (default 3 dias) · MAX=<n>
 * =================================================================== */
const https = require('https');
const http = require('http');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace(/^https?:\/\//, '');
const SB_KEY = CFG.supabase_key;
const AI_URL = '/webhook/sicoob-art-ai';
const GRUPO_PROJETOS = '120363407925288367@g.us';
const DRY_RUN = process.env.DRY_RUN === '1';
const MAX = parseInt(process.env.MAX || '30');
const CONF_MIN = 0.6;
const SINCE = process.env.SINCE || new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

function reqJSON(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const r = lib.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(45000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
function sb(method, path, body) {
  const d = body ? JSON.stringify(body) : null;
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
  if (d) { h['Content-Type'] = 'application/json'; h['Prefer'] = 'return=representation'; h['Content-Length'] = Buffer.byteLength(d); }
  return reqJSON({ hostname: SB_HOST, port: 443, method, path, headers: h }, d);
}
async function sbGet(t, q) { const r = await sb('GET', '/rest/v1/' + t + (q ? '?' + q : '')); if (r.status >= 300) throw new Error(t + ' ' + r.status + ': ' + r.body.slice(0, 150)); return JSON.parse(r.body); }
async function chamarIA(messages) {
  const body = JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages });
  const r = await reqJSON({ _http: true, hostname: 'localhost', port: 5678, path: AI_URL, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  return JSON.parse(JSON.parse(r.body).choices[0].message.content);
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const STATUS_VALIDOS = ['levantamento', 'aguardando_doc', 'elaboracao', 'protocolo_prefeitura', 'analise', 'aprovado', 'finalizado', 'aguardando_pagamento', 'entregue'];
const TIPOS = { averbacao: 'Averbação', regularizacao: 'Regularização', anexacao: 'Anexação', habite_se: 'Habite-se', alvara_construcao: 'Alvará', ampliacao: 'Ampliação', infraestrutura: 'Infraestrutura', aprovacao_condominio: 'Aprov. condomínio', outro: 'Projeto' };

const SYS = [
  'Você lê uma conversa DIRETA (1:1) entre a engenharia Diagnóstika e um contato de PROJETOS (cliente, prestador ou parceiro) e atualiza o andamento dos projetos.',
  'Você recebe: (a) quem é o contato, (b) os projetos candidatos, (c) o que foi dito recentemente no grupo interno de Projetos, (d) as mensagens recentes desta conversa.',
  'IMPORTANTE: as MENSAGENS NOVAS vêm em BLOCO — são várias mensagens seguidas da MESMA conversa. Leia o bloco INTEIRO como UM diálogo e produza NO MÁXIMO UM update por projeto, com o estado FINAL depois de tudo. Nunca gere um update por mensagem.',
  'Saudações ("bom dia", "boa tarde"), confirmações ("ok", "blz", "pode deixar") e emojis NÃO são fatos: sozinhos não geram update. Se o bloco só tem isso, relevante=false.',
  'Só mude o status se o bloco AFIRMAR o novo estado. Na dúvida, mantenha o status (novo_status=null) e registre o próximo passo.',
  'USE O CONTEXTO DO GRUPO para descobrir de qual projeto a conversa trata. Ex: se o grupo disse "N-09 aguardando metragem para gerar ART" e o contato manda "pode fazer a ART para 270,95m2", isso é o N-09.',
  'Extraia SÓ o que a conversa afirma. Não invente. Responda SÓ JSON:',
  '{"relevante":bool,"updates":[{"projeto_idx":<int da lista ou null>,"codigo_mencionado":str,"novo_status":<' + STATUS_VALIDOS.join('|') + '|null>,',
  '"proximo_passo":str|null,"docs_recebidos":[str],"valor_contratado_reais":number|null,"entrada_pendente":bool|null,"confianca":0..1,"resumo":str}]}',
  'relevante=false se for conversa social, de condomínio/reforma/ART de morador, ou sem fato novo de projeto.',
  'Se NÃO der para saber de qual projeto se trata, use projeto_idx=null e confianca baixa — NÃO chute.',
  'Mapeie linguagem natural para status: "aguardando documentação"->aguardando_doc; "aprovado"->aprovado; "pronto/finalizado"->finalizado; "entregue"->entregue; "protocolado"->protocolo_prefeitura; "em análise"->analise.',
  'Documentos citados como entregues/recebidos (matrícula, IPTU, ficha informativa, metragem, imagem de fachada, AVCB, contrato) vão em docs_recebidos.',
  'valor_contratado_reais só se disserem o valor TOTAL do contrato (não pagamento/sinal). entrada_pendente só se falarem explicitamente de entrada/sinal/30%.',
].join(' ');

(async () => {
  const [contatos, projetos, clientes] = await Promise.all([
    sbGet('projeto_contatos', 'select=tel,nome,tipo,cliente_id&ativo=eq.true&confirmado=eq.true'),
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,proximo_passo,bairro,cidade,descricao,receita_total_centavos,receita_recebida_centavos,entrada_percentual,entrada_paga_em'),
    sbGet('fin_projeto_clientes', 'select=id,nome'),
  ]);
  if (!contatos.length) { console.log('Nenhum contato mapeado (projeto_contatos ativo+confirmado). Nada a ler.'); return; }
  const cliById = {}; clientes.forEach(c => cliById[c.id] = c);

  // (c) contexto do grupo Projetos — as últimas mensagens, que é o que dá sentido ao 1:1
  const grupoMsgs = await sbGet('mensagens_wa', 'select=texto,from_me,recebida_em&is_grupo=eq.true&jid=eq.' + encodeURIComponent(GRUPO_PROJETOS) + '&order=recebida_em.desc&limit=25');
  const ctxGrupo = (grupoMsgs || []).filter(m => m.texto).reverse()
    .map(m => '- ' + (m.from_me ? '(nós) ' : '') + String(m.texto).replace(/\s+/g, ' ').slice(0, 160)).join('\n') || '(sem mensagens recentes)';

  const jaProc = new Set((await sbGet('projeto_feeder_processados', 'select=msg_id&limit=4000')).map(r => r.msg_id));

  console.log('===== FEEDER 1:1 ' + (DRY_RUN ? '(DRY-RUN)' : '(AO VIVO)') + ' =====');
  console.log('Contatos mapeados: ' + contatos.map(c => c.nome + '/' + c.tipo).join(', '));
  console.log('Desde: ' + SINCE + '\n');

  let nUp = 0, nRev = 0, nMsg = 0;
  for (const ct of contatos) {
    // mensagens novas DELE (não as nossas) nesta conversa
    const msgs = (await sbGet('mensagens_wa', 'select=id,evo_message_id,texto,from_me,recebida_em&is_grupo=eq.false&tel=like.' + ct.tel + '*&from_me=eq.false&recebida_em=gte.' + SINCE + '&order=recebida_em.asc&limit=' + MAX))
      .filter(m => m.texto && String(m.texto).trim());
    const novas = msgs.filter(m => DRY_RUN || !jaProc.has('wa:' + (m.evo_message_id || m.id)));
    if (!novas.length) continue;

    // (b) candidatos: projetos do cliente; prestador/parceiro vê todos
    const cands = ct.cliente_id ? projetos.filter(p => p.cliente_id === ct.cliente_id) : projetos;
    const lista = cands.map((p, i) => `#${i} cliente="${(cliById[p.cliente_id] || {}).nome}" codigo="${p.codigo || ''}" tipo="${p.tipo}" bairro="${p.bairro || ''}" status="${p.status}" desc="${(p.descricao || '').slice(0, 60)}"`).join('\n');

    // (d) histórico recente da própria conversa (dá o fio da meada)
    const hist = (await sbGet('mensagens_wa', 'select=texto,from_me,recebida_em&is_grupo=eq.false&tel=like.' + ct.tel + '*&order=recebida_em.desc&limit=10'))
      .filter(m => m.texto).reverse().map(m => '- ' + (m.from_me ? '(nós) ' : '(ele/ela) ') + String(m.texto).replace(/\s+/g, ' ').slice(0, 140)).join('\n');

    // BLOCO: todas as mensagens novas desta conversa viram UMA leitura.
    // (mensagem por mensagem fazia "Boa tarde" herdar o contexto e o status oscilar)
    nMsg += novas.length;
    const bloco = novas.map(m => '[' + String(m.recebida_em).slice(5, 16).replace('T', ' ') + '] ' + String(m.texto).replace(/\s+/g, ' ').trim()).join('\n');
    const ultima = novas[novas.length - 1];
    console.log('### ' + ct.nome + ' — ' + novas.length + ' msg(s) nova(s):');
    novas.forEach(m => console.log('    "' + String(m.texto).replace(/\s+/g, ' ').slice(0, 78) + '"'));
    let parsed;
    try {
      parsed = await chamarIA([
        { role: 'system', content: SYS },
        { role: 'user', content:
          'CONTATO: ' + ct.nome + ' (' + ct.tipo + (ct.cliente_id ? ', cliente "' + (cliById[ct.cliente_id] || {}).nome + '"' : '') + ')\n\n' +
          'PROJETOS CANDIDATOS:\n' + lista + '\n\n' +
          'CONTEXTO — últimas mensagens do grupo interno de Projetos:\n' + ctxGrupo + '\n\n' +
          'CONTEXTO — histórico recente desta conversa:\n' + hist + '\n\n' +
          'MENSAGENS NOVAS de ' + ct.nome + ' (leia como UM diálogo):\n' + bloco },
      ]);
    } catch (e) { console.log('   IA falhou: ' + e.message); continue; }

    let ups = (parsed && parsed.relevante && Array.isArray(parsed.updates)) ? parsed.updates : [];
    // trava: no máximo 1 update por projeto (o de maior confiança)
    const porProj = {};
    ups.forEach(u => { const k = (u.projeto_idx == null ? 'sem' : String(u.projeto_idx)); const c = typeof u.confianca === 'number' ? u.confianca : 0.5;
      if (!porProj[k] || c > (porProj[k].confianca || 0)) porProj[k] = u; });
    ups = Object.values(porProj);
    if (!ups.length) console.log('   -> irrelevante (sem fato de projeto)');

    {
      const m = ultima, texto = String(ultima.texto).replace(/\s+/g, ' ').trim();
      for (const upd of ups) {
        const conf = typeof upd.confianca === 'number' ? upd.confianca : 0.5;
        const alvo = (upd.projeto_idx != null && cands[upd.projeto_idx]) ? cands[upd.projeto_idx] : null;
        if (!alvo || conf < CONF_MIN) {
          nRev++;
          console.log('   -> sem projeto certo (conf ' + conf + ') — nota p/ revisão, sem mudar status');
          if (!DRY_RUN && cands.length === 1) {
            await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: cands[0].id, origem: 'whatsapp', confirmado: false, tipo: 'nota', descricao: '(auto 1:1 de ' + ct.nome + ') ' + (upd.resumo || texto.slice(0, 120)) });
          }
          continue;
        }
        const nome = (cliById[alvo.cliente_id] || {}).nome;
        const mudaStatus = upd.novo_status && STATUS_VALIDOS.includes(upd.novo_status) && upd.novo_status !== alvo.status;
        const valor = (typeof upd.valor_contratado_reais === 'number' && upd.valor_contratado_reais > 0) ? Math.round(upd.valor_contratado_reais * 100) : null;
        nUp++;
        console.log('   -> ' + nome + ' / ' + (alvo.codigo || TIPOS[alvo.tipo]) + (mudaStatus ? (': ' + alvo.status + ' => ' + upd.novo_status) : ' (status mantido)') + (upd.proximo_passo ? ' | passo: ' + upd.proximo_passo.slice(0, 45) : '') + (upd.docs_recebidos && upd.docs_recebidos.length ? ' | docs: ' + upd.docs_recebidos.join(', ') : '') + (valor ? ' | contrato R$ ' + (valor / 100).toFixed(2) : '') + ' [conf ' + conf + ']');

        if (!DRY_RUN) {
          const patch = { last_movement_at: new Date(m.recebida_em).toISOString(), origem_ultimo_update: 'whatsapp' };
          if (mudaStatus) patch.status = upd.novo_status;
          if (upd.proximo_passo) patch.proximo_passo = upd.proximo_passo;
          if (valor && valor !== (+alvo.receita_total_centavos || 0)) patch.receita_total_centavos = valor;
          if (upd.entrada_pendente === false && !alvo.entrada_paga_em) patch.entrada_paga_em = new Date(m.recebida_em).toISOString();
          await sb('PATCH', '/rest/v1/fin_projetos?id=eq.' + alvo.id, patch);
          if (mudaStatus) alvo.status = upd.novo_status;
          await sb('POST', '/rest/v1/fin_projeto_eventos', {
            projeto_id: alvo.id, origem: 'whatsapp', confirmado: false,
            tipo: mudaStatus ? 'status_change' : 'nota',
            descricao: '(auto 1:1 de ' + ct.nome + ') ' + (upd.resumo || texto.slice(0, 120)),
          });
          for (const docTxt of (upd.docs_recebidos || [])) {
            const docs = await sbGet('fin_projeto_docs', 'select=id,item,status&projeto_id=eq.' + alvo.id);
            const d = docs.find(x => { const a = norm(x.item), b = norm(docTxt); return a.includes(b) || b.includes(a); });
            if (d && d.status !== 'recebido') {
              await sb('PATCH', '/rest/v1/fin_projeto_docs?id=eq.' + d.id, { status: 'recebido', recebido_em: new Date(m.recebida_em).toISOString(), origem: 'whatsapp' });
              await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'whatsapp', confirmado: false, tipo: 'doc_recebido', descricao: '(auto 1:1 de ' + ct.nome + ') documento recebido: ' + d.item });
            }
          }
        }
      }
      if (!DRY_RUN) {
        // marca TODAS as mensagens do bloco como processadas (a leitura foi conjunta)
        for (const mm of novas) {
          const k = 'wa:' + (mm.evo_message_id || mm.id);
          await sb('POST', '/rest/v1/projeto_feeder_processados', { msg_id: k, autor: ct.nome, texto: String(mm.texto).slice(0, 400), relevante: ups.length > 0, n_updates: ups.length, resultado: ups });
          jaProc.add(k);
        }
      }
    }
  }
  console.log('\n===== RESUMO: ' + nMsg + ' msgs 1:1 · ' + nUp + ' updates · ' + nRev + ' p/ revisão =====');
  if (DRY_RUN) console.log('(DRY-RUN — nada escrito.)');
})().catch(e => { console.error('FALHA feeder 1:1: ' + (e && e.message || e)); process.exit(1); });
