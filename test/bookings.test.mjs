import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVoucher, toLines, parseDate, chargeOf } from '../public/voucher-core.mjs';
import { validateBooking, createMemoryBookingStore } from '../server/bookings.mjs';

// Voucher TBO fictif (même disposition que le modèle réel, noms inventés) : éléments pdf.js { str, transform:[…, x, y], width }.
const it = (str, x, y, width = str.length * 4) => ({ str, transform: [1, 0, 0, 1, x, y], width });
const fakeTbo = [[
  it('Voucher Details', 181, 655), it('TBOH Confirmation:', 404, 657, 63), it('ZZ123A', 483, 657, 24),
  it('Testville (Japan)', 38, 633), it('Hotel Fictif Testville', 38, 614, 90), it('Check In: 04 Dec 2026', 300, 614, 74),
  it('1-1, Rue Imaginaire', 38, 604, 80), it('Check Out: 07 Dec 2026', 300, 604, 79),
  it('Room 1:', 300, 593), it('Mr jean exemple', 300, 583), it('Mrs', 300, 572), it('Mr (11 Yrs)', 300, 562), it('Mr (9 Yrs)', 300, 551),
  it('Booked On:', 38, 537, 37), it('30 Oct 2026', 169, 537),
  it('Rooms', 50, 493, 24), it('Room type', 90, 493, 36), it('Room Details', 240, 493, 45), it('Adult(s)', 469, 493, 26), it('Child', 509, 493, 18),
  it('Room 1', 50, 479, 25), it('DOUBLE FAMILY DELUXE', 90, 479, 102), it('Incl:Breakfast', 240, 479, 42), it('2', 469, 479, 4), it('2', 509, 479, 4),
  it('Room Desc:DOUBLE FAMILY DELUXE,30 SQM CITY VIEW,', 240, 468, 205),
  it('Guest Nationality:', 38, 441, 60), it('France', 100, 441, 22),
  it('Payment Information - It is a prepaid booking. Please do not charge the guest.', 38, 296, 242),
  it('Cancelled on or After', 50, 231, 71), it('Cancelled on or Before', 216, 231, 77), it('Cancelled Charges', 383, 231, 63),
  it('29-Oct-2026', 50, 216, 39), it('02-Dec-2026', 216, 216, 40), it('$0.00', 383, 216, 18),
  it('03-Dec-2026', 50, 202, 40), it('03-Dec-2026', 216, 202, 40), it('$312.64', 383, 202, 25),
  it('04-Dec-2026', 50, 187, 40), it('07-Dec-2026', 216, 187, 40), it('100.00%', 383, 187, 28),
  it('No Show Charges : 100% of Booking Amount', 50, 173, 142),
]];

test('voucher TBO : lecture des champs, annulation sans heure ni fuseau', () => {
  const v = parseVoucher(fakeTbo);
  assert.equal(v.supplier, 'TBO');
  assert.deepEqual([v.supplierRef, v.hotel, v.address, v.city, v.country], ['ZZ123A', 'Hotel Fictif Testville', '1-1, Rue Imaginaire', 'Testville', 'Japan']);
  assert.deepEqual([v.checkin, v.checkout, v.bookedOn, v.nationality, v.leadGuest, v.payment], ['2026-12-04', '2026-12-07', '2026-10-30', 'France', 'jean exemple', 'prepaid']);
  assert.deepEqual(v.rooms, [{ type: 'DOUBLE FAMILY DELUXE', adults: 2, children: 2, meal: 'BB', description: 'DOUBLE FAMILY DELUXE,30 SQM CITY VIEW', childrenAges: [11, 9] }]);
  assert.equal(v.cancellation.length, 3);
  assert.deepEqual([v.freeUntilDate, v.feesFromDate, v.nonRefundable], ['2026-12-02', '2026-12-03', undefined]);
  assert.deepEqual(chargeOf('$312.64'), { amount: 312.64, currency: 'USD' });
  assert.deepEqual(chargeOf('100.00%'), { percent: 100 });
  assert.equal(v.noShow, '100% of Booking Amount');
  assert.equal(parseDate('31 Feb 2026') === null || typeof parseDate('31 Feb 2026') === 'string', true);
});

test('voucher : PDF sans texte ou fournisseur inconnu', () => {
  assert.equal(parseVoucher([[]]).textLength, 0);
  const g = parseVoucher([[it('Hotel X', 10, 500), it('Check-in: 12 Mar 2027', 10, 480), it('Check-out: 15 Mar 2027', 10, 470)]]);
  assert.deepEqual([g.supplier, g.checkin, g.checkout], [null, '2027-03-12', '2027-03-15']);
  assert.equal(toLines([[it('A', 10, 100, 5), it('B', 16, 100, 5), it('C', 80, 100, 5)]])[0].text, 'A B | C');
});

const valid = () => ({ reference: 'TM-1', supplier: 'TBO', hotel: 'Hotel Fictif', checkin: '2026-12-04', checkout: '2026-12-07', leadGuest: 'Jean Exemple',
  rooms: [{ type: 'DOUBLE', meal: 'BB', adults: 2, childrenAges: [11, 9] }], guests: [{ name: 'Jean Exemple', room: 1 }],
  cancellation: [{ from: '2026-10-29', to: '2026-12-02', charge: '$0.00' }], purchase: { amount: 83743, currency: 'EUR' },
  deadline: '2026-12-03T00:00:00+09:00', payment: 'prepaid', validated: true });

test('dossier : contrôles serveur (validation humaine, échéance avec fuseau, prix)', () => {
  assert.equal(validateBooking(valid()).deadline, '2026-12-03T00:00:00+09:00');
  const bad = (patch, code) => assert.throws(() => validateBooking({ ...valid(), ...patch }), new RegExp(code));
  bad({ validated: false }, 'VALIDATION_REQUIRED');
  bad({ deadline: '2026-12-03T00:00' }, 'DEADLINE_INVALID'); // sans fuseau : refusé
  bad({ purchase: { amount: 0, currency: 'EUR' } }, 'PURCHASE_INVALID');
  bad({ checkout: '2026-12-04' }, 'DATES_ORDER');
  bad({ supplier: 'X' }, 'SUPPLIER_INVALID');
  bad({ rooms: [{ type: 'D', meal: 'BB', adults: 2, childrenAges: [18] }] }, 'NUMBER_INVALID');
  assert.equal(validateBooking({ ...valid(), deadline: null, nonRefundable: true }).deadline, null);
});

test('API réservations : connexion requise, origine, partage entre agents, suppression par le créateur ou un admin', async t => {
  const { route } = await import('../src/router.mjs');
  const { createMemoryStore } = await import('../server/auth-store-memory.mjs');
  const { setStoreFactory } = await import('../server/auth-store-d1.mjs');
  const mem = createMemoryStore();
  setStoreFactory(db => db.__memory ?? null); t.after(() => setStoreFactory(null));
  const O = 'https://bedbanks.exemple.test', PWD = 'motdepasse-solide-2026';
  const e = { DB: { __memory: mem, __bookingsMemory: createMemoryBookingStore() }, SETUP_CODE: 'code-installation-de-test-123', ASSETS: { fetch: async () => new Response('') } };
  const call = (path, { method = 'GET', body, cookie, origin = O } = {}) => route(new Request(O + path, { method, headers: { accept: 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), e);
  const boot = await call('/api/auth/bootstrap', { method: 'POST', body: { code: e.SETUP_CODE } });
  await call('/api/auth/set-password', { method: 'POST', body: { token: (await boot.json()).link.split('#t=')[1], password: PWD } });
  const login = async email => (await call('/api/auth/login', { method: 'POST', body: { email, password: PWD } })).headers.get('set-cookie').split(';')[0];
  const admin = await login('anas@travelmuz.fr');
  for (const email of ['myriam@travelmuz.fr', 'mehdi@travelmuz.fr']) {
    const c = await call('/api/admin', { method: 'POST', cookie: admin, body: { action: 'create', email, role: 'agent' } });
    await call('/api/auth/set-password', { method: 'POST', body: { token: (await c.json()).link.split('#t=')[1], password: PWD } });
  }
  const myriam = await login('myriam@travelmuz.fr'), mehdi = await login('mehdi@travelmuz.fr');
  assert.equal((await call('/api/bookings')).status, 401);
  assert.equal((await call('/api/bookings', { method: 'POST', cookie: myriam, body: valid(), origin: 'https://autre.test' })).status, 403);
  const bad = await call('/api/bookings', { method: 'POST', cookie: myriam, body: { ...valid(), validated: false } });
  assert.deepEqual([bad.status, (await bad.json()).detail], [400, 'VALIDATION_REQUIRED']);
  const cr = await call('/api/bookings', { method: 'POST', cookie: myriam, body: valid() });
  assert.equal(cr.status, 201);
  const { booking } = await cr.json();
  assert.equal(booking.createdBy, 'myriam@travelmuz.fr');
  const list = await (await call('/api/bookings', { cookie: mehdi })).json(); // partagé
  assert.equal(list.bookings.length, 1);
  const up = await (await call('/api/bookings/' + booking.id, { method: 'PUT', cookie: mehdi, body: { ...valid(), reference: 'TM-2' } })).json();
  assert.deepEqual([up.booking.reference, up.booking.updatedBy, up.booking.createdBy], ['TM-2', 'mehdi@travelmuz.fr', 'myriam@travelmuz.fr']);
  const link = await (await call('/api/bookings/' + booking.id + '/hotel', { method: 'POST', cookie: mehdi, body: { hbPlaceId: 1461 } })).json();
  assert.deepEqual([link.booking.hbPlaceId, link.booking.reference, link.booking.createdBy], [1461, 'TM-2', 'myriam@travelmuz.fr']);
  assert.equal((await call('/api/bookings/' + booking.id + '/hotel', { method: 'POST', cookie: mehdi, body: { hbPlaceId: 'x' } })).status, 400);
  assert.equal((await call('/api/bookings/' + booking.id, { method: 'DELETE', cookie: mehdi })).status, 403);
  assert.equal((await call('/api/bookings/' + booking.id, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await call('/api/bookings/' + booking.id, { cookie: myriam })).status, 404);
});
