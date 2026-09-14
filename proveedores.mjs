// Quién contesta las preguntas. El MCP es el mismo para todos (es protocolo abierto); lo que
// cambia es qué proveedor ejecuta el bucle de consultas contra él.
import Anthropic from '@anthropic-ai/sdk';

import { guardarAjuste, leerAjuste } from './db.mjs';

export const PROVEEDORES = {
  anthropic: {
    nombre: 'Anthropic',
    env: 'ANTHROPIC_API_KEY',
    logo: '/logos/anthropic.png',
    pordefecto: 'claude-sonnet-5',
    disponible: true,
    nota: 'Conector MCP propio, con token. Es el que corre hoy.',
  },
  openai: {
    nombre: 'OpenAI',
    env: 'OPENAI_API_KEY',
    logo: '/logos/openai.png', // en tema oscuro la hoja de estilos cambia a openai-claro.png
    pordefecto: null, // los nombres de modelo cambian seguido: se eligen de la lista que da su API
    disponible: true,
    nota: 'Responses API con servidor MCP remoto y campo authorization.',
  },
  gemini: {
    nombre: 'Google Gemini',
    env: 'GEMINI_API_KEY',
    logo: '/logos/gemini.jpg',
    pordefecto: null,
    disponible: false,
    nota: 'Su documentación se contradice sobre MCP remoto y no dice cómo autenticar. Sin token, nuestro servidor responde 401.',
  },
};

// La elección vive en la base del dashboard, así que la pantalla Ajustes la cambia al instante.
// Se lee una vez al arrancar y se recuerda: cada turno pregunta quién contesta, y no vale ir a la
// base cada vez. Antes del primer guardado (o sin base) mandan las variables de entorno.
let elegido = null;

/** Trae de la base lo guardado. Se llama al arrancar; si la base falla, se sigue con el entorno. */
export async function cargar() {
  try { elegido = await leerAjuste('ia'); }
  catch (e) { console.error('ajustes: no pude leer la base, sigo con el entorno:', e.message); }
  return activo();
}

/** Quién contesta ahora mismo: manda lo guardado; si no hay o no sirve, el entorno. */
export function activo() {
  const fuente = PROVEEDORES[elegido?.proveedor]
    ? elegido
    : { proveedor: process.env.AI_PROVIDER, modelo: process.env.AI_MODEL };
  const proveedor = PROVEEDORES[fuente.proveedor] ? fuente.proveedor : 'anthropic';
  // Un modelo del proveedor anterior no se hereda al caer en otro: cada uno tiene sus nombres.
  const modelo = (proveedor === fuente.proveedor && fuente.modelo) || PROVEEDORES[proveedor].pordefecto;
  return { proveedor, modelo };
}

/** Una elección utilizable, o una excepción con el motivo en cristiano. */
export function validar({ proveedor, modelo }) {
  const p = PROVEEDORES[proveedor];
  if (!p?.disponible) throw new Error('Ese proveedor no está disponible.');
  if (!process.env[p.env]) throw new Error(`Falta la variable ${p.env} en EasyPanel.`);
  if (typeof modelo !== 'string' || !modelo.trim() || modelo.length > 120) throw new Error('Elige un modelo.');
  return { proveedor, modelo: modelo.trim() };
}

/** Cambia quién contesta, sin desplegar. La memoria solo cambia si la base aceptó el cambio. */
export async function guardar(eleccion, por = null) {
  const nuevo = validar(eleccion);
  await guardarAjuste('ia', nuevo, por);
  elegido = nuevo;
  return activo();
}

// ── El prompt, igual para todos ─────────────────────────────────────────────
// WhatsApp no pinta tablas markdown ni encabezados: ahí la respuesta va en prosa corta.
const WHATSAPP = `

Este turno llega por WhatsApp, así que el formato cambia: sin tablas, sin encabezados y sin
viñetas largas. Responde en dos o tres frases, con las cifras dentro del texto y *negritas* al
estilo de WhatsApp (un asterisco). Si hay varias filas que comparar, di solo las dos o tres que
importan y ofrece el detalle si lo piden.`;

// Cada grupo de WhatsApp es de un cliente, así que ahí no hay que repetirlo en cada pregunta.
const ambitoDe = (cliente) => `

Este grupo es del cliente **${cliente}**: toda pregunta se entiende de ese cliente, sin preguntarlo.
Si te piden datos de otro cliente, dilo y no los traigas.`;

export const system = (canal = 'web', cliente = null) => `Eres el analista de datos de Zebra, una agencia de marketing. Respondes preguntas del equipo sobre las métricas de sus clientes (leads, gasto en pauta, citas, apartados, cierres, llamadas) consultando la base de métricas con las herramientas de zebra-db.

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

Hoy es ${new Date().toISOString().slice(0, 10)}.${canal === 'whatsapp' ? WHATSAPP : ''}${cliente ? ambitoDe(cliente) : ''}`;

const urlMcp = () => `${process.env.AUTH_BASE_URL.replace(/\/+$/, '')}/mcp`;

// ── Anthropic ───────────────────────────────────────────────────────────────
let anthropicClient;
const anthropic = () => (anthropicClient ??= new Anthropic()); // ANTHROPIC_API_KEY

/** Devuelve el stream del SDK: el chat web lo consume evento a evento. */
export function streamAnthropic(messages, canal = 'web', cliente = null, modelo) {
  return anthropic().beta.messages.stream({
    model: modelo,
    max_tokens: 16_000,
    // Sin `fallbacks`: el reintento en otro modelo tras un rechazo está pensado para Opus 5 y no
    // está confirmado en Sonnet 5.
    betas: ['mcp-client-2025-11-20'],
    system: system(canal, cliente),
    mcp_servers: [{
      type: 'url',
      name: 'zebra-db',
      url: urlMcp(),
      authorization_token: process.env.MCP_AUTH_TOKEN,
    }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'zebra-db' }],
    messages,
  });
}

// ── OpenAI ──────────────────────────────────────────────────────────────────
// Responses API: el bucle de herramientas lo ejecuta OpenAI contra nuestro MCP, igual que Anthropic.
// Sin streaming, por simplicidad: se emite el texto final de una vez.
export async function pedirOpenAI(messages, canal = 'web', cliente = null, modelo) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: modelo,
      instructions: system(canal, cliente),
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: [{
        type: 'mcp',
        server_label: 'zebra_db', // snake_case: algunos proveedores rechazan guiones
        server_url: urlMcp(),
        authorization: process.env.MCP_AUTH_TOKEN,
        require_approval: 'never',
      }],
    }),
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos?.error?.message ?? `OpenAI respondió ${res.status}`);

  const salida = Array.isArray(datos.output) ? datos.output : [];
  const herramientas = salida
    .filter((o) => o.type === 'mcp_call')
    .map((o) => ({ name: o.name, input: parseArgs(o.arguments), error: Boolean(o.error), preview: String(o.output ?? o.error ?? '').slice(0, 400) }));
  const texto = datos.output_text ?? salida
    .filter((o) => o.type === 'message')
    .flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text))
    .join('');
  return { texto: (texto ?? '').trim(), herramientas, usage: datos.usage ?? null };
}

const parseArgs = (a) => { try { return typeof a === 'string' ? JSON.parse(a) : (a ?? {}); } catch { return {}; } };

// ── Modelos disponibles, preguntándole a cada proveedor ──────────────────────
async function listar(url, cabeceras, mapear) {
  const res = await fetch(url, { headers: cabeceras });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error?.message ?? `respondió ${res.status}`);
  return mapear(d);
}

/** Para la pantalla de Ajustes: qué modelos ofrece cada proveedor con la clave que hay puesta. */
export async function modelosDisponibles() {
  const salida = {};
  for (const [id, p] of Object.entries(PROVEEDORES)) {
    if (!process.env[p.env]) { salida[id] = { error: `falta ${p.env}` }; continue; }
    if (!p.disponible) { salida[id] = { error: 'no disponible todavía' }; continue; }
    try {
      salida[id] = {
        modelos: id === 'anthropic'
          ? await listar('https://api.anthropic.com/v1/models?limit=40',
              { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
              (d) => (d.data ?? []).map((m) => m.id))
          : await listar('https://api.openai.com/v1/models',
              { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
              (d) => (d.data ?? []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort()),
      };
    } catch (e) { salida[id] = { error: e.message }; }
  }
  return salida;
}
