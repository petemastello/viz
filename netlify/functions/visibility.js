/**
 * Netlify serverless function: GET /api/visibility?lat=X&lon=Y
 *
 * Queries the CMEMS Data Store (marine.copernicus.eu) for Kd490 at the
 * requested lat/lon using the OCEANCOLOUR_GLO_BGC_L3_NRT_009_101 product.
 *
 * Env vars required (set in Netlify site settings):
 *   CMEMS_USERNAME
 *   CMEMS_PASSWORD
 */

const fetch = require('node-fetch');

// ── Constants ──────────────────────────────────────────────────────────────
const DATASET_ID = 'cmems_obs-oc_glo_bgc-transp_nrt_l3-olci-300m_P1D';
const VARIABLE   = 'KD490';
// CMEMS OPeNDAP / subset REST endpoint
const SUBSET_URL = 'https://nrt.cmems-du.eu/thredds/dodsC/' + DATASET_ID;

// Visibility quality thresholds (Kd490 → label)
const THRESHOLDS = [
  { max: 0.085,    label: 'Excellent' },
  { max: 0.17,     label: 'Good'      },
  { max: 0.34,     label: 'Fair'      },
  { max: 0.85,     label: 'Poor'      },
  { max: Infinity, label: 'Very Poor' },
];

function classify(kd490) {
  return (THRESHOLDS.find(t => kd490 < t.max) || THRESHOLDS.at(-1)).label;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Main handler ───────────────────────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // Parse and validate query params
  const { lat, lon, date } = event.queryStringParameters || {};
  const latF = parseFloat(lat);
  const lonF = parseFloat(lon);

  if (isNaN(latF) || isNaN(lonF) || latF < -90 || latF > 90 || lonF < -180 || lonF > 180) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid lat/lon.' }) };
  }

  const username = process.env.CMEMS_USERNAME;
  const password = process.env.CMEMS_PASSWORD;

  if (!username || !password) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server credentials not configured.' }),
    };
  }

  // ── Build date list to try ────────────────────────────────────────────────
  // If the client specifies a date, try it then fall back one day (cloud gaps).
  // Otherwise default to today → yesterday.
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

  let datesToTry;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const requested = new Date(date + 'T12:00:00Z');
    const dayBefore = new Date(requested); dayBefore.setDate(requested.getDate() - 1);
    datesToTry = [requested, dayBefore];
  } else {
    datesToTry = [today, yesterday];
  }

  for (const targetDate of datesToTry) {
    const dateStr = isoDate(targetDate);
    const result  = await fetchKd490(username, password, latF, lonF, dateStr);

    if (result.error === '__retry__') continue; // no data for this date, try next

    if (result.error) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: result.error }) };
    }

    const { kd490 } = result;
    const visibility_m = parseFloat((1.7 / kd490).toFixed(1));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        kd490:        parseFloat(kd490.toFixed(4)),
        visibility_m,
        date:         dateStr,
        quality:      classify(kd490),
      }),
    };
  }

  return {
    statusCode: 404,
    headers,
    body: JSON.stringify({ error: 'No satellite data available for this location. This may be due to cloud cover, land masking, or coastal proximity.' }),
  };
};

// ── Fetch Kd490 from CMEMS via WCS/OPeNDAP ────────────────────────────────
async function fetchKd490(username, password, lat, lon, dateStr) {
  /**
   * We use the CMEMS Copernicus Marine Toolbox REST API:
   *   https://nrt.cmems-du.eu/thredds/wcs/<dataset>
   *   ?service=WCS&version=1.0.0&request=GetCoverage
   *   &coverage=KD490
   *   &bbox=<lon-0.15>,<lat-0.15>,<lon+0.15>,<lat+0.15>
   *   &TIME=<date>/<date>
   *   &FORMAT=application/json   ← not always supported
   *
   * Fallback: OPeNDAP ASCII endpoint for a small spatial/temporal slice.
   */

  const halfBox = 0.15; // degrees (~15 km each side)
  const minLon  = (lon - halfBox).toFixed(4);
  const maxLon  = (lon + halfBox).toFixed(4);
  const minLat  = (lat - halfBox).toFixed(4);
  const maxLat  = (lat + halfBox).toFixed(4);

  const creds  = Buffer.from(`${username}:${password}`).toString('base64');
  const authHd = { Authorization: `Basic ${creds}` };

  // ── Strategy 1: OPeNDAP ASCII subset ────────────────────────────────────
  // URL form: /thredds/dodsC/<dataset>.ascii?KD490[t][lat][lon]
  // We request a lat/lon slice for the target date.
  // The OPeNDAP ASCII response contains values we can parse.
  try {
    const opendapUrl = buildOpendapUrl(DATASET_ID, VARIABLE, lat, lon, dateStr, halfBox);
    const res = await fetch(opendapUrl, {
      headers: { ...authHd, Accept: 'text/plain' },
      timeout: 15000,
    });

    if (res.status === 401) return { error: 'CMEMS authentication failed. Check credentials.' };
    if (res.status === 403) return { error: 'Access denied to CMEMS dataset.' };

    if (res.ok) {
      const text = await res.text();
      const values = parseOpendapAscii(text);
      if (values.length === 0) return { error: '__retry__' };

      // Filter fill values (≤0 or very large) then take median
      const valid = values.filter(v => v > 0 && v < 10);
      if (valid.length === 0) return { error: '__retry__' };

      const kd490 = median(valid);
      return { kd490 };
    }
  } catch (e) {
    // fall through to strategy 2
    console.error('OPeNDAP fetch error:', e.message);
  }

  // ── Strategy 2: CMEMS Toolbox REST subset API ────────────────────────────
  // https://data-be-nrt.cmems-du.eu/api/v1/subset
  try {
    const params = new URLSearchParams({
      dataset_id:   DATASET_ID,
      variables:    VARIABLE,
      minimum_longitude: minLon,
      maximum_longitude: maxLon,
      minimum_latitude:  minLat,
      maximum_latitude:  maxLat,
      start_datetime:    `${dateStr}T00:00:00`,
      end_datetime:      `${dateStr}T23:59:59`,
      output_filename:   'subset.json',
      file_format:       'json',
    });

    const apiUrl = `https://data-be-nrt.cmems-du.eu/api/v1/subset?${params}`;
    const res    = await fetch(apiUrl, { headers: authHd, timeout: 20000 });

    if (res.ok) {
      const json = await res.json();
      // Parse values from the JSON response (structure varies)
      const values = extractJsonValues(json, VARIABLE);
      if (values.length === 0) return { error: '__retry__' };
      const valid  = values.filter(v => v > 0 && v < 10);
      if (valid.length === 0) return { error: '__retry__' };
      return { kd490: median(valid) };
    }

    const errText = await res.text().catch(() => '');
    console.error('Subset API error:', res.status, errText.slice(0, 200));
  } catch (e) {
    console.error('Subset API fetch error:', e.message);
  }

  return { error: 'Could not retrieve satellite data. CMEMS service may be unavailable.' };
}

// ── OPeNDAP URL builder ────────────────────────────────────────────────────
function buildOpendapUrl(datasetId, variable, lat, lon, dateStr, halfBox) {
  // NRT THREDDS server
  const base = `https://nrt.cmems-du.eu/thredds/dodsC/${datasetId}.ascii`;
  // We request: variable[0:0][latIdx-n:latIdx+n][lonIdx-n:lonIdx+n]
  // Since we don't know indices without metadata, use the coordinate constraint syntax
  // which some THREDDS servers support via the "dods" projection or HTTP form.
  // Alternatively, use the simple bounding-box URL format supported by many CMEMS endpoints.
  const url =
    `${base}?${variable}` +
    `&lat>=${(lat - halfBox).toFixed(3)}&lat<=${(lat + halfBox).toFixed(3)}` +
    `&lon>=${(lon - halfBox).toFixed(3)}&lon<=${(lon + halfBox).toFixed(3)}` +
    `&time>=${dateStr}T00:00:00Z&time<=${dateStr}T23:59:59Z`;
  return url;
}

// ── OPeNDAP ASCII response parser ─────────────────────────────────────────
function parseOpendapAscii(text) {
  // OPeNDAP ASCII format looks like:
  //   KD490.KD490[0][0][0]
  //   0.08213
  //   KD490.KD490[0][0][1]
  //   ...
  // Extract all float values that appear on their own line
  const values = [];
  const lines  = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip header lines (contain letters beyond standard float notation)
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) {
      const v = parseFloat(trimmed);
      if (!isNaN(v)) values.push(v);
    }
  }
  return values;
}

// ── JSON response value extractor ─────────────────────────────────────────
function extractJsonValues(json, variable) {
  const values = [];
  function walk(obj) {
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (typeof obj === 'number') { values.push(obj); return; }
    if (obj && typeof obj === 'object') {
      if (variable in obj) { walk(obj[variable]); return; }
      Object.values(obj).forEach(walk);
    }
  }
  walk(json);
  return values;
}

// ── Median helper ──────────────────────────────────────────────────────────
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
