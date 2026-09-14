// El Data Chat por WhatsApp. Evolution API (la pasarela que Zebra ya tiene) avisa por webhook de
// cada mensaje entrante; aquí se responde con el mismo Claude y el mismo MCP que el chat web, y la
// respuesta vuelve por la API de Evolution.
import { timingSafeEqual } from 'node:crypto';

import { turnStream } from './chat.mjs';

const TTL_MS = 30 * 60 * 1000; // media hora en silencio cierra la conversación
const MAX_MENSAJES = 12;       // y nunca se arrastran más de 12

export const numeroDe = (jid = '') => jid.split('@')[0].split(':')[0];
const permitidos = () => (process.env.WHATSAPP_ALLOWED ?? '').split(',').map((n) => n.trim()).filter(Boolean);

// ponytail: historial en memoria del proceso, como el resto del chat. Se pierde al desplegar, que
// para preguntas sueltas del equipo no importa. Si hiciera falta que sobreviva, a Postgres.
const chats = new Map();
function historial(numero, ahora = Date.now()) {
  for (const [k, v] of chats) if (ahora - v.at > TTL_MS) chats.delete(k);
  const c = chats.get(numero) ?? { messages: [], at: ahora };
  c.at = ahora;
  chats.set(numero, c);
  return c;
}

// Evolution normaliza el texto con formato a `conversation`, así que basta con mirar esos dos campos.
export const textoDe = (data) => data?.message?.conversation ?? data?.message?.extendedTextMessage?.text ?? null;

// La respuesta es lo que Claude escribe DESPUÉS de la última consulta: lo anterior son notas de
// progreso (en la web se descartan con el evento `reset`).
export function respuestaFinal(content) {
  const ultima = content.map((b) => b.type).lastIndexOf('mcp_tool_result');
  return content.slice(ultima + 1).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function enviar(numero, texto) {
  const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: numero, text: texto }),
  });
  if (!res.ok) console.error('evolution sendText:', res.status, (await res.text()).slice(0, 200));
}

async function responder(numero, pregunta) {
  const c = historial(numero);
  c.messages.push({ role: 'user', content: pregunta });
  c.messages = c.messages.slice(-MAX_MENSAJES);
  const t0 = Date.now();
  try {
    const msg = await turnStream(c.messages, 'whatsapp').finalMessage();
    const texto = respuestaFinal(msg.content) || 'No pude responder eso. Pregúntamelo de otra forma.';
    if (msg.stop_reason === 'refusal') c.messages.pop();
    else c.messages.push({ role: 'assistant', content: texto });
    console.log(JSON.stringify({ wa: numero, ms: Date.now() - t0, stop: msg.stop_reason, in: msg.usage.input_tokens, out: msg.usage.output_tokens }));
    await enviar(numero, texto);
  } catch (e) {
    console.error('wa:', e?.status ?? '', e?.message);
    c.messages.pop(); // la pregunta que falló no ensucia el hilo
    await enviar(numero, 'Se me cayó la consulta. Vuelve a preguntarme en un momento.');
  }
}

export function mountWhatsapp(app) {
  const esperado = Buffer.from(process.env.WHATSAPP_WEBHOOK_SECRET);

  app.post('/api/whatsapp', (req, res) => {
    // Evolution manda las cabeceras que se configuren en la instancia: ahí va el secreto.
    const recibido = Buffer.from(req.get('x-zebra-secret') ?? '');
    if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Un turno tarda entre 10 y 30 s y Evolution corta a los 30: se acepta el aviso y se responde aparte.
    res.json({ ok: true });

    const { event, data } = req.body ?? {};
    if (event !== 'messages.upsert') return;

    const jid = data?.key?.remoteJid ?? '';
    if (data?.key?.fromMe || jid.endsWith('@g.us')) return; // ni lo que manda el propio bot ni grupos
    const numero = numeroDe(jid);

    const lista = permitidos();
    if (lista.length > 0 && !lista.includes(numero)) {
      return console.log(JSON.stringify({ wa: numero, ignorado: 'fuera de la lista' }));
    }

    const pregunta = textoDe(data)?.trim();
    if (!pregunta) return void enviar(numero, 'Por ahora solo entiendo mensajes de texto.');
    void responder(numero, pregunta);
  });
}
