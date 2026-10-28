// Uso: node usuarios.check.mjs
// Lo que no necesita base: contraseñas, temporales, correos y el freno de intentos.
import assert from 'node:assert/strict';

delete process.env.APP_DATABASE_URL;
const u = await import('./usuarios.mjs');

// scrypt: verifica la buena, rechaza la mala, y un hash raro nunca lanza (el login no se cae).
const h = u.hashear('una clave larga 123');
assert.match(h, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
assert.equal(u.verificar('una clave larga 123', h), true);
assert.equal(u.verificar('una clave larga 124', h), false);
assert.notEqual(u.hashear('x'), u.hashear('x'), 'sal distinta cada vez');
for (const raro of ['', 'basura', 'md5$1$2', 'scrypt$1$1$1$$', null, undefined]) assert.equal(u.verificar('x', raro), false);

// Temporales: largas, sin caracteres que se confunden al dictarlas, y distintas.
const t = u.contrasenaTemporal();
assert.equal(t.length, 14);
assert.match(t, /^[a-km-zA-HJ-NP-Z2-9]+$/);
assert.doesNotMatch(t, /[0O1lI]/);
assert.notEqual(u.contrasenaTemporal(), u.contrasenaTemporal());
assert.ok(u.contrasenaTemporal().length >= u.MINIMO, 'la temporal cumple el mínimo que se exige al cambiarla');

// Correos.
for (const ok of ['ana@ccc.mx', 'Ana.Pérez@cliente.com']) assert.equal(u.correoValido(ok), true, ok);
for (const malo of ['', 'ana', 'ana@', '@ccc.mx', 'a b@c.mx', 'ana@ccc', 42, null]) assert.equal(u.correoValido(malo), false, String(malo));

// Freno: 5 intentos por clave en la ventana; otra clave no se ve afectada; pasa la ventana y se reabre.
let ahora = 0;
const f = new u.Freno({ maximo: 5, ventanaMs: 1000, ahora: () => ahora });
for (let i = 0; i < 5; i++) assert.equal(f.permitido('ana|ip'), true, `intento ${i + 1}`);
assert.equal(f.permitido('ana|ip'), false, 'el sexto se frena');
assert.equal(f.permitido('luis|ip'), true, 'otra persona no paga por ana');
ahora = 1000;
assert.equal(f.permitido('ana|ip'), true, 'pasada la ventana, vuelve a entrar');
f.limpiar('ana|ip');
assert.equal(f.golpes.has('ana|ip'), false);

// Sin base: no hay acceso por contraseña, y autenticar no revienta con datos malos.
assert.equal(u.hayUsuarios(), false);
assert.equal(await u.autenticar('no es correo', 'x'), null);
assert.equal(await u.autenticar('ana@ccc.mx', ''), null);
assert.equal(await u.sesionVigente('ana@ccc.mx', 0), null, 'sin base, una sesión de cliente no vale');

// Roles: solo "admin" o "usuario", y se valida antes de tocar la base.
assert.deepEqual(u.ROLES, ['admin', 'usuario']);
await assert.rejects(u.crear({ email: 'ana@ccc.mx', rol: 'superadmin' }), /Elige un rol/);
await assert.rejects(u.cambiarRol('ana@ccc.mx', 'zebra'), /Elige un rol/);
await assert.rejects(u.crear({ email: 'ana@ccc.mx', rol: 'admin' }), /APP_DATABASE_URL/, 'un rol válido pasa y pide la base');

// Nadie se quita a sí mismo el rol ni el acceso; a otro, sí.
const { sobreSiMismo } = await import('./admin.mjs');
assert.throws(() => sobreSiMismo({ user: { email: 'ana@ccc.mx' } }, ' Ana@CCC.mx '), /propio rol/);
assert.doesNotThrow(() => sobreSiMismo({ user: { email: 'ana@ccc.mx' } }, 'luis@ccc.mx'));

console.log('usuarios OK');
