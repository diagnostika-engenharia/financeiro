// No "Correlacionar" — JS puro (sem require). Le saidas dos nos anteriores,
// correlaciona mensagens do grupo x debitos nao-classificados.
// Saida: 1 item por match (_match:true) ou 1 item-resumo (_match:false) se 0 matches.

const msgResp = $('Buscar msgs').first().json;

// transacoes: HTTP pode dividir array em varios itens OU devolver 1 item com array
let txItems = $('Buscar txs').all().map(i => i.json);
let txs;
if (txItems.length === 1 && Array.isArray(txItems[0])) txs = txItems[0];
else txs = txItems.filter(x => x && typeof x === 'object' && ('id' in x || 'valor' in x));

function norm(s){return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();}
function toks(s){const STOP=new Set(['de','do','da','dos','das','em','no','na','nos','nas','para','por','com','pix','bra','ltda','eireli','sa','epp','the']);return norm(s).split(' ').filter(t=>t.length>2&&!STOP.has(t));}
function overlap(a,b){if(!a.length||!b.length)return 0;const sb=new Set(b);return a.filter(t=>sb.has(t)).length/Math.min(a.length,b.length);}
const CATS={'Refeição/Alimentação':['almoco','almoço','jantar','cafe','café','lanche','refeicao','refeição','restaurante','padaria','panificad','lanchonete','pizza','marmita','comida','sorvete','acai','açaí'],'Combustível':['gasolina','etanol','combustivel','combustível','posto','abastecimento','shell','ipiranga'],'Material/Papelaria':['material','papelaria','impressao','copia','xerox','toner'],'Cartório/Taxas':['cartorio','cartório','taxa','registro','averbacao','certidao'],'Transporte':['uber','taxi','táxi','estacionamento','pedagio','onibus'],'Software/Assinatura':['megazap','software','assinatura','licenca','openai','chatgpt']};
function detectCat(t){const n=norm(t);for(const[c,ks]of Object.entries(CATS))for(const k of ks)if(n.includes(norm(k)))return c;return null;}
function detectPeople(t){const n=norm(t);const f=new Set();if(n.includes('rogerio')||n.includes('rog '))f.add('Rogério');if(n.includes('claudemir')||n.includes('clau '))f.add('Claudemir');return[...f];}
function extractVal(t){const m=t.match(/R\$\s*([\d.,]+)/i);if(!m)return null;return parseFloat(m[1].replace(/\./g,'').replace(',','.'));}

function extractMsgs(resp){
  let arr = Array.isArray(resp) ? resp
    : (resp && resp.messages && resp.messages.records) || (resp && resp.messages) || (resp && resp.records) || [];
  if(!Array.isArray(arr)) arr=[];
  const cutoff = Date.now() - 12*3600*1000;
  const out=[];
  for(const m of arr){
    const ts=(m.messageTimestamp||0)*1000; if(ts<cutoff) continue;
    if(m.key && m.key.fromMe) continue;
    const text=(m.message&&m.message.conversation)||(m.message&&m.message.imageMessage&&m.message.imageMessage.caption)||(m.message&&m.message.extendedTextMessage&&m.message.extendedTextMessage.text)||(m.message&&m.message.videoMessage&&m.message.videoMessage.caption)||(m.message&&m.message.documentMessage&&m.message.documentMessage.caption)||'';
    if(!text||text.length<4) continue;
    out.push({id:m.key&&m.key.id, sender:m.pushName||'?', ts, text});
  }
  return out;
}

const msgs = extractMsgs(msgResp);

function correlate(msgs,txs){
  const matches=[];
  for(const msg of msgs){
    const cat=detectCat(msg.text), people=detectPeople(msg.text), val=extractVal(msg.text), mT=toks(msg.text);
    if(!cat && val===null && people.length===0) continue;
    for(const tx of txs){
      let s=0; const r=[];
      if(val!==null && Math.abs(val-Math.abs(tx.valor))<0.02){s+=5;r.push('valor');}
      const tT=toks([tx.observacao||'',tx.historico||''].join(' '));
      const ov=overlap(mT,tT);
      if(ov>=0.25){s+=Math.round(ov*4);r.push('local='+ov.toFixed(2));}
      const txD=new Date(tx.data+'T'+(tx.hora||'12:00')+':00-03:00').getTime();
      const dH=Math.abs(msg.ts-txD)/3600000;
      if(dH<=6){s+=2;r.push('tempo');}else if(dH<=12){s+=1;r.push('tempo');}
      if(cat){s+=1;r.push('cat');}
      if(s>=4) matches.push({tx,msg,cat,people,score:s,reasons:r.join(',')});
    }
  }
  matches.sort((a,b)=>b.score-a.score);
  const used=new Set();
  return matches.filter(m=>{if(used.has(m.tx.id))return false;used.add(m.tx.id);return true;});
}

const matches = correlate(msgs, txs);
if(!matches.length) return [{json:{_match:false, msgsTotal:msgs.length, txsNaoClassif:txs.length}}];
return matches.map(m=>({json:{
  _match:true,
  txId:m.tx.id, valor:Math.abs(m.tx.valor), data:m.tx.data,
  historico:m.tx.historico||'', observacao:m.tx.observacao||'',
  categoria:m.cat||'Despesa operacional',
  quem:(m.people.length?m.people.join(' e '):m.msg.sender),
  nota:m.msg.text.substring(0,120), legenda:m.msg.text.substring(0,80),
  score:m.score, motivos:m.reasons
}}));
