// Uso: node whatsapp.check.mjs
import assert from 'node:assert/strict';

const { debeResponder, gruposPermitidos, identidades, textoDe, limpiar, esGrupo, esElBot } =
  await import('./whatsapp.mjs');

// Cada número resuelve su propia identidad: la instancia es el primer argumento, y sin ella dos
// números compartirían el @lid de uno solo. Lo demás de esa función habla con Evolution y se
// comprueba en vivo, no aquí.
assert.equal(identidades.length, 3, 'identidades(instancia, grupoJid, sender)');

// Las dos formas en que WhatsApp nombra al bot. Las menciones usan el @lid, no el teléfono.
const TEL = '5219901448105@s.whatsapp.net';
const LID = '259373830041791@lid';
const mias = new Set(['5219901448105', '259373830041791']);
const GRUPO = '120363412885434823@g.us';
const OTRO_GRUPO = '120363000000000002@g.us';
const permitidos = gruposPermitidos(`${GRUPO}=Sofía, ${OTRO_GRUPO}`);

// La lista: cada grupo con su cliente, y un grupo sin cliente es válido pero sin ámbito.
assert.equal(permitidos.get(GRUPO), 'Sofía');
assert.equal(permitidos.get(OTRO_GRUPO), null);
assert.equal(gruposPermitidos('').size, 0);

assert.equal(esGrupo(GRUPO), true);
assert.equal(esGrupo(TEL), false);

// Se reconoce por sus dos nombres, y el sufijo de dispositivo no cuenta.
assert.equal(esElBot(LID, mias), true, 'así llega la mención');
assert.equal(esElBot(TEL, mias), true, 'y así lo nombran los clientes viejos');
assert.equal(esElBot('5219901448105:12@s.whatsapp.net', mias), true, 'el sufijo de dispositivo no cuenta');
assert.equal(esElBot('228874562625635@lid', mias), false, 'el lid de otra persona no es el suyo');
assert.equal(esElBot('', mias), false);

assert.equal(textoDe({ message: { extendedTextMessage: { text: 'hola' } } }), 'hola');
assert.equal(limpiar('@259373830041791 ¿cuántos leads?'), '¿cuántos leads?', 'la mención no va al modelo');

// Un mensaje como los que manda Evolution de verdad: quien escribe llega como @lid, con su
// teléfono aparte, y la mención también es un @lid.
const mensaje = (extra = {}) => ({
  key: {
    remoteJid: GRUPO, fromMe: false,
    participant: '228874562625635@lid', participantAlt: '5219993559463@s.whatsapp.net',
  },
  message: { conversation: '@259373830041791 ¿cuántos leads van?' },
  contextInfo: { mentionedJid: [LID] },
  ...extra,
});

// Responde: lo mencionaron en un grupo de la lista, y hereda el cliente del grupo.
const ok = debeResponder({ data: mensaje(), mias, permitidos });
assert.equal(ok.responder, true);
assert.equal(ok.cliente, 'Sofía');
assert.equal(ok.pregunta, '¿cuántos leads van?');

// También si lo mencionan por número, que es como venía antes del cambio de WhatsApp.
assert.equal(debeResponder({ data: mensaje({ contextInfo: { mentionedJid: [TEL] } }), mias, permitidos }).responder,
  true, 'una mención por teléfono sigue valiendo');

// Y cuando responden a un mensaje suyo sin mencionarlo: ahí el contexto viaja DENTRO del mensaje.
const respuesta = debeResponder({
  data: mensaje({
    message: { extendedTextMessage: { text: '¿y en julio?', contextInfo: { participant: LID } } },
    contextInfo: undefined,
  }),
  mias, permitidos,
});
assert.equal(respuesta.responder, true, 'responder a un mensaje suyo cuenta como mención');
assert.equal(respuesta.pregunta, '¿y en julio?');

// No responde: sin mención, grupo ajeno, privado, mensaje propio ni mensaje sin texto.
const no = (data) => debeResponder({ data, mias, permitidos });
assert.equal(no(mensaje({ contextInfo: {} })).responder, false, 'nadie lo mencionó');
assert.equal(no(mensaje({ key: { remoteJid: '120363000000000009@g.us', fromMe: false } })).responder, false, 'grupo fuera de la lista');
assert.equal(no(mensaje({ key: { remoteJid: '5219993559463@s.whatsapp.net', fromMe: false } })).responder, false, 'privado');
assert.equal(no(mensaje({ key: { remoteJid: GRUPO, fromMe: true } })).responder, false, 'lo mandó el propio bot');
assert.equal(no(mensaje({ message: { imageMessage: {} } })).responder, false, 'sin texto');
assert.equal(no(mensaje({ message: { conversation: '@259373830041791' } })).responder, false, 'solo la mención, sin pregunta');

// Sin identidad propia no se puede juzgar la mención: hay que decirlo, no fingir que nadie lo mencionó.
const sinIdentidad = debeResponder({ data: mensaje(), mias: new Set(), permitidos });
assert.equal(sinIdentidad.responder, false);
assert.equal(sinIdentidad.motivo, 'no sé quién soy');

// Quedarse con lo escrito después de la última consulta ya no vive aquí: se movió a chat.mjs,
// que es quien habla con el proveedor. Ver chat.check.mjs.

console.log('whatsapp OK');
