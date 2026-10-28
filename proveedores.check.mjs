// Uso: node proveedores.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';
process.env.AUTH_SESSION_SECRET = 'secreto-de-prueba-'.padEnd(64, 'x');
delete process.env.APP_DATABASE_URL; // sin base del dashboard: manda el entorno y guardar tiene que avisar

const { activo, elegirActiva, desdeGuardado, recordar, claves, clave, validar, guardar, guardarClave, editarClave, probarClave, explicarHttp, quitarClave, system, PROVEEDORES, cifrar, descifrar, causaDeFallo, registrarFallo, registrarExito, falloActual } = await import('./proveedores.mjs');

// ── Cuál contesta ───────────────────────────────────────────────────────────
const k = (id, proveedor, legible = true) => ({ id, nombre: id, proveedor, legible });
const openai = k('principal', 'openai'), claude = k('claude', 'anthropic'), respaldo = k('respaldo', 'openai');

// Sin claves no contesta nadie; por defecto, OpenAI (sin modelo: sus nombres cambian, se eligen de su lista).
assert.deepEqual(elegirActiva([], null), { clave: null, nombre: null, proveedor: 'openai', modelo: null });
assert.equal(PROVEEDORES.openai.pordefecto, null);
assert.equal(elegirActiva([claude, openai], null).clave, 'principal', 'sin elección manda OpenAI aunque Claude esté antes');
assert.deepEqual(elegirActiva([claude], null), { clave: 'claude', nombre: 'claude', proveedor: 'anthropic', modelo: 'claude-sonnet-5' }, 'solo Claude: Claude con su modelo');

// La elegida manda, con su modelo.
assert.deepEqual(elegirActiva([openai, claude, respaldo], { clave: 'respaldo', proveedor: 'openai', modelo: 'gpt-5.1' }),
  { clave: 'respaldo', nombre: 'respaldo', proveedor: 'openai', modelo: 'gpt-5.1' });
// Si se borró, otra del mismo proveedor y el mismo modelo.
assert.equal(elegirActiva([openai, claude], { clave: 'borrada', proveedor: 'openai', modelo: 'gpt-5.1' }).modelo, 'gpt-5.1');
// Formato viejo { proveedor, modelo } (lo que tenía guardado Cancún): se respeta.
assert.deepEqual(elegirActiva([claude, openai], { proveedor: 'openai', modelo: 'gpt-5.1' }), { clave: 'principal', nombre: 'principal', proveedor: 'openai', modelo: 'gpt-5.1' });
// Un modelo de otro proveedor nunca se hereda.
assert.equal(elegirActiva([claude], { proveedor: 'openai', modelo: 'gpt-5.1' }).modelo, 'claude-sonnet-5');
// Una clave ilegible (rotaron AUTH_SESSION_SECRET) no se elige.
assert.equal(elegirActiva([k('rota', 'openai', false), claude], { clave: 'rota', proveedor: 'openai', modelo: 'gpt-5.1' }).clave, 'claude');

// El formato viejo de claves-ia se convierte a lista, con el nombre del proveedor.
assert.deepEqual(desdeGuardado({ openai: { cifrada: 'x', fin: 'ab12' }, gemini: { cifrada: 'y' } }),
  [{ cifrada: 'x', fin: 'ab12', id: 'openai', nombre: 'OpenAI', proveedor: 'openai' }], 'Gemini ya no existe: se ignora');
assert.deepEqual(desdeGuardado(null), []);

// Las del entorno aparecen como una clave más, de solo lectura.
delete process.env.AI_PROVIDER; delete process.env.AI_MODEL; delete process.env.ANTHROPIC_API_KEY;
process.env.OPENAI_API_KEY = 'sk-del-entorno-1234567890-9z8y';
assert.deepEqual(claves(), [{ id: 'entorno-openai', nombre: 'OpenAI (entorno)', proveedor: 'openai', origen: 'entorno', fin: '9z8y', legible: true, por: null }]);
assert.equal(clave('entorno-openai'), 'sk-del-entorno-1234567890-9z8y');
assert.equal(clave('inventada'), null);
assert.equal(activo().clave, 'entorno-openai');
await assert.rejects(quitarClave('entorno-openai'), /variable de entorno/);

// Las del panel: se descifran al cargar; con otro secreto quedan ilegibles y no se eligen.
recordar([{ id: 'a1', nombre: 'Principal', proveedor: 'openai', cifrada: cifrar('sk-panel-1234567890-abcd'), fin: 'abcd' }]);
assert.equal(clave('a1'), 'sk-panel-1234567890-abcd');
assert.equal(activo().clave, 'a1', 'la del panel va antes que la del entorno');
assert.deepEqual(claves().map((c) => [c.id, c.legible]), [['a1', true], ['entorno-openai', true]]);
recordar([{ id: 'a1', nombre: 'Principal', proveedor: 'openai', cifrada: 'basura', fin: 'abcd' }]);
assert.equal(claves()[0].legible, false);
assert.equal(activo().clave, 'entorno-openai');

// ── Qué elecciones se aceptan ───────────────────────────────────────────────
assert.deepEqual(validar({ clave: 'entorno-openai', modelo: ' gpt-5.1 ' }), { clave: 'entorno-openai', proveedor: 'openai', modelo: 'gpt-5.1' });
assert.throws(() => validar({ clave: 'inventada', modelo: 'x' }), /no existe/);
assert.throws(() => validar({ clave: 'a1', modelo: 'gpt-5.1' }), /no se puede leer/);
assert.throws(() => validar({ clave: 'entorno-openai', modelo: '   ' }), /Elige un modelo/);
assert.throws(() => validar({ clave: 'entorno-openai', modelo: 'x'.repeat(121) }), /Elige un modelo/);
// Sin base, guardar avisa en vez de fingir que guardó.
await assert.rejects(guardar({ clave: 'entorno-openai', modelo: 'gpt-5.1' }), /APP_DATABASE_URL/);

// Guardar una clave valida nombre y forma sin llamar a nadie.
const pegar = (d) => guardarClave({ nombre: 'Respaldo', proveedor: 'openai', clave: 'sk-una-clave-larga-1234567890', ...d });
await assert.rejects(pegar({ proveedor: 'gemini' }), /OpenAI o Claude/);
await assert.rejects(pegar({ nombre: '  ' }), /Ponle un nombre/);
await assert.rejects(pegar({ nombre: 'x'.repeat(41) }), /Ponle un nombre/);
await assert.rejects(pegar({ nombre: 'principal' }), /Ya hay una clave con ese nombre/, 'sin distinguir mayúsculas');
await assert.rejects(pegar({ clave: 'corta' }), /no parece una clave/);
await assert.rejects(pegar({ clave: 'sk con espacios dentro de la clave larga' }), /no parece una clave/);

// Editar y probar: lo que no necesita red ni base.
await assert.rejects(editarClave('entorno-openai', { nombre: 'X' }), /variable de entorno/);
await assert.rejects(editarClave('inventada', { nombre: 'X' }), /no existe/);
recordar([{ id: 'a1', nombre: 'Principal', proveedor: 'openai', cifrada: cifrar('sk-panel-1234567890-abcd'), fin: 'abcd' },
  { id: 'a2', nombre: 'Respaldo', proveedor: 'openai', cifrada: 'basura', fin: 'zz99' }]);
await assert.rejects(editarClave('a1', { nombre: ' Principal ' }), /nada que cambiar/, 'el mismo nombre no es un cambio');
await assert.rejects(editarClave('a1', {}), /nada que cambiar/);
await assert.rejects(editarClave('a1', { nombre: 'respaldo' }), /Ya hay una clave con ese nombre/);
await assert.rejects(editarClave('a1', { clave: 'corta' }), /no parece una clave/);
await assert.rejects(editarClave('a1', { nombre: 'Nueva' }), /APP_DATABASE_URL/, 'un nombre válido llega hasta guardar');
await assert.rejects(probarClave('a2'), /no se puede leer/);
await assert.rejects(probarClave('inventada'), /no existe/);
recordar([]);
delete process.env.OPENAI_API_KEY;

// Los códigos del proveedor se explican: nunca un "404" solo.
assert.match(explicarHttp(401), /^la clave no es válida o fue revocada \(401\)$/);
assert.match(explicarHttp(404), /modelo retirado/);
assert.match(explicarHttp(403), /permiso/);
assert.match(explicarHttp(429), /límite de uso/);
assert.match(explicarHttp(503), /fallando de su lado.*\(503\)/);
assert.match(explicarHttp(418), /respondió con un error \(418\)/);

// ── El prompt es el mismo para todos, y cambia solo por canal y cliente ─────
const web = system('web');
// Rama cancun: el negocio va fijo en el código (guia.mjs).
assert.match(web, /analista de datos de Cancun Country Club, Desarrollo residencial de lujo/);
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
const kk = 'sk-ant-clave-de-prueba-1234567890-a1b2';
const c1 = cifrar(kk), c2 = cifrar(kk);
assert.equal(descifrar(c1), kk, 'ida y vuelta');
assert.notEqual(c1, c2, 'IV distinto en cada cifrado');
assert.ok(!Buffer.from(c1, 'base64').toString('latin1').includes('clave-de-prueba'), 'la clave no queda en claro');
// Con otro secreto no se lee, y no revienta: el panel avisa de que hay que volver a pegarla.
const secreto = process.env.AUTH_SESSION_SECRET;
process.env.AUTH_SESSION_SECRET = 'otro-secreto-'.padEnd(64, 'y');
assert.equal(descifrar(c1), null);
process.env.AUTH_SESSION_SECRET = secreto;
assert.equal(descifrar('basura'), null);
assert.equal(descifrar(c1.slice(0, -4) + 'AAAA'), null, 'si se altera, no se lee');

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
assert.equal(causa(err('The model `gpt-4-32k` does not exist or you do not have access to it.', { status: 404, code: 'model_not_found' }), 'openai'), 'modelo', 'un modelo retirado da 404');
assert.equal(causa(err('400 {"type":"error","error":{"type":"not_found_error","message":"model: claude-3"}}', { status: 400 })), 'modelo');
assert.equal(causa(err('403 permission_error', { status: 403 })), 'permiso');
assert.match(causaDeFallo(err('Your credit balance is too low'), 'anthropic').texto, /cuenta de Anthropic se quedó sin saldo/);
assert.match(causaDeFallo(err('insufficient_quota'), 'openai').texto, /cuenta de OpenAI/);
// En WhatsApp el aviso llega como mensaje del bot: no dice "no puedo contestar", dice qué le falta.
assert.match(causaDeFallo(err('insufficient_quota'), 'openai').texto, /^No tengo acceso a los datos: la cuenta de OpenAI se quedó sin saldo/);

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
