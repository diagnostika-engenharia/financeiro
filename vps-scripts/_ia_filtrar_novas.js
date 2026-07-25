// "Filtrar novas" — pega só mensagens novas do grupo (dedup via static data),
// não-do-bot, dos últimos 20 min. Marca como processadas (otimista).
// Captura também o texto CITADO (quando é resposta a um aviso).

const store = $getWorkflowStaticData('global');
if (!Array.isArray(store.done)) store.done = [];
const doneSet = new Set(store.done);

const resp = $input.first().json;
let arr = Array.isArray(resp) ? resp
  : (resp && resp.messages && resp.messages.records) || (resp && resp.messages) || (resp && resp.records) || [];
if (!Array.isArray(arr)) arr = [];

const cutoff = Date.now() - 20 * 60 * 1000;
const novas = [];
for (const m of arr) {
  const ts = (m.messageTimestamp || 0) * 1000;
  if (ts < cutoff) continue;
  if (m.key && m.key.fromMe) continue;
  const id = m.key && m.key.id;
  if (!id || doneSet.has(id)) continue;

  const msg = m.message || {};
  const text = msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || (msg.imageMessage && msg.imageMessage.caption)
    || (msg.videoMessage && msg.videoMessage.caption)
    || (msg.documentMessage && msg.documentMessage.caption) || '';

  let quoted = '';
  try {
    const ci = msg.extendedTextMessage && msg.extendedTextMessage.contextInfo;
    const qm = ci && ci.quotedMessage;
    if (qm) quoted = qm.conversation
      || (qm.extendedTextMessage && qm.extendedTextMessage.text)
      || (qm.imageMessage && qm.imageMessage.caption) || '';
  } catch (e) {}

  if (!text || text.trim().length < 2) continue;
  novas.push({ id, sender: m.pushName || '?', ts, text: text.trim(), quoted: (quoted || '').trim() });
}

for (const n of novas) store.done.push(n.id);
if (store.done.length > 800) store.done = store.done.slice(-800);

return novas.map(n => ({ json: n }));
