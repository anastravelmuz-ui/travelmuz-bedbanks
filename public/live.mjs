// Comparateur réel multi-fournisseurs : présentation en cartouches de la maquette ChatGPT, données Halalbooking et TBO.
import { filterOffers, cancellationState, cutoffLabel } from './live-core.mjs';
import { tboCancellationState, parseTboDate } from './tbo-core.mjs';
import { hbPanel, tboPanel, bedsPanel, rhPanel, rhCancellationState, comparePanels } from './compare-core.mjs';
import { hbedsFreeUntil } from './hotelbeds-core.mjs';
import { MEAL_LABELS } from './meal-core.mjs';
import { assessPanel, bookingMeal } from './rebook-core.mjs';
import { convertToEur } from './fx-core.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n) : 'Prix non renseigné';
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

let snapshot = null, loading = false, hbState = null; // hbState : null | 'loading' | code d'erreur
let tbo = null; // { status, offers, currency…, nationality } ou { error }
let beds = null; // Bedsonline : même forme
let rh = null; // RateHawk (ETG) : même forme
// Conversion indicative (taux BCE) des montants hors EUR : affichée sous le prix d'origine, jamais utilisée pour comparer.
let fx = null; // null | 'loading' | { date, rates } | { error }
const fxDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('/') : 'date inconnue';
function fxHtml(n, cur, compact = false) {
  const c = typeof cur === 'string' ? cur.trim().toUpperCase() : '';
  if (c === 'EUR' || typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (!c) return '<div class="fx-line">Devise non renseignée : pas d’équivalent EUR.</div>';
  if (fx === null || fx === 'loading') return '<div class="fx-line">Conversion en EUR en cours…</div>';
  if (fx.error) return '<div class="fx-line">Équivalent EUR indisponible (taux BCE non récupéré).</div>';
  const v = convertToEur(n, c, fx);
  if (!v) return `<div class="fx-line">Équivalent EUR indisponible : pas de taux BCE pour ${esc(c)}.</div>`;
  const rate = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 }).format(v.rate);
  return `<div class="fx-line"><strong>≈ ${money(v.amount)}</strong> ${compact ? '' : '<br>'}converti au taux BCE du ${fxDate(v.date)} (1 EUR = ${esc(rate)} ${esc(c)}) · indicatif, hors frais de change</div>`;
}
function ensureFx() {
  if (fx !== null) return;
  const foreign = [tbo, rh, beds].some(r => r?.offers?.some(o => o.currency && o.currency !== 'EUR'));
  if (!foreign) return;
  fx = 'loading';
  fetch('/api/fx').then(r => r.ok ? r.json() : { error: 'FX_UNAVAILABLE' }).catch(() => ({ error: 'FX_UNAVAILABLE' })).then(d => { fx = d?.rates ? d : { error: d?.error ?? 'FX_UNAVAILABLE' }; render(); });
}
const moneyIn = (n, cur) => { try { return typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur || 'EUR' }).format(n) : 'Montant non renseigné'; } catch { return `${n} ${cur ?? ''}`; } };
let rooms = [{ adults: 2, children: [] }];
let draft = null;
let dossierNotes = [];
let dossier = null; // dossier de réservation comparé (/?dossier=<id>)

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
// Lieu choisi : un hôtel (id Halalbooking) ou une destination (texte anglais transmis à Halalbooking).
let place = { type: 'hotel', id: 4, name: 'Deluxe Golden Horn Sultanahmet', city: 'Istanbul', country: 'Turkey' };
const criteria = () => ({ hotelId: place.type === 'hotel' ? place.id : null, checkin: $('#live-in').value, checkout: $('#live-out').value, rooms: structuredClone(rooms), country: $('#live-country').value });
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
    ${o.photos?.length ? `<div class="room-photos">${o.photos.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="${esc(o.room ?? 'Chambre')} · photo ${i + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : ''}
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
function tboPhotos(o) {
  const imgs = (o.roomDetails ?? []).flatMap((d, i) => (d?.images ?? []).map(u => ({ u, label: `${o.roomNames[i] ?? d.name ?? 'Chambre'}` })));
  const unique = [...new Map(imgs.map(x => [x.u, x])).values()].slice(0, 8);
  const byName = (o.roomDetails ?? []).some(d => d?.matchedBy === 'name');
  return unique.length ? `${byName ? '<p class="subtle">Photos de la fiche TBO portant le même intitulé de chambre.</p>' : ''}<div class="room-photos">${unique.map((x, k) => `<a href="${esc(x.u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(x.u)}" alt="${esc(x.label)} · photo ${k + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : '';
}
function tboRoomFacts(o) {
  const facts = (o.roomDetails ?? []).map((d, i) => d && (d.size || d.description) ? `<p>${o.roomNames.length > 1 ? `Ch. ${i + 1} · ` : ''}${d.size ? `Superficie TBO : ${esc(d.size)}` : ''}${d.size && d.description ? ' · ' : ''}${d.description ? esc(d.description) : ''}</p>` : '').join('');
  return facts || '<p>Fiche chambre TBO non disponible : superficie et literie à vérifier.</p>';
}
function tboCard(o) {
  const atProperty = o.supplementsAtProperty ?? [];
  return `<article class="live-card"><div><span class="tag">TBO · staging</span><h3>${o.roomNames.length ? o.roomNames.map((n, i) => o.roomNames.length > 1 ? `Ch. ${i + 1} : ${esc(n)}` : esc(n)).join('<br>') : 'Chambre non renseignée'}</h3>
    <p>${esc(o.meal ?? 'Pension non renseignée')}${o.inclusion ? ' · ' + esc(o.inclusion) : ''}</p>
    <p>${labels[tboCancellationState(o)]}${tboCancellationState(o) === 'unknown' && o.isRefundable ? ' (échéance proche ou fuseau incertain)' : ''}</p>
    ${atProperty.length ? `<p class="tbo-warn">À payer sur place : ${atProperty.map(x => `${esc(x.description ?? 'supplément')} ${moneyIn(x.price, x.currency)}${x.roomIndex ? ` (ch. ${esc(x.roomIndex)})` : ''}`).join(' · ')}</p>` : ''}</div>
    <div class="live-price">${moneyIn(o.price, o.currency)}<small>Montant TBO · total séjour, toutes chambres</small>${fxHtml(o.price, o.currency, true)}${typeof o.tax === 'number' ? `<small>dont taxes ${moneyIn(o.tax, o.currency)}</small>` : ''}${o.recommendedSellingRate ? `<small>Prix de vente minimum conseillé : ${moneyIn(o.recommendedSellingRate, o.currency)}</small>` : ''}</div>
    ${tboPhotos(o)}
    <details><summary>Chambre, annulation et détails</summary>${tboRoomFacts(o)}${tboRules(o)}${o.promotions?.length ? `<p>Promotions : ${o.promotions.map(esc).join(' · ')}</p>` : ''}${o.withTransfers ? '<p>Transferts inclus.</p>' : ''}<p>Aucune équivalence de chambre avec Halalbooking n’est présumée.</p></details></article>`;
}

// ---- Cartouches fournisseurs ----
const PROVIDERS = [
  { id: 'halalbooking', name: 'Halalbooking', letter: 'H' },
  { id: 'tbo', name: 'TBO', letter: 'T' },
  { id: 'ratehawk', name: 'RateHawk', letter: 'R' },
  { id: 'bedsonline', name: 'Bedsonline', letter: 'B' },
];
let panels = {};
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

function hbCondition(p) {
  if (p.state === 'free') {
    const until = p.pick.map(o => (o.cancellation ?? []).find(r => r.penalty === 0 && r.until)?.until).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    return `<p class="condition">✓ Sans frais avant le ${esc(cutoffLabel(until))}</p>`;
  }
  return `<p class="condition warn">${esc(labels[p.state])}</p>`;
}
function tboCondition(o) {
  if (o.state === 'free') {
    const first = (o.cancelPolicies ?? []).filter(r => r.charge > 0).sort((a, b) => parseTboDate(a.from) - parseTboDate(b.from))[0];
    return `<p class="condition">✓ Sans frais avant le ${esc(first?.from ?? '?')} <span class="tbo-warn">(fuseau non précisé)</span></p>`;
  }
  return `<p class="condition warn">${esc(labels[o.state])}</p>`;
}
const mealLine = (label, code) => `<p>♧ ${esc(label ?? (code ? MEAL_LABELS[code] : 'Pension non renseignée'))}</p>`;

function panelBody(id) {
  const nRooms = rooms.length;
  if (id === 'ratehawk') return rhBody(nRooms);
  if (id === 'bedsonline') return bedsBody(nRooms);
  if (id === 'halalbooking') {
    if (!hbState && !snapshot) return { top: 'OFFRES RÉELLES', html: '<div class="state">Prêt à rechercher.</div>' };
    if (hbState === 'loading') return { top: 'OFFRES RÉELLES', html: '<div class="state">Recherche en cours…</div>' };
    if (hbState) return { top: 'ERREUR FOURNISSEUR', html: `<div class="state">${esc(ERRORS[hbState] ?? 'La recherche n’a pas abouti. Ce n’est pas une absence de chambres. Aucun tarif fictif ne la remplace.')}</div>` };
    const p = panels.halalbooking;
    if (!p.received) return { top: 'OFFRES RÉELLES', html: '<div class="state">Halalbooking n’a retourné aucune offre pour ces critères.</div>' };
    if (!p.total) return { top: 'OFFRES RÉELLES', count: p.offers.length, html: `<div class="state">${p.missingRoom != null && p.offers.length ? `Aucune offre avec net agence pour la chambre ${p.missingRoom + 1} avec ces filtres : pas de total partiel.` : 'Aucune offre ne correspond à ces filtres.'}</div>` };
    return { top: 'OFFRES RÉELLES', count: p.offers.length, html: `<div class="price">${money(p.total).replace('€', '<small>€</small>')}</div>
      <div class="price-label">Net agence · total séjour · ${plural(nRooms, 'chambre')}</div>${p.publicTotal ? `<div class="secondary-amount">Prix public ${money(p.publicTotal)}${p.netConfirmed ? '' : ' · net estimé'}</div>` : ''}
      <div class="room-info">${p.pick[0].photos?.[0] ? `<img class="panel-photo" src="${esc(p.pick[0].photos[0])}" alt="${esc(p.pick[0].room ?? 'Chambre')}" loading="lazy" referrerpolicy="no-referrer">` : ''}<strong>${p.pick.map((o, i) => (nRooms > 1 ? `Ch. ${i + 1} : ` : '') + esc(o.room ?? 'Chambre non renseignée')).join('<br>')}</strong>
      ${mealLine(new Set(p.pick.map(o => o.meal)).size === 1 ? p.pick[0].meal : 'Pensions différentes selon la chambre', p.mealCode)}${hbCondition(p)}<p>Net fourni par Halalbooking · hors frais payables sur place</p></div>` };
  }
  // TBO
  if (!tbo) return { top: 'STAGING · DONNÉES DE TEST', html: '<div class="state">Prêt à rechercher.</div>' };
  if (tbo.loading) return { top: 'STAGING · DONNÉES DE TEST', html: '<div class="state">Recherche en cours…</div>' };
  if (tbo.error) return { top: 'ERREUR FOURNISSEUR', html: `<div class="state">${esc(TBO_ERRORS[tbo.error] ?? ERRORS[tbo.error] ?? 'La recherche TBO n’a pas abouti. Ce n’est pas une absence de chambres.')}</div>` };
  if (tbo.status === 'not_mapped') return { top: 'STAGING · DONNÉES DE TEST', html: `<div class="state">Hôtel pas encore associé à un code TBO. ${mapLink('tbo')}</div>` };
  if (tbo.status === 'currency_not_eur') return { top: 'DEVISE NON CONFORME', html: `<div class="state">TBO renvoie des tarifs en ${esc(tbo.currency)} (devise du compte TBO). L’euro est imposé : ${plural(tbo.hidden ?? 0, 'offre')} masquée(s), sans conversion. Demandez à TBO de configurer votre compte en EUR.</div>` };
  const p = panels.tbo;
  if (!p.received) return { top: 'STAGING · DONNÉES DE TEST', html: '<div class="state">TBO n’a retourné aucune disponibilité pour ces critères.</div>' };
  if (!p.pick) return { top: 'STAGING · DONNÉES DE TEST', count: 0, html: '<div class="state">Aucune offre ne correspond à ces filtres.</div>' };
  const o = p.pick[0], atProperty = o.supplementsAtProperty ?? [];
  const amount = p.currency === 'EUR' ? money(p.total).replace('€', '<small>€</small>') : esc(moneyIn(p.total, p.currency));
  return { top: p.currency === 'EUR' ? 'STAGING · DONNÉES DE TEST' : `STAGING · DEVISE ${p.currency ?? '?'} (TEST)`, count: p.offers.length, html: `<div class="price">${amount}</div>${fxHtml(p.total, p.currency)}
    <div class="price-label">Montant TBO · total séjour · ${plural(nRooms, 'chambre')}</div><div class="secondary-amount">Nature nette à confirmer avec TBO</div>${tbo.mapping?.code ? `<div class="secondary-amount">Hôtel TBO interrogé : <strong>${esc(tbo.mapping.name ?? 'nom non enregistré')}</strong> (code ${esc(tbo.mapping.code)})${isAdmin ? ' · <a href="/admin.html">modifier l’association</a>' : ''}</div>` : ''}${p.currency !== 'EUR' ? `<div class="secondary-amount tbo-warn">Devise ${esc(p.currency ?? 'inconnue')} : affichée temporairement pour les tests ; équivalent EUR indicatif, non comparé.</div>` : ''}
    <div class="room-info">${o.roomDetails?.find(d => d?.images?.length) ? `<img class="panel-photo" src="${esc(o.roomDetails.find(d => d?.images?.length).images[0])}" alt="${esc(o.roomNames[0] ?? 'Chambre')}" loading="lazy" referrerpolicy="no-referrer">` : ''}<strong>${o.roomNames.length ? o.roomNames.map((n, i) => (o.roomNames.length > 1 ? `Ch. ${i + 1} : ` : '') + esc(n)).join('<br>') : 'Chambre non renseignée'}</strong>
    ${mealLine(o.meal, o.mealCode)}${tboCondition(o)}<p>${typeof o.tax === 'number' ? `Dont taxes ${moneyIn(o.tax, o.currency)}` : 'Taxes non détaillées'}${atProperty.length ? ` · <span class="tbo-warn">à payer sur place : ${atProperty.map(x => `${esc(x.description ?? 'supplément')} ${moneyIn(x.price, x.currency)}`).join(', ')}</span>` : ''}</p></div>` };
}


let isAdmin = false;
fetch('/api/auth/me').then(r => r.json()).then(d => { isAdmin = d.user?.role === 'admin'; render(); }).catch(() => {});
const mapLink = (provider) => isAdmin
  ? `<button type="button" class="btn-match" data-match="${provider}">Trouver l’hôtel ${{ tbo: 'TBO', ratehawk: 'RateHawk' }[provider] ?? 'Bedsonline'} →</button>`
  : 'Un administrateur peut l’associer.';

// ---- Suggestions de correspondance (administrateurs) : nom + GPS, validation en un clic ----
async function openMatch(provider) {
  const label = { tbo: 'TBO', ratehawk: 'RateHawk' }[provider] ?? 'Bedsonline';
  const key = { tbo: 'tbo', ratehawk: 'ratehawk' }[provider] ?? 'hotelbeds';
  $('#offers-title').innerHTML = `<h2>Associer à ${label}</h2><p>${esc(place.name)} · suggestions par nom et position GPS · aucune association sans votre validation</p>`;
  $('#offers-body').innerHTML = '<div class="empty">Recherche des correspondances… (la première fois pour une ville, le catalogue fournisseur est téléchargé puis gardé 15 jours)</div>';
  $('#offers-modal').showModal();
  const r = await fetch(`/api/admin/match?hotel=${encodeURIComponent(place.id)}&provider=${key}`);
  const d = await r.json().catch(() => ({}));
  const why = { CITY_NOT_FOUND: `Ville « ${esc(d.source?.city ?? '?')} » introuvable chez ${label} : utilisez l’association manuelle dans l’Administration.`, COUNTRY_UNKNOWN: 'Pays non reconnu : association manuelle nécessaire.', QUOTA_EXCEEDED: 'Quota Bedsonline atteint pour aujourd’hui.', CONFIGURATION_MISSING: `Accès ${label} non configurés.` };
  if (!r.ok) { $('#offers-body').innerHTML = `<div class="empty">${why[d.error] ?? 'Suggestions indisponibles pour le moment.'} <a href="/admin.html?hotel=${encodeURIComponent(place.id)}#place-card">Association manuelle</a></div>`; return; }
  const src = d.source;
  const fmtD = m => (m == null ? 'distance inconnue' : m < 1000 ? `à ${m} m` : `à ${(m / 1000).toFixed(1).replace('.', ',')} km`);
  $('#offers-body').innerHTML = `<p class="subtle">Halalbooking : ${esc(src.name)} · ${esc(src.address ?? src.city ?? '')}${src.lat == null ? ' · coordonnées GPS non disponibles (nom seul)' : ''}. ${d.scanned} hôtels ${label} analysés (${esc(d.city.name)}).</p>`
    + (d.noneNearby ? `<p class="msg info">Aucun hôtel ${label} à moins de 1 km : l’établissement est peut-être absent du catalogue ${label}, ou classé sous un autre nom. N’associez que si vous êtes certain qu’il s’agit du même hôtel. <a href="/admin.html?hotel=${encodeURIComponent(place.id)}#place-card">Recherche manuelle</a></p>` : '')
    + (d.candidates.length ? d.candidates.map(c => `<article class="live-card match-card${c.strong ? ' strong' : ''}"><div><span class="tag">${c.strong ? 'Très probable · même nom, moins de 250 m' : `Ressemblance ${Math.round(c.nameScore * 100)} %`}</span><h3>${esc(c.name ?? 'Nom non fourni')}</h3>
      <p>${esc(c.address ?? 'Adresse non fournie')}</p><p>${esc(c.rating ?? '')} · ${fmtD(c.distanceM)} · ${esc((c.city ?? '').replace(/\s+/g, ' '))} · code ${esc(c.code)}</p></div>
      <div class="live-price"><button type="button" class="btn-compare" data-assoc="${esc(c.code)}">Associer</button></div></article>`).join('')
      : `<div class="empty">Aucun hôtel ${label} suffisamment proche par le nom ou la position.</div>`);
  $$('#offers-body [data-assoc]').forEach(b => b.onclick = async () => {
    const c = d.candidates.find(x => x.code === b.dataset.assoc);
    if (!confirm(`Associer « ${place.name} » au code ${label} ${c.code} :\n${c.name}\n${c.address ?? ''}\n${fmtD(c.distanceM)}\n\nConfirmez-vous qu’il s’agit du même établissement ?`)) return;
    b.disabled = true;
    const x = await fetch('/api/admin/mappings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', hbPlaceId: place.id, provider: key, code: c.code, name: c.name, address: c.address }) });
    if (!x.ok) { b.disabled = false; alert('Échec de l’enregistrement.'); return; }
    $('#offers-modal').close();
    rerunProvider(provider);
  });
}
async function rerunProvider(provider) {
  const q = criteria(), nationality = $('#live-nationality').value;
  const url = { tbo: '/api/tbo/search', ratehawk: '/api/ratehawk/search' }[provider] ?? '/api/bedsonline/search';
  const withNat = provider === 'tbo' || provider === 'ratehawk';
  if (provider === 'tbo') tbo = { loading: true }; else if (provider === 'ratehawk') rh = { loading: true }; else beds = { loading: true };
  render();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withNat ? { ...q, nationality } : q) });
  const d = await r.json().catch(() => ({}));
  const v = r.ok ? d : { error: d.detail || d.error || 'SUPPLIER_ERROR' };
  if (provider === 'tbo') tbo = v; else if (provider === 'ratehawk') rh = v; else beds = v;
  render();
}
// ---- RateHawk (ETG) ----
const RH_ERRORS = {
  CONFIGURATION_MISSING: 'Les accès RateHawk (RATEHAWK_KEY_ID, RATEHAWK_API_KEY) ne sont pas configurés sur le serveur. Ce n’est pas une absence de chambres.',
  SUPPLIER_AUTH_FAILED: 'RateHawk a refusé l’accès : clé ou environnement (bac à sable / production) à vérifier. Ce n’est pas une absence de chambres.',
  QUOTA_EXCEEDED: 'Limite de requêtes RateHawk atteinte : réessayez dans une minute. Ce n’est pas une absence de chambres.',
  SUPPLIER_UNREACHABLE: 'RateHawk est injoignable pour le moment. Ce n’est pas une absence de chambres.',
  SUPPLIER_ERROR: 'RateHawk a renvoyé une erreur. Ce n’est pas une absence de chambres. Aucun tarif fictif ne la remplace.',
};
const rhTop = () => (rh?.environment === 'production' ? 'OFFRES RÉELLES' : 'BAC À SABLE · DONNÉES DE TEST');
const fmtUtcDate = iso => new Date(iso).toLocaleString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC';
function rhCondition(o) {
  const st = rhCancellationState(o);
  return `<p class="condition">${labels[st]}${st === 'free' ? ' jusqu’au ' + esc(fmtUtcDate(o.freeCancellationBefore)) : ''}</p>`;
}
function rhBody(nRooms) {
  if (!rh) return { top: rhTop(), html: '<div class="state">Prêt à rechercher.</div>' };
  if (rh.loading) return { top: rhTop(), html: '<div class="state">Recherche en cours…</div>' };
  if (rh.error) return { top: 'ERREUR FOURNISSEUR', html: `<div class="state">${esc(RH_ERRORS[rh.error] ?? ERRORS[rh.error] ?? RH_ERRORS.SUPPLIER_ERROR)}</div>` };
  if (rh.status === 'not_mapped') return { top: rhTop(), html: `<div class="state">Hôtel pas encore associé à un identifiant RateHawk. ${mapLink('ratehawk')}</div>` };
  if (rh.status === 'currency_not_eur') return { top: 'DEVISE NON CONFORME', html: `<div class="state">RateHawk renvoie des tarifs en ${esc(rh.currency)} : l’euro est imposé, ${plural(rh.hidden ?? 0, 'offre')} masquée(s), sans conversion.</div>` };
  const p = panels.ratehawk;
  if (!p?.received) return { top: rhTop(), html: '<div class="state">RateHawk n’a retourné aucune disponibilité pour ces critères.</div>' };
  if (!p.pick) return { top: rhTop(), count: 0, html: '<div class="state">Aucune offre ne correspond à ces filtres.</div>' };
  const o = p.pick[0];
  const amount = p.currency === 'EUR' ? money(p.total).replace('€', '<small>€</small>') : esc(moneyIn(p.total, p.currency));
  return { top: rhTop(), count: p.offers.length, html: `<div class="price">${amount}</div>${fxHtml(p.total, p.currency)}
    <div class="price-label">${p.netConfirmed ? 'Net agence' : 'Montant à payer'} · total séjour · ${plural(nRooms, 'chambre')}</div>${typeof o.gross === 'number' && o.gross !== o.net ? `<div class="secondary-amount">Prix brut ${esc(moneyIn(o.gross, o.currency))}</div>` : ''}
    <div class="room-info"><strong>${esc(o.roomName ?? 'Chambre non renseignée')}</strong>${mealLine(o.mealCode ? null : o.meal, o.mealCode)}${rhCondition(o)}<p>${o.taxesAtHotel.length ? `<span class="tbo-warn">À payer sur place : ${o.taxesAtHotel.map(t => `${esc(t.name ?? 'taxe')} ${esc(moneyIn(t.amount, t.currency))}`).join(', ')}</span>` : 'Aucune taxe à payer sur place indiquée'}</p></div>` };
}
function rhCard(o) {
  return `<article class="live-card"><div><span class="tag">RateHawk · ${rh?.environment === 'production' ? 'production' : 'bac à sable'}</span><h3>${esc(o.roomName ?? 'Chambre non renseignée')}</h3>
    <p>${esc(MEAL_LABELS[o.mealCode] ?? o.meal ?? 'Pension non renseignée')}</p>${rhCondition(o)}
    ${o.taxesAtHotel.length ? `<p class="tbo-warn">À payer sur place : ${o.taxesAtHotel.map(t => `${esc(t.name ?? 'taxe')} ${esc(moneyIn(t.amount, t.currency))}`).join(' · ')}</p>` : ''}
    ${o.cancellation.length ? `<details><summary>Pénalités d’annulation (UTC)</summary><ul>${o.cancellation.map(c => `<li>${c.start ? 'du ' + esc(fmtUtcDate(c.start)) : 'dès la réservation'}${c.end ? ' au ' + esc(fmtUtcDate(c.end)) : ''} : ${esc(moneyIn(c.amount, o.currency))}</li>`).join('')}</ul><p>Aucune équivalence de chambre avec Halalbooking n’est présumée.</p></details>` : ''}</div>
    <div class="live-price">${esc(moneyIn(o.net, o.currency))}<small>${o.netFromSupplier ? 'Net agence' : 'Montant à payer'} · total séjour, toutes chambres</small>${fxHtml(o.net, o.currency, true)}${typeof o.gross === 'number' && o.gross !== o.net ? `<small>Prix brut ${esc(moneyIn(o.gross, o.currency))}</small>` : ''}</div></article>`;
}

// ---- Bedsonline / Hotelbeds ----
const BEDS_ERRORS = {
  CONFIGURATION_MISSING: 'Les accès Bedsonline (HOTELBEDS_API_KEY, HOTELBEDS_SECRET) ne sont pas configurés sur le serveur. Ce n’est pas une absence de chambres.',
  SUPPLIER_AUTH_FAILED: 'Bedsonline a refusé l’accès : clé, secret ou environnement (test/production) à vérifier. Ce n’est pas une absence de chambres.',
  QUOTA_EXCEEDED: 'Quota d’appels Bedsonline atteint (50 par jour en évaluation). Réessayez demain. Ce n’est pas une absence de chambres.',
  SUPPLIER_UNREACHABLE: 'Bedsonline est injoignable pour le moment. Ce n’est pas une absence de chambres.',
  SUPPLIER_ERROR: 'Bedsonline a renvoyé une erreur. Ce n’est pas une absence de chambres. Aucun tarif fictif ne la remplace.',
};
const envTag = () => (beds?.environment === 'production' ? 'OFFRES RÉELLES' : 'TEST · DONNÉES D’ÉVALUATION');
function bedsCondition(o) {
  if (o.state === 'free') return `<p class="condition">✓ Sans frais avant le ${esc(cutoffLabel(hbedsFreeUntil(o)))}</p>`;
  return `<p class="condition warn">${esc(labels[o.state])}</p>`;
}
function bedsTaxes(o) {
  const at = o.taxesAtHotel ?? [];
  return at.length ? `<span class="tbo-warn">à payer sur place : ${at.map(t => `${esc(t.type ?? 'taxe')} ${moneyIn(t.amount, t.currency)}`).join(', ')}</span>` : (o.taxesAllIncluded ? 'Taxes incluses' : 'Taxes à vérifier');
}
function bedsBody(nRooms) {
  if (!beds) return { top: envTag(), html: '<div class="state">Prêt à rechercher.</div>' };
  if (beds.loading) return { top: envTag(), html: '<div class="state">Recherche en cours…</div>' };
  if (beds.error) return { top: 'ERREUR FOURNISSEUR', html: `<div class="state">${esc(BEDS_ERRORS[beds.error] ?? ERRORS[beds.error] ?? 'La recherche Bedsonline n’a pas abouti. Ce n’est pas une absence de chambres.')}</div>` };
  if (beds.status === 'not_mapped') return { top: envTag(), html: `<div class="state">Hôtel pas encore associé à un code Bedsonline. ${mapLink('bedsonline')}</div>` };
  if (beds.status === 'currency_not_eur') return { top: 'DEVISE NON CONFORME', html: `<div class="state">Bedsonline renvoie des tarifs en ${esc(beds.currency)}. L’euro est imposé : offres masquées, sans conversion.</div>` };
  const p = panels.bedsonline;
  if (!p.received) return { top: envTag(), html: '<div class="state">Bedsonline n’a retourné aucune disponibilité pour ces critères.</div>' };
  if (!p.pick) return { top: envTag(), count: p.offers.length, html: `<div class="state">${p.offers.length ? `Aucune offre pour la chambre ${(p.missingRoom ?? 0) + 1} avec ces filtres : pas de total partiel.` : 'Aucune offre ne correspond à ces filtres.'}</div>` };
  const photo = p.pick.find(o => o.photos?.length)?.photos[0];
  const amount = p.currency === 'EUR' ? money(p.total).replace('€', '<small>€</small>') : esc(moneyIn(p.total, p.currency));
  return { top: envTag(), count: p.offers.length, html: `<div class="price">${amount}</div>${fxHtml(p.total, p.currency)}
    <div class="price-label">Net agence · total séjour · ${plural(nRooms, 'chambre')}</div><div class="secondary-amount">Net fourni par Bedsonline${p.pick.some(o => o.recheck) ? ' · prix à revérifier (RECHECK)' : ''}</div>${p.currency !== 'EUR' ? `<div class="secondary-amount tbo-warn">Devise ${esc(p.currency ?? 'inconnue')} : affichée pour les tests, non comparée.</div>` : ''}
    <div class="room-info">${photo ? `<img class="panel-photo" src="${esc(photo)}" alt="${esc(p.pick[0].room ?? 'Chambre')}" loading="lazy" referrerpolicy="no-referrer">` : ''}<strong>${p.pick.map(o => `${o.units > 1 ? `${o.units} × ` : ''}${esc(o.room ?? 'Chambre non renseignée')}`).join('<br>')}</strong>
    ${p.pick[0].category ? `<p>${esc(p.pick[0].category)}</p>` : ''}${mealLine(new Set(p.pick.map(o => o.meal)).size === 1 ? p.pick[0].meal : 'Pensions différentes selon la chambre', p.mealCode)}${new Set(p.pick.map(o => o.state)).size === 1 ? bedsCondition(p.pick[0]) : '<p class="condition warn">Conditions différentes selon la chambre</p>'}<p>${bedsTaxes(p.pick[0])}</p>${p.pick.some(o => o.rateCommentsId) ? '<p class="tbo-warn">Commentaires du tarif à lire (voir le détail)</p>' : ''}</div>` };
}
function bedsCard(o) {
  const photos = (o.photos ?? []).slice(0, 8);
  return `<article class="live-card"><div><span class="tag">Bedsonline · ${beds?.environment === 'production' ? 'offre réelle' : 'test'}</span><h3>${o.units > 1 ? `${o.units} × ` : ''}${esc(o.room ?? 'Chambre non renseignée')}</h3>
    <p>${esc(o.meal ?? 'Pension non renseignée')} · ${esc(o.adults ?? '?')} adulte(s)${o.childrenAges?.length ? ` + enfants ${o.childrenAges.join(', ')} ans` : ''}${o.rateClass === 'NRF' ? ' · tarif non remboursable' : ''}</p>
    ${bedsCondition(o)}${o.occupancyMatched ? '' : '<p class="error">Occupation renvoyée différente de la demande : à vérifier.</p>'}<p>${bedsTaxes(o)}</p></div>
    <div class="live-price">${moneyIn(o.net, o.currency)}<small>Net agence fourni par Bedsonline</small>${fxHtml(o.net, o.currency, true)}${o.sellingRate ? `<small>Prix de vente ${o.hotelMandatory ? 'imposé' : 'conseillé'} : ${moneyIn(o.sellingRate, o.currency)}</small>` : ''}</div>
    ${photos.length ? `<div class="room-photos">${photos.map((u, k) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="${esc(o.room ?? 'Chambre')} · photo ${k + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : ''}
    ${o.rateCommentsId ? `<div class="rate-comments" data-rc="${esc(o.rateCommentsId)}"><p class="tbo-warn">Ce tarif comporte des commentaires de l’hôtel à lire avant toute réservation.</p><button type="button" class="text-button">Afficher les commentaires du tarif</button><div class="rc-body"></div></div>` : ''}
    <details><summary>Chambre, annulation et détails</summary>${o.category ? `<p>Catégorie Hotelbeds : ${esc(o.category)}</p>` : ''}${o.sourceMarket ? `<p>Prix obtenus pour le marché ${esc(o.sourceMarket)} : à utiliser uniquement pour ce marché.</p>` : ''}${o.roomInfo?.maxPax ? `<p>Capacité maximale : ${esc(o.roomInfo.maxPax)} personne(s)${o.roomInfo.maxAdults ? `, dont ${esc(o.roomInfo.maxAdults)} adulte(s)` : ''}.</p>` : ''}
    ${o.cancellation?.length ? '<ul>' + o.cancellation.map(c => `<li>À partir du ${esc(cutoffLabel(c.from))} : ${moneyIn(c.amount, o.currency)} de frais.</li>`).join('') + '</ul>' : '<p>Conditions d’annulation non renseignées : à vérifier.</p>'}
    ${o.promotions?.length ? `<p>Promotions : ${o.promotions.map(esc).join(' · ')}</p>` : ''}${o.recheck ? '<p class="tbo-warn">Tarif à revérifier avant réservation (RECHECK).</p>' : ''}<p>Aucune équivalence de chambre avec les autres fournisseurs n’est présumée.</p></details></article>`;
}
function render() {
  ensureFx();
  const f = filters();
  panels = { halalbooking: snapshot ? hbPanel(snapshot, f) : null, tbo: tbo?.offers ? tboPanel(tbo, f) : null, ratehawk: rh?.offers ? rhPanel(rh, f) : null, bedsonline: beds?.offers ? bedsPanel(beds, f, rooms.length) : null };
  const cmp = comparePanels([panels.halalbooking, panels.tbo, panels.ratehawk, panels.bedsonline]);
  const insight = $('#result-insight');
  if (cmp.lowest) {
    const name = PROVIDERS.find(p => p.id === cmp.lowest.provider).name;
    insight.hidden = false; insight.className = 'insight' + (cmp.comparable ? '' : ' warn');
    const lowCur = cmp.lowest.currency || 'EUR', lowEq = lowCur !== 'EUR' && fx?.rates ? convertToEur(cmp.lowest.total, lowCur, fx) : null;
    insight.innerHTML = `<span>↘</span><span><strong>${esc(moneyIn(cmp.lowest.total, lowCur))}</strong>${lowEq ? ` (≈ ${money(lowEq.amount)}, taux BCE indicatif)` : ''} · ${name} · ${cmp.comparable ? 'Prix le plus bas à pension, chambre et annulation équivalentes.' : `Prix affiché le plus bas, à vérifier : ${esc(cmp.reasons.join(', '))}.`}</span>`;
  } else if (cmp.currencyMismatch) {
    insight.hidden = false; insight.className = 'insight warn';
    insight.innerHTML = '<span>≠</span><span>Devises différentes entre fournisseurs : aucun prix le plus bas n’est désigné. Les montants hors EUR sont accompagnés d’un équivalent EUR indicatif (taux BCE), non utilisé pour comparer.</span>';
  } else insight.hidden = true;
  $('#provider-grid').innerHTML = PROVIDERS.map(prov => {
    const b = panelBody(prov.id);
    const best = cmp.lowest?.provider === prov.id;
    const top = best ? (cmp.comparable ? 'PRIX LE PLUS BAS · COMPARABLE' : 'PRIX AFFICHÉ LE PLUS BAS · À VÉRIFIER') : b.top;
    return `<article class="provider${best ? ' best' : ''}${b.off ? ' off' : ''}"><div class="provider-top">${esc(top)}</div><div class="provider-main">
      <div class="provider-brand"><span class="provider-letter">${prov.letter}</span>${prov.name}</div>
      ${b.count != null ? `<p class="subtle">${plural(b.count, 'offre')} correspondante${b.count > 1 ? 's' : ''}</p>` : ''}${b.html}${dossier ? assessHtml(panels[prov.id]) : ''}</div>
      <div class="provider-bottom"><button type="button" data-offers="${prov.id}" ${b.count ? '' : 'disabled'}>Voir les chambres et conditions <span>↗</span></button></div></article>`;
  }).join('');
  $$('[data-offers]').forEach(btn => btn.onclick = () => openOffers(btn.dataset.offers));
  $$('[data-match]').forEach(btn => btn.onclick = () => openMatch(btn.dataset.match));
}

const snapshotCheckin = () => beds?.criteria?.checkin ?? $('#live-in').value;
function openOffers(id) {
  const p = panels[id];
  if (!p?.offers?.length) return;
  const hotel = $('#results-title').textContent;
  $('#offers-title').innerHTML = `<h2>${{ tbo: 'TBO', bedsonline: 'Bedsonline', ratehawk: 'RateHawk' }[id] ?? 'Halalbooking'}</h2><p>${id === 'tbo' ? 'Données de test (staging)' : id === 'ratehawk' ? (rh?.environment === 'production' ? 'Offres réelles' : 'Bac à sable (test)') : id === 'bedsonline' ? (beds?.environment === 'production' ? 'Offres réelles' : 'Données d’évaluation (test)') : 'Offres réelles'} · ${esc(hotel)} · ${plural(p.offers.length, 'offre')} · filtres appliqués</p>`;
  if (id === 'tbo') $('#offers-body').innerHTML = p.offers.map(tboCard).join('');
  else if (id === 'ratehawk') $('#offers-body').innerHTML = p.offers.map(rhCard).join('');
  else if (id === 'bedsonline') {
    $('#offers-body').innerHTML = p.offers.map(bedsCard).join('');
    $$('#offers-body .rate-comments button').forEach(btn => btn.onclick = async () => {
      const box = btn.closest('.rate-comments'), out = box.querySelector('.rc-body');
      btn.disabled = true; out.textContent = 'Chargement…';
      try {
        const r = await fetch(`/api/bedsonline/ratecomments?code=${encodeURIComponent(box.dataset.rc)}&date=${encodeURIComponent(snapshotCheckin())}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        out.innerHTML = d.comments.length ? '<ul>' + d.comments.map(c => `<li>${esc(c.description)}</li>`).join('') + '</ul>' : '<p>Aucun commentaire renvoyé pour cette date.</p>';
        btn.hidden = true;
      } catch (e) { out.textContent = BEDS_ERRORS[e.message] ?? 'Commentaires indisponibles : vérifiez-les sur Bedsonline avant de réserver.'; btn.disabled = false; }
    });
  }
  else {
    const many = rooms.length > 1 || (snapshot?.criteria?.rooms?.length ?? 1) > 1;
    $('#offers-body').innerHTML = snapshot.criteria.rooms.map((r, i) => {
      const list = p.offers.filter(o => (o.roomIndex ?? 0) === i);
      return (many ? `<h3 class="room-group">Chambre ${i + 1} · ${esc(roomLabel(r))}</h3>` : '') + (list.length ? list.map(card).join('') : '<div class="empty">Aucune offre avec ces filtres.</div>');
    }).join('');
  }
  $('#offers-modal').showModal();
}
$('#close-offers').onclick = () => $('#offers-modal').close();

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
  hideSuggest();
  const typed = $('#live-place').value.trim();
  if (!typed) { $('#live-error').textContent = 'Indiquez une destination ou un hôtel.'; return; }
  if (place.type === 'hotel' && typed !== place.name) place = { type: 'city', name: typed };
  if (place.type === 'city') return searchDestination(1);
  return searchHotel();
};
async function searchHotel() {
  loading = true; showMode('hotel');
  const q = criteria(), nationality = $('#live-nationality').value;
  if (fx?.error) fx = null; // nouvelle tentative de récupération du taux BCE
  snapshot = null; hbState = 'loading'; tbo = { loading: true }; beds = { loading: true }; rh = { loading: true };
  $('#pending').hidden = true; $('#live-error').textContent = '';
  $('#live-status').textContent = 'Recherche en cours auprès des fournisseurs connectés…'; $('#live-submit').disabled = true;
  const n = nightsBetween(q.checkin, q.checkout);
  $('#results-title').textContent = place.name;
  $('#result-location').textContent = `${(place.city ?? '').toUpperCase()}${place.country ? ' · ' + place.country.toUpperCase() : ''} · OFFRES RÉELLES`;
  $('#criteria').textContent = `${q.checkin} → ${q.checkout} · ${n} nuit${n > 1 ? 's' : ''} · ${q.rooms.map((x, i) => `ch. ${i + 1} : ${roomLabel(x)}`).join(' ; ')} · pays ${q.country} · nationalité ${nationality}`;
  render();
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const d = await r.json().catch(() => ({})); return r.ok ? { ok: true, d } : { ok: false, error: d.detail || d.error || 'SUPPLIER_ERROR' }; })
    .catch(() => ({ ok: false, error: 'NETWORK' }));
  const tboRun = post('/api/tbo/search', { ...q, nationality }).then(r => { tbo = r.ok ? r.d : { error: r.error }; render(); });
  const hbRun = post('/api/halalbooking/search', q).then(r => {
    if (r.ok) {
      snapshot = r.d; hbState = null;
      $('#live-room').innerHTML = '<option value="">Toutes les chambres</option>' + [...new Map(r.d.offers.filter(o => o.roomId != null).map(o => [String(o.roomId), o.room])).entries()].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    } else {
      hbState = r.error;
      if (CRITERIA_CODES.includes(r.error)) $('#live-error').textContent = ERRORS[r.error];
    }
    render();
  });
  const bedsRun = post('/api/bedsonline/search', q).then(r => { beds = r.ok ? r.d : { error: r.error }; render(); });
  const rhRun = post('/api/ratehawk/search', { ...q, nationality }).then(r => { rh = r.ok ? r.d : { error: r.error }; render(); });
  await Promise.all([hbRun, tboRun, bedsRun, rhRun]);
  $('#live-status').textContent = `Relevé du ${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Casablanca' })} (heure Maroc) · prix à reconfirmer chez le fournisseur.`;
  clearFilters(); markPending();
  loading = false; $('#live-submit').disabled = false;
}

// ---- Mode destination : hôtels Halalbooking avec prix « dès » ----
let dest = null;
function showMode(mode) { $('#destination-results').hidden = mode !== 'destination'; $('#hotel-results').hidden = mode !== 'hotel'; }
async function searchDestination(page) {
  loading = true; showMode('destination'); $('#live-submit').disabled = true; $('#live-error').textContent = ''; $('#pending').hidden = true;
  const q = { checkin: $('#live-in').value, checkout: $('#live-out').value, rooms: structuredClone(rooms), country: $('#live-country').value, location: place.name, page };
  $('#results-title').textContent = place.name; $('#result-location').textContent = 'DESTINATION · OFFRES HALALBOOKING';
  const n = nightsBetween(q.checkin, q.checkout);
  $('#criteria').textContent = `${q.checkin} → ${q.checkout} · ${n} nuit${n > 1 ? 's' : ''} · ${q.rooms.map((x, i) => `ch. ${i + 1} : ${roomLabel(x)}`).join(' ; ')} · pays ${q.country}`;
  $('#destination-results').innerHTML = '<div class="empty">Recherche des hôtels disponibles…</div>';
  $('#live-status').textContent = 'Recherche Halalbooking en cours…';
  try {
    const r = await fetch('/api/halalbooking/destination', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || d.error || 'SUPPLIER_ERROR');
    dest = d; renderDestination();
    $('#live-status').textContent = `Relevé du ${new Date(d.observedAt).toLocaleString('fr-FR', { timeZone: 'Africa/Casablanca' })} (heure Maroc) · prix « dès » à reconfirmer.`;
  } catch (err) {
    $('#destination-results').innerHTML = `<div class="empty">${esc(err.message === 'LOCATION_INVALID' ? 'Destination invalide : utilisez le nom anglais de la ville, de la région ou du pays (ex. Istanbul, Antalya, Morocco).' : ERRORS[err.message] ?? 'La recherche n’a pas abouti. Aucun tarif fictif ne remplace la réponse.')}</div>`;
    $('#live-status').textContent = 'Aucun résultat exploitable pour cette recherche.';
  } finally { loading = false; $('#live-submit').disabled = false; }
}
function renderDestination() {
  const d = dest;
  if (!d.hotels.length) { $('#destination-results').innerHTML = `<div class="empty">Halalbooking ne propose aucun hôtel disponible pour « ${esc(place.name)} » à ces dates. Essayez le nom anglais de la ville ou du pays (ex. Istanbul, Turkey).</div>`; return; }
  const stars = n => (n ? '★'.repeat(Math.round(n)) : '');
  $('#destination-results').innerHTML = `<p class="subtle">${d.total ?? d.hotels.length} établissement(s) disponibles · page ${d.page}${d.totalPages ? ' sur ' + d.totalPages : ''} · tri Halalbooking</p>
    <div class="dest-grid">${d.hotels.map(h => `<article class="dest-card">${h.photo ? `<img src="${esc(h.photo)}" alt="${esc(h.name)}" loading="lazy" referrerpolicy="no-referrer">` : ''}<div class="body">
      <h3>${esc(h.name)}</h3><span>${esc(stars(h.stars))} ${esc([h.city, h.country].filter(Boolean).join(', '))}</span>
      ${h.reviewScore ? `<span>Avis ${esc(String(h.reviewScore).replace('.', ','))}/10${h.reviewLabel ? ' · ' + esc(h.reviewLabel) : ''}</span>` : ''}
      <span class="net">${typeof h.net === 'number' ? money(h.net) : money(h.minPrice)}</span>
      <span>${typeof h.net === 'number' ? `Net agence dès · public ${money(h.minPrice)}` : 'Prix public dès'} · ${plural(rooms.length, 'chambre')}${h.quantity > rooms.length ? ` (${h.quantity} logements)` : ''}</span>
      <button type="button" class="btn-compare" data-hotel="${h.id}">Comparer les fournisseurs →</button></div></article>`).join('')}</div>
    <div class="dest-pager"><button type="button" data-page="${d.page - 1}" ${d.page > 1 ? '' : 'disabled'}>← Précédent</button><span>Page ${d.page}${d.totalPages ? ' / ' + d.totalPages : ''}</span><button type="button" data-page="${d.page + 1}" ${d.totalPages && d.page < d.totalPages ? '' : 'disabled'}>Suivant →</button></div>`;
  $$('[data-hotel]').forEach(b => b.onclick = () => {
    const h = d.hotels.find(x => String(x.id) === b.dataset.hotel);
    place = { type: 'hotel', id: h.id, name: h.name, city: h.city, country: h.country };
    $('#live-place').value = h.name; searchHotel(); window.scrollTo({ top: $('#live-search').offsetTop, behavior: 'smooth' });
  });
  $$('[data-page]').forEach(b => b.onclick = () => searchDestination(Number(b.dataset.page)));
}

// ---- Suggestions (catalogue Halalbooking, sans appel fournisseur) ----
let suggestTimer = null, suggestions = [], active = -1;
function hideSuggest() { $('#place-suggest').hidden = true; $('#live-place').setAttribute('aria-expanded', 'false'); active = -1; }
function choose(item) {
  place = item.type === 'hotel' ? { type: 'hotel', id: item.id, name: item.name, city: item.city, country: item.country } : { type: 'city', name: item.city, country: item.country };
  $('#live-place').value = place.name; hideSuggest(); markPending();
  if (dossier && !dossier.hbPlaceId && place.type === 'hotel') linkDossierHotel(place);
}
function drawSuggest() {
  const box = $('#place-suggest');
  if (!suggestions.length) { hideSuggest(); return; }
  let html = '', k = 0;
  const cities = suggestions.filter(x => x.type === 'city'), hotels = suggestions.filter(x => x.type === 'hotel');
  if (cities.length) html += '<li class="group" role="presentation">DESTINATIONS</li>' + cities.map(c => `<li role="option" data-i="${k++}" aria-selected="false">📍 ${esc(c.city)}<small>${esc(c.country ?? '')} · ${c.count} établissement(s)</small></li>`).join('');
  if (hotels.length) html += '<li class="group" role="presentation">HÔTELS</li>' + hotels.map(h => `<li role="option" data-i="${k++}" aria-selected="false">${esc(h.name)}<small>${esc([h.city, h.country].filter(Boolean).join(', '))}${h.stars ? ' · ' + '★'.repeat(Math.round(h.stars)) : ''}</small></li>`).join('');
  suggestions = [...cities, ...hotels];
  box.innerHTML = html; box.hidden = false; $('#live-place').setAttribute('aria-expanded', 'true');
  box.querySelectorAll('[data-i]').forEach(li => li.onmousedown = ev => { ev.preventDefault(); choose(suggestions[Number(li.dataset.i)]); });
}
$('#live-place').addEventListener('input', () => {
  const v = $('#live-place').value.trim();
  if (place.type === 'hotel' && v !== place.name) place = { type: 'city', name: v };
  else if (place.type === 'city') place = { type: 'city', name: v };
  clearTimeout(suggestTimer);
  if (v.length < 2) { suggestions = []; hideSuggest(); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const d = await (await fetch('/api/places/suggest?q=' + encodeURIComponent(v))).json();
      suggestions = [...(d.cities ?? []).map(c => ({ type: 'city', ...c })), ...(d.hotels ?? []).map(h => ({ type: 'hotel', ...h }))];
      drawSuggest();
    } catch { hideSuggest(); }
  }, 180);
});
$('#live-place').addEventListener('keydown', e => {
  const items = [...$('#place-suggest').querySelectorAll('[data-i]')];
  if ($('#place-suggest').hidden || !items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((li, i) => li.setAttribute('aria-selected', String(i === active))); }
  else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(suggestions[active]); }
  else if (e.key === 'Escape') hideSuggest();
});
$('#live-place').addEventListener('blur', () => setTimeout(hideSuggest, 120));

const CRITERIA_CODES = ['LOCATION_INVALID', 'CRITERIA_INVALID', 'ROOMS_INVALID', 'ADULTS_INVALID', 'CHILDREN_INVALID', 'CHILD_AGE_INVALID', 'CHILD_AGE_OVER_12', 'NATIONALITY_INVALID'];
guestSummary(); markPending(); render();
setInterval(() => { if (snapshot || tbo?.offers || beds?.offers || rh?.offers) render(); }, 60000);

// ---- Comparaison d'un dossier de réservation (/?dossier=<id>) : critères repris du dossier, aucune action fournisseur ----
const fmtDl = d => d ? `${new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })} ${d.slice(11, 16)} (UTC${d.slice(19)})` : '—';
function assessHtml(panel) {
  const a = assessPanel(panel, dossier);
  if (a.status === 'na') return '';
  const cur = dossier.purchase.currency;
  const amount = a.diff == null ? '' : `${a.diff < 0 ? '−' : '+'}${moneyIn(Math.abs(a.diff), cur)}`;
  const head = a.status === 'gain' ? `Gain potentiel ${esc(amount)} vs dossier` : a.status === 'none' ? `Pas moins cher (${esc(amount)})` : `Écart ${a.diff == null ? 'non calculable' : esc(amount)} · à vérifier`;
  return `<div class="dossier-assess ${a.status}"><strong>${head}</strong>${a.status === 'gain' ? '<p>Chambre à comparer avec le dossier ; prix à reconfirmer avant toute décision.</p>' : ''}${a.reasons.length ? `<p>${esc(a.reasons.join(' · '))}</p>` : ''}</div>`;
}
function nationalityFromText(text) {
  const n = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!n) return null;
  let en; try { en = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { en = null; }
  const norm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  return [...$('#live-nationality').options].find(o => norm(o.textContent) === n || (en && norm(en.of(o.value)) === n) || o.value.toLowerCase() === n)?.value ?? null;
}
function dossierBanner(notes = []) {
  let box = $('#dossier-banner');
  if (!box) { box = document.createElement('div'); box.id = 'dossier-banner'; $('#live-search').before(box); }
  const b = dossier, meal = bookingMeal(b);
  box.className = 'dossier-banner';
  box.innerHTML = `<div><p class="eyebrow">COMPARAISON D’UN DOSSIER RÉSERVÉ</p><strong>${esc(b.reference)} · ${esc(b.hotel)}</strong>
    <p>Acheté ${esc(moneyIn(b.purchase.amount / 100, b.purchase.currency))} chez ${esc(b.supplier)} · ${esc(meal ? MEAL_LABELS[meal] : 'pension à vérifier')} · ${b.nonRefundable ? 'non remboursable' : 'sans frais jusqu’au ' + esc(fmtDl(b.deadline))}</p>
    ${notes.map(t => `<p class="tbo-warn">${esc(t)}</p>`).join('')}</div><a class="text-button" href="/reservations.html">← Retour aux réservations</a>`;
}
async function linkDossierHotel(p) {
  try {
    const r = await fetch(`/api/bookings/${dossier.id}/hotel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hbPlaceId: p.id }) });
    if (r.ok) { dossier.hbPlaceId = p.id; dossierNotes = [`Hôtel rattaché au dossier : ${p.name}.`, ...dossierNotes.slice(1)]; dossierBanner(dossierNotes); searchHotel(); }
  } catch { /* rattachement facultatif : la recherche reste possible */ }
}
async function loadDossier(id) {
  const r = await fetch('/api/bookings/' + encodeURIComponent(id)).catch(() => null);
  if (!r?.ok) { $('#live-error').textContent = 'Dossier introuvable.'; return; }
  dossier = (await r.json()).booking;
  const notes = [];
  $('#live-in').value = dossier.checkin; $('#live-out').value = dossier.checkout;
  rooms = dossier.rooms.map(x => ({ adults: x.adults, children: [...x.childrenAges] })); guestSummary();
  const nat = nationalityFromText(dossier.nationality);
  if (nat) $('#live-nationality').value = nat; else notes.push(`Nationalité « ${dossier.nationality ?? 'non renseignée'} » non reconnue : choisissez-la ci-dessous.`);
  notes.push(`Pays de résidence du client non enregistré dans le dossier : ${$('#live-country').selectedOptions[0]?.textContent ?? '?'} utilisé, à vérifier.`);
  if (dossier.rooms.some(x => x.childrenAges.some(a => a > 12))) notes.push('Enfant de plus de 12 ans : Halalbooking le compte comme adulte, la recherche peut être refusée.');
  if (dossier.hbPlaceId) {
    const pi = await fetch('/api/places/info?id=' + dossier.hbPlaceId).then(x => x.ok ? x.json() : null).catch(() => null);
    place = pi?.place ? { type: 'hotel', id: pi.place.id, name: pi.place.name, city: pi.place.city, country: pi.place.country } : { type: 'hotel', id: dossier.hbPlaceId, name: dossier.hotel };
    $('#live-place').value = place.name; dossierBanner(notes); searchHotel();
  } else {
    notes.unshift('Choisissez l’hôtel correspondant dans la liste : il sera rattaché au dossier, puis la comparaison démarre.');
    dossierNotes = notes; dossierBanner(notes);
    const input = $('#live-place'); input.value = dossier.hotel; input.focus(); input.dispatchEvent(new Event('input'));
  }
}
const dossierId = new URLSearchParams(location.search).get('dossier');
if (dossierId && /^[0-9a-f-]{36}$/.test(dossierId)) loadDossier(dossierId);
