// Uso: node wa-admin.check.mjs
import assert from 'node:assert/strict';

delete process.env.APP_DATABASE_URL;

const { nombreValido, jidValido, estadoPanel } = await import('./wa-admin.mjs');
const { estado } = await import('./whatsapp.mjs');

// El nombre de la conexión lo escribe una persona y acaba dentro de una URL: se valida estricto.
for (const bueno of ['zebra-bot', 'datachat', 'bot_2', 'abc']) {
  assert.equal(nombreValido(bueno), true, `deberia aceptar ${bueno}`);
}
for (const malo of ['../otra', 'bot/../x', 'con espacios', 'MAYUSCULAS', 'acentúa', 'ab', '', null, undefined, 'a'.repeat(32)]) {
  assert.equal(nombreValido(malo), false, `deberia rechazar ${String(malo)}`);
}

// El identificador de grupo, igual: solo grupos, nunca un privado.
assert.equal(jidValido('120363412885434823@g.us'), true);
assert.equal(jidValido('5219991234567-1601234567@g.us'), true, 'los grupos de antes de 2021 llevan guion');
assert.equal(jidValido('5219991234567-@g.us'), false);
assert.equal(jidValido('../x-1@g.us'), false);
assert.equal(jidValido('5219993559463@s.whatsapp.net'), false, 'un privado no es un grupo');
assert.equal(jidValido('@g.us'), false);
assert.equal(jidValido(''), false);

// Un número que nunca se conectó en este proceso se ve desconectado, no rompe el panel.
assert.deepEqual(estado('zebra-bot'), { estado: 'desconectado', qr: null, numero: null });

// Sesión vencida: solo si no hay conexión y WhatsApp la había cerrado.
assert.equal(estadoPanel('desconectado', null), 'desconectado', 'nunca se vinculó');
assert.equal(estadoPanel('desconectado', new Date()), 'vencida');
assert.equal(estadoPanel('conectado', new Date()), 'conectado', 'si ya reconectó, la fecha vieja no importa');
assert.equal(estadoPanel('esperando', new Date()), 'esperando', 'mientras muestra el QR');

console.log('wa-admin OK');
