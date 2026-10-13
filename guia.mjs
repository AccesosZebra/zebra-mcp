// Lo que describe la base de métricas de ESTA instancia: el nombre del negocio, la guía que leen
// las herramientas del MCP y los permisos del rol de lectura. Cada clon tiene su base, parecida
// pero no igual a la de Zebra, así que nada de esto vive en el código: se edita en Ajustes.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

import { guardarAjuste, hayBase, leerAjuste } from './db.mjs';
import { completar } from './proveedores.mjs';

// La guía con la que nació el proyecto. Se siembra sola en la instancia de Zebra (ver sembrarZebra).
export const GUIA_ZEBRA = `Base de métricas de Zebra (Postgres 17, solo lectura).

Responde SOLO con la capa canónica: los esquemas mart, crm, ops y ads. Hoy tiene un solo cliente,
Sofía (cliente_id 'sofia'). Si preguntan por otro cliente, di que todavía no está en la capa
canónica y no lo busques en otros esquemas.

- mart: KPIs ya calculados por cliente_id y fecha. Empieza siempre aquí.
  v_kpi_diario (gasto, leads por fuente, citas, apartados, cierres, valor, llamadas, presupuesto),
  v_kpi_campana_diario y v_cohorte_* (por campaña), v_kpi_asesor_diario (por asesor),
  v_perdida_*, v_presupuesto_mes, v_frescura (qué tan al día están los datos).
- crm: detalle de leads, eventos de etapa y llamadas, para lo que mart no trae agregado.
- ops: clientes, presupuesto, tipo de cambio.
- ads: gasto diario por campaña de Meta y Google.

Los demás esquemas (uno por cliente: "Grupo Gira", "Midstorage", "Zenco Desarrollos"…, y los
"<Cliente>_callpicker") son copias en bruto de hojas de cálculo: no los uses para responder.`;

// Sin guía, el modelo no sabe nada de la base: que explore antes de consultar, y que no adivine.
export const GUIA_GENERICA = `Base de métricas (Postgres, solo lectura). Todavía no hay una guía que la describa:
antes de consultar, revisa list_tables y get_schema. Muchas columnas pueden ser texto aunque guarden
fechas o montos: revisa los valores antes de sumar o filtrar. Si una métrica no es obvia, di qué tabla
y columna usaste para calcularla.`;

export const LIMITES = { nombre: 60, giro: 120, guia: 20_000 };

// ── El contexto guardado ────────────────────────────────────────────────────
// Se lee una vez al arrancar y se recuerda: el MCP lo consulta en cada petición.
let contexto = null; // { nombre, giro, guia, por, actualizado }

export async function cargarContexto() {
  try { contexto = await leerAjuste('contexto'); }
  catch (e) { console.error('contexto: no pude leer la base, sigo con la guía genérica:', e.message); }
  return contexto;
}

export const contextoActual = () => contexto;
export const guiaActual = () => contexto?.guia?.trim() || GUIA_GENERICA;

/** "Zebra, una agencia de marketing", o "este negocio" si nadie lo ha dicho. */
export function quienEs(c = contexto) {
  const nombre = c?.nombre?.trim();
  if (!nombre) return 'este negocio';
  return c.giro?.trim() ? `${nombre}, ${c.giro.trim()}` : nombre;
}

/** Lo que manda el navegador, limpio y dentro de sus topes; o una excepción en cristiano. */
export function validarContexto({ nombre = '', giro = '', guia = '' } = {}) {
  const limpio = {};
  for (const [campo, valor] of Object.entries({ nombre, giro, guia })) {
    if (typeof valor !== 'string') throw new Error(`El campo ${campo} no es válido.`);
    const v = valor.trim();
    if (v.length > LIMITES[campo]) throw new Error(`El campo ${campo} admite hasta ${LIMITES[campo].toLocaleString('es')} caracteres.`);
    limpio[campo] = v;
  }
  return limpio;
}

export async function guardarContexto(datos, por = null) {
  const nuevo = { ...validarContexto(datos), por, actualizado: new Date().toISOString() };
  await guardarAjuste('contexto', nuevo, por);
  contexto = nuevo;
  return nuevo;
}

// ── Lo que ve el rol de lectura ─────────────────────────────────────────────
// Un pool propio y pequeño: estas consultas son de Ajustes, no compiten con las del MCP.
let pool;
function lector() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    pool.on('error', (e) => console.error('pool guía:', e.message));
  }
  return pool;
}

const SISTEMA = "('pg_catalog', 'information_schema')";
const ident = (x) => `"${String(x).replaceAll('"', '""')}"`;

/** Cuántas tablas y vistas ve el bot, para decirlo en el panel. */
export async function conteos() {
  const { rows } = await lector().query(
    `select count(*) filter (where table_type = 'VIEW')::int as vistas,
            count(*) filter (where table_type <> 'VIEW')::int as tablas,
            count(distinct table_schema)::int as esquemas
       from information_schema.tables where table_schema not in ${SISTEMA}`);
  return rows[0];
}

/**
 * Semilla: si nadie ha guardado contexto y esta es la base de Zebra (la única con
 * mart.v_kpi_diario), se guarda la guía de Zebra. Si lo guardado es una semilla anterior que nadie
 * editó, se pone al día; en cuanto alguien guarda desde el panel, ya no se toca. En el clon de un
 * cliente no se siembra nada.
 */
/** La semilla guardada es de una versión anterior y nadie la ha tocado: se puede poner al día. */
export const semillaVieja = (c) => c?.por === 'semilla' && c.guia !== GUIA_ZEBRA;

export async function sembrarZebra() {
  if (!hayBase || (contexto && !semillaVieja(contexto))) return false;
  const { rows } = await lector().query(
    "select 1 from information_schema.tables where table_schema = 'mart' and table_name = 'v_kpi_diario'");
  if (!rows.length) return false;
  await guardarContexto({ nombre: 'Zebra', giro: 'una agencia de marketing', guia: GUIA_ZEBRA }, 'semilla');
  return true;
}

export const TOPES = { objetos: 150, filas: 2, valor: 60, texto: 60_000 };

const recortar = (v) => {
  if (v == null) return null;
  const t = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > TOPES.valor ? `${t.slice(0, TOPES.valor)}…` : t;
};

/** Esquemas, tablas, columnas y un par de filas de ejemplo: la materia prima del borrador. */
export async function inventario() {
  const { rows } = await lector().query(
    `select c.table_schema as s, c.table_name as t, t.table_type as tipo, c.column_name as col, c.data_type as dt
       from information_schema.columns c
       join information_schema.tables t using (table_schema, table_name)
      where c.table_schema not in ${SISTEMA}
      order by 1, 2, c.ordinal_position`);
  const porObjeto = new Map();
  for (const r of rows) {
    const clave = `${r.s}.${r.t}`;
    if (!porObjeto.has(clave)) porObjeto.set(clave, { esquema: r.s, nombre: r.t, vista: r.tipo === 'VIEW', columnas: [], muestras: [] });
    porObjeto.get(clave).columnas.push(`${r.col} ${r.dt}`);
  }
  const todos = [...porObjeto.values()];
  const objetos = todos.slice(0, TOPES.objetos);

  // Las muestras van en una transacción de solo lectura; un SAVEPOINT por consulta para que una
  // vista rota no deje sin muestras a las demás.
  const client = await lector().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    for (const o of objetos) {
      await client.query('SAVEPOINT m');
      try {
        const { rows: filas } = await client.query(`SELECT * FROM ${ident(o.esquema)}.${ident(o.nombre)} LIMIT ${TOPES.filas}`);
        o.muestras = filas.map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, recortar(v)])));
        await client.query('RELEASE SAVEPOINT m');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT m');
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  return { objetos, omitidos: todos.length - objetos.length };
}

/** El inventario en texto, sin pasar del tope: lo que de verdad cabe en una llamada al modelo. */
export function inventarioATexto({ objetos, omitidos = 0 }, tope = TOPES.texto) {
  const partes = [];
  let largo = 0;
  let cortados = omitidos;
  for (const o of objetos) {
    const bloque = [`${ident(o.esquema)}.${ident(o.nombre)} (${o.vista ? 'vista' : 'tabla'}): ${o.columnas.join(', ')}`,
      ...o.muestras.map((m) => `  ejemplo: ${JSON.stringify(m)}`)].join('\n');
    if (largo + bloque.length > tope) { cortados += 1; continue; }
    partes.push(bloque);
    largo += bloque.length + 2;
  }
  if (cortados) partes.push(`(…y ${cortados} objetos más que no caben aquí; siguen el mismo patrón o hay que revisarlos con list_tables.)`);
  return partes.join('\n\n');
}

const INSTRUCCIONES = `Escribes la guía de una base de métricas de solo lectura. La leerá otro modelo que solo
tiene tres herramientas (list_tables, get_schema, query_readonly) y que responde preguntas del equipo:
la guía le dice dónde buscar cada cosa sin tener que explorar toda la base.

Reglas:
- Describe solo lo que aparece en el inventario. No inventes tablas, columnas ni clientes.
- Agrupa: si varios esquemas o tablas siguen un mismo patrón de nombres, descríbelo una vez con <x>.
- Di qué significa cada métrica importante y en qué tabla y columna está (leads, gasto, citas,
  ventas, lo que haya).
- Señala las trampas que veas en los ejemplos: fechas o montos guardados como texto, formatos de
  fecha, moneda, columnas casi siempre vacías.
- Si hay una capa ya agregada y otra en bruto, di cuál preferir.
- Texto plano en español, sin preámbulo ni despedida, máximo 3 500 caracteres.

Este es el estilo esperado, tomado de OTRA base; no copies sus nombres:

${GUIA_ZEBRA}`;

/** Un borrador de guía escrito por el modelo activo. No se guarda: se revisa en el panel. */
export async function borrador() {
  const inv = await inventario();
  if (!inv.objetos.length) throw new Error('El rol de lectura no ve ninguna tabla ni vista. Revisa los permisos.');
  const texto = await completar(INSTRUCCIONES, `Negocio: ${quienEs()}\n\nInventario de la base:\n\n${inventarioATexto(inv)}`);
  if (!texto) throw new Error('El modelo no devolvió ningún texto. Inténtalo de nuevo.');
  return texto.slice(0, LIMITES.guia);
}

// ── Permisos del rol de lectura ─────────────────────────────────────────────
// Solo con METRICAS_ADMIN_URL: una credencial de administrador que se usa para esto y para nada más.
export const hayAdmin = () => Boolean(process.env.METRICAS_ADMIN_URL);

/** El usuario de DATABASE_URL: es el rol al que se le dan los permisos. */
export function nombreLector(url = process.env.DATABASE_URL) {
  try { return decodeURIComponent(new URL(url).username) || null; } catch { return null; }
}

export async function aplicarPermisos() {
  if (!hayAdmin()) throw new Error('Falta METRICAS_ADMIN_URL: sin una conexión de administrador no se pueden dar permisos.');
  const rol = nombreLector();
  if (!rol) throw new Error('No pude sacar el usuario de DATABASE_URL.');
  const sql = await readFile(new URL('./grants.sql', import.meta.url), 'utf8');
  const admin = new pg.Client({ connectionString: process.env.METRICAS_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query("select set_config('zebra.lector', $1, false)", [rol]);
    await admin.query(sql);
    const { rows } = await admin.query(
      `select count(*)::int as objetos, count(distinct table_schema)::int as esquemas
         from information_schema.role_table_grants where grantee = $1 and privilege_type = 'SELECT'`, [rol]);
    return { rol, ...rows[0] };
  } finally {
    await admin.end().catch(() => {});
  }
}
