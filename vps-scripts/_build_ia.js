// Monta e cria o workflow "Financeiro — IA" via API n8n.
// Uso: N8NKEY="..." node _build_ia.js
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

const filtrar = read('_ia_filtrar_novas.js');
const montar  = read('_ia_montar_prompt.js');
const extrair = read('_ia_extrair_resposta.js');

const GJID = '120363254845222563@g.us';
const evoCred = { httpHeaderAuth: { id: 'rT3fxrnBbDxkTWNw', name: 'Evolution apikey' } };
const pgCred  = { postgres: { id: 'LQ0Lu1R0sqq8sAMz', name: 'Postgres account' } };
const oaiCred = { openAiApi: { id: 'oxUNjZdVarEJYg3x', name: 'OpenAI - Diagnóstika' } };

const wf = {
  name: 'Financeiro — IA',
  nodes: [
    { parameters: { rule: { interval: [{ field: 'cronExpression', expression: '* 7-23 * * *' }] } },
      id: 'a1', name: 'Agendador', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 300] },
    { parameters: { method: 'POST', url: 'https://evo.84.46.248.23.sslip.io/chat/findMessages/diagnostika',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ where:{ key:{ remoteJid: "' + GJID + '" } }, page:1, offset:30 }) }}', options: {} },
      id: 'a2', name: 'Buscar msgs', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 300], credentials: evoCred },
    { parameters: { jsCode: filtrar, mode: 'runOnceForAllItems' },
      id: 'a3', name: 'Filtrar novas', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 300] },
    { parameters: { operation: 'executeQuery',
        query: "SELECT id, data::text AS data, historico, valor::text AS valor, tipo, categoria, observacao FROM fin_transacoes_bancarias WHERE data >= to_char((CURRENT_DATE - INTERVAL '45 days'),'YYYY-MM-DD') ORDER BY data DESC LIMIT 400" },
      id: 'a4', name: 'Buscar txs', type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: [660, 300], credentials: pgCred },
    { parameters: { jsCode: montar, mode: 'runOnceForAllItems' },
      id: 'a5', name: 'Montar prompt', type: 'n8n-nodes-base.code', typeVersion: 2, position: [880, 300] },
    { parameters: { method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
        authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: {} },
      id: 'a6', name: 'IA (OpenAI)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1100, 300], credentials: oaiCred, disabled: true },
    { parameters: { jsCode: extrair, mode: 'runOnceForAllItems' },
      id: 'a7', name: 'Extrair resposta', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1320, 300] },
    { parameters: { method: 'POST', url: 'https://evo.84.46.248.23.sslip.io/message/sendText/diagnostika',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ number: $json.grupo, text: $json.texto }) }}', options: {} },
      id: 'a8', name: 'Notificar', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1540, 300], credentials: evoCred, disabled: true }
  ],
  connections: {
    'Agendador': { main: [[{ node: 'Buscar msgs', type: 'main', index: 0 }]] },
    'Buscar msgs': { main: [[{ node: 'Filtrar novas', type: 'main', index: 0 }]] },
    'Filtrar novas': { main: [[{ node: 'Buscar txs', type: 'main', index: 0 }]] },
    'Buscar txs': { main: [[{ node: 'Montar prompt', type: 'main', index: 0 }]] },
    'Montar prompt': { main: [[{ node: 'IA (OpenAI)', type: 'main', index: 0 }]] },
    'IA (OpenAI)': { main: [[{ node: 'Extrair resposta', type: 'main', index: 0 }]] },
    'Extrair resposta': { main: [[{ node: 'Notificar', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1' }
};

// Sem chave: apenas escreve o JSON do workflow pra importar no n8n.
const outFile = path.join(dir, 'Financeiro_IA_importar.json');
fs.writeFileSync(outFile, JSON.stringify(wf, null, 2), 'utf8');
console.log('Arquivo gerado:', outFile);
console.log('Nós:', wf.nodes.map(n => n.name + (n.disabled ? ' (OFF)' : '')).join(', '));
