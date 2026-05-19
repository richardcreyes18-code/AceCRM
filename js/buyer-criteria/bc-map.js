// js/buyer-criteria/bc-map.js — Interactive location map for BC expanded view.
// County geometry from us-atlas (same CDN as states) + embedded FIPS lookup.
// No external API calls — zero CORS / rate-limit / URL-encoding issues.

const _maps       = new Map(); // containerId → { map, stateLayer, countyLayer, cityLayer }
const _cityCache  = new Map(); // city string → [lat, lng] | null

let _statesGeoJson  = null; // us-atlas states feature collection
let _countiesGeoJson = null; // us-atlas counties feature collection

const STATE_STYLE  = { color: '#b8860b', weight: 1.5, fillColor: '#ffd700', fillOpacity: 0.30 };
const COUNTY_STYLE = { color: '#2563eb', weight: 2,   fillColor: '#93c5fd', fillOpacity: 0.45 };

const _STATE_FIPS = {
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',FL:'12',GA:'13',
  HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',
  MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',
  NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',
  SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56',DC:'11',
};

// county name (lower) → 5-digit FIPS string, for states relevant to this CRM
const _COUNTY_FIPS = {
  NJ:{atlantic:'34001',bergen:'34003',burlington:'34005',camden:'34007','cape may':'34009',
      cumberland:'34011',essex:'34013',gloucester:'34015',hudson:'34017',hunterdon:'34019',
      mercer:'34021',middlesex:'34023',monmouth:'34025',morris:'34027',ocean:'34029',
      passaic:'34031',salem:'34033',somerset:'34035',sussex:'34037',union:'34039',warren:'34041'},
  NY:{albany:'36001',allegany:'36003',bronx:'36005',broome:'36007',cattaraugus:'36009',
      cayuga:'36011',chautauqua:'36013',chemung:'36015',chenango:'36017',clinton:'36019',
      columbia:'36021',cortland:'36023',delaware:'36025',dutchess:'36027',erie:'36029',
      essex:'36031',franklin:'36033',fulton:'36035',genesee:'36037',greene:'36039',
      hamilton:'36041',herkimer:'36043',jefferson:'36045',kings:'36047',lewis:'36049',
      livingston:'36051',madison:'36053',monroe:'36055',montgomery:'36057',nassau:'36059',
      'new york':'36061',niagara:'36063',oneida:'36065',onondaga:'36067',ontario:'36069',
      orange:'36071',orleans:'36073',oswego:'36075',otsego:'36077',putnam:'36079',
      queens:'36081',rensselaer:'36083',richmond:'36085',rockland:'36087',
      'st. lawrence':'36089',saratoga:'36091',schenectady:'36093',schoharie:'36095',
      schuyler:'36097',seneca:'36099',steuben:'36101',suffolk:'36103',sullivan:'36105',
      tioga:'36107',tompkins:'36109',ulster:'36111',warren:'36113',washington:'36115',
      wayne:'36117',westchester:'36119',wyoming:'36121',yates:'36123'},
  PA:{adams:'42001',allegheny:'42003',armstrong:'42005',beaver:'42007',bedford:'42009',
      berks:'42011',blair:'42013',bradford:'42015',bucks:'42017',butler:'42019',
      cambria:'42021',cameron:'42023',carbon:'42025',centre:'42027',chester:'42029',
      clarion:'42031',clearfield:'42033',clinton:'42035',columbia:'42037',crawford:'42039',
      cumberland:'42041',dauphin:'42043',delaware:'42045',elk:'42047',erie:'42049',
      fayette:'42051',forest:'42053',franklin:'42055',fulton:'42057',greene:'42059',
      huntingdon:'42061',indiana:'42063',jefferson:'42065',juniata:'42067',
      lackawanna:'42069',lancaster:'42071',lawrence:'42073',lebanon:'42075',
      lehigh:'42077',luzerne:'42079',lycoming:'42081',mckean:'42083',mercer:'42085',
      mifflin:'42087',monroe:'42089',montgomery:'42091',montour:'42093',
      northampton:'42095',northumberland:'42097',perry:'42099',philadelphia:'42101',
      pike:'42103',potter:'42105',schuylkill:'42107',snyder:'42109',somerset:'42111',
      sullivan:'42113',susquehanna:'42115',tioga:'42117',union:'42119',venango:'42121',
      warren:'42123',washington:'42125',wayne:'42127',westmoreland:'42129',
      wyoming:'42131',york:'42133'},
  CT:{fairfield:'09001',hartford:'09003',litchfield:'09005',middlesex:'09007',
      'new haven':'09009','new london':'09011',tolland:'09013',windham:'09015'},
  DE:{kent:'10001','new castle':'10003',sussex:'10005'},
  MD:{allegany:'24001','anne arundel':'24003',baltimore:'24005',calvert:'24009',
      caroline:'24011',carroll:'24013',cecil:'24015',charles:'24017',dorchester:'24019',
      frederick:'24021',garrett:'24023',harford:'24025',howard:'24027',kent:'24029',
      montgomery:'24031',"prince george's":'24033',"queen anne's":'24035',
      "st. mary's":'24037',somerset:'24039',talbot:'24041',washington:'24043',
      wicomico:'24045',worcester:'24047','baltimore city':'24510'},
  MA:{barnstable:'25001',berkshire:'25003',bristol:'25005',dukes:'25007',essex:'25009',
      franklin:'25011',hampden:'25013',hampshire:'25015',middlesex:'25017',
      nantucket:'25019',norfolk:'25021',plymouth:'25023',suffolk:'25025',worcester:'25027'},
  VA:{accomack:'51001',albemarle:'51003',alleghany:'51005',amelia:'51007',amherst:'51009',
      appomattox:'51011',arlington:'51013',augusta:'51015',bath:'51017',bedford:'51019',
      bland:'51021',botetourt:'51023',brunswick:'51025',buchanan:'51027',
      buckingham:'51029',campbell:'51031',caroline:'51033',carroll:'51035',
      charlotte:'51037',chesterfield:'51041',clarke:'51043',craig:'51045',
      culpeper:'51047',cumberland:'51049',dickenson:'51051',dinwiddie:'51053',
      essex:'51057',fairfax:'51059',fauquier:'51061',floyd:'51063',fluvanna:'51065',
      franklin:'51067',frederick:'51069',giles:'51071',gloucester:'51073',
      goochland:'51075',grayson:'51077',greene:'51079',greensville:'51081',
      halifax:'51083',hanover:'51085',henrico:'51087',henry:'51089',highland:'51091',
      'isle of wight':'51093','james city':'51095','king george':'51099',
      'king william':'51101',lancaster:'51103',lee:'51105',loudoun:'51107',
      louisa:'51109',lunenburg:'51111',madison:'51113',mathews:'51115',
      mecklenburg:'51117',middlesex:'51119',montgomery:'51121',nelson:'51125',
      'new kent':'51127',northampton:'51131',northumberland:'51133',nottoway:'51135',
      orange:'51137',page:'51139',patrick:'51141',pittsylvania:'51143',
      powhatan:'51145','prince edward':'51147','prince george':'51149',
      'prince william':'51153',pulaski:'51155',rappahannock:'51157',richmond:'51159',
      roanoke:'51161',rockbridge:'51163',rockingham:'51165',russell:'51167',
      scott:'51169',shenandoah:'51171',smyth:'51173',southampton:'51175',
      spotsylvania:'51177',stafford:'51179',surry:'51181',sussex:'51183',
      tazewell:'51185',warren:'51187',washington:'51191',westmoreland:'51193',
      wise:'51195',wythe:'51197',york:'51199'},
};

// ── Lazy loaders ──────────────────────────────────────────────────────────────

async function _ensureLeaflet() {
  if (window.L) return window.L;
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
  await _ensureTopojson();
  const topo = await fetch('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json').then(r => r.json());
  _statesGeoJson = window.topojson.feature(topo, topo.objects.states);
  return _statesGeoJson;
}

async function _ensureCountiesGeoJson() {
  if (_countiesGeoJson) return _countiesGeoJson;
  await _ensureTopojson();
  const topo = await fetch('https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json').then(r => r.json());
  _countiesGeoJson = window.topojson.feature(topo, topo.objects.counties);
  return _countiesGeoJson;
}

// ── City geocoder ─────────────────────────────────────────────────────────────

async function _geocodeCity(cityStr, stateHints = []) {
  const key = cityStr.trim().toLowerCase() + '|' + stateHints.join(',');
  if (_cityCache.has(key)) return _cityCache.get(key);
  const queries = [...stateHints.map(s => `${cityStr.trim()}, ${s}`), cityStr.trim()];
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
    } catch (_) {}
  }
  _cityCache.set(key, null);
  return null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function _parseStates(str) {
  return (str || '').split(',').map(s => s.trim().toUpperCase()).filter(s => s.length === 2 && _STATE_FIPS[s]);
}

function _parseList(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function bcMapInit(containerId, statesStr, countiesStr, citiesStr) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const L = await _ensureLeaflet();
  if (!L) return;

  if (_maps.has(containerId)) { _maps.get(containerId).map.remove(); _maps.delete(containerId); }

  const map = L.map(containerId, { zoomControl: true, scrollWheelZoom: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18,
  }).addTo(map);
  // City markers always on top of county polygons regardless of render order
  map.createPane('citiesPane').style.zIndex = 450;

  const inst = {
    map,
    stateLayer:  L.layerGroup().addTo(map),
    countyLayer: L.layerGroup().addTo(map), // always on map — visibility toggled via zoom
    cityLayer:   L.layerGroup().addTo(map),
  };
  _maps.set(containerId, inst);
  map.setView([38, -96], 4);
  map.on('zoomend', () => _applyZoomVisibility(containerId));

  await _renderAll(containerId, statesStr, countiesStr, citiesStr, true);
}

export async function bcMapRefresh(containerId, statesStr, countiesStr, citiesStr) {
  if (!_maps.has(containerId)) return bcMapInit(containerId, statesStr, countiesStr, citiesStr);
  await _renderAll(containerId, statesStr, countiesStr, citiesStr, false);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

async function _renderAll(containerId, statesStr, countiesStr, citiesStr, fitBounds) {
  const inst = _maps.get(containerId);
  if (!inst) return;
  const stateCodes  = _parseStates(statesStr);
  const countyNames = _parseList(countiesStr);
  const cities      = _parseList(citiesStr);
  const stateHints  = stateCodes.length ? stateCodes : ['NJ'];

  await Promise.all([
    _renderStateLayer(inst, stateCodes),
    _renderCountyLayer(inst, stateCodes, countyNames),
    _renderCityLayer(inst, cities, stateHints),
  ]);

  _applyZoomVisibility(containerId);

  if (fitBounds) {
    const hasCounties = (() => { let n = 0; inst.countyLayer.eachLayer(() => n++); return n > 0; })();
    _smartFit(inst, hasCounties, cities.length > 0, stateCodes.length > 0);
  }
}

async function _renderStateLayer(inst, stateCodes) {
  const L = window.L;
  inst.stateLayer.clearLayers();
  if (!stateCodes.length) return;
  try {
    const geoAll = await _ensureStatesGeoJson();
    const fipsSet = new Set(stateCodes.map(c => parseInt(_STATE_FIPS[c], 10)));
    const filtered = { type:'FeatureCollection', features: geoAll.features.filter(f => fipsSet.has(f.id)) };
    if (filtered.features.length) L.geoJSON(filtered, { style: () => STATE_STYLE }).addTo(inst.stateLayer);
  } catch (e) { console.warn('[bc-map] state layer error', e.message); }
}

async function _renderCountyLayer(inst, stateCodes, countyNames) {
  const L = window.L;
  inst.countyLayer.clearLayers();
  if (!countyNames.length) return;

  const effectiveStates = stateCodes.length ? stateCodes : ['NJ'];

  // Build set of target FIPS codes by matching county names against lookup table
  const targetFips = new Set();
  for (const stateAbbr of effectiveStates) {
    const fipsMap = _COUNTY_FIPS[stateAbbr];
    if (!fipsMap) continue;
    for (const rawName of countyNames) {
      const key = rawName.toLowerCase().replace(/\s+county\s*$/i, '').trim();
      if (fipsMap[key]) targetFips.add(fipsMap[key]);
    }
  }

  if (!targetFips.size) {
    console.warn('[bc-map] no FIPS matches for counties:', countyNames, 'in states:', effectiveStates);
    return;
  }

  try {
    const allCounties = await _ensureCountiesGeoJson();
    // us-atlas feature ids are numeric; FIPS strings need zero-padding already handled above
    const matched = {
      type: 'FeatureCollection',
      features: allCounties.features.filter(f => targetFips.has(String(f.id).padStart(5, '0'))),
    };
    if (matched.features.length) {
      L.geoJSON(matched, { style: () => COUNTY_STYLE }).addTo(inst.countyLayer);
    } else {
      console.warn('[bc-map] zero features matched from us-atlas for FIPS:', [...targetFips]);
    }
  } catch (e) {
    console.error('[bc-map] county render error', e.message);
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
    L.circleMarker(ll, { radius:7, fillColor:'#e53935', color:'#b71c1c', weight:1.5, opacity:1, fillOpacity:0.85, pane:'citiesPane' })
      .bindTooltip(cities[i], { permanent:false, direction:'top' })
      .addTo(inst.cityLayer);
  }
}

// Counties always visible; states shown only at zoom ≤ 6
function _applyZoomVisibility(containerId) {
  const inst = _maps.get(containerId);
  if (!inst) return;
  const { map, stateLayer } = inst;
  const zoom = map.getZoom();
  if (zoom <= 6) { if (!map.hasLayer(stateLayer)) map.addLayer(stateLayer); }
  else           { if (map.hasLayer(stateLayer))  map.removeLayer(stateLayer); }
}

function _smartFit(inst, hasCounties, hasCities, hasStates) {
  const L = window.L;
  const layers = [];
  if (hasCounties) inst.countyLayer.eachLayer(l => layers.push(l));
  if (hasCities)   inst.cityLayer.eachLayer(l => layers.push(l));
  if (!layers.length && hasStates) inst.stateLayer.eachLayer(l => layers.push(l));
  if (!layers.length) return;
  try {
    const bounds = L.featureGroup(layers).getBounds();
    if (bounds.isValid()) {
      inst.map.fitBounds(bounds.pad(0.15));
      inst.map.once('moveend', () => {
        const cid = [..._maps.entries()].find(([, v]) => v === inst)?.[0];
        if (cid) _applyZoomVisibility(cid);
      });
    }
  } catch (_) {}
}
