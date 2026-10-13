// Uso: node proveedores.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';
process.env.AUTH_SESSION_SECRET = 'secreto-de-prueba-'.padEnd(64, 'x');
delete process.env.APP_DATABASE_URL; // sin base del dashboard: manda el entorno y guardar tiene que avisar

const { activo, guardar, validar, system, PROVEEDORES, cifrar, descifrar, clave, estadoClave, guardarClave } = await import('./proveedores.mjs');

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
assert.match(web, /analista de datos de Zebra/);
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

console.log('proveedores OK');
