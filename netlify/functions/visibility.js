/**
 * Netlify serverless function: GET /api/visibility?lat=X&lon=Y&date=YYYY-MM-DD
 * Debug mode:                  GET /api/visibility?lat=X&lon=Y&date=D&debug=1
 *
 * Uses WMS GetFeatureInfo on the same public teroWmts server that serves the
 * overlay tiles — no auth needed, confirmed live.
 *
 * Env vars (still needed for future authenticated endpoints):
 *   CMEMS_USERNAME, CMEMS_PASSWORD
 */

const fetch = require('node-fetch');

// ── The only confirmed-live CMEMS server ───────────────────────────────────
// nrt.cmems-du.eu is domain-squatted (dead). Use the public wmts server.
const TERO   = 'https://wmts.marine.copernicus.eu/teroWmts/';
const LAYER  = 'OCEANCOLOUR_GLO_BGC_L3_NRT_009_101/cmems_obs-oc_glo_bgc-transp_nrt_l3-olci-300m_P1D/KD490';

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

  // Dates to try: requested → day before (satellite latency / cloud fallback)
  const primary = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? new Date(date + 'T12:00:00Z') : new Date();
  const dayBefore = new Date(primary);
  dayBefore.setUTCDate(primary.getUTCDate() - 1);
  const datesToTry = [isoDate(primary), isoDate(dayBefore)];

  const diagnostics = [];

  for (const d of datesToTry) {
    console.log(`[visibility] trying ${d} at (${latF}, ${lonF})`);

    // Try GeoJSON first, then XML — same endpoint
    for (const fmt of ['application/json', 'text/xml']) {
      const result = await queryTeroWMS(latF, lonF, d, fmt);
      if (isDbg) diagnostics.push({ date: d, fmt, ...result });

      if (result.kd490 !== null) {
        console.log(`[visibility] hit: kd490=${result.kd490} on ${d} via ${fmt}`);
        if (isDbg) return dbgResponse(CORS, diagnostics, result.kd490, d, fmt);
        return okResponse(CORS, result.kd490, d);
      }
    }
  }

  console.log(`[visibility] no data found for (${latF}, ${lonF})`);
  if (isDbg) return { statusCode: 200, headers: CORS, body: JSON.stringify({ diagnostics, winner: null }) };
  return {
    statusCode: 404,
    headers: CORS,
    body: JSON.stringify({
      error: 'No satellite data for this location. Possible causes: cloud cover, land masking, or coastal proximity.',
    }),
  };
};

// ── WMS GetFeatureInfo against the public teroWmts server ─────────────────
async function queryTeroWMS(lat, lon, dateStr, infoFormat) {
  // 3×3 grid over a ~0.2° box; query the centre pixel (i=1, j=1)
  const delta  = 0.1;
  const minLon = (lon - delta).toFixed(4);
  const maxLon = (lon + delta).toFixed(4);
  const minLat = (lat - delta).toFixed(4);
  const maxLat = (lat + delta).toFixed(4);

  const url = new URL(TERO);
  Object.entries({
    service:      'WMS',
    version:      '1.3.0',
    request:      'GetFeatureInfo',
    layers:       LAYER,
    query_layers: LAYER,
    crs:          'CRS:84',
    bbox:         `${minLon},${minLat},${maxLon},${maxLat}`,
    width:        '3',
    height:       '3',
    i:            '1',
    j:            '1',
    info_format:  infoFormat,
    time:         `${dateStr}T00:00:00Z`,
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log('[teroWMS]', url.toString());
  try {
    const res  = await fetch(url.toString(), { timeout: 15000 });
    const body = await res.text();
    console.log(`[teroWMS] format=${infoFormat} status=${res.status} preview="${body.slice(0, 500)}"`);

    if (!res.ok) return { kd490: null, status: res.status, preview: body.slice(0, 500), url: url.toString() };

    const kd490 = infoFormat === 'application/json'
      ? parseGeoJSON(body)
      : parseXML(body);

    return { kd490, status: res.status, preview: body.slice(0, 500), url: url.toString() };
  } catch (e) {
    console.error('[teroWMS] fetch error:', e.message);
    return { kd490: null, error: e.message, url: url.toString() };
  }
}

// ── Parsers ────────────────────────────────────────────────────────────────

// GeoJSON FeatureCollection response (OGC standard)
// { "type": "FeatureCollection", "features": [{ "properties": { "KD490": 0.082, ... } }] }
function parseGeoJSON(text) {
  try {
    const json = JSON.parse(text);
    const features = json.features || [];

    const values = [];
    for (const f of features) {
      const props = f.properties || {};
      for (const [key, val] of Object.entries(props)) {
        if (key.toUpperCase().includes('KD490') || key.toUpperCase() === 'VALUE') {
          const v = parseFloat(val);
          if (isFinite(v) && v > 0 && v < 10) values.push(v);
        }
      }
    }
    if (values.length > 0) { console.log('[GeoJSON] values:', values); return median(values); }

    // Explicit empty response → no data (not an error)
    if (features.length === 0) { console.log('[GeoJSON] empty feature collection — no data here'); return null; }

    console.warn('[GeoJSON] features present but no KD490 property found');
  } catch (e) { console.warn('[GeoJSON] parse error:', e.message); }
  return null;
}

// XML response — ncWMS, MapServer, or GeoServer style
// <value>0.082</value>  or  KD490: 0.082  or  <GRAY_INDEX>0.082</GRAY_INDEX>
function parseXML(text) {
  // Explicit "none" / nodata — return null cleanly
  if (/<value[^>]*>\s*none\s*</i.test(text) ||
      /<value[^>]*>\s*-9{3,}/i.test(text))  { console.log('[XML] explicit nodata'); return null; }

  // <value>0.082</value>
  const valTag = text.match(/<value[^>]*>\s*([\d.eE+\-]+)\s*</i);
  if (valTag) {
    const v = parseFloat(valTag[1]);
    if (isFinite(v) && v > 0 && v < 10) { console.log('[XML] <value>:', v); return v; }
  }

  // <GRAY_INDEX>0.082</GRAY_INDEX>  (MapServer)
  const gray = text.match(/<GRAY_INDEX[^>]*>\s*([\d.eE+\-]+)\s*</i);
  if (gray) {
    const v = parseFloat(gray[1]);
    if (isFinite(v) && v > 0 && v < 10) { console.log('[XML] <GRAY_INDEX>:', v); return v; }
  }

  // KD490 = 0.082 or KD490: 0.082  (plain text in XML body)
  const labeled = text.match(/KD490[^0-9\-]*?([\d.eE+\-]+)/i);
  if (labeled) {
    const v = parseFloat(labeled[1]);
    if (isFinite(v) && v > 0 && v < 10) { console.log('[XML] labeled match:', v); return v; }
  }

  console.warn('[XML] no value extracted');
  return null;
}

// ── Response helpers ───────────────────────────────────────────────────────
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

function dbgResponse(headers, diagnostics, kd490, date, fmt) {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ diagnostics, winner: fmt, kd490, date }),
  };
}
