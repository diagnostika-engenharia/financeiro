// "Extrair resposta" — lê o JSON do Gemini e gera 1 item por mensagem a enviar.
const GRUPO = '120363254845222563@g.us';

const resp = $input.first().json;
let txt = '';
try { txt = resp.choices[0].message.content; }
catch (e) { return [{ json: { _erro: 'ia_sem_resposta', raw: JSON.stringify(resp).slice(0, 300) } }]; }

let parsed = null;
try { parsed = JSON.parse(txt); }
catch (e) {
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
}
if (!parsed) return [{ json: { _erro: 'json_invalido', txt: txt.slice(0, 300) } }];

function limparMd(s) {
  return String(s)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^#+\s*/gm, '');
}

const acoes = (parsed && parsed.acoes) || [];
const out = [];
for (const a of acoes) {
  if (a && a.tipo === 'responder' && a.texto && String(a.texto).trim()) {
    out.push({ json: { grupo: GRUPO, texto: limparMd(String(a.texto).trim()) } });
  }
}
return out;
