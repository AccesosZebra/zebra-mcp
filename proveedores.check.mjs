// Uso: node proveedores.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';

const { activo, system, PROVEEDORES } = await import('./proveedores.mjs');

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

// Gemini se muestra pero no se ofrece: su conector MCP no está confirmado.
assert.equal(PROVEEDORES.gemini.disponible, false);
assert.match(PROVEEDORES.gemini.nota, /401|autenticar/);

// El prompt es el mismo para todos, y cambia solo por canal y cliente.
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
