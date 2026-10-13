// La pantalla "Ajustes": qué proveedor y modelo están activos, cuáles hay disponibles, el cambio, y
// las claves de API. Guardar surte efecto de inmediato, también en WhatsApp: el turno siguiente ya
// usa lo elegido. Las claves entran por aquí pero nunca salen: solo de dónde vienen y cómo terminan.
import { hayBase } from './db.mjs';
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
    });
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
