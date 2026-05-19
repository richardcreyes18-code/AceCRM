// js/buyer-criteria/bc-map.js — Interactive location map for BC expanded view.
// Yellow state polygons at zoom≤7, blue county polygons at zoom>7, red city markers always.

const _maps        = new Map(); // containerId → { map, stateLayer, countyLayer, cityLayer }
const _countyCache = new Map(); // stateFips → GeoJSON | null
const _cityCache   = new Map(); // city string (lower) → [lat, lng] | null

let _statesGeoJson = null; // us-atlas feature collection, loaded once

const STATE_STYLE  = { color: '#b8860b', weight: 1.5, fillColor: '#ffd700', fillOpacity: 0.35 };
const COUNTY_STYLE = { color: '#1565c0', weight: 1,   fillColor: '#1976d2', fillOpacity: 0.30 };

const _STATE_FIPS = {
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',FL:'12',GA:'13',
  HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',
  MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',
  NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',
  SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56',DC:'11',
};

// ── Lazy loaders ──────────────────────────────────────────────────────────────

async function _ensureLeaflet() {
  if (window.L) return window.L;
  if (typeof window._loadLeaflet === 'function') return window._loadLeaflet();
  if (!document.querySelector('link[href*="leaflet.min.css"]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(css);
  }
  await new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
  return window.L;
}

async function _ensureTopojson() {
  if (window.topojson) return window.topojson;
  await new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
  return window.topojson;
}

async function _ensureStatesGeoJson() {
  if (_statesGeoJson) return _statesGeoJson;
  const [topo] = await Promise.all([
    fetch('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json').then(r => r.json()),
    _ensureTopojson(),
  ]);
  _statesGeoJson = window.topojson.feature(topo, topo.objects.states);
  return _statesGeoJson;
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function _fetchCountiesForState(fips) {
  if (_countyCache.has(fips)) return _countyCache.get(fips);
  const url =
    `https://tigerweb.geo.census.gov/arcgis/rest/services/TigerWeb/State_County/MapServer/5/query` +
    `?where=STATEFP%3D'${fips}'&outFields=NAME%2CSTATEFP&f=geojson&returnGeometry=true`;
  try {
    const data = await fetch(url).then(r => r.json());
    _countyCache.set(fips, data);
    return data;
  } catch (e) {
    console.warn('[bc-map] county fetch failed for FIPS', fips, e.message);
    _countyCache.set(fips, null);
    return null;
  }
}

// Try "{city}, {stateCode}" for each buyer state before falling back to bare city name.
// This prevents "Galloway" from resolving to Galloway, WI instead of Galloway, NJ.
async function _geocodeCity(cityStr, stateHints = []) {
  const city = cityStr.trim();
  const key  = city.toLowerCase() + '|' + stateHints.join(',');
  if (_cityCache.has(key)) return _cityCache.get(key);

  // Build query list: qualified names first, then bare city as last resort
  const queries = [...stateHints.map(s => `${city}, ${s}`), city];

  for (const q of queries) {
    try {
      const data = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=us&format=json&limit=1`,
        { headers: { 'Accept-Language': 'en', 'User-Agent': 'ace-crm/1.0' } }
      ).then(r => r.json());
      if (data?.[0]) {
        const ll = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
        _cityCache.set(key, ll);
        return ll;
      }
    } catch (e) { /* try next */ }
  }

  _cityCache.set(key, null);
  return null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function _parseStates(str) {
  return (str || '').split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length === 2 && _STATE_FIPS[s]);
}

function _parseList(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function bcMapInit(containerId, statesStr, countiesStr, citiesStr) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const L = await _ensureLeaflet();
  if (!L) { console.warn('[bc-map] Leaflet failed to load'); return; }

  if (_maps.has(containerId)) {
    _maps.get(containerId).map.remove();
    _maps.delete(containerId);
  }

  const map = L.map(containerId, { zoomControl: true, scrollWheelZoom: true });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  const inst = {
    map,
    stateLayer:  L.layerGroup().addTo(map),
    countyLayer: L.layerGroup(),  // added to map only at zoom>7
    cityLayer:   L.layerGroup().addTo(map),
  };
  _maps.set(containerId, inst);

  map.setView([38, -96], 4);

  map.on('zoomend', () => _applyZoomVisibility(containerId));

  await _renderAll(containerId, statesStr, countiesStr, citiesStr, true);
}

export async function bcMapRefresh(containerId, statesStr, countiesStr, citiesStr) {
  if (!_maps.has(containerId)) {
    return bcMapInit(containerId, statesStr, countiesStr, citiesStr);
  }
  await _renderAll(containerId, statesStr, countiesStr, citiesStr, false);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

async function _renderAll(containerId, statesStr, countiesStr, citiesStr, fitBounds) {
  const inst = _maps.get(containerId);
  if (!inst) return;

  const stateCodes  = _parseStates(statesStr);
  const countyNames = _parseList(countiesStr);
  const cities      = _parseList(citiesStr);

  // Default to NJ when no states set — keeps city geocoding anchored to the primary market
  const stateHints = stateCodes.length ? stateCodes : ['NJ'];

  await Promise.all([
    _renderStateLayer(inst, stateCodes),
    _renderCountyLayer(inst, stateCodes, countyNames),
    _renderCityLayer(inst, cities, stateHints),
  ]);

  _applyZoomVisibility(containerId);

  if (fitBounds) {
    // hasCounties checks actual rendered layers (counties may render even with no explicit stateCodes)
    const renderedCounties = (() => { let n = 0; inst.countyLayer.eachLayer(() => n++); return n > 0; })();
    _smartFit(inst, renderedCounties, cities.length > 0, stateCodes.length > 0);
  }
}

async function _renderStateLayer(inst, stateCodes) {
  const L = window.L;
  inst.stateLayer.clearLayers();
  if (!stateCodes.length) return;

  let geoAll;
  try { geoAll = await _ensureStatesGeoJson(); } catch (e) { return; }

  // us-atlas stores FIPS as a numeric id (e.g. 34 for NJ, 36 for NY)
  const fipsSet = new Set(stateCodes.map(c => parseInt(_STATE_FIPS[c], 10)));

  const filtered = {
    type: 'FeatureCollection',
    features: geoAll.features.filter(f => fipsSet.has(f.id)),
  };

  if (filtered.features.length) {
    L.geoJSON(filtered, { style: () => STATE_STYLE }).addTo(inst.stateLayer);
  }
}

async function _renderCountyLayer(inst, stateCodes, countyNames) {
  const L = window.L;
  inst.countyLayer.clearLayers();
  if (!countyNames.length) return;

  // If no states are set, default to NJ (the primary market)
  const effectiveStates = stateCodes.length ? stateCodes : ['NJ'];

  // TigerWeb NAME field is bare ("Atlantic") but BC chips may have " County" suffix
  // ("Atlantic County"). Strip the suffix so both forms match.
  const countySet = new Set(
    countyNames.map(n => n.toLowerCase().replace(/\s+county\s*$/i, '').trim())
  );

  const results = await Promise.all(
    effectiveStates.map(code => _fetchCountiesForState(_STATE_FIPS[code]))
  );

  for (const geoJson of results) {
    if (!geoJson?.features) continue;
    const matched = {
      type: 'FeatureCollection',
      features: geoJson.features.filter(
        f => countySet.has((f.properties?.NAME || '').toLowerCase())
      ),
    };
    if (matched.features.length) {
      L.geoJSON(matched, { style: () => COUNTY_STYLE }).addTo(inst.countyLayer);
    }
  }
}

async function _renderCityLayer(inst, cities, stateHints = []) {
  const L = window.L;
  inst.cityLayer.clearLayers();
  if (!cities.length) return;

  const positions = await Promise.all(cities.map(c => _geocodeCity(c, stateHints)));

  for (let i = 0; i < cities.length; i++) {
    const ll = positions[i];
    if (!ll) continue;
    L.circleMarker(ll, {
      radius: 7,
      fillColor: '#e53935',
      color: '#b71c1c',
      weight: 1.5,
      opacity: 1,
      fillOpacity: 0.85,
    }).bindTooltip(cities[i], { permanent: false, direction: 'top' })
      .addTo(inst.cityLayer);
  }
}

function _applyZoomVisibility(containerId) {
  const inst = _maps.get(containerId);
  if (!inst) return;
  const { map, stateLayer, countyLayer } = inst;
  const zoom = map.getZoom();
  if (zoom <= 7) {
    if (!map.hasLayer(stateLayer))  map.addLayer(stateLayer);
    if (map.hasLayer(countyLayer))  map.removeLayer(countyLayer);
  } else {
    if (map.hasLayer(stateLayer))   map.removeLayer(stateLayer);
    if (!map.hasLayer(countyLayer)) map.addLayer(countyLayer);
  }
}

// Fit strategy: counties+cities > cities alone > states
// This zooms in as tightly as the data allows.
function _smartFit(inst, hasCounties, hasCities, hasStates) {
  const L = window.L;
  const layers = [];

  if (hasCounties) {
    inst.countyLayer.eachLayer(l => layers.push(l));
  }
  if (hasCities) {
    inst.cityLayer.eachLayer(l => layers.push(l));
  }

  // No county/city data found — fall back to state polygons
  if (!layers.length && hasStates) {
    inst.stateLayer.eachLayer(l => layers.push(l));
  }

  if (!layers.length) return;

  try {
    const group = L.featureGroup(layers);
    const bounds = group.getBounds();
    if (bounds.isValid()) {
      const pad = (hasCounties || hasCities) ? 0.12 : 0.15;
      inst.map.fitBounds(bounds.pad(pad));
      // fitBounds triggers zoomend which calls _applyZoomVisibility,
      // but fire it immediately too so county layer appears right away
      // when the fit zoom lands above 7.
      inst.map.once('moveend', () => {
        const containerId = [..._maps.entries()].find(([, v]) => v === inst)?.[0];
        if (containerId) _applyZoomVisibility(containerId);
      });
    }
  } catch (e) {}
}
