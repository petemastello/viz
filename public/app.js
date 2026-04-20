/* ── Dive Visibility App ── */

// ── Map init ──────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([-18, 147], 5);

// OSM base layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
}).addTo(map);

// ── CMEMS WMTS Kd490 overlay ───────────────────────────────────────────────
// Layer: OCEANCOLOUR_GLO_BGC_L3_NRT_009_101
// Variable: KD490 (diffuse attenuation coefficient at 490nm)
const WMTS_URL =
  'https://wmts.marine.copernicus.eu/teroWmts/?service=WMTS&version=1.0.0' +
  '&request=GetTile' +
  '&layer=OCEANCOLOUR_GLO_BGC_L3_NRT_009_101%2F' +
  'cmems_obs-oc_glo_bgc-transp_nrt_l3-olci-300m_P1D%2FKD490' +
  '&tilematrixset=EPSG%3A3857' +
  '&tilematrix={z}&tilerow={y}&tilecol={x}' +
  '&style=cmap%3Adeep%2Crange%3A0.03%2F0.5%2ClogScale';

L.tileLayer(WMTS_URL, {
  attribution: '© <a href="https://marine.copernicus.eu">CMEMS</a> · Sentinel-3 OLCI',
  opacity: 0.75,
  maxZoom: 18,
  tms: false,
}).addTo(map);

// ── State ──────────────────────────────────────────────────────────────────
let clickMarker = null;

// ── UI element refs ────────────────────────────────────────────────────────
const card       = document.getElementById('result-card');
const cardClose  = document.getElementById('result-close');
const loading    = document.getElementById('result-loading');
const errorEl    = document.getElementById('result-error');
const errorMsg   = document.getElementById('result-error-msg');
const content    = document.getElementById('result-content');
const depthEl    = document.getElementById('result-depth');
const qualityEl  = document.getElementById('result-quality');
const metaEl     = document.getElementById('result-meta');
const markerEl   = document.getElementById('result-marker');
const searchInput = document.getElementById('search-input');
const suggestBox = document.getElementById('search-suggestions');

// ── Visibility helpers ─────────────────────────────────────────────────────
const THRESHOLDS = [
  { max: 0.085, label: 'Excellent', cls: 'quality-excellent' },
  { max: 0.17,  label: 'Good',      cls: 'quality-good'      },
  { max: 0.34,  label: 'Fair',      cls: 'quality-fair'      },
  { max: 0.85,  label: 'Poor',      cls: 'quality-poor'      },
  { max: Infinity, label: 'Very Poor', cls: 'quality-very-poor' },
];

function classify(kd490) {
  return THRESHOLDS.find(t => kd490 < t.max);
}

// Map Kd490 (log scale 0.03–0.5) → 0–100% for the progress bar marker
function kd490ToBarPct(kd490) {
  const lo = Math.log(0.03);
  const hi = Math.log(0.5);
  const v  = Math.log(Math.max(0.03, Math.min(0.5, kd490)));
  return ((v - lo) / (hi - lo)) * 100;
}

// ── Show / hide card states ────────────────────────────────────────────────
function showCard() { card.classList.remove('hidden'); }

function setCardState(state) {
  content.classList.add('hidden');
  loading.classList.add('hidden');
  errorEl.classList.add('hidden');
  if (state === 'loading') { loading.classList.remove('hidden'); showCard(); }
  if (state === 'error')   { errorEl.classList.remove('hidden'); showCard(); }
  if (state === 'content') { content.classList.remove('hidden'); showCard(); }
}

cardClose.addEventListener('click', () => card.classList.add('hidden'));

// ── Fetch visibility from serverless function ─────────────────────────────
async function queryVisibility(lat, lon) {
  setCardState('loading');
  try {
    const res  = await fetch(`/api/visibility?lat=${lat}&lon=${lon}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      errorMsg.textContent = data.error || 'Failed to fetch data.';
      setCardState('error');
      return;
    }

    const { kd490, visibility_m, date, quality } = data;
    const tier = classify(kd490);

    depthEl.textContent    = `${visibility_m.toFixed(1)} m`;
    qualityEl.textContent  = quality;
    qualityEl.className    = `result-quality ${tier.cls}`;
    metaEl.textContent     = `Kd490 = ${kd490.toFixed(3)} · Sentinel-3 OLCI · ${date}`;
    markerEl.style.left    = `${kd490ToBarPct(kd490)}%`;

    setCardState('content');
  } catch (err) {
    errorMsg.textContent = 'Network error. Check your connection.';
    setCardState('error');
  }
}

// ── Map click handler ──────────────────────────────────────────────────────
function handleMapClick(latlng) {
  const { lat, lng } = latlng;

  // Remove old marker
  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }

  // Pulsing circle marker
  const pulseIcon = L.divIcon({
    className: '',
    html: '<div class="click-pulse"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
  clickMarker = L.marker([lat, lng], { icon: pulseIcon, interactive: false }).addTo(map);

  queryVisibility(lat, lng);
}

map.on('click', e => handleMapClick(e.latlng));

// ── Nominatim search ───────────────────────────────────────────────────────
let searchTimer = null;

async function fetchSuggestions(query) {
  if (query.length < 3) { suggestBox.innerHTML = ''; return; }
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const hits = await res.json();
    renderSuggestions(hits);
  } catch { suggestBox.innerHTML = ''; }
}

function renderSuggestions(hits) {
  suggestBox.innerHTML = '';
  hits.forEach(hit => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.textContent = hit.display_name;
    div.addEventListener('click', () => {
      searchInput.value  = hit.display_name;
      suggestBox.innerHTML = '';
      const lat = parseFloat(hit.lat);
      const lon = parseFloat(hit.lon);
      map.flyTo([lat, lon], 8, { duration: 1.2 });
      // Small delay so the fly animation starts before querying
      setTimeout(() => handleMapClick({ lat, lng: lon }), 800);
    });
    suggestBox.appendChild(div);
  });
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => fetchSuggestions(searchInput.value.trim()), 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { suggestBox.innerHTML = ''; searchInput.blur(); }
});

// Close suggestions when clicking elsewhere
document.addEventListener('click', e => {
  if (!document.getElementById('search-box').contains(e.target)) {
    suggestBox.innerHTML = '';
  }
});
