// Point d'entrée Cloudflare : n'exporte que le gestionnaire (contrainte du runtime Workers).
import { route } from './router.mjs';

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch { return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
  },
};
