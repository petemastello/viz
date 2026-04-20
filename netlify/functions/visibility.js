/**
 * Netlify serverless function: GET /api/visibility?lat=X&lon=Y&date=YYYY-MM-DD
 * Debug mode:                  GET /api/visibility?lat=X&lon=Y&date=D&debug=1
 *
 * Queries CMEMS THREDDS for Kd490 at a lat/lon using two strategies:
 *   1. THREDDS NCSS grid-as-point → CSV
 *   2. THREDDS WMS GetFeatureInfo → XML
 *
 * Env vars:  CMEMS_USERNAME, CMEMS_PASSWORD
 */

const fetch = require('node-fetch');

const THREDDS = 'https://nrt.cmems-du.eu/thredds';
const DATASET = 'cmems_obs-oc_glo_bgc-transp_nrt_l3-olci-300m_P1D';
const VAR     = 'KD490';

const QUALITY = [
  { max: 0.085,    label: 'Excellent' },
  { max: 0.17,     label: 'Good'      },
  { max: 0.34,     label: 'Fair'      },
  { max: 0.85,     label: 'Poor'      },
  { max: Infinity, label: 'Very Poor' },
];

function classify(k) { return (QUALITY.find(t => k < t.max) || QUALITY.at(-1)).label; }
function isoDate(d)  { return d.toISOString().slice(0, 10); }
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const { lat, lon, date, debug } = event.queryStringParameters || {};
  const latF  = parseFloat(lat);
  const lonF  = parseFloat(lon);
  const isDbg = debug === '1';

  if (isNaN(latF) || isNaN(lonF) || latF < -90 || latF > 90 || lonF < -180 || lonF > 180) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid lat/lon.' }) };
  }

  const user = process.env.CMEMS_USERNAME;
  const pass = process.env.CMEMS_PASSWORD;
  if (!user || !pass) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'CMEMS credentials not configured.' }) };
  }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // Dates to attempt: requested → day before (cloud-cover fallback)
  const primary = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? new Date(date + 'T12:00:00Z')
    : new Date();
  const dayBefore = new Date(primary);
  dayBefore.setUTCDate(primary.getUTCDate() - 1);
  const datesToTry = [isoDate(primary), isoDate(dayBefore)];

  const diagnostics = []; // collected when debug=1

  for (const d of datesToTry) {
    console.log(`[visibility] trying ${d} at (${latF}, ${lonF})`);

    // ── Strategy 1: NCSS ──────────────────────────────────────────────────
    const ncss = await tryNCSS(auth, latF, lonF, d);
    if (isDbg) diagnostics.push({ strategy: 'NCSS', date: d, ...ncss });
    if (ncss.kd490 !== null) {
      console.log(`[visibility] NCSS hit: kd490=${ncss.kd490} on ${d}`);
      if (isDbg) return { statusCode: 200, headers: CORS, body: JSON.stringify({ diagnostics, winner: 'NCSS', kd490: ncss.kd490, date: d }) };
      return okResponse(CORS, ncss.kd490, d);
    }

    // ── Strategy 2: WMS GetFeatureInfo ────────────────────────────────────
    const wms = await tryWMS(auth, latF, lonF, d);
    if (isDbg) diagnostics.push({ strategy: 'WMS', date: d, ...wms });
    if (wms.kd490 !== null) {
      console.log(`[visibility] WMS hit: kd490=${wms.kd490} on ${d}`);
      if (isDbg) return { statusCode: 200, headers: CORS, body: JSON.stringify({ diagnostics, winner: 'WMS', kd490: wms.kd490, date: d }) };
      return okResponse(CORS, wms.kd490, d);
    }
  }

  console.log(`[visibility] no data found for (${latF}, ${lonF})`);
  if (isDbg) return { statusCode: 200, headers: CORS, body: JSON.stringify({ diagnostics, winner: null }) };

  return {
    statusCode: 404,
    headers: CORS,
    body: JSON.stringify({
      error: 'No satellite data for this location. Possible causes: cloud cover, land masking, or coastal proximity. Try an open-ocean location or a different date.',
    }),
  };
};

function okResponse(headers, kd490, date) {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      kd490:        parseFloat(kd490.toFixed(4)),
      visibility_m: parseFloat((1.7 / kd490).toFixed(1)),
      date,
      quality:      classify(kd490),
    }),
  };
}

// ── Strategy 1: THREDDS NCSS grid-as-point ─────────────────────────────────
// Returns CSV: date,KD490[unit="m-1"]\n2026-04-19T12:00:00Z,0.082
async function tryNCSS(auth, lat, lon, dateStr) {
  const url = new URL(`${THREDDS}/ncss/${DATASET}`);
  url.searchParams.set('var',       VAR);
  url.searchParams.set('latitude',  lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('time',      `${dateStr}T12:00:00Z`);
  url.searchParams.set('accept',    'csv');

  console.log('[NCSS]', url.toString());
  try {
    const res  = await fetch(url.toString(), { headers: { Authorization: auth }, timeout: 15000 });
    const body = await res.text();
    console.log(`[NCSS] status=${res.status} preview="${body.slice(0, 300)}"`);
    if (!res.ok) return { kd490: null, status: res.status, preview: body.slice(0, 300), url: url.toString() };

    const kd490 = parseNCSS(body);
    return { kd490, status: res.status, preview: body.slice(0, 300), url: url.toString() };
  } catch (e) {
    console.error('[NCSS] error:', e.message);
    return { kd490: null, error: e.message, url: url.toString() };
  }
}

function parseNCSS(text) {
  // Expected:
  //   date,KD490[unit="m-1"]
  //   2026-04-19T12:00:00Z,0.0824
  //
  // Or with lat/lon columns:
  //   date,lat[unit="..."],lon[unit="..."],KD490[unit="..."]
  //   2026-04-19T...,−18,147,0.0824
  const lines = text.trim().split('\n');
  if (lines.length < 2) { console.warn('[NCSS] too few lines'); return null; }

  // Find KD490 column (case-insensitive prefix match)
  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  const varCol  = headers.findIndex(h => h.startsWith(VAR));
  if (varCol < 0) { console.warn('[NCSS] KD490 column not found in:', lines[0]); return null; }

  const values = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= varCol) continue;
    const v = parseFloat(cols[varCol]);
    // Filter: must be a plausible Kd490 (not fill value like 9.96e36, not negative)
    if (isFinite(v) && v > 0 && v < 10) values.push(v);
  }

  if (values.length === 0) { console.warn('[NCSS] no plausible values'); return null; }
  return median(values);
}

// ── Strategy 2: THREDDS WMS GetFeatureInfo ─────────────────────────────────
// ncWMS returns XML with <value> tag; we ONLY trust that tag — no float scanning.
async function tryWMS(auth, lat, lon, dateStr) {
  const delta  = 0.05;
  const minLon = (lon - delta).toFixed(4);
  const maxLon = (lon + delta).toFixed(4);
  const minLat = (lat - delta).toFixed(4);
  const maxLat = (lat + delta).toFixed(4);

  // WMS 1.1.1, SRS=EPSG:4326, bbox = minLon,minLat,maxLon,maxLat
  const url = new URL(`${THREDDS}/wms/${DATASET}`);
  Object.entries({
    service:      'WMS',
    version:      '1.1.1',
    request:      'GetFeatureInfo',
    layers:       VAR,
    query_layers: VAR,
    srs:          'EPSG:4326',
    bbox:         `${minLon},${minLat},${maxLon},${maxLat}`,
    width:        '3',
    height:       '3',
    x:            '1',
    y:            '1',
    info_format:  'text/xml',
    time:         `${dateStr}T12:00:00.000Z`,
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log('[WMS]', url.toString());
  try {
    const res  = await fetch(url.toString(), { headers: { Authorization: auth }, timeout: 15000 });
    const body = await res.text();
    console.log(`[WMS] status=${res.status} preview="${body.slice(0, 400)}"`);
    if (!res.ok) return { kd490: null, status: res.status, preview: body.slice(0, 400), url: url.toString() };

    const kd490 = parseWMS(body);
    return { kd490, status: res.status, preview: body.slice(0, 400), url: url.toString() };
  } catch (e) {
    console.error('[WMS] error:', e.message);
    return { kd490: null, error: e.message, url: url.toString() };
  }
}

function parseWMS(text) {
  // ncWMS XML: <value>0.0824</value> or <value>none</value>
  const xmlMatch = text.match(/<value[^>]*>\s*([\d.eE+\-]+)\s*</i);
  if (xmlMatch) {
    const v = parseFloat(xmlMatch[1]);
    if (isFinite(v) && v > 0 && v < 10) { console.log('[WMS] <value> match:', v); return v; }
    console.warn('[WMS] <value> tag found but value out of range or "none":', xmlMatch[1]);
    return null; // explicit "none" or fill value — do NOT fall through to float scan
  }

  // Plain text: "KD490: 0.0824 m-1"
  const txtMatch = text.match(/KD490[^\d]*?([\d.eE+\-]+)/i);
  if (txtMatch) {
    const v = parseFloat(txtMatch[1]);
    if (isFinite(v) && v > 0 && v < 10) { console.log('[WMS] text match:', v); return v; }
  }

  // No float scanning — if we can't find a clearly labelled value, return null.
  // Float scanning caused false positives from WMS version numbers / bbox values.
  console.warn('[WMS] no labelled value found in response');
  return null;
}
