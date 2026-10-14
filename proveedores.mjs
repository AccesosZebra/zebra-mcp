// Quién contesta las preguntas. El MCP es el mismo para todos (es protocolo abierto); lo que
// cambia es qué proveedor ejecuta el bucle de consultas contra él.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

import { guardarAjuste, leerAjuste } from './db.mjs';
import { quienEs } from './guia.mjs';

export const PROVEEDORES = {
  anthropic: {
    nombre: 'Anthropic',
    env: 'ANTHROPIC_API_KEY',
    logo: '/logos/anthropic.png',
    pordefecto: 'claude-sonnet-5',
    nota: 'Modelos Claude',
    consola: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    nombre: 'OpenAI',
    env: 'OPENAI_API_KEY',
    logo: '/logos/openai.png', // en tema oscuro la hoja de estilos cambia a openai-claro.png
    pordefecto: null, // los nombres de modelo cambian seguido: se eligen de la lista que da su API
    nota: 'Modelos GPT',
    consola: 'https://platform.openai.com/api-keys',
  },
};

// ── Claves de API ───────────────────────────────────────────────────────────
// Se pegan desde Ajustes y viven en la base del dashboard, cifradas: una copia de la base no
// basta para usarlas. La llave sale de AUTH_SESSION_SECRET, así que rotarlo deja las guardadas
// ilegibles; el panel lo dice y se vuelven a pegar. Si no hay clave en el panel, manda la
// variable de entorno, como antes.
const llave = () => Buffer.from(hkdfSync('sha256', process.env.AUTH_SESSION_SECRET ?? '', 'zebra-mcp', 'claves-ia', 32));

export function cifrar(texto) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llave(), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), datos]).toString('base64');
}

/** El texto, o null si no se puede leer (otra llave, o el valor se alteró). */
export function descifrar(b64) {
  try {
    const b = Buffer.from(b64, 'base64');
    const d = createDecipheriv('aes-256-gcm', llave(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

let guardadas = {}; // lo que hay en la base, cifrado: id → { cifrada, fin, por, cuando }
const enClaro = {}; // id → la clave descifrada, o null si no se pudo leer

function recordar(fila) {
  guardadas = fila ?? {};
  for (const id of Object.keys(PROVEEDORES)) {
    enClaro[id] = guardadas[id] ? descifrar(guardadas[id].cifrada) : undefined;
  }
}

/** La clave que se usa: la del panel; si no hay, la del entorno. */
export const clave = (id) => enClaro[id] || process.env[PROVEEDORES[id]?.env] || null;

/** Lo que el panel puede saber de una clave. Nunca la clave: solo de dónde viene y cómo termina. */
export function estadoClave(id) {
  if (guardadas[id]) {
    const legible = Boolean(enClaro[id]);
    return { hay: legible, origen: 'panel', fin: guardadas[id].fin, legible, por: guardadas[id].por ?? null };
  }
  const delEntorno = process.env[PROVEEDORES[id]?.env];
  return delEntorno
    ? { hay: true, origen: 'entorno', fin: delEntorno.slice(-4), legible: true, por: null }
    : { hay: false, origen: null, fin: null, legible: true, por: null };
}

/** Prueba la clave contra el proveedor, y solo si responde la guarda. */
export async function guardarClave(id, valor, por = null) {
  if (!PROVEEDORES[id]) throw new Error('Ese proveedor no existe.');
  const limpia = typeof valor === 'string' ? valor.trim() : '';
  if (limpia.length < 20 || limpia.length > 300 || /\s/.test(limpia)) {
    throw new Error('Eso no parece una clave de API: pégala completa, sin espacios.');
  }
  try {
    await listarModelos(id, limpia);
  } catch (e) {
    throw new Error(`${PROVEEDORES[id].nombre} no aceptó la clave: ${e.message}`);
  }
  const nuevas = { ...guardadas, [id]: { cifrada: cifrar(limpia), fin: limpia.slice(-4), por, cuando: new Date().toISOString() } };
  await guardarAjuste('claves-ia', nuevas, por);
  recordar(nuevas);
  return estadoClave(id);
}

/** Quita la del panel. Si hay variable de entorno, vuelve a mandar ella. */
export async function quitarClave(id, por = null) {
  if (!PROVEEDORES[id]) throw new Error('Ese proveedor no existe.');
  const { [id]: _fuera, ...resto } = guardadas;
  await guardarAjuste('claves-ia', resto, por);
  recordar(resto);
  return estadoClave(id);
}

// La elección vive en la base del dashboard, así que la pantalla Ajustes la cambia al instante.
// Se lee una vez al arrancar y se recuerda: cada turno pregunta quién contesta, y no vale ir a la
// base cada vez. Antes del primer guardado (o sin base) mandan las variables de entorno.
let elegido = null;

/** Trae de la base lo guardado. Se llama al arrancar; si la base falla, se sigue con el entorno. */
export async function cargar() {
  try {
    elegido = await leerAjuste('ia');
    recordar(await leerAjuste('claves-ia'));
    for (const id of Object.keys(PROVEEDORES)) {
      if (guardadas[id] && !enClaro[id]) console.error(`ajustes: la clave de ${id} no se puede leer (¿cambió AUTH_SESSION_SECRET?)`);
    }
  } catch (e) { console.error('ajustes: no pude leer la base, sigo con el entorno:', e.message); }
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
  if (!p) throw new Error('Ese proveedor no está disponible.');
  if (!clave(proveedor)) throw new Error(`Falta la clave de ${p.nombre}: pégala en su tarjeta.`);
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

// Quién es el negocio sale de Ajustes (guia.mjs); qué hay en la base, de la guía que traen las
// propias herramientas. Aquí solo va cómo trabajar y cómo responder, igual para cualquier cliente.
export const system = (canal = 'web', cliente = null) => `Eres el analista de datos de ${quienEs()}. Respondes preguntas del equipo sobre sus métricas (leads, gasto, citas, ventas y lo que describa la guía de la base) consultando la base de métricas con las herramientas de zebra-db. La descripción de esas herramientas trae la guía: qué hay y dónde buscarlo.

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
// Se rehace solo si la clave cambió desde el panel.
let anthropicClient, anthropicClave;
function anthropic() {
  const k = clave('anthropic');
  if (!k) throw new Error('Falta la clave de Anthropic: pégala en Ajustes.');
  if (k !== anthropicClave) { anthropicClient = new Anthropic({ apiKey: k }); anthropicClave = k; }
  return anthropicClient;
}

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
  const k = clave('openai');
  if (!k) throw new Error('Falta la clave de OpenAI: pégala en Ajustes.');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
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
  if (!res.ok) throw errorOpenAI(res, datos);

  const salida = Array.isArray(datos.output) ? datos.output : [];
  const herramientas = salida
    .filter((o) => o.type === 'mcp_call')
    .map((o) => ({ name: o.name, input: parseArgs(o.arguments), error: Boolean(o.error), preview: String(o.output ?? o.error ?? '').slice(0, 400) }));
  return { texto: textoOpenAI(datos), herramientas, usage: datos.usage ?? null };
}

function errorOpenAI(res, datos) {
  const e = new Error(datos?.error?.message ?? `OpenAI respondió ${res.status}`);
  e.status = res.status;
  e.code = datos?.error?.code ?? datos?.error?.type ?? null;
  return e;
}

const textoOpenAI = (datos) => (datos.output_text ?? (Array.isArray(datos.output) ? datos.output : [])
  .filter((o) => o.type === 'message')
  .flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text))
  .join('') ?? '').trim();

const parseArgs = (a) => { try { return typeof a === 'string' ? JSON.parse(a) : (a ?? {}); } catch { return {}; } };

// ── Modelos disponibles, preguntándole a cada proveedor ──────────────────────
async function listar(url, cabeceras, mapear) {
  const res = await fetch(url, { headers: cabeceras });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error?.message ?? `respondió ${res.status}`);
  return mapear(d);
}

/** Los modelos de un proveedor con una clave dada. También sirve para probar una clave nueva. */
function listarModelos(id, k) {
  return id === 'anthropic'
    ? listar('https://api.anthropic.com/v1/models?limit=40',
        { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
        (d) => (d.data ?? []).map((m) => m.id))
    : listar('https://api.openai.com/v1/models',
        { Authorization: `Bearer ${k}` },
        (d) => (d.data ?? []).map((m) => m.id).filter((x) => /^(gpt|o\d)/.test(x)).sort());
}

/** Para la pantalla de Ajustes: qué modelos ofrece cada proveedor con la clave que hay puesta. */
export async function modelosDisponibles() {
  const salida = {};
  for (const id of Object.keys(PROVEEDORES)) {
    const k = clave(id);
    if (!k) { salida[id] = { error: 'Sin clave todavía' }; continue; }
    try { salida[id] = { modelos: await listarModelos(id, k) }; }
    catch (e) { salida[id] = { error: e.message }; }
  }
  return salida;
}

// ── Por qué no contesta ─────────────────────────────────────────────────────
// Cuando el proveedor falla por la cuenta (sin clave, sin saldo, clave mala, límite), volver a
// preguntar no sirve: se dice la causa exacta. El último fallo queda en memoria para la franja del
// panel, y se borra en cuanto una respuesta sale bien. Nada de notificaciones: solo se ve al mirar.
// ponytail: en memoria del proceso; un despliegue lo limpia, y la siguiente pregunta lo vuelve a llenar.

/** { codigo, texto } si la causa es de la cuenta del proveedor; null si es otra cosa. */
export function causaDeFallo(e, proveedor = activo().proveedor) {
  const nombre = PROVEEDORES[proveedor]?.nombre ?? 'el proveedor de IA';
  const m = String(e?.message ?? '');
  const code = String(e?.code ?? e?.error?.error?.type ?? '');
  if (/^Falta la clave/i.test(m)) {
    return { codigo: 'sin-clave', texto: `No puedo contestar: falta configurar la clave de API de ${nombre} en Ajustes del panel.` };
  }
  if (/credit balance|insufficient_quota|exceeded your current quota|billing/i.test(`${m} ${code}`)) {
    return { codigo: 'sin-saldo', texto: `No puedo contestar: la cuenta de ${nombre} se quedó sin saldo (tokens). Hay que recargarla para que vuelva a responder.` };
  }
  if (e?.status === 401 || /invalid x-api-key|incorrect api key|invalid_api_key|authentication/i.test(`${m} ${code}`)) {
    return { codigo: 'clave-invalida', texto: `No puedo contestar: la clave de API de ${nombre} no es válida o fue revocada. Hay que cambiarla en Ajustes del panel.` };
  }
  if (e?.status === 429 || /rate.?limit/i.test(`${m} ${code}`)) {
    return { codigo: 'limite', texto: `No puedo contestar ahora: se alcanzó el límite de uso por minuto de ${nombre}. Pregúntame de nuevo en un minuto.` };
  }
  return null;
}

let ultimoFallo = null; // { codigo, texto, proveedor, desde, ultimo, veces, canal }

export function registrarFallo(causa, canal) {
  if (!causa) return;
  const ahora = new Date().toISOString();
  ultimoFallo = ultimoFallo?.codigo === causa.codigo
    ? { ...ultimoFallo, texto: causa.texto, ultimo: ahora, veces: ultimoFallo.veces + 1, canal }
    : { ...causa, proveedor: activo().proveedor, desde: ahora, ultimo: ahora, veces: 1, canal };
}
export const registrarExito = () => { ultimoFallo = null; };
export const falloActual = () => ultimoFallo;
