/* UI smoke test. Dev only: needs 'npm i jsdom' in a scratch folder. Run: node tests/ui-smoke.test.js */
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const fs = require('fs');
const root = require('path').join(__dirname, '..') + '/';
const html = fs.readFileSync(root + 'index.html', 'utf8').replace('<script src="./app.js"></script>', '');
const appJs = fs.readFileSync(root + 'app.js', 'utf8');

const payload = { source_generated_at: new Date(Date.now() - 3 * 3600e3).toISOString(), stations: [
  { id:'a1', name:'Reading Extra', brand:'TESCO', postcode:'RG1 8DF', town:'Reading', lat:51.46005, lon:-0.95608, prices:{E10:{pence_per_litre:175.9,submitted_at:new Date(Date.now()-20*3600e3).toISOString()},B7S:{pence_per_litre:199.9,submitted_at:new Date(Date.now()-40*864e5).toISOString()}} },
  { id:'a7', name:'Reading <b>Esso</b>', brand:'ESSO', postcode:'RG2 0AA', town:'Reading', lat:51.43, lon:-0.97, prices:{E10:{pence_per_litre:168.9,submitted_at:new Date(Date.now()-5*3600e3).toISOString()}} },
  { id:'a3', name:'No stamp', brand:'Joe', postcode:'RG3 1AA', town:'Reading', lat:51.45, lon:-1.0, prices:{E10:{pence_per_litre:171.9}} },
]};
let mode = 'ok';
const calls = [];
function fakeFetch(url) {
  calls.push(url);
  if (url.includes('stations.json')) {
    if (mode === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode === 'bad') return Promise.resolve({ ok: true, status: 200, json: async () => ({ nope: 1 }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => payload });
  }
  if (url.includes('/postcodes/RG18DF')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { latitude: 51.4543, longitude: -0.9781 } }) });
  if (url.includes('/postcodes/')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  if (url.includes('/places')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: null }) });
  if (url.includes('nominatim')) return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  return Promise.reject(new TypeError('unexpected ' + url));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function boot(m) {
  mode = m; calls.length = 0;
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://user.github.io/fuel/', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = fakeFetch;
  w.matchMedia = () => ({ matches: false, addEventListener(){}, addListener(){} });
  w.eval(appJs);
  await wait(50);
  return w;
}
let fails = 0;
function check(name, cond, extra) { console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  ' + (extra||''))); if (!cond) fails++; }

(async () => {
  console.log('Happy path');
  let w = await boot('ok'); let d = w.document;
  check('fuel chips built from data (E10, B7S only)', [...d.querySelectorAll('#fuel-options input')].map(i=>i.value).join() === 'E10,B7S');
  check('start prompt shown before searching', !d.getElementById('empty').hidden && /Search to see prices/.test(d.getElementById('empty').textContent));
  check('data status shows source publish time', /Price file published/.test(d.getElementById('data-status').textContent));
  d.getElementById('q').value = 'rg1 8df';
  d.getElementById('search-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(50);
  const cards = [...d.querySelectorAll('#results .station')];
  check('3 results rendered', cards.length === 3, cards.length);
  check('cheapest first and badged', /Cheapest here/.test(cards[0].textContent) && /168\.9/.test(cards[0].textContent));
  check('markup in station name is escaped (no <b> element)', !d.querySelector('#results b') && /<b>Esso<\/b>/.test(cards[0].textContent));
  check('missing timestamp flagged', /No timestamp/.test(cards[2].textContent) || cards.some(c => /No timestamp/.test(c.textContent)));
  check('summary shows cheapest', /Cheapest Unleaded E10/.test(d.getElementById('summary').textContent));
  check('directions links present', cards[0].querySelectorAll('a[href*="google.com/maps/dir"]').length === 1 && cards[0].querySelectorAll('a[href*="openstreetmap.org/directions"]').length === 1);
  d.querySelector('input[value="B7S"]').checked = true; d.querySelector('input[value="B7S"]').dispatchEvent(new w.Event('change'));
  check('switching to diesel shows 1 stale-flagged station', d.querySelectorAll('#results .station').length === 1 && /2 weeks old/.test(d.getElementById('results').textContent));
  d.getElementById('hide-old').checked = true; d.getElementById('hide-old').dispatchEvent(new w.Event('change'));
  check('hide old prices -> empty state with note', d.getElementById('empty').hidden === false && /Over|older than 14/.test(d.getElementById('summary').textContent + d.getElementById('empty').textContent) || d.getElementById('empty').hidden === false);
  d.getElementById('reset-btn').click();
  check('reset restores E10 and 5 miles', d.querySelector('input[value="E10"]').checked && d.getElementById('radius').value === '5' && !d.getElementById('hide-old').checked);
  const before = calls.length;
  d.getElementById('radius').value = '1'; d.getElementById('radius').dispatchEvent(new w.Event('change'));
  check('changing filters makes no network requests', calls.length === before);
  check('stations.json fetched once', calls.filter(u => u.includes('stations.json')).length === 1);

  console.log('Search errors');
  d.getElementById('q').value = 'ZZ99 9ZZ';
  d.getElementById('search-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(50);
  check('bad postcode: error shown, previous location NOT silently replaced', /couldn.t find the postcode ZZ99 9ZZ/.test(d.getElementById('search-msg').textContent));
  d.getElementById('q').value = 'tesco';
  d.getElementById('search-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(1400);
  check('unknown place that matches a brand falls back to UK-wide name search', /across the UK/.test(d.getElementById('summary').textContent), d.getElementById('summary').textContent);

  console.log('Source failures');
  w = await boot('down'); d = w.document;
  check('feed down: error banner with retry', /couldn.t reach the price source/.test(d.getElementById('banner').textContent) && !!d.querySelector('#banner button'));
  check('feed down: no prices invented', d.querySelectorAll('#results .station').length === 0);
  mode = 'ok'; d.querySelector('#banner button').click(); await wait(80);
  check('retry loads data', d.getElementById('banner').hidden && d.querySelectorAll('#fuel-options input').length === 2);
  w = await boot('bad'); d = w.document;
  check('malformed payload: clear error', /not in the expected format/.test(d.getElementById('banner').textContent));

  console.log(fails ? fails + ' FAILED' : 'all smoke checks passed');
  process.exit(fails ? 1 : 0);
})();
