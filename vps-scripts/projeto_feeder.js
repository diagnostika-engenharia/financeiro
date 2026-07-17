'use strict';
/* ===================================================================
 * FEEDER DO GRUPO PROJETOS — lê as mensagens do grupo e atualiza os
 * projetos automaticamente. Fase 2, peça de leitura (o par do digest).
 * -------------------------------------------------------------------
 * Fluxo: lê mensagens novas do grupo "Projetos - Diagnóstika" (Evolution),
 * a IA (gpt-4o-mini via proxy n8n) extrai {codigo/cliente, status,
 * proximo_passo, docs recebidos, projeto novo}, casa com fin_projetos e:
 *   - status/proximo_passo -> fin_projetos (+ last_movement_at, origem='grupo')
 *   - documento recebido    -> fin_projeto_docs.status='recebido'
 *   - SEMPRE evento em fin_projeto_eventos: origem='grupo', confirmado=FALSE
 * Projeto novo mencionado -> cria rascunho e sinaliza (não ignora — é lead).
 *
 * REGRA INVIOLÁVEL: só LÊ o grupo e ESCREVE nos objetos de projeto.
 * NUNCA fala com cliente, NUNCA envia nada. Todo update automático entra
 * como confirmado=false (revisável/reversível). Ambíguo NÃO chuta status.
 *
 * Idempotente: projeto_feeder_processados guarda os msg_id já vistos.
 *
 * Modos:
 *   DRY_RUN=1  -> só mostra o que faria, não escreve nada.
 *   SINCE=YYYY-MM-DD -> processa mensagens a partir dessa data (default: 3 dias).
 *   MAX=<n>    -> teto de mensagens por rodada (default 40).
 *
 * Rodar dry-run:  docker exec -e DRY_RUN=1 -e SINCE=2026-07-01 n8n-n8n-1 node /home/node/.n8n/projeto_feeder.js
 * =================================================================== */
const https = require('https');
const http = require('http');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace(/^https?:\/\//, '');
const SB_KEY = CFG.supabase_key;                          // service_role
const EVO_HOST = (CFG.evo_url || '').replace(/^https?:\/\//, '');
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const EVO_EP = EVO_HOST.split(':');
const GRUPO_PROJETOS = '120363407925288367@g.us';
const AI_URL = '/webhook/sicoob-art-ai';                  // proxy OpenAI já existente

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX = parseInt(process.env.MAX || '40');
const CONF_STATUS = 0.6;                                  // confiança mínima p/ mover status
const SINCE = process.env.SINCE ? new Date(process.env.SINCE + 'T00:00:00-03:00')
  : new Date(Date.now() - 3 * 86400000);                  // default: últimos 3 dias

// ── HTTP helpers ────────────────────────────────────────────────────
function reqJSON(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const r = lib.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(45000, () => { r.destroy(); reject(new Error('timeout')); });
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
  return reqJSON({ _http: true, hostname: EVO_EP[0], port: parseInt(EVO_EP[1] || '8080'), method, path, headers: h }, data);
}
async function chamarIA(messages) {
  const body = JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages });
  const r = await reqJSON({ _http: true, hostname: 'localhost', port: 5678, path: AI_URL, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  const j = JSON.parse(r.body);
  const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return JSON.parse(txt);
}

// ── utilidades ──────────────────────────────────────────────────────
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const msgText = m => { const mm = m.message || {}; return mm.conversation || (mm.extendedTextMessage && mm.extendedTextMessage.text) || (mm.imageMessage && mm.imageMessage.caption) || ''; };
const STATUS_VALIDOS = ['levantamento', 'aguardando_doc', 'elaboracao', 'protocolo_prefeitura', 'analise', 'aprovado', 'finalizado', 'aguardando_pagamento', 'entregue'];
const TIPOS_VALIDOS = ['averbacao', 'regularizacao', 'anexacao', 'habite_se', 'alvara_construcao', 'ampliacao', 'infraestrutura', 'aprovacao_condominio', 'outro'];

// casa um "ref" (codigo ou cliente) da IA contra a lista de projetos
function acharProjeto(projetos, clientesById, upd) {
  // 1) por código normalizado
  const codRef = norm(upd.codigo_mencionado);
  if (codRef) {
    const porCod = projetos.filter(p => p.codigo && norm(p.codigo) === codRef);
    if (porCod.length === 1) return porCod[0];
    // código parcial (ex: "AA27" casa "AA27/AA28")
    const parcial = projetos.filter(p => p.codigo && (norm(p.codigo).includes(codRef) || codRef.includes(norm(p.codigo))));
    if (parcial.length === 1) return parcial[0];
  }
  // 2) por cliente
  const cliRef = norm(upd.cliente_mencionado);
  if (cliRef) {
    const cands = projetos.filter(p => { const nome = norm((clientesById[p.cliente_id] || {}).nome); return nome && (nome.includes(cliRef) || cliRef.includes(nome)); });
    if (cands.length === 1) return cands[0];
    // cliente + código juntos desambiguam
    if (cands.length > 1 && codRef) {
      const c2 = cands.filter(p => p.codigo && (norm(p.codigo).includes(codRef) || codRef.includes(norm(p.codigo))));
      if (c2.length === 1) return c2[0];
    }
    if (cands.length > 1) return { _ambiguo: true, candidatos: cands };
  }
  return null;
}

(async () => {
  // contexto: projetos + clientes atuais
  const [projetos, clientes] = await Promise.all([
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,proximo_passo,bairro,cidade,descricao,receita_total_centavos,receita_recebida_centavos,entrada_percentual,entrada_paga_em'),
    sbGet('fin_projeto_clientes', 'select=id,nome'),
  ]);
  const clientesById = {}; clientes.forEach(c => clientesById[c.id] = c);
  const listaCtx = projetos.map((p, i) => `#${i} cliente="${(clientesById[p.cliente_id] || {}).nome || '?'}" codigo="${p.codigo || ''}" tipo="${p.tipo}" bairro="${p.bairro || ''}" status="${p.status}" desc="${(p.descricao || '').slice(0, 60)}"`).join('\n');

  // mensagens do grupo
  const rMsg = await evo('POST', '/chat/findMessages/' + EVO_INSTANCE, { where: { key: { remoteJid: GRUPO_PROJETOS } }, limit: 200 });
  let recs; try { recs = JSON.parse(rMsg.body).messages.records; } catch (e) { throw new Error('findMessages: ' + rMsg.body.slice(0, 200)); }

  // filtra: não-minhas, com texto, dentro do período, ordenadas por tempo
  let msgs = recs.filter(m => m.key && !m.key.fromMe && msgText(m).trim())
    .map(m => ({ id: m.key.id, ts: m.messageTimestamp || 0, autor: m.pushName || '?', texto: msgText(m).trim() }))
    .filter(m => new Date(m.ts * 1000) >= SINCE)
    .sort((a, b) => a.ts - b.ts);

  // idempotência: pula já processadas
  const jaProc = new Set((await sbGet('projeto_feeder_processados', 'select=msg_id&limit=2000')).map(r => r.msg_id));
  msgs = msgs.filter(m => DRY_RUN || !jaProc.has(m.id)).slice(0, MAX);

  console.log('===== FEEDER PROJETOS ' + (DRY_RUN ? '(DRY-RUN)' : '(AO VIVO)') + ' =====');
  console.log('Mensagens a processar: ' + msgs.length + ' (desde ' + SINCE.toISOString().slice(0, 10) + ')');

  const SYS = [
    'Você lê mensagens de um grupo interno de WhatsApp de uma engenharia (projetos de averbação, regularização, alvará, habite-se etc.).',
    'Cada mensagem pode: (a) atualizar o andamento de um ou mais projetos, (b) mencionar um projeto novo, ou (c) ser conversa/link/pergunta irrelevante.',
    'Você recebe a LISTA de projetos existentes (com índice #, cliente, código, status).',
    'Extraia SÓ o que a mensagem afirma. Não invente. Responda SÓ JSON:',
    '{"relevante":bool,"updates":[{"projeto_idx":<int da lista ou null>,"cliente_mencionado":str,"codigo_mencionado":str,',
    '"novo_status":<um de: ' + STATUS_VALIDOS.join('|') + '|null>,"proximo_passo":str|null,"docs_recebidos":[str],',
    '"valor_contratado_reais":number|null,"entrada_pendente":bool|null,',
    '"projeto_novo":bool,"confianca":0..1,"resumo":str}]}',
    'Regras: se a msg for link/pergunta/combinação sem fato de andamento -> relevante=false, updates=[].',
    'Mapeie linguagem natural para status: "aguardando documentação/falta doc"->aguardando_doc; "aprovado"->aprovado;',
    '"finalizado/pronto"->finalizado; "aguardando pagamento/vai pagar"->aguardando_pagamento; "entregue/já entregamos/recebemos e finalizou"->entregue;',
    '"em análise/aguardando aprovação do condomínio"->analise; "protocolado na prefeitura"->protocolo_prefeitura; "levantando/vamos iniciar"->levantamento.',
    'Se mencionar documento recebido (matrícula, IPTU, contrato, imagem de fachada, metragem, etc.) coloque em docs_recebidos.',
    'VALOR: se a mensagem disser o valor do contrato/orçamento do projeto, coloque em valor_contratado_reais (número em reais). Entenda "2k"/"2 mil"=2000, "3,5k"=3500, "R$ 4.000"=4000. É o valor TOTAL do contrato — NÃO confunda com pagamento recebido, sinal, entrada ou parcela; nesses casos deixe valor_contratado_reais=null.',
    'ENTRADA: a regra da empresa é 30% de entrada antes de começar. Só use entrada_pendente quando a mensagem falar EXPLICITAMENTE da entrada inicial (palavras "entrada", "sinal", "30%"): "falta entrada"/"sem entrada"/"não deu entrada" -> entrada_pendente=true; "entrada paga"/"deu entrada"/"pagou o sinal" -> entrada_pendente=false. ATENÇÃO: "aguardando pagamento" do saldo/parcela final NÃO é entrada -> entrada_pendente=null. Se a msg não falar de entrada, null.',
    'Cada lote/imóvel é um projeto DISTINTO. Se a mensagem citar um código/lote (ex: N-09, ZM4, Q-46, São Bento) que NÃO está na lista — mesmo para um cliente que já existe — trate como projeto_novo=true e projeto_idx=null (é um lead/projeto novo daquele cliente, não uma atualização de outro projeto dele).',
    'Para distinguir projetos do mesmo cliente use o código E o bairro (ex: "São Bento" casa o projeto cujo bairro="São Bento", não o de outro bairro).',
    'projeto_novo=true só se for claramente um projeto/lote que NÃO está na lista. confianca reflita o quão explícito é o fato.',
  ].join(' ');

  const resultados = [];
  for (const m of msgs) {
    let parsed;
    try {
      parsed = await chamarIA([
        { role: 'system', content: SYS },
        { role: 'user', content: 'PROJETOS EXISTENTES:\n' + listaCtx + '\n\nMENSAGEM de ' + m.autor + ':\n"' + m.texto + '"' },
      ]);
    } catch (e) { console.log('  IA falhou msg ' + m.id + ': ' + e.message); continue; }

    const ups = (parsed && parsed.relevante && Array.isArray(parsed.updates)) ? parsed.updates : [];
    console.log('\n[' + new Date(m.ts * 1000).toISOString().slice(5, 16).replace('T', ' ') + '] ' + m.autor + ': ' + m.texto.slice(0, 90).replace(/\n/g, ' '));
    if (!ups.length) { console.log('   -> irrelevante (sem update)'); }

    const aplicados = [];
    for (const upd of ups) {
      let alvo = (upd.projeto_idx != null && projetos[upd.projeto_idx]) ? projetos[upd.projeto_idx] : acharProjeto(projetos, clientesById, upd);
      const conf = typeof upd.confianca === 'number' ? upd.confianca : 0.5;

      // Rede de segurança: se a msg citou um código que NÃO bate com o do projeto
      // casado, é outro lote/imóvel do mesmo cliente => projeto novo (não sobrescreve).
      if (alvo && !alvo._ambiguo) {
        const codRef = norm(upd.codigo_mencionado);
        if (codRef && alvo.codigo && !norm(alvo.codigo).includes(codRef) && !codRef.includes(norm(alvo.codigo))) {
          console.log('   -> código "' + upd.codigo_mencionado + '" não bate com o do projeto casado (' + alvo.codigo + ') — tratando como PROJETO NOVO');
          upd.projeto_novo = true; alvo = null;
        }
      }

      if (alvo && alvo._ambiguo) {
        console.log('   -> AMBÍGUO ("' + (upd.cliente_mencionado || upd.codigo_mencionado) + '"): ' + alvo.candidatos.map(c => c.codigo || c.id.slice(0, 4)).join(', ') + ' — registra nota p/ revisão, não muda status');
        aplicados.push({ tipo: 'ambiguo', resumo: upd.resumo, confianca: conf });
        continue;
      }

      if (!alvo) {
        if (upd.projeto_novo) {
          console.log('   -> PROJETO NOVO: "' + (upd.cliente_mencionado || '?') + ' / ' + (upd.codigo_mencionado || '?') + '" — cria rascunho (revisar)');
          aplicados.push({ tipo: 'novo', cliente: upd.cliente_mencionado, codigo: upd.codigo_mencionado, resumo: upd.resumo, confianca: conf });
        } else {
          console.log('   -> não casou com nenhum projeto e não é novo — nota p/ revisão');
          aplicados.push({ tipo: 'sem_match', resumo: upd.resumo, confianca: conf });
        }
        continue;
      }

      const nome = (clientesById[alvo.cliente_id] || {}).nome;
      const mudaStatus = upd.novo_status && STATUS_VALIDOS.includes(upd.novo_status) && conf >= CONF_STATUS && upd.novo_status !== alvo.status;
      // valor do contrato dito no grupo (só grava se ainda não tem valor ou se mudou)
      const valorReais = (typeof upd.valor_contratado_reais === 'number' && upd.valor_contratado_reais > 0) ? upd.valor_contratado_reais : null;
      const novoTotal = (valorReais && conf >= CONF_STATUS) ? Math.round(valorReais * 100) : null;
      const mudaValor = novoTotal && novoTotal !== (+alvo.receita_total_centavos || 0);
      // entrada (regra: 30% antes de começar) — só marca PAGA se a msg afirmar que pagou
      const entradaPaga = upd.entrada_pendente === false && conf >= CONF_STATUS && !alvo.entrada_paga_em;
      const entradaFalta = upd.entrada_pendente === true;
      console.log('   -> ' + nome + ' / ' + (alvo.codigo || alvo.tipo) + (mudaStatus ? (': ' + alvo.status + ' => ' + upd.novo_status) : ' (status mantido)') + (mudaValor ? ' | CONTRATO R$ ' + (novoTotal / 100).toFixed(2) : '') + (entradaPaga ? ' | ENTRADA PAGA' : entradaFalta ? ' | falta entrada' : '') + (upd.proximo_passo ? ' | passo: ' + upd.proximo_passo.slice(0, 40) : '') + (upd.docs_recebidos && upd.docs_recebidos.length ? ' | docs: ' + upd.docs_recebidos.join(', ') : '') + ' [conf ' + conf + ']');
      aplicados.push({ tipo: 'update', projeto_id: alvo.id, cliente: nome, codigo: alvo.codigo, de: alvo.status, para: mudaStatus ? upd.novo_status : null, proximo_passo: upd.proximo_passo || null, docs: upd.docs_recebidos || [], valor_centavos: mudaValor ? novoTotal : null, entrada_paga: entradaPaga || null, entrada_falta: entradaFalta || null, confianca: conf, resumo: upd.resumo });

      if (!DRY_RUN) {
        // 1) atualiza o projeto (status/proximo_passo/valor/entrada/movimento/origem)
        const patch = { last_movement_at: new Date(m.ts * 1000).toISOString(), origem_ultimo_update: 'grupo' };
        if (mudaStatus) patch.status = upd.novo_status;
        if (upd.proximo_passo) patch.proximo_passo = upd.proximo_passo;
        if (mudaValor) patch.receita_total_centavos = novoTotal;
        if (entradaPaga) patch.entrada_paga_em = new Date(m.ts * 1000).toISOString();
        await sb('PATCH', '/rest/v1/fin_projetos?id=eq.' + alvo.id, patch);
        if (mudaStatus) alvo.status = upd.novo_status;  // reflete no contexto local
        if (mudaValor) alvo.receita_total_centavos = novoTotal;
        if (entradaPaga) alvo.entrada_paga_em = patch.entrada_paga_em;
        // eventos específicos de valor/entrada (sempre confirmado=false)
        if (mudaValor) await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'grupo', confirmado: false, tipo: 'nota', valor_centavos: novoTotal, descricao: '(auto do grupo) valor do contrato: R$ ' + (novoTotal / 100).toFixed(2) + ' — entrada de ' + (alvo.entrada_percentual || 30) + '% = R$ ' + ((novoTotal * (alvo.entrada_percentual || 30) / 100) / 100).toFixed(2) });
        if (entradaPaga) await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'grupo', confirmado: false, tipo: 'pagamento', descricao: '(auto do grupo) entrada informada como PAGA — liberado para iniciar' });
        if (entradaFalta) await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'grupo', confirmado: false, tipo: 'nota', descricao: '(auto do grupo) entrada ainda NÃO paga — não iniciar antes dos ' + (alvo.entrada_percentual || 30) + '%' });
        // 2) evento SEMPRE confirmado=false
        await sb('POST', '/rest/v1/fin_projeto_eventos', {
          projeto_id: alvo.id, origem: 'grupo', confirmado: false,
          tipo: mudaStatus ? 'status_change' : 'nota',
          descricao: (mudaStatus ? ('Status ' + alvo.status + ' (auto do grupo): ') : '(auto do grupo) ') + (upd.resumo || m.texto.slice(0, 120)),
        });
        // 3) documentos recebidos
        for (const docTxt of (upd.docs_recebidos || [])) {
          const docs = await sbGet('fin_projeto_docs', 'select=id,item,status&projeto_id=eq.' + alvo.id);
          const alvoDoc = docs.find(d => { const a = norm(d.item), b = norm(docTxt); return a.includes(b) || b.includes(a); });
          if (alvoDoc && alvoDoc.status !== 'recebido') {
            await sb('PATCH', '/rest/v1/fin_projeto_docs?id=eq.' + alvoDoc.id, { status: 'recebido', recebido_em: new Date(m.ts * 1000).toISOString(), origem: 'grupo' });
            await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: alvo.id, origem: 'grupo', confirmado: false, tipo: 'doc_recebido', descricao: '(auto do grupo) documento recebido: ' + alvoDoc.item });
          }
        }
      }
    }

    // projeto novo -> cria rascunho (fora do dry-run)
    if (!DRY_RUN) {
      for (const a of aplicados.filter(x => x.tipo === 'novo')) {
        // cliente: reusa o existente (match fuzzy, um só), senão cria
        let cli = null;
        if (a.cliente) {
          const cref = norm(a.cliente);
          const cands = clientes.filter(c => { const cn = norm(c.nome); return cn && (cn.includes(cref) || cref.includes(cn)); });
          if (cands.length === 1) cli = cands[0];
        }
        if (!cli && a.cliente) {
          const rc = await sb('POST', '/rest/v1/fin_projeto_clientes', { nome: a.cliente, obs: 'Criado automaticamente pelo feeder do grupo (revisar).' });
          cli = (JSON.parse(rc.body) || [])[0]; if (cli) { clientes.push(cli); clientesById[cli.id] = cli; }
        }
        if (cli) {
          const rp = await sb('POST', '/rest/v1/fin_projetos', {
            cliente_id: cli.id, codigo: a.codigo || null, tipo: 'outro', status: 'levantamento',
            descricao: 'Rascunho criado pelo feeder do grupo: ' + (a.resumo || ''), origem_ultimo_update: 'grupo',
            proximo_passo: 'Revisar rascunho vindo do grupo e completar dados',
          });
          const novo = (JSON.parse(rp.body) || [])[0];
          if (novo) { projetos.push(novo); await sb('POST', '/rest/v1/fin_projeto_eventos', { projeto_id: novo.id, origem: 'grupo', confirmado: false, tipo: 'nota', descricao: '(auto do grupo) projeto novo detectado: ' + (a.resumo || a.codigo || a.cliente) }); }
        }
      }
      // marca a mensagem como processada
      await sb('POST', '/rest/v1/projeto_feeder_processados', {
        msg_id: m.id, autor: m.autor, texto: m.texto, relevante: ups.length > 0, n_updates: aplicados.filter(x => x.tipo === 'update' || x.tipo === 'novo').length, resultado: aplicados,
      });
    }
    resultados.push({ msg: m.texto.slice(0, 60), aplicados });
  }

  const nUp = resultados.reduce((s, r) => s + r.aplicados.filter(a => a.tipo === 'update').length, 0);
  const nNovo = resultados.reduce((s, r) => s + r.aplicados.filter(a => a.tipo === 'novo').length, 0);
  const nRev = resultados.reduce((s, r) => s + r.aplicados.filter(a => a.tipo === 'ambiguo' || a.tipo === 'sem_match').length, 0);
  console.log('\n===== RESUMO: ' + msgs.length + ' msgs · ' + nUp + ' updates · ' + nNovo + ' projetos novos · ' + nRev + ' p/ revisão =====');
  if (DRY_RUN) console.log('(DRY-RUN — nada foi escrito no banco.)');
})().catch(e => { console.error('FALHA feeder: ' + (e && e.message || e)); process.exit(1); });
