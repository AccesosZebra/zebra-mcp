// Uso: node n8n.check.mjs
// La API para n8n sin red ni base: clave, destino, URLs de medios y lo que se le pasa a Baileys.
import assert from 'node:assert/strict';

delete process.env.APP_DATABASE_URL;
const n = await import('./n8n.mjs');

// ── La clave: solo coincide la buena, y nada raro revienta ──
const clave = 'zmcp_una-clave-de-prueba-larga-0123456789';
const hash = n.hashClave(clave);
assert.match(hash, /^[0-9a-f]{64}$/);
assert.equal(n.claveCoincide(clave, hash), true);
assert.equal(n.claveCoincide(clave + 'x', hash), false);
for (const raro of [undefined, null, '', 42]) assert.equal(n.claveCoincide(raro, hash), false);
assert.equal(n.claveCoincide(clave, null), false, 'un número sin clave no deja pasar a nadie');

// ── A quién va ──
assert.deepEqual(n.destino('120363428912675963@g.us'), { jid: '120363428912675963@g.us' });
assert.deepEqual(n.destino('5219991234567-1601234567@g.us'), { jid: '5219991234567-1601234567@g.us' }, 'grupos viejos con guion');
assert.deepEqual(n.destino('5219997923682@s.whatsapp.net'), { jid: '5219997923682@s.whatsapp.net' });
assert.deepEqual(n.destino(' +52 1 999 792 3682 '), { digitos: '5219997923682' }, 'con espacios y +');
assert.deepEqual(n.destino(5219997923682), { digitos: '5219997923682' }, 'el nodo puede mandarlo como número');
for (const malo of ['', 'hola', '123', '1234567890123456', 'x@g.us', '521@lid', null]) {
  assert.throws(() => n.destino(malo), /destino no es válido/, String(malo));
}

// ── URLs de medios: solo https a un dominio público ──
assert.equal(n.urlPermitida('https://cdn.ejemplo.com/a.png').hostname, 'cdn.ejemplo.com');
for (const [url, re] of [
  ['http://cdn.ejemplo.com/a.png', /https:\/\//],
  ['ftp://cdn.ejemplo.com/a.png', /https:\/\//],
  ['https://10.0.0.5/a.png', /dominio público/],
  ['https://[::1]/a.png', /dominio público/],
  ['https://postgres_reportes:3000/', /dominio público/],
  ['https://localhost/a', /dominio público/],
  ['https://panel.internal/a', /dominio público/],
  ['no es url', /URL válida/],
]) assert.throws(() => n.urlPermitida(url), re, url);
for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
  assert.equal(n.ipPrivada(ip), true, ip);
}
for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) assert.equal(n.ipPrivada(ip), false, ip);

// bajarMedio: base64 (con o sin data:), URL pública, y lo que se rechaza.
const png = Buffer.from('imagen de prueba');
assert.deepEqual(await n.bajarMedio(png.toString('base64')), png);
assert.deepEqual(await n.bajarMedio(`data:image/png;base64,${png.toString('base64')}`), png);
await assert.rejects(n.bajarMedio(''), /Falta el archivo/);
await assert.rejects(n.bajarMedio('esto no es base64 ¿?'), /ni base64/);
const publica = { resolverDns: async () => [{ address: '151.101.1.1' }] };
const ok = (cuerpo, cab = {}) => async () => new Response(cuerpo, { status: 200, headers: cab });
assert.deepEqual(await n.bajarMedio('https://cdn.ejemplo.com/a.png', { ...publica, pedir: ok(png) }), png);
await assert.rejects(n.bajarMedio('https://trampa.ejemplo.com/a', { resolverDns: async () => [{ address: '10.0.0.7' }], pedir: ok(png) }), /red interna/, 'un dominio que resuelve a la red interna');
await assert.rejects(n.bajarMedio('https://cdn.ejemplo.com/a', { ...publica, pedir: async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }) }), /redirige/);
await assert.rejects(n.bajarMedio('https://cdn.ejemplo.com/a', { ...publica, pedir: async () => new Response('x', { status: 404 }) }), /respondió 404/);
await assert.rejects(n.bajarMedio('https://cdn.ejemplo.com/a', { ...publica, pedir: ok('x', { 'content-length': String(n.MAX_MEDIO + 1) }) }), /20 MB/);
await assert.rejects(n.bajarMedio('https://nadie.ejemplo.com/a', { resolverDns: async () => { throw new Error('ENOTFOUND'); }, pedir: ok(png) }), /No se encontró el dominio/);

// ── Lo que recibe Baileys, desde los cuerpos que manda el nodo ──
assert.deepEqual(n.contenidoTexto({ number: 'x', text: 'Hola *equipo*', mentioned: ['5219991234567@s.whatsapp.net', 'basura'] }),
  { text: 'Hola *equipo*', mentions: ['5219991234567@s.whatsapp.net'] });
assert.throws(() => n.contenidoTexto({ text: '   ' }), /Falta el texto/);
const archivo = Buffer.from('x');
assert.deepEqual(n.contenidoMedio({ mediatype: 'image', caption: 'Reporte', mimetype: 'image/png' }, archivo),
  { image: archivo, mimetype: 'image/png', caption: 'Reporte', mentions: [] });
assert.deepEqual(n.contenidoMedio({ mediatype: 'video', caption: '' }, archivo), { video: archivo, mimetype: undefined, caption: undefined, mentions: [] });
assert.deepEqual(n.contenidoMedio({ mediatype: 'document', fileName: 'cierre.pdf', mimetype: 'application/pdf' }, archivo),
  { document: archivo, mimetype: 'application/pdf', fileName: 'cierre.pdf', caption: undefined, mentions: [] });
assert.equal(n.contenidoMedio({ mediatype: 'document' }, archivo).mimetype, 'application/octet-stream', 'un documento siempre lleva tipo');
assert.equal(n.contenidoMedio({ mediatype: 'document' }, archivo).fileName, 'archivo');
assert.throws(() => n.contenidoMedio({ mediatype: 'audio' }, archivo), /image, video o document/);
assert.deepEqual(n.contenidoReaccion({ key: { remoteJid: '120363428912675963@g.us', fromMe: 'true', id: 'ABC' }, reaction: '👍' }),
  { jid: '120363428912675963@g.us', contenido: { react: { text: '👍', key: { remoteJid: '120363428912675963@g.us', fromMe: true, id: 'ABC' } } } });
assert.throws(() => n.contenidoReaccion({ key: { remoteJid: '120363428912675963@g.us' } }), /Faltan el id/);

console.log('n8n OK');
