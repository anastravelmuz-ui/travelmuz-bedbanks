// Lecture des vouchers (texte des PDF, extrait dans le navigateur avec pdf.js) : aucune donnée envoyée à un tiers.
// Le résultat est une proposition de saisie : l'agent vérifie et complète avant enregistrement (validation humaine).

/** Éléments texte pdf.js ({ str, transform }) → lignes : même ordonnée (±2), triées de gauche à droite, cellules séparées. */
export function toLines(pages) {
  const lines = [];
  for (const items of pages) {
    const rows = [];
    for (const it of items) {
      const s = String(it.str ?? '').replace(/\s+/g, ' ').trim();
      if (!s) continue;
      const x = it.transform?.[4] ?? 0, y = it.transform?.[5] ?? 0, w = it.width ?? s.length * 4;
      let row = rows.find(r => Math.abs(r.y - y) <= 2);
      if (!row) rows.push(row = { y, items: [] });
      row.items.push({ s, x, w });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      const cells = [];
      let end = -Infinity;
      for (const it of r.items) {
        if (cells.length && it.x - end < 8) cells[cells.length - 1] += ' ' + it.s; else cells.push(it.s);
        end = it.x + it.w;
      }
      lines.push({ cells, text: cells.join(' | ') });
    }
  }
  return lines;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** « 04 Dec 2026 », « 29-Oct-2026 » → « 2026-12-04 » ; null si non reconnu. */
export function parseDate(s) {
  const m = String(s ?? '').match(/(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s-]+(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  const d = `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(d + 'T00:00:00Z')) ? null : d;
}
const after = (text, label) => { const i = text.indexOf(label); return i < 0 ? null : text.slice(i + label.length).replace(/^[\s|:]*/, ''); };
const firstCell = s => (s ?? '').split(' | ')[0].trim() || null;

export function mealFromText(s) {
  const t = String(s ?? '').toLowerCase();
  if (/all ?inclusive|tout compris/.test(t)) return 'AI';
  if (/full board|pension compl/.test(t)) return 'FB';
  if (/half board|demi.?pension/.test(t)) return 'HB';
  if (/breakfast|petit.?d[ée]j/.test(t)) return 'BB';
  if (/room only|no meal|sans repas|chambre seule/.test(t)) return 'RO';
  return null;
}

export function detectSupplier(text) {
  if (/TBOH? Confirmation|TBO Holidays|tboholidays/i.test(text)) return 'TBO';
  if (/hotelbeds|bedsonline/i.test(text)) return 'Bedsonline';
  if (/ratehawk|emerging travel|ETG/i.test(text)) return 'RateHawk';
  if (/halal ?booking/i.test(text)) return 'Halalbooking';
  return null;
}

/** Voucher TBO (modèle « Voucher Details / TBOH Confirmation ») */
export function parseTbo(lines) {
  const out = { supplier: 'TBO', rooms: [], guests: [], cancellation: [] };
  const texts = lines.map(l => l.text);
  const find = re => texts.findIndex(t => re.test(t));
  const conf = texts.map(t => after(t, 'TBOH Confirmation')).find(Boolean); if (conf) out.supplierRef = firstCell(conf);
  const ci = texts.map(t => after(t, 'Check In')).find(Boolean); if (ci) out.checkin = parseDate(ci);
  const co = texts.map(t => after(t, 'Check Out')).find(Boolean); if (co) out.checkout = parseDate(co);
  const bo = texts.map(t => after(t, 'Booked On')).find(Boolean); if (bo) out.bookedOn = parseDate(bo);
  const nat = texts.map(t => after(t, 'Guest Nationality')).find(Boolean); if (nat) out.nationality = firstCell(nat);
  // Ville (Pays), puis nom de l'hôtel et adresse dans la colonne de gauche (lignes « Check In / Check Out »).
  const iCi = find(/Check In/);
  if (iCi >= 0) {
    out.hotel = lines[iCi].cells[0] && !/Check In/.test(lines[iCi].cells[0]) ? lines[iCi].cells[0] : null;
    const iCo = find(/Check Out/);
    if (iCo >= 0 && lines[iCo].cells.length > 1) out.address = lines[iCo].cells[0];
    for (let k = iCi - 1; k >= 0 && k >= iCi - 3; k--) {
      const m = texts[k].match(/^([^|()]+?)\s*\(([^)]+)\)\s*$/);
      if (m) { out.city = m[1].trim(); out.country = m[2].trim(); break; }
    }
  }
  // Voyageurs : « Room N: » puis une ligne par personne (« Mr Prénom Nom », « Mr (11 Yrs) »).
  let room = null;
  for (let k = Math.max(iCi, 0); k < lines.length; k++) {
    const cell = lines[k].cells[lines[k].cells.length - 1];
    if (/^Booked On|^Guest Itinerary/.test(texts[k])) break;
    const r = cell.match(/^Room\s*(\d+)\s*:/i); if (r) { room = Number(r[1]); continue; }
    if (room == null) continue;
    const g = cell.match(/^(Mr|Mrs|Ms|Miss|Mstr|Master|Dr)\.?\s*(.*?)\s*(?:\((\d{1,2})\s*Yrs?\))?\s*$/i);
    if (g) out.guests.push({ room, title: g[1], name: g[2] || null, age: g[3] != null ? Number(g[3]) : null });
  }
  out.leadGuest = out.guests.find(g => g.name)?.name ?? null;
  // Chambres : tableau « Rooms | Room type | Room Details | Adult(s) | Child ».
  const iTab = find(/Room type/);
  if (iTab >= 0) {
    let cur = null;
    for (let k = iTab + 1; k < lines.length; k++) {
      const c = lines[k].cells;
      if (/^Guest Nationality|^Hotel Rules|^Payment/.test(texts[k])) break;
      if (/^Room\s*\d+$/i.test(c[0])) {
        const nums = c.filter(x => /^\d+$/.test(x)).map(Number);
        cur = { type: c[1] ?? null, details: c.slice(2).filter(x => !/^\d+$/.test(x)).join(' '), adults: nums[0] ?? null, children: nums[1] ?? 0 };
        out.rooms.push(cur);
      } else if (cur) cur.details += ' ' + c.filter(x => !/^\d+$/.test(x)).join(' ');
    }
    for (const r of out.rooms) {
      r.meal = mealFromText((r.details.match(/Incl:\s*([^,]*?)(?=Room Desc|$)/i) ?? [])[1] ?? '');
      const desc = r.details.match(/Room Desc:\s*(.*)$/i);
      r.description = (desc ? desc[1] : r.details).trim().replace(/,\s*$/, '') || null;
      delete r.details;
      const ages = out.guests.filter(g => g.room === out.rooms.indexOf(r) + 1 && g.age != null).map(g => g.age);
      r.childrenAges = ages.length === r.children ? ages : null; // âges seulement s'ils correspondent au nombre d'enfants
    }
  }
  if (texts.some(t => /prepaid booking/i.test(t))) out.payment = 'prepaid';
  // Annulation : « du | au | frais » (dates sans heure ni fuseau chez TBO).
  const iCan = find(/Cancelled on or After/);
  if (iCan >= 0) {
    for (let k = iCan + 1; k < lines.length; k++) {
      const c = lines[k].cells;
      const from = parseDate(c[0]), to = parseDate(c[1]);
      if (!from || !to) { const ns = texts[k].match(/No Show Charges\s*:\s*(.*)/i); if (ns) out.noShow = ns[1].trim(); if (!from && !/No Show/i.test(texts[k])) break; continue; }
      out.cancellation.push({ from, to, charge: c[2] ?? null, ...chargeOf(c[2]) });
    }
    const free = out.cancellation.filter(p => p.amount === 0);
    const paid = out.cancellation.filter(p => p.amount > 0 || p.percent > 0).sort((a, b) => a.from.localeCompare(b.from));
    if (paid.length) out.feesFromDate = paid[0].from; // jour de début des frais, heure et fuseau non indiqués
    if (free.length) out.freeUntilDate = free.map(p => p.to).sort().at(-1);
    if (!free.length && paid.length && out.bookedOn && paid[0].from <= out.bookedOn) out.nonRefundable = true;
  }
  return out;
}

export function chargeOf(s) {
  const t = String(s ?? '').replace(/,/g, '');
  const pct = t.match(/([\d.]+)\s*%/); if (pct) return { percent: Number(pct[1]) };
  const m = t.match(/(\$|€|£|USD|EUR|GBP)?\s*([\d.]+)\s*(USD|EUR|GBP)?/i);
  if (!m) return {};
  const cur = { $: 'USD', '€': 'EUR', '£': 'GBP' }[m[1]] ?? ((m[1] || m[3] || '').toUpperCase() || null);
  return { amount: Number(m[2]), currency: cur };
}

/** Lecture générique : seulement les champs reconnaissables sans modèle fournisseur. */
export function parseGeneric(lines) {
  const out = { rooms: [], guests: [], cancellation: [] };
  const all = lines.map(l => l.text).join('\n');
  const grab = re => { const m = all.match(re); return m ? parseDate(m[1]) : null; };
  out.checkin = grab(/(?:Check[- ]?in|Arriv[ée]e)[^0-9\n]{0,20}(\d{1,2}[\s-]+[A-Za-z]{3}[a-z]*[\s-]+\d{4})/i);
  out.checkout = grab(/(?:Check[- ]?out|D[ée]part)[^0-9\n]{0,20}(\d{1,2}[\s-]+[A-Za-z]{3}[a-z]*[\s-]+\d{4})/i);
  return out;
}

/** Point d'entrée : pages pdf.js → proposition { supplier, champs…, found: [noms des champs lus] }. */
export function parseVoucher(pages) {
  const lines = toLines(pages);
  const supplier = detectSupplier(lines.map(l => l.text).join('\n'));
  const out = supplier === 'TBO' ? parseTbo(lines) : { ...parseGeneric(lines), supplier };
  out.found = Object.entries(out).filter(([k, v]) => k !== 'found' && v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k]) => k);
  out.textLength = lines.reduce((n, l) => n + l.text.length, 0); // 0 → PDF scanné / image : saisie manuelle
  return out;
}
