// Uso: node reportes.check.mjs
import assert from 'node:assert/strict';

const r = await import('./reportes.mjs');

// Rama cancun: lista fija, con el id de siempre para que /reportes/<id>/ no cambie.
assert.deepEqual(r.REPORTES.map((x) => x.id), ['nI7LSL67']);
assert.equal(r.REPORTES[0].url, 'http://postgres_reportes:3000/');
for (const x of r.REPORTES) assert.ok(['incrustar', 'interno'].includes(x.modo), `${x.id}: modo válido`);

// Al navegador nunca llega la dirección interna: solo la ruta del panel.
const interno = { id: 'abc', nombre: 'E', url: 'http://postgres_reportes:3000/', modo: 'interno' };
assert.deepEqual(r.publico(interno), { id: 'abc', nombre: 'E', modo: 'interno', src: '/reportes/abc/' });
assert.equal(r.publico({ ...interno, modo: 'incrustar', url: 'https://a.mx/' }).src, 'https://a.mx/');
assert.doesNotMatch(r.SANDBOX, /allow-same-origin/, 'lo servido desde el panel no ve la sesión');

console.log('reportes OK');
