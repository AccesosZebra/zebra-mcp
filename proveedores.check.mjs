// Uso: node proveedores.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';
process.env.AUTH_SESSION_SECRET = 'secreto-de-prueba-'.padEnd(64, 'x');
delete process.env.APP_DATABASE_URL; // sin base del dashboard: manda el entorno y guardar tiene que avisar

const { activo, guardar, validar, system, PROVEEDORES, cifrar, descifrar, clave, estadoClave, guardarClave, causaDeFallo, registrarFallo, registrarExito, falloActual } = await import('./proveedores.mjs');

// Por defecto, Anthropic con su modelo. Un proveedor inventado no debe romper nada.
delete process.env.AI_PROVIDER; delete process.env.AI_MODEL;
assert.deepEqual(activo(), { proveedor: 'anthropic', modelo: 'claude-sonnet-5' });

process.env.AI_PROVIDER = 'inventado';
assert.equal(activo().proveedor, 'anthropic', 'un proveedor desconocido cae en el de siempre');

process.env.AI_PROVIDER = 'openai';
process.env.AI_MODEL = 'gpt-por-elegir';
assert.deepEqual(activo(), { proveedor: 'openai', modelo: 'gpt-por-elegir' });

// OpenAI no trae modelo por defecto a propósito: sus nombres cambian y se eligen de su lista.
delete process.env.AI_MODEL;
assert.equal(activo().modelo, null);
assert.equal(PROVEEDORES.openai.pordefecto, null);

// Al caer en otro proveedor no se hereda el modelo del anterior: cada uno tiene sus nombres.
process.env.AI_PROVIDER = 'inventado'; process.env.AI_MODEL = 'gpt-5';
assert.deepEqual(activo(), { proveedor: 'anthropic', modelo: 'claude-sonnet-5' });

// Solo los dos que funcionan: Gemini se quitó.
assert.deepEqual(Object.keys(PROVEEDORES), ['anthropic', 'openai']);

// ── Qué elecciones se aceptan ───────────────────────────────────────────────
process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';
assert.deepEqual(validar({ proveedor: 'anthropic', modelo: ' claude-sonnet-5 ' }),
  { proveedor: 'anthropic', modelo: 'claude-sonnet-5' }, 'se guarda sin espacios sobrantes');

const rechaza = (eleccion, regex) => assert.throws(() => validar(eleccion), regex);
rechaza({ proveedor: 'gemini', modelo: 'gemini-3' }, /no está disponible/);
rechaza({ proveedor: 'inventado', modelo: 'x' }, /no está disponible/);
rechaza({ proveedor: 'anthropic', modelo: '   ' }, /Elige un modelo/);
rechaza({ proveedor: 'anthropic', modelo: 'x'.repeat(121) }, /Elige un modelo/);
delete process.env.OPENAI_API_KEY;
rechaza({ proveedor: 'openai', modelo: 'gpt-5' }, /Falta la clave de OpenAI/);

// Sin base, guardar avisa en vez de fingir que guardó, y no cambia quién contesta.
await assert.rejects(guardar({ proveedor: 'anthropic', modelo: 'claude-sonnet-5' }), /APP_DATABASE_URL/);
assert.equal(activo().proveedor, 'anthropic');

// ── El prompt es el mismo para todos, y cambia solo por canal y cliente ─────
const web = system('web');
// Sin contexto guardado no sabe de qué negocio es: nada de Zebra escrito en el código.
assert.match(web, /analista de datos de este negocio/);
assert.doesNotMatch(web, /Zebra, una agencia/);
assert.doesNotMatch(web, /WhatsApp/);

const wa = system('whatsapp');
assert.match(wa, /sin tablas/, 'en WhatsApp no se piden tablas');

const conCliente = system('whatsapp', 'Grupo Gira');
assert.match(conCliente, /Grupo Gira/);
assert.match(conCliente, /no los traigas/, 'prohíbe datos de otro cliente');
assert.doesNotMatch(system('web'), /Grupo Gira/);

// ── Claves de API ───────────────────────────────────────────────────────────
// Cifradas: el texto guardado no contiene la clave, y cada cifrado es distinto aunque la clave no.
const k = 'sk-ant-clave-de-prueba-1234567890-a1b2';
const c1 = cifrar(k), c2 = cifrar(k);
assert.equal(descifrar(c1), k, 'ida y vuelta');
assert.notEqual(c1, c2, 'IV distinto en cada cifrado');
assert.ok(!Buffer.from(c1, 'base64').toString('latin1').includes('clave-de-prueba'), 'la clave no queda en claro');
// Con otro secreto no se lee, y no revienta: el panel avisa de que hay que volver a pegarla.
const secreto = process.env.AUTH_SESSION_SECRET;
process.env.AUTH_SESSION_SECRET = 'otro-secreto-'.padEnd(64, 'y');
assert.equal(descifrar(c1), null);
process.env.AUTH_SESSION_SECRET = secreto;
assert.equal(descifrar('basura'), null);
assert.equal(descifrar(c1.slice(0, -4) + 'AAAA'), null, 'si se altera, no se lee');

// Sin clave en el panel manda el entorno; el panel solo ve los últimos 4 caracteres.
process.env.ANTHROPIC_API_KEY = 'sk-ant-del-entorno-9z8y';
assert.equal(clave('anthropic'), 'sk-ant-del-entorno-9z8y');
assert.deepEqual(estadoClave('anthropic'), { hay: true, origen: 'entorno', fin: '9z8y', legible: true, por: null });
delete process.env.OPENAI_API_KEY;
assert.equal(clave('openai'), null);
assert.equal(estadoClave('openai').hay, false);
assert.equal(clave('inventado'), null);

// Guardar rechaza lo que no parece una clave sin llamar a nadie.
await assert.rejects(guardarClave('anthropic', 'corta'), /no parece una clave/);
await assert.rejects(guardarClave('anthropic', 'sk-ant con espacios dentro de la clave'), /no parece una clave/);
await assert.rejects(guardarClave('inventado', k), /no existe/);

// ── Por qué no contesta: cada error real de la cuenta, con su causa exacta ──
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const causa = (e, p = 'anthropic') => causaDeFallo(e, p)?.codigo ?? null;
assert.equal(causa(err('Falta la clave de Anthropic: pégala en Ajustes.')), 'sin-clave');
assert.equal(causa(err('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', { status: 400 })), 'sin-saldo');
assert.equal(causa(err('You exceeded your current quota, please check your plan and billing details.', { status: 429, code: 'insufficient_quota' }), 'openai'), 'sin-saldo', 'la cuota agotada de OpenAI es 429 pero es saldo, no límite');
assert.equal(causa(err('401 invalid x-api-key', { status: 401 })), 'clave-invalida');
assert.equal(causa(err('Incorrect API key provided: sk-…', { status: 401, code: 'invalid_api_key' }), 'openai'), 'clave-invalida');
assert.equal(causa(err('429 rate_limit_error', { status: 429 })), 'limite');
assert.equal(causa(err('fetch failed')), null, 'un corte de red no es culpa de la cuenta');
assert.equal(causa(err('500 overloaded', { status: 500 })), null);
assert.match(causaDeFallo(err('Your credit balance is too low'), 'anthropic').texto, /cuenta de Anthropic se quedó sin saldo/);
assert.match(causaDeFallo(err('insufficient_quota'), 'openai').texto, /cuenta de OpenAI/);

// La franja: acumula mientras la causa es la misma, cambia si cambia, y se borra al contestar bien.
registrarExito();
assert.equal(falloActual(), null);
registrarFallo(causaDeFallo(err('Your credit balance is too low')), 'whatsapp');
registrarFallo(causaDeFallo(err('Your credit balance is too low')), 'chat');
assert.deepEqual([falloActual().codigo, falloActual().veces, falloActual().canal], ['sin-saldo', 2, 'chat']);
registrarFallo(causaDeFallo(err('401 invalid x-api-key', { status: 401 })), 'whatsapp');
assert.deepEqual([falloActual().codigo, falloActual().veces], ['clave-invalida', 1], 'otra causa empieza de cero');
registrarFallo(null, 'whatsapp');
assert.equal(falloActual().codigo, 'clave-invalida', 'un fallo que no es de la cuenta no borra el aviso');
registrarExito();
assert.equal(falloActual(), null, 'contestar bien lo borra');

console.log('proveedores OK');
