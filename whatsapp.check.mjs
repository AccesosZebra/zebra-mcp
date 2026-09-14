// Uso: node whatsapp.check.mjs
import assert from 'node:assert/strict';

const { numeroDe, textoDe, respuestaFinal } = await import('./whatsapp.mjs');

// El número sale del JID, con o sin sufijo de dispositivo.
assert.equal(numeroDe('5219997923682@s.whatsapp.net'), '5219997923682');
assert.equal(numeroDe('5219997923682:12@s.whatsapp.net'), '5219997923682');
assert.equal(numeroDe(''), '');

// Texto plano y texto con formato (Evolution normaliza el segundo a `conversation`).
assert.equal(textoDe({ message: { conversation: 'hola' } }), 'hola');
assert.equal(textoDe({ message: { extendedTextMessage: { text: 'con *formato*' } } }), 'con *formato*');
assert.equal(textoDe({ message: { imageMessage: {} } }), null, 'una imagen no es texto');
assert.equal(textoDe({}), null);

// La respuesta es lo escrito DESPUÉS de la última consulta: antes van notas de progreso.
const content = [
  { type: 'text', text: 'Voy a revisar la base.' },
  { type: 'mcp_tool_use', name: 'query_readonly' },
  { type: 'mcp_tool_result', is_error: false },
  { type: 'text', text: 'Sofía tuvo 498 leads' },
  { type: 'text', text: ' en agosto.' },
];
assert.equal(respuestaFinal(content), 'Sofía tuvo 498 leads en agosto.');

// Sin consultas, la respuesta es todo el texto.
assert.equal(respuestaFinal([{ type: 'text', text: 'Hola, ¿qué quieres saber?' }]), 'Hola, ¿qué quieres saber?');

// Si la última consulta no llegó a producir texto, no se inventa nada.
assert.equal(respuestaFinal([
  { type: 'text', text: 'Consultando…' },
  { type: 'mcp_tool_use', name: 'query_readonly' },
  { type: 'mcp_tool_result', is_error: true },
]), '');

console.log('whatsapp OK');
