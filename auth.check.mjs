// Uso: node auth.check.mjs
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'x'.repeat(40);
const { signSession, verifySession, isEmailAllowed } = await import('./auth.mjs');

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

console.log('auth OK');
