// La pantalla "Integración WA" del panel: estado de la conexión, QR para vincular el teléfono del
// bot y reaplicar el webhook. Todo habla con Evolution API desde el servidor, así que la apikey
// nunca llega al navegador. A propósito no se expone borrar la instancia: solo desvincular.
import { gruposPermitidos } from './whatsapp.mjs';

const base = () => process.env.EVOLUTION_URL.replace(/\/+$/, '');
const instancia = () => process.env.EVOLUTION_INSTANCE;
// Los grupos donde contesta, con su cliente: "1203630@g.us=Sofía, 1203631@g.us=Grupo Gira".
const configurados = () => [...gruposPermitidos()].map(([jid, cliente]) => ({ jid, cliente }));

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

/** El webhook que debe tener la instancia para que el bot reciba los mensajes. */
export const webhookConfig = () => ({
  enabled: true,
  url: `${process.env.AUTH_BASE_URL.replace(/\/+$/, '')}/api/whatsapp`,
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
async function numeroDelBot() {
  const r = await evo(`/instance/fetchInstances?instanceName=${encodeURIComponent(instancia())}`);
  if (!r.ok) return null;
  const inst = Array.isArray(r.datos) ? r.datos[0] : (r.datos?.instance ?? r.datos);
  return (inst?.ownerJid ?? inst?.owner ?? '').split('@')[0] || null;
}

export function mountWaAdmin(app, requireSession) {
  const log = (req, accion, extra = {}) => console.log(JSON.stringify({ wa_admin: req.user.email, accion, ...extra }));

  app.get('/api/wa/status', requireSession, async (_req, res) => {
    const r = await evo(`/instance/connectionState/${instancia()}`);
    // Evolution responde 404 cuando la instancia todavía no existe: eso no es un error del panel.
    if (r.status === 404) return res.json({ estado: 'sin-instancia', instancia: instancia(), grupos: configurados() });
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    res.json({ estado: estadoDe(r.datos), instancia: instancia(), numero: await numeroDelBot(), grupos: configurados() });
  });

  app.post('/api/wa/instance', requireSession, async (req, res) => {
    const r = await evo('/instance/create', {
      method: 'POST',
      body: {
        instanceName: instancia(),
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        groupsIgnore: false, // el bot vive en grupos: uno por cliente
        alwaysOnline: false,
        readMessages: false,
        webhook: webhookConfig(),
      },
    });
    log(req, 'crear instancia', { status: r.status });
    if (!r.ok) return res.status(502).json({ error: r.datos?.response?.message ?? `Evolution respondió ${r.status}` });
    res.json({ ok: true });
  });

  // El QR caduca en segundos y Evolution lo renueva solo: el navegador vuelve a pedirlo.
  app.get('/api/wa/qr', requireSession, async (_req, res) => {
    const r = await evo(`/instance/connect/${instancia()}`);
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    const { base64 = null, code = null, pairingCode = null, count = null } = r.datos ?? {};
    if (!base64 && r.datos?.instance) return res.json({ estado: estadoDe(r.datos), numero: numeroDe(r.datos) });
    res.json({ estado: 'esperando', base64, code, pairingCode, count });
  });

  // Los grupos del teléfono, para copiar el identificador sin buscarlo a mano.
  app.get('/api/wa/groups', requireSession, async (_req, res) => {
    const r = await evo(`/group/fetchAllGroups/${instancia()}?getParticipants=false`);
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    const lista = (Array.isArray(r.datos) ? r.datos : []).map((g) => ({ jid: g.id, nombre: g.subject, miembros: g.size }));
    const configurado = new Set(gruposPermitidos().keys());
    res.json({ grupos: lista.map((g) => ({ ...g, activo: configurado.has(g.jid) })) });
  });

  app.post('/api/wa/webhook', requireSession, async (req, res) => {
    const r = await evo(`/webhook/set/${instancia()}`, { method: 'POST', body: { webhook: webhookConfig() } });
    log(req, 'reaplicar webhook', { status: r.status });
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    res.json({ ok: true, url: webhookConfig().url });
  });

  app.delete('/api/wa/session', requireSession, async (req, res) => {
    const r = await evo(`/instance/logout/${instancia()}`, { method: 'DELETE' });
    log(req, 'desvincular', { status: r.status });
    if (!r.ok) return res.status(502).json({ error: `Evolution respondió ${r.status}` });
    res.json({ ok: true });
  });
}
