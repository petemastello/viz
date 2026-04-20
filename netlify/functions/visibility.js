/**
 * Netlify serverless function: GET /api/visibility?lat=X&lon=Y&date=YYYY-MM-DD
 *
 * Queries CMEMS THREDDS for Kd490 at a lat/lon using two strategies:
 *   1. THREDDS NCSS grid-as-point → CSV  (simplest)
 *   2. THREDDS WMS GetFeatureInfo → XML  (fallback)
 *
 * Env vars (set in Netlify Site Settings → Environment Variables):
 *   CMEMS_USERNAME  – your Copernicus Marine email
 *   CMEMS_PASSWORD  – your Copernicus Marine password
 */

const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────────────────
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

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const { lat, lon, date } = event.queryStringParameters || {};
  const latF = parseFloat(lat);
  const lonF = parseFloat(lon);

  if (isNaN(latF) || isNaN(lonF) || latF < -90 || latF > 90 || lonF < -180 || lonF > 180) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid lat/lon.' }) };
  }

  const user = process.env.CMEMS_USERNAME;
  const pass = process.env.CMEMS_PASSWORD;
  if (!user || !pass) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'CMEMS credentials not configured in Netlify env vars.' }) };
  }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // Build ordered list of dates to try (requested date first, then one day back)
  const today = new Date();
  let primary;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    primary = new Date(date + 'T12:00:00Z');
  } else {
    primary = today;
  }
  const fallback = new Date(primary);
  fallback.setUTCDate(primary.getUTCDate() - 1);
  const datesToTry = [isoDate(primary), isoDate(fallback)];

  for (const d of datesToTry) {
    console.log(`[visibility] Trying date ${d} at (${latF}, ${lonF})`);

    // Strategy 1: NCSS grid-as-point → CSV
    let kd490 = await tryNCSS(auth, latF, lonF, d);
    if (kd490 !== null) {
      console.log(`[visibility] NCSS success: kd490=${kd490} on ${d}`);
      return ok(CORS, kd490, d);
    }

    // Strategy 2: WMS GetFeatureInfo → XML/text
    kd490 = await tryWMS(auth, latF, lonF, d);
    if (kd490 !== null) {
      console.log(`[visibility] WMS success: kd490=${kd490} on ${d}`);
      return ok(CORS, kd490, d);
    }
  }

  console.log(`[visibility] All strategies failed for (${latF}, ${lonF})`);
  return {
    statusCode: 404,
    headers: CORS,
    body: JSON.stringify({
      error: 'No satellite data available. Likely causes: cloud cover, land pixel, or coastal masking. Try a different date or open-ocean location.',
    }),
  };
};

function ok(headers, kd490, date) {
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

// ── Strategy 1: THREDDS NetCDF Subset Service (NCSS) ──────────────────────
// Returns a CSV like:  date,KD490[unit="m-1"]\n2026-04-19T12:00:00Z,0.0824
async function tryNCSS(auth, lat, lon, dateStr) {
  const url = new URL(`${THREDDS}/ncss/${DATASET}`);
  url.searchParams.set('var',       VAR);
  url.searchParams.set('latitude',  lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('time',      `${dateStr}T12:00:00Z`);
  url.searchParams.set('accept',    'csv');

  console.log('[NCSS] GET', url.toString());
  try {
    const res  = await fetch(url.toString(), { headers: { Authorization: auth }, timeout: 15000 });
    const body = await res.text();
    console.log(`[NCSS] status=${res.status} body-preview="${body.slice(0, 200)}"`);

    if (!res.ok) return null;
    return parseCSV(body);
  } catch (e) {
    console.error('[NCSS] fetch error:', e.message);
    return null;
  }
}

// Parse NCSS CSV: scan every token that looks like a float
function parseCSV(text) {
  // Typical format:
  //   date,KD490[unit="m-1"]
  //   2026-04-19T12:00:00Z,0.0824
  // Or with bbox:
  //   date,lat[...],lon[...],KD490[...]
  //   ...,0.0824
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;

  // Header line: find which column is our variable
  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  const varCol  = headers.findIndex(h => h.startsWith(VAR));
  if (varCol < 0) { console.warn('[NCSS] variable column not found in header:', lines[0]); return null; }

  // Data lines (skip header)
  const values = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= varCol) continue;
    const v = parseFloat(cols[varCol]);
    if (!isNaN(v) && v > 0 && v < 10) values.push(v);
  }

  if (values.length === 0) { console.warn('[NCSS] no valid values parsed'); return null; }
  return median(values);
}

// ── Strategy 2: THREDDS WMS GetFeatureInfo ─────────────────────────────────
// ncWMS returns XML or plain text with the value at a pixel
async function tryWMS(auth, lat, lon, dateStr) {
  const delta = 0.05; // ~5km box
  const minLon = (lon - delta).toFixed(4);
  const maxLon = (lon + delta).toFixed(4);
  const minLat = (lat - delta).toFixed(4);
  const maxLat = (lat + delta).toFixed(4);

  // WMS 1.1.1 with SRS=EPSG:4326 — bbox is minLon,minLat,maxLon,maxLat
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
    time:         `${dateStr}T00:00:00.000Z`,
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log('[WMS] GET', url.toString());
  try {
    const res  = await fetch(url.toString(), { headers: { Authorization: auth }, timeout: 15000 });
    const body = await res.text();
    console.log(`[WMS] status=${res.status} body-preview="${body.slice(0, 400)}"`);

    if (!res.ok) return null;
    return parseWMSResponse(body);
  } catch (e) {
    console.error('[WMS] fetch error:', e.message);
    return null;
  }
}

// Parse ncWMS XML or text to extract a float value
function parseWMSResponse(text) {
  // Try XML: <value>0.0824</value>  or  <value>0.0824 m-1</value>
  const xmlMatch = text.match(/<value[^>]*>([\d.eE+\-]+)/i);
  if (xmlMatch) {
    const v = parseFloat(xmlMatch[1]);
    if (!isNaN(v) && v > 0 && v < 10) return v;
  }

  // Try plain text: "KD490: 0.0824"
  const txtMatch = text.match(/KD490[^:]*:\s*([\d.eE+\-]+)/i);
  if (txtMatch) {
    const v = parseFloat(txtMatch[1]);
    if (!isNaN(v) && v > 0 && v < 10) return v;
  }

  // Scan all floats in the response
  const floats = [...text.matchAll(/([\d]+\.[\d]+(?:[eE][+\-]?\d+)?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(v => v > 0.001 && v < 5); // plausible Kd490 range

  if (floats.length > 0) {
    console.log('[WMS] fallback floats found:', floats);
    return median(floats);
  }

  console.warn('[WMS] no valid value found in response');
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
