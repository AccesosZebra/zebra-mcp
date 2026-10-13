// La pestaña "Admin": los usuarios con contraseña (la gente del cliente). Solo administradores.
// Las contraseñas temporales se devuelven una sola vez, al crear o resetear; nunca se guardan ni
// van al log.
import { allowedDomains } from './auth.mjs';
import { activar, borrar, crear, hayUsuarios, listar, resetear } from './usuarios.mjs';

export function mountAdmin(app, soloAdmin) {
  const log = (req, accion, extra = {}) => console.log(JSON.stringify({ admin: req.user.email, accion, ...extra }));
  const enBase = (fn) => async (req, res) => {
    if (!hayUsuarios()) return res.status(503).json({ error: 'Para crear usuarios hace falta la base del dashboard (APP_DATABASE_URL).' });
    try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
  };

  app.get('/api/usuarios', soloAdmin, async (_req, res) => {
    res.json({ usuarios: hayUsuarios() ? await listar() : [], dominios: allowedDomains(), hayBase: hayUsuarios() });
  });

  app.post('/api/usuarios', soloAdmin, enBase(async (req, res) => {
    const { email, nombre } = req.body ?? {};
    const temporal = await crear({ email, nombre }, req.user.email);
    log(req, 'crear usuario', { usuario: String(email).trim().toLowerCase() });
    res.json({ temporal });
  }));

  // Una sola ruta para lo que se le hace a un usuario existente: activar/desactivar o resetear.
  app.patch('/api/usuarios/:email', soloAdmin, enBase(async (req, res) => {
    const { email } = req.params;
    const { activo, resetear: reset } = req.body ?? {};
    if (reset) {
      const temporal = await resetear(email);
      log(req, 'resetear contraseña', { usuario: email });
      return res.json({ temporal });
    }
    if (typeof activo !== 'boolean') return res.status(400).json({ error: 'No se indicó qué cambiar.' });
    await activar(email, activo);
    log(req, activo ? 'activar usuario' : 'desactivar usuario', { usuario: email });
    res.json({ ok: true });
  }));

  app.delete('/api/usuarios/:email', soloAdmin, enBase(async (req, res) => {
    const borrado = await borrar(req.params.email);
    log(req, 'borrar usuario', { usuario: req.params.email, borrado });
    res.json({ ok: borrado });
  }));
}
