'use strict';
/* ===================================================================
 * PERGUNTA DOS VALORES DE CONTRATO — mensagem separada do digest
 * -------------------------------------------------------------------
 * Por que separada: o digest é um RELATÓRIO; isto é um PEDIDO que precisa
 * de resposta. Pergunta no meio de 30 linhas não é respondida, e repetir a
 * lista todo dia vira ruído. Mesmo padrão que funcionou em jun/2026 no
 * sicoob_projetos.js (pergunta dedicada -> Claudemir respondeu).
 *
 * Pergunta SÓ quando há projeto ativo sem valor, e com COOLDOWN (default 3
 * dias) — some sozinha conforme os valores forem informados.
 * A resposta é capturada automaticamente pelo projeto_feeder.js, que já lê
 * o grupo e extrai valor_contratado_reais do texto.
 *
 * REGRA: só fala com a EQUIPE, no grupo Projetos. NUNCA com cliente.
 *
 * Modos: DRY_RUN=1 (mostra sem enviar) · FORCE=1 (ignora o cooldown)
 * =================================================================== */
const https = require('https');
const http = require('http');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace(/^https?:\/\//, '');
const SB_KEY = CFG.supabase_key;
const EVO_EP = (CFG.evo_url || '').replace(/^https?:\/\//, '').split(':');
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const GRUPO_PROJETOS = '120363407925288367@g.us';
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === '1';
const PCT_PADRAO = 30;   // % de entrada padrao citado na pergunta
const COOLDOWN_DIAS = parseInt(process.env.COOLDOWN_DIAS || '3');

function reqJSON(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const r = lib.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.setTimeout(30000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
function sb(method, path, body) {
  const d = body ? JSON.stringify(body) : null;
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
  if (d) { h['Content-Type'] = 'application/json'; h['Prefer'] = 'return=representation'; h['Content-Length'] = Buffer.byteLength(d); }
  return reqJSON({ hostname: SB_HOST, port: 443, method, path, headers: h }, d);
}
async function sbGet(t, q) { const r = await sb('GET', '/rest/v1/' + t + (q ? '?' + q : '')); if (r.status >= 300) throw new Error(t + ' ' + r.status); return JSON.parse(r.body); }
function evoSendGrupo(texto) {
  const d = JSON.stringify({ number: GRUPO_PROJETOS, text: texto });
  return reqJSON({ _http: true, hostname: EVO_EP[0], port: parseInt(EVO_EP[1] || '8080'), path: '/message/sendText/' + EVO_INSTANCE, method: 'POST', headers: { apikey: EVO_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, d);
}

const TIPOS = { averbacao: 'Averbação', regularizacao: 'Regularização', anexacao: 'Anexação', habite_se: 'Habite-se', alvara_construcao: 'Alvará', ampliacao: 'Ampliação', infraestrutura: 'Infraestrutura', aprovacao_condominio: 'Aprov. condomínio', outro: 'Projeto' };
const ATIVO = p => p.status !== 'entregue';

(async () => {
  // Agendado (SCHEDULED=1): pergunta às 7h25 BRT, dia útil (logo antes do
  // digest das 7h30). O cron do SO ignora CRON_TZ, então ele dispara de hora
  // em hora no minuto :25 e é ESTE guard, no relógio BRT do container, que
  // escolhe a hora certa — imune ao fuso do host e ao horário de verão europeu.
  if (process.env.SCHEDULED === '1') {
    const now = new Date(); const dow = now.getDay(), hh = now.getHours();
    if (!(dow >= 1 && dow <= 5 && hh === 7)) { console.log('Fora da janela (BRT ' + now.toTimeString().slice(0, 5) + ', dow ' + dow + '); pergunto só às 7h25 em dia útil.'); return; }
  }

  const [projetos, clientes, log] = await Promise.all([
    sbGet('fin_projetos', 'select=id,cliente_id,codigo,tipo,status,bairro,receita_total_centavos'),
    sbGet('fin_projeto_clientes', 'select=id,nome'),
    sbGet('projeto_digest_log', 'select=gerado_em,origem&origem=eq.pergunta_valores&order=gerado_em.desc&limit=1'),
  ]);
  const nome = id => (clientes.find(c => c.id === id) || {}).nome || '?';
  const semValor = projetos.filter(p => ATIVO(p) && !((+p.receita_total_centavos || 0) > 0));

  if (!semValor.length) { console.log('Todos os projetos ativos já têm valor. Nada a perguntar.'); return; }

  // cooldown: nao repetir a pergunta todo dia
  if (!FORCE && log.length) {
    const dias = (Date.now() - new Date(log[0].gerado_em)) / 86400000;
    if (dias < COOLDOWN_DIAS) { console.log('Já perguntei há ' + dias.toFixed(1) + ' dia(s) (cooldown ' + COOLDOWN_DIAS + 'd). Não pergunto de novo.'); return; }
  }

  const itens = semValor.map(p => {
    const rot = p.codigo ? p.codigo : (TIPOS[p.tipo] || 'Projeto') + (p.bairro ? ' ' + p.bairro : '');
    return '- ' + nome(p.cliente_id) + ' · ' + rot;
  });

  const L = [];
  L.push('Claudemir, preciso dos valores fechados destes ' + semValor.length + ' projetos:');
  L.push('');
  itens.forEach(i => L.push(i));
  L.push('');
  L.push('Só responder aqui no formato: código = valor');
  L.push('Ex: AH-24 = 3500 · JATOBA = 4 mil · Q-46 = 2.800');
  L.push('');
  L.push('É p/ quê: com o valor eu calculo a entrada de ' + PCT_PADRAO + '% e passo a cobrar quem começou sem pagar. Sem o valor não dá p/ controlar isso.');
  const conteudo = L.join('\n');

  console.log('===== PERGUNTA DOS VALORES ' + (DRY_RUN ? '(DRY-RUN)' : '(ENVIANDO)') + ' =====');
  console.log(conteudo);
  console.log('=====================================');
  if (DRY_RUN) { console.log('(DRY-RUN — nada enviado.)'); return; }

  const snd = await evoSendGrupo(conteudo);
  if (snd.status >= 300) throw new Error('Evolution ' + snd.status + ': ' + snd.body.slice(0, 200));
  // registra no mesmo log do digest (origem=pergunta_valores) p/ auditoria + cooldown
  await sb('POST', '/rest/v1/projeto_digest_log', { conteudo, resumo: { sem_valor: semValor.length, projetos: itens }, destino_jid: GRUPO_PROJETOS, enviado: true, enviado_em: new Date().toISOString(), origem: 'pergunta_valores' });
  console.log('ENVIADO ao grupo Projetos. Evolution status ' + snd.status + '. A resposta sera capturada pelo projeto_feeder.js.');
})().catch(e => { console.error('FALHA pergunta-valores: ' + (e && e.message || e)); process.exit(1); });
