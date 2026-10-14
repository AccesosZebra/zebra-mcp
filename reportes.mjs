// La pestaña "Reporte": páginas de otros sistemas que se ven dentro del panel. Dos modos:
// - incrustar: un iframe con la URL tal cual. Sirve para cualquier página que se deje incrustar.
// - interno:   el panel la pide por la red interna y la sirve en /reportes/<id>/, detrás de su login.
//              Para apps de la misma VPS que no deberían estar públicas (p. ej. postgres_reportes:3000).
// Se configuran en Ajustes (solo administradores) y se guardan en la tabla ajustes, clave "reportes".
import { randomBytes } from 'node:crypto';

import { guardarAjuste, leerAjuste } from './db.mjs';

export const MODOS = ['incrustar', 'interno'];
export const MAXIMO = 12;

let lista = [];
export async function cargarReportes() {
  try { lista = (await leerAjuste('reportes')) ?? []; }
  catch (e) { console.error('reportes: no pude leer la base:', e.message); }
  return lista;
}
export const reportes = () => lista;

/** Lo que manda el panel, limpio; o una excepción en cristiano. */
export function validarReporte({ nombre, url, modo } = {}) {
  const n = typeof nombre === 'string' ? nombre.trim() : '';
  if (!n || n.length > 60) throw new Error('Ponle un nombre de hasta 60 caracteres.');
  if (!MODOS.includes(modo)) throw new Error('Elige cómo se muestra.');
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { throw new Error('Esa URL no es válida.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('La URL tiene que empezar con http:// o https://.');
  if (u.username || u.password) throw new Error('No pongas usuario ni contraseña dentro de la URL.');
  // Incrustada, la página la carga el navegador del usuario: si no es https, el navegador la bloquea.
  if (modo === 'incrustar' && u.protocol !== 'https:') throw new Error('Para incrustar, la URL tiene que ser https://.');
  return { nombre: n, url: u.href, modo };
}

/**
 * ¿Se deja incrustar? Lo dicen X-Frame-Options y el frame-ancestors de su CSP. Devuelve un aviso en
 * cristiano, o null si no hay nada que avisar. Un error de red también es un aviso, no un bloqueo.
 */
export function avisoDeIncrustar(cabeceras) {
  const xfo = (cabeceras.get('x-frame-options') ?? '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return 'Esa página no permite que la incrusten (X-Frame-Options): se verá en blanco.';
  const fa = /frame-ancestors([^;]*)/i.exec(cabeceras.get('content-security-policy') ?? '')?.[1]?.trim();
  if (fa && !/(^|\s)\*(\s|$)/.test(fa)) return `Esa página solo deja que la incrusten ${fa === "'none'" ? 'nadie' : fa}: probablemente se verá en blanco.`;
  return null;
}

async function probar({ url, modo }, pedir = fetch) {
  let res;
  try { res = await pedir(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) }); }
  catch (e) { return modo === 'interno' ? `El panel no pudo abrir esa dirección: ${e.cause?.code ?? e.message}.` : null; }
  if (modo === 'interno') {
    if (!res.ok) return `Esa dirección respondió ${res.status}: el reporte se verá con ese error hasta que lo arreglen.`;
    return null;
  }
  return avisoDeIncrustar(res.headers);
}

export async function agregarReporte(datos, por = null, pedir = fetch) {
  const r = validarReporte(datos);
  if (lista.length >= MAXIMO) throw new Error(`Caben hasta ${MAXIMO} reportes.`);
  const nuevo = { id: randomBytes(6).toString('base64url'), ...r, por, creado: new Date().toISOString() };
  const aviso = await probar(r, pedir);
  const siguiente = [...lista, nuevo];
  await guardarAjuste('reportes', siguiente, por);
  lista = siguiente;
  return { reporte: nuevo, aviso };
}

export async function quitarReporte(id, por = null) {
  const siguiente = lista.filter((r) => r.id !== id);
  if (siguiente.length === lista.length) throw new Error('Ese reporte no existe.');
  await guardarAjuste('reportes', siguiente, por);
  lista = siguiente;
}

/** Lo que ve el navegador: para los internos, la ruta del panel; nunca la dirección interna. */
export const publico = (r) => ({ id: r.id, nombre: r.nombre, modo: r.modo, src: r.modo === 'interno' ? `/reportes/${r.id}/` : r.url });

// Lo que la página servida puede hacer: correr sus scripts y formularios, pero en un origen opaco,
// sin la cookie ni la API del panel aunque se sirva desde el mismo dominio.
export const SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

/** /reportes/<id>/<resto>: la app interna, pedida por la red de la VPS y servida aislada. */
export function mountReportes(app, requireSession, soloAdmin) {
  app.get('/api/reportes', requireSession, (_req, res) => res.json({ reportes: lista.map(publico) }));

  app.get('/api/reportes/admin', soloAdmin, (_req, res) => res.json({ reportes: lista, modos: MODOS, maximo: MAXIMO }));

  app.post('/api/reportes', soloAdmin, async (req, res) => {
    try {
      const r = await agregarReporte(req.body ?? {}, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'añadir reporte', nombre: r.reporte.nombre, modo: r.reporte.modo }));
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/reportes/:id', soloAdmin, async (req, res) => {
    try {
      await quitarReporte(req.params.id, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'quitar reporte', id: req.params.id }));
      res.json({ ok: true });
    } catch (e) { res.status(404).json({ error: e.message }); }
  });

  app.get(['/reportes/:id', '/reportes/:id/*resto'], requireSession, async (req, res) => {
    const r = lista.find((x) => x.id === req.params.id && x.modo === 'interno');
    if (!r) return res.status(404).send('Ese reporte no existe.');
    // Sin la barra final, las rutas relativas de la página apuntarían fuera de su carpeta.
    if (!req.params.resto && !req.path.endsWith('/')) return res.redirect(301, `/reportes/${r.id}/`);
    const resto = [].concat(req.params.resto ?? []).join('/');
    const destino = new URL(resto, r.url.endsWith('/') ? r.url : `${r.url}/`);
    for (const [k, v] of Object.entries(req.query)) destino.searchParams.set(k, String(v));
    // Solo se puede bajar dentro de la dirección configurada, nunca subir ni salir de ella.
    if (!destino.href.startsWith(r.url.endsWith('/') ? r.url : `${r.url}/`) && destino.href !== r.url) return res.status(400).send('Ruta no válida.');
    try {
      // Nada del usuario viaja a la app interna: ni cookies, ni la sesión, ni su IP.
      const up = await fetch(destino, { headers: { accept: req.get('accept') ?? '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      res.status(up.status);
      for (const h of ['content-type', 'last-modified', 'etag']) if (up.headers.get(h)) res.set(h, up.headers.get(h));
      res.set({ 'Content-Security-Policy': `sandbox ${SANDBOX}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.send(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      console.error(`reporte ${r.id}:`, e.cause?.code ?? e.message);
      res.status(502).send('No se pudo cargar el reporte. Intenta en un momento.');
    }
  });
}
