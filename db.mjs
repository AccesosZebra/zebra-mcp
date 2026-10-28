// La base del dashboard (servicio zebra-mcp_db): lo que se administra desde el panel.
// No confundir con la base de métricas, que es de solo lectura y vive en DATABASE_URL.
// Sin APP_DATABASE_URL el panel sigue en pie: mandan las variables de entorno y guardar avisa.
import { readFile } from 'node:fs/promises';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import pg from 'pg';

export const hayBase = Boolean(process.env.APP_DATABASE_URL);

let pool;
function db() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL, max: 3 });
    pool.on('error', (e) => console.error('pool dashboard:', e.message));
  }
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

/** Una consulta cualquiera a la base del dashboard, para módulos con tablas propias (usuarios). */
export async function consulta(texto, params = []) {
  exigirBase();
  return db().query(texto, params);
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
  const { rows } = await db().query('select instancia, etiqueta, creado, vencida, api_fin, api_creada, n8n_pausa, n8n_pausa_motivo from wa_numeros order by creado');
  return rows;
}

/** Borra el número, sus grupos y su sesión (wa_sesion cae en cascada). Dice si existía. */
export async function borrarNumero(instancia) {
  exigirBase();
  // Las dos en una sola sentencia: o se va todo, o no se va nada.
  const { rowCount } = await db().query(
    `with g as (delete from wa_grupos where instancia = $1)
     delete from wa_numeros where instancia = $1`, [instancia]);
  return rowCount > 0;
}

export async function agregarNumero({ instancia, etiqueta = null, por = null }) {
  exigirBase();
  await db().query(
    `insert into wa_numeros (instancia, etiqueta, por) values ($1, $2, $3)
       on conflict (instancia) do update set etiqueta = excluded.etiqueta`,
    [instancia, etiqueta, por]);
}

// ── La clave de n8n de cada número ──────────────────────────────────────────
/** Guarda (o reemplaza) la clave de un número: solo su hash y sus últimos 4. */
export async function ponerClaveApi(instancia, hash, fin) {
  exigirBase();
  const { rowCount } = await db().query(
    'update wa_numeros set api_hash = $2, api_fin = $3, api_creada = now() where instancia = $1', [instancia, hash, fin]);
  return rowCount > 0;
}

export async function quitarClaveApi(instancia) {
  exigirBase();
  await db().query('update wa_numeros set api_hash = null, api_fin = null, api_creada = null where instancia = $1', [instancia]);
}

/** El número con esa instancia y su hash, para validar la clave que manda n8n. */
export async function claveApiDe(instancia) {
  if (!hayBase) return null;
  const { rows } = await db().query('select instancia, etiqueta, api_hash, n8n_pausa, n8n_pausa_motivo from wa_numeros where instancia = $1', [instancia]);
  return rows[0] ?? null;
}

/** El número dueño de una clave: n8n la prueba con /instance/fetchInstances, que no dice cuál. */
export async function numeroPorClave(hash) {
  if (!hayBase) return null;
  const { rows } = await db().query('select instancia, etiqueta from wa_numeros where api_hash = $1', [hash]);
  return rows[0] ?? null;
}

/** Kill switch de n8n: pausa los envíos de un número (o los reanuda). */
export async function pausarN8n(instancia, motivo) {
  exigirBase();
  await db().query('update wa_numeros set n8n_pausa = now(), n8n_pausa_motivo = $2 where instancia = $1 and n8n_pausa is null', [instancia, motivo]);
}

export async function reanudarN8n(instancia) {
  exigirBase();
  await db().query('update wa_numeros set n8n_pausa = null, n8n_pausa_motivo = null where instancia = $1', [instancia]);
}

/** Anota (o borra, con null) cuándo WhatsApp cerró la sesión de un número por su cuenta. */
export async function marcarVencida(instancia, cuando) {
  exigirBase();
  await db().query('update wa_numeros set vencida = $2 where instancia = $1', [instancia, cuando]);
}

/** Los grupos donde contesta un número: jid → cliente. El mismo Map que se usaba con el entorno. */
export async function grupos(instancia) {
  if (!hayBase) return new Map();
  const { rows } = await db().query('select jid, cliente from wa_grupos where instancia = $1', [instancia]);
  return new Map(rows.map((r) => [r.jid, r.cliente]));
}

/** Para el panel: los grupos vinculados con su nombre, del más viejo al más nuevo. */
export async function gruposVinculados(instancia) {
  if (!hayBase) return [];
  const { rows } = await db().query('select jid, nombre, cliente from wa_grupos where instancia = $1 order by creado', [instancia]);
  return rows;
}

export async function ponerGrupo({ jid, nombre = null, cliente = null, instancia, por = null }) {
  exigirBase();
  await db().query(
    `insert into wa_grupos (jid, nombre, cliente, instancia, por) values ($1, $2, $3, $4, $5)
       on conflict (jid) do update set nombre = excluded.nombre, cliente = excluded.cliente, instancia = excluded.instancia, por = excluded.por`,
    [jid, nombre, cliente, instancia, por]);
}

export async function quitarGrupo(jid) {
  exigirBase();
  const { rowCount } = await db().query('delete from wa_grupos where jid = $1', [jid]);
  return rowCount > 0;
}

// ── WhatsApp: la sesión de cada número ──────────────────────────────────────
// Lo que Baileys guardaría en una carpeta, aquí en una tabla: las llaves sobreviven al despliegue
// sin montar volúmenes. Las llaves son Buffers, así que todo pasa por BufferJSON al guardar y leer.

const aJson = (v) => JSON.stringify(v, BufferJSON.replacer);
const deJson = (t) => JSON.parse(t, BufferJSON.reviver);

/** El mismo contrato que useMultiFileAuthState de Baileys, contra la tabla wa_sesion. */
export async function estadoAuth(instancia) {
  exigirBase();
  const { rows } = await db().query(
    "select valor::text as v from wa_sesion where instancia = $1 and clave = 'creds'", [instancia]);
  const creds = rows[0] ? deJson(rows[0].v) : initAuthCreds();

  const keys = {
    async get(tipo, ids) {
      const { rows: filas } = await db().query(
        'select clave, valor::text as v from wa_sesion where instancia = $1 and clave = any($2)',
        [instancia, ids.map((id) => `${tipo}-${id}`)]);
      const porClave = new Map(filas.map((f) => [f.clave, deJson(f.v)]));
      const salida = {};
      for (const id of ids) {
        let valor = porClave.get(`${tipo}-${id}`) ?? null;
        if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
        salida[id] = valor;
      }
      return salida;
    },
    async set(datos) {
      for (const tipo in datos) {
        for (const id in datos[tipo]) {
          const valor = datos[tipo][id];
          await (valor ? guardarClave(instancia, `${tipo}-${id}`, valor)
            : db().query('delete from wa_sesion where instancia = $1 and clave = $2', [instancia, `${tipo}-${id}`]));
        }
      }
    },
  };
  return { state: { creds, keys }, saveCreds: () => guardarClave(instancia, 'creds', creds) };
}

function guardarClave(instancia, clave, valor) {
  return db().query(
    `insert into wa_sesion (instancia, clave, valor) values ($1, $2, $3::jsonb)
       on conflict (instancia, clave) do update set valor = excluded.valor`,
    [instancia, clave, aJson(valor)]);
}

/** Olvida el dispositivo vinculado: al desvincular o cuando WhatsApp cierra la sesión. */
export async function borrarSesion(instancia) {
  exigirBase();
  await db().query('delete from wa_sesion where instancia = $1', [instancia]);
}

/** Los números que ya estaban vinculados, para reconectarlos al arrancar sin QR. */
export async function conSesion() {
  if (!hayBase) return [];
  // Baileys guarda creds desde que muestra el primer QR; 'me' solo aparece al escanearlo.
  const { rows } = await db().query("select instancia from wa_sesion where clave = 'creds' and valor ? 'me'");
  return rows.map((r) => r.instancia);
}

/** Crea o completa las tablas. Así la base nueva de cada cliente queda lista sin pasos a mano. */
export async function aplicarEsquema() {
  if (!hayBase) return false;
  await db().query(await readFile(new URL('./app-schema.sql', import.meta.url), 'utf8'));
  return true;
}
