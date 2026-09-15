// La pantalla "Integración WA" del panel: los números del bot, su QR, su webhook y en qué grupos
// contesta cada uno. Todo habla con Evolution API desde el servidor, así que la apikey nunca llega
// al navegador. A propósito no se expone borrar una instancia: solo desvincular.
import { agregarNumero, grupos, numeros, ponerGrupo, quitarGrupo } from './db.mjs';

const base = () => process.env.EVOLUTION_URL.replace(/\/+$/, '');

// El nombre de la instancia lo escribe una persona y acaba dentro de una URL y de una ruta de
// Evolution: es frontera de confianza y se valida estricto, no se confía en el navegador.
export const nombreValido = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9_-]{2,30}$/.test(n);
export const jidValido = (j) => typeof j === 'string' && /^\d{5,}@g\.us$/.test(j);

async function evo(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { apikey: process.env.EVOLUTION_API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let datos;
  try { datos = JSON.parse(texto); } catch { datos = { raw: texto.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, datos };
}

/** El webhook que debe tener cada instancia: una dirección por número. */
export const webhookConfig = (instancia) => ({
  enabled: true,
  url: `${process.env.AUTH_BASE_URL.replace(/\/+$/, '')}/api/whatsapp/${instancia}`,
  byEvents: false,
  base64: false,
  events: ['MESSAGES_UPSERT'],
  headers: { 'x-zebra-secret': process.env.WHATSAPP_WEBHOOK_SECRET },
});

/** Evolution devuelve el estado en sitios distintos según el endpoint; aquí se unifica. */
export function estadoDe(datos) {
  const crudo = datos?.instance?.state ?? datos?.state ?? datos?.instance?.connectionStatus ?? null;
  return { open: 'conectado', connecting: 'esperando', close: 'desconectado' }[crudo] ?? 'desconocido';
}

// `connectionState` solo devuelve instanceName y state: el número propio vive en `fetchInstances`.
async function numeroDelBot(instancia) {
  const r = await evo(`/instance/fetchInstances?instanceName=${encodeURIComponent(instancia)}`);
  if (!r.ok) return null;
  const inst = Array.isArray(r.datos) ? r.datos[0] : (r.datos?.instance ?? r.datos);
  return (inst?.ownerJid ?? inst?.owner ?? '').split('@')[0] || null;
}

export function mountWaAdmin(app, requireSession) {
  const log = (req, accion, extra = {}) => console.log(JSON.stringify({ wa_admin: req.user.email, accion, ...extra }));

  // Toda ruta con :instancia valida el nombre antes de tocar nada.
  const conNumero = (fn) => async (req, res) => {
    const { instancia } = req.params;
    if (!nombreValido(instancia)) return res.status(400).json({ error: 'Ese nombre de número no es válido.' });
    return fn(req, res, instancia);
  };

  // Los números guardados, cada uno con su estado real en Evolution y sus grupos.
  app.get('/api/wa/numeros', requireSession, async (_req, res) => {
    const salida = [];
    for (const n of await numeros()) {
      const r = await evo(`/instance/connectionState/${n.instancia}`);
      // Evolution responde 404 cuando la instancia no existe: eso no es un error del panel.
      const estado = r.status === 404 ? 'sin-instancia' : (r.ok ? estadoDe(r.datos) : 'desconocido');
      salida.push({
        ...n,
        estado,
        numero: estado === 'conectado' ? await numeroDelBot(n.instancia) : null,
        grupos: [...await grupos(n.instancia)].map(([jid, cliente]) => ({ jid, cliente })),
      });
    }
    res.json({ numeros: salida });
  });

  app.post('/api/wa/numeros', requireSession, async (req, res) => {
    const { instancia, etiqueta } = req.body ?? {};
    if (!nombreValido(instancia)) {
      return res.status(400).json({ error: 'El nombre va en minúsculas y sin espacios ni acentos, de 3 a 31 caracteres. Por ejemplo: zebra-bot.' });
    }
    const r = await evo('/instance/create', {
      method: 'POST',
      body: {
        instanceName: instancia,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        groupsIgnore: false, // el bot vive en grupos: uno por cliente
        alwaysOnline: false,
        readMessages: false,
        webhook: webhookConfig(instancia),
      },
    });
    log(req, 'crear numero', { instancia, status: r.status });
    if (!r.ok) {
      // El Evolution es compartido: si el nombre ya existe, se dice y no se adopta lo ajeno.
      return res.status(502).json({ error: r.datos?.response?.message ?? `Evolution respondió ${r.status}` });
    }
    await agregarNumero({ instancia, etiqueta: typeof etiqueta === 'string' ? etiqueta.slice(0, 60) : null, por: req.user.email });
    res.json({ ok: true });
  });

  // El QR caduca en segundos y Evolution lo renueva solo: el navegador vuelve a pedirlo.
  app.get('/api/wa/numeros/:instancia/qr', requireSession, conNumero(async (_req, res, instancia) => {
    const r = await evo(`/instance/connect/${instancia}`);
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    const { base64 = null, code = null, pairingCode = null, count = null } = r.datos ?? {};
    // Si ya está vinculado, Evolution devuelve el estado en vez del QR.
    if (!base64 && r.datos?.instance) return res.json({ estado: estadoDe(r.datos), numero: await numeroDelBot(instancia) });
    res.json({ estado: 'esperando', base64, code, pairingCode, count });
  }));

  // Los grupos del teléfono, para elegirlos sin copiar identificadores a mano.
  app.get('/api/wa/numeros/:instancia/groups', requireSession, conNumero(async (_req, res, instancia) => {
    const r = await evo(`/group/fetchAllGroups/${instancia}?getParticipants=false`);
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    const configurado = new Set((await grupos(instancia)).keys());
    const lista = (Array.isArray(r.datos) ? r.datos : [])
      .map((g) => ({ jid: g.id, nombre: g.subject, miembros: g.size, activo: configurado.has(g.id) }));
    res.json({ grupos: lista });
  }));

  app.post('/api/wa/numeros/:instancia/webhook', requireSession, conNumero(async (req, res, instancia) => {
    const r = await evo(`/webhook/set/${instancia}`, { method: 'POST', body: { webhook: webhookConfig(instancia) } });
    log(req, 'reaplicar webhook', { instancia, status: r.status });
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    res.json({ ok: true, url: webhookConfig(instancia).url });
  }));

  app.delete('/api/wa/numeros/:instancia/session', requireSession, conNumero(async (req, res, instancia) => {
    const r = await evo(`/instance/logout/${instancia}`, { method: 'DELETE' });
    log(req, 'desvincular', { instancia, status: r.status });
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    res.json({ ok: true });
  }));

  // Dónde contesta cada número. Esto es lo que antes obligaba a editar WHATSAPP_GROUPS y desplegar.
  app.post('/api/wa/grupos', requireSession, async (req, res) => {
    const { jid, cliente, instancia } = req.body ?? {};
    if (!jidValido(jid)) return res.status(400).json({ error: 'Ese identificador de grupo no es válido.' });
    if (!nombreValido(instancia)) return res.status(400).json({ error: 'Ese nombre de número no es válido.' });
    try {
      await ponerGrupo({
        jid,
        cliente: typeof cliente === 'string' && cliente.trim() ? cliente.trim().slice(0, 80) : null,
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
