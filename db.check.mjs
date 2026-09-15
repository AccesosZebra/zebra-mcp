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

// Sembrar no hace nada si no hay base, ni si no hay instancia en el entorno.
assert.equal(await db.sembrar({ instancia: 'zebra-bot', grupos: new Map() }), null);
assert.equal(await db.sembrar({ instancia: null, grupos: new Map() }), null);

// Escribir: avisa de lo que falta.
await assert.rejects(db.guardarAjuste('ia', { proveedor: 'anthropic' }), /APP_DATABASE_URL/);
await assert.rejects(db.agregarNumero({ instancia: 'zebra-bot' }), /APP_DATABASE_URL/);
await assert.rejects(db.ponerGrupo({ jid: '120363412885434823@g.us', instancia: 'zebra-bot' }), /APP_DATABASE_URL/);
await assert.rejects(db.quitarGrupo('120363412885434823@g.us'), /APP_DATABASE_URL/);

console.log('db OK');
