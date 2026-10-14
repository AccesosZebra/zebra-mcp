// Uso: node reportes.check.mjs
import assert from 'node:assert/strict';

delete process.env.APP_DATABASE_URL;
const r = await import('./reportes.mjs');

// Validación: nombre, modo y URL; para incrustar, solo https (el navegador bloquearía http).
assert.deepEqual(r.validarReporte({ nombre: ' Embudo ', url: 'http://postgres_reportes:3000', modo: 'interno' }),
  { nombre: 'Embudo', url: 'http://postgres_reportes:3000/', modo: 'interno' });
assert.equal(r.validarReporte({ nombre: 'Looker', url: 'https://lookerstudio.google.com/x', modo: 'incrustar' }).modo, 'incrustar');
const rechaza = (d, re) => assert.throws(() => r.validarReporte(d), re);
rechaza({ nombre: '', url: 'https://a.mx', modo: 'incrustar' }, /nombre/);
rechaza({ nombre: 'x'.repeat(61), url: 'https://a.mx', modo: 'incrustar' }, /nombre/);
rechaza({ nombre: 'A', url: 'https://a.mx', modo: 'otro' }, /cómo se muestra/);
rechaza({ nombre: 'A', url: 'no es url', modo: 'incrustar' }, /no es válida/);
rechaza({ nombre: 'A', url: 'javascript:alert(1)', modo: 'incrustar' }, /http/);
rechaza({ nombre: 'A', url: 'file:///etc/passwd', modo: 'interno' }, /http/);
rechaza({ nombre: 'A', url: 'http://a.mx', modo: 'incrustar' }, /https/);
rechaza({ nombre: 'A', url: 'https://user:pass@a.mx', modo: 'incrustar' }, /contraseña/);

// ¿Se deja incrustar? X-Frame-Options y frame-ancestors.
const cab = (o) => new Headers(o);
assert.equal(r.avisoDeIncrustar(cab({})), null);
assert.match(r.avisoDeIncrustar(cab({ 'x-frame-options': 'DENY' })), /no permite/);
assert.match(r.avisoDeIncrustar(cab({ 'x-frame-options': 'SAMEORIGIN' })), /no permite/);
assert.match(r.avisoDeIncrustar(cab({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })), /nadie/);
assert.match(r.avisoDeIncrustar(cab({ 'content-security-policy': "frame-ancestors 'self' https://a.mx" })), /a\.mx/);
assert.equal(r.avisoDeIncrustar(cab({ 'content-security-policy': 'frame-ancestors *' })), null);

// Al navegador nunca llega la dirección interna: solo la ruta del panel.
const interno = { id: 'abc', nombre: 'E', url: 'http://postgres_reportes:3000/', modo: 'interno' };
assert.deepEqual(r.publico(interno), { id: 'abc', nombre: 'E', modo: 'interno', src: '/reportes/abc/' });
assert.equal(r.publico({ ...interno, modo: 'incrustar', url: 'https://a.mx/' }).src, 'https://a.mx/');
assert.doesNotMatch(r.SANDBOX, /allow-same-origin/, 'lo servido desde el panel no ve la sesión');

console.log('reportes OK');
