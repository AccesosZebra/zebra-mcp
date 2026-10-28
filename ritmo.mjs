// El ritmo de WhatsApp: todo lo que sale de un número pasa por SU cola y sale de uno en uno, con
// pausas al azar, "escribiendo…" proporcional al texto y topes por minuto, hora y día. Lo que más
// delata a un bot son las ráfagas a intervalos fijos; aquí no las hay.
//
// - Las respuestas del bot van primero y nunca se rechazan: son respuestas a alguien que preguntó.
// - Lo de n8n respeta los topes: si se pasa, recibe 429 con el límite que tocó.
// - ponytail: contadores en memoria del proceso; un despliegue los reinicia. Si hiciera falta
//   exactitud entre reinicios, a Postgres.

export const LIMITES = { minuto: 10, hora: 150, dia: 800, cola: 20 };
export const PAUSA = { min: 3_000, max: 8_000 };   // entre envíos del mismo número
export const MISMO_CHAT_MS = 3_000;                // entre dos envíos al mismo chat
export const ESCRITURA = { msPorLetra: 40, min: 1_500, max: 6_000, medio: [2_000, 4_000], tope: 20_000 };

/** Un error que la API puede devolver tal cual: lleva su código HTTP. */
export class ErrorRitmo extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; this.esApi = true; }
}

/** Map con caducidad y tope de entradas (las más viejas se van primero). Sin dependencias. */
export class Memoria {
  constructor({ ttlMs, max = 1000, ahora = Date.now }) { Object.assign(this, { ttlMs, max, ahora, datos: new Map() }); }
  get(k) {
    const e = this.datos.get(k);
    if (!e) return undefined;
    if (this.ahora() >= e.hasta) { this.datos.delete(k); return undefined; }
    return e.v;
  }
  set(k, v) {
    this.datos.delete(k);
    this.datos.set(k, { v, hasta: this.ahora() + this.ttlMs });
    while (this.datos.size > this.max) this.datos.delete(this.datos.keys().next().value);
    return true;
  }
  del(k) { this.datos.delete(k); }
  flushAll() { this.datos.clear(); }
}

/** Cuánto "escribe" antes de enviar: proporcional al texto, con azar; los medios, un rato fijo. */
export function tiempoEscritura(contenido, azar = Math.random) {
  const texto = contenido?.text ?? contenido?.caption;
  if (contenido?.image || contenido?.video || contenido?.document) {
    const [a, b] = ESCRITURA.medio;
    return Math.round(a + (b - a) * azar());
  }
  if (contenido?.react) return 0; // una reacción no se "escribe"
  const base = Math.min(ESCRITURA.max, Math.max(ESCRITURA.min, (texto?.length ?? 0) * ESCRITURA.msPorLetra));
  return Math.round(base * (0.8 + 0.4 * azar()));
}

const MINUTO = 60_000, HORA = 60 * MINUTO, DIA = 24 * HORA;

export class Cola {
  /**
   * sock: el socket de Baileys. alFallar(e, origen): para el kill switch. Lo demás se inyecta en las
   * pruebas: el reloj, la espera y el azar.
   */
  constructor({ sock, alFallar = () => {}, ahora = Date.now, dormir = (ms) => new Promise((ok) => setTimeout(ok, ms)), azar = Math.random }) {
    Object.assign(this, { sock, alFallar, ahora, dormir, azar });
    this.pendientes = [];      // { jid, contenido, origen, delay, ok, mal, encolado }
    this.enviados = [];        // marcas de tiempo de los envíos, para los topes
    this.ultimo = 0;           // el último envío del número
    this.ultimoChat = new Map(); // jid → el último envío a ese chat
    this.trabajando = false;
  }

  /** Cuántos hubo en la ventana, contando lo que espera en la cola. */
  cuenta(ventana) {
    const desde = this.ahora() - ventana;
    this.enviados = this.enviados.filter((t) => t > this.ahora() - DIA);
    return this.enviados.filter((t) => t > desde).length + this.pendientes.length;
  }

  /** Revisa los topes de n8n. Lanza 429 con el límite que tocó. */
  revisar() {
    if (this.pendientes.filter((p) => p.origen === 'n8n').length >= LIMITES.cola) {
      throw new ErrorRitmo(429, 'Hay demasiados mensajes en cola para este número; reintenta en unos minutos.');
    }
    for (const [ventana, tope, nombre] of [[MINUTO, LIMITES.minuto, 'por minuto'], [HORA, LIMITES.hora, 'por hora'], [DIA, LIMITES.dia, 'al día']]) {
      if (this.cuenta(ventana) >= tope) throw new ErrorRitmo(429, `Se alcanzó el límite de ${tope} mensajes ${nombre} de este número. Espera y reintenta.`);
    }
  }

  /** Encola y espera a que salga. Devuelve el mensaje de Baileys y cuánto esperó. */
  async enviar({ jid, contenido, origen = 'n8n', delay = 0 }) {
    if (origen === 'n8n') this.revisar();
    return new Promise((ok, mal) => {
      this.pendientes.push({ jid, contenido, origen, delay, ok, mal, encolado: this.ahora() });
      this.trabajar();
    });
  }

  async trabajar() {
    if (this.trabajando) return;
    this.trabajando = true;
    try {
      while (this.pendientes.length) {
        // El bot primero; dentro de cada origen, por orden de llegada.
        const i = Math.max(0, this.pendientes.findIndex((p) => p.origen === 'bot'));
        const p = this.pendientes.splice(i, 1)[0];
        try { p.ok(await this.uno(p)); } catch (e) { this.alFallar(e, p.origen); p.mal(e); }
      }
    } finally { this.trabajando = false; }
  }

  async uno({ jid, contenido, delay, encolado }) {
    // La pausa entre envíos es al azar: nunca un intervalo fijo.
    const pausa = PAUSA.min + (PAUSA.max - PAUSA.min) * this.azar();
    const listo = Math.max(this.ultimo ? this.ultimo + pausa : 0, (this.ultimoChat.get(jid) ?? 0) + MISMO_CHAT_MS);
    if (listo > this.ahora()) await this.dormir(listo - this.ahora());

    const escribir = Math.min(ESCRITURA.tope, Math.max(tiempoEscritura(contenido, this.azar), Number(delay) || 0));
    if (escribir) {
      await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await this.dormir(escribir);
      await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
    const msg = await this.sock.sendMessage(jid, contenido);
    const t = this.ahora();
    this.ultimo = t;
    this.ultimoChat.set(jid, t);
    this.enviados.push(t);
    return { msg, esperaMs: t - encolado };
  }
}

// Las señales de que WhatsApp empezó a rechazar al número: con ellas se pausa n8n.
export const esRechazo = (e) => /rate-overlimit|forbidden|not-authorized|too many/i.test(String(e?.message ?? ''))
  || [403, 429].includes(e?.output?.statusCode ?? e?.data?.status ?? e?.status);
