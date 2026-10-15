// El Data Chat por WhatsApp, sin pasarela externa: cada número es un dispositivo vinculado que vive
// dentro de este proceso (Baileys, lo mismo que usaba Evolution por dentro). Solo se contesta en los
// grupos de la lista y solo cuando mencionan al bot o responden a un mensaje suyo. Cada grupo está
// atado a un cliente, así que dentro de ese grupo las preguntas se entienden de ese cliente.
import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

import { textoDeTurno } from './chat.mjs';
import { causaDeFallo, registrarExito, registrarFallo } from './proveedores.mjs';
import { borrarSesion, conSesion, estadoAuth, grupos as gruposDe, marcarVencida } from './db.mjs';

const TTL_MS = 30 * 60 * 1000; // media hora en silencio cierra la conversación
const MAX_MENSAJES = 12;       // y nunca se arrastran más de 12

const numero = (jid = '') => jid.split('@')[0].split(':')[0];
export const esGrupo = (jid = '') => jid.endsWith('@g.us');

/** ¿Este jid es el bot? WhatsApp lo nombra de dos formas y las menciones usan la nueva. */
export const esElBot = (jid, mias) => Boolean(jid) && mias.has(numero(jid));

// El texto simple llega en `conversation`; el que lleva formato, mención o cita, en `extendedTextMessage`.
export const textoDe = (data) => data?.message?.conversation ?? data?.message?.extendedTextMessage?.text ?? null;

// La mención llega como "@5219997923682" dentro del texto; al bot no le aporta nada.
export const limpiar = (texto = '') => texto.replace(/@\d{6,}/g, ' ').replace(/\s+/g, ' ').trim();

/** Decide si este mensaje merece respuesta, y de qué cliente habla. */
export function debeResponder({ data, mias, permitidos }) {
  const jid = data?.key?.remoteJid ?? '';
  if (data?.key?.fromMe) return { responder: false, motivo: 'lo mandó el propio bot' };
  if (!esGrupo(jid)) return { responder: false, motivo: 'no es un grupo' };
  if (!permitidos.has(jid)) return { responder: false, motivo: 'grupo fuera de la lista' };

  // Sin saber cómo se llama a sí mismo no hay forma de juzgar la mención: decir "no lo
  // mencionaron" sería mentir y manda a buscar el problema al sitio equivocado.
  if (!mias?.size) return { responder: false, motivo: 'no sé quién soy' };

  // En los mensajes con formato el contexto viaja dentro del propio mensaje, no al lado.
  const ctx = data?.contextInfo ?? data?.message?.extendedTextMessage?.contextInfo ?? {};
  const mencionado = (ctx.mentionedJid ?? []).some((j) => esElBot(j, mias));
  const leResponden = esElBot(ctx.participant ?? '', mias);
  if (!mencionado && !leResponden) return { responder: false, motivo: 'no lo mencionaron' };

  const pregunta = limpiar(textoDe(data) ?? '');
  if (!pregunta) return { responder: false, motivo: 'sin texto' };
  return { responder: true, jid, cliente: permitidos.get(jid) ?? null, pregunta };
}

// Cómo se llama el bot a sí mismo. Son DOS nombres: su número (5219…@s.whatsapp.net) y su @lid
// (2593…@lid), que es el que aparece en las menciones desde que WhatsApp cambió el
// direccionamiento. Comparar solo contra el número hacía que ninguna mención coincidiera.
export const misNombres = (user) => new Set([user?.id, user?.lid].filter(Boolean).map(numero));

// ponytail: historial en memoria del proceso, por grupo. Se pierde al desplegar, que para preguntas
// sueltas del equipo no importa. Si hiciera falta que sobreviva, a Postgres.
const chats = new Map();
function historial(clave, ahora = Date.now()) {
  for (const [k, v] of chats) if (ahora - v.at > TTL_MS) chats.delete(k);
  const c = chats.get(clave) ?? { messages: [], at: ahora };
  c.at = ahora;
  chats.set(clave, c);
  return c;
}

async function enviar(instancia, destino, texto) {
  const sock = conexiones.get(instancia)?.sock;
  try {
    if (!sock) throw new Error('el número no está conectado');
    await sock.sendMessage(destino, { text: texto });
  } catch (e) {
    console.error(`wa ${instancia}: no pude enviar:`, e.message);
  }
}

async function responder({ instancia, jid, cliente, pregunta }) {
  // Cada número lleva su propio hilo, aunque dos atendieran el mismo grupo.
  const c = historial(`${instancia}:${jid}`);
  c.messages.push({ role: 'user', content: pregunta });
  c.messages = c.messages.slice(-MAX_MENSAJES);
  const t0 = Date.now();
  try {
    const r = await textoDeTurno(c.messages, 'whatsapp', cliente);
    const texto = r.texto || 'No pude responder eso. Pregúntamelo de otra forma.';
    if (r.stop === 'refusal') c.messages.pop();
    else c.messages.push({ role: 'assistant', content: texto });
    console.log(JSON.stringify({ wa: jid, instancia, cliente, ms: Date.now() - t0, stop: r.stop, model: r.modelo, in: r.usage?.input_tokens ?? 0, out: r.usage?.output_tokens ?? 0 }));
    await enviar(instancia, jid, texto);
    registrarExito();
  } catch (e) {
    console.error('wa:', e?.status ?? '', e?.message);
    c.messages.pop(); // la pregunta que falló no ensucia el hilo
    // Si es la cuenta del proveedor (sin clave, sin saldo…), volver a preguntar no sirve: se dice la
    // causa exacta. Solo responde a quien preguntó; no se avisa a nadie más.
    const causa = causaDeFallo(e);
    registrarFallo(causa, 'whatsapp');
    await enviar(instancia, jid, causa?.texto ?? 'Se me cayó la consulta. Vuelve a preguntarme en un momento.');
  }
}

// ── Conexiones ──────────────────────────────────────────────────────────────
// ponytail: cada número es un socket de este proceso. Nunca correr dos réplicas del contenedor
// contra la misma base: WhatsApp acepta una sola conexión por dispositivo y tumba la otra.
const conexiones = new Map(); // instancia → { sock, estado, qr, intentos }
const silencio = pino({ level: 'silent' });

// Cierres tras los que reconectar sería pelear: otro proceso tomó la sesión, o WhatsApp la vetó.
const SIN_REINTENTO = new Set([DisconnectReason.connectionReplaced, DisconnectReason.forbidden]);

/** Lo que el panel necesita saber de un número. */
export function estado(instancia) {
  const c = conexiones.get(instancia);
  if (!c) return { estado: 'desconectado', qr: null, numero: null };
  return { estado: c.estado, qr: c.qr, numero: c.estado === 'conectado' ? numero(c.sock.user?.id) : null };
}

/** Abre (o reabre) la conexión de un número. Sin sesión guardada, genera un QR para vincularlo. */
export async function conectar(instancia) {
  const previa = conexiones.get(instancia);
  if (previa && previa.estado !== 'desconectado') return;
  // Se apunta antes del primer await: el panel pide el QR cada 5 s y dos peticiones a la vez
  // abrirían dos sockets del mismo número, que WhatsApp tumbaría uno contra otro.
  const c = { sock: null, estado: 'esperando', qr: null, intentos: previa?.intentos ?? 0 };
  conexiones.set(instancia, c);
  previa?.sock?.end(undefined);

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await estadoAuth(instancia));
  } catch (e) {
    c.estado = 'desconectado';
    throw e;
  }
  const sock = c.sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silencio) },
    logger: silencio,
    browser: ['Zebra Data Chat', 'Chrome', '1.0'],
    markOnlineOnConnect: false, // que el teléfono siga recibiendo notificaciones
    syncFullHistory: false,     // el bot no necesita los chats viejos
  });

  sock.ev.on('creds.update', () => saveCreds().catch((e) => console.error(`wa ${instancia}: no pude guardar la sesión:`, e.message)));

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (conexiones.get(instancia) !== c) return; // un socket viejo que ya se reemplazó
    if (qr) {
      c.qr = await QRCode.toDataURL(qr, { margin: 1, width: 264 });
      c.estado = 'esperando';
    }
    if (connection === 'open') {
      Object.assign(c, { estado: 'conectado', qr: null, intentos: 0 });
      console.log(JSON.stringify({ wa: instancia, conectado: numero(sock.user?.id) }));
      marcarVencida(instancia, null).catch((e) => console.error(`wa ${instancia}:`, e.message));
    }
    if (connection !== 'close') return;

    const codigo = lastDisconnect?.error?.output?.statusCode;
    c.estado = 'desconectado';
    c.qr = null;
    if (codigo === DisconnectReason.loggedOut && !c.desvinculando) {
      // WhatsApp cerró la sesión: el teléfono pasó más de 14 días sin usarse, o lo desvincularon
      // desde el teléfono. Las llaves ya no valen, se olvidan, y queda anotado para que el panel
      // diga "sesión vencida" y pida volver a escanear. Los grupos se quedan.
      await borrarSesion(instancia).catch((e) => console.error(`wa ${instancia}:`, e.message));
      await marcarVencida(instancia, new Date()).catch((e) => console.error(`wa ${instancia}:`, e.message));
      return console.log(JSON.stringify({ wa: instancia, vencida: 'WhatsApp cerró la sesión' }));
    }
    // Sin vincular y sin escanear a tiempo: el QR caducó. Se espera a que lo pidan otra vez desde
    // el panel, en vez de generar códigos para siempre.
    const sinVincular = !state.creds.me && codigo !== DisconnectReason.restartRequired;
    if (c.desvinculando || sinVincular || SIN_REINTENTO.has(codigo)) {
      return console.log(JSON.stringify({ wa: instancia, cerrado: codigo ?? 'sin código' }));
    }
    // 515 llega justo después de escanear el QR y pide reabrir; lo demás son cortes de red.
    const espera = codigo === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** c.intentos++);
    console.log(JSON.stringify({ wa: instancia, reconecta_en_ms: espera, codigo }));
    setTimeout(() => conectar(instancia).catch((e) => console.error(`wa ${instancia}:`, e.message)), espera);
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return; // 'append' es historial que llega al vincular, no mensajes nuevos
    for (const data of messages) atender(instancia, sock, data).catch((e) => console.error(`wa ${instancia}:`, e.message));
  });
}

async function atender(instancia, sock, data) {
  const jid = data?.key?.remoteJid ?? '';
  if (!esGrupo(jid)) return; // privados y estados ni se registran: no hay nada que decidir
  const permitidos = await gruposDe(instancia);
  const veredicto = debeResponder({ data, mias: misNombres(sock.user), permitidos });
  if (!veredicto.responder) return console.log(JSON.stringify({ wa: jid, instancia, ignorado: veredicto.motivo }));
  void responder({ ...veredicto, instancia });
}

/** Los grupos donde está el teléfono, para elegirlos en el panel. */
export async function gruposDelTelefono(instancia) {
  const c = conexiones.get(instancia);
  if (c?.estado !== 'conectado') throw new Error('Ese número no está conectado.');
  return Object.values(await c.sock.groupFetchAllParticipating())
    .map((g) => ({ jid: g.id, nombre: g.subject, miembros: g.participants?.length ?? g.size ?? null }));
}

/** El socket de un número si está conectado; null si no. Lo usa la API para n8n (n8n.mjs). */
export function socketConectado(instancia) {
  const c = conexiones.get(instancia);
  return c?.estado === 'conectado' ? c.sock : null;
}

/** Desvincula el teléfono y olvida sus llaves. El número y sus grupos se quedan. */
export async function desvincular(instancia) {
  const c = conexiones.get(instancia);
  if (c) {
    c.desvinculando = true;
    await c.sock?.logout().catch(() => {}); // si ya estaba caído, no hay nada que avisar a WhatsApp
    conexiones.delete(instancia);
  }
  await borrarSesion(instancia);
}

/** Al arrancar: reconecta los números que ya estaban vinculados. Los demás esperan al panel. */
export async function arrancarWhatsapp() {
  const vinculados = await conSesion();
  for (const instancia of vinculados) await conectar(instancia);
  return vinculados;
}
