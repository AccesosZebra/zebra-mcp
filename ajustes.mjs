// El bloque "Inteligencia artificial" de Ajustes: qué clave y qué modelo contestan, las claves con
// nombre que hay, y el cambio. Guardar surte efecto de inmediato, también en WhatsApp: el turno
// siguiente ya usa lo elegido. Las claves entran por aquí pero nunca salen: solo de dónde vienen y
// cómo terminan.
import { hayBase } from './db.mjs';
import { PROVEEDORES, activo, claves, editarClave, falloActual, guardar, guardarClave, modelosDisponibles, probarClave, quitarClave } from './proveedores.mjs';

export function mountAjustes(app, soloAdmin) {
  app.get('/api/settings', soloAdmin, async (_req, res) => {
    res.json({
      activo: activo(),
      hayBase,
      proveedores: Object.fromEntries(Object.entries(PROVEEDORES).map(([id, p]) => [id, { nombre: p.nombre, logo: p.logo, nota: p.nota, consola: p.consola }])),
      claves: claves(),
      modelos: await modelosDisponibles(),
      fallo: falloActual(),
    });
  });

  app.post('/api/settings', soloAdmin, async (req, res) => {
    const { clave, modelo } = req.body ?? {};
    try {
      const elegido = await guardar({ clave, modelo }, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'elegir', clave: elegido.nombre, proveedor: elegido.proveedor, modelo: elegido.modelo }));
      res.json({ activo: elegido });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // La clave se prueba contra el proveedor antes de guardarla. En el log va quién y su nombre, nunca cuál.
  app.put('/api/settings/clave', soloAdmin, async (req, res) => {
    const { nombre, proveedor, clave } = req.body ?? {};
    try {
      const nueva = await guardarClave({ nombre, proveedor, clave }, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'añadir clave', nombre: nueva.nombre, proveedor, fin: nueva.fin }));
      res.json({ clave: nueva });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Nombre, clave o ambos. Una clave nueva se prueba antes de guardarla.
  app.patch('/api/settings/clave/:id', soloAdmin, async (req, res) => {
    const { nombre, clave } = req.body ?? {};
    try {
      const editada = await editarClave(req.params.id, { nombre, clave }, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'editar clave', nombre: editada.nombre, clave: Boolean(clave), fin: editada.fin }));
      res.json({ clave: editada });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ¿Funciona? Solo pregunta; no cambia nada.
  app.post('/api/settings/clave/:id/probar', soloAdmin, async (req, res) => {
    try {
      res.json(await probarClave(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/settings/clave/:id', soloAdmin, async (req, res) => {
    try {
      await quitarClave(req.params.id, req.user.email);
      console.log(JSON.stringify({ ajustes: req.user.email, accion: 'quitar clave', id: req.params.id }));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
