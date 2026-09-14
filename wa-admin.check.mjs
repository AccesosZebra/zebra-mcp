// Uso: node wa-admin.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.WHATSAPP_WEBHOOK_SECRET = 'secreto-de-prueba';

const { estadoDe, webhookConfig } = await import('./wa-admin.mjs');

// El estado llega en sitios distintos segun el endpoint de Evolution.
assert.equal(estadoDe({ instance: { instanceName: 'DataChat', state: 'open' } }), 'conectado');
assert.equal(estadoDe({ state: 'connecting' }), 'esperando');
assert.equal(estadoDe({ instance: { state: 'close' } }), 'desconectado');
assert.equal(estadoDe({}), 'desconocido');
assert.equal(estadoDe(null), 'desconocido');

// El webhook apunta al endpoint del bot, sin barra doble, y lleva el secreto en la cabecera.
const w = webhookConfig();
assert.equal(w.url, 'https://ejemplo.test/api/whatsapp');
assert.equal(w.enabled, true);
assert.deepEqual(w.events, ['MESSAGES_UPSERT']);
assert.equal(w.headers['x-zebra-secret'], 'secreto-de-prueba');
assert.equal(w.byEvents, false, 'byEvents partiria la URL por evento');

console.log('wa-admin OK');
