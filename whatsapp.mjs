// El Data Chat por WhatsApp, sin pasarela externa: cada número es un dispositivo vinculado que vive
// dentro de este proceso (Baileys, lo mismo que usaba Evolution por dentro). Solo se contesta en los
// grupos de la lista y solo cuando mencionan al bot o responden a un mensaje suyo. Cada grupo está
// atado a un cliente, así que dentro de ese grupo las preguntas se entienden de ese cliente.
import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

import { textoDeTurno } from './chat.mjs';
import { causaDeFallo, registrarExito, registrarFallo } from './proveedores.mjs';
import { borrarSesion, conSesion, estadoAuth, grupos as gruposDe, marcarVencida, pausarN8n } from './db.mjs';
import { Cola, Memoria, esRechazo } from './ritmo.mjs';

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

// La respuesta del bot sale por la cola del número, con prioridad: espaciada y con "escribiendo…".
async function enviar(instancia, destino, texto) {
  try {
    const cola = colaDe(instancia);
    if (!cola) throw new Error('el número no está conectado');
    await cola.enviar({ jid: destino, contenido: { text: texto }, origen: 'bot' });
  } catch (e) {
    console.error(`wa ${instancia}: no pude enviar:`, e.message);
  }
}

async function responder({ instancia, jid, key, cliente, pregunta }) {
  // Cada número lleva su propio hilo, aunque dos atendieran el mismo grupo.
  const c = historial(`${instancia}:${jid}`);
  c.messages.push({ role: 'user', content: pregunta });
  c.messages = c.messages.slice(-MAX_MENSAJES);
  const t0 = Date.now();
  // Como una persona: lee la pregunta y "escribe" mientras el modelo piensa. WhatsApp borra el
  // "escribiendo…" a los ~25 s, así que se renueva cada 8.
  const sock = conexiones.get(instancia)?.sock;
  await sock?.readMessages([key]).catch(() => {});
  const escribir = () => sock?.sendPresenceUpdate('composing', jid).catch(() => {});
  escribir();
  const latido = setInterval(escribir, 8_000);
  try {
    const r = await textoDeTurno(c.messages, 'whatsapp', cliente);
    const texto = r.texto || 'No pude responder eso. Pregúntamelo de otra forma.';
    if (r.stop === 'refusal') c.messages.pop();
    else c.messages.push({ role: 'assistant', content: texto });
    console.log(JSON.stringify({ wa: jid, instancia, cliente, ms: Date.now() - t0, stop: r.stop, model: r.modelo, in: r.usage?.input_tokens ?? 0, out: r.usage?.output_tokens ?? 0 }));
    clearInterval(latido);
    await enviar(instancia, jid, texto);
    registrarExito();
  } catch (e) {
    console.error('wa:', e?.status ?? '', e?.message);
    c.messages.pop(); // la pregunta que falló no ensucia el hilo
    // Si es la cuenta del proveedor (sin clave, sin saldo…), volver a preguntar no sirve: se dice la
    // causa exacta. Solo responde a quien preguntó; no se avisa a nadie más.
    const causa = causaDeFallo(e);
    registrarFallo(causa, 'whatsapp');
    clearInterval(latido);
    await enviar(instancia, jid, causa?.texto ?? 'Se me cayó la consulta. Vuelve a preguntarme en un momento.');
  } finally {
    clearInterval(latido);
  }
}

// ── Conexiones ──────────────────────────────────────────────────────────────
// ponytail: cada número es un socket de este proceso. Nunca correr dos réplicas del contenedor
// contra la misma base: WhatsApp acepta una sola conexión por dispositivo y tumba la otra.
const conexiones = new Map(); // instancia → { sock, estado, qr, intentos }

// Lo que Baileys pide para portarse como un cliente normal, por número y en memoria:
// - reintentos: cuántas veces pidieron reenviar un mensaje que no pudieron descifrar;
// - enviados: el contenido de lo que mandamos, para atender esos reenvíos (getMessage);
// - grupos: los datos de cada grupo, para no consultarlos a WhatsApp en cada envío.
// ponytail: en memoria; un despliegue los vacía y se vuelven a llenar solos.
const cachés = new Map(); // instancia → { reintentos, enviados, grupos }
const cachéDe = (instancia) => {
  if (!cachés.has(instancia)) {
    cachés.set(instancia, {
      reintentos: new Memoria({ ttlMs: 10 * 60_000, max: 5_000 }),
      enviados: new Memoria({ ttlMs: 6 * 60 * 60_000, max: 1_000 }),
      grupos: new Memoria({ ttlMs: 5 * 60_000, max: 500 }),
    });
  }
  return cachés.get(instancia);
};

/** Los datos de un grupo, de la caché o pidiéndolos una vez. Los usa Baileys y "mencionar a todos". */
export async function datosDeGrupo(instancia, jid) {
  const { grupos } = cachéDe(instancia);
  const guardado = grupos.get(jid);
  if (guardado) return guardado;
  const sock = conexiones.get(instancia)?.sock;
  if (!sock) return undefined;
  const datos = await sock.groupMetadata(jid);
  grupos.set(jid, datos);
  return datos;
}

// La cola de cada número (ritmo.mjs). Se rehace si cambió el socket (una reconexión).
const colas = new Map(); // instancia → { sock, cola }
const fallosN8n = new Map(); // instancia → fallos seguidos de n8n

/** La cola del número si está conectado; null si no. */
export function colaDe(instancia) {
  const sock = socketConectado(instancia);
  if (!sock) return null;
  const actual = colas.get(instancia);
  if (actual?.sock === sock) return actual.cola;
  const { enviados } = cachéDe(instancia);
  const cola = new Cola({
    sock: {
      sendPresenceUpdate: (...a) => sock.sendPresenceUpdate(...a),
      // Lo enviado se recuerda unas horas: si el destinatario no lo pudo descifrar, lo pedirá otra vez.
      sendMessage: async (jid, contenido) => {
        const msg = await sock.sendMessage(jid, contenido);
        if (msg?.key?.id && msg.message) enviados.set(msg.key.id, msg.message);
        fallosN8n.set(instancia, 0);
        return msg;
      },
    },
    alFallar: (e, origen) => { if (origen === 'n8n') vigilar(instancia, e); },
  });
  colas.set(instancia, { sock, cola });
  return cola;
}

// Kill switch: si WhatsApp empieza a rechazar los envíos de n8n (o fallan 3 seguidos), se pausan los
// de ese número hasta que alguien los reanude en el panel. Las respuestas del bot siguen.
function vigilar(instancia, e) {
  const fallos = (fallosN8n.get(instancia) ?? 0) + 1;
  fallosN8n.set(instancia, fallos);
  if (!esRechazo(e) && fallos < 3) return;
  const motivo = esRechazo(e) ? `WhatsApp rechazó un envío (${String(e?.message ?? e).slice(0, 80)})` : '3 envíos seguidos fallaron';
  fallosN8n.set(instancia, 0);
  console.log(JSON.stringify({ wa: instancia, n8n_pausa: motivo }));
  pausarN8n(instancia, motivo).catch((err) => console.error(`wa ${instancia}: no pude pausar n8n:`, err.message));
}
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
    msgRetryCounterCache: cachéDe(instancia).reintentos,
    getMessage: async (key) => cachéDe(instancia).enviados.get(key.id),
    cachedGroupMetadata: (jid) => datosDeGrupo(instancia, jid).catch(() => undefined),
  });
  // Si cambian los datos de un grupo, la próxima vez se piden de nuevo.
  sock.ev.on('groups.update', (cambios) => { for (const g of cambios) if (g.id) cachéDe(instancia).grupos.del(g.id); });
  sock.ev.on('group-participants.update', ({ id }) => cachéDe(instancia).grupos.del(id));

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
    // Tras 8 fallos seguidos (unos 5 min) se baja a un intento cada 5 min: los ciclos rápidos de
    // conexión y desconexión son una bandera roja para WhatsApp.
    const lenta = c.intentos >= 8;
    const espera = codigo === DisconnectReason.restartRequired ? 0 : lenta ? 5 * 60_000 : Math.min(60_000, 2_000 * 2 ** c.intentos);
    c.intentos++;
    console.log(JSON.stringify({ wa: instancia, reconecta_en_ms: espera, codigo, ...(lenta ? { reconexion: 'lenta' } : {}) }));
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
  void responder({ ...veredicto, instancia, key: data.key });
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
