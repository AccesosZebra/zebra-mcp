// Uso: node auth.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'x'.repeat(40);
delete process.env.AUTH_ALLOWED_DOMAIN;
delete process.env.APP_DATABASE_URL;
const { signSession, verifySession, isEmailAllowed, allowedDomains, requireAdmin, requireSession, verificarIdToken } = await import('./auth.mjs');

const token = signSession('Ana@ZebraDigital.marketing', 0);
assert.equal(verifySession(token, 1000)?.email, 'ana@zebradigital.marketing');
assert.equal(verifySession(token, 8 * 24 * 3600 * 1000), null, 'vencida');

const [part, sig] = token.split('.');
assert.equal(verifySession(`${part}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`, 0), null, 'firma alterada');
const forged = Buffer.from(JSON.stringify({ email: 'x@gmail.com', exp: 9e9 })).toString('base64url');
assert.equal(verifySession(`${forged}.${sig}`, 0), null, 'payload cambiado');
assert.equal(verifySession('basura', 0), null);
assert.equal(verifySession(undefined, 0), null);

assert.equal(isEmailAllowed('ana@zebradigital.marketing'), true);
assert.equal(isEmailAllowed('a@evilzebradigital.marketing'), false);
assert.equal(isEmailAllowed('a@b@zebradigital.marketing'), false);
assert.equal(isEmailAllowed('ana@gmail.com'), false);

process.env.AUTH_SESSION_SECRET = 'y'.repeat(40);
assert.equal(verifySession(token, 1000), null, 'otro secreto');

process.env.AUTH_SESSION_SECRET = 'x'.repeat(40);

// Roles: Google es admin (también las cookies viejas, sin rol); la contraseña es cliente con su versión.
assert.equal(verifySession(signSession('ana@zebradigital.marketing', 0), 1000).rol, 'admin');
const viejo = Buffer.from(JSON.stringify({ email: 'ana@zebradigital.marketing', exp: 9e9 })).toString('base64url');
const { createHmac } = await import('node:crypto');
const firmar = (p) => `${p}.${createHmac('sha256', 'x'.repeat(40)).update(p).digest('base64url')}`;
assert.equal(verifySession(firmar(viejo), 0)?.rol, 'admin', 'las cookies de antes de los roles siguen valiendo');
const cli = verifySession(signSession('Luis@CCC.mx', 0, { rol: 'cliente', v: 3 }), 1000);
assert.deepEqual([cli.email, cli.rol, cli.v], ['luis@ccc.mx', 'cliente', 3], 'un cliente no necesita dominio de Google');
assert.equal(verifySession(signSession('luis@ccc.mx', 0, { rol: 'admin' }), 1000), null, 'admin fuera de los dominios no vale');
const inventado = Buffer.from(JSON.stringify({ email: 'x@y.mx', exp: 9e9, rol: 'superadmin' })).toString('base64url');
assert.equal(verifySession(firmar(inventado), 0), null, 'un rol desconocido no entra');

// Varios dominios de Google, con y sin "@", con espacios.
process.env.AUTH_ALLOWED_DOMAIN = ' zebradigital.marketing , @ccc.mx ';
assert.deepEqual(allowedDomains(), ['zebradigital.marketing', 'ccc.mx']);
assert.equal(isEmailAllowed('dir@ccc.mx'), true);
assert.equal(isEmailAllowed('dir@notccc.mx'), false);
delete process.env.AUTH_ALLOWED_DOMAIN;

// requireAdmin (Ajustes y Admin) deja pasar a Zebra y al cliente con rol admin.
const res = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const pasa = (mw, user) => { let ok = false; const r = res(); mw({ user }, r, () => { ok = true; }); return ok || r.code; };
const zebra = { rol: 'admin', zebra: true, admin: true };
const clienteAdmin = { rol: 'cliente', zebra: false, admin: true };
const clienteUsuario = { rol: 'cliente', zebra: false, admin: false };
assert.equal(pasa(requireAdmin, zebra), true);
assert.equal(pasa(requireAdmin, clienteAdmin), true, 'el admin del cliente entra a Ajustes y Admin');
assert.equal(pasa(requireAdmin, clienteUsuario), 403);

// requireSession: con Google, req.user dice que es Zebra y administrador.
const conGoogle = { headers: { cookie: `zebra_chat_session=${encodeURIComponent(signSession('ana@zebradigital.marketing', Date.now()))}` }, originalUrl: '/api/me' };
await requireSession(conGoogle, res(), () => {});
assert.deepEqual([conGoogle.user.zebra, conGoogle.user.admin], [true, true]);

// requireSession: una cookie de cliente sin base que la respalde no entra (revocación).
const cookie = `zebra_chat_session=${encodeURIComponent(signSession('luis@ccc.mx', Date.now(), { rol: 'cliente', v: 0 }))}`;
const r2 = res(); let entro = false;
await requireSession({ headers: { cookie }, originalUrl: '/api/chat' }, r2, () => { entro = true; });
assert.equal(entro, false); assert.equal(r2.code, 401);

// ID token de Google: se acepta solo si es para nuestro client_id, de Google, vigente y verificado.
process.env.GOOGLE_CLIENT_ID = 'nuestro.apps.googleusercontent.com';
const google = (claims, ok = true) => async () => ({ ok, json: async () => claims });
const bueno = { aud: 'nuestro.apps.googleusercontent.com', iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 600), email: 'Ana@ZebraDigital.marketing', email_verified: 'true', hd: 'zebradigital.marketing' };
assert.deepEqual(await verificarIdToken('t', google(bueno)), { email: 'ana@zebradigital.marketing', hd: 'zebradigital.marketing', nombre: null });
await assert.rejects(verificarIdToken('t', google(bueno, false)), /inválido/, 'Google lo rechaza');
await assert.rejects(verificarIdToken('t', google({ ...bueno, aud: 'otra.apps.googleusercontent.com' })), /otra aplicación/);
await assert.rejects(verificarIdToken('t', google({ ...bueno, iss: 'evil.com' })), /no es de Google/);
await assert.rejects(verificarIdToken('t', google({ ...bueno, exp: '1' })), /venció/);
await assert.rejects(verificarIdToken('t', google({ ...bueno, email_verified: 'false' })), /no verificó/);

console.log('auth OK');
