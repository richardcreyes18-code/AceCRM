// geocoding/google.js — Google Geocoding API + bulk geocode UI.
//
// 6 exports: googleGeocodeAddress (one-off geocode), runBulkGeocode (batch
// processor with cancel-able progress UI), cancelBulkGeocode, plus modal
// open/close/start helpers.
//
// _bgGeocodeAll (legacy Nominatim-based background scanner) is intentionally
// NOT migrated — it's already disabled (early `return`) and the boot code
// still calls it via window. Leaving it in legacy avoids any chance of
// re-enabling it accidentally during the move.
//
// External dependencies (legacy script owns these; bare-name access via
// the global env, since they're either `var` (Phase 3+) or function
// declarations):
//   state:    window._store, window.allDeals
//   functions: cleanAddress, _canonicalCounty, buildSidebar
//   modal id targets: 'bulkGeocodeModal', 'bgProgress', 'bgSuccess',
//                     'bgFail', 'bgSkipped', 'bgCurrent', 'bgBar',
//                     'bgConfirmPanel', 'bgRunPanel', etc.

import { _sbPatch } from '../core/supabase.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

// ═══════════════════════════════════════════════════════════════════════
// LEGACY BLOCK BELOW — copied from index.html with `export` added to top-
// level functions and external script-scope refs prefixed with `window.`.
// Internal logic is byte-identical.
// ═══════════════════════════════════════════════════════════════════════

let _bulkGeocodeState = { running:false, cancel:false };

// Geocode via Google Geocoding REST API. Returns {lat, lng, county, zip, state, city, formatted, ok}.
// Requires a Google Places/Geocoding API key saved in settings.
export async function googleGeocodeAddress(addr){
  const key = window._store.get('google_places_key');
  if(!key) return { ok:false, error:'No Google API key configured. Add one in Settings.' };
  if(!addr) return { ok:false, error:'Empty address' };

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${key}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if(data.status !== 'OK' || !data.results || !data.results.length){
      return { ok:false, error:data.status||'NO_RESULTS', errorMsg:data.error_message };
    }
    const r = data.results[0];
    const loc = r.geometry && r.geometry.location;
    if(!loc) return { ok:false, error:'NO_GEOMETRY' };
    const comp = name => {
      const c = r.address_components.find(x => x.types.includes(name));
      return c ? c.long_name : '';
    };
    const compShort = name => {
      const c = r.address_components.find(x => x.types.includes(name));
      return c ? c.short_name : '';
    };
    return {
      ok: true,
      lat: loc.lat,
      lng: loc.lng,
      formatted: r.formatted_address || '',
      county: comp('administrative_area_level_2') || '',
      city: comp('locality') || comp('sublocality') || comp('neighborhood') || '',
      state: compShort('administrative_area_level_1') || '',
      zip: comp('postal_code') || '',
      // v113.43: surface Google's confidence flags so callers can decide
      // whether to trust the canonical formatted_address.
      partial_match: r.partial_match === true,
      location_type: (r.geometry && r.geometry.location_type) || null,
    };
  } catch(e) {
    return { ok:false, error:e.message||'FETCH_FAILED' };
  }
}

// Bulk cleanup + geocode driver. Processes deals in small batches with a live UI.

export async function runBulkGeocode(options){
  options = options || {};
  const onlyMissing = !!options.onlyMissing;    // skip deals that already have lat/lon
  const dryRun = !!options.dryRun;               // just clean, don't geocode or save

  if(_bulkGeocodeState.running) return;
  _bulkGeocodeState = { running:true, cancel:false };

  const key = window._store.get('google_places_key');
  if(!dryRun && !key){
    alert('No Google API key found. Add one in Settings → Address Autocomplete first.');
    _bulkGeocodeState.running = false;
    return;
  }

  // Filter the target set
  const target = window.allDeals.filter(d => {
    if(!d['Address']) return false;
    if(onlyMissing){
      const lat = Number(d['Latitude']);
      if(lat && !isNaN(lat) && lat !== 0) return false;
    }
    return true;
  });

  // Open the progress modal
  const modal = document.getElementById('bulkGeocodeModal');
  if(modal) modal.style.display = 'flex';
  const update = (progress, success, fail, skipped, currentAddr, currentClean) => {
    const p = document.getElementById('bgProgress'); if(p) p.textContent = progress;
    const s = document.getElementById('bgSuccess');  if(s) s.textContent = success;
    const f = document.getElementById('bgFail');     if(f) f.textContent = fail;
    const sk= document.getElementById('bgSkipped');  if(sk) sk.textContent = skipped;
    const cur = document.getElementById('bgCurrent');
    if(cur) cur.innerHTML = currentAddr ? `<div style="font-size:11px;color:#64748b;">Processing:</div><div style="font-size:12px;color:#0f172a;margin-top:2px;">${currentAddr}</div>${currentClean ? `<div style="font-size:11px;color:#16a34a;margin-top:2px;">→ ${currentClean}</div>` : ''}` : '';
    const bar = document.getElementById('bgBar');
    if(bar && target.length){
      const pct = ((success + fail + skipped) / target.length) * 100;
      bar.style.width = pct.toFixed(1) + '%';
    }
  };

  let success = 0, fail = 0, skipped = 0;
  const failedList = [];
  update(`0 / ${target.length}`, 0, 0, 0);

  // Google has a limit ~50 QPS on the free tier. We stay well under at ~10 QPS
  // (batch of 5 in parallel, 500ms between batches).
  const BATCH = 5;
  const DELAY_MS = 500;

  for(let i = 0; i < target.length; i += BATCH){
    if(_bulkGeocodeState.cancel) break;
    const slice = target.slice(i, i + BATCH);

    await Promise.all(slice.map(async (d) => {
      const originalAddr = d['Address'];
      const cleaned = cleanAddress(originalAddr);

      if(!cleaned){ skipped++; return; }

      if(dryRun){
        // Just save the cleaned address, no geocoding
        try {
          await _sbPatch(SB_TABLES.properties, d.id, { address: cleaned });
          d['Address'] = cleaned;
          success++;
        } catch(e){ fail++; failedList.push({addr:originalAddr, err:e.message}); }
        return;
      }

      const geo = await googleGeocodeAddress(cleaned);
      if(!geo.ok){
        fail++;
        failedList.push({addr:originalAddr, cleaned, err:geo.error+(geo.errorMsg?' — '+geo.errorMsg:'')});
        return;
      }

      // Build the final address: "street, city, state zip"
      const finalAddr = geo.formatted || cleaned;

      // Clean county name (Google returns "Morris County" already)
      // v113.27: canonicalize against _appLists.counties so we never write
      // "Monmouth County" when the canonical form is "Monmouth".
      const countyRaw = geo.county || '';
      const county = countyRaw ? _canonicalCounty(countyRaw) : '';

      try {
        await _sbPatch(SB_TABLES.properties, d.id, {
          address: finalAddr,
          latitude: geo.lat,
          longitude: geo.lng,
          simple_county: county,
        });
        // Update in-memory deal so the UI reflects it without reloading
        d['Address'] = finalAddr;
        d['Latitude'] = geo.lat;
        d['Longitude'] = geo.lng;
        if(county) d['Simple County'] = county;
        success++;
      } catch(e){
        fail++;
        failedList.push({addr:originalAddr, cleaned, err:e.message});
      }
    }));

    update(`${success + fail + skipped} / ${target.length}`, success, fail, skipped,
      slice[slice.length-1] ? slice[slice.length-1]['Address'] : '',
      slice[slice.length-1] ? cleanAddress(slice[slice.length-1]['Address']||'') : '');

    if(i + BATCH < target.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  _bulkGeocodeState.running = false;

  // Final report
  const btn = document.getElementById('bgCloseBtn');
  if(btn){ btn.textContent = 'Close'; btn.disabled = false; }
  const cancelBtn = document.getElementById('bgCancelBtn');
  if(cancelBtn) cancelBtn.style.display = 'none';
  update(`✓ Done — ${success + fail + skipped} / ${target.length}`, success, fail, skipped, '');

  // Save failures to a debug object so the user can inspect in console
  window._bulkGeocodeFailures = failedList;
  const failDetail = document.getElementById('bgFailDetail');
  if(failDetail && failedList.length){
    failDetail.style.display = 'block';
    failDetail.innerHTML = `<div style="margin-top:10px;font-size:11px;color:#64748b;"><strong>${failedList.length} failures</strong> saved to <code>window._bulkGeocodeFailures</code>. First 5:</div>` +
      failedList.slice(0,5).map(f => `<div style="font-size:10px;color:#b91c1c;margin-top:2px;">• ${f.addr.substring(0,50)}… — ${f.err}</div>`).join('');
  }

  // Rebuild sidebar + pipeline if they're open
  if(typeof buildSidebar === 'function') buildSidebar(document.getElementById('sideSearch')?.value || '');
}

export function cancelBulkGeocode(){
  _bulkGeocodeState.cancel = true;
  const btn = document.getElementById('bgCancelBtn');
  if(btn){ btn.textContent = 'Stopping…'; btn.disabled = true; }
}

export function openBulkGeocodeModal(){
  const modal = document.getElementById('bulkGeocodeModal');
  if(!modal) return;
  // Reset the UI
  const btn = document.getElementById('bgCloseBtn');
  if(btn){ btn.textContent = 'Cancel'; btn.disabled = false; }
  const cancelBtn = document.getElementById('bgCancelBtn');
  if(cancelBtn) cancelBtn.style.display = '';
  document.getElementById('bgProgress').textContent = 'Ready';
  document.getElementById('bgSuccess').textContent = '0';
  document.getElementById('bgFail').textContent = '0';
  document.getElementById('bgSkipped').textContent = '0';
  document.getElementById('bgBar').style.width = '0%';
  document.getElementById('bgCurrent').innerHTML = '';
  const fd = document.getElementById('bgFailDetail');
  if(fd){ fd.style.display = 'none'; fd.innerHTML = ''; }
  document.getElementById('bgConfirmPanel').style.display = 'block';
  document.getElementById('bgRunPanel').style.display = 'none';
  modal.style.display = 'flex';
}

export function closeBulkGeocodeModal(){
  if(_bulkGeocodeState.running){
    if(!confirm('Geocoding is still running. Are you sure you want to close? Already-saved addresses will be kept.')) return;
    _bulkGeocodeState.cancel = true;
  }
  const modal = document.getElementById('bulkGeocodeModal');
  if(modal) modal.style.display = 'none';
}

export function startBulkGeocode(onlyMissing){
  document.getElementById('bgConfirmPanel').style.display = 'none';
  document.getElementById('bgRunPanel').style.display = 'block';
  const cancelBtn = document.getElementById('bgCancelBtn');
  if(cancelBtn) cancelBtn.style.display = '';
  const closeBtn = document.getElementById('bgCloseBtn');
  if(closeBtn) closeBtn.textContent = 'Close';
  runBulkGeocode({ onlyMissing });
}
