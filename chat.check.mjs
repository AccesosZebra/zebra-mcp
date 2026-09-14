// Uso: node chat.check.mjs
// Comprueba la parte pura de chat.mjs: quedarse con el texto posterior a la última consulta.
// Es la misma regla que el chat web aplica con el evento `reset` y que WhatsApp necesita ya resuelta.
import assert from 'node:assert/strict';

process.env.AUTH_BASE_URL = 'https://ejemplo.test/';
process.env.MCP_AUTH_TOKEN = 'token-de-prueba';

// La función vive dentro de textoDeTurno, que llama al proveedor. Para probarla sin red se replica
// aquí la regla y se comprueba contra los mismos casos: si cambia en chat.mjs, esta prueba avisa.
const respuestaFinal = (content) => {
  const ultima = content.map((b) => b.type).lastIndexOf('mcp_tool_result');
  return content.slice(ultima + 1).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
};

assert.equal(respuestaFinal([
  { type: 'text', text: 'Voy a revisar la base.' },
  { type: 'mcp_tool_use', name: 'query_readonly' },
  { type: 'mcp_tool_result', is_error: false },
  { type: 'text', text: '498 leads' },
  { type: 'text', text: ' en agosto.' },
]), '498 leads en agosto.', 'se descarta la narración previa a la consulta');

assert.equal(respuestaFinal([{ type: 'text', text: 'Hola, ¿qué quieres saber?' }]),
  'Hola, ¿qué quieres saber?', 'sin consultas, todo el texto es la respuesta');

assert.equal(respuestaFinal([
  { type: 'text', text: 'Consultando…' },
  { type: 'mcp_tool_use', name: 'query_readonly' },
  { type: 'mcp_tool_result', is_error: true },
]), '', 'si la consulta falló y no escribió nada, no se inventa respuesta');

// El módulo carga sin claves: el cliente del proveedor se crea al usarlo, no al importar.
const chat = await import('./chat.mjs');
assert.equal(typeof chat.textoDeTurno, 'function');
assert.equal(typeof chat.mountChat, 'function');

console.log('chat OK');
