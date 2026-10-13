// Usuarios con contraseña: la gente del cliente, que no tiene cuenta de Google del equipo. Los crea
// un administrador en la pestaña Admin. Port de src/auth/{password,users,rateLimit}.ts de Zebra
// Reports, al estilo de este repo: scrypt de la stdlib, sin dependencias.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { consulta, hayBase } from './db.mjs';

// ── Contraseñas ─────────────────────────────────────────────────────────────
// Formato autodescriptivo: scrypt$N$r$p$<salt>$<hash>. Subir el costo después no invalida los viejos.
const N = 16384, R = 8, P = 1, LARGO = 64;

export function hashear(contrasena) {
  const sal = randomBytes(16);
  const hash = scryptSync(contrasena, sal, LARGO, { N, r: R, p: P });
  return ['scrypt', N, R, P, sal.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Nunca lanza: un hash corrupto es simplemente una contraseña que no coincide. */
export function verificar(contrasena, guardado) {
  try {
    const [algo, n, r, p, sal64, hash64] = String(guardado).split('$');
    if (algo !== 'scrypt') return false;
    const sal = Buffer.from(sal64, 'base64url');
    const esperado = Buffer.from(hash64, 'base64url');
    if (!sal.length || !esperado.length) return false;
    const obtenido = scryptSync(String(contrasena), sal, esperado.length, { N: +n, r: +r, p: +p });
    return timingSafeEqual(obtenido, esperado);
  } catch {
    return false;
  }
}

// Sin 0/O, 1/l/I: la contraseña temporal se dicta o se copia de un mensaje.
const LEGIBLES = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function contrasenaTemporal(largo = 14) {
  const bytes = randomBytes(largo);
  return [...bytes].map((b) => LEGIBLES[b % LEGIBLES.length]).join('');
}

export const MINIMO = 10;
export const correoValido = (c) => typeof c === 'string' && c.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim());
const norm = (c) => String(c).trim().toLowerCase();

// ── Freno de intentos ───────────────────────────────────────────────────────
// ponytail: en memoria del proceso, por correo|IP. Basta con una instancia (que ya es obligatorio
// por WhatsApp); con réplicas iría a Postgres.
export class Freno {
  constructor({ maximo = 5, ventanaMs = 15 * 60 * 1000, ahora = Date.now } = {}) {
    Object.assign(this, { maximo, ventanaMs, ahora, golpes: new Map() });
  }
  /** true si este intento está permitido (y lo cuenta). */
  permitido(clave) {
    const t = this.ahora();
    const e = this.golpes.get(clave);
    if (!e || t >= e.hasta) {
      this.golpes.set(clave, { n: 1, hasta: t + this.ventanaMs });
      if (this.golpes.size > 10_000) for (const [k, v] of this.golpes) if (t >= v.hasta) this.golpes.delete(k);
      return true;
    }
    e.n += 1;
    return e.n <= this.maximo;
  }
  limpiar(clave) { this.golpes.delete(clave); }
}
export const frenoLogin = new Freno();

// ── La tabla ────────────────────────────────────────────────────────────────
export const hayUsuarios = () => hayBase;

const COLUMNAS = 'email, nombre, hash, activo, v, creado, por';

export async function buscar(email) {
  if (!hayBase) return null;
  const { rows } = await consulta(`select ${COLUMNAS} from usuarios where email = $1`, [norm(email)]);
  return rows[0] ?? null;
}

/** Para el panel: nunca el hash. */
export async function listar() {
  const { rows } = await consulta('select email, nombre, activo, creado, por from usuarios order by creado');
  return rows;
}

/** Crea un usuario con contraseña temporal. Devuelve la temporal: se muestra una sola vez. */
export async function crear({ email, nombre = '' }, por = null) {
  if (!correoValido(email)) throw new Error('Ese correo no es válido.');
  if (typeof nombre !== 'string' || nombre.length > 80) throw new Error('El nombre admite hasta 80 caracteres.');
  const temporal = contrasenaTemporal();
  const { rowCount } = await consulta(
    `insert into usuarios (email, nombre, hash, por) values ($1, $2, $3, $4) on conflict (email) do nothing`,
    [norm(email), nombre.trim(), hashear(temporal), por]);
  if (!rowCount) throw new Error('Ya existe un usuario con ese correo.');
  return temporal;
}

/** Nueva contraseña temporal; sube `v`, así que saca de todas sus sesiones. */
export async function resetear(email) {
  const temporal = contrasenaTemporal();
  const { rowCount } = await consulta('update usuarios set hash = $2, v = v + 1 where email = $1', [norm(email), hashear(temporal)]);
  if (!rowCount) throw new Error('Ese usuario no existe.');
  cache.delete(norm(email));
  return temporal;
}

/** Desactivar también sube `v`: el usuario sale en menos de un minuto. */
export async function activar(email, activo) {
  const { rowCount } = await consulta('update usuarios set activo = $2, v = v + 1 where email = $1', [norm(email), Boolean(activo)]);
  if (!rowCount) throw new Error('Ese usuario no existe.');
  cache.delete(norm(email));
}

export async function borrar(email) {
  const { rowCount } = await consulta('delete from usuarios where email = $1', [norm(email)]);
  cache.delete(norm(email));
  return rowCount > 0;
}

/** El propio usuario cambia su contraseña. Devuelve la `v` nueva para renovar su cookie. */
export async function cambiarContrasena(email, actual, nueva) {
  if (typeof nueva !== 'string' || nueva.length < MINIMO) throw new Error(`La contraseña nueva necesita al menos ${MINIMO} caracteres.`);
  if (nueva.length > 200) throw new Error('Esa contraseña es demasiado larga.');
  const u = await buscar(email);
  if (!u || !u.activo || !verificar(actual, u.hash)) throw new Error('La contraseña actual no es correcta.');
  const { rows } = await consulta('update usuarios set hash = $2, v = v + 1 where email = $1 returning v', [u.email, hashear(nueva)]);
  cache.delete(u.email);
  return rows[0].v;
}

/** Login por contraseña: el usuario si todo coincide, null si no (sin decir qué falló). */
export async function autenticar(email, contrasena) {
  if (!correoValido(email) || typeof contrasena !== 'string' || !contrasena) return null;
  const u = await buscar(email);
  return u && u.activo && verificar(contrasena, u.hash) ? u : null;
}

// ── Revocación ──────────────────────────────────────────────────────────────
// La cookie lleva la `v` del usuario. Si en la base cambió (reseteo, cambio de contraseña) o está
// desactivado, la sesión deja de valer. Caché de 60 s para no ir a la base en cada petición.
const CACHE_MS = 60_000;
const cache = new Map();

export async function sesionVigente(email, v) {
  const clave = norm(email);
  const hit = cache.get(clave);
  let u;
  if (hit && Date.now() - hit.at < CACHE_MS) u = hit.u;
  else {
    u = await buscar(clave).catch(() => null);
    cache.set(clave, { u, at: Date.now() });
  }
  return Boolean(u && u.activo && u.v === (v ?? 0));
}
