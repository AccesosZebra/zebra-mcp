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
// Se pegan desde Ajustes, cada una con un nombre para reconocerla ("Principal", "Respaldo"…), y
// viven en la base del dashboard, cifradas: una copia de la base no basta para usarlas. La llave
// sale de AUTH_SESSION_SECRET, así que rotarlo deja las guardadas ilegibles; el panel lo dice y se
// vuelven a pegar. Las variables de entorno (OPENAI_API_KEY, ANTHROPIC_API_KEY) aparecen como una
// clave más, de solo lectura.
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

export const MAX_CLAVES = 10;
const ENTORNO = (proveedor) => `entorno-${proveedor}`;

let guardadas = []; // lo que hay en la base, cifrado: [{ id, nombre, proveedor, cifrada, fin, por, cuando }]
const enClaro = new Map(); // id → la clave descifrada, o null si no se pudo leer

/** Lo guardado, como lista. Antes era { anthropic: {…}, openai: {…} }: se convierte al leerlo. */
export function desdeGuardado(valor) {
  if (Array.isArray(valor)) return valor;
  if (!valor || typeof valor !== 'object') return [];
  return Object.entries(valor).filter(([p]) => PROVEEDORES[p])
    .map(([p, v]) => ({ ...v, id: p, nombre: PROVEEDORES[p].nombre, proveedor: p }));
}

export function recordar(lista) {
  guardadas = desdeGuardado(lista);
  enClaro.clear();
  for (const g of guardadas) enClaro.set(g.id, descifrar(g.cifrada));
}

/** Todas las claves, del panel y del entorno. Nunca el texto: solo de dónde viene y cómo termina. */
export function claves() {
  const delPanel = guardadas.map((g) => ({
    id: g.id, nombre: g.nombre, proveedor: g.proveedor, origen: 'panel', fin: g.fin, legible: Boolean(enClaro.get(g.id)), por: g.por ?? null,
  }));
  const delEntorno = Object.entries(PROVEEDORES).filter(([, p]) => process.env[p.env]).map(([id, p]) => ({
    id: ENTORNO(id), nombre: `${p.nombre} (entorno)`, proveedor: id, origen: 'entorno', fin: process.env[p.env].slice(-4), legible: true, por: null,
  }));
  return [...delPanel, ...delEntorno];
}

/** El texto de una clave, o null. */
export function clave(id) {
  if (enClaro.get(id)) return enClaro.get(id);
  const p = Object.keys(PROVEEDORES).find((x) => ENTORNO(x) === id);
  return (p && process.env[PROVEEDORES[p].env]) || null;
}

function validarNombre(nombre, menos = null) {
  const n = typeof nombre === 'string' ? nombre.trim() : '';
  if (!n || n.length > 40) throw new Error('Ponle un nombre de hasta 40 caracteres, para reconocerla.');
  if (claves().some((c) => c.id !== menos && c.nombre.toLowerCase() === n.toLowerCase())) throw new Error('Ya hay una clave con ese nombre.');
  return n;
}

/** La clave limpia, probada contra su proveedor. Si no responde, dice por qué en cristiano. */
async function probada(proveedor, valor) {
  const limpia = typeof valor === 'string' ? valor.trim() : '';
  if (limpia.length < 20 || limpia.length > 300 || /\s/.test(limpia)) {
    throw new Error('Eso no parece una clave de API: pégala completa, sin espacios.');
  }
  try {
    await listarModelos(proveedor, limpia);
  } catch (e) {
    throw new Error(`${PROVEEDORES[proveedor].nombre} no aceptó la clave: ${e.message}.`);
  }
  return limpia;
}

const delPanel = (id) => {
  if (Object.keys(PROVEEDORES).some((x) => ENTORNO(x) === id)) throw new Error('Esa viene de una variable de entorno: se cambia en EasyPanel.');
  const g = guardadas.find((x) => x.id === id);
  if (!g) throw new Error('Esa clave no existe.');
  return g;
};

async function guardarLista(lista, por) {
  await guardarAjuste('claves-ia', lista, por);
  recordar(lista);
}

/** Prueba la clave contra el proveedor, y solo si responde la guarda. */
export async function guardarClave({ nombre, proveedor, clave: valor } = {}, por = null) {
  if (!PROVEEDORES[proveedor]) throw new Error('Elige de quién es la clave: OpenAI o Claude.');
  const n = validarNombre(nombre);
  if (guardadas.length >= MAX_CLAVES) throw new Error(`Caben hasta ${MAX_CLAVES} claves: quita una antes.`);
  const limpia = await probada(proveedor, valor);
  const nueva = { id: randomBytes(6).toString('base64url'), nombre: n, proveedor, cifrada: cifrar(limpia), fin: limpia.slice(-4), por, cuando: new Date().toISOString() };
  await guardarLista([...guardadas, nueva], por);
  return claves().find((c) => c.id === nueva.id);
}

/** Cambia el nombre, la clave o ambos. Una clave nueva se prueba antes; el proveedor no cambia. */
export async function editarClave(id, { nombre, clave: valor } = {}, por = null) {
  const g = delPanel(id);
  const cambios = {};
  if (nombre !== undefined && String(nombre).trim() !== g.nombre) cambios.nombre = validarNombre(nombre, id);
  if (typeof valor === 'string' && valor.trim()) {
    const limpia = await probada(g.proveedor, valor);
    Object.assign(cambios, { cifrada: cifrar(limpia), fin: limpia.slice(-4), por, cuando: new Date().toISOString() });
  }
  if (!Object.keys(cambios).length) throw new Error('No hay nada que cambiar.');
  await guardarLista(guardadas.map((x) => (x.id === id ? { ...x, ...cambios } : x)), por);
  return claves().find((c) => c.id === id);
}

/** ¿Funciona? Le pide la lista de modelos al proveedor con esa clave. No guarda nada. */
export async function probarClave(id) {
  const c = claves().find((x) => x.id === id);
  if (!c) throw new Error('Esa clave no existe.');
  if (!c.legible) throw new Error(`La clave "${c.nombre}" no se puede leer (cambió el secreto del servidor): edítala y pégala de nuevo.`);
  try {
    return { modelos: (await listarModelos(c.proveedor, clave(id))).length };
  } catch (e) {
    throw new Error(`${PROVEEDORES[c.proveedor].nombre} no aceptó la clave: ${e.message}.`);
  }
}

/** Quita una del panel. La que está en uso no, mientras haya otra a la que pasarse. */
export async function quitarClave(id, por = null) {
  delPanel(id);
  if (activo().clave === id && claves().filter((c) => c.legible).length > 1) throw new Error('Es la que está en uso: elige otra antes de quitarla.');
  await guardarLista(guardadas.filter((g) => g.id !== id), por);
}

// ── Cuál contesta ───────────────────────────────────────────────────────────
// La elección vive en la base del dashboard ({ clave, proveedor, modelo }), así que Ajustes la
// cambia al instante. Se lee una vez al arrancar y se recuerda: cada turno pregunta quién contesta.
// Antes del primer guardado (o sin base) mandan AI_PROVIDER y AI_MODEL, si están.
let elegido = null;

/** Trae de la base lo guardado. Se llama al arrancar; si la base falla, se sigue con el entorno. */
export async function cargar() {
  try {
    elegido = await leerAjuste('ia');
    recordar(await leerAjuste('claves-ia'));
    for (const c of claves()) if (!c.legible) console.error(`ajustes: la clave "${c.nombre}" no se puede leer (¿cambió AUTH_SESSION_SECRET?)`);
  } catch (e) { console.error('ajustes: no pude leer la base, sigo con el entorno:', e.message); }
  return activo();
}

/**
 * Qué clave y qué modelo contestan: la elegida; si ya no está, otra del mismo proveedor; si no, la
 * primera de OpenAI (la de siempre en esta instancia), y si no hay, cualquiera. El modelo solo se
 * conserva si la clave es del mismo proveedor que la elección: cada uno tiene sus nombres.
 */
export function elegirActiva(lista, eleccion) {
  const usables = lista.filter((c) => c.legible);
  const c = usables.find((x) => x.id === eleccion?.clave)
    || usables.find((x) => x.proveedor === eleccion?.proveedor)
    || usables.find((x) => x.proveedor === 'openai')
    || usables[0];
  if (!c) return { clave: null, nombre: null, proveedor: 'openai', modelo: null };
  const modelo = (c.proveedor === eleccion?.proveedor && eleccion.modelo) || PROVEEDORES[c.proveedor].pordefecto;
  return { clave: c.id, nombre: c.nombre, proveedor: c.proveedor, modelo };
}

export const activo = () => elegirActiva(claves(), elegido ?? { proveedor: process.env.AI_PROVIDER, modelo: process.env.AI_MODEL });
const claveActiva = () => clave(activo().clave);

/** Una elección utilizable, o una excepción con el motivo en cristiano. */
export function validar({ clave: id, modelo }) {
  const c = claves().find((x) => x.id === id);
  if (!c) throw new Error('Esa clave no existe.');
  if (!c.legible) throw new Error(`La clave "${c.nombre}" no se puede leer: vuelve a pegarla.`);
  if (typeof modelo !== 'string' || !modelo.trim() || modelo.length > 120) throw new Error('Elige un modelo.');
  return { clave: c.id, proveedor: c.proveedor, modelo: modelo.trim() };
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
  const k = claveActiva();
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
  const k = claveActiva();
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

// ── Errores de los proveedores, en cristiano ────────────────────────────────
// Lo que el proveedor responde viene en inglés y a veces sin texto ("404"). Al panel le llega qué
// significa y qué hacer; el detalle original va al log del servidor.
export function explicarHttp(status) {
  const frase = {
    400: 'rechazó la petición: algún dato no es válido',
    401: 'la clave no es válida o fue revocada',
    403: 'la clave no tiene permiso para esto: revisa sus permisos o los del proyecto en la consola del proveedor',
    404: 'no existe lo que se pidió: suele ser un modelo retirado o que esta clave no puede usar',
    429: 'se pasó del límite de uso, o la cuenta no tiene saldo',
  }[status] ?? (status >= 500 ? 'el servicio está fallando de su lado: intenta en unos minutos' : 'respondió con un error');
  return `${frase} (${status})`;
}

// ── Modelos disponibles, preguntándole a cada proveedor ──────────────────────
async function listar(url, cabeceras, mapear) {
  let res;
  try { res = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(15_000) }); }
  catch (e) { throw new Error(`no se pudo conectar con el servicio (${e.cause?.code ?? e.name})`); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`modelos ${new URL(url).host}: ${res.status} ${d?.error?.message ?? ''}`);
    throw Object.assign(new Error(explicarHttp(res.status)), { status: res.status });
  }
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

/** Para la pantalla de Ajustes: qué modelos ofrece cada clave legible, por id. */
export async function modelosDisponibles() {
  const usables = claves().filter((c) => c.legible);
  const listas = await Promise.all(usables.map((c) => listarModelos(c.proveedor, clave(c.id))
    .then((modelos) => ({ modelos }), (e) => ({ error: e.message }))));
  return Object.fromEntries(usables.map((c, i) => [c.id, listas[i]]));
}

// ── Por qué no contesta ─────────────────────────────────────────────────────
// Cuando el proveedor falla por la cuenta (sin clave, sin saldo, clave mala, límite), volver a
// preguntar no sirve: se dice la causa exacta. El último fallo queda en memoria para la franja del
// panel, y se borra en cuanto una respuesta sale bien. Nada de notificaciones: solo se ve al mirar.
// ponytail: en memoria del proceso; un despliegue lo limpia, y la siguiente pregunta lo vuelve a llenar.

/** { codigo, texto } si la causa es de la cuenta del proveedor; null si es otra cosa. */
export function causaDeFallo(e, proveedor = activo().proveedor) {
  // Con varias claves, se dice cuál: "OpenAI (clave «Respaldo»)".
  const cual = claves().length > 1 && activo().nombre ? ` (clave «${activo().nombre}»)` : '';
  const nombre = `${PROVEEDORES[proveedor]?.nombre ?? 'el proveedor de IA'}${cual}`;
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
  // Un modelo retirado o que esa clave no puede usar: OpenAI y Anthropic responden 404 (a veces 400).
  if (e?.status === 404 || /model_not_found|not_found_error|model\b.*(does not exist|not found)/i.test(`${m} ${code}`)) {
    return { codigo: 'modelo', texto: `No puedo contestar: el modelo «${activo().modelo}» ya no está disponible en ${nombre}. Hay que elegir otro en Ajustes del panel.` };
  }
  if (e?.status === 403 || /permission/i.test(code)) {
    return { codigo: 'permiso', texto: `No puedo contestar: la clave de ${nombre} no tiene permiso para usar el modelo «${activo().modelo}». Revisa sus permisos o elige otro modelo en Ajustes del panel.` };
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
