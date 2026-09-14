// Uso: npm run check  (MCP_URL=https://mcp.zebra-ecosystem.cloud/mcp npm run check para el público)
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL ?? 'http://localhost:3000/mcp');

const sinToken = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: '{}',
});
assert.equal(sinToken.status, 401, 'sin token debe responder 401');

const client = new Client({ name: 'check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } },
}));

const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name).sort(), ['get_schema', 'list_tables', 'query_readonly']);

const llamar = (name, args = {}) => client.callTool({ name, arguments: args });
const txt = (r) => r.content[0].text;

const tablas = await llamar('list_tables');
assert.match(txt(tablas), /mart\.v_kpi_diario/);
assert.match(txt(tablas), /"Grupo Gira"\.v_funnel_resumen_gira \(vista\)/);
assert.doesNotMatch(txt(tablas), /chats|\(tabla\).*"Grupo Gira"|"Grupo Gira"\.[^\n]*\(tabla\)/);

const gira = await llamar('query_readonly', { sql: 'select count(*)::int as n from "Grupo Gira".cierres_gira' });
assert.ok(!gira.isError, txt(gira));

assert.match(txt(await llamar('get_schema', { table_name: 'mart.v_kpi_diario' })), /cliente_id/);
assert.ok((await llamar('get_schema', { table_name: '"Sofía".chats' })).isError);

const ok = await llamar('query_readonly', { sql: 'select count(*)::int as n from mart.v_kpi_diario;' });
assert.ok(!ok.isError, txt(ok));
assert.ok(JSON.parse(txt(ok)).filas[0].n > 0);

const mucho = JSON.parse(txt(await llamar('query_readonly', { sql: 'select generate_series(1, 1000) as n' })));
assert.equal(mucho.filas.length, 500);
assert.equal(mucho.truncado, true);

for (const malo of [
  'delete from ops.clientes',
  'select 1; drop table ops.clientes',
  // Cierra el paréntesis del envoltorio: dos sentencias válidas, solo las frena el protocolo extendido.
  'select 1) q; select 1 from (select 1',
  'with d as (delete from ops.clientes returning *) select * from d',
  'select * from "Sofía".chats',
  'select pg_sleep(25)',
]) {
  const r = await llamar('query_readonly', { sql: malo });
  assert.ok(r.isError, `debió fallar: ${malo}`);
  console.log(`bloqueado: ${malo}\n  → ${txt(r)}`);
}

await client.close();
console.log('\nOK: todas las comprobaciones pasaron');
