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

/** Guarda un ajuste, pisando el anterior. Deja constancia de quién lo cambió. */
export async function guardarAjuste(clave, valor, por = null) {
  if (!hayBase) throw new Error('Falta APP_DATABASE_URL: todavía no hay dónde guardar.');
  await db().query(
    `insert into ajustes (clave, valor, por) values ($1, $2, $3)
       on conflict (clave) do update set valor = excluded.valor, actualizado = now(), por = excluded.por`,
    [clave, JSON.stringify(valor), por]);
}
