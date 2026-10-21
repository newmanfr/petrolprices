# Forecourt Finder

A static UK petrol and diesel price comparison site. Search any postcode, town or city, compare nearby stations, and see the cheapest places to fill up. It runs entirely in the browser, so it hosts free on GitHub Pages: no server, no database, no API keys, no build step.

## Deploy to GitHub Pages

1. Create a new GitHub repository (public repos work on the free plan).
2. Upload every file in this folder, keeping the structure, including the hidden `.nojekyll` file and the `vendor/` folder.
3. In the repository go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose your main branch and the **/ (root)** folder, then save.
4. After a minute the site is live at `https://<your-username>.github.io/<repository-name>/`.

All asset paths are relative (`./styles.css`, `./app.js`, `vendor/leaflet/...`), so it works under a project URL as well as a custom domain. No GitHub Actions workflow is needed.

## Where the data comes from

| | cheapfuelnearme.uk (used) | cheapestfuelnearme.co.uk (not used) |
|---|---|---|
| Shape | One static file, `/api/v1/stations.json` (about 3 MB, about 8,100 stations) | Query API (`/api/stations?lat=&lon=`) on someone else's server |
| Fits a static site | Yes: fetch once, search locally | Needs a live server for every search |
| Fields | id, name, brand, postcode, town, lat, lon, per-fuel price with its own `submitted_at`, `site_quiet`, `location_repaired` | Similar, per its OpenAPI spec |
| Freshness | `source_generated_at` in the file; rebuilt about 09:45 and 15:45 UTC | "Refreshes twice a day" |
| Terms | Open Government Licence v3.0, no key, no rate limit, no extra attribution required | OGL v3.0, asks for credit, 5-minute caching, 15-minute polling advice |
| Wording | Says clearly the prices are not live | Describes prices as "live" |

The site uses the first one. Its docs promise fields are only ever added, never renamed or removed within `/api/v1`, which suits a static site that can't be redeployed on a schedule.

Things the code handles because they appear in the real data:

- Postcodes sometimes have no space (`KW148TU`). They are normalised.
- `town` is sometimes empty or a county name, so station search also matches name, brand and postcode.
- Some prices are weeks old, and a few look wrong (for example E10 above diesel). Prices outside 90p to 350p are hidden and counted in a visible note. Everything else is shown as reported, with an age badge.
- A grade with no price has no key in the file, so a missing fuel never appears as 0p.
- Coordinates outside the UK are treated as missing.

Fuel codes seen: `E10`, `E5` (petrol), `B7S`, `B7P`, `B10` (diesel), `HVO`. The source does not document these codes. The labels used here (E10 unleaded, E5 super unleaded, B7S diesel, B7P premium diesel) are inferred from the code names and the price levels. Check them against the CMA Fuel Finder scheme documentation if the exact wording matters to you. Fuel filters are built from whatever codes appear in the file, and unknown codes are shown under their raw code.

## Caching and rate limits

- The price file is fetched once per page load and kept in memory. It is also saved in IndexedDB for 1 hour, so reloads and revisits don't re-download 3 MB. If the source is unreachable, a saved copy is shown with a visible warning and its saved time. If there is none, you get an error and a **Try again** button.
- Changing fuel, radius, brand, sort or the name filter never touches the network. The name filter waits 250 ms after you stop typing.
- Location lookups only happen when you press **Search**, never per keystroke. Results are cached in `localStorage` for 30 days.
- Geocoding uses [postcodes.io](https://postcodes.io) first (free, no key, CORS enabled, covers postcodes, outward codes like `M1`, and place names). Nominatim is only a fallback for place names, with at least 1.1 seconds between requests, UK results only, and no autocomplete, as its usage policy requires. Nominatim's limit is per application rather than per visitor, so if the site becomes busy, remove the fallback or host your own geocoder.
- The map uses OpenStreetMap's public tile server only when someone opens the Map view. It is not suitable for heavy traffic (see the OSM tile usage policy). To change provider, edit `tileUrl` and `tileAttribution` at the top of `app.js`.
- Leaflet 1.9.4 is vendored in `vendor/leaflet/` (BSD-2-Clause), so there are no CDN scripts.
- No cookies, no analytics, no service worker. The browser's location is requested only after you press **Use my location**.

## Licence and attribution

The page footer carries these. Keep them if you fork.

- Fuel prices: contains public sector information licensed under the Open Government Licence v3.0. Source: CMA Fuel Finder statutory scheme, republished by Cheap Fuel Near Me.
- Postcode lookups: postcodes.io, which uses ONS and Royal Mail data. The footer uses the standard ONS Postcode Directory wording. Confirm against the postcodes.io licence page before publishing.
- Map: © OpenStreetMap contributors.

## Files

```
index.html          page
styles.css          themes and layout
app.js              all logic (core functions plus UI)
vendor/leaflet/     map library, loaded only for the Map view
.nojekyll           stops GitHub running Jekyll over the site
tests/              development-only tests, not used by the site
```

## Tests

`node tests/core.test.js` runs 33 checks with no dependencies: postcode parsing, haversine distance, radius, brand, fuel and text filters, sorting, missing coordinates and timestamps, implausible prices, geocoding with mocked network (including the 1-per-second gap and cache), and error handling.

`tests/ui-smoke.test.js` drives the page in jsdom with a mocked network. Install jsdom somewhere and run `JSDOM_PATH=/path/to/node_modules/jsdom node tests/ui-smoke.test.js`.

## What was not verified

These tests used a fixture that copies the schema of the real file, not the live file itself.

- I read the API documentation and a truncated sample of the live `stations.json` (schema confirmed), but could not download the full file or inspect its HTTP headers from my environment. Whether the browser can fetch it (CORS) rests on the provider's documentation. Open the site once and check.
- Calls to postcodes.io and Nominatim were not made from my environment. The place-name response fields (`name_1`, `county_unitary`, `latitude`, `longitude`, `local_type`) come from my knowledge of that API, and the code falls back to Nominatim if they are missing. Test a town search after deploying.
- Not tested on real iPhone, Android or tablet screens, with a screen reader, or for colour contrast with a checker. Colours were chosen for contrast and layout is mobile-first, but check it yourself.
- The Google Maps and OpenStreetMap directions links follow their documented URL formats but were not opened.
