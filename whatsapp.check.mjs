// Uso: node whatsapp.check.mjs
import assert from 'node:assert/strict';

const { debeResponder, gruposPermitidos, textoDe, limpiar, respuestaFinal, esGrupo, mismoNumero } =
  await import('./whatsapp.mjs');

const BOT = '5219990000000@s.whatsapp.net';
const GRUPO = '120363000000000001@g.us';
const OTRO_GRUPO = '120363000000000002@g.us';
const permitidos = gruposPermitidos(`${GRUPO}=Sofía, ${OTRO_GRUPO}`);

// La lista: cada grupo con su cliente, y un grupo sin cliente es válido pero sin ámbito.
assert.equal(permitidos.get(GRUPO), 'Sofía');
assert.equal(permitidos.get(OTRO_GRUPO), null);
assert.equal(gruposPermitidos('').size, 0);

assert.equal(esGrupo(GRUPO), true);
assert.equal(esGrupo(BOT), false);
assert.equal(mismoNumero('5219990000000:12@s.whatsapp.net', BOT), true, 'el sufijo de dispositivo no cuenta');
assert.equal(mismoNumero('5219991111111@s.whatsapp.net', BOT), false);

assert.equal(textoDe({ message: { extendedTextMessage: { text: 'hola' } } }), 'hola');
assert.equal(limpiar('@5219990000000 ¿cuántos leads?'), '¿cuántos leads?', 'la mención no va al modelo');

const mensaje = (extra = {}) => ({
  key: { remoteJid: GRUPO, fromMe: false, participant: '5219991111111@s.whatsapp.net' },
  message: { conversation: '@5219990000000 ¿cuántos leads van?' },
  contextInfo: { mentionedJid: [BOT] },
  ...extra,
});

// Responde: lo mencionaron en un grupo de la lista, y hereda el cliente del grupo.
const ok = debeResponder({ data: mensaje(), botJid: BOT, permitidos });
assert.equal(ok.responder, true);
assert.equal(ok.cliente, 'Sofía');
assert.equal(ok.pregunta, '¿cuántos leads van?');

// También cuando responden a un mensaje suyo, sin mencionarlo.
const respuesta = debeResponder({
  data: mensaje({ message: { conversation: '¿y en julio?' }, contextInfo: { participant: BOT } }),
  botJid: BOT, permitidos,
});
assert.equal(respuesta.responder, true);

// No responde: sin mención, grupo ajeno, privado, mensaje propio ni mensaje sin texto.
const no = (data) => debeResponder({ data, botJid: BOT, permitidos });
assert.equal(no(mensaje({ contextInfo: {} })).responder, false, 'nadie lo mencionó');
assert.equal(no(mensaje({ key: { remoteJid: '120363000000000009@g.us', fromMe: false } })).responder, false, 'grupo fuera de la lista');
assert.equal(no(mensaje({ key: { remoteJid: '5219991111111@s.whatsapp.net', fromMe: false } })).responder, false, 'privado');
assert.equal(no(mensaje({ key: { remoteJid: GRUPO, fromMe: true } })).responder, false, 'lo mandó el propio bot');
assert.equal(no(mensaje({ message: { imageMessage: {} } })).responder, false, 'sin texto');
assert.equal(no(mensaje({ message: { conversation: '@5219990000000' } })).responder, false, 'solo la mención, sin pregunta');

// Sin número propio no se puede juzgar la mención: hay que decirlo, no fingir que nadie lo mencionó.
const sinNumero = debeResponder({ data: mensaje(), botJid: null, permitidos });
assert.equal(sinNumero.responder, false);
assert.equal(sinNumero.motivo, 'no sé mi propio número');

// La respuesta es lo escrito después de la última consulta.
assert.equal(respuestaFinal([
  { type: 'text', text: 'Voy a revisar.' },
  { type: 'mcp_tool_use' }, { type: 'mcp_tool_result' },
  { type: 'text', text: '498 leads' }, { type: 'text', text: ' en agosto.' },
]), '498 leads en agosto.');
assert.equal(respuestaFinal([{ type: 'text', text: 'Hola' }]), 'Hola');

console.log('whatsapp OK');
