const assert = require('node:assert/strict');
const { test } = require('node:test');

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

  // another token should be forbidden
  const resForbidden = await api(`/clients/${mat}`, { token: STUDENT_TOKEN });
  assert.equal(resForbidden.status, 403, 'accessing another matricula should be forbidden');

  // cleanup
  const del = await expectJson(`/clients/${mat}`, { method: 'DELETE', token: mat });
  assert.equal(del.deleted, true);
});

test('purchases respect ownership; create, update, delete', async () => {
  // ensure OTHER_TOKEN client exists for negative test
  await expectJson('/clients', { method: 'POST', token: OTHER_TOKEN, body: { matricula: OTHER_TOKEN, name: 'Other', email: `other${OTHER_TOKEN}@example.com` } }, 201);

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

  const deleted = await expectJson(`/purchases/${created.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  assert.equal(deleted.deleted, true);
});

test('itinerary with booking linkage and cleanup', async () => {
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

test('unauthorized purchase creation is rejected', async () => {
  const res = await api('/purchases', {
    method: 'POST',
    body: { clientMatricula: STUDENT_TOKEN, hotelId: 1, planeId: 1, totalAmount: 100 },
  });
  assert.equal(res.status, 401);
});
