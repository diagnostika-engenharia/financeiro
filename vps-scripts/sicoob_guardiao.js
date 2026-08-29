'use strict';
// GUARDIAO da sincronizacao do Sicoob.
// Testa o MESMO caminho de upsert que o robo usa em producao (POST on_conflict=hash +
// Prefer resolution=ignore-duplicates). Se o schema divergir do codigo (ex.: indice unico
// virou parcial e o on_conflict deixou de casar -> erro 42P10), o insert de teste falha e o
// guardiao AVISA no grupo Financeiro. NAO tenta consertar sozinho — so alerta.
// Verde = silencioso (nao polui o grupo). Sempre limpa o registro de teste.
const fs = require('fs');
const https = require('https');
const http = require('http');

const CFG = JSON.parse(fs.readFileSync('/home/node/.n8n/sicoob_config.json', 'utf8'));
const SB_HOST = CFG.supabase_url.replace('https://', '');
const SB_KEY = CFG.supabase_key;
const EVO_HOST = (CFG.evo_url || '').replace('http://', '').replace('https://', '');
const EVO_INSTANCE = CFG.evo_instance;
const EVO_KEY = CFG.evo_apikey;
const GRUPO = CFG.grupo_financeiro;
const DRY = process.env.DRY_RUN === '1';   // nao envia alerta, so imprime

function reqHttps(opts, data) {
  return new Promise((resolve, reject) => {
    const lib = opts._http ? http : https;
    const r = lib.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); r.setTimeout(25000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
function sb(method, path, body, extra) {
  const data = body ? JSON.stringify(body) : null;
  const headers = Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, extra || {});
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  return reqHttps({ hostname: SB_HOST, port: 443, method, path, headers }, data);
}
async function alertarGrupo(texto) {
  const p = EVO_HOST.split(':');
  const payload = JSON.stringify({ number: GRUPO, text: texto });
  return reqHttps({ _http: true, hostname: p[0], port: parseInt(p[1] || '8080'), method: 'POST', path: '/message/sendText/' + EVO_INSTANCE, headers: { apikey: EVO_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload);
}

const T = '/rest/v1/fin_transacoes_bancarias';
const HASH = 'sic_guardiao_smoke';
const row = {
  conta: 'GUARDIAO', data: '2000-01-01', historico: 'GUARDIAO SMOKE (ignore)', descricao: 'GUARDIAO SMOKE (ignore)',
  valor: 0.01, tipo: 'credito', categoria: 'Não classificado', tipo_categoria: 'Receita',
  status: 'classificado', competencia: '2000-01', origem_arquivo: 'guardiao_smoke', observacao: '', hora: '00:00', hash: HASH
};

(async () => {
  let falha = null;
  try {
    await sb('DELETE', T + '?hash=eq.' + HASH, null, { Prefer: 'return=minimal' }); // limpa resto anterior
    // 1) insert novo pelo MESMO caminho do robo — 42P10 aqui = schema divergente do codigo
    const i1 = await sb('POST', T + '?on_conflict=hash', [row], { Prefer: 'resolution=ignore-duplicates,return=representation' });
    if (i1.status >= 300 || /42P10/.test(i1.body)) throw new Error('INSERT falhou (status ' + i1.status + '): ' + i1.body.slice(0, 200));
    // 2) reinsert identico -> idempotente (0 linhas), sem erro
    const i2 = await sb('POST', T + '?on_conflict=hash', [row], { Prefer: 'resolution=ignore-duplicates,return=representation' });
    if (i2.status >= 300 || /42P10/.test(i2.body)) throw new Error('REINSERT falhou (status ' + i2.status + '): ' + i2.body.slice(0, 200));
    const b2 = JSON.parse(i2.body);
    if (Array.isArray(b2) && b2.length !== 0) throw new Error('idempotencia quebrada: reinsert criou ' + b2.length + ' linha(s)');
    // 3) exatamente 1 linha no banco (sem duplicata)
    const g = await sb('GET', T + '?hash=eq.' + HASH + '&select=id');
    const n = JSON.parse(g.body).length;
    if (n !== 1) throw new Error('esperado 1 linha de teste, encontrado ' + n + ' (duplicata?)');
  } catch (e) {
    falha = e.message;
  } finally {
    try { await sb('DELETE', T + '?hash=eq.' + HASH, null, { Prefer: 'return=minimal' }); } catch (e) {} // limpeza sempre
  }

  if (!falha) { console.log('GUARDIAO: VERDE — upsert on_conflict=hash ok, idempotente, sem duplicata.'); return; }

  const msg = [
    '🛡️ ALERTA DO GUARDIAO — sincronizacao do Sicoob EM RISCO',
    'Claudemir e Rogerio, atencao.',
    '',
    'O teste automatico do upsert do extrato FALHOU. Provavel divergencia entre o schema do banco e o codigo do robo (o INSERT do robo usa ON CONFLICT (hash) e pode ter perdido o indice unico compativel).',
    '',
    'Erro: ' + falha,
    '',
    'Efeito: enquanto isso, novas transacoes do extrato podem NAO estar entrando no sistema.',
    '',
    'Como reverter/consertar: garantir um indice unico NAO-PARCIAL em fin_transacoes_bancarias(hash):',
    'DROP INDEX IF EXISTS ux_fin_transacoes_hash; CREATE UNIQUE INDEX ux_fin_transacoes_hash ON fin_transacoes_bancarias (hash);',
    '(nunca deixar o indice parcial com WHERE — o on_conflict=hash do robo nao casa com indice parcial).',
    '',
    'O guardiao NAO corrige sozinho — so avisa.'
  ].join('\n');
  console.error('GUARDIAO: VERMELHO — ' + falha);
  if (DRY) { console.log('[DRY_RUN] alerta NAO enviado. Previa:\n' + msg); process.exit(1); }
  try { const st = await alertarGrupo(msg); console.log('alerta enviado ao grupo, status ' + st.status); } catch (e) { console.error('falha ao enviar alerta: ' + e.message); }
  process.exit(1);
})().catch(e => { console.error('GUARDIAO erro inesperado: ' + e.message); process.exit(1); });
