// La pantalla "Ajustes": qué proveedor y modelo están activos, y cuáles hay disponibles.
// La elección vive en variables de entorno (decisión de Carlos), así que esta pantalla no la
// cambia por sí sola: prepara las dos líneas para pegar en EasyPanel y desplegar.
import { PROVEEDORES, activo, modelosDisponibles } from './proveedores.mjs';

export function mountAjustes(app, requireSession) {
  app.get('/api/settings', requireSession, async (_req, res) => {
    const { proveedor, modelo } = activo();
    res.json({
      activo: { proveedor, modelo },
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
}
