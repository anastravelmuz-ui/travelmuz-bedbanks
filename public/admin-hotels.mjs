// Administration : correspondance des hôtels Halalbooking ↔ TBO, validée par un humain.
const $ = id => document.getElementById(id);
const say = { CONFIGURATION_MISSING: 'Identifiants TBO absents dans Cloudflare (TBO_USERNAME, TBO_PASSWORD).', SUPPLIER_AUTH_FAILED: 'TBO refuse les identifiants : vérifiez-les dans Cloudflare.', SUPPLIER_UNREACHABLE: 'TBO est injoignable pour le moment.', INSECURE_ENDPOINT: 'Adresse TBO non sécurisée (HTTPS requis).', INVALID_CRITERIA: 'Critère invalide.', ADMIN_REQUIRED: 'Réservé aux administrateurs.' };
const msg = (text, kind = 'info') => { const m = $('map-msg'); m.textContent = text; m.className = 'msg ' + kind; m.hidden = !text; };
async function api(path, body) {
  try {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data } : { ok: false, error: data.error ?? 'SERVER_ERROR' };
  } catch { return { ok: false, error: 'NETWORK' }; }
}
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const hotelId = () => Number($('map-hotel').value);
let cityCode = null;

async function showCurrent() {
  const r = await api('/api/admin/mappings');
  if (!r.ok) { if (r.error === 'ADMIN_REQUIRED' || r.error === 'AUTHENTICATION_REQUIRED') return; $('mapping').hidden = false; $('map-current').textContent = say[r.error] ?? 'Correspondances indisponibles.'; return; }
  $('mapping').hidden = false;
  const m = r.data.mappings.find(x => x.hbPlaceId === hotelId() && x.provider === 'tbo');
  const box = $('map-current'); box.replaceChildren();
  if (!m) { box.textContent = 'Aucun code TBO associé : la recherche TBO est désactivée pour cet hôtel.'; return; }
  const del = el('button', { type: 'button', className: 'text-button', textContent: 'Retirer l’association' });
  del.onclick = async () => { if (!confirm('Retirer l’association TBO de cet hôtel ?')) return; const x = await api('/api/admin/mappings', { action: 'delete', hbPlaceId: hotelId(), provider: 'tbo', code: m.code }); msg(x.ok ? 'Association retirée.' : say[x.error] ?? 'Échec.', x.ok ? 'ok' : 'err'); showCurrent(); };
  box.append(`Associé au code TBO ${m.code}${m.name ? ' · ' + m.name : ''}${m.address ? ' · ' + m.address : ''} — validé par ${m.validatedBy} le ${new Date(m.validatedAt).toLocaleString('fr-FR')}. `, del);
}

$('map-city-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget; msg('Recherche des villes TBO…');
  $('map-cities').replaceChildren(); $('map-hotels').replaceChildren(); $('map-hotel-form').hidden = true;
  const r = await api(`/api/admin/tbo/cities?country=${encodeURIComponent(f.country.value.trim().toUpperCase())}&q=${encodeURIComponent(f.q.value.trim())}`);
  if (!r.ok) return msg(say[r.error] ?? 'La recherche n’a pas abouti.', 'err');
  if (!r.data.cities.length) return msg('Aucune ville TBO ne correspond.', 'info');
  msg('Choisissez la ville TBO :');
  $('map-cities').replaceChildren(...r.data.cities.map(c => {
    const b = el('button', { type: 'button', className: 'btn secondary', textContent: 'Choisir' });
    b.onclick = () => { cityCode = c.code; $('map-cities').replaceChildren(el('div', { className: 'map-item' }, el('span', {}, `${c.name} `, el('small', { textContent: `code ville TBO ${c.code}` })))); $('map-hotel-form').hidden = false; msg(''); };
    return el('div', { className: 'map-item' }, el('span', { textContent: c.name }), b);
  }));
});

$('map-hotel-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!cityCode) return; msg('Recherche des hôtels TBO… (la liste d’une grande ville peut prendre quelques secondes)');
  const r = await api(`/api/admin/tbo/hotels?city=${encodeURIComponent(cityCode)}&q=${encodeURIComponent(e.currentTarget.q.value.trim())}`);
  if (!r.ok) return msg(say[r.error] ?? 'La recherche n’a pas abouti.', 'err');
  msg(`${r.data.hotels.length} hôtel(s) affiché(s) sur ${r.data.total} dans cette ville. Vérifiez nom, adresse et catégorie avant d’associer.`);
  const target = $('map-hotel').selectedOptions[0].dataset.name;
  $('map-hotels').replaceChildren(...r.data.hotels.map(h => {
    const b = el('button', { type: 'button', className: 'btn', textContent: 'Associer' });
    b.onclick = async () => {
      if (!confirm(`Associer « ${target} » au code TBO ${h.code} :\n${h.name}\n${h.address ?? 'adresse non fournie'}\n${h.rating ?? ''}\n\nConfirmez-vous qu’il s’agit du même établissement ?`)) return;
      const x = await api('/api/admin/mappings', { action: 'set', hbPlaceId: hotelId(), provider: 'tbo', code: h.code, name: h.name, address: h.address });
      msg(x.ok ? 'Association enregistrée. La recherche TBO est active pour cet hôtel.' : say[x.error] ?? 'Échec.', x.ok ? 'ok' : 'err'); showCurrent();
    };
    return el('div', { className: 'map-item' }, el('span', {}, h.name ?? 'Nom non fourni', el('small', { textContent: [h.rating, h.address, `code ${h.code}`].filter(Boolean).join(' · ') })), b);
  }));
});
$('map-hotel').onchange = showCurrent;
showCurrent();
