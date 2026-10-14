// Backend del chat web: recibe la conversación, se la pasa al proveedor activo (que consulta la
// base a través del MCP) y devuelve la respuesta en NDJSON, como el Editor de Prompt Studio.
import { contextoActual } from './guia.mjs';
import { activo, causaDeFallo, pedirOpenAI, registrarExito, registrarFallo, streamAnthropic } from './proveedores.mjs';

const MAX_MENSAJES = 60;
const MAX_BYTES = 90_000; // por debajo del límite de 100kb de express.json

// El navegador solo guarda el texto de cada turno: el historial pesa poco y nadie puede colar
// resultados de herramientas inventados. El modelo vuelve a consultar si lo necesita.
function validMessages(m) {
  return Array.isArray(m) && m.length > 0 && m.length <= MAX_MENSAJES
    && m.every((x) => (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string' && x.content.trim())
    && m.at(-1).role === 'user'
    && Buffer.byteLength(JSON.stringify(m)) <= MAX_BYTES;
}

// ponytail: límite en memoria por proceso (una sola instancia en EasyPanel); a Redis si se escala.
const hits = new Map();
function allowed(email, now = Date.now()) {
  const recent = (hits.get(email) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  const tooFast = recent.length > 0 && now - recent.at(-1) < 2000;
  hits.set(email, recent);
  if (tooFast || recent.length >= 60) return false;
  recent.push(now);
  return true;
}

const preview = (content) => (typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join(''))
  .slice(0, 400);

function errorMessage(e) {
  const causa = causaDeFallo(e);
  if (causa) return causa.texto;
  if (e?.status) return `No se pudo obtener la respuesta (${e.status}).`;
  return e?.message || 'No se pudo obtener la respuesta.';
}

/** Un turno del chat web, con el proveedor que esté activo. */
function turno({ messages, canal = 'web', cliente = null, send, onFinal }) {
  const { proveedor, modelo } = activo();
  if (proveedor === 'openai') {
    return pedirOpenAI(messages, canal, cliente, modelo).then(({ texto, herramientas, usage }) => {
      // OpenAI resuelve el bucle entero antes de responder: las consultas se muestran de golpe.
      herramientas.forEach((h, i) => {
        send({ type: 'tool', id: String(i), name: h.name, input: h.input });
        send({ type: 'tool_result', id: String(i), error: h.error, preview: h.preview });
      });
      if (texto) send({ type: 'text', text: texto });
      onFinal({ modelo, stop: 'end_turn', in: usage?.input_tokens ?? 0, out: usage?.output_tokens ?? 0 });
    });
  }

  const stream = streamAnthropic(messages, canal, cliente, modelo);
  let sawText = false;
  stream.on('streamEvent', (e) => {
    if (e.type !== 'content_block_start') return;
    // Claude narra lo que va a hacer antes de consultar: el navegador borra ese texto al ver `reset`.
    if (e.content_block.type === 'mcp_tool_use' && sawText) { sawText = false; send({ type: 'reset' }); }
    if (e.content_block.type === 'text' && sawText) send({ type: 'text', text: '\n\n' });
  });
  stream.on('text', (text) => { sawText = true; send({ type: 'text', text }); });
  stream.on('contentBlock', (block) => {
    if (block.type === 'mcp_tool_use') send({ type: 'tool', id: block.id, name: block.name, input: block.input });
    if (block.type === 'mcp_tool_result') send({ type: 'tool_result', id: block.tool_use_id, error: block.is_error, preview: preview(block.content) });
  });
  return stream.finalMessage().then((msg) => {
    if (msg.stop_reason === 'refusal') send({ type: 'text', text: '\n\nNo puedo responder esa pregunta.' });
    if (msg.stop_reason === 'max_tokens') send({ type: 'text', text: '\n\n(La respuesta se cortó por largo. Pide menos detalle.)' });
    onFinal({ modelo: msg.model, stop: msg.stop_reason, in: msg.usage.input_tokens, out: msg.usage.output_tokens });
  });
}

export function mountChat(app, requireSession) {
  // La barra lateral muestra quién está dentro.
  app.get('/api/me', requireSession, (req, res) => res.json({ email: req.user.email, rol: req.user.rol, negocio: contextoActual()?.nombre || null }));

  app.post('/api/chat', requireSession, async (req, res) => {
    const { messages } = req.body ?? {};
    if (!validMessages(messages)) return res.status(400).json({ error: 'La conversación no es válida o es demasiado larga. Empieza una nueva.' });
    if (!allowed(req.user.email)) return res.status(429).json({ error: 'Vas muy rápido. Espera unos segundos.' });

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const send = (evt) => { if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n'); };
    const ping = setInterval(() => send({ type: 'ping' }), 15_000);
    const t0 = Date.now();

    try {
      await turno({
        messages,
        send,
        onFinal: ({ modelo, stop, in: entrada, out }) =>
          console.log(JSON.stringify({ chat: req.user.email, ms: Date.now() - t0, stop, model: modelo, in: entrada, out })),
      });
      send({ type: 'done' });
      registrarExito();
    } catch (e) {
      console.error('chat:', e?.status ?? '', e?.message);
      registrarFallo(causaDeFallo(e), 'chat');
      send({ type: 'error', message: errorMessage(e) });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });
}

/** El texto final de un turno, sin streaming. Lo usa el bot de WhatsApp. */
export async function textoDeTurno(messages, canal, cliente) {
  const { proveedor, modelo } = activo();
  if (proveedor === 'openai') {
    const { texto, usage } = await pedirOpenAI(messages, canal, cliente, modelo);
    return { texto, modelo, stop: 'end_turn', usage };
  }
  const msg = await streamAnthropic(messages, canal, cliente, modelo).finalMessage();
  // La respuesta es lo que Claude escribe DESPUÉS de la última consulta: lo anterior son notas.
  const ultima = msg.content.map((b) => b.type).lastIndexOf('mcp_tool_result');
  const texto = msg.content.slice(ultima + 1).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { texto, modelo: msg.model, stop: msg.stop_reason, usage: msg.usage };
}
