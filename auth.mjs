// Login con Google para el chat. Port de lib/auth/* de Prompt Studio: OAuth
// "authorization code" hablando directo con Google y una cookie de sesión
// firmada con HMAC-SHA256. Solo entran correos verificados del dominio.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const SESSION_COOKIE = 'zebra_chat_session';
const STATE_COOKIE = 'zebra_chat_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const allowedDomain = () => (process.env.AUTH_ALLOWED_DOMAIN || 'zebradigital.marketing').toLowerCase();

// El "@" delante evita dominios parecidos (evilzebradigital.marketing).
export function isEmailAllowed(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  return e.split('@').length === 2 && e.endsWith('@' + allowedDomain());
}

function secret() {
  const s = process.env.AUTH_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('Falta AUTH_SESSION_SECRET (mínimo 32 caracteres)');
  return s;
}
const sign = (part) => createHmac('sha256', secret()).update(part).digest('base64url');

export function signSession(email, now = Date.now()) {
  const payload = { email: email.trim().toLowerCase(), exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${part}.${sign(part)}`;
}

// Firma, vencimiento y (otra vez) dominio. Nunca lanza con basura: devuelve null.
export function verifySession(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [part, sig, extra] = token.split('.');
  if (!part || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(part));
  const received = Buffer.from(sig);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof payload?.exp !== 'number' || Math.floor(now / 1000) >= payload.exp) return null;
  return isEmailAllowed(payload.email) ? payload : null;
}

function readCookie(req, name) {
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0 && pair.slice(0, i).trim() === name) return decodeURIComponent(pair.slice(i + 1).trim());
  }
  return null;
}

// Detrás del proxy de EasyPanel el host interno no sirve: AUTH_BASE_URL manda.
const baseUrl = (req) => (process.env.AUTH_BASE_URL
  || `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`).replace(/\/+$/, '');
const redirectUri = (req) => `${baseUrl(req)}/auth/callback`;
const cookieOpts = (req, maxAge) => ({ httpOnly: true, secure: baseUrl(req).startsWith('https://'), sameSite: 'lax', path: '/', maxAge });

// El id_token llega servidor a servidor por TLS desde el endpoint de Google, así
// que (como indica Google para este flujo) se puede leer sin re-verificar la firma.
async function exchangeCode(req, code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google respondió ${res.status}`);
  const { id_token } = await res.json();
  if (!id_token) throw new Error('Google no devolvió id_token');
  const c = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString('utf8'));
  return {
    email: typeof c.email === 'string' ? c.email : null,
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    hd: typeof c.hd === 'string' ? c.hd : null,
  };
}

export function requireSession(req, res, next) {
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  if (session) {
    req.user = session;
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Tu sesión venció. Vuelve a entrar.' });
  res.redirect('/login');
}

export function mountAuth(app) {
  app.get('/auth/google', (req, res) => {
    const state = randomUUID();
    res.cookie(STATE_COOKIE, state, cookieOpts(req, 10 * 60 * 1000));
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
      hd: allowedDomain(), // solo una pista para Google; el filtro real es el del callback
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/auth/callback', async (req, res) => {
    const fail = (error) => {
      res.clearCookie(STATE_COOKIE, { path: '/' });
      res.redirect(`/login?error=${error}`);
    };
    if (req.query.error) return fail('google');
    const { code, state } = req.query;
    const expected = readCookie(req, STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) return fail('state');

    let identity;
    try { identity = await exchangeCode(req, String(code)); } catch { return fail('google'); }

    const hdMismatch = identity.hd != null && identity.hd.toLowerCase() !== allowedDomain();
    if (!identity.emailVerified || !isEmailAllowed(identity.email) || hdMismatch) return fail('domain');

    res.clearCookie(STATE_COOKIE, { path: '/' });
    res.cookie(SESSION_COOKIE, signSession(identity.email), cookieOpts(req, SESSION_TTL_SECONDS * 1000));
    res.redirect('/');
  });

  app.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });
}
