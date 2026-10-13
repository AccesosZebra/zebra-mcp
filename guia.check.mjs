// Uso: node guia.check.mjs
// Sin base del dashboard ni de métricas: lo que una instancia recién clonada tiene que hacer bien.
import assert from 'node:assert/strict';

delete process.env.APP_DATABASE_URL;
process.env.DATABASE_URL = 'postgres://claude_readonly:x@localhost:1/metricas';
delete process.env.METRICAS_ADMIN_URL;

const g = await import('./guia.mjs');

// Sin contexto guardado: guía genérica, que manda a explorar, y ningún nombre de Zebra.
assert.equal(g.guiaActual(), g.GUIA_GENERICA);
assert.match(g.GUIA_GENERICA, /list_tables/);
assert.doesNotMatch(g.GUIA_GENERICA, /Zebra|Sofía|Gira/);
assert.equal(g.quienEs(), 'este negocio');
assert.equal(g.quienEs({ nombre: 'Sofía Residencial' }), 'Sofía Residencial');
assert.equal(g.quienEs({ nombre: ' Zebra ', giro: ' una agencia de marketing ' }), 'Zebra, una agencia de marketing');
assert.equal(g.quienEs({ nombre: '', giro: 'algo' }), 'este negocio', 'sin nombre, el giro solo no dice quién es');

// Sin base del dashboard no se siembra nada ni se puede guardar.
assert.equal(await g.sembrarZebra(), false);
await assert.rejects(g.guardarContexto({ nombre: 'X' }), /APP_DATABASE_URL/);

// Validación: recorta espacios, respeta topes, rechaza tipos raros.
assert.deepEqual(g.validarContexto({ nombre: ' A ', giro: '', guia: ' g ' }), { nombre: 'A', giro: '', guia: 'g' });
assert.deepEqual(g.validarContexto(), { nombre: '', giro: '', guia: '' });
assert.throws(() => g.validarContexto({ nombre: 'x'.repeat(61) }), /nombre admite hasta 60/);
assert.throws(() => g.validarContexto({ guia: 'x'.repeat(20_001) }), /guia admite hasta/);
assert.throws(() => g.validarContexto({ giro: 42 }), /no es válido/);

// El inventario en texto nunca pasa del tope y dice cuánto dejó fuera.
const objeto = (i) => ({ esquema: `Cliente ${i}`, nombre: `leads_${i}`, vista: true, columnas: ['fecha text', 'fuente text'], muestras: [{ fecha: '01/09/2026', fuente: 'Meta' }] });
const muchos = { objetos: Array.from({ length: 50 }, (_, i) => objeto(i)), omitidos: 3 };
const corto = g.inventarioATexto(muchos, 1_000);
assert.ok(corto.length < 1_200, 'respeta el tope (más la línea final)');
assert.match(corto, /y \d+ objetos más/);
assert.match(g.inventarioATexto({ objetos: [objeto(1)] }), /^"Cliente 1"\."leads_1" \(vista\): fecha text, fuente text\n {2}ejemplo: /);
assert.doesNotMatch(g.inventarioATexto({ objetos: [objeto(1)] }), /objetos más/, 'si cabe todo, no avisa de nada');

// Permisos: el rol sale de DATABASE_URL; sin URL de administrador, avisa en vez de intentar.
assert.equal(g.nombreLector(), 'claude_readonly');
assert.equal(g.nombreLector('postgres://lector%40x:p@h/b'), 'lector@x');
assert.equal(g.nombreLector('no es url'), null);
assert.equal(g.hayAdmin(), false);
await assert.rejects(g.aplicarPermisos(), /METRICAS_ADMIN_URL/);

console.log('guia OK');
