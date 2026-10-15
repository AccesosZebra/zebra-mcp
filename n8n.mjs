// La API para n8n: las rutas de Evolution API que usa el nodo de la comunidad
// (n8n-nodes-evolution-api) para ENVIAR mensajes, sobre el WhatsApp nativo de este proceso. El nodo
// pega el Server Url (https://<panel>/evo) delante de rutas fijas y manda la clave en la cabecera
// `apikey`. Cada número tiene su clave; aquí solo se guarda su sha256.
//
// Solo envío: texto, imagen, video, documento y reacción, más /instance/fetchInstances, que n8n usa
// para probar la credencial. Lo demás responde 501. "Quoted" se ignora: citar exige guardar los
// mensajes, y este proceso no guarda historial.
import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import express from 'express';

import { claveApiDe, numeroPorClave } from './db.mjs';
import { Freno } from './usuarios.mjs';
import { estado, socketConectado } from './whatsapp.mjs';

export const PREFIJO = '/evo';
export const MAX_MEDIO = 20 * 1024 * 1024; // lo que acepta WhatsApp para un documento ronda los 100 MB; aquí basta con 20
const MAX_DELAY_MS = 20_000;

// ── La clave ────────────────────────────────────────────────────────────────
export const hashClave = (clave) => createHash('sha256').update(String(clave)).digest('hex');

/** Compara en tiempo constante. Nunca lanza: una clave rara simplemente no coincide. */
export function claveCoincide(clave, hash) {
  if (typeof clave !== 'string' || !clave || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(hashClave(clave)), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Errores con la forma de Evolution, pero en cristiano ────────────────────
export class ErrorApi extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}
const cuerpoError = (status, mensaje) => ({ status, error: mensaje, response: { message: [mensaje] } });

// ── A quién va ──────────────────────────────────────────────────────────────
/**
 * Lo que manda el nodo como "número": un jid (grupo o persona) se usa tal cual; unos dígitos hay
 * que resolverlos con WhatsApp. Devuelve { jid } o { digitos }.
 */
export function destino(numero) {
  const t = String(numero ?? '').trim();
  if (/^[\d-]+@g\.us$/.test(t) || /^\d+@s\.whatsapp\.net$/.test(t)) return { jid: t };
  const digitos = t.replace(/[\s()+.-]/g, '');
  if (/^\d{8,15}$/.test(digitos)) return { digitos };
  throw new ErrorApi(400, 'El destino no es válido: usa un número con lada (p. ej. 5219991234567) o el id de un grupo (…@g.us).');
}

// ponytail: caché en memoria del proceso; un despliegue la vacía y se vuelve a preguntar.
const resueltos = new Map(); // `${instancia}:${digitos}` → jid

/** El jid real de unos dígitos. WhatsApp corrige el "521…" de México y dice si el número existe. */
async function resolver(sock, instancia, numero) {
  const d = destino(numero);
  if (d.jid) return d.jid;
  const clave = `${instancia}:${d.digitos}`;
  if (resueltos.has(clave)) return resueltos.get(clave);
  const [r] = (await sock.onWhatsApp(d.digitos)) ?? [];
  if (!r?.exists) throw new ErrorApi(400, `El número ${d.digitos} no tiene WhatsApp.`);
  resueltos.set(clave, r.jid);
  return r.jid;
}

// ── Medios: URL pública o base64 ────────────────────────────────────────────
// El servidor descarga la URL él mismo: nunca hacia la red interna (otros contenedores, la base,
// el panel de EasyPanel), para que una clave de n8n no sirva de puente.
const privadas = new BlockList();
for (const [red, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) privadas.addSubnet(red, bits, 'ipv4');
for (const [red, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) privadas.addSubnet(red, bits, 'ipv6');
// Una IPv4 escrita como IPv6 (::ffff:10.0.0.1) se revisa como IPv4. (Una subred ::ffff:0:0/96 en
// BlockList abarcaría TODAS las IPv4, públicas incluidas.)
export function ipPrivada(ip) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4) return privadas.check(v4, 'ipv4');
  return privadas.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

/** La URL, si es https y con un dominio público por nombre; si no, una excepción en cristiano. */
export function urlPermitida(texto) {
  let u;
  try { u = new URL(String(texto)); } catch { throw new ErrorApi(400, 'El archivo no es una URL válida ni base64.'); }
  if (u.protocol !== 'https:') throw new ErrorApi(400, 'La URL del archivo tiene que empezar con https://.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || !host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ErrorApi(400, 'La URL del archivo tiene que ser de un dominio público, no una IP ni un nombre interno.');
  }
  return u;
}

const pareceUrl = (t) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t);

/** El archivo como Buffer. `pedir` y `resolverDns` se inyectan en las pruebas. */
export async function bajarMedio(media, { pedir = fetch, resolverDns = (h) => lookup(h, { all: true }) } = {}) {
  const t = String(media ?? '').trim();
  if (!t) throw new ErrorApi(400, 'Falta el archivo (media): una URL https o el contenido en base64.');
  if (!pareceUrl(t)) {
    const b64 = t.replace(/^data:[^,]*;base64,/, '');
    if (!/^[A-Za-z0-9+/=_\s-]+$/.test(b64)) throw new ErrorApi(400, 'El archivo no es una URL válida ni base64.');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new ErrorApi(400, 'El archivo en base64 está vacío.');
    if (buf.length > MAX_MEDIO) throw new ErrorApi(413, 'El archivo pasa de 20 MB.');
    return buf;
  }
  const u = urlPermitida(t);
  const ips = await resolverDns(u.hostname).catch(() => []);
  if (!ips.length) throw new ErrorApi(400, `No se encontró el dominio ${u.hostname}.`);
  if (ips.some((x) => ipPrivada(x.address))) throw new ErrorApi(400, 'La URL del archivo apunta a una red interna.');
  let res;
  // Sin seguir redirecciones: una redirección podría llevar a la red interna después de la revisión.
  try { res = await pedir(u, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw new ErrorApi(502, `No se pudo descargar el archivo (${e.cause?.code ?? e.name}).`); }
  if (res.status >= 300 && res.status < 400) throw new ErrorApi(400, 'La URL del archivo redirige a otra: usa la dirección final.');
  if (!res.ok) throw new ErrorApi(502, `No se pudo descargar el archivo: el servidor respondió ${res.status}.`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_MEDIO) throw new ErrorApi(413, 'El archivo pasa de 20 MB.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIO) throw new ErrorApi(413, 'El archivo pasa de 20 MB.');
  return buf;
}

// ── Lo que se le pasa a Baileys ─────────────────────────────────────────────
const menciones = (body) => (Array.isArray(body?.mentioned) ? body.mentioned.filter((m) => /^\d+@s\.whatsapp\.net$/.test(m)) : []);

export function contenidoTexto(body) {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) throw new ErrorApi(400, 'Falta el texto del mensaje.');
  if (text.length > 65_000) throw new ErrorApi(400, 'El texto es demasiado largo.');
  return { text, mentions: menciones(body) };
}

export const TIPOS = ['image', 'video', 'document'];

export function contenidoMedio(body, archivo) {
  const tipo = body?.mediatype;
  if (!TIPOS.includes(tipo)) throw new ErrorApi(400, 'mediatype tiene que ser image, video o document.');
  const caption = typeof body.caption === 'string' && body.caption ? body.caption : undefined;
  const mimetype = typeof body.mimetype === 'string' && body.mimetype ? body.mimetype : undefined;
  const base = { caption, mentions: menciones(body) };
  if (tipo === 'image') return { image: archivo, mimetype, ...base };
  if (tipo === 'video') return { video: archivo, mimetype, ...base };
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 200) : 'archivo';
  return { document: archivo, mimetype: mimetype ?? 'application/octet-stream', fileName, ...base };
}

/** La reacción: el nodo ya manda la llave completa del mensaje, así que no hace falta historial. */
export function contenidoReaccion(body) {
  const k = body?.key ?? {};
  if (typeof k.id !== 'string' || !k.id || typeof k.remoteJid !== 'string') throw new ErrorApi(400, 'Faltan el id y el chat del mensaje al que reaccionas.');
  destino(k.remoteJid); // que sea un jid válido
  const fromMe = k.fromMe === true || k.fromMe === 'true';
  return { jid: k.remoteJid, contenido: { react: { text: typeof body.reaction === 'string' ? body.reaction : '', key: { remoteJid: k.remoteJid, fromMe, id: k.id } } } };
}

// ── Las rutas ───────────────────────────────────────────────────────────────
const frenoClaves = new Freno({ maximo: 20, ventanaMs: 15 * 60 * 1000 });
const instanciaDe = (texto) => String(texto ?? '').trim().toLowerCase();

/**
 * Monta /evo. `socketDe` se inyecta en las pruebas para no abrir un WhatsApp de verdad.
 * El parser de JSON de /evo (con su límite de 20 MB) lo pone server.mjs, antes que el general.
 */
export function mountN8n(app, { socketDe = socketConectado } = {}) {
  const r = express.Router();
  const responder = (res, e) => {
    const status = e instanceof ErrorApi ? e.status : 500;
    if (status === 500) console.error('n8n:', e?.message);
    res.status(status).json(cuerpoError(status, status === 500 ? 'No se pudo enviar el mensaje. Intenta de nuevo en un momento.' : e.message));
  };

  // La clave tiene que ser la del número de la ruta. Los fallos cuentan para el freno por IP.
  const autenticar = async (req, instancia) => {
    const n = instancia ? await claveApiDe(instancia) : null;
    if (n?.api_hash && claveCoincide(req.get('apikey'), n.api_hash)) return n;
    if (!frenoClaves.permitido(`mal|${req.ip ?? ''}`)) throw new ErrorApi(429, 'Demasiados intentos con una clave incorrecta. Espera 15 minutos.');
    if (!req.get('apikey')) throw new ErrorApi(401, 'Falta la ApiKey: genérala en el panel (Integración WA → el número → Opciones avanzadas).');
    if (!n) throw new ErrorApi(401, `La instancia «${instancia}» no existe o esa ApiKey no es suya: el Instance Name es el nombre de la conexión en el panel.`);
    throw new ErrorApi(401, 'La ApiKey no es válida para esta instancia. Revisa que sea la última que generaste para este número.');
  };

  // n8n prueba la credencial aquí, sin decir de qué número es: se busca el dueño de la clave.
  r.get('/instance/fetchInstances', async (req, res) => {
    try {
      const n = await numeroPorClave(hashClave(req.get('apikey') ?? ''));
      if (!n) {
        if (!frenoClaves.permitido(`mal|${req.ip ?? ''}`)) throw new ErrorApi(429, 'Demasiados intentos con una clave incorrecta. Espera 15 minutos.');
        throw new ErrorApi(401, 'La ApiKey no es válida. Genérala en el panel: Integración WA → el número → Opciones avanzadas.');
      }
      const pedido = instanciaDe(req.query.instanceName);
      if (pedido && pedido !== n.instancia) return res.json([]);
      const e = estado(n.instancia);
      res.json([{ name: n.instancia, profileName: n.etiqueta ?? n.instancia, connectionStatus: e.estado === 'conectado' ? 'open' : 'close', ownerJid: e.numero ? `${e.numero}@s.whatsapp.net` : null }]);
    } catch (e) { responder(res, e); }
  });

  const enviar = (tipo, armar) => async (req, res) => {
    const instancia = instanciaDe(req.params.instancia);
    let jid;
    try {
      await autenticar(req, instancia);
      const sock = socketDe(instancia);
      if (!sock) throw new ErrorApi(409, 'Ese número no está conectado (o su sesión de WhatsApp venció): vuelve a vincularlo en el panel.');
      const pedido = await armar(req.body ?? {}, sock, instancia);
      jid = pedido.jid;
      if (req.body?.quoted) console.log(JSON.stringify({ n8n: instancia, tipo, quoted: 'ignorado' }));
      const delay = Math.min(Math.max(Number(req.body?.delay) || 0, 0), MAX_DELAY_MS);
      if (delay) {
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await new Promise((ok) => setTimeout(ok, delay));
      }
      const msg = await sock.sendMessage(jid, pedido.contenido);
      console.log(JSON.stringify({ n8n: instancia, tipo, destino: jid.endsWith('@g.us') ? 'grupo' : 'numero', ok: true }));
      res.status(201).json(msg);
    } catch (e) {
      console.log(JSON.stringify({ n8n: instancia, tipo, destino: jid ? (jid.endsWith('@g.us') ? 'grupo' : 'numero') : null, ok: false, status: e.status ?? 500 }));
      responder(res, e);
    }
  };

  r.post('/message/sendText/:instancia', enviar('texto', async (body, sock, instancia) => {
    const contenido = contenidoTexto(body);
    const jid = await resolver(sock, instancia, body.number);
    if (body.mentionsEveryOne === true && jid.endsWith('@g.us')) {
      contenido.mentions = (await sock.groupMetadata(jid)).participants.map((p) => p.id);
    }
    return { jid, contenido };
  }));

  r.post('/message/sendMedia/:instancia', enviar('medio', async (body, sock, instancia) => {
    if (!TIPOS.includes(body.mediatype)) throw new ErrorApi(400, 'mediatype tiene que ser image, video o document.');
    const jid = await resolver(sock, instancia, body.number);
    return { jid, contenido: contenidoMedio(body, await bajarMedio(body.media)) };
  }));

  r.post('/message/sendReaction/:instancia', enviar('reaccion', async (body) => contenidoReaccion(body)));

  // Lo que el nodo puede pedir y aquí no existe: se dice claro, no un 404 sin explicación.
  r.all('/{*resto}', (_req, res) => res.status(501).json(cuerpoError(501,
    'zebra-mcp solo implementa el envío de mensajes: texto, imagen, video, documento y reacción.')));

  app.use(PREFIJO, r);
}
