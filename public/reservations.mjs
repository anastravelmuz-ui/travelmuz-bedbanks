// Module Réservations : liste partagée des dossiers, ajout depuis un voucher lu dans le navigateur, validation humaine.
import { parseVoucher } from './voucher-core.mjs';
import { hbPanel, tboPanel, bedsPanel, rhPanel } from './compare-core.mjs';
import { assessPanel, freeUntilOf, bookingMeal } from './rebook-core.mjs';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SUPPLIERS = ['TBO', 'Halalbooking', 'Bedsonline', 'RateHawk', 'Autre'];
const MEALS = { RO: 'Chambre seule', BB: 'Petit déjeuner', HB: 'Demi-pension', FB: 'Pension complète', AI: 'Tout compris', unknown: 'À vérifier' };
const CURRENCIES = ['EUR', 'USD', 'GBP', 'AED', 'TRY', 'MAD', 'JPY'];
const OFFSETS = Array.from({ length: 105 }, (_, i) => (i - 48) / 4).map(n => (n < 0 ? '-' : '+') + String(Math.floor(Math.abs(n))).padStart(2, '0') + ':' + String(Math.round((Math.abs(n) % 1) * 60)).padStart(2, '0'));
const ERRORS = { FIELD_REQUIRED: 'Un champ obligatoire est vide.', DATE_INVALID: 'Une date est invalide.', DATES_ORDER: 'Le départ doit être après l’arrivée.', PURCHASE_INVALID: 'Indiquez le prix d’achat total et sa devise.', DEADLINE_INVALID: 'Indiquez la date, l’heure et le décalage UTC du début des frais (ou cochez « non remboursable »).', ROOMS_INVALID: 'Vérifiez les chambres.', MEAL_INVALID: 'Choisissez la pension de chaque chambre.', NUMBER_INVALID: 'Vérifiez les adultes et les âges des enfants (0 à 17 ans).', VALIDATION_REQUIRED: 'Cochez la case de vérification.', FIELD_TOO_LONG: 'Un texte est trop long.', FORBIDDEN: 'Seul le créateur du dossier ou un administrateur peut le supprimer.' };

let bookings = [], me = null, fileUrl = null;

function toast(t) { $('#toast').textContent = t; $('#toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
const api = async (path, init = {}) => {
  const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (r.status === 401) { location.replace('/connexion.html'); throw new Error('AUTH'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail ?? d.error ?? 'SERVER_ERROR');
  return d;
};
const fmtDate = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const money = p => p ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: p.currency }).format(p.amount / 100) : '—';
/** Échéance affichée dans son propre fuseau (celui saisi), jamais convertie silencieusement. */
const fmtDeadline = s => s ? `${fmtDate(s.slice(0, 10))} ${s.slice(11, 16)} (UTC${s.slice(19)})` : '—';
const titleCase = s => String(s ?? '').toLowerCase().replace(/(^|[\s'-])\p{L}/gu, m => m.toUpperCase());

export function bookingState(b, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (b.checkout < today) return 'past';
  if (b.nonRefundable) return 'nonref';
  return Date.parse(b.deadline) > now ? 'free' : 'fees';
}
const STATE_LABEL = { free: ['Sans frais', ''], fees: ['Frais en cours', 'warn'], nonref: ['Non remboursable', 'warn'], past: ['Séjour passé', ''] };

function render() {
  const now = Date.now(), list = bookings.map(b => ({ ...b, state: bookingState(b, now) }));
  const n = s => list.filter(b => b.state === s).length;
  $('#stats').innerHTML = `<div class="stat"><span>Dossiers</span><b>${list.length}</b><small>Partagés entre les agents</small></div><div class="stat"><span>Encore annulables sans frais</span><b>${n('free')}</b><small>Calculé à l’instant présent</small></div><div class="stat"><span>Surveillance automatique</span><b>Inactive</b><small>Prévue ultérieurement</small></div>`;
  const q = $('#q').value.trim().toLowerCase(), f = $('#filter').value;
  const shown = list.filter(b => (f === 'all' || b.state === f) && [b.reference, b.hotel, b.leadGuest, b.supplierRef, b.city].join(' ').toLowerCase().includes(q));
  $('#count').textContent = `${shown.length} dossier(s) affiché(s) sur ${list.length}`;
  $('#rows').innerHTML = shown.map(b => { const [label, cls] = STATE_LABEL[b.state]; return `<tr><td><strong>${esc(b.hotel)}</strong><small>${esc(b.reference)} · ${esc(b.supplier)}${b.supplierRef ? ' ' + esc(b.supplierRef) : ''}</small></td><td>${esc(b.leadGuest)}<small>${b.rooms.length} chambre(s) · ${b.rooms.reduce((s, r) => s + r.adults, 0)} adulte(s)${b.rooms.some(r => r.childrenAges.length) ? ' · ' + b.rooms.flatMap(r => r.childrenAges).length + ' enfant(s)' : ''}</small></td><td>${fmtDate(b.checkin)}<small>${nights(b.checkin, b.checkout)} nuit(s) · ${esc(MEALS[b.rooms[0]?.meal] ?? '')}</small></td><td>${money(b.purchase)}<small>${b.payment === 'prepaid' ? 'Prépayé' : b.payment === 'hotel' ? 'Payable à l’hôtel' : 'Paiement à vérifier'}</small></td><td>${b.nonRefundable ? '—' : fmtDeadline(b.deadline)}</td><td><span class="tag ${cls}">${label}</span></td><td><button class="text-button" data-compare="${esc(b.id)}" title="Comparer ce dossier avec les offres actuelles">Comparer</button> · <button class="text-button" data-id="${esc(b.id)}">Ouvrir →</button></td></tr>`; }).join('');
  $('#empty').hidden = !!shown.length;
  $$('[data-id]').forEach(btn => { btn.onclick = () => openForm(bookings.find(b => b.id === btn.dataset.id)); });
  $$('[data-compare]').forEach(btn => { btn.onclick = () => openCompare(bookings.find(b => b.id === btn.dataset.compare)); });
}
async function load() {
  try { bookings = (await api('/api/bookings')).bookings; render(); }
  catch (e) { if (e.message !== 'AUTH') $('#count').textContent = 'Impossible de charger les dossiers (' + e.message + ').'; }
}

// ---- Voucher → proposition de saisie ----
async function readPdf(file) {
  const pdfjs = await import('/vendor/pdfjs-4.10.38/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-4.10.38/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= Math.min(doc.numPages, 10); p++) pages.push((await (await doc.getPage(p)).getTextContent()).items);
  await doc.destroy();
  return pages;
}
/** Champs lus → brouillon de dossier + liste des champs à surligner. */
export function draftFromVoucher(v) {
  const marks = new Set(), d = { cancellation: [], rooms: [] };
  const put = (k, val, mark = k) => { if (val != null && val !== '') { d[k] = val; marks.add(mark); } };
  put('supplier', v.supplier); put('supplierRef', v.supplierRef); put('hotel', v.hotel); put('address', v.address); put('city', v.city); put('country', v.country);
  put('checkin', v.checkin); put('checkout', v.checkout); put('bookedOn', v.bookedOn); put('nationality', v.nationality); put('noShow', v.noShow);
  if (v.leadGuest) put('leadGuest', titleCase(v.leadGuest));
  const others = (v.guests ?? []).filter(g => g.name && titleCase(g.name) !== d.leadGuest).map(g => titleCase(g.name) + (g.room > 1 ? ` (chambre ${g.room})` : ''));
  if (others.length) put('otherGuests', others.join('\n'));
  if (v.payment) put('payment', v.payment);
  d.rooms = (v.rooms ?? []).map((r, i) => {
    if (r.type) marks.add(`room${i}.type`); if (r.meal) marks.add(`room${i}.meal`); if (r.description) marks.add(`room${i}.description`); if (r.adults) marks.add(`room${i}.adults`);
    if (r.childrenAges?.length) marks.add(`room${i}.ages`);
    return { type: r.type ?? '', meal: r.meal ?? 'unknown', description: r.description ?? '', adults: r.adults ?? 2, childrenAges: r.childrenAges ?? [], childrenCount: r.children ?? 0 };
  });
  if (v.cancellation?.length) { d.cancellation = v.cancellation.map(p => ({ from: p.from, to: p.to, charge: p.charge ?? '' })); marks.add('cancellation'); }
  if (v.nonRefundable) put('nonRefundable', true);
  else if (v.feesFromDate) { d.deadlineLocal = v.feesFromDate + 'T00:00'; marks.add('deadlineLocal'); d.deadlineHint = v.supplier === 'TBO' ? 'TBO indique le jour de début des frais, sans heure ni fuseau : 00:00 est proposé, confirmez le décalage UTC (le plus prudent : UTC+14:00) ou vérifiez auprès de TBO.' : ''; }
  return { draft: d, marks };
}

// ---- Formulaire ----
function openModal(title, subtitle, body) {
  $('#modal-title').innerHTML = `<h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}`;
  $('#modal-body').innerHTML = body;
  if (!$('#modal').open) $('#modal').showModal();
}
$('#close-modal').onclick = () => $('#modal').close();
$('#modal').addEventListener('close', () => { $('#modal').classList.remove('wide-modal'); if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; } });

const input = (name, label, value, { type = 'text', cls = '', attrs = '' } = {}) => `<label class="${cls}">${label}<input name="${name}" type="${type}" value="${esc(value ?? '')}" ${attrs}></label>`;
const select = (name, label, options, value, cls = '') => `<label class="${cls}">${label}<select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
function roomHtml(r, i) {
  return `<div class="bk-room" data-room="${i}"><label>Catégorie de chambre (libellé fournisseur)<input name="room${i}.type" value="${esc(r.type)}" required maxlength="200"></label>${select(`room${i}.meal`, 'Pension', Object.entries(MEALS), r.meal)}<label>Adultes<input name="room${i}.adults" type="number" min="1" max="9" value="${r.adults}" required></label><label>Âges des enfants<input name="room${i}.ages" value="${esc(r.childrenAges.join(', '))}" placeholder="ex. 11, 9"></label><button type="button" class="text-button" data-remove-room="${i}" ${i === 0 ? 'hidden' : ''}>Retirer</button><label class="wide">Description (literie, superficie, vue…)<input name="room${i}.description" value="${esc(r.description)}" maxlength="500"></label></div>`;
}
function cancelHtml(p, i) {
  return `<div class="bk-row" data-cancel="${i}"><label>Du<input name="can${i}.from" type="date" value="${esc(p.from)}"></label><label>Au (inclus)<input name="can${i}.to" type="date" value="${esc(p.to)}"></label><label>Frais (tels qu’indiqués)<input name="can${i}.charge" value="${esc(p.charge)}" maxlength="40"></label><button type="button" class="text-button" data-remove-cancel="${i}">Retirer</button></div>`;
}

function openForm(existing = null, draft = null, marks = new Set(), readInfo = '') {
  const b = existing ? { ...existing, otherGuests: (existing.guests ?? []).filter(g => g.name !== existing.leadGuest).map(g => g.name + (g.room > 1 ? ` (chambre ${g.room})` : '')).join('\n'), deadlineLocal: existing.deadline?.slice(0, 16) ?? '', offset: existing.deadline?.slice(19) ?? '' }
    : { supplier: 'TBO', payment: 'unknown', rooms: [{ type: '', meal: 'unknown', description: '', adults: 2, childrenAges: [] }], cancellation: [], offset: '', ...(draft ?? {}) };
  if (!b.rooms?.length) b.rooms = [{ type: '', meal: 'unknown', description: '', adults: 2, childrenAges: [] }];
  const canDelete = existing && (me?.role === 'admin' || existing.createdBy === me?.email);
  openModal(existing ? `Dossier ${existing.reference}` : 'Ajouter une réservation', existing ? `Créé par ${existing.createdBy} · modifié le ${new Date(existing.updatedAt).toLocaleString('fr-FR')} par ${existing.updatedBy}` : 'Le voucher est lu dans votre navigateur et n’est pas conservé.', `<form id="bk-form" novalidate>
  ${existing ? '' : `<div class="upload-area"><label>Voucher (PDF)<input id="voucher" type="file" accept="application/pdf,image/png,image/jpeg"></label><p>PDF de 10 Mo maximum. Lecture automatique des vouchers TBO ; pour les autres, lecture partielle. Images et scans : saisie manuelle.</p><div id="file-preview"></div><p class="read-status" id="read-status">${esc(readInfo)}</p><div class="legend"><span><i class="v"></i>Lu sur le voucher : à vérifier</span><span><i class="f"></i>À compléter</span></div></div>`}
  <div class="bk-section"><h3>Dossier</h3><div class="form-grid">
    ${input('reference', 'Référence du dossier agence *', b.reference, { attrs: 'required maxlength="80" placeholder="ex. TM-2026-0142"' })}
    ${select('supplier', 'Fournisseur *', SUPPLIERS.map(s => [s, s]), b.supplier)}
    ${input('supplierRef', 'N° de confirmation fournisseur', b.supplierRef, { attrs: 'maxlength="80"' })}
    ${input('bookedOn', 'Date de réservation', b.bookedOn, { type: 'date' })}
  </div></div>
  <div class="bk-section"><h3>Hôtel</h3><div class="form-grid">
    ${input('hotel', 'Hôtel *', b.hotel, { cls: 'wide', attrs: 'required maxlength="200"' })}
    ${input('address', 'Adresse', b.address, { cls: 'wide', attrs: 'maxlength="300"' })}
    ${input('city', 'Ville', b.city, { attrs: 'maxlength="120"' })}${input('country', 'Pays', b.country, { attrs: 'maxlength="120"' })}
  </div></div>
  <div class="bk-section"><h3>Séjour et voyageurs</h3><div class="form-grid">
    ${input('checkin', 'Arrivée *', b.checkin, { type: 'date', attrs: 'required' })}${input('checkout', 'Départ *', b.checkout, { type: 'date', attrs: 'required' })}
    ${input('leadGuest', 'Client principal *', b.leadGuest, { attrs: 'required maxlength="120"' })}${input('nationality', 'Nationalité des voyageurs', b.nationality, { attrs: 'maxlength="60"' })}
    <label class="wide">Autres voyageurs nommés (un par ligne)<textarea name="otherGuests" rows="2" maxlength="2000">${esc(b.otherGuests ?? '')}</textarea></label>
  </div></div>
  <div class="bk-section"><h3>Chambres</h3><div class="bk-rows" id="rooms">${b.rooms.map(roomHtml).join('')}</div><button type="button" class="text-button" id="add-room" style="margin-top:10px">＋ Ajouter une chambre</button></div>
  <div class="bk-section"><h3>Prix d’achat</h3><div class="form-grid">
    ${input('price', 'Prix d’achat total (toutes chambres, tout le séjour) *', b.purchase ? (b.purchase.amount / 100).toFixed(2) : '', { type: 'number', attrs: 'step="0.01" min="0.01" required' })}
    ${select('currency', 'Devise *', CURRENCIES.map(c => [c, c]), b.purchase?.currency ?? 'EUR')}
    ${select('payment', 'Paiement', [['prepaid', 'Prépayé au fournisseur'], ['hotel', 'Payable à l’hôtel'], ['unknown', 'À vérifier']], b.payment)}
  </div></div>
  <div class="bk-section"><h3>Annulation</h3>
    <div class="bk-rows" id="cancels">${(b.cancellation ?? []).map(cancelHtml).join('')}</div><button type="button" class="text-button" id="add-cancel" style="margin:10px 0 16px">＋ Ajouter une période</button>
    <div class="form-grid">
      <label class="wide check"><input type="checkbox" name="nonRefundable" ${b.nonRefundable ? 'checked' : ''}>Non remboursable dès la réservation</label>
      ${input('deadlineLocal', 'Début des frais (date et heure) *', b.deadlineLocal, { type: 'datetime-local', cls: 'deadline' })}
      ${select('offset', 'Décalage UTC à cette échéance *', [['', 'À confirmer'], ...OFFSETS.map(o => [o, 'UTC' + o])], b.offset, 'deadline')}
      ${input('noShow', 'Non-présentation', b.noShow, { cls: 'wide', attrs: 'maxlength="120"' })}
    </div>
    <p class="subtle deadline"><button type="button" class="text-button" id="offset-prudent">Choisir UTC+14:00 (le plus prudent)</button> · UTC−12:00 est au contraire le moins prudent.</p>
    <p class="subtle" id="deadline-hint">${esc(b.deadlineHint ?? 'Recopiez l’heure et le décalage indiqués par le fournisseur. Ne déduisez pas le fuseau de celui de l’agence.')}</p>
  </div>
  <div class="bk-section"><label class="wide">Notes internes<textarea name="notes" rows="2" maxlength="2000">${esc(b.notes ?? '')}</textarea></label></div>
  <label class="check" style="margin-top:18px"><input type="checkbox" name="validated">J’ai vérifié chaque information avec le voucher : hôtel, voyageurs, dates, chambres, prix et conditions d’annulation.</label>
  <p id="bk-error" class="error" role="alert"></p>
  <div class="form-actions">${existing ? '<button type="button" class="secondary" id="compare-now">Comparer maintenant</button>' : ''}${canDelete ? '<button type="button" id="delete" class="text-button">Supprimer ce dossier</button>' : ''}<button class="primary" type="submit">${existing ? 'Enregistrer les modifications' : 'Enregistrer le dossier'}</button></div></form>`);

  const form = $('#bk-form');
  const highlight = () => {
    form.querySelectorAll('input,select,textarea').forEach(el => {
      el.classList.toggle('from-voucher', marks.has(el.name) || (marks.has('cancellation') && /^can\d/.test(el.name)));
      const empty = !el.value && (el.required || el.name === 'price' || (el.name === 'offset' || el.name === 'deadlineLocal') && !form.nonRefundable.checked);
      el.classList.toggle('to-fill', !!empty && !existing);
    });
  };
  const toggleDeadline = () => { form.querySelectorAll('.deadline').forEach(l => { l.hidden = form.nonRefundable.checked; }); highlight(); };
  $('#offset-prudent').onclick = () => { form.offset.value = '+14:00'; highlight(); };
  form.nonRefundable.onchange = toggleDeadline; form.oninput = highlight; toggleDeadline();
  const rebindRows = () => {
    form.querySelectorAll('[data-remove-room]').forEach(btn => { btn.onclick = () => { btn.closest('.bk-room').remove(); }; });
    form.querySelectorAll('[data-remove-cancel]').forEach(btn => { btn.onclick = () => { btn.closest('.bk-row').remove(); }; });
  };
  rebindRows();
  $('#add-room').onclick = () => { const i = Date.now() % 1e6; $('#rooms').insertAdjacentHTML('beforeend', roomHtml({ type: '', meal: 'unknown', description: '', adults: 2, childrenAges: [] }, i)); rebindRows(); highlight(); };
  $('#add-cancel').onclick = () => { const i = Date.now() % 1e6; $('#cancels').insertAdjacentHTML('beforeend', cancelHtml({ from: '', to: '', charge: '' }, i)); rebindRows(); };
  const childWarn = (draft?.rooms ?? []).some(r => r.childrenCount && r.childrenAges.length !== r.childrenCount);
  if (childWarn) $('#bk-error').textContent = 'Le voucher mentionne des enfants dont les âges n’ont pas pu être lus : complétez-les.';

  if (!existing) $('#voucher').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024 || !['application/pdf', 'image/png', 'image/jpeg'].includes(f.type)) { e.target.value = ''; toast('Choisissez un PDF, PNG ou JPEG de moins de 10 Mo.'); return; }
    const keep = Object.fromEntries(new FormData(form)); // conserve une référence déjà tapée
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(f);
    if (f.type !== 'application/pdf') { $('#read-status').textContent = 'Image : lecture automatique impossible. Saisissez les informations à la main.'; showPreview(f); return; }
    $('#read-status').textContent = 'Lecture du voucher…';
    try {
      const v = parseVoucher(await readPdf(f));
      if (!v.textLength) { $('#read-status').textContent = 'Ce PDF ne contient pas de texte (scan) : saisie manuelle.'; showPreview(f); return; }
      const { draft: d, marks: m } = draftFromVoucher(v);
      if (keep.reference) d.reference = keep.reference;
      const url = fileUrl; fileUrl = null; // conservé pour l'aperçu du nouveau formulaire
      openForm(null, d, m, `${m.size} information(s) lue(s)${v.supplier ? ' · voucher ' + v.supplier : ' · fournisseur non reconnu'}. Vérifiez les champs en bleu et complétez les champs en orange (référence, prix d’achat${d.deadlineLocal ? ', décalage UTC du début des frais' : ', début des frais'}).`);
      fileUrl = url; showPreview(f);
    } catch { $('#read-status').textContent = 'Lecture impossible : saisissez les informations à la main.'; }
  };

  form.onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const rooms = [...form.querySelectorAll('.bk-room')].map(el => { const i = el.dataset.room; return { type: fd[`room${i}.type`], meal: fd[`room${i}.meal`], description: fd[`room${i}.description`], adults: Number(fd[`room${i}.adults`]), childrenAges: String(fd[`room${i}.ages`] ?? '').split(/[,;\s]+/).filter(Boolean).map(Number) }; });
    const cancellation = [...form.querySelectorAll('.bk-row[data-cancel]')].map(el => { const i = el.dataset.cancel; return { from: fd[`can${i}.from`], to: fd[`can${i}.to`], charge: fd[`can${i}.charge`] }; }).filter(p => p.from || p.to || p.charge);
    const lead = fd.leadGuest?.trim();
    const guests = [lead, ...String(fd.otherGuests ?? '').split('\n')].map(s => s?.trim()).filter(Boolean).map(s => { const m = s.match(/^(.*?)\s*\(chambre (\d+)\)$/i); return { name: m ? m[1] : s, room: m ? Number(m[2]) : 1, age: null }; });
    const nonRefundable = !!fd.nonRefundable;
    const body = { reference: fd.reference, supplier: fd.supplier, supplierRef: fd.supplierRef, hotel: fd.hotel, address: fd.address, city: fd.city, country: fd.country, checkin: fd.checkin, checkout: fd.checkout, bookedOn: fd.bookedOn || null, leadGuest: lead, nationality: fd.nationality, rooms, guests, cancellation, payment: fd.payment, nonRefundable, deadline: nonRefundable ? null : (fd.deadlineLocal && fd.offset ? fd.deadlineLocal + ':00' + fd.offset : ''), noShow: fd.noShow, notes: fd.notes, purchase: { amount: Math.round(Number(fd.price) * 100), currency: fd.currency }, hbPlaceId: existing?.hbPlaceId ?? null, validated: !!fd.validated };
    try {
      const r = await api(existing ? `/api/bookings/${existing.id}` : '/api/bookings', { method: existing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      bookings = bookings.filter(x => x.id !== r.booking.id).concat(r.booking).sort((a, b) => a.checkin.localeCompare(b.checkin));
      $('#modal').close(); render(); toast('Dossier enregistré. Aucune action chez le fournisseur.');
    } catch (err) { $('#bk-error').textContent = ERRORS[err.message] ?? 'Enregistrement impossible (' + err.message + ').'; }
  };
  if (existing) $('#compare-now').onclick = () => openCompare(existing);
  if (canDelete) $('#delete').onclick = async () => {
    if ($('#delete').dataset.confirm !== '1') { $('#delete').dataset.confirm = '1'; $('#delete').textContent = 'Confirmer la suppression du dossier (rien n’est annulé chez le fournisseur)'; return; }
    try { await api(`/api/bookings/${existing.id}`, { method: 'DELETE' }); bookings = bookings.filter(x => x.id !== existing.id); $('#modal').close(); render(); toast('Dossier supprimé. Aucune annulation fournisseur.'); }
    catch (err) { $('#bk-error').textContent = ERRORS[err.message] ?? err.message; }
  };
}
function showPreview(f) {
  const box = $('#file-preview'); if (!box || !fileUrl) return;
  box.replaceChildren();
  if (f.type === 'application/pdf') { const a = document.createElement('a'); a.href = fileUrl; a.target = '_blank'; a.rel = 'noopener'; a.className = 'text-button'; a.textContent = `Ouvrir ${f.name} ↗`; box.append(a); }
  else { const im = document.createElement('img'); im.src = fileUrl; im.alt = 'Voucher'; im.className = 'upload-preview'; box.append(im); }
}

// ---- Comparaison d'un dossier, dans cette page (aucune action fournisseur) ----
const NATIONALITIES = [['FR', 'France'], ['MA', 'Maroc'], ['BE', 'Belgique'], ['CH', 'Suisse'], ['GB', 'Royaume-Uni'], ['DZ', 'Algérie'], ['TN', 'Tunisie'], ['TR', 'Turquie'], ['SA', 'Arabie saoudite'], ['AE', 'Émirats arabes unis']];
const RESIDENCES = [['FR', 'France'], ['MA', 'Maroc'], ['BE', 'Belgique'], ['CH', 'Suisse'], ['GB', 'Royaume-Uni']];
const SUP_ERRORS = { CONFIGURATION_MISSING: 'Accès non configurés sur le serveur.', SUPPLIER_AUTH_FAILED: 'Accès refusé par le fournisseur.', SUPPLIER_UNREACHABLE: 'Fournisseur injoignable pour le moment.', QUOTA_EXCEEDED: 'Quota de requêtes du fournisseur atteint.', CHILD_AGE_OVER_12: 'Halalbooking accepte les enfants jusqu’à 12 ans : recherche refusée.', CRITERIA_INVALID: 'Critères refusés (dates passées ou séjour trop long).', NETWORK: 'Connexion impossible.' };
const norm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export function nationalityCode(text) {
  const n = norm(text); if (!n) return null;
  let en = null; try { en = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* noms français seulement */ }
  return NATIONALITIES.find(([c, fr]) => norm(fr) === n || norm(en?.of(c)) === n || c.toLowerCase() === n)?.[0] ?? null;
}
const fmtUtc = t => t === Infinity ? 'jusqu’à l’arrivée' : 'jusqu’au ' + new Date(t).toLocaleString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC';

async function openCompare(b) {
  const nat = nationalityCode(b.nationality);
  const head = `<div class="dossier-banner"><div><strong>${esc(b.reference)} · ${esc(b.hotel)}</strong><p>Acheté ${esc(money(b.purchase))} chez ${esc(b.supplier)} · ${esc(MEALS[bookingMeal(b) ?? 'unknown'])} · ${b.nonRefundable ? 'non remboursable' : 'sans frais jusqu’au ' + esc(fmtDeadline(b.deadline))}</p><p>${fmtDate(b.checkin)} → ${fmtDate(b.checkout)} · ${b.rooms.map((r, i) => `ch. ${i + 1} : ${r.adults} adulte(s)${r.childrenAges.length ? ' + enfants ' + r.childrenAges.join(', ') + ' ans' : ''}`).join(' ; ')}</p></div></div>`;
  openModal('Comparer le dossier', 'Offres actuelles des fournisseurs connectés · aucune réservation ni annulation.', `${head}
    <div class="form-grid" style="margin:16px 0"><label>Pays de résidence du client<select id="cmp-country">${RESIDENCES.map(([c, l]) => `<option value="${c}">${l}</option>`).join('')}</select></label>
    <label>Nationalité (TBO)<select id="cmp-nat">${nat ? '' : '<option value="">À choisir</option>'}${NATIONALITIES.map(([c, l]) => `<option value="${c}" ${c === nat ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="wide" id="cmp-hotel"></div></div>
    <p class="subtle">Pays de résidence non enregistré dans le dossier : vérifiez-le avant de lancer.${nat ? '' : ` Nationalité « ${esc(b.nationality ?? 'non renseignée')} » non reconnue.`}</p>
    <div class="form-actions" style="margin-top:8px"><button type="button" class="primary" id="cmp-run" ${b.hbPlaceId ? '' : 'disabled'}>Lancer la comparaison</button></div>
    <p id="cmp-status" class="subtle" role="status"></p><div class="cmp-grid" id="cmp-results"></div>`);
  $('#modal').classList.add('wide-modal');
  const hotelBox = $('#cmp-hotel');
  const drawHotel = () => {
    if (b.hbPlaceId) { hotelBox.innerHTML = `<p class="subtle">Hôtel du catalogue rattaché au dossier (n° ${esc(b.hbPlaceId)}). <button type="button" class="text-button" id="cmp-relink">Changer</button></p>`; $('#cmp-relink').onclick = () => { b = { ...b, hbPlaceId: null }; $('#cmp-run').disabled = true; drawHotel(); }; return; }
    hotelBox.innerHTML = `<label>Hôtel correspondant dans le catalogue (choisi une fois, rattaché au dossier)<input id="cmp-q" value="${esc(b.hotel)}" autocomplete="off"></label><ul class="place-suggest cmp-suggest" id="cmp-sugg"></ul>`;
    let t = null;
    const look = () => { clearTimeout(t); t = setTimeout(async () => {
      const q = $('#cmp-q').value.trim(); if (q.length < 2) return;
      const d = await api('/api/places/suggest?q=' + encodeURIComponent(q)).catch(() => ({ hotels: [] }));
      $('#cmp-sugg').innerHTML = (d.hotels ?? []).map((h, i) => `<li data-h="${i}">${esc(h.name)}<small>${esc([h.city, h.country].filter(Boolean).join(', '))}</small></li>`).join('')
        + (b.city ? `<li data-city="1" class="cmp-city">🔎 Chercher « ${esc(q)} » parmi les hôtels Halalbooking disponibles à ${esc(b.city)} (quelques secondes)</li>` : (d.hotels ?? []).length ? '' : '<li class="group">Aucun hôtel trouvé dans le catalogue : essayez le début du nom.</li>');
      const city = $('#cmp-sugg').querySelector('[data-city]');
      if (city) city.onclick = async () => {
        city.textContent = 'Recherche dans les hôtels Halalbooking de ' + b.city + '…';
        const words = norm(q).split(/\s+/).filter(w => w.length > 1);
        const hits = [];
        for (let page = 1; page <= 15; page++) { // destination : 20 hôtels par page, disponibles aux dates du dossier
          const r = await fetch('/api/halalbooking/destination', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: b.city, checkin: b.checkin, checkout: b.checkout, rooms: b.rooms.map(x => ({ adults: x.adults, children: [...x.childrenAges] })), country: $('#cmp-country').value, page }) }).then(x => x.ok ? x.json() : null).catch(() => null);
          if (!r) break;
          for (const h of r.hotels ?? []) if (words.every(w => norm(h.name).includes(w))) hits.push({ id: h.id, name: h.name, city: b.city, country: b.country });
          if (page >= (r.totalPages ?? 1)) break;
        }
        d.hotels = hits;
        $('#cmp-sugg').innerHTML = hits.map((h, i) => `<li data-h="${i}">${esc(h.name)}<small>${esc(b.city)} · disponible aux dates du dossier</small></li>`).join('') || `<li class="group">Aucun hôtel Halalbooking disponible à ${esc(b.city)} ne correspond à « ${esc(q)} » aux dates du dossier. La comparaison reste impossible sans cet hôtel.</li>`;
        bindHits();
      };
      const bindHits = () => $('#cmp-sugg').querySelectorAll('[data-h]').forEach(li => { li.onclick = async () => {
        const h = d.hotels[Number(li.dataset.h)];
        try { const r = await api(`/api/bookings/${b.id}/hotel`, { method: 'POST', body: JSON.stringify({ hbPlaceId: h.id }) }); b = r.booking; bookings = bookings.map(x => x.id === b.id ? b : x); drawHotel(); $('#cmp-run').disabled = false; runCompare(b); }
        catch (e) { $('#cmp-status').textContent = 'Rattachement impossible (' + e.message + ').'; }
      }; });
      bindHits();
    }, 200); };
    $('#cmp-q').oninput = look; look();
  };
  drawHotel();
  $('#cmp-run').onclick = () => runCompare(b);
  if (b.hbPlaceId) runCompare(b);
}

async function runCompare(b) {
  const nationality = $('#cmp-nat').value;
  if (!nationality) { $('#cmp-status').textContent = 'Choisissez la nationalité (demandée par TBO).'; return; }
  const q = { hotelId: b.hbPlaceId, checkin: b.checkin, checkout: b.checkout, rooms: b.rooms.map(r => ({ adults: r.adults, children: [...r.childrenAges] })), country: $('#cmp-country').value };
  $('#cmp-run').disabled = true; $('#cmp-status').textContent = 'Recherche en cours auprès des fournisseurs…';
  const cards = { halalbooking: { name: 'Halalbooking', state: 'loading' }, tbo: { name: 'TBO', state: 'loading' }, ratehawk: { name: 'RateHawk', state: 'loading' }, bedsonline: { name: 'Bedsonline', state: 'loading' } };
  const draw = () => { $('#cmp-results').innerHTML = Object.entries(cards).map(([id, c]) => cmpCard(id, c, b)).join(''); };
  draw();
  const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const d = await r.json().catch(() => ({})); return r.ok ? { d } : { error: d.detail || d.error || 'SUPPLIER_ERROR' }; }).catch(() => ({ error: 'NETWORK' }));
  const set = (id, make) => r => { cards[id] = { ...cards[id], ...(r.error ? { state: 'error', error: r.error } : make(r.d)) }; draw(); };
  await Promise.all([
    post('/api/halalbooking/search', q).then(set('halalbooking', d => ({ state: 'ok', panel: hbPanel(d, {}) }))),
    post('/api/tbo/search', { ...q, nationality }).then(set('tbo', d => d.status === 'not_mapped' ? { state: 'unmapped' } : d.status === 'currency_not_eur' ? { state: 'error', error: 'Devise ' + d.currency + ' (euro imposé)' } : { state: 'ok', panel: tboPanel(d, {}) })),
    post('/api/ratehawk/search', { ...q, nationality }).then(set('ratehawk', d => d.status === 'not_mapped' ? { state: 'unmapped' } : d.status === 'currency_not_eur' ? { state: 'error', error: 'Devise ' + d.currency + ' (euro imposé)' } : { state: 'ok', panel: rhPanel(d, {}), env: d.environment })),
    post('/api/bedsonline/search', q).then(set('bedsonline', d => d.status === 'not_mapped' ? { state: 'unmapped' } : { state: 'ok', panel: bedsPanel(d, {}, q.rooms.length), env: d.environment })),
  ]);
  $('#cmp-status').textContent = `Relevé du ${new Date().toLocaleString('fr-FR')} · prix à reconfirmer chez le fournisseur avant toute décision.`;
  $('#cmp-run').disabled = false;
}

function cmpCard(id, c, b) {
  const shell = (top, body, cls = '') => `<article class="cmp-card ${cls}"><div class="cmp-top">${esc(top)}</div><h3>${esc(c.name)}</h3>${body}</article>`;
  if (c.state === 'off') return shell('NON CONNECTÉ', '<p class="subtle">Accès API en attente.</p>', 'off');
  if (c.state === 'loading') return shell('RECHERCHE…', '<p class="subtle">Recherche en cours…</p>');
  if (c.state === 'unmapped') return shell('HÔTEL NON ASSOCIÉ', `<p class="subtle">Hôtel pas encore associé chez ${esc(c.name)}. Un administrateur peut l’associer depuis le comparateur.</p><a class="text-button" href="/?dossier=${esc(b.id)}" target="_blank" rel="noopener">Ouvrir dans le comparateur ↗</a>`);
  if (c.state === 'error') return shell('ERREUR FOURNISSEUR', `<p class="subtle">${esc(SUP_ERRORS[c.error] ?? c.error)} Ce n’est pas une absence de chambres ; aucun tarif fictif ne la remplace.</p>`);
  const p = c.panel;
  if (!p?.received) return shell('AUCUNE OFFRE', '<p class="subtle">Aucune disponibilité retournée pour ces critères.</p>');
  if (typeof p.total !== 'number') return shell('INCOMPLET', '<p class="subtle">Pas d’offre couvrant toutes les chambres : aucun total partiel.</p>');
  const a = assessPanel(p, b);
  const amount = a.diff == null ? '' : `${a.diff < 0 ? '−' : '+'}${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: b.purchase.currency }).format(Math.abs(a.diff))}`;
  const verdict = a.status === 'gain' ? `Gain potentiel ${amount}` : a.status === 'none' ? `Pas moins cher (${amount})` : `À vérifier${amount ? ' · écart ' + amount : ''}`;
  const rooms = p.pick.flatMap(o => o.roomNames ?? [o.roomName ?? o.room ?? 'Chambre non renseignée']);
  const free = p.pick.map(o => freeUntilOf(id, o));
  const cancel = free.some(t => t == null) ? 'Non remboursable ou conditions à vérifier' : 'Sans frais ' + fmtUtc(Math.min(...free));
  const top = id === 'tbo' ? 'STAGING · TEST' : id === 'ratehawk' && c.env !== 'production' ? 'BAC À SABLE · TEST' : id === 'bedsonline' && c.env !== 'production' ? 'TEST · ÉVALUATION' : 'OFFRES RÉELLES';
  const label = id === 'tbo' ? 'Montant TBO (net à confirmer)' : p.netConfirmed ? 'Net agence' : 'Net estimé';
  return shell(top, `<div class="cmp-price">${esc(new Intl.NumberFormat('fr-FR', { style: 'currency', currency: p.currency ?? 'EUR' }).format(p.total))}</div><p class="subtle">${label} · total séjour · ${b.rooms.length} chambre(s)</p>
    <p><strong>${rooms.map(esc).join('<br>')}</strong></p><p>${esc(MEALS[p.mealCode] ?? 'Pension non reconnue')} · ${esc(cancel)}</p>
    <div class="dossier-assess ${a.status}"><strong>${esc(verdict)}</strong>${a.status === 'gain' ? '<p>Chambre à comparer avec le dossier (« ' + esc(b.rooms.map(r => r.type).join(' / ')) + ' »).</p>' : ''}${a.reasons.length ? `<p>${esc(a.reasons.join(' · '))}</p>` : ''}</div>`, a.status);
}

$('#add').onclick = () => openForm();
$('#q').oninput = render; $('#filter').onchange = render;
setInterval(render, 60000);
fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(d => { me = d?.user ?? null; }).catch(() => {});
load();
