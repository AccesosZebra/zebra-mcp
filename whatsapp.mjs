// El Data Chat por WhatsApp. Evolution API (la pasarela que Zebra ya tiene) avisa por webhook de
// cada mensaje; aquí solo se contesta en los grupos de la lista y solo cuando mencionan al bot o
// responden a un mensaje suyo. Cada grupo está atado a un cliente, así que dentro de ese grupo las
// preguntas se entienden de ese cliente sin repetirlo.
import { timingSafeEqual } from 'node:crypto';

import { textoDeTurno } from './chat.mjs';

const TTL_MS = 30 * 60 * 1000; // media hora en silencio cierra la conversación
const MAX_MENSAJES = 12;       // y nunca se arrastran más de 12

const numero = (jid = '') => jid.split('@')[0].split(':')[0];
export const esGrupo = (jid = '') => jid.endsWith('@g.us');

/** ¿Este jid es el bot? WhatsApp lo nombra de dos formas y las menciones usan la nueva. */
export const esElBot = (jid, mias) => Boolean(jid) && mias.has(numero(jid));

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

/** Decide si este mensaje merece respuesta, y de qué cliente habla. */
export function debeResponder({ data, mias, permitidos }) {
  const jid = data?.key?.remoteJid ?? '';
  if (data?.key?.fromMe) return { responder: false, motivo: 'lo mandó el propio bot' };
  if (!esGrupo(jid)) return { responder: false, motivo: 'no es un grupo' };
  if (!permitidos.has(jid)) return { responder: false, motivo: 'grupo fuera de la lista' };

  // Sin saber cómo se llama a sí mismo no hay forma de juzgar la mención: decir "no lo
  // mencionaron" sería mentir y manda a buscar el problema al sitio equivocado.
  if (!mias?.size) return { responder: false, motivo: 'no sé quién soy' };

  // En los mensajes con formato el contexto viaja dentro del propio mensaje, no al lado.
  const ctx = data?.contextInfo ?? data?.message?.extendedTextMessage?.contextInfo ?? {};
  const mencionado = (ctx.mentionedJid ?? []).some((j) => esElBot(j, mias));
  const leResponden = esElBot(ctx.participant ?? '', mias);
  if (!mencionado && !leResponden) return { responder: false, motivo: 'no lo mencionaron' };

  const pregunta = limpiar(textoDe(data) ?? '');
  if (!pregunta) return { responder: false, motivo: 'sin texto' };
  return { responder: true, jid, cliente: permitidos.get(jid) ?? null, pregunta };
}

// Cómo se llama el bot a sí mismo. Son DOS nombres: su número (5219…@s.whatsapp.net) y su @lid
// (2593…@lid), que es el que aparece en las menciones desde que WhatsApp cambió el
// direccionamiento. Comparar solo contra el número hacía que ninguna mención coincidiera.
// Evolution no expone el lid de la instancia: el que lo trae es la lista de participantes de un
// grupo, con el teléfono de cada uno al lado. Se resuelve una vez y se recuerda.
let mias = null;
export async function identidades(grupoJid, senderDelSobre) {
  if (mias?.size) return mias;
  const propias = new Set();
  const apuntar = (jid) => { if (jid) propias.add(numero(jid)); };
  const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
  const cabeceras = { apikey: process.env.EVOLUTION_API_KEY };
  const pedir = async (ruta) => (await fetch(`${base}${ruta}`, { headers: cabeceras })).json();

  apuntar(senderDelSobre); // el sobre del webhook a veces ya lo trae, en una forma u otra
  try {
    const d = await pedir(`/instance/fetchInstances?instanceName=${encodeURIComponent(process.env.EVOLUTION_INSTANCE)}`);
    const inst = Array.isArray(d) ? d[0] : (d?.instance ?? d);
    apuntar(inst?.ownerJid ?? inst?.owner);

    const g = await pedir(`/group/participants/${process.env.EVOLUTION_INSTANCE}?groupJid=${encodeURIComponent(grupoJid)}`);
    for (const p of g?.participants ?? []) if (propias.has(numero(p.phoneNumber ?? ''))) apuntar(p.id);
  } catch (e) {
    console.error('wa: no pude averiguar quien soy:', e.message);
  }

  if (!propias.size) console.error('wa: sin identidad propia, ninguna mencion va a coincidir');
  // Con las dos formas ya no hay nada que reintentar; con una sola, se vuelve a intentar luego.
  if (propias.size >= 2) mias = propias;
  return propias;
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
    const r = await textoDeTurno(c.messages, 'whatsapp', cliente);
    const texto = r.texto || 'No pude responder eso. Pregúntamelo de otra forma.';
    if (r.stop === 'refusal') c.messages.pop();
    else c.messages.push({ role: 'assistant', content: texto });
    console.log(JSON.stringify({ wa: jid, cliente, ms: Date.now() - t0, stop: r.stop, model: r.modelo, in: r.usage?.input_tokens ?? 0, out: r.usage?.output_tokens ?? 0 }));
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

    // Preguntar quién soy solo para los grupos de la lista: los demás no gastan ni una llamada.
    const permitidos = gruposPermitidos();
    const enLista = permitidos.has(data?.key?.remoteJid ?? '');
    const veredicto = debeResponder({
      data,
      mias: enLista ? await identidades(data.key.remoteJid, sender) : new Set(),
      permitidos,
    });
    if (!veredicto.responder) {
      return console.log(JSON.stringify({ wa: data?.key?.remoteJid ?? '?', ignorado: veredicto.motivo }));
    }
    void responder(veredicto);
  });
}
