// Uso: node ritmo.check.mjs
// La cola de WhatsApp con un reloj falso: nada espera de verdad, pero cada espera queda anotada.
import assert from 'node:assert/strict';

const { Cola, Memoria, ErrorRitmo, LIMITES, PAUSA, MISMO_CHAT_MS, ESCRITURA, tiempoEscritura, esRechazo } = await import('./ritmo.mjs');

// Un reloj que solo avanza cuando la cola "duerme", y un socket que anota lo que se le pide.
function banco({ azar = () => 0.5, fallar = null } = {}) {
  let t = 1_000_000;
  const log = [];
  const sock = {
    sendPresenceUpdate: async (estado, jid) => { log.push([t, estado, jid]); },
    sendMessage: async (jid, contenido) => {
      if (fallar) throw fallar;
      log.push([t, 'send', jid, contenido.text ?? Object.keys(contenido)[0]]);
      return { key: { id: `M${log.length}`, remoteJid: jid } };
    },
  };
  const fallos = [];
  const cola = new Cola({ sock, ahora: () => t, dormir: async (ms) => { t += ms; }, azar, alFallar: (e, o) => fallos.push([e.message, o]) });
  return { cola, log, fallos, reloj: { get: () => t, avanzar: (ms) => { t += ms; } } };
}
const envios = (log) => log.filter((x) => x[1] === 'send');

// ── Tiempo de escritura: proporcional al largo, con tope y piso, y fijo para medios ──
assert.equal(tiempoEscritura({ text: 'hola' }, () => 0.5), ESCRITURA.min, 'un texto corto, el mínimo');
assert.equal(tiempoEscritura({ text: 'x'.repeat(1000) }, () => 0.5), ESCRITURA.max, 'uno largo, el máximo');
assert.equal(tiempoEscritura({ text: 'x'.repeat(100) }, () => 0.5), 4_000, '100 letras ≈ 4 s');
assert.equal(tiempoEscritura({ text: 'x'.repeat(100) }, () => 0), 3_200, 'con azar: −20 %');
assert.equal(tiempoEscritura({ text: 'x'.repeat(100) }, () => 1), 4_800, 'con azar: +20 %');
assert.equal(tiempoEscritura({ image: Buffer.from('x') }, () => 0), ESCRITURA.medio[0]);
assert.equal(tiempoEscritura({ react: { text: '👍' } }), 0, 'una reacción no se escribe');

// ── Orden: escribiendo → pausa → envío, y pausa al azar entre envíos ──
{
  const { cola, log } = banco();
  await Promise.all([
    cola.enviar({ jid: 'g1@g.us', contenido: { text: 'uno' } }),
    cola.enviar({ jid: 'g2@g.us', contenido: { text: 'dos' } }),
  ]);
  assert.deepEqual(log.map((x) => x[1]), ['composing', 'paused', 'send', 'composing', 'paused', 'send']);
  const [a, b] = envios(log).map((x) => x[0]);
  const pausa = PAUSA.min + (PAUSA.max - PAUSA.min) * 0.5;
  assert.equal(b - a, pausa + ESCRITURA.min, 'entre dos envíos: la pausa al azar y luego lo que "escribe"');
}

// ── El mismo chat espera al menos 3 s, aunque la pausa al azar sea menor ──
{
  const { cola, log } = banco({ azar: () => 0 }); // la pausa mínima (3 s) = MISMO_CHAT_MS
  await cola.enviar({ jid: 'g1@g.us', contenido: { react: { text: '👍', key: {} } } });
  await cola.enviar({ jid: 'g1@g.us', contenido: { react: { text: '👍', key: {} } } });
  const [a, b] = envios(log).map((x) => x[0]);
  assert.ok(b - a >= MISMO_CHAT_MS, `mismo chat: ${b - a} ms`);
}

// ── El bot pasa antes que lo que n8n ya tenía en cola ──
{
  const { cola, log } = banco();
  const p = [
    cola.enviar({ jid: 'g@g.us', contenido: { text: 'n8n 1' }, origen: 'n8n' }),
    cola.enviar({ jid: 'g@g.us', contenido: { text: 'n8n 2' }, origen: 'n8n' }),
    cola.enviar({ jid: 'g@g.us', contenido: { text: 'bot' }, origen: 'bot' }),
  ];
  await Promise.all(p);
  assert.deepEqual(envios(log).map((x) => x[3]), ['n8n 1', 'bot', 'n8n 2'], 'el primero ya salía; luego el bot');
}

// ── Topes: n8n recibe 429 al pasar el minuto; el bot nunca se rechaza ──
{
  const { cola, reloj } = banco();
  for (let i = 0; i < LIMITES.minuto; i++) cola.enviados.push(reloj.get() - 1_000);
  assert.throws(() => cola.revisar(), (e) => e instanceof ErrorRitmo && e.status === 429 && /10 mensajes por minuto/.test(e.message));
  await assert.rejects(cola.enviar({ jid: 'g@g.us', contenido: { text: 'x' }, origen: 'n8n' }), /por minuto/);
  await cola.enviar({ jid: 'g@g.us', contenido: { text: 'x' }, origen: 'bot' }); // pasa igual
  reloj.avanzar(61_000);
  cola.revisar(); // pasado el minuto, se vuelve a poder
  cola.enviados = Array.from({ length: LIMITES.hora }, () => reloj.get() - 5 * 60_000);
  assert.throws(() => cola.revisar(), /150 mensajes por hora/);
  cola.enviados = Array.from({ length: LIMITES.dia }, () => reloj.get() - 3 * 60 * 60_000);
  assert.throws(() => cola.revisar(), /800 mensajes al día/);
}

// ── Cola llena: 429 sin encolar más ──
{
  const { cola } = banco();
  cola.trabajando = true; // que nadie saque nada
  for (let i = 0; i < LIMITES.cola; i++) cola.pendientes.push({ origen: 'n8n' });
  cola.enviados = [];
  // Para que salte la cola y no el minuto, se relaja el tope del minuto un momento.
  const tope = LIMITES.minuto; LIMITES.minuto = 1e9; LIMITES.hora = 1e9; LIMITES.dia = 1e9;
  assert.throws(() => cola.revisar(), /demasiados mensajes en cola/);
  Object.assign(LIMITES, { minuto: tope, hora: 150, dia: 800 });
}

// ── Si falla, avisa al kill switch con el origen ──
{
  const { cola, fallos } = banco({ fallar: new Error('rate-overlimit') });
  await assert.rejects(cola.enviar({ jid: 'g@g.us', contenido: { text: 'x' }, origen: 'n8n' }), /rate-overlimit/);
  assert.deepEqual(fallos, [['rate-overlimit', 'n8n']]);
}
assert.equal(esRechazo(new Error('rate-overlimit')), true);
assert.equal(esRechazo(Object.assign(new Error('x'), { output: { statusCode: 403 } })), true);
assert.equal(esRechazo(new Error('fetch failed')), false, 'un corte de red no pausa nada');

// ── Memoria: caduca y respeta el tope ──
{
  let t = 0;
  const m = new Memoria({ ttlMs: 1_000, max: 2, ahora: () => t });
  m.set('a', 1); m.set('b', 2); m.set('c', 3);
  assert.equal(m.get('a'), undefined, 'la más vieja se fue');
  assert.equal(m.get('c'), 3);
  t = 1_000;
  assert.equal(m.get('c'), undefined, 'caducó');
  m.set('d', 4); m.del('d'); assert.equal(m.get('d'), undefined);
  m.set('e', 5); m.flushAll(); assert.equal(m.get('e'), undefined);
}

console.log('ritmo OK');
