// Uso: node proveedores.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';
delete process.env.APP_DATABASE_URL; // sin base del dashboard: manda el entorno y guardar tiene que avisar

const { activo, guardar, validar, system, PROVEEDORES } = await import('./proveedores.mjs');

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

// Gemini se muestra pero no se ofrece: su conector MCP no está confirmado.
assert.equal(PROVEEDORES.gemini.disponible, false);
assert.match(PROVEEDORES.gemini.nota, /401|autenticar/);

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
rechaza({ proveedor: 'openai', modelo: 'gpt-5' }, /Falta la variable OPENAI_API_KEY/);

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

console.log('proveedores OK');
