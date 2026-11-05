// Dossiers de réservation (module Réservations) : partagés entre agents connectés, stockés dans D1.
// Données nominatives : jamais de fichier voucher conservé, jamais de journalisation du contenu.
// Aucune action fournisseur (consultation seule) ; pas de surveillance ni d'email à ce stade.

export const SUPPLIERS = ['TBO', 'Halalbooking', 'Bedsonline', 'RateHawk', 'Autre'];
export const MEALS = ['RO', 'BB', 'HB', 'FB', 'AI', 'unknown'];
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'AED', 'TRY', 'MAD', 'JPY'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/;

const fail = code => { throw new Error(code); };
const str = (v, max, required = false) => {
  if (v == null || v === '') { if (required) fail('FIELD_REQUIRED'); return null; }
  if (typeof v !== 'string') fail('FIELD_INVALID');
  const s = v.trim(); if (!s && required) fail('FIELD_REQUIRED');
  if (s.length > max) fail('FIELD_TOO_LONG');
  return s || null;
};
const date = (v, required = false) => { if (v == null || v === '') { if (required) fail('DATE_INVALID'); return null; } if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) fail('DATE_INVALID'); return v; };
const int = (v, min, max) => { if (!Number.isInteger(v) || v < min || v > max) fail('NUMBER_INVALID'); return v; };

/** Contrôle complet d'un dossier saisi (après validation humaine obligatoire). */
export function validateBooking(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('BODY_INVALID');
  const out = {
    reference: str(b.reference, 80, true),
    supplier: SUPPLIERS.includes(b.supplier) ? b.supplier : fail('SUPPLIER_INVALID'),
    supplierRef: str(b.supplierRef, 80),
    hotel: str(b.hotel, 200, true), address: str(b.address, 300), city: str(b.city, 120), country: str(b.country, 120),
    checkin: date(b.checkin, true), checkout: date(b.checkout, true), bookedOn: date(b.bookedOn),
    leadGuest: str(b.leadGuest, 120, true), nationality: str(b.nationality, 60),
    rooms: [], guests: [], cancellation: [],
    purchase: null, payment: ['prepaid', 'hotel', 'unknown'].includes(b.payment) ? b.payment : 'unknown',
    nonRefundable: b.nonRefundable === true,
    deadline: null, noShow: str(b.noShow, 120), notes: str(b.notes, 2000),
  };
  if (out.checkout <= out.checkin) fail('DATES_ORDER');
  if (!Array.isArray(b.rooms) || b.rooms.length < 1 || b.rooms.length > 9) fail('ROOMS_INVALID');
  out.rooms = b.rooms.map(r => {
    const ages = Array.isArray(r?.childrenAges) ? r.childrenAges.map(a => int(a, 0, 17)) : [];
    if (ages.length > 6) fail('ROOMS_INVALID');
    return { type: str(r?.type, 200, true), meal: MEALS.includes(r?.meal) ? r.meal : fail('MEAL_INVALID'), description: str(r?.description, 500), adults: int(r?.adults, 1, 9), childrenAges: ages };
  });
  if (b.guests != null) {
    if (!Array.isArray(b.guests) || b.guests.length > 40) fail('GUESTS_INVALID');
    out.guests = b.guests.map(g => ({ name: str(g?.name, 120, true), room: int(g?.room, 1, 9), age: g?.age == null ? null : int(g.age, 0, 17) }));
  }
  if (b.cancellation != null) {
    if (!Array.isArray(b.cancellation) || b.cancellation.length > 10) fail('CANCELLATION_INVALID');
    out.cancellation = b.cancellation.map(p => ({ from: date(p?.from, true), to: date(p?.to, true), charge: str(p?.charge, 40) }));
  }
  const p = b.purchase;
  if (!p || !Number.isInteger(p.amount) || p.amount <= 0 || p.amount > 1e9 || !CURRENCIES.includes(p.currency)) fail('PURCHASE_INVALID');
  out.purchase = { amount: p.amount, currency: p.currency }; // centimes
  // Début des frais : date, heure et décalage UTC saisis ou confirmés par l'agent (TBO n'indique ni heure ni fuseau).
  if (out.nonRefundable) { if (b.deadline) fail('DEADLINE_INVALID'); }
  else if (typeof b.deadline !== 'string' || !DEADLINE.test(b.deadline) || Number.isNaN(Date.parse(b.deadline))) fail('DEADLINE_INVALID');
  else out.deadline = b.deadline;
  if (b.validated !== true) fail('VALIDATION_REQUIRED');
  return out;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, data TEXT NOT NULL, checkin TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS bookings_checkin ON bookings(checkin)',
];
let ready = null;
const fromRow = r => r && { id: r.id, ...JSON.parse(r.data), createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by };

export function createBookingStore(db) {
  if (db?.__bookingsMemory) return db.__bookingsMemory;
  const ensure = () => (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
  return {
    async list(limit = 500) { await ensure(); return ((await db.prepare('SELECT * FROM bookings ORDER BY checkin LIMIT ?').bind(limit).all()).results ?? []).map(fromRow); },
    async get(id) { await ensure(); return fromRow(await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first()); },
    async create(data, email, now = Date.now()) { await ensure(); const id = crypto.randomUUID(); await db.prepare('INSERT INTO bookings (id, data, checkin, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)').bind(id, JSON.stringify(data), data.checkin, now, email, now, email).run(); return this.get(id); },
    async update(id, data, email, now = Date.now()) { await ensure(); const r = await db.prepare('UPDATE bookings SET data = ?, checkin = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(JSON.stringify(data), data.checkin, now, email, id).run(); return r.meta?.changes ? this.get(id) : null; },
    async remove(id) { await ensure(); const r = await db.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run(); return !!r.meta?.changes; },
  };
}

/** Mémoire (tests). */
export function createMemoryBookingStore() {
  const m = new Map();
  return {
    async list() { return [...m.values()].sort((a, b) => a.checkin.localeCompare(b.checkin)); },
    async get(id) { return m.get(id) ?? null; },
    async create(data, email, now = Date.now()) { const id = crypto.randomUUID(); const r = { id, ...data, createdAt: now, createdBy: email, updatedAt: now, updatedBy: email }; m.set(id, r); return r; },
    async update(id, data, email, now = Date.now()) { const old = m.get(id); if (!old) return null; const r = { ...old, ...data, id, updatedAt: now, updatedBy: email }; m.set(id, r); return r; },
    async remove(id) { return m.delete(id); },
  };
}
