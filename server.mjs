import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

const { DATABASE_URL, MCP_AUTH_TOKEN, PORT = '3000' } = process.env;
if (!DATABASE_URL || !MCP_AUTH_TOKEN || MCP_AUTH_TOKEN.length < 32) {
  console.error('Faltan DATABASE_URL o MCP_AUTH_TOKEN (mínimo 32 caracteres)');
  process.exit(1);
}

const MAX_FILAS = 500;

// Qué se puede leer lo decide el rol claude_readonly (grants.sql): information_schema ya filtra por permisos.
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
pool.on('error', (e) => console.error('pool:', e.message));

const texto = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

async function registrar(tool, detalle, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(JSON.stringify({ tool, ms: Date.now() - t0, detalle }));
    return r;
  } catch (e) {
    console.log(JSON.stringify({ tool, ms: Date.now() - t0, detalle, error: e.message }));
    return texto(`Error de Postgres: ${e.message}`, true);
  }
}

const CAPAS = `Base de métricas de Zebra (Postgres 17, solo lectura). Hay dos fuentes:

1) Un esquema por cliente ("Grupo Gira", "Midstorage", "Sofía", "Zenco Desarrollos"…): vistas espejo de las
   hojas de Sheets de ese cliente, con sufijo del cliente (casi todo texto; revisa columnas con get_schema):
   entrada_leads_<x>, citas_agendadas_<x>, citas_realizadas_<x>, apartados_<x>, cierres_<x>,
   ventas_perdidas_<x>, spent_campañas_<x> (gasto), glosario_asesores_<x>, perfilado_ia_<x>,
   v_funnel_resumen_<x>, v_lead_funnel_<x>. Los esquemas "<Cliente>_callpicker" tienen llamadas.
   Es la fuente para cualquier cliente.

2) Capa canónica, hoy SOLO con el cliente Sofía (cliente_id 'sofia'):
   - mart: KPIs ya calculados por cliente_id y fecha. v_kpi_diario (gasto, leads por fuente, citas,
     apartados, cierres, valor, llamadas, presupuesto), v_kpi_campana_diario y v_cohorte_* (por campaña),
     v_kpi_asesor_diario (por asesor), v_perdida_*, v_presupuesto_mes, v_frescura.
   - crm: detalle de leads, eventos de etapa y llamadas. ops: clientes, presupuesto, tipo de cambio.
   - ads: gasto diario por campaña de Meta y Google.
   Para Sofía prefiere mart; para los demás usa su esquema.`;

function crearServidor() {
  const server = new McpServer({ name: 'zebra-db', version: '1.0.0' });

  server.registerTool('list_tables', {
    description: `Lista las tablas y vistas disponibles, con el nombre listo para usar en SQL.\n\n${CAPAS}`,
  }, () => registrar('list_tables', null, async () => {
    const { rows } = await pool.query(
      `select quote_ident(table_schema) || '.' || quote_ident(table_name) as nombre,
              case table_type when 'VIEW' then 'vista' else 'tabla' end as tipo
         from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name`);
    return texto(rows.map((r) => `${r.nombre} (${r.tipo})`).join('\n'));
  }));

  server.registerTool('get_schema', {
    description: 'Columnas y tipos de una tabla o vista. Formato "esquema.tabla", p. ej. "mart.v_kpi_diario" o "Grupo Gira".cierres_gira.',
    inputSchema: { table_name: z.string().describe('esquema.tabla') },
  }, ({ table_name }) => registrar('get_schema', table_name, async () => {
    const [esquema, ...resto] = table_name.replaceAll('"', '').split('.');
    const { rows } = await pool.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = $1 and table_name = $2
        order by ordinal_position`, [esquema, resto.join('.')]);
    if (!rows.length) return texto(`No existe "${table_name}" o no hay acceso. Usa list_tables.`, true);
    return texto(rows.map((r) => `${r.column_name} ${r.data_type}`).join('\n'));
  }));

  server.registerTool('query_readonly', {
    description: `Ejecuta UNA consulta SELECT (o WITH … SELECT) de solo lectura y devuelve JSON.
Máximo ${MAX_FILAS} filas y 20 s: agrega en SQL (sum, count, group by) en vez de traer filas crudas.
Identificadores con mayúsculas, acentos, ñ o espacios van entre comillas dobles.\n\n${CAPAS}`,
    inputSchema: { sql: z.string().describe('Una sola consulta SELECT, sin punto y coma') },
    annotations: { readOnlyHint: true },
  }, ({ sql }) => registrar('query_readonly', sql.slice(0, 300), async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '20s'");
      // Envolver + protocolo extendido: una sola sentencia SELECT, sin "; DROP…" ni COMMIT colados.
      const { rows } = await client.query({
        text: `SELECT * FROM (${sql.trim().replace(/;\s*$/, '')}) q LIMIT ${MAX_FILAS + 1}`,
        queryMode: 'extended',
      });
      const truncado = rows.length > MAX_FILAS;
      return texto(JSON.stringify({ filas: rows.slice(0, MAX_FILAS), truncado }));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }));

  return server;
}

// Sin validación de Host: todo /mcp exige el token, así que un rebinding de DNS no obtiene nada.
const app = createMcpExpressApp({ host: '0.0.0.0' });
const esperado = Buffer.from(`Bearer ${MCP_AUTH_TOKEN}`);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Chat con login de Google. Si falta configuración, el MCP sigue funcionando solo.
const CHAT_ENV = ['ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_SESSION_SECRET', 'AUTH_BASE_URL'];
const faltan = CHAT_ENV.filter((k) => !process.env[k]);
if (faltan.length) {
  console.warn(`Chat desactivado, faltan: ${faltan.join(', ')}`);
} else {
  const { fileURLToPath } = await import('node:url');
  const { mountAuth, requireSession } = await import('./auth.mjs');
  const { mountChat } = await import('./chat.mjs');
  const page = (name) => fileURLToPath(new URL(`./public/${name}`, import.meta.url));
  mountAuth(app);
  mountChat(app, requireSession);
  // El bot de WhatsApp es opcional: sin su configuración, el chat web sigue igual.
  // EVOLUTION_INSTANCE ya no hace falta: los números viven en la base y se añaden desde el panel.
  const WA_ENV = ['EVOLUTION_URL', 'EVOLUTION_API_KEY', 'WHATSAPP_WEBHOOK_SECRET'];
  const faltanWa = WA_ENV.filter((k) => !process.env[k]);
  if (faltanWa.length) {
    console.warn(`WhatsApp desactivado, faltan: ${faltanWa.join(', ')}`);
  } else {
    const { gruposPermitidos, mountWhatsapp } = await import('./whatsapp.mjs');
    const { mountWaAdmin } = await import('./wa-admin.mjs');
    const { sembrar } = await import('./db.mjs');
    // Migración de una vez: lo que hubiera en el entorno pasa a la base y desaparece de la vista.
    try {
      const semilla = await sembrar({ instancia: process.env.EVOLUTION_INSTANCE, grupos: gruposPermitidos() });
      if (semilla) console.log(`WhatsApp sembrado desde el entorno: ${JSON.stringify(semilla)}`);
    } catch (e) {
      console.error('No pude sembrar la configuración de WhatsApp:', e.message);
    }
    mountWhatsapp(app);
    mountWaAdmin(app, requireSession); // la pantalla "Integración WA" del panel
  }

  const { mountAjustes } = await import('./ajustes.mjs');
  const { cargar } = await import('./proveedores.mjs');
  console.log(`Contesta: ${JSON.stringify(await cargar())}`); // lo guardado manda desde el primer turno
  mountAjustes(app, requireSession); // la pantalla "Ajustes" del panel

  app.get('/favicon.ico', (_req, res) => res.sendFile(page('favicon.ico')));
  // Logos de los proveedores. Lista cerrada de archivos: nada que venga del navegador toca el disco.
  const LOGOS = new Set(['anthropic.png', 'openai.png', 'openai-claro.png', 'gemini.jpg']);
  app.get('/logos/:archivo', (req, res) => {
    if (!LOGOS.has(req.params.archivo)) return res.status(404).end();
    res.sendFile(page(`logos/${req.params.archivo}`));
  });
  app.get('/login', (_req, res) => res.sendFile(page('login.html')));
  app.get('/', requireSession, (_req, res) => res.sendFile(page('chat.html')));
}

app.use('/mcp', (req, res, next) => {
  const recibido = Buffer.from(req.headers.authorization ?? '');
  if (recibido.length === esperado.length && timingSafeEqual(recibido, esperado)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.post('/mcp', async (req, res) => {
  const server = crearServidor();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp:', e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());

app.listen(Number(PORT), '0.0.0.0', () => console.log(`zebra-mcp escuchando en :${PORT}`));
