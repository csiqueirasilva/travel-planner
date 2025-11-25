const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const OpenAPIClientAxios = require('openapi-client-axios').default;
require('dotenv').config();

const BASE = process.env.BASE_URL || process.env.BASE_PROD || 'https://leiame.app';
const STUDENT_TOKEN = process.env.STUDENT_TOKEN || '1234567';
const OTHER_TOKEN = process.env.OTHER_TOKEN || randomMatricula(); // used for cross-access tests
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const OPENAPI_PATH = path.join(__dirname, '..', 'src', 'openapi.json');
const OPENAPI_CLIENT_PATH = path.join(__dirname, '..', 'src', 'openapi-client.json');
const OPENAPI_ADMIN_PATH = path.join(__dirname, '..', 'src', 'openapi-admin.json');

if (!ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN env required to run full API coverage tests');
}

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

async function expectJsonWithRetry(path, opts = {}, expectedStatus = 200, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const res = await api(path, opts);
    if (res.status === expectedStatus) return res.json();
    lastErr = res.status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(lastErr, expectedStatus, `${path} expected ${expectedStatus}, got ${lastErr}`);
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

async function getOpenApiClient() {
  const definition = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
  const api = new OpenAPIClientAxios({ definition, axiosConfigDefaults: { baseURL: BASE } });
  return api.getClient();
}

test('health responds', async () => {
  const data = await expectJson('/health');
  assert.equal(data.status, 'ok');
});

test('status endpoint responds', async () => {
  const data = await expectJson('/status');
  assert.equal(data.status, 'ok');
});

test('auth login echoes bearer token', async () => {
  const mat = randomMatricula();
  const res = await expectJson('/auth/login', {
    method: 'POST',
    body: { matricula: mat },
  });
  assert.equal(res.token, mat);
  assert.ok(typeof res.bearer === 'string' && res.bearer.includes(mat));
});

test('auth login rejects invalid matricula format', async () => {
  const res = await api('/auth/login', {
    method: 'POST',
    body: { matricula: 'abc' },
  });
  assert.equal(res.status, 400);
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

test('admin can create and manage any client', async () => {
  const mat = randomMatricula();
  const body = { matricula: mat, name: 'Admin Created', email: `admin${mat}@example.com` };
  const created = await expectJson('/clients', { method: 'POST', token: ADMIN_TOKEN, body }, 201);
  assert.equal(created.matricula, mat);

  const fetched = await expectJson(`/clients/${mat}`, { token: ADMIN_TOKEN });
  assert.equal(fetched.matricula, mat);

  await expectJson(`/clients/${mat}`, { method: 'DELETE', token: ADMIN_TOKEN });
});

test('invalid auth token format returns explicit 401', async () => {
  const res = await api('/clients', {
    method: 'POST',
    token: 'bad-token',
    body: { matricula: randomMatricula(), name: 'Bad Token', email: 'bad@example.com' },
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.ok(
    typeof data.error === 'string' && data.error.toLowerCase().includes('authorization'),
    'should include auth error detail'
  );
});

test('admin can list clients', async () => {
  const list = await expectJson('/clients', { token: ADMIN_TOKEN });
  assert.ok(Array.isArray(list), 'admin should list clients');
  assert.ok(list.some((c) => c.matricula === '1234567'), 'seed student should be present');
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

test('clients can update their own profile data', async () => {
  const mat = randomMatricula();
  const createBody = { matricula: mat, name: 'Updatable User', email: `update${mat}@example.com` };
  await expectJson('/clients', { method: 'POST', token: mat, body: createBody }, 201);

  const updated = await expectJson(`/clients/${mat}`, {
    method: 'PUT',
    token: mat,
    body: { matricula: mat, name: 'Updated User', email: `updated${mat}@example.com`, active: false },
  });
  assert.equal(updated.name, 'Updated User');
  assert.equal(updated.email, `updated${mat}@example.com`);
  assert.equal(updated.active, false);

  const fetched = await expectJson(`/clients/${mat}`, { token: mat });
  assert.equal(fetched.name, 'Updated User');

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

  const fetched = await expectJson(`/purchases/${created.id}`, { token: STUDENT_TOKEN });
  assert.equal(fetched.id, created.id);

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

test('admin CRUD for locations, hotels, planes and sales report', async () => {
  const locBody = { name: 'Loc Admin Test', city: 'Test City', country: 'TC' };
  const location = await expectJson('/locations', { method: 'POST', token: ADMIN_TOKEN, body: locBody }, 201);
  assert.ok(location.id);

  const locData = await expectJson(`/locations/${location.id}`);
  assert.equal(locData.id, location.id);

  const updatedLoc = await expectJson(`/locations/${location.id}`, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: { name: 'Loc Admin Test Updated' },
  });
  assert.equal(updatedLoc.name, 'Loc Admin Test Updated');

  const hotelBody = {
    name: 'Admin Hotel Test',
    city: 'Test City',
    country: 'TC',
    price: 100,
    stars: 3,
    amenities: ['wifi'],
    locationId: location.id,
  };
  const hotel = await expectJson('/hotels', { method: 'POST', token: ADMIN_TOKEN, body: hotelBody }, 201);
  assert.ok(hotel.id);

  const hotelData = await expectJson(`/hotels/${hotel.id}`);
  assert.equal(hotelData.id, hotel.id);

  const availability = await expectJson(`/hotels/${hotel.id}/availability`);
  assert.equal(availability.hotelId, hotel.id);

  const planeBody = {
    code: `AD${Date.now()}`.slice(0, 8),
    origin: 'AAA',
    destination: 'BBB',
    departure: '2030-01-01T10:00:00Z',
    arrival: '2030-01-01T12:00:00Z',
    price: 50,
  };
  const plane = await expectJson('/planes', { method: 'POST', token: ADMIN_TOKEN, body: planeBody }, 201);
  assert.ok(plane.id);

  const planeData = await expectJson(`/planes/${plane.id}`);
  assert.equal(planeData.id, plane.id);

  const search = await expectJson(`/planes/search?origin=${planeBody.origin}&destination=${planeBody.destination}`);
  assert.ok(search.some((p) => p.id === plane.id));

  const report = await expectJson('/reports/sales', { token: ADMIN_TOKEN });
  assert.ok(report && typeof report === 'object');

  await expectJson(`/planes/${plane.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
  await expectJson(`/hotels/${hotel.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
  await expectJson(`/locations/${location.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
});

test('admin updates hotels via put/patch and students are blocked', async () => {
  const suffix = Date.now();
  const location = await expectJson('/locations', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { name: `Hotel Update Loc ${suffix}`, city: 'Cidade', country: 'BR' },
  }, 201);

  const studentLocUpdate = await api(`/locations/${location.id}`, {
    method: 'PUT',
    token: STUDENT_TOKEN,
    body: { name: 'Sem permissao', city: 'Cidade', country: 'BR' },
  });
  assert.equal(studentLocUpdate.status, 403);

  const studentLocDelete = await api(`/locations/${location.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  assert.equal(studentLocDelete.status, 403);

  const hotel = await expectJson('/hotels', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: {
      name: `Hotel Update ${suffix}`,
      city: 'Cidade',
      country: 'BR',
      price: 200,
      stars: 3,
      amenities: ['wifi'],
      locationId: location.id,
    },
  }, 201);

  const updated = await expectJson(`/hotels/${hotel.id}`, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: {
      name: `Hotel Update ${suffix} v2`,
      city: 'Outra Cidade',
      country: 'BR',
      price: 250,
      stars: 4,
      amenities: ['wifi'],
    },
  });
  assert.equal(updated.name, `Hotel Update ${suffix} v2`);
  assert.equal(updated.stars, 4);

  const patched = await expectJson(`/hotels/${hotel.id}`, {
    method: 'PATCH',
    token: ADMIN_TOKEN,
    body: { price: 275, amenities: ['wifi', 'pool'] },
  });
  assert.equal(patched.price, 275);
  assert.ok(patched.amenities.includes('pool'));

  const studentPatch = await api(`/hotels/${hotel.id}`, {
    method: 'PATCH',
    token: STUDENT_TOKEN,
    body: { price: 999 },
  });
  assert.equal(studentPatch.status, 403);

  const studentPut = await api(`/hotels/${hotel.id}`, {
    method: 'PUT',
    token: STUDENT_TOKEN,
    body: { name: 'Hotel estudante', city: 'Cidade', country: 'BR' },
  });
  assert.equal(studentPut.status, 403);

  await expectJson(`/hotels/${hotel.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
  await expectJson(`/locations/${location.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
});

test('admin updates planes and blocks student updates', async () => {
  const suffix = Date.now();
  const plane = await expectJson('/planes', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: {
      code: `UP${suffix}`.slice(0, 8),
      origin: 'RIO',
      destination: 'SSA',
      departure: '2030-02-01T10:00:00Z',
      arrival: '2030-02-01T12:00:00Z',
      price: 100,
    },
  }, 201);

  const updated = await expectJson(`/planes/${plane.id}`, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: {
      code: `UP${suffix + 1}`.slice(0, 8),
      origin: 'GRU',
      destination: 'MEX',
      departure: '2030-02-02T10:00:00Z',
      arrival: '2030-02-02T12:00:00Z',
      price: 150,
    },
  });
  assert.equal(updated.origin, 'GRU');
  assert.equal(updated.destination, 'MEX');
  assert.equal(updated.price, 150);

  const studentUpdate = await api(`/planes/${plane.id}`, {
    method: 'PUT',
    token: STUDENT_TOKEN,
    body: { code: 'STU1234', origin: 'AAA', destination: 'BBB', price: 1 },
  });
  assert.equal(studentUpdate.status, 403);

  const studentDelete = await api(`/planes/${plane.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  assert.equal(studentDelete.status, 403);

  await expectJson(`/planes/${plane.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
});

test('offers detail and update require admin for mutation', async () => {
  const suffix = Date.now();
  const offer = await expectJson('/offers', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: {
      title: `Oferta Editavel ${suffix}`,
      description: 'Oferta para teste de update',
      discountPercent: 15,
      validUntil: '2031-01-01',
    },
  }, 201);

  const detail = await expectJson(`/offers/${offer.id}`);
  assert.equal(detail.id, offer.id);

  const updated = await expectJson(`/offers/${offer.id}`, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: {
      title: `Oferta Editada ${suffix}`,
      description: 'Descricao atualizada',
      discountPercent: 20,
    },
  });
  assert.equal(updated.discountPercent, 20);

  const studentUpdate = await api(`/offers/${offer.id}`, {
    method: 'PUT',
    token: STUDENT_TOKEN,
    body: { title: 'Sem Permissao', discountPercent: 5 },
  });
  assert.equal(studentUpdate.status, 403);

  const studentDelete = await api(`/offers/${offer.id}`, { method: 'DELETE', token: STUDENT_TOKEN });
  assert.equal(studentDelete.status, 403);

  await expectJson(`/offers/${offer.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
});

test('itinerary with booking linkage and cleanup', async () => {
  const mat = randomMatricula();
  await ensureClientExists(mat);
  await ensureClientExists(OTHER_TOKEN);

  // positive: create itinerary and booking with owner token
  const itinerary = await expectJson(
    '/itineraries',
    {
      method: 'POST',
      token: mat,
      body: { name: 'Teste Itinerário', notes: 'Anotar passeios' },
    },
    201
  );
  assert.ok(itinerary.id);

  const booking = await expectJson(
    '/bookings',
    {
      method: 'POST',
      token: mat,
      body: { clientMatricula: mat, hotelId: 1, itineraryId: itinerary.id, totalAmount: 500 },
    },
    201
  );
  assert.ok(booking.id);

  const itData = await expectJsonWithRetry(
    `/itineraries/${itinerary.id}`,
    { token: mat },
    200,
    10
  );
  assert.ok(Array.isArray(itData.bookings));

  // negative: missing/other auth
  const itNoAuth = await api(`/itineraries/${itinerary.id}`);
  assert.equal(itNoAuth.status, 401, 'itinerary read requires auth');

  const itForbidden = await api(`/itineraries/${itinerary.id}`, { token: OTHER_TOKEN });
  assert.equal(itForbidden.status, 403, 'other user should not read itinerary');

  const updatedItinerary = await expectJson(
    `/itineraries/${itinerary.id}`,
    {
      method: 'PUT',
      token: mat,
      body: { name: 'Itinerário Atualizado', notes: 'Notas novas' },
    }
  );
  assert.equal(updatedItinerary.name, 'Itinerário Atualizado');

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
    body: { clientMatricula: mat, hotelId: 1, totalAmount: 123 },
  });
  assert.equal(bookingCrossCreate.status, 403, 'cannot create booking for another matricula');

  const bookingNoAuth = await api(`/bookings/${booking.id}`);
  assert.equal(bookingNoAuth.status, 401, 'booking read requires auth');

  // cleanup booking and itinerary
  await expectJson(`/bookings/${booking.id}`, { method: 'DELETE', token: mat });
  await expectJson(`/itineraries/${itinerary.id}`, { method: 'DELETE', token: mat });

  const redeleted = await api(`/itineraries/${itinerary.id}`, { method: 'DELETE', token: mat });
  assert.equal(redeleted.status, 404);
});

test('booking detail and update are available to the owner', async () => {
  const mat = randomMatricula();
  await ensureClientExists(mat);

  const booking = await expectJson(
    '/bookings',
    {
      method: 'POST',
      token: mat,
      body: { clientMatricula: mat, hotelId: 1, planeId: 1, totalAmount: 321 },
    },
    201
  );
  assert.ok(booking.id);

  const detail = await expectJson(`/bookings/${booking.id}`, { token: mat });
  assert.equal(detail.id, booking.id);

  const updated = await expectJson(`/bookings/${booking.id}`, {
    method: 'PUT',
    token: mat,
    body: { clientMatricula: mat, totalAmount: 400, status: 'UPDATED' },
  });
  assert.equal(updated.totalAmount, 400);
  assert.equal(updated.status, 'UPDATED');

  await expectJson(`/bookings/${booking.id}`, { method: 'DELETE', token: mat });
  await expectJson(`/clients/${mat}`, { method: 'DELETE', token: mat });
});

test('creating itineraries requires authentication', async () => {
  const res = await api('/itineraries', {
    method: 'POST',
    body: { name: 'Sem auth nao pode' },
  });
  assert.equal(res.status, 401);
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
  const farMatricula = String(farId);
  await expectStatus(`/locations/${farId}`, {}, 404);
  await expectStatus(`/locations/${farId}`, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: { name: 'Missing', city: 'Nowhere', country: 'NA' },
  }, 404);
  await expectStatus(`/locations/${farId}`, { method: 'DELETE', token: ADMIN_TOKEN }, 404);
  await expectStatus(`/hotels/${farId}`, {}, 404);
  await expectStatus(`/hotels/${farId}/availability`, {}, 404);
  await expectStatus(`/hotels/${farId}`, {
    method: 'PUT',
    token: ADMIN_TOKEN,
    body: { name: 'Missing Hotel', city: 'NA', country: 'NA', price: 0 },
  }, 404);
  await expectStatus(`/hotels/${farId}`, { method: 'PATCH', token: ADMIN_TOKEN, body: { price: 1 } }, 404);
  await expectStatus(`/hotels/${farId}`, { method: 'DELETE', token: ADMIN_TOKEN }, 404);
  await expectStatus(`/planes/${farId}`, {}, 404);
  await expectStatus(
    `/planes/${farId}`,
    {
      method: 'PUT',
      token: ADMIN_TOKEN,
      body: { code: 'XX0000', origin: 'AAA', destination: 'BBB', price: 1 },
    },
    404
  );
  await expectStatus(`/planes/${farId}`, { method: 'DELETE', token: ADMIN_TOKEN }, 404);
  await expectStatus(`/offers/${farId}`, {}, 404);
  await expectStatus(
    `/offers/${farId}`,
    { method: 'PUT', token: ADMIN_TOKEN, body: { title: 'Missing Offer', discountPercent: 1 } },
    404
  );
  await expectStatus(`/offers/${farId}`, { method: 'DELETE', token: ADMIN_TOKEN }, 404);
  await expectStatus(`/purchases/${farId}`, { token: STUDENT_TOKEN }, 404);
  await expectStatus(`/bookings/${farId}`, { token: STUDENT_TOKEN }, 404);
  await expectStatus(
    `/bookings/${farId}`,
    { method: 'PUT', token: STUDENT_TOKEN, body: { clientMatricula: STUDENT_TOKEN, totalAmount: 1 } },
    404
  );
  await expectStatus(
    `/clients/${farMatricula}`,
    {
      method: 'PUT',
      token: farMatricula,
      body: { matricula: farMatricula, name: 'Missing Client', email: `missing${farMatricula}@example.com` },
    },
    404
  );
  await expectStatus(`/clients/${farMatricula}`, { method: 'DELETE', token: farMatricula }, 404);
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

test('admin-only endpoints allow admin token end-to-end', async () => {
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

test('reports clients and top destinations require admin', async () => {
  await ensureClientExists(STUDENT_TOKEN);
  const clientsReport = await expectJson('/reports/clients', { token: ADMIN_TOKEN });
  assert.ok(clientsReport.total >= 1, 'clients report should return totals');
  assert.ok(Array.isArray(clientsReport.clients), 'clients list should be present');

  const topDest = await expectJson('/reports/top-destinations', { token: ADMIN_TOKEN });
  assert.ok(topDest && Array.isArray(topDest.top), 'top destinations should be an array');

  const studentClients = await api('/reports/clients', { token: STUDENT_TOKEN });
  assert.equal(studentClients.status, 403);
  const studentTop = await api('/reports/top-destinations', { token: STUDENT_TOKEN });
  assert.equal(studentTop.status, 403);
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

test('split openapi specs stay under 30 operations', () => {
  const clientDoc = JSON.parse(fs.readFileSync(OPENAPI_CLIENT_PATH, 'utf8'));
  const adminDoc = JSON.parse(fs.readFileSync(OPENAPI_ADMIN_PATH, 'utf8'));
  const countOps = (doc) =>
    Object.values(doc.paths || {}).reduce((acc, methods) => acc + Object.keys(methods || {}).length, 0);
  assert.ok(countOps(clientDoc) <= 30, 'client openapi spec capped at 30 operations');
  assert.ok(countOps(adminDoc) <= 30, 'admin openapi spec capped at 30 operations');
  assert.ok(clientDoc.paths?.['/auth/login']?.post, 'client spec keeps auth/login');
  assert.ok(adminDoc.paths?.['/reports/usage']?.get, 'admin spec keeps reports/usage');
  assert.ok(!adminDoc.paths?.['/auth/login'], 'admin spec excludes auth/login to stay lean');
});

test('openapi client schema drives a successful client creation', async () => {
  const openApiPath = path.join(__dirname, '..', 'src', 'openapi.json');
  const doc = JSON.parse(fs.readFileSync(openApiPath, 'utf8'));
  const clientPost =
    doc.paths?.['/clients']?.post?.requestBody?.content?.['application/json']?.schema;
  assert.ok(clientPost, 'clients POST should define requestBody schema');
  assert.ok(
    Array.isArray(clientPost.required) &&
      clientPost.required.includes('matricula') &&
      clientPost.required.includes('name') &&
      clientPost.required.includes('email'),
    'clients POST schema should require matricula, name, email'
  );

  // ensure all operations have operationId
  Object.entries(doc.paths || {}).forEach(([p, methods]) => {
    Object.entries(methods || {}).forEach(([m, cfg]) => {
      if (cfg && typeof cfg === 'object') {
        assert.ok(cfg.operationId, `operationId missing for ${m.toUpperCase()} ${p}`);
      }
    });
  });

  const mat = randomMatricula();
  const body = { matricula: mat, name: 'OpenAPI User', email: `openapi${mat}@example.com` };
  const created = await expectJson('/clients', { method: 'POST', token: mat, body }, 201);
  assert.equal(created.matricula, mat);

  const fetched = await expectJson(`/clients/${mat}`, { token: mat });
  assert.equal(fetched.matricula, mat);

  await expectJson(`/clients/${mat}`, { method: 'DELETE', token: mat });
});

test('openapi client can call all operations (smoke)', async () => {
  const client = await getOpenApiClient();
  // health/status
  const health = await client.healthCheck();
  assert.equal(health.data.status, 'ok');
  const status = await client.statusCheck();
  assert.equal(status.data.status, 'ok');

  // auth login positive/negative
  const mat = randomMatricula();
  const login = await client.login({ matricula: mat });
  assert.equal(login.data.token, mat);
  const invalidLoginRes = await client.login({ matricula: 'abc' }).catch((err) => err.response);
  assert.equal(invalidLoginRes.status, 400);

  // ensure client exists for further calls
  await ensureClientExists(STUDENT_TOKEN);
  await ensureClientExists(OTHER_TOKEN);

  // locations list
  const locs = await client.listLocations();
  assert.ok(Array.isArray(locs.data));

  // hotels list and detail
  const hotels = await client.listHotels({ city: 'Rio de Janeiro' });
  assert.ok(Array.isArray(hotels.data));
  if (hotels.data.length > 0) {
    const h = hotels.data[0];
    const hd = await client.getHotel({ id: h.id });
    assert.equal(hd.data.id, h.id);
    const avail = await client.getHotelAvailability({ id: h.id });
    assert.equal(avail.data.hotelId, h.id);
    const revs = await client.listHotelReviews({ id: h.id });
    assert.ok(Array.isArray(revs.data));
  }

  // planes
  const planes = await client.listPlanes({ origin: 'RIO', destination: 'SAO' });
  assert.ok(Array.isArray(planes.data));
  if (planes.data.length > 0) {
    const p = planes.data[0];
    const pd = await client.getPlane({ id: p.id });
    assert.equal(pd.data.id, p.id);
    const search = await client.searchPlanes({ origin: p.origin, destination: p.destination });
    assert.ok(Array.isArray(search.data));
  }

  // offers
  const offersToday = await client.listTodayOffers();
  assert.ok(Array.isArray(offersToday.data));
  const offersAny = await client.listOffers();
  assert.ok(Array.isArray(offersAny.data));

  // purchases negative (unauthorized)
  const badPurchaseRes = await client
    .createPurchase({}, { headers: { 'Content-Type': 'application/json' } })
    .catch((err) => err.response);
  assert.equal(badPurchaseRes.status, 401);

  // bookings negative (unauthorized)
  const badBookingRes = await client
    .createBooking({}, { headers: { 'Content-Type': 'application/json' } })
    .catch((err) => err.response);
  assert.equal(badBookingRes.status, 401);
});
