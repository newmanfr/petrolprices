/*
 * Petrol Finder: UK petrol and diesel price comparison.
 * Static site: no backend, no build step, no API keys.
 *
 * Structure:
 *   Core  - pure logic (parsing, filtering, sorting, geocoding). Unit-tested in Node.
 *   UI    - DOM wiring. Only runs in a browser.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Core
   * ------------------------------------------------------------------ */
  var Core = (function () {
    var CONFIG = {
      dataUrl: 'https://cheapfuelnearme.uk/api/v1/stations.json',
      postcodesApi: 'https://api.postcodes.io',
      nominatimUrl: 'https://nominatim.openstreetmap.org/search',
      // OpenStreetMap's public tile server has a usage policy (no heavy use, attribution required).
      // If this site gets busy, swap in a provider you have an agreement with.
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      cacheTtlMs: 60 * 60 * 1000,        // reuse the saved dataset for up to 1 hour
      fetchTimeoutMs: 45000,
      geoTtlMs: 30 * 24 * 3600 * 1000,   // remember geocoding results for 30 days
      geoCacheMax: 80,
      minPence: 90,                      // prices outside this range are treated as implausible
      maxPence: 350,
      maxMarkers: 150,
      pageSize: 40,
      sourceStaleHours: 36,              // warn if the source file itself is older than this
      nominatimGapMs: 1100               // Nominatim policy: max 1 request per second
    };

    var FUEL_INFO = {
      E10: { label: 'Unleaded E10', group: 'Petrol', order: 1 },
      E5: { label: 'Super unleaded E5', group: 'Petrol', order: 2 },
      B7S: { label: 'Diesel', group: 'Diesel', order: 3 },
      B7P: { label: 'Premium diesel', group: 'Diesel', order: 4 },
      B10: { label: 'Diesel B10', group: 'Diesel', order: 5 },
      HVO: { label: 'HVO', group: 'Other', order: 6 }
    };

    var BRAND_MAP = {
      BP: 'BP', SHELL: 'Shell', ESSO: 'Esso', TESCO: 'Tesco', SAINSBURYS: "Sainsbury's",
      MORRISONS: 'Morrisons', ASDA: 'Asda', ASDAEXPRESS: 'Asda', TEXACO: 'Texaco', JET: 'Jet',
      GULF: 'Gulf', MURCO: 'Murco', MAXOL: 'Maxol', APPLEGREEN: 'Applegreen', VALERO: 'Valero',
      SPAR: 'Spar', HARVESTENERGY: 'Harvest Energy', ESSAR: 'Essar', TOTAL: 'TotalEnergies',
      TOTALENERGIES: 'TotalEnergies', COOP: 'Co-op', COSTCO: 'Costco', WAITROSE: 'Waitrose'
    };
    var MAJOR_BRANDS = ['BP', 'Shell', 'Esso', 'Tesco', "Sainsbury's", 'Morrisons', 'Asda'];
    var INDEPENDENT = 'Independent';

    function toNum(v) {
      if (v === null || v === undefined || v === '') return NaN;
      return Number(v);
    }

    function normalisePostcode(s) {
      var c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length < 5 || c.length > 7) return null;
      var out = c.slice(0, -3), inn = c.slice(-3);
      if (!/^[A-Z]{1,2}\d[A-Z\d]?$/.test(out) || !/^\d[A-Z]{2}$/.test(inn)) return null;
      return out + ' ' + inn;
    }

    function normaliseOutcode(s) {
      var c = String(s || '').toUpperCase().replace(/\s+/g, '');
      return /^[A-Z]{1,2}\d[A-Z\d]?$/.test(c) ? c : null;
    }

    function brandInfo(rawBrand, name) {
      var raw = String(rawBrand || '').trim();
      var key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (BRAND_MAP[key]) return { group: BRAND_MAP[key], label: BRAND_MAP[key], known: true };
      var label = raw && raw.toLowerCase() !== String(name || '').trim().toLowerCase() ? raw : '';
      return { group: INDEPENDENT, label: label, known: false };
    }

    function strip(s) { return String(s || '').toLowerCase().replace(/['\u2019]/g, ''); }

    function prepareStation(s) {
      if (!s || typeof s !== 'object' || !s.prices || typeof s.prices !== 'object') return null;
      var lat = toNum(s.lat), lon = toNum(s.lon);
      var okCoords = isFinite(lat) && isFinite(lon) && lat >= 49 && lat <= 61.5 && lon >= -9 && lon <= 2.5;
      var prices = {};
      var any = false;
      Object.keys(s.prices).forEach(function (grade) {
        var e = s.prices[grade];
        if (!e || typeof e !== 'object') return;
        var p = toNum(e.pence_per_litre);
        if (!isFinite(p) || p <= 0) return;
        var at = typeof e.submitted_at === 'string' && !isNaN(Date.parse(e.submitted_at)) ? e.submitted_at : null;
        prices[grade] = { pence: p, at: at };
        any = true;
      });
      if (!any) return null;
      var name = String(s.name || '').trim() || 'Unnamed station';
      var bi = brandInfo(s.brand, name);
      var rawPc = String(s.postcode || '').trim();
      var pc = normalisePostcode(rawPc) || rawPc;
      var town = String(s.town || '').trim();
      return {
        id: String(s.id || ''),
        name: name,
        brandGroup: bi.group,
        brandLabel: bi.label,
        postcode: pc,
        town: town,
        lat: okCoords ? lat : null,
        lon: okCoords ? lon : null,
        prices: prices,
        quiet: s.site_quiet === true,
        repaired: s.location_repaired || null,
        search: strip([name, s.brand, town, pc, pc.replace(/\s/g, '')].join(' '))
      };
    }

    function validatePayload(p) {
      if (!p || typeof p !== 'object' || !Array.isArray(p.stations) || p.stations.length === 0) {
        throw new Error('The price file was not in the expected format.');
      }
      return p;
    }

    function prepareStations(payload) {
      var out = [];
      payload.stations.forEach(function (s) {
        var p = prepareStation(s);
        if (p) out.push(p);
      });
      return out;
    }

    function availableFuels(prepared) {
      var counts = {};
      prepared.forEach(function (s) {
        Object.keys(s.prices).forEach(function (g) { counts[g] = (counts[g] || 0) + 1; });
      });
      return Object.keys(counts).map(function (code) {
        var info = FUEL_INFO[code] || { label: code, group: 'Other', order: 99 };
        return { code: code, label: info.label, group: info.group, order: info.order, count: counts[code] };
      }).sort(function (a, b) { return a.order - b.order || a.code.localeCompare(b.code); });
    }

    function availableBrands(prepared) {
      var counts = {};
      prepared.forEach(function (s) { counts[s.brandGroup] = (counts[s.brandGroup] || 0) + 1; });
      var list = [];
      MAJOR_BRANDS.forEach(function (b) { if (counts[b]) list.push({ value: b, count: counts[b] }); });
      Object.keys(counts).filter(function (b) { return MAJOR_BRANDS.indexOf(b) < 0 && b !== INDEPENDENT; })
        .sort(function (a, b) { return counts[b] - counts[a]; })
        .forEach(function (b) { list.push({ value: b, count: counts[b] }); });
      if (counts[INDEPENDENT]) list.push({ value: INDEPENDENT, label: 'Independent and other', count: counts[INDEPENDENT] });
      return list;
    }

    function haversineMiles(lat1, lon1, lat2, lon2) {
      var R = 3958.7613, rad = Math.PI / 180;
      var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function ageInfo(iso, nowMs) {
      var t = iso ? Date.parse(iso) : NaN;
      if (isNaN(t)) return { level: 'missing', text: 'No timestamp from the source', hours: null };
      var h = (nowMs - t) / 3600000;
      var text;
      if (h < 1) text = 'less than an hour ago';
      else if (h < 24) text = Math.floor(h) + (Math.floor(h) === 1 ? ' hour ago' : ' hours ago');
      else if (h < 48) text = 'yesterday';
      else text = Math.floor(h / 24) + ' days ago';
      var level = h <= 168 ? 'ok' : h <= 336 ? 'old' : 'stale';
      return { level: level, text: text, hours: h };
    }

    function textTerms(text) {
      return strip(text).split(/\s+/).filter(Boolean);
    }

    function searchStations(prepared, o) {
      var terms = textTerms(o.text);
      var out = [];
      var counts = { noCoords: 0, implausible: 0, old: 0 };
      for (var i = 0; i < prepared.length; i++) {
        var s = prepared[i];
        var p = s.prices[o.fuel];
        if (!p) continue;
        if (o.brand && s.brandGroup !== o.brand) continue;
        if (terms.length) {
          var ok = true;
          for (var t = 0; t < terms.length; t++) { if (s.search.indexOf(terms[t]) < 0) { ok = false; break; } }
          if (!ok) continue;
        }
        var d = null;
        if (o.center) {
          if (s.lat === null) { counts.noCoords++; continue; }
          d = haversineMiles(o.center.lat, o.center.lon, s.lat, s.lon);
          if (d > o.radiusMi) continue;
        }
        if (p.pence < CONFIG.minPence || p.pence > CONFIG.maxPence) { counts.implausible++; continue; }
        var age = ageInfo(p.at, o.now);
        if (o.hideOld && age.level === 'stale') { counts.old++; continue; }
        out.push({ station: s, price: p.pence, at: p.at, age: age, distance: d });
      }
      return { results: out, noCoords: counts.noCoords, implausible: counts.implausible, old: counts.old };
    }

    function sortResults(list, mode) {
      function dist(r) { return r.distance === null ? 1e9 : r.distance; }
      function byName(a, b) { return a.station.name.localeCompare(b.station.name, 'en-GB'); }
      var cmp;
      if (mode === 'nearest') cmp = function (a, b) { return (dist(a) - dist(b)) || (a.price - b.price) || byName(a, b); };
      else if (mode === 'name') cmp = function (a, b) { return byName(a, b) || (a.price - b.price); };
      else cmp = function (a, b) { return (a.price - b.price) || (dist(a) - dist(b)) || byName(a, b); };
      return list.slice().sort(cmp);
    }

    function computeStats(list) {
      if (!list.length) return null;
      var prices = list.map(function (r) { return r.price; }).sort(function (a, b) { return a - b; });
      var n = prices.length, sum = 0;
      prices.forEach(function (p) { sum += p; });
      var avg = sum / n;
      return { n: n, min: prices[0], max: prices[n - 1], avg: avg, q1: prices[Math.floor((n - 1) * 0.25)], saving50: (avg - prices[0]) * 0.5 };
    }

    function tierOf(price, stats) {
      if (!stats) return 'normal';
      if (price <= stats.min + 1e-9) return 'best';
      if (price <= stats.q1 + 1e-9) return 'good';
      return 'normal';
    }

    function fmtPence(p) { return p.toFixed(1); }
    function fmtMiles(d) { return d < 10 ? d.toFixed(1) : String(Math.round(d)); }

    function directionLinks(s) {
      if (s.lat === null) {
        var q = encodeURIComponent(s.name + ' ' + s.postcode);
        return { google: 'https://www.google.com/maps/search/?api=1&query=' + q, osm: 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(s.postcode || s.name) };
      }
      var ll = s.lat + ',' + s.lon;
      return {
        google: 'https://www.google.com/maps/dir/?api=1&destination=' + ll,
        osm: 'https://www.openstreetmap.org/directions?route=%3B' + ll
      };
    }

    /* ---- Geocoding ---- */
    function GeoError(code, message) {
      var e = new Error(message);
      e.name = 'GeoError';
      e.code = code;
      return e;
    }

    var SETTLEMENT = { 'City': 1, 'Town': 1, 'Village': 1, 'Suburban Area': 1, 'Hamlet': 1, 'Other Settlement': 1 };

    function parsePlaces(arr) {
      if (!Array.isArray(arr)) return [];
      var seen = {}, out = [];
      arr.forEach(function (r) {
        var lat = toNum(r.latitude !== undefined ? r.latitude : r.lat);
        var lon = toNum(r.longitude !== undefined ? r.longitude : r.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        var name = r.name_1 || r.name;
        if (!name) return;
        var area = r.county_unitary || r.district_borough || r.region || '';
        var label = area && area !== name ? name + ', ' + area : name;
        if (seen[label]) return;
        seen[label] = true;
        out.push({ lat: lat, lon: lon, label: label, rank: SETTLEMENT[r.local_type] ? 0 : 1 });
      });
      return out.map(function (x, i) { x.i = i; return x; })
        .sort(function (a, b) { return a.rank - b.rank || a.i - b.i; })
        .map(function (x) { return { lat: x.lat, lon: x.lon, label: x.label }; });
    }

    function createGeocoder(deps) {
      var f = deps.fetch;
      var store = deps.storage || null;
      var sleep = deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var now = deps.now || Date.now;
      var lastNominatim = 0;
      var KEY = 'ff:geo:v1';

      function readCache() { try { return JSON.parse(store.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
      function writeCache(c) { try { store.setItem(KEY, JSON.stringify(c)); } catch (e) { /* storage full or blocked */ } }
      function cacheGet(k) {
        if (!store) return null;
        var e = readCache()[k];
        return e && now() - e.t < CONFIG.geoTtlMs ? e.v : null;
      }
      function cacheSet(k, v) {
        if (!store) return;
        var c = readCache();
        c[k] = { t: now(), v: v };
        var keys = Object.keys(c);
        if (keys.length > CONFIG.geoCacheMax) {
          keys.sort(function (a, b) { return c[a].t - c[b].t; })
            .slice(0, keys.length - CONFIG.geoCacheMax).forEach(function (x) { delete c[x]; });
        }
        writeCache(c);
      }

      async function request(url) {
        try { return await f(url); }
        catch (e) { throw GeoError('network', 'We couldn’t reach the location lookup service. Check your connection and try again.'); }
      }

      async function lookupPostcode(pc) {
        var res = await request(CONFIG.postcodesApi + '/postcodes/' + encodeURIComponent(pc.replace(' ', '')));
        if (res.status === 404) throw GeoError('notfound', 'We couldn’t find the postcode ' + pc + '. Check it for typos, or search by town instead.');
        if (!res.ok) throw GeoError('service', 'The postcode lookup service returned an error (' + res.status + '). Try again in a moment.');
        var j = await res.json();
        var r = j && j.result;
        var lat = r ? toNum(r.latitude) : NaN, lon = r ? toNum(r.longitude) : NaN;
        if (!isFinite(lat) || !isFinite(lon)) throw GeoError('notfound', 'The postcode ' + pc + ' has no map location. Try a nearby postcode or the town name.');
        return { lat: lat, lon: lon, label: pc, kind: 'postcode', alternatives: [] };
      }

      async function lookupOutcode(oc) {
        var res = await request(CONFIG.postcodesApi + '/outcodes/' + encodeURIComponent(oc));
        if (res.status === 404) throw GeoError('notfound', 'We couldn’t find the postcode area ' + oc + '. Try a full postcode or a town name.');
        if (!res.ok) throw GeoError('service', 'The postcode lookup service returned an error (' + res.status + '). Try again in a moment.');
        var j = await res.json();
        var r = j && j.result;
        var lat = r ? toNum(r.latitude) : NaN, lon = r ? toNum(r.longitude) : NaN;
        if (!isFinite(lat) || !isFinite(lon)) throw GeoError('notfound', 'The postcode area ' + oc + ' has no map location.');
        return { lat: lat, lon: lon, label: oc + ' area', kind: 'outcode', alternatives: [] };
      }

      async function nominatim(q) {
        var wait = CONFIG.nominatimGapMs - (now() - lastNominatim);
        if (wait > 0) await sleep(wait);
        lastNominatim = now();
        var url = CONFIG.nominatimUrl + '?format=jsonv2&limit=5&countrycodes=gb&q=' + encodeURIComponent(q);
        var res = await request(url);
        if (!res.ok) throw GeoError('service', 'The place search service returned an error (' + res.status + '). Try again in a moment.');
        var arr = await res.json();
        if (!Array.isArray(arr)) return [];
        return parsePlaces(arr.map(function (r) {
          var parts = String(r.display_name || '').split(',').map(function (x) { return x.trim(); });
          return { latitude: r.lat, longitude: r.lon, name_1: parts[0], county_unitary: parts[1] || '', local_type: 'Town' };
        }));
      }

      async function lookupPlace(q) {
        var places = [], pcFail = null;
        try {
          var res = await request(CONFIG.postcodesApi + '/places?limit=8&q=' + encodeURIComponent(q));
          if (res.ok) { var j = await res.json(); places = parsePlaces(j && j.result); }
          else pcFail = GeoError('service', 'place lookup failed');
        } catch (e) { pcFail = e; }
        var source = places;
        if (!source.length) {
          try { source = await nominatim(q); }
          catch (e) { throw (pcFail && pcFail.code === 'network') ? pcFail : e; }
        }
        if (!source.length) throw GeoError('notfound', 'We couldn’t find “' + q + '” in the UK. Try a postcode or a nearby larger town.');
        var top = source[0];
        return { lat: top.lat, lon: top.lon, label: top.label, kind: 'place', alternatives: source.slice(0, 5) };
      }

      return {
        async geocode(raw) {
          var q = String(raw || '').trim().replace(/\s+/g, ' ');
          if (!q) throw GeoError('empty', 'Enter a postcode, town or city to search.');
          var key = q.toLowerCase();
          var hit = cacheGet(key);
          if (hit) return hit;
          var pc = normalisePostcode(q), oc = pc ? null : normaliseOutcode(q);
          var result = pc ? await lookupPostcode(pc) : oc ? await lookupOutcode(oc) : await lookupPlace(q);
          cacheSet(key, result);
          return result;
        }
      };
    }

    function classifyDataError(e) {
      if (e && e.name === 'AbortError') return 'The price source took too long to respond.';
      if (e && e.httpStatus) return 'The price source returned an error (HTTP ' + e.httpStatus + ').';
      if (e && e.name === 'SyntaxError') return 'The price file could not be read (invalid JSON).';
      if (e && e.name === 'TypeError') return 'We couldn’t reach the price source. It may be offline, or your connection or browser blocked the request.';
      return (e && e.message) ? e.message : 'Something went wrong loading prices.';
    }

    return {
      CONFIG: CONFIG, FUEL_INFO: FUEL_INFO, MAJOR_BRANDS: MAJOR_BRANDS, INDEPENDENT: INDEPENDENT,
      normalisePostcode: normalisePostcode, normaliseOutcode: normaliseOutcode, brandInfo: brandInfo,
      prepareStation: prepareStation, prepareStations: prepareStations, validatePayload: validatePayload,
      availableFuels: availableFuels, availableBrands: availableBrands, haversineMiles: haversineMiles,
      ageInfo: ageInfo, searchStations: searchStations, sortResults: sortResults, computeStats: computeStats,
      tierOf: tierOf, fmtPence: fmtPence, fmtMiles: fmtMiles, directionLinks: directionLinks,
      parsePlaces: parsePlaces, createGeocoder: createGeocoder, classifyDataError: classifyDataError
    };
  })();

  if (typeof module === 'object' && module.exports) { module.exports = Core; return; }
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  var C = Core.CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  ['q', 'search-form', 'search-btn', 'locate-btn', 'search-msg', 'alt-places', 'fuel-options', 'radius', 'sort',
    'brand', 'name-filter', 'hide-old', 'reset-btn', 'more-filters', 'data-status', 'banner', 'loading',
    'loading-text', 'summary', 'view-bar', 'view-list', 'view-map', 'empty', 'results', 'more-btn',
    'map-wrap', 'map', 'theme-toggle', 'theme-label'
  ].forEach(function (id) { el[id] = $(id); });

  var PREF_KEY = 'ff:prefs:v1';
  var state = {
    payload: null, stations: [], fuels: [], center: null,
    fuel: 'E10', radius: 5, brand: '', text: '', sort: 'cheapest', hideOld: false,
    view: 'list', shown: C.pageSize, results: [], stats: null,
    loaded: false, loadingData: false, dataNote: null
  };
  var geocoder = createGeo();

  function createGeo() {
    var storage = null;
    try { storage = window.localStorage; } catch (e) { /* blocked */ }
    return Core.createGeocoder({ fetch: function (u) { return window.fetch(u); }, storage: storage });
  }

  /* ---- helpers ---- */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function show(n, on) { if (on) n.removeAttribute('hidden'); else n.setAttribute('hidden', ''); }
  var dtf;
  try { dtf = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }); }
  catch (e) { dtf = null; }
  function fmtDate(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return 'unknown';
    return dtf ? dtf.format(new Date(t)) + ' (UK time)' : new Date(t).toUTCString();
  }
  function priceSign(price, tier, extra) {
    return h('span', { class: 'sign tier-' + tier + (extra ? ' ' + extra : '') }, [Core.fmtPence(price), h('small', { text: 'p' })]);
  }

  /* ---- preferences ---- */
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (p.fuel) state.fuel = String(p.fuel);
      if ([1, 2, 3, 5, 10, 15, 25, 50].indexOf(Number(p.radius)) >= 0) state.radius = Number(p.radius);
      if (['cheapest', 'nearest', 'name'].indexOf(p.sort) >= 0) state.sort = p.sort;
      if (p.view === 'map' || p.view === 'list') state.view = p.view;
      state.hideOld = p.hideOld === true;
    } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ fuel: state.fuel, radius: state.radius, sort: state.sort, view: state.view, hideOld: state.hideOld }));
    } catch (e) { /* ignore */ }
  }

  /* ---- theme ---- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var light = t === 'light';
    el['theme-label'].textContent = light ? 'Dark theme' : 'Light theme';
    el['theme-toggle'].setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', light ? '#ffffff' : '#0b1220');
  }
  el['theme-toggle'].addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('ff:theme', next); } catch (e) { /* ignore */ }
  });

  /* ---- banner / status ---- */
  function showBanner(kind, msg, actions) {
    var b = el.banner;
    clear(b);
    b.className = 'banner ' + kind;
    b.appendChild(h('span', { text: msg }));
    (actions || []).forEach(function (a) {
      var btn = h('button', { type: 'button', class: 'btn btn-small', text: a.label });
      btn.addEventListener('click', a.onClick);
      b.appendChild(btn);
    });
    show(b, true);
  }
  function hideBanner() { show(el.banner, false); }

  function renderDataStatus() {
    var d = el['data-status'];
    clear(d);
    if (!state.payload) return;
    var gen = state.payload.source_generated_at;
    d.appendChild(document.createTextNode(
      'Price file published ' + fmtDate(gen) + '. ' + state.stations.length.toLocaleString('en-GB') +
      ' stations. Updated twice a day by the source; not live.'));
  }

  /* ---- dataset loading (memory + IndexedDB) ---- */
  function idb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      var r = indexedDB.open('Petrol-finder', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }
  function idbSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  async function fetchDataset() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, C.fetchTimeoutMs) : null;
    try {
      var res = await fetch(C.dataUrl, ctrl ? { signal: ctrl.signal, cache: 'no-cache' } : { cache: 'no-cache' });
      if (!res.ok) { var err = new Error('HTTP ' + res.status); err.httpStatus = res.status; throw err; }
      var json = await res.json();
      return Core.validatePayload(json);
    } finally { if (timer) clearTimeout(timer); }
  }

  function useDataset(payload) {
    state.payload = payload;
    state.stations = Core.prepareStations(payload);
    state.fuels = Core.availableFuels(state.stations);
    if (!state.fuels.some(function (f) { return f.code === state.fuel; })) {
      state.fuel = state.fuels.length ? state.fuels[0].code : 'E10';
    }
    buildFuelOptions();
    buildBrandOptions();
    state.loaded = true;
    renderDataStatus();
  }

  async function loadData(force) {
    if (state.loadingData) return;
    state.loadingData = true;
    hideBanner();
    el['loading-text'].textContent = 'Loading prices…';
    show(el.loading, !state.loaded);
    var cached = null;
    try { cached = await idbGet('dataset'); } catch (e) { cached = null; }
    var now = Date.now();
    try {
      if (!force && cached && cached.payload && now - cached.fetchedAt < C.cacheTtlMs) {
        useDataset(Core.validatePayload(cached.payload));
      } else {
        var payload = await fetchDataset();
        useDataset(payload);
        idbSet('dataset', { fetchedAt: Date.now(), payload: payload }).catch(function () { /* cache is optional */ });
      }
      var ageH = (Date.now() - Date.parse(state.payload.source_generated_at)) / 3600000;
      if (isFinite(ageH) && ageH > C.sourceStaleHours) {
        showBanner('warn', 'The source has not published new prices for over ' + Math.floor(ageH) + ' hours, so everything shown may be out of date.');
      }
    } catch (e) {
      var why = Core.classifyDataError(e);
      var usable = null;
      try { usable = cached && cached.payload ? Core.validatePayload(cached.payload) : null; } catch (x) { usable = null; }
      if (usable && !state.loaded) {
        useDataset(usable);
        showBanner('warn', why + ' Showing prices saved on this device from ' + fmtDate(new Date(cached.fetchedAt).toISOString()) + '. They may be out of date.',
          [{ label: 'Try again', onClick: function () { loadData(true); } }]);
      } else if (!state.loaded) {
        showBanner('error', why, [{ label: 'Try again', onClick: function () { loadData(true); } }]);
      } else {
        showBanner('warn', why + ' Still showing the previous data.', [{ label: 'Try again', onClick: function () { loadData(true); } }]);
      }
    } finally {
      state.loadingData = false;
      show(el.loading, false);
      render();
    }
  }

  /* ---- filter controls ---- */
  function buildFuelOptions() {
    var box = el['fuel-options'];
    clear(box);
    var groups = {};
    state.fuels.forEach(function (f) { (groups[f.group] = groups[f.group] || []).push(f); });
    ['Petrol', 'Diesel', 'Other'].forEach(function (g) {
      if (!groups[g]) return;
      var row = h('div', { class: 'fuel-group', role: 'group', 'aria-label': g }, [h('span', { class: 'fuel-group-name', text: g })]);
      groups[g].forEach(function (f) {
        var input = h('input', { type: 'radio', name: 'fuel', value: f.code });
        if (f.code === state.fuel) input.checked = true;
        input.addEventListener('change', function () { state.fuel = f.code; state.shown = C.pageSize; savePrefs(); render(); });
        row.appendChild(h('label', { class: 'fuel-chip', title: f.count.toLocaleString('en-GB') + ' stations report this fuel' }, [input, h('span', { text: f.label })]));
      });
      box.appendChild(row);
    });
  }
  function buildBrandOptions() {
    var sel = el.brand;
    var prev = state.brand;
    clear(sel);
    sel.appendChild(h('option', { value: '', text: 'All brands' }));
    Core.availableBrands(state.stations).forEach(function (b) {
      sel.appendChild(h('option', { value: b.value, text: (b.label || b.value) + ' (' + b.count.toLocaleString('en-GB') + ')' }));
    });
    sel.value = prev;
    if (sel.value !== prev) state.brand = '';
  }
  function syncControls() {
    el.radius.value = String(state.radius);
    el.sort.value = state.sort;
    el['hide-old'].checked = state.hideOld;
    el['name-filter'].value = state.text;
    var nearest = el.sort.querySelector('option[value="nearest"]');
    if (nearest) nearest.disabled = !state.center;
    el['view-list'].setAttribute('aria-pressed', String(state.view === 'list'));
    el['view-map'].setAttribute('aria-pressed', String(state.view === 'map'));
    var inputs = el['fuel-options'].querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === state.fuel;
  }

  el.radius.addEventListener('change', function () { state.radius = Number(el.radius.value); state.shown = C.pageSize; savePrefs(); render(); });
  el.sort.addEventListener('change', function () { state.sort = el.sort.value; state.shown = C.pageSize; savePrefs(); render(); });
  el.brand.addEventListener('change', function () { state.brand = el.brand.value; state.shown = C.pageSize; render(); });
  el['hide-old'].addEventListener('change', function () { state.hideOld = el['hide-old'].checked; state.shown = C.pageSize; savePrefs(); render(); });
  var nameTimer = null;
  el['name-filter'].addEventListener('input', function () {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(function () { state.text = el['name-filter'].value; state.shown = C.pageSize; render(); }, 250);
  });
  el['reset-btn'].addEventListener('click', resetFilters);
  function resetFilters() {
    state.radius = 5; state.sort = 'cheapest'; state.brand = ''; state.text = ''; state.hideOld = false; state.shown = C.pageSize;
    state.fuel = state.fuels.some(function (f) { return f.code === 'E10'; }) ? 'E10' : (state.fuels[0] ? state.fuels[0].code : 'E10');
    el.brand.value = '';
    savePrefs(); syncControls(); render();
  }
  el['more-btn'].addEventListener('click', function () { state.shown += C.pageSize; renderList(); });

  /* ---- search / location ---- */
  function setMessage(msg, kind) {
    var m = el['search-msg'];
    if (!msg) { show(m, false); m.textContent = ''; return; }
    m.className = 'form-msg' + (kind === 'info' ? ' info' : '');
    m.textContent = msg;
    show(m, true);
  }
  function setBusy(on) {
    el['search-btn'].disabled = on; el['locate-btn'].disabled = on;
    el['search-btn'].textContent = on ? 'Searching…' : 'Search';
  }
  function setCenter(c) {
    state.center = c; state.shown = C.pageSize;
    renderAlternatives(c);
    syncControls();
    render();
  }
  function renderAlternatives(c) {
    var box = el['alt-places'];
    clear(box);
    var alts = c && c.alternatives ? c.alternatives.filter(function (a) { return a.label !== c.label; }) : [];
    if (!alts.length) { show(box, false); return; }
    box.appendChild(h('span', { class: 'hint', text: 'Other matches:' }));
    alts.slice(0, 4).forEach(function (a) {
      var b = h('button', { type: 'button', class: 'chip-btn', text: a.label });
      b.addEventListener('click', function () {
        setCenter({ lat: a.lat, lon: a.lon, label: a.label, kind: 'place', alternatives: [c].concat(alts.filter(function (x) { return x !== a; })).map(function (x) { return { lat: x.lat, lon: x.lon, label: x.label }; }) });
      });
      box.appendChild(b);
    });
    show(box, true);
  }

  el['search-form'].addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (el['search-btn'].disabled) return;
    var q = el.q.value;
    setMessage('');
    if (!q.trim()) { setMessage('Enter a postcode, town or city to search.'); el.q.focus(); return; }
    setBusy(true);
    try {
      var g = await geocoder.geocode(q);
      setCenter(g);
    } catch (e) {
      // If it is not a place but does match station names (e.g. "Tesco"), search by name across the UK.
      var asText = Core.searchStations(state.stations, { fuel: state.fuel, text: q, brand: '', center: null, radiusMi: 0, hideOld: false, now: Date.now() });
      if (e && e.code === 'notfound' && state.loaded && asText.results.length) {
        state.text = q.trim(); state.center = null; state.shown = C.pageSize;
        renderAlternatives(null);
        syncControls(); render();
        setMessage('“' + q.trim() + '” isn’t a place we recognise, so we searched station names and brands across the UK instead. Add a postcode or town to see stations near you.', 'info');
      } else {
        setMessage(e && e.message ? e.message : 'Search failed. Try again.');
      }
    } finally { setBusy(false); }
  });

  el['locate-btn'].addEventListener('click', function () {
    setMessage('');
    if (!navigator.geolocation) { setMessage('Your browser doesn’t support location. Search by postcode or town instead.'); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      setBusy(false);
      setCenter({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'your location', kind: 'gps', alternatives: [] });
    }, function (err) {
      setBusy(false);
      var msg = err && err.code === 1 ? 'Location permission was denied. Search by postcode or town instead.'
        : err && err.code === 3 ? 'Finding your location took too long. Try again or search by postcode.'
        : 'We couldn’t work out your location. Search by postcode or town instead.';
      setMessage(msg);
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });

  /* ---- rendering ---- */
  function nowMs() { return Date.now(); }

  function render() {
    syncControls();
    var hasCenter = !!state.center, hasText = state.text.trim().length > 0;
    show(el.summary, false); show(el['view-bar'], false);
    show(el.results, false); show(el['more-btn'], false); show(el['map-wrap'], false); show(el.empty, false);
    if (!state.loaded) return;

    if (!hasCenter && !hasText) {
      state.results = []; state.stats = null;
      showEmpty('Search to see prices',
        'Enter a postcode, town or city above, or use your location. You can also filter by station name or brand to compare across the UK.');
      return;
    }

    var sr = Core.searchStations(state.stations, {
      fuel: state.fuel, center: state.center, radiusMi: state.radius, brand: state.brand,
      text: state.text, hideOld: state.hideOld, now: nowMs()
    });
    var mode = (state.sort === 'nearest' && !hasCenter) ? 'cheapest' : state.sort;
    state.results = Core.sortResults(sr.results, mode);
    state.stats = Core.computeStats(state.results);
    renderSummary(sr);
    show(el['view-bar'], state.results.length > 0);

    if (!state.results.length) {
      var next = [1, 2, 3, 5, 10, 15, 25, 50].filter(function (r) { return r > state.radius; })[0];
      showEmpty('No stations found',
        hasCenter ? 'Nothing reports ' + fuelLabel() + ' within ' + state.radius + (state.radius === 1 ? ' mile' : ' miles') + ' of ' + state.center.label + ' with these filters.'
          : 'No stations match those filters.',
        next && hasCenter ? [{ label: 'Widen to ' + next + ' miles', onClick: function () { state.radius = next; savePrefs(); render(); } }] : null);
      return;
    }
    if (state.view === 'map') { show(el['map-wrap'], true); showMap(); }
    else { show(el.results, true); renderList(); }
  }

  function fuelLabel() {
    for (var i = 0; i < state.fuels.length; i++) if (state.fuels[i].code === state.fuel) return state.fuels[i].label;
    return state.fuel;
  }

  function showEmpty(title, text, actions) {
    var e = el.empty;
    clear(e);
    e.appendChild(h('h3', { text: title }));
    e.appendChild(h('p', { text: text }));
    var wrap = h('div', { class: 'actions' });
    (actions || []).forEach(function (a) {
      var b = h('button', { type: 'button', class: 'btn', text: a.label });
      b.addEventListener('click', a.onClick);
      wrap.appendChild(b);
    });
    var r = h('button', { type: 'button', class: 'btn btn-quiet', text: 'Reset filters' });
    if (title !== 'Search to see prices') { r.addEventListener('click', resetFilters); wrap.appendChild(r); }
    if (wrap.childNodes.length) e.appendChild(wrap);
    show(e, true);
  }

  function renderSummary(sr) {
    var s = el.summary, st = state.stats;
    clear(s);
    if (!st) { show(s, false); return; }
    var where = state.center ? ' within ' + state.radius + (state.radius === 1 ? ' mile' : ' miles') + ' of ' + state.center.label : ' across the UK';
    var filt = state.text.trim() ? ' matching “' + state.text.trim() + '”' : '';
    s.appendChild(h('p', { class: 'summary-count', text: st.n.toLocaleString('en-GB') + (st.n === 1 ? ' station' : ' stations') + filt + where }));

    var best = null;
    for (var i = 0; i < state.results.length; i++) if (!best || state.results[i].price < best.price) best = state.results[i];
    if (best) {
      var sub = 'Average ' + Core.fmtPence(st.avg) + 'p';
      if (st.n > 1 && st.saving50 >= 0.05) sub += '. Filling a 50 litre tank here instead of at the average costs about £' + st.saving50.toFixed(2) + ' less.';
      var text = h('div', { class: 'best-text' }, [
        h('div', { class: 'best-title', text: 'Cheapest ' + fuelLabel() + ': ' + best.station.name }),
        h('div', { class: 'best-sub', text: [best.distance !== null ? Core.fmtMiles(best.distance) + ' miles away' : '', best.station.town || best.station.postcode].filter(Boolean).join(', ') }),
        h('div', { class: 'best-sub', text: sub })
      ]);
      s.appendChild(h('div', { class: 'best' }, [priceSign(best.price, 'best'), text]));
    }
    var notes = [];
    if (sr.implausible) notes.push(sr.implausible + (sr.implausible === 1 ? ' price was' : ' prices were') + ' hidden because ' + (sr.implausible === 1 ? 'it looks' : 'they look') + ' implausible (outside ' + C.minPence + 'p to ' + C.maxPence + 'p).');
    if (sr.noCoords) notes.push(sr.noCoords + (sr.noCoords === 1 ? ' station' : ' stations') + ' without a usable map position ' + (sr.noCoords === 1 ? 'is' : 'are') + ' not included in distance searches.');
    if (sr.old) notes.push(sr.old + (sr.old === 1 ? ' price' : ' prices') + ' older than 14 days hidden.');
    if (notes.length) {
      var ul = h('ul', { class: 'summary-notes' });
      notes.forEach(function (n) { ul.appendChild(h('li', { text: n })); });
      s.appendChild(ul);
    }
    show(s, true);
  }

  function renderList() {
    var list = el.results;
    clear(list);
    var slice = state.results.slice(0, state.shown);
    slice.forEach(function (r) { list.appendChild(renderCard(r)); });
    var left = state.results.length - slice.length;
    el['more-btn'].textContent = 'Show ' + Math.min(left, C.pageSize) + ' more (' + left + ' left)';
    show(el['more-btn'], left > 0);
  }

  function renderCard(r) {
    var s = r.station, st = state.stats;
    var tier = Core.tierOf(r.price, st);
    var isBest = st && r.price <= st.min + 1e-9 && st.n > 1;
    var li = h('li', { class: 'station' + (isBest ? ' is-cheapest' : '') });

    var brandBits = [];
    if (s.brandLabel) brandBits.push(s.brandLabel);
    if (!s.brandLabel || s.brandGroup === Core.INDEPENDENT) brandBits.push('Independent');
    var main = h('div', { class: 'station-main' }, [
      h('h3', { class: 'station-name', text: s.name }),
      h('div', { class: 'station-brand', text: brandBits.filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' · ') })
    ]);
    var price = h('div', { class: 'station-price' }, [priceSign(r.price, tier), h('span', { class: 'per', text: 'per litre, ' + fuelLabel() })]);
    li.appendChild(h('div', { class: 'station-top' }, [main, price]));

    var addr = [s.town, s.postcode].filter(Boolean).join(', ');
    var meta = [addr, r.distance !== null ? Core.fmtMiles(r.distance) + ' miles away' : ''].filter(Boolean).join(' · ');
    li.appendChild(h('p', { class: 'station-meta', text: meta || 'Address not provided' }));

    var badges = h('div', { class: 'badges' });
    if (isBest) badges.appendChild(h('span', { class: 'badge good', text: 'Cheapest here' }));
    else if (tier === 'good') badges.appendChild(h('span', { class: 'badge good', text: 'Competitive price' }));
    var ageBadge = h('span', {
      class: 'badge ' + (r.age.level === 'stale' || r.age.level === 'missing' ? 'bad' : r.age.level === 'old' ? 'warn' : ''),
      title: r.at ? fmtDate(r.at) : null,
      text: r.age.level === 'missing' ? 'No timestamp' : 'Reported ' + r.age.text
    });
    badges.appendChild(ageBadge);
    if (r.age.level === 'old') badges.appendChild(h('span', { class: 'badge warn', text: 'Over a week old' }));
    if (r.age.level === 'stale') badges.appendChild(h('span', { class: 'badge bad', text: 'Over 2 weeks old: may be out of date' }));
    if (s.quiet) badges.appendChild(h('span', { class: 'badge warn', text: 'No updates from this site for 14+ days' }));
    if (s.repaired === 'district_centre') badges.appendChild(h('span', { class: 'badge warn', text: 'Approximate location' }));
    else if (s.repaired === 'sign_flip') badges.appendChild(h('span', { class: 'badge', text: 'Map position corrected' }));
    li.appendChild(badges);

    var links = Core.directionLinks(s);
    var label = s.lat === null ? 'Find on ' : 'Directions: ';
    li.appendChild(h('div', { class: 'station-links' }, [
      h('a', { href: links.google, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label + 'Google Maps for ' + s.name + ' (opens in a new tab)', text: label + 'Google Maps' }),
      h('a', { href: links.osm, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label + 'OpenStreetMap for ' + s.name + ' (opens in a new tab)', text: label + 'OpenStreetMap' })
    ]));

    var codes = Object.keys(s.prices);
    if (codes.length > 1) {
      var ul = h('ul', { class: 'all-prices' });
      codes.sort(function (a, b) { return ((Core.FUEL_INFO[a] || { order: 99 }).order) - ((Core.FUEL_INFO[b] || { order: 99 }).order); }).forEach(function (c) {
        var p = s.prices[c], a = Core.ageInfo(p.at, nowMs());
        var nm = (Core.FUEL_INFO[c] || { label: c }).label;
        ul.appendChild(h('li', {}, [
          h('span', { text: nm }),
          h('span', {}, [h('strong', { text: Core.fmtPence(p.pence) + 'p' }), h('span', { class: 'when', text: ' · ' + (a.level === 'missing' ? 'no timestamp' : a.text) })])
        ]));
      });
      li.appendChild(h('details', {}, [h('summary', { text: 'All fuel prices at this station' }), ul]));
    }
    return li;
  }

  /* ---- views / map ---- */
  function setView(v) {
    state.view = v; savePrefs(); render();
  }
  el['view-list'].addEventListener('click', function () { setView('list'); });
  el['view-map'].addEventListener('click', function () { setView('map'); });

  var leafletPromise = null, map = null, layer = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = 'vendor/leaflet/leaflet.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { leafletPromise = null; reject(new Error('The map library failed to load.')); };
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  function showMap() {
    loadLeaflet().then(function () {
      if (state.view !== 'map') return;
      if (!map) {
        map = L.map(el.map).setView([54.5, -3], 6);
        L.tileLayer(C.tileUrl, { maxZoom: 18, attribution: C.tileAttribution }).addTo(map);
        layer = L.layerGroup().addTo(map);
      }
      map.invalidateSize();
      updateMap();
    }).catch(function (e) {
      state.view = 'list';
      showBanner('warn', e.message + ' Showing the list instead.');
      render();
    });
  }

  function updateMap() {
    layer.clearLayers();
    var pts = [];
    var st = state.stats;
    state.results.filter(function (r) { return r.station.lat !== null; }).slice(0, C.maxMarkers).forEach(function (r) {
      var tier = Core.tierOf(r.price, st);
      var icon = L.divIcon({
        className: 'pin-wrap', iconSize: [56, 24], iconAnchor: [28, 24], popupAnchor: [0, -24],
        html: '<span class="pin pin-' + tier + '">' + Core.fmtPence(r.price) + '</span>'
      });
      var links = Core.directionLinks(r.station);
      var pop = h('div', {}, [
        h('div', { class: 'popup-name', text: r.station.name }),
        h('div', { class: 'popup-price', text: Core.fmtPence(r.price) + 'p per litre (' + fuelLabel() + ')' }),
        h('div', { text: (r.distance !== null ? Core.fmtMiles(r.distance) + ' miles away. ' : '') + (r.age.level === 'missing' ? 'No timestamp.' : 'Reported ' + r.age.text + '.') }),
        h('a', { href: links.google, target: '_blank', rel: 'noopener noreferrer', text: 'Google Maps' }),
        document.createTextNode(' · '),
        h('a', { href: links.osm, target: '_blank', rel: 'noopener noreferrer', text: 'OpenStreetMap' })
      ]);
      L.marker([r.station.lat, r.station.lon], { icon: icon, title: r.station.name + ', ' + Core.fmtPence(r.price) + 'p', alt: r.station.name }).bindPopup(pop).addTo(layer);
      pts.push([r.station.lat, r.station.lon]);
    });
    if (state.center) {
      pts.push([state.center.lat, state.center.lon]);
      L.circle([state.center.lat, state.center.lon], { radius: state.radius * 1609.344, color: '#3ddc97', weight: 1, fillOpacity: 0.04 }).addTo(layer);
      L.marker([state.center.lat, state.center.lon], {
        icon: L.divIcon({ className: 'pin-wrap', iconSize: [16, 16], iconAnchor: [8, 8], html: '<span class="pin pin-here"></span>' }),
        title: 'Search location', alt: 'Search location'
      }).addTo(layer);
    }
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 });
  }

  /* ---- init ---- */
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  loadPrefs();
  if (window.matchMedia && matchMedia('(min-width: 900px)').matches) el['more-filters'].setAttribute('open', '');
  syncControls();
  render();
  loadData(false);
})();
