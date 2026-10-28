// Uso: node guia.check.mjs
// Rama cancun: el contexto va fijo en el código, sin base ni panel.
import assert from 'node:assert/strict';

const g = await import('./guia.mjs');

assert.equal(g.quienEs(), 'Cancun Country Club, Desarrollo residencial de lujo');
assert.equal(g.contextoActual().nombre, 'Cancun Country Club');
assert.match(g.guiaActual(), /esquema metricas/);
assert.doesNotMatch(g.guiaActual(), /Zebra|Sofía|Gira/, 'nada de la guía de Zebra');
assert.equal(g.quienEs({ nombre: '', giro: 'algo' }), 'este negocio', 'sin nombre, el giro solo no dice quién es');
assert.equal(g.quienEs({ nombre: ' X ' }), 'X');

console.log('guia OK');
