// Login del panel, con dos puertas (el modelo de Zebra Reports):
// - Google, para el equipo: entran como administradores los correos verificados de los dominios
//   de AUTH_ALLOWED_DOMAIN (lista separada por comas). Port de lib/auth/* de Prompt Studio.
// - Correo y contraseña, para la gente del cliente: rol "cliente", usuarios creados en Admin. Dentro
//   de "cliente", la base dice si es "admin" (entra a Ajustes y Admin) o "usuario".
// La sesión es una cookie firmada con HMAC-SHA256 que dice quién es y con qué rol.
// En req.user: `zebra` (entró con Google) y `admin` (Zebra, o cliente con rol "admin").
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

import { autenticar, cambiarContrasena, frenoLogin, hayUsuarios, sesionVigente } from './usuarios.mjs';

const SESSION_COOKIE = 'zebra_chat_session';
const STATE_COOKIE = 'zebra_chat_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Los dominios que entran con Google, como administradores. */
export const allowedDomains = () => (process.env.AUTH_ALLOWED_DOMAIN || 'zebradigital.marketing')
  .split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

// El "@" delante evita dominios parecidos (evilzebradigital.marketing).
export function isEmailAllowed(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  return e.split('@').length === 2 && allowedDomains().some((d) => e.endsWith('@' + d));
}

function secret() {
  const s = process.env.AUTH_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('Falta AUTH_SESSION_SECRET (mínimo 32 caracteres)');
  return s;
}
const sign = (part) => createHmac('sha256', secret()).update(part).digest('base64url');

/** rol "admin" (Google) o "cliente" (contraseña, con su versión de sesión `v`). */
export function signSession(email, now = Date.now(), { rol = 'admin', v } = {}) {
  const payload = { email: email.trim().toLowerCase(), exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS, rol, ...(rol === 'cliente' ? { v: v ?? 0 } : {}) };
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
  // Las cookies de antes de los roles no traen rol: eran todas de Google.
  const rol = payload.rol ?? 'admin';
  if (rol === 'cliente') return typeof payload.email === 'string' ? { ...payload, rol } : null;
  // Un admin tiene que seguir siendo de un dominio permitido: quitar uno de la lista lo saca.
  return rol === 'admin' && isEmailAllowed(payload.email) ? { ...payload, rol } : null;
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

/**
 * Verifica un ID token de Google con su endpoint tokeninfo (que comprueba la firma) y además lo que
 * le toca a quien lo recibe: que sea para NUESTRO client_id, de Google, vigente y con correo
 * verificado. Sin dependencias; para un login de equipo, el viaje extra a Google no pesa.
 */
export async function verificarIdToken(token, pedir = fetch) {
  const res = await pedir(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error('token inválido');
  const c = await res.json();
  if (c.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('el token es de otra aplicación');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new Error('el token no es de Google');
  if (!(Number(c.exp) * 1000 > Date.now())) throw new Error('el token venció');
  if (!(c.email_verified === true || c.email_verified === 'true')) throw new Error('Google no verificó este correo');
  return { email: String(c.email).toLowerCase(), hd: c.hd ?? null, nombre: c.name ?? null };
}

export async function requireSession(req, res, next) {
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  // Un cliente se revalida contra la base: desactivarlo o resetearle la contraseña lo saca en ≤ 60 s,
  // y un cambio de rol vale en el mismo plazo.
  const cliente = session?.rol === 'cliente' ? await sesionVigente(session.email, session.v) : null;
  if (session && (session.rol !== 'cliente' || cliente)) {
    const zebra = session.rol === 'admin';
    req.user = { ...session, zebra, admin: zebra || cliente?.rol === 'admin' };
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Tu sesión venció. Vuelve a entrar.' });
  res.redirect('/login');
}

/** Administradores: Zebra o un cliente con rol "admin". Va siempre después de requireSession. */
export function requireAdmin(req, res, next) {
  if (req.user?.admin) return next();
  res.status(403).json({ error: 'Esta sección es solo para administradores.' });
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
    });
    // Solo una pista para Google, y solo si hay un dominio; el filtro real es el del callback.
    if (allowedDomains().length === 1) params.set('hd', allowedDomains()[0]);
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

    const hdMismatch = identity.hd != null && !allowedDomains().includes(identity.hd.toLowerCase());
    if (!identity.emailVerified || !isEmailAllowed(identity.email) || hdMismatch) return fail('domain');

    res.clearCookie(STATE_COOKIE, { path: '/' });
    res.cookie(SESSION_COOKIE, signSession(identity.email, Date.now(), { rol: 'admin' }), cookieOpts(req, SESSION_TTL_SECONDS * 1000));
    res.redirect('/');
  });

  // Lo que la página de login necesita saber para pintarse. El client_id de Google es público.
  app.get('/auth/config', (_req, res) => res.json({
    clientId: process.env.GOOGLE_CLIENT_ID, dominios: allowedDomains(), contrasena: hayUsuarios(),
  }));

  // El botón "Acceder como…" de Google (Identity Services) entrega un ID token al navegador; aquí se
  // verifica con Google antes de abrir sesión. El flujo con redirección de arriba sigue de respaldo.
  app.post('/auth/google', async (req, res) => {
    const { credential } = req.body ?? {};
    if (typeof credential !== 'string' || credential.length > 4096) return res.status(400).json({ error: 'Falta la credencial de Google.' });
    let c;
    try { c = await verificarIdToken(credential); } catch (e) {
      return res.status(401).json({ error: `No se pudo verificar la sesión de Google: ${e.message}` });
    }
    const hdMismatch = c.hd != null && !allowedDomains().includes(String(c.hd).toLowerCase());
    if (!isEmailAllowed(c.email) || hdMismatch) {
      return res.status(403).json({ error: `Esa cuenta no tiene acceso. Solo cuentas ${allowedDomains().map((d) => '@' + d).join(' o ')}.` });
    }
    console.log(JSON.stringify({ login: c.email, via: 'google' }));
    res.cookie(SESSION_COOKIE, signSession(c.email, Date.now(), { rol: 'admin' }), cookieOpts(req, SESSION_TTL_SECONDS * 1000));
    res.json({ ok: true });
  });

  // La puerta del cliente. Un solo mensaje para "no existe" y "clave mala": no se confirma quién existe.
  app.post('/auth/password', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!hayUsuarios()) return res.status(503).json({ error: 'El acceso con contraseña no está disponible en esta instancia.' });
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Escribe tu correo y tu contraseña.' });
    }
    const clave = `${email.trim().toLowerCase()}|${req.ip ?? ''}`;
    if (!frenoLogin.permitido(clave)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    let u;
    try { u = await autenticar(email, password); } catch (e) {
      console.error('login contraseña:', e.message);
      return res.status(503).json({ error: 'No se pudo comprobar la contraseña. Intenta en un momento.' });
    }
    if (!u) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    frenoLogin.limpiar(clave);
    console.log(JSON.stringify({ login: u.email, via: 'contraseña' }));
    res.cookie(SESSION_COOKIE, signSession(u.email, Date.now(), { rol: 'cliente', v: u.v }), cookieOpts(req, SESSION_TTL_SECONDS * 1000));
    res.json({ ok: true });
  });

  // El cliente cambia su propia contraseña. Sube su versión: cierra sus otras sesiones y renueva esta.
  app.post('/api/me/contrasena', requireSession, async (req, res) => {
    if (req.user.rol !== 'cliente') return res.status(403).json({ error: 'Tu cuenta entra con Google: la contraseña se cambia ahí.' });
    const { actual, nueva } = req.body ?? {};
    try {
      const v = await cambiarContrasena(req.user.email, actual, nueva);
      res.cookie(SESSION_COOKIE, signSession(req.user.email, Date.now(), { rol: 'cliente', v }), cookieOpts(req, SESSION_TTL_SECONDS * 1000));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });
}
