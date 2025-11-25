const assert = require('node:assert/strict');
const { test } = require('node:test');
require('dotenv').config();

const BASE = 'https://leiame.app';
const STUDENT_TOKEN = process.env.STUDENT_TOKEN || '1234567';
const OTHER_TOKEN = process.env.OTHER_TOKEN || randomMatricula(); // used for cross-access tests

function randomMatricula() {
  // 7-digit string, avoid leading zero
  const n = Math.floor(1000000 + Math.random() * 9000000);
  return String(n);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = token;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function expectJson(path, opts = {}, expectedStatus = 200) {
  const res = await api(path, opts);
  assert.equal(res.status, expectedStatus, `${path} expected ${expectedStatus}, got ${res.status}`);
  return res.json();
}

async function expectStatus(path, opts = {}, expectedStatus = 200) {
  const res = await api(path, opts);
  assert.equal(res.status, expectedStatus, `${path} expected ${expectedStatus}, got ${res.status}`);
  return res;
}

async function ensureClientExists(matricula, token = matricula) {
  const body = { matricula, name: `User ${matricula}`, email: `user${matricula}@example.com` };
  const res = await api('/clients', { method: 'POST', token, body });
  if (res.status === 201) return res.json();
  if (res.status === 409) {
    return expectJson(`/clients/${matricula}`, { token });
  }
  assert.equal(res.status, 201, `Failed to ensure client ${matricula} exists`);
}

test('health responds', async () => {
  const data = await expectJson('/health');
  assert.equal(data.status, 'ok');
});

test('locations and hotels are available with filters', async () => {
  const locations = await expectJson('/locations');
  assert.ok(Array.isArray(locations) && locations.length > 0, 'locations list should not be empty');

  const hotels = await expectJson('/hotels?city=Rio de Janeiro&priceMin=100&priceMax=2000&amenities=wifi');
  assert.ok(Array.isArray(hotels) && hotels.length > 0, 'filtered hotels should not be empty');
  const hotel = hotels[0];
  const detail = await expectJson(`/hotels/${hotel.id}`);
  assert.equal(detail.id, hotel.id);

  const availability = await expectJson(`/hotels/${hotel.id}/availability?startDate=2025-12-01&endDate=2025-12-05`);
  assert.equal(availability.hotelId, hotel.id);
});

test('planes search and detail', async () => {
  const planes = await expectJson('/planes/search?origin=RIO&destination=SAO');
  assert.ok(planes.length > 0, 'should find at least one seeded plane');
  const p = planes[0];
  const detail = await expectJson(`/planes/${p.id}`);
  assert.equal(detail.id, p.id);
});

test('offers today and by date', async () => {
  const today = await expectJson('/offers/today');
  assert.ok(Array.isArray(today));
  const dated = await expectJson('/offers?date=2026-01-01');
  assert.ok(Array.isArray(dated));
});

test('client lifecycle with self-access only', async () => {
  const mat = randomMatricula();
  const body = { matricula: mat, name: 'Test User', email: `user${mat}@example.com` };
  const created = await expectJson('/clients', { method: 'POST', token: mat, body }, 201);
  assert.equal(created.matricula, mat);

  const mine = await expectJson(`/clients/${mat}`, { token: mat });
  assert.equal(mine.matricula, mat);

  const resNoAuth = await api(`/clients/${mat}`);
  assert.equal(resNoAuth.status, 401, 'client endpoints require authentication');

  // another token should be forbidden for read/update/delete
  const resForbidden = await api(`/clients/${mat}`, { token: STUDENT_TOKEN });
  assert.equal(resForbidden.status, 403, 'accessing another matricula should be forbidden');

  const resUpdateForbidden = await api(`/clients/${mat}`, {
    method: 'PUT',
    token: STUDENT_TOKEN,
    body: { name: 'Intruder' },
  });
  assert.equal(resUpdateForbidden.status, 403, 'updating another matricula should be forbidden');

  const resDeleteForbidden = await api(`/clients/${mat}`, { method: 'DELETE', token: STUDENT_TOKEN });
  assert.equal(resDeleteForbidden.status, 403, 'deleting another matricula should be forbidden');

  // cleanup
  const del = await expectJson(`/clients/${mat}`, { method: 'DELETE', token: mat });
  assert.equal(del.deleted, true);
});

test('client validation and duplicate protection', async () => {
  const invalidRes = await api('/clients', {
    method: 'POST',
    token: STUDENT_TOKEN,
    body: { matricula: '123', name: 'Bad', email: 'bad@example.com' },
  });
  assert.equal(invalidRes.status, 400, 'matricula must have 7 digits');

  const mat = randomMatricula();
  const body = { matricula: mat, name: 'Dup Test', email: `dup${mat}@example.com` };
  await expectJson('/clients', { method: 'POST', token: mat, body }, 201);
  const dupRes = await api('/clients', { method: 'POST', token: mat, body });
  assert.equal(dupRes.status, 409, 'duplicate matricula should not be allowed');
  await expectJson(`/clients/${mat}`, { method: 'DELETE', token: mat });
});

test('purchases respect ownership; create, update, delete', async () => {
  await ensureClientExists(STUDENT_TOKEN);
  await ensureClientExists(OTHER_TOKEN);

  const crossCreate = await api('/purchases', {
    method: 'POST',
    token: OTHER_TOKEN,
    body: {
      clientMatricula: STUDENT_TOKEN,
      hotelId: 1,
      planeId: 1,
      totalAmount: 999,
    },
  });
  assert.equal(crossCreate.status, 403, 'cannot create purchase for another matricula');

  const purchaseBody = {
    clientMatricula: STUDENT_TOKEN,
    hotelId: 1,
    planeId: 1,
    checkIn: '2025-12-01',
    checkOut: '2025-12-05',
    guests: 2,
    totalAmount: 1200,
  };
  const created = await expectJson('/purchases', { method: 'POST', token: STUDENT_TOKEN, body: purchaseBody }, 201);
  assert.ok(created.id);

  const resNoAuth = await api(`/purchases/${created.id}`);
  assert.equal(resNoAuth.status, 401, 'purchase read requires auth');

  const forbiddenRead = await api(`/purchases/${created.id}`, { token: OTHER_TOKEN });
  assert.equal(forbiddenRead.status, 403, 'other user should not read purchase');

  const updated = await expectJson(`/purchases/${created.id}`, {
    method: 'PUT',
    token: STUDENT_TOKEN,
    body: { guests: 3, totalAmount: 1300 },
  });
  assert.equal(updated.guests, 3);

  const forbidden = await api(`/purchases/${created.id}`, {
    method: 'PUT',
    token: OTHER_TOKEN,
    body: { guests: 4 },
  });
  assert.equal(forbidden.status, 403, 'other user should not update purchase');

  const forbiddenDelete = await api(`/purchases/${created.id}`, {
    method: 'DELETE',
    token: OTHER_TOKEN,
  });
  assert.equal(forbiddenDelete.status, 403, 'other user should not delete purchase');

  const deleted = await expectJson(`/purchases/${created.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  assert.equal(deleted.deleted, true);
});

test('itinerary with booking linkage and cleanup', async () => {
  await ensureClientExists(STUDENT_TOKEN);
  await ensureClientExists(OTHER_TOKEN);

  const itinerary = await expectJson('/itineraries', {
    method: 'POST',
    token: STUDENT_TOKEN,
    body: { name: 'Teste Itinerário', notes: 'Anotar passeios' },
  }, 201);
  assert.ok(itinerary.id);

  const booking = await expectJson('/bookings', {
    method: 'POST',
    token: STUDENT_TOKEN,
    body: { clientMatricula: STUDENT_TOKEN, hotelId: 1, itineraryId: itinerary.id, totalAmount: 500 },
  }, 201);
  assert.ok(booking.id);

  const itData = await expectJson(`/itineraries/${itinerary.id}`, { token: STUDENT_TOKEN });
  assert.ok(Array.isArray(itData.bookings));

  const itNoAuth = await api(`/itineraries/${itinerary.id}`);
  assert.equal(itNoAuth.status, 401, 'itinerary read requires auth');

  const itForbidden = await api(`/itineraries/${itinerary.id}`, { token: OTHER_TOKEN });
  assert.equal(itForbidden.status, 403, 'other user should not read itinerary');

  const itDeleteForbidden = await api(`/itineraries/${itinerary.id}`, {
    method: 'DELETE',
    token: OTHER_TOKEN,
  });
  assert.equal(itDeleteForbidden.status, 403, 'other user should not delete itinerary');

  const bookingReadForbidden = await api(`/bookings/${booking.id}`, { token: OTHER_TOKEN });
  assert.equal(bookingReadForbidden.status, 403, 'other user should not read booking');

  const bookingUpdateForbidden = await api(`/bookings/${booking.id}`, {
    method: 'PUT',
    token: OTHER_TOKEN,
    body: { totalAmount: 999 },
  });
  assert.equal(bookingUpdateForbidden.status, 403, 'other user should not update booking');

  const bookingDeleteForbidden = await api(`/bookings/${booking.id}`, {
    method: 'DELETE',
    token: OTHER_TOKEN,
  });
  assert.equal(bookingDeleteForbidden.status, 403, 'other user should not delete booking');

  const bookingCrossCreate = await api('/bookings', {
    method: 'POST',
    token: OTHER_TOKEN,
    body: { clientMatricula: STUDENT_TOKEN, hotelId: 1, totalAmount: 123 },
  });
  assert.equal(bookingCrossCreate.status, 403, 'cannot create booking for another matricula');

  const bookingNoAuth = await api(`/bookings/${booking.id}`);
  assert.equal(bookingNoAuth.status, 401, 'booking read requires auth');

  // cleanup booking and itinerary
  await expectJson(`/bookings/${booking.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  await expectJson(`/itineraries/${itinerary.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
});

test('reviews can be posted and listed', async () => {
  const review = await expectJson('/hotels/1/reviews', {
    method: 'POST',
    token: STUDENT_TOKEN,
    body: { rating: 5, comment: 'Teste de review automatizado' },
  }, 201);
  assert.ok(review.id);
  const list = await expectJson('/hotels/1/reviews');
  assert.ok(Array.isArray(list) && list.some((r) => r.id === review.id));
});

test('posting reviews without auth is rejected', async () => {
  const res = await api('/hotels/1/reviews', {
    method: 'POST',
    body: { rating: 4, comment: 'Should not be accepted without token' },
  });
  assert.equal(res.status, 401, 'review POST should require authentication');
});

test('unauthorized purchase creation is rejected', async () => {
  const res = await api('/purchases', {
    method: 'POST',
    body: { clientMatricula: STUDENT_TOKEN, hotelId: 1, planeId: 1, totalAmount: 100 },
  });
  assert.equal(res.status, 401);
});

test('missing resources return 404 with auth provided', async () => {
  await ensureClientExists(STUDENT_TOKEN);
  const farId = 9999999;
  await expectStatus(`/hotels/${farId}`, {}, 404);
  await expectStatus(`/hotels/${farId}/availability`, {}, 404);
  await expectStatus(`/planes/${farId}`, {}, 404);
  await expectStatus(`/offers/${farId}`, {}, 404);
  await expectStatus(`/purchases/${farId}`, { token: STUDENT_TOKEN }, 404);
  await expectStatus(`/bookings/${farId}`, { token: STUDENT_TOKEN }, 404);
  await expectStatus(`/itineraries/${farId}`, { token: STUDENT_TOKEN }, 404);
});

test('double delete on purchases returns 404 after first removal', async () => {
  await ensureClientExists(STUDENT_TOKEN);
  const purchaseBody = {
    clientMatricula: STUDENT_TOKEN,
    hotelId: 1,
    planeId: 1,
    totalAmount: 500,
  };
  const created = await expectJson('/purchases', { method: 'POST', token: STUDENT_TOKEN, body: purchaseBody }, 201);
  await expectJson(`/purchases/${created.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  await expectStatus(`/purchases/${created.id}`, { method: 'DELETE', token: STUDENT_TOKEN }, 404);
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

test('admin-only endpoints allow admin token end-to-end', { skip: !ADMIN_TOKEN }, async () => {
  const suffix = Date.now();
  const location = await expectJson('/locations', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { name: `Admin Loc ${suffix}`, city: 'Admin City', country: 'BR' },
  }, 201);

  const hotel = await expectJson('/hotels', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: {
      name: `Admin Hotel ${suffix}`,
      city: 'Admin City',
      country: 'BR',
      address: 'Rua Admin',
      price: 123,
      stars: 4,
      amenities: ['wifi'],
      locationId: location.id,
    },
  }, 201);

  const plane = await expectJson('/planes', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: {
      code: `AD${suffix}`.slice(0, 8),
      origin: 'RIO',
      destination: 'SAO',
      departure: '2030-01-01T10:00:00Z',
      arrival: '2030-01-01T12:00:00Z',
      price: 999,
    },
  }, 201);

  const offer = await expectJson('/offers', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: {
      title: `Oferta Admin ${suffix}`,
      description: 'Oferta criada por teste admin',
      discountPercent: 10,
      validUntil: '2030-01-10',
    },
  }, 201);

  const clientsList = await expectJson('/clients', { token: ADMIN_TOKEN });
  assert.ok(Array.isArray(clientsList), 'admin should list clients');

  const salesReport = await expectJson('/reports/sales', { token: ADMIN_TOKEN });
  assert.ok(salesReport && typeof salesReport === 'object', 'admin should access sales report');

  const usage = await expectJson('/reports/usage', { token: ADMIN_TOKEN });
  assert.ok(Array.isArray(usage), 'admin should access usage logs');

  // cleanup created resources
  await expectJson(`/offers/${offer.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
  await expectJson(`/planes/${plane.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
  await expectJson(`/hotels/${hotel.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
  await expectJson(`/locations/${location.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
});
test('admin-only endpoints block student tokens', async () => {
  const adminOnlyOps = [
    { method: 'POST', path: '/hotels', body: { name: 'Hotel Sem Permissao' } },
    { method: 'DELETE', path: '/hotels/1' },
    { method: 'POST', path: '/locations', body: { name: 'Loc Sem Permissao', city: 'Cidade', country: 'BR' } },
    { method: 'POST', path: '/planes', body: { code: 'ZZ0001', origin: 'RIO', destination: 'SAO', price: 1 } },
    { method: 'POST', path: '/offers', body: { title: 'Oferta Negada', discountPercent: 5 } },
    { method: 'GET', path: '/clients' },
    { method: 'GET', path: '/reports/sales' },
    { method: 'GET', path: '/reports/usage' },
  ];

  for (const op of adminOnlyOps) {
    const res = await api(op.path, { method: op.method, token: STUDENT_TOKEN, body: op.body });
    assert.equal(res.status, 403, `${op.method} ${op.path} should require admin privileges`);
  }

  const missingAuth = await api('/hotels', { method: 'POST', body: { name: 'Sem Auth' } });
  assert.equal(missingAuth.status, 401, 'admin endpoints should reject missing Authorization header');
});
