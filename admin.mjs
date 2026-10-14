// La pestaña "Admin": los usuarios con contraseña (la gente del cliente). La usan Zebra y los
// usuarios del cliente con rol "admin", igual que Ajustes. Las contraseñas temporales se devuelven una sola vez, al
// crear o resetear; nunca se guardan ni van al log.
import { allowedDomains } from './auth.mjs';
import { activar, borrar, cambiarRol, crear, hayUsuarios, listar, resetear, ROLES } from './usuarios.mjs';

// Nadie se quita a sí mismo el rol, el acceso o la cuenta: así siempre queda un administrador que
// pueda deshacerlo. Si aun así se pierde, Zebra entra con Google y lo arregla.
export function sobreSiMismo(req, email) {
  if (String(email).trim().toLowerCase() === req.user.email) throw new Error('No puedes cambiar tu propio rol, desactivarte ni borrarte. Pídeselo a otro administrador.');
}

export function mountAdmin(app, soloAdmin) {
  const log = (req, accion, extra = {}) => console.log(JSON.stringify({ admin: req.user.email, accion, ...extra }));
  const enBase = (fn) => async (req, res) => {
    if (!hayUsuarios()) return res.status(503).json({ error: 'Para crear usuarios hace falta la base del dashboard (APP_DATABASE_URL).' });
    try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
  };

  app.get('/api/usuarios', soloAdmin, async (req, res) => {
    res.json({ usuarios: hayUsuarios() ? await listar() : [], dominios: allowedDomains(), hayBase: hayUsuarios(), roles: ROLES, yo: req.user.email });
  });

  app.post('/api/usuarios', soloAdmin, enBase(async (req, res) => {
    const { email, nombre, rol } = req.body ?? {};
    const temporal = await crear({ email, nombre, rol }, req.user.email);
    log(req, 'crear usuario', { usuario: String(email).trim().toLowerCase(), rol: rol ?? 'usuario' });
    res.json({ temporal });
  }));

  // Una sola ruta para lo que se le hace a un usuario existente: rol, activar/desactivar o resetear.
  app.patch('/api/usuarios/:email', soloAdmin, enBase(async (req, res) => {
    const { email } = req.params;
    const { activo, rol, resetear: reset } = req.body ?? {};
    if (reset) {
      const temporal = await resetear(email);
      log(req, 'resetear contraseña', { usuario: email });
      return res.json({ temporal });
    }
    if (rol !== undefined) {
      sobreSiMismo(req, email);
      await cambiarRol(email, rol);
      log(req, 'cambiar rol', { usuario: email, rol });
      return res.json({ ok: true });
    }
    if (typeof activo !== 'boolean') return res.status(400).json({ error: 'No se indicó qué cambiar.' });
    if (!activo) sobreSiMismo(req, email);
    await activar(email, activo);
    log(req, activo ? 'activar usuario' : 'desactivar usuario', { usuario: email });
    res.json({ ok: true });
  }));

  app.delete('/api/usuarios/:email', soloAdmin, enBase(async (req, res) => {
    sobreSiMismo(req, req.params.email);
    const borrado = await borrar(req.params.email);
    log(req, 'borrar usuario', { usuario: req.params.email, borrado });
    res.json({ ok: borrado });
  }));
}
