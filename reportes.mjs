// La pestaña "Reporte": páginas de otros sistemas que se ven dentro del panel. Dos modos:
// - incrustar: un iframe con la URL tal cual. Sirve para cualquier página que se deje incrustar.
// - interno:   el panel la pide por la red interna y la sirve en /reportes/<id>/, detrás de su login.
//              Para apps de la misma VPS que no deberían estar públicas (p. ej. postgres_reportes:3000).
// Rama cancun: una sola instancia, así que la lista va fija en el código y no se edita desde el panel.
// El id es el que tenía guardado en Ajustes, para que /reportes/<id>/ no cambie.
export const REPORTES = [
  { id: 'nI7LSL67', nombre: 'Cancún Country Club', url: 'http://postgres_reportes:3000/', modo: 'interno' },
];

/** Lo que ve el navegador: para los internos, la ruta del panel; nunca la dirección interna. */
export const publico = (r) => ({ id: r.id, nombre: r.nombre, modo: r.modo, src: r.modo === 'interno' ? `/reportes/${r.id}/` : r.url });

// Lo que la página servida puede hacer: correr sus scripts y formularios, pero en un origen opaco,
// sin la cookie ni la API del panel aunque se sirva desde el mismo dominio.
export const SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

/** /reportes/<id>/<resto>: la app interna, pedida por la red de la VPS y servida aislada. */
export function mountReportes(app, requireSession) {
  app.get('/api/reportes', requireSession, (_req, res) => res.json({ reportes: REPORTES.map(publico) }));

  app.get(['/reportes/:id', '/reportes/:id/*resto'], requireSession, async (req, res) => {
    const r = REPORTES.find((x) => x.id === req.params.id && x.modo === 'interno');
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
