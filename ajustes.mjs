// La pantalla "Ajustes": qué proveedor y modelo están activos, cuáles hay disponibles, el cambio, y
// las claves de API. Guardar surte efecto de inmediato, también en WhatsApp: el turno siguiente ya
// usa lo elegido. Las claves entran por aquí pero nunca salen: solo de dónde vienen y cómo terminan.
import { hayBase } from './db.mjs';
import { GUIA_GENERICA, LIMITES, aplicarPermisos, borrador, conteos, contextoActual, guardarContexto, hayAdmin, nombreLector } from './guia.mjs';
import { PROVEEDORES, activo, estadoClave, guardar, guardarClave, modelosDisponibles, quitarClave } from './proveedores.mjs';

export function mountAjustes(app, requireSession) {
  app.get('/api/settings', requireSession, async (_req, res) => {
    const { proveedor, modelo } = activo();
    res.json({
      activo: { proveedor, modelo },
      hayBase,
      proveedores: Object.entries(PROVEEDORES).map(([id, p]) => ({
        id,
        nombre: p.nombre,
        logo: p.logo,
        nota: p.nota,
        consola: p.consola,
        env: p.env,
        clave: estadoClave(id),
      })),
      modelos: await modelosDisponibles(),
      contexto: { ...(contextoActual() ?? {}), generica: GUIA_GENERICA, limites: LIMITES },
      permisos: { hayAdmin: hayAdmin(), rol: nombreLector(), ve: await conteos().catch((e) => ({ error: e.message })) },
    });
  });

  // Quién es el negocio y cómo es su base. Vale desde la pregunta siguiente, sin reiniciar.
  app.put('/api/settings/contexto', requireSession, async (req, res) => {
    try {
      const guardado = await guardarContexto(req.body ?? {}, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'contexto', nombre: guardado.nombre, guia: guardado.guia.length }));
      res.json({ contexto: guardado });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Recorre la base y el modelo redacta una guía. No guarda nada: se revisa en el panel.
  app.post('/api/settings/guia/borrador', requireSession, async (req, res) => {
    const t0 = Date.now();
    try {
      const texto = await borrador();
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'borrador de guía', ms: Date.now() - t0, largo: texto.length }));
      res.json({ borrador: texto });
    } catch (e) {
      console.error('borrador de guía:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/api/settings/permisos', requireSession, async (req, res) => {
    try {
      const r = await aplicarPermisos();
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'permisos', ...r }));
      res.json({ ...r, ve: await conteos() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/settings', requireSession, async (req, res) => {
    const { proveedor, modelo } = req.body ?? {};
    try {
      const elegido = await guardar({ proveedor, modelo }, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, ...elegido }));
      res.json({ activo: elegido });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // La clave se prueba contra el proveedor antes de guardarla. En el log va quién, nunca cuál.
  app.put('/api/settings/clave', requireSession, async (req, res) => {
    const { proveedor, clave } = req.body ?? {};
    try {
      const estado = await guardarClave(proveedor, clave, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, clave: proveedor, accion: 'guardar', fin: estado.fin }));
      res.json({ clave: estado });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/settings/clave/:proveedor', requireSession, async (req, res) => {
    try {
      const estado = await quitarClave(req.params.proveedor, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, clave: req.params.proveedor, accion: 'quitar' }));
      res.json({ clave: estado });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
