// La pantalla "Integración WA" del panel: los números del bot, su QR y en qué grupos contesta cada
// uno, y borrarlos. Las conexiones viven en este mismo proceso (whatsapp.mjs): aquí solo se exponen al panel.
import { agregarNumero, borrarNumero, grupos, gruposVinculados, numeros, ponerGrupo, quitarGrupo } from './db.mjs';
import { falloActual } from './proveedores.mjs';
import { conectar, desvincular, estado, gruposDelTelefono } from './whatsapp.mjs';

// El nombre de un número NUEVO lo escribe una persona y acaba dentro de una URL: se valida estricto.
// Los que ya existen no se juzgan por su forma sino por estar en la base: el sembrado desde
// Evolution se llama "DataChat", con mayúsculas, y quedaba imposible de tocar.
export const nombreValido = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9_-]{2,30}$/.test(n);
const existe = async (n) => typeof n === 'string' && (await numeros()).some((x) => x.instancia === n);

// Grupos nuevos: "120363…@g.us". Los creados antes de 2021: "<teléfono del creador>-<segundos>@g.us".
export const jidValido = (j) => typeof j === 'string' && /^\d{5,}(-\d+)?@g\.us$/.test(j);

/**
 * Lo que ve el panel: si no hay conexión y WhatsApp había cerrado la sesión, "vencida" (hay que
 * volver a escanear); si no, el estado de la conexión tal cual.
 */
export const estadoPanel = (vivo, vencida) => (vivo === 'desconectado' && vencida ? 'vencida' : vivo);

export function mountWaAdmin(app, requireSession) {
  const log = (req, accion, extra = {}) => console.log(JSON.stringify({ wa_admin: req.user.email, accion, ...extra }));

  // Toda ruta con :instancia comprueba que el número exista antes de tocar nada.
  const conNumero = (fn) => async (req, res) => {
    const { instancia } = req.params;
    if (!(await existe(instancia))) return res.status(404).json({ error: 'Ese número no existe.' });
    try {
      return await fn(req, res, instancia);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  };

  // Los números guardados, cada uno con su estado real y sus grupos.
  app.get('/api/wa/numeros', requireSession, async (_req, res) => {
    const salida = [];
    for (const n of await numeros()) {
      const { estado: e, numero } = estado(n.instancia);
      salida.push({ ...n, estado: estadoPanel(e, n.vencida), numero, grupos: await gruposVinculados(n.instancia) });
    }
    res.json({ numeros: salida, fallo: falloActual() });
  });

  app.post('/api/wa/numeros', requireSession, async (req, res) => {
    const { instancia, etiqueta } = req.body ?? {};
    if (!nombreValido(instancia)) {
      return res.status(400).json({ error: 'El nombre va en minúsculas y sin espacios ni acentos, de 3 a 31 caracteres. Por ejemplo: zebra-bot.' });
    }
    try {
      await agregarNumero({ instancia, etiqueta: typeof etiqueta === 'string' ? etiqueta.slice(0, 60) : null, por: req.user.email });
      log(req, 'crear numero', { instancia });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // El QR caduca en segundos y se renueva solo: el navegador vuelve a pedirlo. Pedirlo es lo que
  // abre la conexión, así que también sirve para reintentar un número que se cayó.
  app.get('/api/wa/numeros/:instancia/qr', requireSession, conNumero(async (_req, res, instancia) => {
    if (estado(instancia).estado === 'desconectado') await conectar(instancia);
    const { estado: e, qr, numero } = estado(instancia);
    res.json({ estado: e, base64: qr, numero });
  }));

  // Los grupos del teléfono, para elegirlos sin copiar identificadores a mano.
  app.get('/api/wa/numeros/:instancia/groups', requireSession, conNumero(async (_req, res, instancia) => {
    const configurado = new Set((await grupos(instancia)).keys());
    const lista = (await gruposDelTelefono(instancia)).map((g) => ({ ...g, activo: configurado.has(g.jid) }));
    res.json({ grupos: lista });
  }));

  app.delete('/api/wa/numeros/:instancia/session', requireSession, conNumero(async (req, res, instancia) => {
    await desvincular(instancia);
    log(req, 'desvincular', { instancia });
    res.json({ ok: true });
  }));

  // Borrar es definitivo: desvincula el teléfono y se lleva sus grupos y su sesión.
  app.delete('/api/wa/numeros/:instancia', requireSession, conNumero(async (req, res, instancia) => {
    await desvincular(instancia);
    await borrarNumero(instancia);
    log(req, 'borrar numero', { instancia });
    res.json({ ok: true });
  }));

  // Dónde contesta cada número. Rama cancun: una sola empresa, así que el grupo no lleva cliente (en
  // Zebra decía de qué cliente es el grupo); se guarda su nombre para reconocerlo en el panel.
  app.post('/api/wa/grupos', requireSession, async (req, res) => {
    const { jid, nombre, instancia } = req.body ?? {};
    if (!jidValido(jid)) return res.status(400).json({ error: 'Ese identificador de grupo no es válido.' });
    if (!(await existe(instancia))) return res.status(404).json({ error: 'Ese número no existe.' });
    try {
      await ponerGrupo({
        jid,
        nombre: typeof nombre === 'string' && nombre.trim() ? nombre.trim().slice(0, 120) : null,
        instancia,
        por: req.user.email,
      });
      log(req, 'atender grupo', { instancia, jid });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/wa/grupos/:jid', requireSession, async (req, res) => {
    if (!jidValido(req.params.jid)) return res.status(400).json({ error: 'Ese identificador de grupo no es válido.' });
    try {
      const borrado = await quitarGrupo(req.params.jid);
      log(req, 'dejar de atender grupo', { jid: req.params.jid, borrado });
      res.json({ ok: borrado });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
