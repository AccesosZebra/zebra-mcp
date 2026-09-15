// La base del dashboard (servicio zebra-mcp_db): lo que se administra desde el panel.
// No confundir con la base de métricas, que es de solo lectura y vive en DATABASE_URL.
// Sin APP_DATABASE_URL el panel sigue en pie: mandan las variables de entorno y guardar avisa.
import pg from 'pg';

export const hayBase = Boolean(process.env.APP_DATABASE_URL);

let pool;
function db() {
  pool ??= new pg.Pool({ connectionString: process.env.APP_DATABASE_URL, max: 3 });
  pool.on('error', (e) => console.error('pool dashboard:', e.message));
  return pool;
}

/** El valor de un ajuste, o null si no está guardado o no hay base. */
export async function leerAjuste(clave) {
  if (!hayBase) return null;
  const { rows } = await db().query('select valor from ajustes where clave = $1', [clave]);
  return rows[0]?.valor ?? null;
}

function exigirBase() {
  if (!hayBase) throw new Error('Falta APP_DATABASE_URL: todavía no hay dónde guardar.');
}

/** Guarda un ajuste, pisando el anterior. Deja constancia de quién lo cambió. */
export async function guardarAjuste(clave, valor, por = null) {
  exigirBase();
  await db().query(
    `insert into ajustes (clave, valor, por) values ($1, $2, $3)
       on conflict (clave) do update set valor = excluded.valor, actualizado = now(), por = excluded.por`,
    [clave, JSON.stringify(valor), por]);
}

// ── WhatsApp: números y grupos ──────────────────────────────────────────────
// Se consulta en cada mensaje entrante, sin caché, para que lo que se cambie en el panel valga
// desde el siguiente mensaje. Son consultas por clave primaria o por índice.
// ponytail: si el volumen lo justificara, caché en memoria invalidada al escribir.

/** Los números configurados, del más viejo al más nuevo. */
export async function numeros() {
  if (!hayBase) return [];
  const { rows } = await db().query('select instancia, etiqueta, creado from wa_numeros order by creado');
  return rows;
}

export async function agregarNumero({ instancia, etiqueta = null, por = null }) {
  exigirBase();
  await db().query(
    `insert into wa_numeros (instancia, etiqueta, por) values ($1, $2, $3)
       on conflict (instancia) do update set etiqueta = excluded.etiqueta`,
    [instancia, etiqueta, por]);
}

/** Los grupos donde contesta un número: jid → cliente. El mismo Map que se usaba con el entorno. */
export async function grupos(instancia) {
  if (!hayBase) return new Map();
  const { rows } = await db().query('select jid, cliente from wa_grupos where instancia = $1', [instancia]);
  return new Map(rows.map((r) => [r.jid, r.cliente]));
}

export async function ponerGrupo({ jid, cliente = null, instancia, por = null }) {
  exigirBase();
  await db().query(
    `insert into wa_grupos (jid, cliente, instancia, por) values ($1, $2, $3, $4)
       on conflict (jid) do update set cliente = excluded.cliente, instancia = excluded.instancia, por = excluded.por`,
    [jid, cliente, instancia, por]);
}

export async function quitarGrupo(jid) {
  exigirBase();
  const { rowCount } = await db().query('delete from wa_grupos where jid = $1', [jid]);
  return rowCount > 0;
}

/**
 * Migración de una sola vez: si no hay ningún número guardado, se meten el de la variable de
 * entorno y sus grupos. Así el primer despliegue no interrumpe al bot que ya está contestando.
 * Devuelve null si no había nada que sembrar.
 */
export async function sembrar({ instancia, grupos: lista }) {
  if (!hayBase || !instancia) return null;
  const { rows } = await db().query('select count(*)::int as n from wa_numeros');
  if (rows[0].n > 0) return null;

  await db().query('insert into wa_numeros (instancia, etiqueta, por) values ($1, $1, $2)', [instancia, 'semilla']);
  for (const [jid, cliente] of lista ?? []) {
    await db().query(
      `insert into wa_grupos (jid, cliente, instancia, por) values ($1, $2, $3, 'semilla')
         on conflict (jid) do nothing`,
      [jid, cliente, instancia]);
  }
  return { instancia, grupos: lista?.size ?? 0 };
}
