// Backend del chat: una ruta que manda la conversación a Claude con el MCP de la
// base conectado (el conector de Anthropic hace el bucle de herramientas) y
// devuelve la respuesta en NDJSON, como el Editor de Prompt Studio.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5';
const MAX_MESSAGES = 60;
const MAX_BYTES = 90_000; // por debajo del límite de 100kb de express.json

const system = () => `Eres el analista de datos de Zebra, una agencia de marketing. Respondes preguntas del equipo sobre las métricas de sus clientes (leads, gasto en pauta, citas, apartados, cierres, llamadas) consultando la base de métricas con las herramientas de zebra-db.

Cómo trabajar:
- Toda cifra sale de una consulta. Nunca estimes ni inventes un número; si la base no tiene el dato, dilo.
- Si no sabes qué tabla o columna usar, revisa list_tables y get_schema antes de consultar.
- Agrega en SQL (sum, count, group by) en vez de traer filas crudas.
- Si la pregunta es ambigua (cliente, periodo), asume lo más razonable y dilo en una línea. Pregunta solo si no hay forma razonable de asumir.

Cómo responder:
- No escribas nada antes ni entre consultas: la interfaz ya muestra qué consultaste. Tu primer texto es la respuesta.
- Todo lo que escribas va en español, sin excepción.
- Directo: primero la respuesta en una o dos frases, después el detalle.
- Di siempre qué cliente y qué periodo usaste, y la moneda de los montos.
- Para comparar varias filas o métricas usa una tabla en markdown.
- Sin preámbulos sobre lo que vas a hacer y sin guiones largos.

Hoy es ${new Date().toISOString().slice(0, 10)}.`;

// El navegador solo guarda el texto de cada turno: el historial pesa poco y nadie
// puede colar resultados de herramientas inventados. Claude vuelve a consultar si lo necesita.
function validMessages(m) {
  return Array.isArray(m) && m.length > 0 && m.length <= MAX_MESSAGES
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
  if (e instanceof Anthropic.RateLimitError) return 'Se alcanzó el límite de uso de la API. Intenta en un momento.';
  if (e instanceof Anthropic.AuthenticationError) return 'La API key de Anthropic no es válida.';
  if (e instanceof Anthropic.APIError) return `No se pudo obtener la respuesta (${e.status ?? 'sin estado'}).`;
  return 'No se pudo obtener la respuesta.';
}

export function mountChat(app, requireSession) {
  const client = new Anthropic(); // ANTHROPIC_API_KEY

  // La barra lateral muestra quién está dentro.
  app.get('/api/me', requireSession, (req, res) => res.json({ email: req.user.email }));

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

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16_000,
      // Sin `fallbacks`: el reintento en otro modelo tras un rechazo está pensado para Opus 5 y no
      // está confirmado en Sonnet 5. Si vuelve Opus 5, devolver betas 'server-side-fallback-2026-07-01'
      // y `fallbacks: 'default'`.
      betas: ['mcp-client-2025-11-20'],
      system: system(),
      mcp_servers: [{
        type: 'url',
        name: 'zebra-db',
        url: `${process.env.AUTH_BASE_URL.replace(/\/+$/, '')}/mcp`,
        authorization_token: process.env.MCP_AUTH_TOKEN,
      }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'zebra-db' }],
      messages,
    });
    res.on('close', () => { if (!res.writableFinished) stream.abort(); });

    // Opus 5 narra lo que va a hacer antes de consultar aunque el prompt lo prohíba. Ese texto se
    // ve mientras llega y el navegador lo borra si detrás viene una consulta: la respuesta es lo
    // escrito después de la última consulta.
    // ponytail: si Claude escribe parte de la respuesta y vuelve a consultar, esa parte se pierde;
    // en la práctica la síntesis final la repite. Si molesta, mantener el texto y solo separarlo.
    let sawText = false;
    stream.on('streamEvent', (e) => {
      if (e.type !== 'content_block_start') return;
      if (e.content_block.type === 'mcp_tool_use' && sawText) { sawText = false; send({ type: 'reset' }); }
      if (e.content_block.type === 'text' && sawText) send({ type: 'text', text: '\n\n' });
    });
    stream.on('text', (text) => { sawText = true; send({ type: 'text', text }); });
    stream.on('contentBlock', (block) => {
      if (block.type === 'mcp_tool_use') send({ type: 'tool', id: block.id, name: block.name, input: block.input });
      if (block.type === 'mcp_tool_result') send({ type: 'tool_result', id: block.tool_use_id, error: block.is_error, preview: preview(block.content) });
    });

    try {
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') send({ type: 'text', text: '\n\nNo puedo responder esa pregunta.' });
      if (msg.stop_reason === 'max_tokens') send({ type: 'text', text: '\n\n(La respuesta se cortó por largo. Pide menos detalle.)' });
      console.log(JSON.stringify({ chat: req.user.email, ms: Date.now() - t0, stop: msg.stop_reason, model: msg.model, in: msg.usage.input_tokens, out: msg.usage.output_tokens }));
      send({ type: 'done' });
    } catch (e) {
      console.error('chat:', e?.status ?? '', e?.message);
      send({ type: 'error', message: errorMessage(e) });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });
}
