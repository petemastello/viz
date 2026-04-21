/**
 * Netlify serverless function: GET /api/visibility?lat=X&lon=Y&date=YYYY-MM-DD
 * Debug:                       add &debug=1
 *
 * Strategy: fetch the WMTS tile that covers the clicked location, decode the
 * PNG, read the pixel colour, and invert the jet colormap + log scale back
 * to Kd490.  This uses the same confirmed-live tile server as the map overlay.
 *
 * No credentials needed — CMEMS overlay tiles are public.
 */

const fetch = require('node-fetch');
const { PNG } = require('pngjs');

// ── Colormap + scale ────────────────────────────────────────────────────────
// WMTS style: cmap:dense, logScale
const KD_MIN  = 0.03;
const KD_MAX  = 0.5;
const LOG_MIN = Math.log(KD_MIN);  // −3.507
const LOG_MAX = Math.log(KD_MAX);  // −0.693

// cmocean 'dense': t=0 → light (clear water), t=1 → dark blue (turbid)
// Anchor points (R,G,B in 0–255):
// t=0.00: (230,240,240)  t=0.25: (130,195,205)  t=0.50: (40,145,165)
// t=0.75: (10,85,125)    t=1.00: (8,40,60)
function denseRGB(t) {
  t = Math.max(0, Math.min(1, t));
  const anchors = [
    [230, 240, 240],
    [130, 195, 205],
    [ 40, 145, 165],
    [ 10,  85, 125],
    [  8,  40,  60],
  ];
  const seg = t * (anchors.length - 1);
  const lo  = Math.floor(seg);
  const hi  = Math.min(lo + 1, anchors.length - 1);
  const f   = seg - lo;
  return anchors[lo].map((v, i) => Math.round(v + f * (anchors[hi][i] - v)));
}

// Pre-build LUT: 512 entries covering the full dense range
const LUT = Array.from({ length: 512 }, (_, i) => {
  const t     = i / 511;
  const kd490 = Math.exp(LOG_MIN + t * (LOG_MAX - LOG_MIN));
  const [r, g, b] = denseRGB(t);
  return { kd490, r, g, b };
});

// Find nearest Kd490 for an RGB pixel (NN lookup in colour space)
function rgbToKd490(r, g, b) {
  let best = null, bestDist = Infinity;
  for (const e of LUT) {
    const d = (r - e.r) ** 2 + (g - e.g) ** 2 + (b - e.b) ** 2;
    if (d < bestDist) { bestDist = d; best = e; }
  }
  // Reject if the closest LUT colour is too far away (nodata colour, artefact)
  return bestDist < 3000 ? best.kd490 : null;
}

// ── Tile maths (EPSG:3857 / standard slippy-map XYZ) ──────────────────────
function latLonToTile(lat, lon, z) {
  const n   = Math.pow(2, z);
  const x   = Math.floor((lon + 180) / 360 * n);
  const rad = lat * Math.PI / 180;
  const y   = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  return { x, y: Math.max(0, Math.min(n - 1, y)), z };
}

function tilePixel(lat, lon, tile) {
  const { x, y, z } = tile;
  const n   = Math.pow(2, z);
  const rad = lat * Math.PI / 180;
  const px  = Math.floor(((lon + 180) / 360 * n - x) * 256);
  const py  = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n - y) * 256);
  return { px: Math.max(0, Math.min(255, px)), py: Math.max(0, Math.min(255, py)) };
}

// ── WMTS tile URL (mirrors the Leaflet overlay URL) ────────────────────────
const LAYER = 'OCEANCOLOUR_GLO_BGC_L3_NRT_009_101/cmems_obs-oc_glo_bgc-transp_nrt_l3-olci-4km_P1D_202207/KD490';
const STYLE = 'cmap:dense,logScale';
const WMTS  = 'https://wmts.marine.copernicus.eu/teroWmts/';

function tileUrl(z, x, y, dateStr) {
  return WMTS +
    `?service=WMTS&version=1.0.0&request=GetTile` +
    `&layer=${encodeURIComponent(LAYER)}` +
    `&tilematrixset=EPSG%3A3857` +
    `&tilematrix=${z}&tilerow=${y}&tilecol=${x}` +
    `&style=${encodeURIComponent(STYLE)}` +
    `&time=${dateStr}T00:00:00.000Z`;
}

// ── Fetch + decode tile → sample pixels ────────────────────────────────────
async function sampleTile(lat, lon, dateStr, zoom) {
  const tile = latLonToTile(lat, lon, zoom);
  const url  = tileUrl(zoom, tile.x, tile.y, dateStr);
  console.log(`[tile z=${zoom}]`, url);

  const res = await fetch(url, { timeout: 15000 });
  console.log(`[tile] status=${res.status} content-type=${res.headers.get('content-type')}`);
  if (!res.ok) return { kd490: null, reason: `HTTP ${res.status}`, url };

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('png') && !ct.includes('image')) {
    const txt = await res.text();
    console.log('[tile] non-image response:', txt.slice(0, 200));
    return { kd490: null, reason: 'non-image response', preview: txt.slice(0, 200), url };
  }

  const buf = await res.buffer();

  return new Promise((resolve) => {
    const png = new PNG();
    png.parse(buf, (err, data) => {
      if (err) { console.error('[tile] PNG parse error:', err.message); resolve({ kd490: null, reason: 'PNG parse error', url }); return; }

      const { px, py } = tilePixel(lat, lon, tile);

      // Sample a 3×3 window around the target pixel for robustness
      const values = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ix = Math.max(0, Math.min(255, px + dx));
          const iy = Math.max(0, Math.min(255, py + dy));
          const i  = (data.width * iy + ix) * 4;
          const r  = data.data[i];
          const g  = data.data[i + 1];
          const b  = data.data[i + 2];
          const a  = data.data[i + 3];
          if (a < 10) continue; // transparent = land or cloud-masked, skip
          const kd490 = rgbToKd490(r, g, b);
          if (kd490 !== null) values.push(kd490);
          console.log(`  pixel (${ix},${iy}) rgba=(${r},${g},${b},${a}) → kd490=${kd490}`);
        }
      }

      if (values.length === 0) {
        console.log('[tile] all sampled pixels transparent or unmatched');
        resolve({ kd490: null, reason: 'all pixels transparent/masked', url });
        return;
      }

      const kd490 = median(values);
      console.log(`[tile] sampled ${values.length} pixels, median kd490=${kd490}`);
      resolve({ kd490, pixelCount: values.length, url });
    });
  });
}

// ── Quality classification ─────────────────────────────────────────────────
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

  // Dates to try: requested → day before (cloud-cover / latency fallback)
  const primary = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? new Date(date + 'T12:00:00Z') : new Date();
  const dayBefore = new Date(primary);
  dayBefore.setUTCDate(primary.getUTCDate() - 1);
  const datesToTry = [isoDate(primary), isoDate(dayBefore)];

  const diagnostics = [];

  for (const d of datesToTry) {
    // Try zoom levels 7 then 6 — higher zoom = finer pixel, but sparser data
    for (const zoom of [7, 6]) {
      const result = await sampleTile(latF, lonF, d, zoom);
      if (isDbg) diagnostics.push({ date: d, zoom, ...result });

      if (result.kd490 !== null) {
        const kd490 = result.kd490;
        if (isDbg) return { statusCode: 200, headers: CORS,
          body: JSON.stringify({ diagnostics, kd490, date: d, zoom }) };
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            kd490:        parseFloat(kd490.toFixed(4)),
            visibility_m: parseFloat((1.7 / kd490).toFixed(1)),
            date:         d,
            quality:      classify(kd490),
          }),
        };
      }
    }
  }

  if (isDbg) return { statusCode: 200, headers: CORS, body: JSON.stringify({ diagnostics, kd490: null }) };
  return {
    statusCode: 404,
    headers: CORS,
    body: JSON.stringify({
      error: 'No data at this location. Likely cloud cover, land masking, or no satellite pass for this date.',
    }),
  };
};
