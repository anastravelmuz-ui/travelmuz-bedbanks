// Comparateur réel multi-fournisseurs : présentation en cartouches de la maquette ChatGPT, données Halalbooking et TBO.
import { filterOffers, cancellationState, cutoffLabel } from './live-core.mjs';
import { tboCancellationState, parseTboDate } from './tbo-core.mjs';
import { hbPanel, tboPanel, comparePanels } from './compare-core.mjs';
import { MEAL_LABELS } from './meal-core.mjs';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n) : 'Prix non renseigné';
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

let snapshot = null, loading = false, hbState = null; // hbState : null | 'loading' | code d'erreur
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
  return unique.length ? `<div class="room-photos">${unique.map((x, k) => `<a href="${esc(x.u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(x.u)}" alt="${esc(x.label)} · photo ${k + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : '';
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
    <div class="live-price">${moneyIn(o.price, o.currency)}<small>Montant TBO · total séjour, toutes chambres</small>${typeof o.tax === 'number' ? `<small>dont taxes ${moneyIn(o.tax, o.currency)}</small>` : ''}${o.recommendedSellingRate ? `<small>Prix de vente minimum conseillé : ${moneyIn(o.recommendedSellingRate, o.currency)}</small>` : ''}</div>
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
  if (id === 'ratehawk') return { top: 'NON CONNECTÉ', off: true, html: '<div class="state">Accès API en attente. Aucun tarif n’est affiché tant que la connexion n’est pas établie.</div>' };
  if (id === 'bedsonline') return { top: 'NON CONNECTÉ', off: true, html: '<div class="state">Accès de test Hotelbeds validé séparément ; pas encore raccordé au comparateur.</div>' };
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
  if (tbo.status === 'not_mapped') return { top: 'STAGING · DONNÉES DE TEST', html: '<div class="state">Hôtel pas encore associé à un code TBO. Un administrateur peut le faire dans Administration › Correspondance des hôtels.</div>' };
  if (tbo.status === 'currency_not_eur') return { top: 'DEVISE NON CONFORME', html: `<div class="state">TBO renvoie des tarifs en ${esc(tbo.currency)} (devise du compte TBO). L’euro est imposé : ${plural(tbo.hidden ?? 0, 'offre')} masquée(s), sans conversion. Demandez à TBO de configurer votre compte en EUR.</div>` };
  const p = panels.tbo;
  if (!p.received) return { top: 'STAGING · DONNÉES DE TEST', html: '<div class="state">TBO n’a retourné aucune disponibilité pour ces critères.</div>' };
  if (!p.pick) return { top: 'STAGING · DONNÉES DE TEST', count: 0, html: '<div class="state">Aucune offre ne correspond à ces filtres.</div>' };
  const o = p.pick[0], atProperty = o.supplementsAtProperty ?? [];
  const amount = p.currency === 'EUR' ? money(p.total).replace('€', '<small>€</small>') : esc(moneyIn(p.total, p.currency));
  return { top: p.currency === 'EUR' ? 'STAGING · DONNÉES DE TEST' : `STAGING · DEVISE ${p.currency ?? '?'} (TEST)`, count: p.offers.length, html: `<div class="price">${amount}</div>
    <div class="price-label">Montant TBO · total séjour · ${plural(nRooms, 'chambre')}</div><div class="secondary-amount">Nature nette à confirmer avec TBO</div>${p.currency !== 'EUR' ? `<div class="secondary-amount tbo-warn">Devise ${esc(p.currency ?? 'inconnue')} : affichée temporairement pour les tests, non comparée à l’euro.</div>` : ''}
    <div class="room-info">${o.roomDetails?.find(d => d?.images?.length) ? `<img class="panel-photo" src="${esc(o.roomDetails.find(d => d?.images?.length).images[0])}" alt="${esc(o.roomNames[0] ?? 'Chambre')}" loading="lazy" referrerpolicy="no-referrer">` : ''}<strong>${o.roomNames.length ? o.roomNames.map((n, i) => (o.roomNames.length > 1 ? `Ch. ${i + 1} : ` : '') + esc(n)).join('<br>') : 'Chambre non renseignée'}</strong>
    ${mealLine(o.meal, o.mealCode)}${tboCondition(o)}<p>${typeof o.tax === 'number' ? `Dont taxes ${moneyIn(o.tax, o.currency)}` : 'Taxes non détaillées'}${atProperty.length ? ` · <span class="tbo-warn">à payer sur place : ${atProperty.map(x => `${esc(x.description ?? 'supplément')} ${moneyIn(x.price, x.currency)}`).join(', ')}</span>` : ''}</p></div>` };
}

function render() {
  const f = filters();
  panels = { halalbooking: snapshot ? hbPanel(snapshot, f) : null, tbo: tbo?.offers ? tboPanel(tbo, f) : null };
  const cmp = comparePanels([panels.halalbooking, panels.tbo]);
  const insight = $('#result-insight');
  if (cmp.lowest) {
    const name = PROVIDERS.find(p => p.id === cmp.lowest.provider).name;
    insight.hidden = false; insight.className = 'insight' + (cmp.comparable ? '' : ' warn');
    insight.innerHTML = `<span>↘</span><span><strong>${money(cmp.lowest.total)}</strong> · ${name} · ${cmp.comparable ? 'Prix le plus bas à pension, chambre et annulation équivalentes.' : `Prix affiché le plus bas, à vérifier : ${esc(cmp.reasons.join(', '))}.`}</span>`;
  } else if (cmp.currencyMismatch) {
    insight.hidden = false; insight.className = 'insight warn';
    insight.innerHTML = '<span>≠</span><span>Devises différentes entre fournisseurs : aucun prix le plus bas n’est désigné, aucune conversion n’est faite.</span>';
  } else insight.hidden = true;
  $('#provider-grid').innerHTML = PROVIDERS.map(prov => {
    const b = panelBody(prov.id);
    const best = cmp.lowest?.provider === prov.id;
    const top = best ? (cmp.comparable ? 'PRIX LE PLUS BAS · COMPARABLE' : 'PRIX AFFICHÉ LE PLUS BAS · À VÉRIFIER') : b.top;
    return `<article class="provider${best ? ' best' : ''}${b.off ? ' off' : ''}"><div class="provider-top">${esc(top)}</div><div class="provider-main">
      <div class="provider-brand"><span class="provider-letter">${prov.letter}</span>${prov.name}</div>
      ${b.count != null ? `<p class="subtle">${plural(b.count, 'offre')} correspondante${b.count > 1 ? 's' : ''}</p>` : ''}${b.html}</div>
      <div class="provider-bottom"><button type="button" data-offers="${prov.id}" ${b.count ? '' : 'disabled'}>Voir les chambres et conditions <span>↗</span></button></div></article>`;
  }).join('');
  $$('[data-offers]').forEach(btn => btn.onclick = () => openOffers(btn.dataset.offers));
}

function openOffers(id) {
  const p = panels[id];
  if (!p?.offers?.length) return;
  const hotel = $('#results-title').textContent;
  $('#offers-title').innerHTML = `<h2>${id === 'tbo' ? 'TBO' : 'Halalbooking'}</h2><p>${id === 'tbo' ? 'Données de test (staging)' : 'Offres réelles'} · ${esc(hotel)} · ${plural(p.offers.length, 'offre')} · filtres appliqués</p>`;
  if (id === 'tbo') $('#offers-body').innerHTML = p.offers.map(tboCard).join('');
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
  loading = true;
  const q = criteria(), nationality = $('#live-nationality').value;
  snapshot = null; hbState = 'loading'; tbo = { loading: true };
  $('#pending').hidden = true; $('#live-error').textContent = '';
  $('#live-status').textContent = 'Recherche en cours auprès des fournisseurs connectés…'; $('#live-submit').disabled = true;
  const n = nightsBetween(q.checkin, q.checkout);
  $('#results-title').textContent = $('#live-hotel').selectedOptions[0].textContent.split(' · ')[0];
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
  await Promise.all([hbRun, tboRun]);
  $('#live-status').textContent = `Relevé du ${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Casablanca' })} (heure Maroc) · prix à reconfirmer chez le fournisseur.`;
  clearFilters(); markPending();
  loading = false; $('#live-submit').disabled = false;
};
const CRITERIA_CODES = ['CRITERIA_INVALID', 'ROOMS_INVALID', 'ADULTS_INVALID', 'CHILDREN_INVALID', 'CHILD_AGE_INVALID', 'CHILD_AGE_OVER_12', 'NATIONALITY_INVALID'];
guestSummary(); markPending(); render();
setInterval(() => { if (snapshot || tbo?.offers) render(); }, 60000);
