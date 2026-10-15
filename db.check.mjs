// Uso: node db.check.mjs
// Sin APP_DATABASE_URL: leer no debe romper y escribir debe avisar con un mensaje entendible,
// no con un error de conexión. Es el estado en el que arranca cualquiera que clone el repo.
import assert from 'node:assert/strict';

delete process.env.APP_DATABASE_URL;

const db = await import('./db.mjs');

assert.equal(db.hayBase, false);

// Leer: vacío, sin excepciones.
assert.equal(await db.leerAjuste('ia'), null);
assert.deepEqual(await db.numeros(), []);
assert.equal((await db.grupos('zebra-bot')).size, 0);

assert.deepEqual(await db.conSesion(), [], 'sin base no hay números que reconectar');
assert.equal(await db.aplicarEsquema(), false, 'sin base no hay esquema que aplicar');

// Escribir: avisa de lo que falta.
await assert.rejects(db.guardarAjuste('ia', { proveedor: 'anthropic' }), /APP_DATABASE_URL/);
await assert.rejects(db.agregarNumero({ instancia: 'zebra-bot' }), /APP_DATABASE_URL/);
await assert.rejects(db.ponerGrupo({ jid: '120363412885434823@g.us', instancia: 'zebra-bot' }), /APP_DATABASE_URL/);
await assert.rejects(db.marcarVencida('zebra-bot', new Date()), /APP_DATABASE_URL/);
await assert.rejects(db.quitarGrupo('120363412885434823@g.us'), /APP_DATABASE_URL/);
await assert.rejects(db.estadoAuth('zebra-bot'), /APP_DATABASE_URL/);
await assert.rejects(db.borrarSesion('zebra-bot'), /APP_DATABASE_URL/);
await assert.rejects(db.borrarNumero('zebra-bot'), /APP_DATABASE_URL/);

// La sesión se guarda como JSON y sus llaves son Buffers: si la ida y vuelta las convirtiera en
// objetos sueltos, el teléfono se desvincularía en cada despliegue.
const { BufferJSON, initAuthCreds } = await import('baileys');
const creds = initAuthCreds();
const vuelta = JSON.parse(JSON.stringify(creds, BufferJSON.replacer), BufferJSON.reviver);
assert.ok(Buffer.isBuffer(vuelta.noiseKey.private), 'las llaves vuelven como Buffer');
assert.deepEqual(vuelta.signedIdentityKey.public, creds.signedIdentityKey.public);
assert.equal(vuelta.registrationId, creds.registrationId);

console.log('db OK');
