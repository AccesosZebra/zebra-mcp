// Uso: node wa-admin.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.WHATSAPP_WEBHOOK_SECRET = 'secreto-de-prueba';
delete process.env.APP_DATABASE_URL;

const { estadoDe, webhookConfig, nombreValido, jidValido } = await import('./wa-admin.mjs');

// El estado llega en sitios distintos segun el endpoint de Evolution.
assert.equal(estadoDe({ instance: { instanceName: 'DataChat', state: 'open' } }), 'conectado');
assert.equal(estadoDe({ state: 'connecting' }), 'esperando');
assert.equal(estadoDe({ instance: { state: 'close' } }), 'desconectado');
assert.equal(estadoDe({}), 'desconocido');
assert.equal(estadoDe(null), 'desconocido');

// Cada número tiene su propia dirección de aviso, sin barra doble y con el secreto en la cabecera.
const w = webhookConfig('zebra-bot');
assert.equal(w.url, 'https://ejemplo.test/api/whatsapp/zebra-bot');
assert.equal(w.enabled, true);
assert.deepEqual(w.events, ['MESSAGES_UPSERT']);
assert.equal(w.headers['x-zebra-secret'], 'secreto-de-prueba');
assert.equal(w.byEvents, false, 'byEvents partiria la URL por evento');

// El nombre de la instancia lo escribe una persona y acaba dentro de una URL: se valida estricto.
for (const bueno of ['zebra-bot', 'datachat', 'bot_2', 'abc']) {
  assert.equal(nombreValido(bueno), true, `deberia aceptar ${bueno}`);
}
for (const malo of ['../otra', 'bot/../x', 'con espacios', 'MAYUSCULAS', 'acentúa', 'ab', '', null, undefined, 'a'.repeat(32)]) {
  assert.equal(nombreValido(malo), false, `deberia rechazar ${String(malo)}`);
}

// El identificador de grupo, igual: solo grupos, nunca un privado.
assert.equal(jidValido('120363412885434823@g.us'), true);
assert.equal(jidValido('5219993559463@s.whatsapp.net'), false, 'un privado no es un grupo');
assert.equal(jidValido('@g.us'), false);
assert.equal(jidValido(''), false);

console.log('wa-admin OK');
