import assert from 'node:assert/strict';
import { test } from 'node:test';

const BASE = 'https://leiame.app';

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  assert.equal(res.ok, true, `Expected ok for ${path}, got ${res.status}`);
  return res.json();
}

test('health endpoint responds', async () => {
  const data = await getJson('/health');
  assert.equal(data.status, 'ok');
});

test('hotels list is not empty', async () => {
  const hotels = await getJson('/hotels');
  assert.ok(Array.isArray(hotels), 'Hotels response should be an array');
  assert.ok(hotels.length > 0, 'Hotels list should have at least one item');
  assert.ok(hotels[0].name, 'Hotel should have a name');
});

test('locations list is not empty', async () => {
  const locations = await getJson('/locations');
  assert.ok(Array.isArray(locations));
  assert.ok(locations.length > 0);
});

test('planes search returns at least one flight for seeded route', async () => {
  const planes = await getJson('/planes/search?origin=RIO&destination=SAO');
  assert.ok(Array.isArray(planes));
  assert.ok(planes.length > 0, 'Expected at least one plane in seeded data');
});

test('offers endpoints respond', async () => {
  const today = await getJson('/offers/today');
  assert.ok(Array.isArray(today));
  const dated = await getJson('/offers?date=2026-01-01');
  assert.ok(Array.isArray(dated));
});
