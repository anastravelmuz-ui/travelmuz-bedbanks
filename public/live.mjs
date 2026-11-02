// Comparateur Halalbooking réel : recherche par chambres (adultes, enfants et âges), net agence fourni, filtres locaux.
import { filterOffers, cancellationState, cutoffLabel } from './live-core.mjs';
import { tboCancellationState } from './tbo-core.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n) : 'Prix non renseigné';
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

let snapshot = null, loading = false;
let tbo = null; // { status, offers, currency…, nationality } ou { error }
const moneyIn = (n, cur) => { try { return typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur || 'EUR' }).format(n) : 'Montant non renseigné'; } catch { return `${n} ${cur ?? ''}`; } };
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
  NATIONALITY_INVALID: 'Choisissez la nationalité du client principal (demandée par TBO).',
  INSECURE_ENDPOINT: 'Adresse TBO non sécurisée : recherche bloquée.',
  SUPPLIER_INVALID_RESPONSE: 'Réponse du fournisseur illisible. Aucun tarif fictif ne la remplace.',
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

// ---- TBO ----
const TBO_ERRORS = {
  CONFIGURATION_MISSING: 'Les accès TBO ne sont pas configurés sur le serveur. Ce n’est pas une absence de chambres.',
  SUPPLIER_AUTH_FAILED: 'TBO a refusé l’accès (identifiants). Ce n’est pas une absence de chambres.',
  SUPPLIER_UNREACHABLE: 'TBO est injoignable pour le moment. Réessayez plus tard. Ce n’est pas une absence de chambres.',
  SUPPLIER_ERROR: 'TBO a renvoyé une erreur. Ce n’est pas une absence de chambres. Aucun tarif fictif ne la remplace.',
  CHILD_AGE_INVALID: 'Âge d’enfant non accepté par TBO.',
};
function tboRules(o) {
  if (o.isRefundable === false) return '<p>Non remboursable selon TBO.</p>';
  if (!o.cancelPolicies?.length) return '<p>Conditions d’annulation non renseignées : à vérifier auprès de TBO.</p>';
  return '<ul>' + o.cancelPolicies.map(p => `<li>${p.roomIndex ? `Chambre ${esc(p.roomIndex)} · ` : ''}à partir du ${esc(p.from ?? 'date non renseignée')} <span class="tbo-warn">(fuseau horaire non précisé par TBO)</span> : ${typeof p.charge === 'number' ? (p.type === 'Percentage' ? `${p.charge} %` : moneyIn(p.charge, o.currency)) : 'frais à vérifier'}${p.type && !['Percentage', 'Fixed'].includes(p.type) ? ` (${esc(p.type)})` : ''}.</li>`).join('') + '</ul>';
}
function tboCard(o) {
  const atProperty = o.supplementsAtProperty ?? [];
  return `<article class="live-card"><div><span class="tag">TBO · staging</span><h3>${o.roomNames.length ? o.roomNames.map((n, i) => o.roomNames.length > 1 ? `Ch. ${i + 1} : ${esc(n)}` : esc(n)).join('<br>') : 'Chambre non renseignée'}</h3>
    <p>${esc(o.meal ?? 'Pension non renseignée')}${o.inclusion ? ' · ' + esc(o.inclusion) : ''}</p>
    <p>${labels[tboCancellationState(o)]}${tboCancellationState(o) === 'unknown' && o.isRefundable ? ' (échéance proche ou fuseau incertain)' : ''}</p>
    ${atProperty.length ? `<p class="tbo-warn">À payer sur place : ${atProperty.map(x => `${esc(x.description ?? 'supplément')} ${moneyIn(x.price, x.currency)}${x.roomIndex ? ` (ch. ${esc(x.roomIndex)})` : ''}`).join(' · ')}</p>` : ''}</div>
    <div class="live-price">${moneyIn(o.price, o.currency)}<small>Montant TBO · total séjour, toutes chambres</small>${typeof o.tax === 'number' ? `<small>dont taxes ${moneyIn(o.tax, o.currency)}</small>` : ''}${o.recommendedSellingRate ? `<small>Prix de vente minimum conseillé : ${moneyIn(o.recommendedSellingRate, o.currency)}</small>` : ''}</div>
    <details><summary>Annulation et détails</summary>${tboRules(o)}${o.promotions?.length ? `<p>Promotions : ${o.promotions.map(esc).join(' · ')}</p>` : ''}${o.withTransfers ? '<p>Transferts inclus.</p>' : ''}<p>Aucune équivalence de chambre avec Halalbooking n’est présumée.</p></details></article>`;
}
function renderTbo() {
  const box = $('#tbo-offers');
  if (!tbo) { box.innerHTML = '<div class="empty">Lancez une recherche.</div>'; return; }
  if (tbo.loading) { box.innerHTML = '<div class="empty">Recherche TBO en cours…</div>'; return; }
  if (tbo.error) { box.innerHTML = `<div class="empty">${esc(TBO_ERRORS[tbo.error] ?? ERRORS[tbo.error] ?? 'La recherche TBO n’a pas abouti. Ce n’est pas une absence de chambres. Aucun tarif fictif ne la remplace.')}</div>`; return; }
  if (tbo.status === 'not_mapped') { box.innerHTML = '<div class="empty">Cet hôtel n’est pas encore associé à un code TBO. Un administrateur peut le faire dans Administration › Correspondance des hôtels.</div>'; return; }
  const f = filters();
  const items = tbo.offers.filter(o => (!f.refund || tboCancellationState(o) === f.refund) && (f.budget === '' || f.budget == null || (typeof o.price === 'number' && o.price <= Number(f.budget))))
    .sort((a, b) => (f.sort === 'desc' ? -1 : 1) * ((a.price ?? Infinity) - (b.price ?? Infinity)));
  if (!tbo.offers.length) { box.innerHTML = '<div class="empty">TBO n’a retourné aucune disponibilité pour ces critères.</div>'; return; }
  box.innerHTML = items.length ? items.map(tboCard).join('') : '<div class="empty">Aucune offre TBO ne correspond à ces filtres.</div>';
}
function renderSummary() {
  const box = $('#provider-summary');
  const parts = [];
  if (snapshot?.offers?.length) {
    const perRoom = snapshot.criteria.rooms.map((_, i) => snapshot.offers.filter(o => (o.roomIndex ?? 0) === i && typeof o.netPrice === 'number').map(o => o.netPrice));
    if (perRoom.every(l => l.length)) parts.push(`<div>Halalbooking · net agence dès<strong>${money(perRoom.reduce((s, l) => s + Math.min(...l), 0))}</strong>offre la moins chère de chaque chambre, EUR</div>`);
  }
  if (tbo?.offers?.length) {
    const cheapest = tbo.offers.filter(o => typeof o.price === 'number').sort((a, b) => a.price - b.price)[0];
    if (cheapest) parts.push(`<div>TBO · montant dès<strong>${moneyIn(cheapest.price, cheapest.currency)}</strong>toutes chambres, ${esc(cheapest.currency ?? 'devise inconnue')} · nature nette à confirmer</div>`);
  }
  box.hidden = !parts.length;
  box.innerHTML = parts.join('') + (parts.length > 1 ? '<div>Comparaison indicative : pensions, chambres, conditions et devises non harmonisées. Aucun meilleur prix n’est désigné.</div>' : '');
}
function render() {
  renderTbo(); renderSummary();
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
  const natChanged = !!(tbo?.nationality && tbo.nationality !== $('#live-nationality').value);
  $('#pending').hidden = !snapshot || (JSON.stringify(criteria()) === JSON.stringify(snapshot.criteria) && !natChanged);
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
  const nationality = $('#live-nationality').value;
  tbo = { loading: true }; renderTbo(); $('#tbo-status').textContent = 'Recherche en cours';
  const tboRun = fetch('/api/tbo/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...q, nationality }) })
    .then(async r => { const d = await r.json().catch(() => ({})); tbo = r.ok ? d : { error: d.detail || d.error || 'SUPPLIER_ERROR' }; })
    .catch(() => { tbo = { error: 'NETWORK' }; })
    .finally(() => {
      $('#tbo-status').textContent = tbo.error ? 'Erreur de recherche' : tbo.status === 'not_mapped' ? 'Hôtel non associé' : `${tbo.offers.length} offre(s) reçue(s) · staging`;
      renderTbo(); renderSummary();
    });
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
    renderSummary();
    await tboRun;
    loading = false; $('#live-submit').disabled = false;
  }
};
guestSummary(); markPending();
setInterval(() => { if (snapshot) render(); }, 60000);
