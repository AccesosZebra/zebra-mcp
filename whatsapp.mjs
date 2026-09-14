// El Data Chat por WhatsApp. Evolution API (la pasarela que Zebra ya tiene) avisa por webhook de
// cada mensaje; aquí solo se contesta en los grupos de la lista y solo cuando mencionan al bot o
// responden a un mensaje suyo. Cada grupo está atado a un cliente, así que dentro de ese grupo las
// preguntas se entienden de ese cliente sin repetirlo.
import { timingSafeEqual } from 'node:crypto';

import { turnStream } from './chat.mjs';

const TTL_MS = 30 * 60 * 1000; // media hora en silencio cierra la conversación
const MAX_MENSAJES = 12;       // y nunca se arrastran más de 12

const numero = (jid = '') => jid.split('@')[0].split(':')[0];
export const esGrupo = (jid = '') => jid.endsWith('@g.us');
export const mismoNumero = (a, b) => Boolean(a && b) && numero(a) === numero(b);

/** WHATSAPP_GROUPS = "1203630@g.us=Sofía, 1203631@g.us=Grupo Gira" */
export function gruposPermitidos(crudo = process.env.WHATSAPP_GROUPS ?? '') {
  const mapa = new Map();
  for (const par of crudo.split(',')) {
    const [jid, ...resto] = par.split('=');
    const id = jid.trim();
    if (id) mapa.set(id, resto.join('=').trim() || null);
  }
  return mapa;
}

// Evolution normaliza el texto con formato a `conversation`.
export const textoDe = (data) => data?.message?.conversation ?? data?.message?.extendedTextMessage?.text ?? null;

// La mención llega como "@5219997923682" dentro del texto; al bot no le aporta nada.
export const limpiar = (texto = '') => texto.replace(/@\d{6,}/g, ' ').replace(/\s+/g, ' ').trim();

/** La respuesta es lo que Claude escribe DESPUÉS de la última consulta: lo anterior son notas. */
export function respuestaFinal(content) {
  const ultima = content.map((b) => b.type).lastIndexOf('mcp_tool_result');
  return content.slice(ultima + 1).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Decide si este mensaje merece respuesta, y de qué cliente habla. */
export function debeResponder({ data, botJid, permitidos }) {
  const jid = data?.key?.remoteJid ?? '';
  if (data?.key?.fromMe) return { responder: false, motivo: 'lo mandó el propio bot' };
  if (!esGrupo(jid)) return { responder: false, motivo: 'no es un grupo' };
  if (!permitidos.has(jid)) return { responder: false, motivo: 'grupo fuera de la lista' };

  // Sin el número propio no hay forma de saber si la mención era para el bot: decir "no lo
  // mencionaron" sería mentir y manda a buscar el problema al sitio equivocado.
  if (!botJid) return { responder: false, motivo: 'no sé mi propio número' };

  const ctx = data?.contextInfo ?? {};
  const mencionado = (ctx.mentionedJid ?? []).some((j) => mismoNumero(j, botJid));
  const leResponden = mismoNumero(ctx.participant ?? '', botJid);
  if (!mencionado && !leResponden) return { responder: false, motivo: 'no lo mencionaron' };

  const pregunta = limpiar(textoDe(data) ?? '');
  if (!pregunta) return { responder: false, motivo: 'sin texto' };
  return { responder: true, jid, cliente: permitidos.get(jid) ?? null, pregunta };
}

// El número propio del bot: se pregunta una vez y se recuerda. Sin él no se puede saber si lo
// mencionaron, así que si no se resuelve hay que gritarlo, no callar.
// Ojo: `connectionState` NO lo trae (solo instanceName y state); el que lo tiene es `fetchInstances`.
let jidPropio = null;
export async function botJid(senderDelSobre) {
  if (jidPropio) return jidPropio;
  if (senderDelSobre) return (jidPropio = senderDelSobre);
  const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/instance/fetchInstances?instanceName=${encodeURIComponent(process.env.EVOLUTION_INSTANCE)}`, {
    headers: { apikey: process.env.EVOLUTION_API_KEY },
  });
  const d = await res.json().catch(() => null);
  const inst = Array.isArray(d) ? d[0] : (d?.instance ?? d);
  jidPropio = inst?.ownerJid ?? inst?.owner ?? null;
  if (!jidPropio) console.error('wa: no pude averiguar mi propio numero, ninguna mencion va a coincidir');
  return jidPropio;
}

// ponytail: historial en memoria del proceso, por grupo. Se pierde al desplegar, que para preguntas
// sueltas del equipo no importa. Si hiciera falta que sobreviva, a Postgres.
const chats = new Map();
function historial(clave, ahora = Date.now()) {
  for (const [k, v] of chats) if (ahora - v.at > TTL_MS) chats.delete(k);
  const c = chats.get(clave) ?? { messages: [], at: ahora };
  c.at = ahora;
  chats.set(clave, c);
  return c;
}

async function enviar(destino, texto) {
  const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: destino, text: texto }),
  });
  if (!res.ok) console.error('evolution sendText:', res.status, (await res.text()).slice(0, 200));
}

async function responder({ jid, cliente, pregunta }) {
  const c = historial(jid);
  c.messages.push({ role: 'user', content: pregunta });
  c.messages = c.messages.slice(-MAX_MENSAJES);
  const t0 = Date.now();
  try {
    const msg = await turnStream(c.messages, 'whatsapp', cliente).finalMessage();
    const texto = respuestaFinal(msg.content) || 'No pude responder eso. Pregúntamelo de otra forma.';
    if (msg.stop_reason === 'refusal') c.messages.pop();
    else c.messages.push({ role: 'assistant', content: texto });
    console.log(JSON.stringify({ wa: jid, cliente, ms: Date.now() - t0, stop: msg.stop_reason, in: msg.usage.input_tokens, out: msg.usage.output_tokens }));
    await enviar(jid, texto);
  } catch (e) {
    console.error('wa:', e?.status ?? '', e?.message);
    c.messages.pop(); // la pregunta que falló no ensucia el hilo
    await enviar(jid, 'Se me cayó la consulta. Vuelve a preguntarme en un momento.');
  }
}

export function mountWhatsapp(app) {
  const esperado = Buffer.from(process.env.WHATSAPP_WEBHOOK_SECRET);

  app.post('/api/whatsapp', async (req, res) => {
    // Evolution manda las cabeceras que se configuren en la instancia: ahí va el secreto.
    const recibido = Buffer.from(req.get('x-zebra-secret') ?? '');
    if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Un turno tarda entre 10 y 30 s y Evolution corta a los 30: se acepta y se responde aparte.
    res.json({ ok: true });

    const { event, data, sender } = req.body ?? {};
    if (event !== 'messages.upsert') return;

    const veredicto = debeResponder({ data, botJid: await botJid(sender), permitidos: gruposPermitidos() });
    if (!veredicto.responder) {
      return console.log(JSON.stringify({ wa: data?.key?.remoteJid ?? '?', ignorado: veredicto.motivo }));
    }
    void responder(veredicto);
  });
}
