// La pantalla "Ajustes": qué proveedor y modelo están activos, cuáles hay disponibles, y el cambio.
// Guardar surte efecto de inmediato, también en WhatsApp: el turno siguiente ya usa lo elegido.
import { ARCHIVO, PROVEEDORES, activo, guardar, modelosDisponibles } from './proveedores.mjs';

export function mountAjustes(app, requireSession) {
  app.get('/api/settings', requireSession, async (_req, res) => {
    const { proveedor, modelo } = activo();
    res.json({
      activo: { proveedor, modelo },
      archivo: ARCHIVO,
      proveedores: Object.entries(PROVEEDORES).map(([id, p]) => ({
        id,
        nombre: p.nombre,
        logo: p.logo,
        nota: p.nota,
        disponible: p.disponible,
        clave: Boolean(process.env[p.env]), // solo si existe: el valor no sale de aquí
        env: p.env,
      })),
      modelos: await modelosDisponibles(),
    });
  });

  app.post('/api/settings', requireSession, (req, res) => {
    const { proveedor, modelo } = req.body ?? {};
    try {
      const elegido = guardar({ proveedor, modelo });
      console.log(JSON.stringify({ ajustes: req.user.email, ...elegido }));
      res.json({ activo: elegido });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
