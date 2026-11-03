// Administration : hôtel de référence choisi dans le catalogue Halalbooking (partagé par les sections TBO et Bedsonline).
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
window.__admHotel = { id: 4, name: 'Deluxe Golden Horn Sultanahmet', city: 'Istanbul', country: 'Turkey' };
function announce() {
  const h = window.__admHotel;
  $('adm-current').textContent = `Hôtel sélectionné : ${h.name}${h.city ? ' · ' + h.city : ''}${h.country ? ', ' + h.country : ''} (Halalbooking ${h.id})`;
  $('adm-place').value = h.name;
  window.dispatchEvent(new CustomEvent('adminhotel', { detail: h }));
}
async function init() {
  const me = await fetch('/api/admin').then(r => r.ok).catch(() => false);
  if (!me) return;
  $('place-card').hidden = false; $('catalog-card').hidden = false;
  const id = Number(params.get('hotel'));
  if (Number.isSafeInteger(id) && id > 0) {
    const r = await fetch('/api/places/info?id=' + id);
    if (r.ok) { const { place } = await r.json(); window.__admHotel = place; }
    else if (params.get('name')) window.__admHotel = { id, name: params.get('name').slice(0, 200), city: params.get('city'), country: null };
  }
  announce(); catalogState();
}
let timer = null, list = [];
$('adm-place').addEventListener('input', () => {
  const v = $('adm-place').value.trim(); clearTimeout(timer);
  if (v.length < 2) { $('adm-suggest').hidden = true; return; }
  timer = setTimeout(async () => {
    const d = await (await fetch('/api/places/suggest?q=' + encodeURIComponent(v))).json().catch(() => ({ hotels: [] }));
    list = d.hotels ?? [];
    const box = $('adm-suggest');
    box.innerHTML = list.length ? list.map((h, i) => `<li data-i="${i}">${esc(h.name)}<small>${esc([h.city, h.country].filter(Boolean).join(', '))} · Halalbooking ${h.id}</small></li>`).join('') : '<li class="group">Aucun hôtel dans le catalogue : synchronisez-le ou cherchez l’hôtel depuis le comparateur.</li>';
    box.hidden = false;
    box.querySelectorAll('[data-i]').forEach(li => li.onmousedown = e => { e.preventDefault(); window.__admHotel = list[Number(li.dataset.i)]; box.hidden = true; announce(); });
  }, 180);
});
$('adm-place').addEventListener('blur', () => setTimeout(() => { $('adm-suggest').hidden = true; }, 120));

// ---- Synchronisation du catalogue par lots ----
let stop = false;
async function catalogState() {
  const s = await (await fetch('/api/admin/catalog/state')).json().catch(() => null);
  if (!s) return;
  const sync = s.sync ?? {};
  const when = t => new Date(t).toLocaleString('fr-FR');
  const running = sync.nextPage > 1;
  $('cat-state').textContent = `${s.count.toLocaleString('fr-FR')} établissement(s) dans le catalogue. `
    + (running ? `Import automatique en arrière-plan : page ${sync.nextPage}${sync.totalPages ? ' sur ' + sync.totalPages : ''}, dernier lot ${when(sync.lastBatchAt)}. Vous pouvez fermer cette page.` : '')
    + (sync.completedAt ? ` Dernière synchronisation complète : ${when(sync.completedAt)} (renouvelée automatiquement tous les 7 jours).` : running ? '' : ' Import automatique en attente de démarrage.')
    + (sync.lastError ? ` Dernière erreur : ${sync.lastError} (${when(sync.lastErrorAt)}), l’import reprendra seul.` : '');
  return sync;
}
$('cat-sync').onclick = async () => {
  const sync = (await catalogState()) ?? {};
  let from = sync.completedAt ? 1 : sync.nextPage ?? 1;
  stop = false; $('cat-sync').disabled = true; $('cat-stop').hidden = false;
  while (!stop) {
    const r = await fetch('/api/admin/catalog/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { $('cat-state').textContent = `Synchronisation interrompue (${d.error ?? 'erreur'}) à la page ${from}. Relancez pour reprendre.`; break; }
    $('cat-state').textContent = `Import en cours : page ${Math.min(d.nextPage - 1, d.totalPages ?? d.nextPage)} sur ${d.totalPages ?? '?'}…`;
    if (d.done) { await catalogState(); break; }
    from = d.nextPage;
  }
  if (stop) await catalogState();
  $('cat-sync').disabled = false; $('cat-stop').hidden = true;
};
$('cat-stop').onclick = () => { stop = true; };
init();
