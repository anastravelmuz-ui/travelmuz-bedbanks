// Administration : connexion Bedsonline (Hotelbeds) et correspondance des hôtels, validée par un humain.
const $ = id => document.getElementById(id);
const HOTEL = { id: 4, name: 'Deluxe Golden Horn Sultanahmet' }; // hôtel de référence (même liste que le comparateur)
const say = { CONFIGURATION_MISSING: 'Clés absentes dans Cloudflare (HOTELBEDS_API_KEY, HOTELBEDS_SECRET).', SUPPLIER_AUTH_FAILED: 'Bedsonline refuse la clé : vérifiez clé, secret et environnement.', QUOTA_EXCEEDED: 'Quota d’appels atteint (50 par jour en évaluation).', SUPPLIER_UNREACHABLE: 'Bedsonline injoignable.', INVALID_CRITERIA: 'Code destination invalide (ex. IST).' };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const msg = (t, k = 'info') => { const m = $('hb-msg'); m.textContent = t; m.className = 'msg ' + k; m.hidden = !t; };
async function api(path, body) {
  try { const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const d = await r.json().catch(() => ({})); return r.ok ? { ok: true, data: d } : { ok: false, error: d.error ?? 'SERVER_ERROR' }; }
  catch { return { ok: false, error: 'NETWORK' }; }
}
let from = 1;
async function current() {
  const r = await api('/api/admin/mappings');
  if (!r.ok) return;
  $('hb-mapping').hidden = false;
  const m = r.data.mappings.find(x => x.hbPlaceId === HOTEL.id && x.provider === 'hotelbeds');
  const box = $('hb-current'); box.replaceChildren();
  if (!m) { box.textContent = `${HOTEL.name} : aucun code Bedsonline associé, la recherche Bedsonline est désactivée pour cet hôtel.`; return; }
  const del = el('button', { type: 'button', className: 'text-button', textContent: 'Retirer l’association' });
  del.onclick = async () => { if (!confirm('Retirer l’association Bedsonline ?')) return; await api('/api/admin/mappings', { action: 'delete', hbPlaceId: HOTEL.id, provider: 'hotelbeds', code: m.code }); current(); };
  box.append(`${HOTEL.name} ↔ code Bedsonline ${m.code}${m.name ? ' · ' + m.name : ''}${m.address ? ' · ' + m.address : ''} — validé par ${m.validatedBy} le ${new Date(m.validatedAt).toLocaleString('fr-FR')}. `, del);
}
$('hb-status-btn').onclick = async () => {
  const out = $('hb-status-out'); out.hidden = false; out.textContent = 'Test en cours (2 appels)…';
  const r = await api('/api/admin/hotelbeds/status');
  if (!r.ok) { out.textContent = say[r.error] ?? 'Test impossible.'; return; }
  const label = v => (v === 'ok' ? 'accepte la clé ✓' : v === 'SUPPLIER_AUTH_FAILED' ? 'refuse la clé' : say[v] ?? v);
  out.textContent = `Environnement de test : ${label(r.data.test)} · Production : ${label(r.data.production)} · Site configuré sur : ${r.data.configured}.`
    + (r.data.production === 'ok' && r.data.configured === 'test' ? ' Votre clé est une clé de production : il faudra régler HOTELBEDS_BASE_URL sur https://api.hotelbeds.com.' : '');
};
async function search(start) {
  const f = $('hb-search'); msg('Recherche dans le catalogue Bedsonline (1 appel)…'); $('hb-hotels').replaceChildren();
  const r = await api(`/api/admin/hotelbeds/hotels?destination=${encodeURIComponent(f.destination.value.trim().toUpperCase())}&q=${encodeURIComponent(f.q.value.trim())}&from=${start}`);
  if (!r.ok) { $('hb-next').hidden = true; return msg(say[r.error] ?? 'La recherche n’a pas abouti.', 'err'); }
  from = start; const end = start + r.data.scanned - 1;
  msg(`${r.data.hotels.length} hôtel(s) trouvé(s) parmi les hôtels ${start} à ${end} sur ${r.data.total ?? '?'} de la destination.`);
  $('hb-next').hidden = !(r.data.total && end < r.data.total);
  $('hb-hotels').replaceChildren(...r.data.hotels.map(h => {
    const b = el('button', { type: 'button', className: 'btn', textContent: 'Associer' });
    b.onclick = async () => {
      if (!confirm(`Associer « ${HOTEL.name} » au code Bedsonline ${h.code} :\n${h.name}\n${h.address || 'adresse non fournie'}\n${h.rating ?? ''}\n\nConfirmez-vous qu’il s’agit du même établissement ?`)) return;
      const x = await api('/api/admin/mappings', { action: 'set', hbPlaceId: HOTEL.id, provider: 'hotelbeds', code: h.code, name: h.name, address: h.address });
      msg(x.ok ? 'Association enregistrée : la recherche Bedsonline est active pour cet hôtel.' : 'Échec de l’enregistrement.', x.ok ? 'ok' : 'err'); current();
    };
    return el('div', { className: 'map-item' }, el('span', {}, h.name ?? 'Nom non fourni', el('small', { textContent: [h.rating, h.address, `code ${h.code}`].filter(Boolean).join(' · ') })), b);
  }));
}
$('hb-search').addEventListener('submit', e => { e.preventDefault(); search(1); });
$('hb-next').onclick = () => search(from + 1000);
current();
