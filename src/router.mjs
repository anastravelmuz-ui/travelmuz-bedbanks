// TravelMuz Bedbanks — routage du Worker Cloudflare (D-016).
// Toutes les requêtes passent ici avant les fichiers statiques : rien n'est visible sans compte.
import { createAuth } from '../server/auth-core.mjs';
import { createD1Store } from '../server/auth-store-d1.mjs';
import { handleAuth, currentUser } from '../server/auth-http.mjs';
import { validateSearch, searchHalalbooking } from '../server/halalbooking.mjs';

export const FIRST_ADMIN_EMAIL = 'anas@travelmuz.fr'; // D-015

// Accessibles sans session : pages et ressources nécessaires pour se connecter.
const PUBLIC_PATHS = new Set([
  '/connexion.html', '/reinitialiser.html', '/comptes.mjs', '/comptes.css',
  '/style.css', '/live.css', '/favicon.ico',
]);
const PUBLIC_AUTH = new Set(['login', 'logout', 'me', 'forgot', 'link', 'set-password', 'bootstrap']);
const ADMIN_PAGES = new Set(['/admin.html']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function secure(response, { noStore = false } = {}) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  if (noStore) r.headers.set('Cache-Control', 'no-store');
  return r;
}
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function halalbookingSearch(request, env, user) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'ORIGIN_REJECTED' }, 403);
  if (Number(request.headers.get('content-length') ?? 0) > 4096) return json({ error: 'BODY_TOO_LARGE' }, 413);
  let criteria;
  try { const raw = await request.text(); if (raw.length > 4096) throw new Error(); criteria = validateSearch(JSON.parse(raw)); }
  catch { return json({ error: 'INVALID_CRITERIA' }, 400); }
  try {
    return json(await searchHalalbooking(criteria, { partner: env.HALALBOOKING_PARTNER_CODE, secret: env.HALALBOOKING_SECRET_KEY }));
  } catch (e) {
    const error = e instanceof Error ? e.message : 'SUPPLIER_ERROR';
    const known = ['CONFIGURATION_MISSING', 'SUPPLIER_AUTH_FAILED', 'SUPPLIER_UNREACHABLE', 'SUPPLIER_INVALID_RESPONSE'];
    return json({ error: known.includes(error) ? error : 'SUPPLIER_ERROR' }, 502);
  }
}

export async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const auth = env.DB ? createAuth(createD1Store(env.DB)) : null;
  const ctx = { auth, setupCode: env.SETUP_CODE ?? '', firstAdminEmail: FIRST_ADMIN_EMAIL, mailer: null };

  const authMatch = path.match(/^\/api\/auth\/([a-z-]+)$/);
  if (authMatch && PUBLIC_AUTH.has(authMatch[1])) return secure(await handleAuth(authMatch[1], request, ctx), { noStore: true });
  if (path === '/api/admin') return secure(await handleAuth('admin', request, ctx), { noStore: true });

  let user = null;
  try { user = await currentUser(request, auth); } catch { user = null; }

  if (path === '/api/halalbooking/search') return secure(await halalbookingSearch(request, env, user), { noStore: true });
  if (path.startsWith('/api/')) return secure(json({ error: 'NOT_FOUND' }, 404));

  const isPublic = PUBLIC_PATHS.has(path) || path.startsWith('/fonts/');
  if (!isPublic && !user) {
    const accept = request.headers.get('accept') ?? '';
    if (request.method === 'GET' && (accept.includes('text/html') || path === '/' || path.endsWith('.html'))) {
      return secure(Response.redirect(new URL('/connexion.html', url).toString(), 302), { noStore: true });
    }
    return secure(json({ error: 'AUTHENTICATION_REQUIRED' }, 401));
  }
  if (ADMIN_PAGES.has(path) && user?.role !== 'admin') return secure(Response.redirect(new URL('/', url).toString(), 302), { noStore: true });

  // La racine sert la page du comparateur.
  const assetRequest = path === '/' ? new Request(new URL('/index.html', url), request) : request;
  const asset = await env.ASSETS.fetch(assetRequest);
  // Pages privées : jamais en cache partagé.
  return secure(asset, { noStore: !isPublic });
}
