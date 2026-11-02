// Comparateur Halalbooking réel : recherche par chambres (adultes, enfants et âges), net agence fourni, filtres locaux.
import { filterOffers, cancellationState, cutoffLabel } from './live-core.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n) : 'Prix non renseigné';
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

let snapshot = null, loading = false;
let rooms = [{ adults: 2, children: [] }];
let draft = null;

const MAX_ROOMS = 4, MAX_ADULTS = 6, MAX_CHILDREN = 4, MAX_CHILD_AGE = 12;
const labels = { free: 'Sans frais actuellement', nonref: 'Non remboursable actuellement', fees: 'Annulable avec frais', unknown: 'Conditions à vérifier' };
const ERRORS = {
  CRITERIA_INVALID: 'Vérifiez les dates (futures, 30 nuits maximum) et le pays.',
  ROOMS_INVALID: 'Entre 1 et 4 chambres.',
  ADULTS_INVALID: 'Chaque chambre doit compter de 1 à 6 adultes.',
  CHILDREN_INVALID: '4 enfants maximum par chambre.',
  CHILD_AGE_INVALID: 'Indiquez l’âge de chaque enfant.',
  CHILD_AGE_OVER_12: 'Halalbooking accepte les enfants jusqu’à 12 ans : comptez les plus âgés comme adultes.',
  AUTHENTICATION_REQUIRED: 'Session expirée : reconnectez-vous.',
  CONFIGURATION_MISSING: 'Les accès Halalbooking ne sont pas configurés sur le serveur. Ce n’est pas une absence de chambres.',
  SUPPLIER_AUTH_FAILED: 'Halalbooking a refusé l’accès. Ce n’est pas une absence de chambres.',
  SUPPLIER_UNREACHABLE: 'Halalbooking est injoignable pour le moment. Réessayez plus tard.',
};

const roomLabel = r => `${r.adults} adulte${r.adults > 1 ? 's' : ''}${r.children.length ? ' + ' + r.children.map(a => a === 0 ? 'bébé (< 1 an)' : `enfant ${a} an${a > 1 ? 's' : ''}`).join(', ') : ''}`;
const criteria = () => ({ hotelId: Number($('#live-hotel').value), checkin: $('#live-in').value, checkout: $('#live-out').value, rooms: structuredClone(rooms), country: $('#live-country').value });
const filters = () => ({ meal: $('#live-meal').value, refund: $('#live-refund').value, room: $('#live-room').value, budget: $('#live-budget').value, sort: $('#live-sort').value });

// ---- Voyageurs et chambres ----
function roomsProblem(list) {
  if (!list.length || list.length > MAX_ROOMS) return ERRORS.ROOMS_INVALID;
  for (const r of list) {
    if (!Number.isInteger(r.adults) || r.adults < 1 || r.adults > MAX_ADULTS) return ERRORS.ADULTS_INVALID;
    if (r.children.length > MAX_CHILDREN) return ERRORS.CHILDREN_INVALID;
    if (r.children.some(a => !Number.isInteger(a) || a < 0)) return ERRORS.CHILD_AGE_INVALID;
    if (r.children.some(a => a > MAX_CHILD_AGE)) return ERRORS.CHILD_AGE_OVER_12;
  }
  return '';
}
function guestSummary() {
  const a = rooms.reduce((n, r) => n + r.adults, 0), c = rooms.reduce((n, r) => n + r.children.length, 0);
  $('#live-guests').innerHTML = `${a} adulte${a > 1 ? 's' : ''}${c ? ` · ${c} enfant${c > 1 ? 's' : ''}` : ''} · ${rooms.length} ch. <span>⌄</span>`;
}
function drawGuests() {
  $('#room-editors').innerHTML = draft.map((r, i) => `<div class="room-editor"><h3>Chambre ${i + 1}${draft.length > 1 ? `<button type="button" class="text-button" data-remove-room="${i}">Retirer</button>` : ''}</h3>
    <div class="form-grid"><label>Adultes<input data-adults="${i}" type="number" min="1" max="${MAX_ADULTS}" value="${r.adults}"></label>
    <label>Enfants (0–12 ans)<input data-children="${i}" type="number" min="0" max="${MAX_CHILDREN}" value="${r.children.length}"></label></div>
    ${r.children.length ? `<div class="ages">${r.children.map((a, j) => `<label>Âge enfant ${j + 1}<input aria-label="Âge enfant ${j + 1}, chambre ${i + 1}" data-age="${i}-${j}" type="number" min="0" max="${MAX_CHILD_AGE}" value="${Number.isInteger(a) ? a : ''}"></label>`).join('')}</div><p class="subtle">0 = moins d’un an. Âge à la date de départ.</p>` : ''}</div>`).join('');
  $('#add-room').disabled = draft.length >= MAX_ROOMS;
  $$('[data-adults]').forEach(el => el.oninput = () => { draft[+el.dataset.adults].adults = el.value === '' ? NaN : Number(el.value); });
  $$('[data-age]').forEach(el => el.oninput = () => { const [i, j] = el.dataset.age.split('-').map(Number); draft[i].children[j] = el.value === '' ? NaN : Number(el.value); });
  $$('[data-children]').forEach(el => el.onchange = () => {
    const n = Number(el.value), r = draft[+el.dataset.children];
    if (!Number.isInteger(n) || n < 0 || n > MAX_CHILDREN) { el.value = r.children.length; return; }
    if (n === r.children.length) return;
    r.children = Array.from({ length: n }, (_, k) => r.children[k] ?? NaN); setTimeout(drawGuests); // hors de l'événement : évite un redessin pendant la perte de focus
  });
  $$('[data-remove-room]').forEach(el => el.onclick = () => { draft.splice(+el.dataset.removeRoom, 1); drawGuests(); });
}
$('#live-guests').onclick = () => { draft = structuredClone(rooms); $('#guest-error').textContent = ''; drawGuests(); $('#modal').showModal(); };
$('#add-room').onclick = () => { draft.push({ adults: 2, children: [] }); drawGuests(); };
$('#close-modal').onclick = () => $('#modal').close();
$('#guest-save').onclick = () => {
  const err = roomsProblem(draft);
  $('#guest-error').textContent = err;
  if (err) return;
  rooms = structuredClone(draft); guestSummary(); $('#modal').close(); markPending();
};

// ---- Affichage des offres ----
function rulesText(rules) {
  if (!Array.isArray(rules) || !rules.length) return '<p>Conditions non renseignées : à vérifier auprès du fournisseur.</p>';
  return '<ul>' + rules.map((r, i) => {
    const period = r.until ? `${i ? 'Puis, avant' : 'Avant'} le ${cutoffLabel(r.until)} (échéance exclue)` : 'Après l’échéance précédente, ou dès maintenant si aucune échéance';
    const fee = typeof r.penalty === 'number' ? (r.penalty === 0 ? 'aucun frais' : `${r.penalty} % ${r.nights ? `des ${r.nights} première(s) nuit(s)` : 'du séjour'}`) : 'pénalité à vérifier';
    return `<li>${esc(period)} : ${esc(fee)}${typeof r.penalty_amount === 'number' ? ` — ${money(r.penalty_amount)}` : ''}.</li>`;
  }).join('') + '</ul>';
}
function netBlock(o) {
  if (typeof o.netPrice !== 'number') return '<small>Net agence non fourni par Halalbooking</small>';
  const rate = o.commissionRate != null ? String(o.commissionRate).replace('.', ',') + ' %' : 'commission non lisible';
  return o.netSource === 'supplier'
    ? `<span class="net-estimate">Net agence : ${money(o.netPrice)}</span><small>Fourni par Halalbooking · commission ${esc(rate)}${typeof o.commissionAmount === 'number' ? ` (${money(o.commissionAmount)})` : ''}</small>`
    : `<span class="net-estimate">Net agence estimé : ${money(o.netPrice)}</span><small>Net non fourni : prix − commission ${esc(rate)}, à reconfirmer</small>`;
}
function card(o) {
  const mismatch = o.group && o.requestedGroup && o.group !== o.requestedGroup;
  return `<article class="live-card"><div><span class="tag">Halalbooking · offre réelle</span><h3>${esc(o.room ?? 'Chambre non renseignée')}</h3>
    <p>${esc(o.meal ?? 'Pension non renseignée')} · ${esc(o.quantity ?? '?')} logement(s)${o.confirmation === 'delayed' ? ' · confirmation sous 24 h' : ''}</p>
    <p>${labels[cancellationState(o.cancellation)]}</p>${mismatch ? `<p class="error">Occupation renvoyée (${esc(o.group)}) différente de la demande (${esc(o.requestedGroup)}) : à vérifier.</p>` : ''}</div>
    <div class="live-price">${money(o.price)}<small>Prix public · total du séjour pour cette chambre</small>${netBlock(o)}</div>
    <details><summary>Chambre, commission et conditions</summary>
    <p>${esc(o.description ?? 'Description physique non fournie. Aucune équivalence avec une autre chambre n’est présumée.')}</p>
    ${o.inclusions?.length ? `<p>Inclus : ${o.inclusions.map(esc).join(' · ')}</p>` : ''}
    <p>Commission annoncée : ${o.commissionPercent != null ? esc(o.commissionPercent) + ' %' : 'non renseignée'}. Prix de recherche : commission et net peuvent évoluer à la vérification ou à la réservation. Frais payables sur place non inclus dans le net.</p>
    ${rulesText(o.cancellation)}<p>Horaires et décalages UTC fournis par Halalbooking, conservés sans conversion.</p></details></article>`;
}
function render() {
  if (!snapshot) return;
  const items = filterOffers(snapshot.offers, filters());
  $('#result-count').textContent = `${items.length} offre(s) affichée(s) sur ${snapshot.offers.length} reçue(s)`;
  if (!items.length) {
    $('#live-offers').innerHTML = '<div class="empty">' + (snapshot.offers.length ? 'Aucune offre reçue ne correspond à ces filtres. Effacez les filtres pour retrouver la liste.' : 'Halalbooking n’a retourné aucune offre pour ces critères.') + '</div>';
    return;
  }
  const many = snapshot.criteria.rooms.length > 1;
  $('#live-offers').innerHTML = snapshot.criteria.rooms.map((r, i) => {
    const list = items.filter(o => (o.roomIndex ?? 0) === i);
    const head = many ? `<h3 class="room-group">Chambre ${i + 1} · ${esc(roomLabel(r))}</h3>` : '';
    return head + (list.length ? list.map(card).join('') : `<div class="empty">Aucune offre affichée pour la chambre ${i + 1}${snapshot.offers.some(o => (o.roomIndex ?? 0) === i) ? ' avec ces filtres' : ' : Halalbooking n’a rien proposé pour cette occupation'}.</div>`);
  }).join('');
}
function clearFilters() { for (const id of ['meal', 'refund', 'room', 'budget']) $('#live-' + id).value = ''; $('#live-sort').value = 'asc'; render(); }
function markPending() {
  const n = nightsBetween($('#live-in').value, $('#live-out').value);
  $('#live-nights').textContent = Number.isFinite(n) && n > 0 ? `${n} nuit${n > 1 ? 's' : ''}` : 'Dates à vérifier';
  $('#pending').hidden = !snapshot || JSON.stringify(criteria()) === JSON.stringify(snapshot.criteria);
}

$('#clear').onclick = clearFilters;
for (const id of ['meal', 'refund', 'room', 'budget', 'sort']) $('#live-' + id).addEventListener('input', render);
$('#live-search').addEventListener('input', markPending);
$('#live-search').onsubmit = async e => {
  e.preventDefault();
  if (loading) return;
  const err = roomsProblem(rooms);
  if (err) { $('#live-error').textContent = err; return; }
  loading = true;
  const q = criteria();
  snapshot = null;
  $('#live-offers').innerHTML = ''; $('#result-count').textContent = ''; $('#criteria').textContent = '';
  $('#results-title').textContent = 'Recherche Halalbooking'; $('#pending').hidden = true; $('#live-error').textContent = '';
  $('#live-status').textContent = 'Recherche en cours…'; $('#hb-status').textContent = 'Recherche en cours'; $('#live-submit').disabled = true;
  try {
    const r = await fetch('/api/halalbooking/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || 'SUPPLIER_ERROR');
    snapshot = data;
    $('#results-title').textContent = data.offers[0]?.hotel ?? 'Résultats Halalbooking';
    const n = nightsBetween(q.checkin, q.checkout);
    $('#criteria').textContent = `${q.checkin} → ${q.checkout} · ${n} nuit${n > 1 ? 's' : ''} · ${q.rooms.map((x, i) => `ch. ${i + 1} : ${roomLabel(x)}`).join(' ; ')} · pays ${q.country}`;
    $('#live-status').textContent = `Relevé du ${new Date(data.observedAt).toLocaleString('fr-FR', { timeZone: 'Africa/Casablanca' })} (heure Maroc) · prix à reconfirmer chez le fournisseur.`;
    $('#hb-status').textContent = `${data.offers.length} offre(s) reçue(s)`;
    $('#live-meal').innerHTML = '<option value="">Toutes les pensions</option>' + [...new Set(data.offers.map(o => o.meal).filter(Boolean))].map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    $('#live-room').innerHTML = '<option value="">Toutes les chambres</option>' + [...new Map(data.offers.filter(o => o.roomId != null).map(o => [String(o.roomId), o.room])).entries()].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    clearFilters();
    markPending();
  } catch (err) {
    $('#live-error').textContent = ERRORS[err.message] ?? 'La recherche n’a pas abouti. Aucun tarif fictif ne remplace la réponse.';
    $('#hb-status').textContent = 'Erreur de recherche';
    $('#live-status').textContent = 'Aucun résultat exploitable pour cette recherche.';
  } finally {
    loading = false; $('#live-submit').disabled = false;
  }
};
guestSummary(); markPending();
setInterval(() => { if (snapshot) render(); }, 60000);
