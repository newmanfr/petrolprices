/* Run with: node tests/core.test.js   (no dependencies; development only, not used by the website) */
'use strict';
const assert = require('assert');
const C = require('../app.js');

let passed = 0;
function test(name, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => ok(name), (e) => bad(name, e)); ok(name); }
  catch (e) { bad(name, e); }
}
function ok(n) { passed++; console.log('  ok   ' + n); }
function bad(n, e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }

// Fixture mirrors the schema observed in https://cheapfuelnearme.uk/api/v1/stations.json
const NOW = Date.parse('2026-10-21T12:00:00Z');
const payload = {
  source_generated_at: '2026-10-21T09:00:00.060000Z',
  count: 9,
  stations: [
    { id: 'a1', name: 'Reading Extra - Petrol Filling Station', brand: 'TESCO', postcode: 'RG1 8DF', town: 'Reading', lat: 51.46005, lon: -0.95608,
      prices: { E5: { pence_per_litre: 185.9, submitted_at: '2026-10-14T15:00:00Z' }, E10: { pence_per_litre: 175.9, submitted_at: '2026-10-20T15:00:00Z' }, B7S: { pence_per_litre: 199.9, submitted_at: '2026-09-28T17:00:00Z' } }, site_quiet: false, location_repaired: null },
    { id: 'a2', name: 'Sainsburys Pensby', brand: "SAINSBURY'S", postcode: 'CH61 7UB', town: 'Wirral', lat: 53.35295, lon: -3.09298,
      prices: { E10: { pence_per_litre: 173.9, submitted_at: '2026-10-13T07:00:00Z' } }, site_quiet: false, location_repaired: null },
    { id: 'a3', name: 'Hilltop Garage', brand: 'Hilltop Garage', postcode: 'LE7 7NL', town: 'Leicester', lat: 52.72012, lon: -1.12867,
      prices: { E10: { pence_per_litre: 175.9, submitted_at: '2026-09-16T19:00:00Z' } }, site_quiet: true, location_repaired: null },
    { id: 'a4', name: 'Odd Coords', brand: 'SHELL', postcode: 'KW148TU', town: 'Castletown', lat: null, lon: null,
      prices: { E10: { pence_per_litre: 170.0, submitted_at: '2026-10-20T10:00:00Z' } } },
    { id: 'a5', name: 'Bad Price', brand: 'BP', postcode: 'S1 1AA', town: 'Sheffield', lat: 53.38, lon: -1.47,
      prices: { E10: { pence_per_litre: 19.9, submitted_at: '2026-10-20T10:00:00Z' } } },
    { id: 'a6', name: 'No Timestamp', brand: 'ESSO', postcode: 'S1 2AA', town: 'Sheffield', lat: 53.381, lon: -1.471,
      prices: { E10: { pence_per_litre: 172.9 } } },
    { id: 'a7', name: 'Reading Esso', brand: 'ESSO', postcode: 'RG2 0AA', town: 'Reading', lat: 51.43, lon: -0.97,
      prices: { E10: { pence_per_litre: 168.9, submitted_at: '2026-10-21T08:00:00Z' }, B7P: { pence_per_litre: 209.9, submitted_at: '2026-10-21T08:00:00Z' } }, location_repaired: 'district_centre' },
    { id: 'a8', name: 'Empty', brand: 'BP', postcode: 'X', town: '', lat: 52, lon: -1, prices: {} },
    { id: 'a9', name: 'Swapped coords', brand: 'BP', postcode: 'S3 3AA', town: '', lat: -1.5, lon: 53.4,
      prices: { E10: { pence_per_litre: 171.9, submitted_at: '2026-10-20T10:00:00Z' } } }
  ]
};
const prepared = C.prepareStations(C.validatePayload(payload));

console.log('Postcodes');
test('normalises postcodes', () => {
  assert.strictEqual(C.normalisePostcode('rg18df'), 'RG1 8DF');
  assert.strictEqual(C.normalisePostcode('KW148TU'), 'KW14 8TU');
  assert.strictEqual(C.normalisePostcode('SW1A 1AA'), 'SW1A 1AA');
  assert.strictEqual(C.normalisePostcode('M1 1AE'), 'M1 1AE');
  assert.strictEqual(C.normalisePostcode('Leeds'), null);
  assert.strictEqual(C.normalisePostcode('12345'), null);
});
test('outcodes', () => {
  assert.strictEqual(C.normaliseOutcode('m1'), 'M1');
  assert.strictEqual(C.normaliseOutcode('SW1A'), 'SW1A');
  assert.strictEqual(C.normaliseOutcode('Leeds'), null);
});

console.log('Data preparation');
test('drops stations with no prices and keeps the rest', () => {
  assert.strictEqual(prepared.length, 8);
  assert.ok(!prepared.some((s) => s.id === 'a8'));
});
test('missing or out-of-UK coordinates become null', () => {
  assert.strictEqual(prepared.find((s) => s.id === 'a4').lat, null);
  assert.strictEqual(prepared.find((s) => s.id === 'a9').lat, null);
});
test('missing timestamp stays missing', () => {
  assert.strictEqual(prepared.find((s) => s.id === 'a6').prices.E10.at, null);
});
test('rejects malformed payloads', () => {
  assert.throws(() => C.validatePayload(null));
  assert.throws(() => C.validatePayload({ stations: [] }));
  assert.throws(() => C.validatePayload({ stations: 'x' }));
});
test('brand grouping', () => {
  assert.strictEqual(prepared.find((s) => s.id === 'a1').brandGroup, 'Tesco');
  assert.strictEqual(prepared.find((s) => s.id === 'a2').brandGroup, "Sainsbury's");
  assert.strictEqual(prepared.find((s) => s.id === 'a3').brandGroup, 'Independent');
  assert.strictEqual(prepared.find((s) => s.id === 'a3').brandLabel, '');
});
test('fuels come from the data', () => {
  const codes = C.availableFuels(prepared).map((f) => f.code);
  assert.deepStrictEqual(codes, ['E10', 'E5', 'B7S', 'B7P']);
});

console.log('Distance');
test('haversine: London to Manchester is about 163 miles', () => {
  const d = C.haversineMiles(51.5074, -0.1278, 53.4808, -2.2426);
  assert.ok(d > 160 && d < 166, String(d));
});
test('haversine: zero distance', () => assert.strictEqual(C.haversineMiles(52, -1, 52, -1), 0));

console.log('Search, filter, sort');
const reading = { lat: 51.4543, lon: -0.9781 };
function run(o) { return C.searchStations(prepared, Object.assign({ fuel: 'E10', center: reading, radiusMi: 5, brand: '', text: '', hideOld: false, now: NOW }, o)); }
test('radius filter finds only nearby stations', () => {
  const r = run({});
  assert.deepStrictEqual(r.results.map((x) => x.station.id).sort(), ['a1', 'a7']);
});
test('wider radius still excludes far stations', () => {
  const r = run({ radiusMi: 10 });
  assert.ok(!r.results.some((x) => x.station.id === 'a2'));
});
test('stations without coordinates are counted, not shown, in distance search', () => {
  const r = run({ radiusMi: 50 });
  assert.ok(r.noCoords >= 2);
  assert.ok(!r.results.some((x) => x.station.id === 'a4'));
});
test('implausible prices are hidden and counted', () => {
  const sheffield = { lat: 53.38, lon: -1.47 };
  const r = run({ center: sheffield, radiusMi: 5 });
  assert.strictEqual(r.implausible, 1);
  assert.deepStrictEqual(r.results.map((x) => x.station.id), ['a6']);
});
test('brand filter', () => {
  assert.deepStrictEqual(run({ brand: 'Tesco', radiusMi: 10 }).results.map((x) => x.station.id), ['a1']);
});
test('text filter ignores apostrophes and case', () => {
  const r = run({ center: null, text: 'SAINSBURYS' });
  assert.deepStrictEqual(r.results.map((x) => x.station.id), ['a2']);
  assert.strictEqual(r.results[0].distance, null);
});
test('postcode text matches with or without space', () => {
  assert.strictEqual(run({ center: null, text: 'rg28' }).results.length, 0);
  assert.strictEqual(run({ center: null, text: 'RG2' }).results.length, 1);
});
test('fuel filter excludes stations without that fuel', () => {
  assert.deepStrictEqual(run({ fuel: 'B7P', radiusMi: 10 }).results.map((x) => x.station.id), ['a7']);
});
test('empty result set', () => {
  assert.strictEqual(run({ text: 'zzzz' }).results.length, 0);
});
test('hide stale prices', () => {
  const lei = { lat: 52.72, lon: -1.13 };
  assert.strictEqual(run({ center: lei, radiusMi: 5 }).results.length, 1);
  const r = run({ center: lei, radiusMi: 5, hideOld: true });
  assert.strictEqual(r.results.length, 0);
  assert.strictEqual(r.old, 1);
});
test('sorting', () => {
  const r = run({ radiusMi: 10 }).results;
  assert.deepStrictEqual(C.sortResults(r, 'cheapest').map((x) => x.station.id), ['a7', 'a1']);
  const near = C.sortResults(r, 'nearest');
  assert.ok(near[0].distance <= near[1].distance);
  assert.deepStrictEqual(C.sortResults(r, 'name').map((x) => x.station.id), ['a7', 'a1']);
});
test('stats and tiers', () => {
  const r = run({ radiusMi: 10 }).results;
  const s = C.computeStats(r);
  assert.strictEqual(s.n, 2); assert.strictEqual(s.min, 168.9);
  assert.strictEqual(C.tierOf(168.9, s), 'best');
  assert.strictEqual(C.tierOf(175.9, s), 'normal');
  assert.strictEqual(C.computeStats([]), null);
});

console.log('Age');
test('age levels', () => {
  assert.strictEqual(C.ageInfo('2026-10-21T08:00:00Z', NOW).level, 'ok');
  assert.strictEqual(C.ageInfo('2026-10-12T08:00:00Z', NOW).level, 'old');
  assert.strictEqual(C.ageInfo('2026-09-16T19:00:00Z', NOW).level, 'stale');
  assert.strictEqual(C.ageInfo(null, NOW).level, 'missing');
  assert.strictEqual(C.ageInfo('garbage', NOW).level, 'missing');
});

console.log('Links');
test('direction links use coordinates when present, search otherwise', () => {
  const a = C.directionLinks(prepared.find((s) => s.id === 'a1'));
  assert.ok(a.google.includes('destination=51.46005,-0.95608'));
  assert.ok(a.osm.includes('route=%3B51.46005,-0.95608'));
  const b = C.directionLinks(prepared.find((s) => s.id === 'a4'));
  assert.ok(b.google.includes('query='));
});

console.log('Geocoding (mocked network)');
function mockFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [frag, res] of routes) {
      if (url.includes(frag)) {
        if (res instanceof Error) throw res;
        return { ok: res.status === undefined || (res.status >= 200 && res.status < 300), status: res.status || 200, json: async () => res.body };
      }
    }
    throw new TypeError('no route');
  };
  f.calls = calls;
  return f;
}
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } }; };

test('postcode lookup success and caching', async () => {
  const f = mockFetch([['/postcodes/M11AE', { body: { result: { latitude: 53.4807, longitude: -2.2426 } } }]]);
  const g = C.createGeocoder({ fetch: f, storage: mem(), sleep: async () => {} });
  const a = await g.geocode('m1 1ae');
  assert.strictEqual(a.label, 'M1 1AE'); assert.ok(Math.abs(a.lat - 53.4807) < 1e-6);
  await g.geocode('m1 1ae');
  assert.strictEqual(f.calls.length, 1, 'second lookup should be served from cache');
});
test('unknown postcode gives a useful error (no default location)', async () => {
  const g = C.createGeocoder({ fetch: mockFetch([['/postcodes/', { status: 404, body: {} }]]), storage: mem(), sleep: async () => {} });
  await assert.rejects(() => g.geocode('ZZ99 9ZZ'), (e) => e.code === 'notfound' && /ZZ99 9ZZ/.test(e.message));
});
test('outcode lookup', async () => {
  const g = C.createGeocoder({ fetch: mockFetch([['/outcodes/M1', { body: { result: { latitude: 53.48, longitude: -2.24 } } }]]), storage: mem() });
  const r = await g.geocode('M1');
  assert.strictEqual(r.kind, 'outcode');
});
test('place lookup via postcodes.io, ranks settlements first', async () => {
  const f = mockFetch([['/places?', { body: { result: [
    { name_1: 'Leeds Road', local_type: 'Named Road', latitude: 1, longitude: 1, county_unitary: 'X' },
    { name_1: 'Leeds', local_type: 'City', latitude: 53.8, longitude: -1.55, county_unitary: 'West Yorkshire' }] } }]]);
  const g = C.createGeocoder({ fetch: f, storage: mem() });
  const r = await g.geocode('Leeds');
  assert.strictEqual(r.label, 'Leeds, West Yorkshire');
  assert.strictEqual(r.alternatives.length, 2);
});
test('place lookup falls back to Nominatim and respects the 1 request/second gap', async () => {
  const f = mockFetch([['/places?', { status: 500, body: {} }], ['nominatim', { body: [{ lat: '51.48', lon: '-3.18', display_name: 'Cardiff, Wales, United Kingdom' }] }]]);
  const sleeps = [];
  let t = 1000000;
  const g = C.createGeocoder({ fetch: f, storage: mem(), now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  const r = await g.geocode('Cardiff');
  assert.strictEqual(r.label, 'Cardiff, Wales');
  assert.ok(f.calls.some((u) => u.includes('nominatim') && u.includes('countrycodes=gb')));
  const r2 = await g.geocode('Cardiff castle');   // uncached, immediate second call
  assert.ok(sleeps.some((ms) => ms > 0), 'second Nominatim call should wait');
});
test('network failure is reported as a network error', async () => {
  const g = C.createGeocoder({ fetch: async () => { throw new TypeError('offline'); }, storage: mem() });
  await assert.rejects(() => g.geocode('SW1A 1AA'), (e) => e.code === 'network');
  await assert.rejects(() => g.geocode('Leeds'), (e) => e.code === 'network');
});
test('nothing found anywhere gives notfound', async () => {
  const f = mockFetch([['/places?', { body: { result: null } }], ['nominatim', { body: [] }]]);
  const g = C.createGeocoder({ fetch: f, storage: mem(), sleep: async () => {} });
  await assert.rejects(() => g.geocode('Qwertyville'), (e) => e.code === 'notfound');
});
test('empty input', async () => {
  const g = C.createGeocoder({ fetch: mockFetch([]), storage: mem() });
  await assert.rejects(() => g.geocode('   '), (e) => e.code === 'empty');
});

console.log('Data errors');
test('error messages', () => {
  assert.match(C.classifyDataError(Object.assign(new Error('x'), { httpStatus: 503 })), /503/);
  assert.match(C.classifyDataError(new SyntaxError('x')), /invalid JSON/);
  assert.match(C.classifyDataError(new TypeError('x')), /blocked|offline/);
  assert.match(C.classifyDataError(Object.assign(new Error('x'), { name: 'AbortError' })), /too long/);
});

setTimeout(() => console.log('\n' + passed + ' passed' + (process.exitCode ? ', with failures' : '')), 50);
