import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

import { guiaActual } from './guia.mjs';

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

// La guía de la base vive en guia.mjs (en la rama cancun, fija en el código). Se lee en cada
// petición.

function crearServidor() {
  const server = new McpServer({ name: 'zebra-db', version: '1.0.0' });

  server.registerTool('list_tables', {
    description: `Lista las tablas y vistas disponibles, con el nombre listo para usar en SQL.\n\n${guiaActual()}`,
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
    description: 'Columnas y tipos de una tabla o vista. Formato "esquema.tabla", p. ej. "ventas".cierres o "Mi Cliente".leads (con comillas si hay mayúsculas, acentos o espacios).',
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
Identificadores con mayúsculas, acentos, ñ o espacios van entre comillas dobles.\n\n${guiaActual()}`,
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
// Lo mismo que createMcpExpressApp({ host: '0.0.0.0' }) (que no valida el Host), salvo el límite del
// JSON: 100 kb para todo como antes, y más para /evo, donde n8n manda archivos en base64 (20 MB
// de archivo son ~27 MB en base64). El primero que parsea gana; el segundo ve el cuerpo listo y pasa.
const app = express();
app.use('/evo', express.json({ limit: '28mb' }));
app.use(express.json());
const esperado = Buffer.from(`Bearer ${MCP_AUTH_TOKEN}`);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Chat con login de Google. Si falta configuración, el MCP sigue funcionando solo. Las claves de
// IA no hacen falta para arrancar: se pegan desde Ajustes.
const CHAT_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_SESSION_SECRET', 'AUTH_BASE_URL'];
const faltan = CHAT_ENV.filter((k) => !process.env[k]);
if (faltan.length) {
  console.warn(`Chat desactivado, faltan: ${faltan.join(', ')}`);
} else {
  const { fileURLToPath } = await import('node:url');
  const { mountAuth, requireAdmin, requireSession } = await import('./auth.mjs');
  const soloAdmin = [requireSession, requireAdmin]; // Ajustes y Admin: Zebra y los administradores del cliente
  const { mountChat } = await import('./chat.mjs');
  const page = (name) => fileURLToPath(new URL(`./public/${name}`, import.meta.url));
  mountAuth(app);
  mountChat(app, requireSession);
  // La base del dashboard se prepara sola: una instancia nueva arranca con las tablas creadas.
  const { aplicarEsquema, hayBase } = await import('./db.mjs');
  try {
    if (await aplicarEsquema()) console.log('Base del dashboard: esquema aplicado');
  } catch (e) {
    console.error('No pude aplicar el esquema de la base del dashboard:', e.message);
  }

  // El bot de WhatsApp vive aquí mismo y guarda su sesión en esa base: sin ella no hay dónde
  // recordar el teléfono vinculado, y el resto sigue igual.
  if (!hayBase) {
    console.warn('WhatsApp desactivado, falta APP_DATABASE_URL');
  } else {
    const { arrancarWhatsapp } = await import('./whatsapp.mjs');
    const { mountWaAdmin } = await import('./wa-admin.mjs');
    try {
      console.log(`WhatsApp: reconectando ${JSON.stringify(await arrancarWhatsapp())}`);
    } catch (e) {
      console.error('No pude reconectar WhatsApp:', e.message);
    }
    mountWaAdmin(app, requireSession); // la pantalla "Integración WA" del panel
    const { mountN8n } = await import('./n8n.mjs');
    mountN8n(app); // /evo: n8n envía mensajes con el nodo de Evolution API
  }

  const { mountAjustes } = await import('./ajustes.mjs');
  const { cargar } = await import('./proveedores.mjs');
  console.log(`Contesta: ${JSON.stringify(await cargar())}`); // lo guardado manda desde el primer turno
  mountAjustes(app, soloAdmin); // la pantalla "Ajustes" del panel
  const { mountAdmin } = await import('./admin.mjs');
  mountAdmin(app, soloAdmin); // Ajustes → Usuarios: usuarios con contraseña
  const { mountReportes } = await import('./reportes.mjs');
  mountReportes(app, requireSession); // la pestaña "Reporte": páginas fijas, incrustadas o servidas

  app.get('/favicon.ico', (_req, res) => res.sendFile(page('favicon.ico')));
  // Logos de los proveedores. Lista cerrada de archivos: nada que venga del navegador toca el disco.
  const LOGOS = new Set(['anthropic.png', 'openai.png', 'openai-claro.png']);
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
