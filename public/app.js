/* ── Dive Visibility App ── */

// ── Date helpers ───────────────────────────────────────────────────────────
function isoDate(d) { return d.toISOString().slice(0, 10); }

function getLast10Days() {
  const days = [];
  for (let i = 9; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(isoDate(d));
  }
  return days; // [oldest, …, today]
}

function shortLabel(iso) {
  // "2026-04-20" → "Apr 20"
  const [, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ── Map init ───────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([-18, 147], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
}).addTo(map);

// ── CMEMS Kd490 overlay ────────────────────────────────────────────────────
// Uses the public CMEMS WMTS service (no auth needed for tiles).
// Layer format: PRODUCT/DATASET/VARIABLE
// Style: jet colormap, Kd490 range 0.03–0.5 on log scale
function buildWmtsUrl(dateStr) {
  const base   = 'https://wmts.marine.copernicus.eu/teroWmts/';
  const layer  = 'OCEANCOLOUR_GLO_BGC_L3_NRT_009_101/cmems_obs-oc_glo_bgc-transp_nrt_l3-olci-300m_P1D/KD490';
  const style  = 'cmap:jet,range:0.03/0.5,logScale';

  return (
    base +
    `?service=WMTS&version=1.0.0&request=GetTile` +
    `&layer=${encodeURIComponent(layer)}` +
    `&tilematrixset=EPSG%3A3857` +
    `&tilematrix={z}&tilerow={y}&tilecol={x}` +
    `&style=${encodeURIComponent(style)}` +
    `&time=${dateStr}`
  );
}

let overlayVisible = true;
let wmtsLayer = L.tileLayer(buildWmtsUrl(isoDate(new Date())), {
  attribution: '© <a href="https://marine.copernicus.eu">CMEMS</a> · Sentinel-3 OLCI',
  opacity: 0.85,
  maxZoom: 18,
  crossOrigin: true,
}).addTo(map);

// ── Overlay toggle ─────────────────────────────────────────────────────────
const overlayToggleBtn = document.getElementById('overlay-toggle');
overlayToggleBtn.addEventListener('click', () => {
  overlayVisible = !overlayVisible;
  overlayToggleBtn.classList.toggle('active', overlayVisible);
  wmtsLayer.setOpacity(overlayVisible ? 0.85 : 0);
});

// ── Timeline state ─────────────────────────────────────────────────────────
const DAYS         = getLast10Days();
let   selectedIdx  = DAYS.length - 1; // start on today
let   isPlaying    = false;
let   playTimer    = null;

// ── Timeline DOM build ─────────────────────────────────────────────────────
const timelineDays = document.getElementById('timeline-days');
const playBtn      = document.getElementById('play-btn');
const playIcon     = document.getElementById('play-icon');
const pauseIcon    = document.getElementById('pause-icon');

DAYS.forEach((date, i) => {
  const tick = document.createElement('div');
  tick.className = 'day-tick' + (i === selectedIdx ? ' active' : '');
  tick.dataset.idx = i;
  tick.title = date;

  const label = document.createElement('div');
  label.className = 'day-label';
  label.textContent = shortLabel(date);

  tick.appendChild(label);
  tick.addEventListener('click', () => selectDay(i));
  timelineDays.appendChild(tick);
});

function selectDay(idx) {
  if (idx === selectedIdx) return;

  // Update active tick
  timelineDays.querySelectorAll('.day-tick').forEach((t, i) => {
    t.classList.toggle('active', i === idx);
  });

  selectedIdx = idx;
  const dateStr = DAYS[idx];

  // Swap WMTS layer to new date and force reload
  wmtsLayer.setUrl(buildWmtsUrl(dateStr), false);

  // Re-query the pinned location if the result card is open
  if (!card.classList.contains('hidden') && pinnedLatLng) {
    queryVisibility(pinnedLatLng.lat, pinnedLatLng.lng, dateStr);
  }
}

// ── Play / Pause ───────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => {
  isPlaying ? pauseAnimation() : playAnimation();
});

function playAnimation() {
  isPlaying = true;
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');

  // If at end, restart from beginning
  if (selectedIdx >= DAYS.length - 1) selectDay(0);

  playTimer = setInterval(() => {
    const next = selectedIdx + 1;
    if (next >= DAYS.length) {
      pauseAnimation();
      return;
    }
    selectDay(next);
  }, 1000);
}

function pauseAnimation() {
  isPlaying = false;
  playIcon.classList.remove('hidden');
  pauseIcon.classList.add('hidden');
  clearInterval(playTimer);
  playTimer = null;
}

// Pause when user clicks a tick manually during playback
timelineDays.addEventListener('click', () => { if (isPlaying) pauseAnimation(); });

// ── State ──────────────────────────────────────────────────────────────────
let clickMarker  = null;
let pinnedLatLng = null;

// ── UI element refs ────────────────────────────────────────────────────────
const card        = document.getElementById('result-card');
const cardClose   = document.getElementById('result-close');
const loading     = document.getElementById('result-loading');
const errorEl     = document.getElementById('result-error');
const errorMsg    = document.getElementById('result-error-msg');
const content     = document.getElementById('result-content');
const depthEl     = document.getElementById('result-depth');
const qualityEl   = document.getElementById('result-quality');
const metaEl      = document.getElementById('result-meta');
const markerEl    = document.getElementById('result-marker');
const searchInput = document.getElementById('search-input');
const suggestBox  = document.getElementById('search-suggestions');

// ── Visibility helpers ─────────────────────────────────────────────────────
const THRESHOLDS = [
  { max: 0.085,    label: 'Excellent', cls: 'quality-excellent' },
  { max: 0.17,     label: 'Good',      cls: 'quality-good'      },
  { max: 0.34,     label: 'Fair',      cls: 'quality-fair'      },
  { max: 0.85,     label: 'Poor',      cls: 'quality-poor'      },
  { max: Infinity, label: 'Very Poor', cls: 'quality-very-poor' },
];

function classify(kd490) {
  return THRESHOLDS.find(t => kd490 < t.max);
}

function kd490ToBarPct(kd490) {
  const lo = Math.log(0.03);
  const hi = Math.log(0.5);
  const v  = Math.log(Math.max(0.03, Math.min(0.5, kd490)));
  return ((v - lo) / (hi - lo)) * 100;
}

// ── Card state ─────────────────────────────────────────────────────────────
function showCard() { card.classList.remove('hidden'); }

function setCardState(state) {
  content.classList.add('hidden');
  loading.classList.add('hidden');
  errorEl.classList.add('hidden');
  if (state === 'loading') { loading.classList.remove('hidden'); showCard(); }
  if (state === 'error')   { errorEl.classList.remove('hidden'); showCard(); }
  if (state === 'content') { content.classList.remove('hidden'); showCard(); }
}

cardClose.addEventListener('click', () => {
  card.classList.add('hidden');
  pinnedLatLng = null;
});

// ── Fetch visibility ───────────────────────────────────────────────────────
async function queryVisibility(lat, lon, dateStr) {
  setCardState('loading');
  try {
    const res  = await fetch(`/api/visibility?lat=${lat}&lon=${lon}&date=${dateStr}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      errorMsg.textContent = data.error || 'Failed to fetch data.';
      setCardState('error');
      return;
    }

    const { kd490, visibility_m, date, quality } = data;
    const tier = classify(kd490);

    depthEl.textContent   = `${visibility_m.toFixed(1)} m`;
    qualityEl.textContent = quality;
    qualityEl.className   = `result-quality ${tier.cls}`;
    metaEl.textContent    = `Kd490 = ${kd490.toFixed(3)} · Sentinel-3 OLCI · ${date}`;
    markerEl.style.left   = `${kd490ToBarPct(kd490)}%`;

    setCardState('content');
  } catch {
    errorMsg.textContent = 'Network error. Check your connection.';
    setCardState('error');
  }
}

// ── Map click ──────────────────────────────────────────────────────────────
function handleMapClick(latlng) {
  const { lat, lng } = latlng;
  pinnedLatLng = { lat, lng };

  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }

  const pulseIcon = L.divIcon({
    className: '',
    html: '<div class="click-pulse"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
  clickMarker = L.marker([lat, lng], { icon: pulseIcon, interactive: false }).addTo(map);

  queryVisibility(lat, lng, DAYS[selectedIdx]);
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
      searchInput.value    = hit.display_name;
      suggestBox.innerHTML = '';
      const lat = parseFloat(hit.lat);
      const lon = parseFloat(hit.lon);
      map.flyTo([lat, lon], 8, { duration: 1.2 });
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

document.addEventListener('click', e => {
  if (!document.getElementById('search-box').contains(e.target)) {
    suggestBox.innerHTML = '';
  }
});
