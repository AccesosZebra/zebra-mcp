// Uso: node proveedores.check.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';

// Un archivo que todavía no existe: hasta el primer guardado mandan las variables de entorno.
const ARCHIVO = join(tmpdir(), `ajustes-check-${process.pid}.json`);
process.env.AJUSTES_FILE = ARCHIVO;

const { activo, guardar, system, PROVEEDORES } = await import('./proveedores.mjs');

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

// ── Guardar sin desplegar ───────────────────────────────────────────────────
process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';
process.env.AI_PROVIDER = 'openai'; // el entorno dice una cosa…
process.env.AI_MODEL = 'gpt-por-elegir';

assert.deepEqual(guardar({ proveedor: 'anthropic', modelo: ' claude-sonnet-5 ' }),
  { proveedor: 'anthropic', modelo: 'claude-sonnet-5' }, 'se guarda sin espacios sobrantes');
assert.deepEqual(activo(), { proveedor: 'anthropic', modelo: 'claude-sonnet-5' }, '…y lo guardado manda');

// Al reiniciar el contenedor, el archivo del volumen sigue mandando sobre el entorno.
const otraCarga = await import(`./proveedores.mjs?reinicio=1`);
assert.deepEqual(otraCarga.activo(), { proveedor: 'anthropic', modelo: 'claude-sonnet-5' });

const rechaza = (eleccion, regex) => assert.throws(() => guardar(eleccion), regex);
rechaza({ proveedor: 'gemini', modelo: 'gemini-3' }, /no está disponible/);
rechaza({ proveedor: 'inventado', modelo: 'x' }, /no está disponible/);
rechaza({ proveedor: 'anthropic', modelo: '   ' }, /Elige un modelo/);
rechaza({ proveedor: 'anthropic', modelo: 'x'.repeat(121) }, /Elige un modelo/);

delete process.env.OPENAI_API_KEY;
rechaza({ proveedor: 'openai', modelo: 'gpt-5' }, /Falta la variable OPENAI_API_KEY/);
assert.equal(activo().proveedor, 'anthropic', 'un intento fallido no cambia quién contesta');

// Sin volumen montado, guardar tiene que decir exactamente eso y no fallar en silencio.
process.env.AJUSTES_FILE = '/no-existe-esta-ruta/ajustes.json';
const sinVolumen = await import('./proveedores.mjs?sinvolumen=1');
process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';
assert.throws(() => sinVolumen.guardar({ proveedor: 'anthropic', modelo: 'claude-sonnet-5' }), /volumen/);

rmSync(ARCHIVO, { force: true });
console.log('proveedores OK');
