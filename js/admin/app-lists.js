// admin/app-lists.js — admin curated lists (asset types, counties,
// preferred cities, regions). Powers the Settings → App Lists tab and
// the various filter dropdowns + add/rename/delete flows.
//
// Phase 5 commit 1 of 4. 33 exports. Reads from window._appLists (the
// canonical curated cache, already `var` from v261's _canonicalCounty
// migration). Writes via _sbGet/Post/Patch/Delete + _sbRpc.
//
// External dependencies on window.* (legacy still owns these):
//   state:    window._appLists, window._NJ_MUNICIPALITIES (legacy `const`
//             → `var` in this commit), window.allDeals, window._currentUser,
//             window._companyDirectory
//   functions: isSupabase (function decl), window._canonicalCounty
//             (from schemas/county-map.js, attached via main.js)

import { _sbGet, _sbPost, _sbPatch, _sbDelete, _sbRpc } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

export function _appListMeta(listKey, value){
  return window._appListsMeta[listKey + '::' + value] || {};
}

export async function _loadAppLists(){
  if(!isSupabase()) return;
  try{
    const rows = await _sbGet(SB_TABLES.appLists,
      'select=list_key,value,sort_order,metadata&is_active=eq.true&order=sort_order.asc,value.asc');
    if(!Array.isArray(rows)) return;
    const next = {
      asset_types: [], preferred_cities: [],
      states: [], regions: [], counties: [],
    };
    // Wipe and rebuild metadata map in one pass.
    for(const k in window._appListsMeta) delete window._appListsMeta[k];
    for(const r of rows){
      const bucket = next[r.list_key];
      if(bucket) bucket.push(r.value);
      if(r.metadata && typeof r.metadata === 'object'){
        window._appListsMeta[r.list_key + '::' + r.value] = r.metadata;
      }
    }
    window._appLists.asset_types      = next.asset_types;
    window._appLists.preferred_cities = next.preferred_cities;
    window._appLists.states           = next.states;
    window._appLists.regions          = next.regions;
    window._appLists.counties         = next.counties;
    // v102.35: rebuild ASSET_SUBTYPES from the curated list. This is what
    // wires Settings edits through to the lead form / deal-card editor /
    // Buyer Criteria editor — they all read the same global name.
    _rebuildAssetSubtypes();
    // v113.26: first-run seed. If states/regions/counties came back empty,
    // populate from the hardcoded NJ constants + standard US state list and
    // re-fetch so the rest of the app starts with real data.
    await _appListsMaybeSeed();
  }catch(e){
    console.warn('[v102.34] _loadAppLists failed:', e.message);
  }
}

// v113.26: idempotent seed for the three new app lists (states / regions /
// counties). Runs once when those lists are empty in the DB. The values
// come from the existing in-app constants so the seed is just a one-time
// migration of in-code data into the editable settings table.
//
// Source of truth after seeding:
//   - window._appLists.states    ← rows for every US state (+DC), default NJ flagged
//   - window._appLists.regions   ← All NJ / North NJ / Central NJ / South NJ / Tri-State
//   - window._appLists.counties  ← every NJ county, metadata.regions = ['North NJ'] etc.
//
// Schema (per ace_app_lists):
//   list_key: 'states' | 'regions' | 'counties'
//   value:    the canonical name (state code, region label, bare county name)
//   metadata: free-form JSON; see _appListsBuildSeed for shapes
//
// If a future deploy adds a new region/state/county, this function does
// NOT re-run — admins add them via Settings > App Lists.
export async function _appListsMaybeSeed(){
  const needs = [];
  if(!window._appLists.states.length)   needs.push('states');
  if(!window._appLists.regions.length)  needs.push('regions');
  if(!window._appLists.counties.length) needs.push('counties');
  if(!needs.length) return;
  const seed = _appListsBuildSeed();
  let inserted = 0;
  for(const listKey of needs){
    const rows = seed[listKey] || [];
    for(let i = 0; i < rows.length; i++){
      const r = rows[i];
      try{
        // Use the upsert primitive so re-running this against a partially
        // populated DB (or one with tombstoned rows) reactivates instead
        // of erroring out on a unique violation.
        await _appListUpsert(listKey, r.value, { sortOrder: i, metadata: r.metadata, silent: true });
        inserted++;
      }catch(e){
        // Most likely cause: row already active (race with another tab's
        // seed). Safe to skip.
        if(!/already exists/i.test(e.message||'')) {
          console.warn('[v113.26] seed failed for', listKey, r.value, e.message);
        }
      }
    }
  }
  if(inserted){
    console.log('[v113.26] seeded ace_app_lists with', inserted, 'rows across', needs.join(', '));
    // Re-fetch so the cache reflects what we just wrote.
    try{
      const rows = await _sbGet(SB_TABLES.appLists,
        'select=list_key,value,sort_order,metadata&is_active=eq.true&order=sort_order.asc,value.asc');
      if(Array.isArray(rows)){
        const next = { states: [], regions: [], counties: [] };
        for(const r of rows){
          const bucket = next[r.list_key];
          if(bucket) bucket.push(r.value);
          if(r.metadata && typeof r.metadata === 'object'){
            window._appListsMeta[r.list_key + '::' + r.value] = r.metadata;
          }
        }
        window._appLists.states   = next.states;
        window._appLists.regions  = next.regions;
        window._appLists.counties = next.counties;
      }
    }catch(e){ console.warn('[v113.26] post-seed reload failed:', e.message); }
  }
}

// v113.26: build the seed payload. Pulled out so it's easy to read and
// audit what gets written on the first deploy. Order in each list defines
// the default sort_order.
export function _appListsBuildSeed(){
  // 50 US states + DC. NJ flagged as the broker's default home state.
  const STATES = [
    ['NJ','New Jersey',true],['NY','New York'],['PA','Pennsylvania'],['CT','Connecticut'],
    ['DE','Delaware'],['MD','Maryland'],['VA','Virginia'],['MA','Massachusetts'],
    ['RI','Rhode Island'],['NH','New Hampshire'],['ME','Maine'],['VT','Vermont'],
    ['FL','Florida'],['GA','Georgia'],['NC','North Carolina'],['SC','South Carolina'],
    ['TN','Tennessee'],['KY','Kentucky'],['WV','West Virginia'],['AL','Alabama'],
    ['MS','Mississippi'],['LA','Louisiana'],['AR','Arkansas'],['OK','Oklahoma'],
    ['TX','Texas'],['OH','Ohio'],['MI','Michigan'],['IN','Indiana'],['IL','Illinois'],
    ['WI','Wisconsin'],['MN','Minnesota'],['IA','Iowa'],['MO','Missouri'],
    ['ND','North Dakota'],['SD','South Dakota'],['NE','Nebraska'],['KS','Kansas'],
    ['CO','Colorado'],['NM','New Mexico'],['AZ','Arizona'],['UT','Utah'],
    ['NV','Nevada'],['CA','California'],['OR','Oregon'],['WA','Washington'],
    ['ID','Idaho'],['MT','Montana'],['WY','Wyoming'],['AK','Alaska'],['HI','Hawaii'],
    ['DC','District of Columbia'],
  ];
  const states = STATES.map(([code, name, isDefault]) => ({
    value: code,
    metadata: isDefault ? { name, default: true } : { name },
  }));

  // NJ regions + Tri-State. "All NJ" is a special selector that adds every
  // county in NJ; "Tri-State" adds every county in NJ + flags NY/PA states.
  const regions = [
    { value: 'All NJ',     metadata: { state: 'NJ', special: 'all_state' } },
    { value: 'North NJ',   metadata: { state: 'NJ' } },
    { value: 'Central NJ', metadata: { state: 'NJ' } },
    { value: 'South NJ',   metadata: { state: 'NJ' } },
    { value: 'Tri-State',  metadata: { special: 'multi_state', states: ['NJ','NY','PA'] } },
  ];

  // NJ counties with their region tags. Mirrors NJ_NORTH_COUNTIES /
  // NJ_CENTRAL_COUNTIES / NJ_SOUTH_COUNTIES + Ricky's house rule that
  // Ocean belongs to BOTH Central and South, and Hunterdon to BOTH North
  // and Central (per _countyRegions at line ~17664).
  const tagFor = bare => {
    const r = [];
    if(typeof NJ_NORTH_COUNTIES !== 'undefined' && NJ_NORTH_COUNTIES.includes(bare))     r.push('North NJ');
    if(typeof NJ_CENTRAL_COUNTIES !== 'undefined' && NJ_CENTRAL_COUNTIES.includes(bare)) r.push('Central NJ');
    if(typeof NJ_SOUTH_COUNTIES !== 'undefined' && NJ_SOUTH_COUNTIES.includes(bare))     r.push('South NJ');
    if(bare === 'Ocean'     && !r.includes('South NJ'))   r.push('South NJ');
    if(bare === 'Hunterdon' && !r.includes('Central NJ')) r.push('Central NJ');
    return r;
  };
  const njCounties = (typeof NJ_COUNTIES !== 'undefined' ? NJ_COUNTIES : []);
  const counties = njCounties.map(bare => ({
    value: bare,
    metadata: { state: 'NJ', regions: tagFor(bare) },
  }));

  return { states, regions, counties };
}

// v102.35: derive ASSET_SUBTYPES from window._appLists.asset_types. Each row is
// either a bare category ("Multifamily") or a "Category: Subtype" combo
// ("Multifamily: Garden/Low Rise"). Bare-category rows seed empty subtype
// arrays so categories with no subtypes still appear in the lead form's
// left column. The combo rows split on the FIRST ": " only — subtype names
// containing colons (none currently) would still parse correctly.
//
// Order preservation: ace_app_lists is loaded with order=sort_order.asc,
// so iterating window._appLists.asset_types in order produces categories in their
// curated display order, with subtypes following each parent.
export function _rebuildAssetSubtypes(){
  const list = (window._appLists.asset_types || []);
  if(!list.length) return; // keep the hardcoded fallback if DB load gave nothing
  const next = {};
  for(const v of list){
    const idx = v.indexOf(': ');
    if(idx === -1){
      // Bare category. Seed empty array if not yet present.
      if(!(v in next)) next[v] = [];
    }else{
      const cat = v.slice(0, idx);
      const sub = v.slice(idx + 2);
      if(!(cat in next)) next[cat] = [];
      next[cat].push(sub);
    }
  }
  ASSET_SUBTYPES = next;
}

// ─── App List editor helpers (Settings > App Lists) ───────────────────
//
// v102.35: asset_types is rendered as a collapsible tree (categories with
// nested subtypes), preferred_cities stays as a flat list. Both share the
// same _appListAdd/_appListRename/_appListDelete primitives, with extra
// tree-specific behavior layered on for asset_types:
//   - Validation: ":" not allowed in category names
//   - Validation: subtypes can only be added under an existing category
//   - Block delete: a category with active subtypes cannot be deleted
//   - Reactivate-over-insert: the v102.34 tombstone semantics still apply
//
// IMPORTANT (v102.35 vs v102.36): renaming a category in this version only
// updates the row itself — it does NOT cascade to "Category: X" subtype
// rows or to the crm_asset_classification on existing deals. Cascading
// rename ships in v102.36 alongside the drift-normalization migration so
// the dangerous mutation lives in its own ship and can be rolled back
// independently. The UI button shows a tooltip explaining this.

// DOM id helper — asset_types -> AssetTypes, preferred_cities -> PreferredCities
export function _appListDomKey(listKey){
  return listKey.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

// Set the status message under the App Lists section.
export function _appListStatus(msg, isError){
  const el = document.getElementById('alStatus');
  if(!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#dc2626' : '#64748b';
  if(msg && !isError){
    setTimeout(() => { if(el.textContent === msg) el.textContent = ''; }, 2500);
  }
}

// Per-category collapse state for the asset_types tree. Default: all
// categories collapsed on first render so the panel doesn't explode to
// 140 rows immediately. Persisted only in-memory (resets on page reload).
const _appListExpanded = {};

export function _appListToggleCategory(cat){
  _appListExpanded[cat] = !_appListExpanded[cat];
  _appListRender('asset_types');
}

// v360: per-list search filter state. Currently consumed by preferred_cities
// but generic enough to wire to any future flat list.
const _appListSearch = {};
export function _appListSetSearch(listKey, val){
  _appListSearch[listKey] = String(val || '');
  _appListRender(listKey);
  // Restore focus to the search input after the re-render (innerHTML on the
  // list only — the search input above it survives, but the focus may have
  // moved if the user clicked elsewhere mid-typing).
  const inp = document.getElementById('alSearch' + _appListDomKey(listKey));
  if(inp && document.activeElement !== inp){
    const wasFocused = inp.getAttribute('data-was-focused') === '1';
    if(wasFocused) inp.focus();
  }
}
if(typeof window !== 'undefined') window._appListSetSearch = _appListSetSearch;

// Group flat asset_types rows into a {category: [subtypes]} map. Bare
// category rows seed an empty subtype array so categories with no subtypes
// still render. Categories appear in the order they first appear in the
// flat list (which is sort_order from the DB).
export function _appListGroupAssetTypes(){
  const list = (window._appLists.asset_types || []);
  const groups = []; // [{cat, subs}] preserving order
  const map = {};
  for(const v of list){
    const idx = v.indexOf(': ');
    let cat, sub;
    if(idx === -1){ cat = v; sub = null; }
    else { cat = v.slice(0, idx); sub = v.slice(idx + 2); }
    if(!(cat in map)){
      map[cat] = { cat, subs: [] };
      groups.push(map[cat]);
    }
    if(sub) map[cat].subs.push(sub);
  }
  return groups;
}

// HTML-escape a string for embedding in attributes / text.
export function _appListEsc(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// JS-string-escape for use inside onclick="..._appListFoo('val')..." attrs.
// Wraps the result in single quotes via the calling template — this just
// escapes the contents.
export function _appListJsEsc(s){
  return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

// Re-render one subsection from window._appLists cache.
export function _appListRender(listKey){
  const domKey = _appListDomKey(listKey);
  const listEl  = document.getElementById('alList'  + domKey);
  const countEl = document.getElementById('alCount' + domKey);
  if(!listEl) return;

  // v113.26: states / regions / counties — flat lists with optional metadata
  // chips. Counties show their region tags + state; regions show their state
  // and special flag; states show their long name.
  if(listKey === 'states' || listKey === 'regions' || listKey === 'counties'){
    const values = window._appLists[listKey] || [];
    if(countEl) countEl.textContent = values.length + ' item' + (values.length === 1 ? '' : 's');
    if(!values.length){
      listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#94a3b8;font-size:11px;">No items yet — add one above.</div>';
      return;
    }
    listEl.innerHTML = values.map(v => {
      const safe = _appListEsc(v);
      const attr = _appListJsEsc(v);
      const meta = _appListMeta(listKey, v);
      let chips = '';
      if(listKey === 'states' && meta.name){
        chips += `<span style="background:#f1f5f9;color:#475569;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:500;">${_appListEsc(meta.name)}</span>`;
        if(meta.default) chips += `<span style="background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:600;">Default</span>`;
      }
      if(listKey === 'regions'){
        if(meta.state) chips += `<span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:600;">${_appListEsc(meta.state)}</span>`;
        if(meta.special === 'all_state') chips += `<span style="background:#ecfccb;color:#3f6212;border:1px solid #d9f99d;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:600;">All-state</span>`;
        if(meta.special === 'multi_state' && Array.isArray(meta.states)){
          chips += `<span style="background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:600;">Multi: ${_appListEsc(meta.states.join(', '))}</span>`;
        }
      }
      if(listKey === 'counties'){
        if(meta.state) chips += `<span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:600;">${_appListEsc(meta.state)}</span>`;
        if(Array.isArray(meta.regions) && meta.regions.length){
          chips += meta.regions.map(rg =>
            `<span style="background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:500;">${_appListEsc(rg)}</span>`).join('');
        }
        // Inline edit-tags button so admins can correct a county's region
        // assignment without re-creating the row.
        chips += `<button onclick="_appListEditCountyMeta('${attr}')" title="Edit state / region tags" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit tags</button>`;
      }
      return '<div class="al-row" style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #e2e8f0;background:#fff;">'
           +   '<div style="flex:1;color:#0f172a;display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span style="font-weight:600;">' + safe + '</span>' + chips + '</div>'
           +   '<button onclick="_appListRename(\'' + listKey + '\',\'' + attr + '\')" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Rename</button>'
           +   '<button onclick="_appListDelete(\'' + listKey + '\',\'' + attr + '\')" style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Delete</button>'
           + '</div>';
    }).join('');
    return;
  }

  if(listKey === 'preferred_cities'){
    // Flat list. v360: support the search filter wired above the list.
    const values = window._appLists.preferred_cities || [];
    const q = (_appListSearch.preferred_cities || '').trim();
    const tokenMatch = (typeof window._tokenMatch === 'function')
      ? window._tokenMatch
      : (qq, hay) => String(hay).toLowerCase().indexOf(String(qq).toLowerCase()) !== -1;
    const filtered = q ? values.filter(v => tokenMatch(q, v)) : values;
    if(countEl){
      countEl.textContent = q
        ? (filtered.length + ' of ' + values.length + ' shown')
        : (values.length + ' item' + (values.length === 1 ? '' : 's'));
    }
    if(!values.length){
      listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#94a3b8;font-size:11px;">No items yet — add one above.</div>';
      return;
    }
    if(!filtered.length){
      listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#94a3b8;font-size:11px;">No cities match "' + _appListEsc(q) + '".</div>';
      return;
    }
    listEl.innerHTML = filtered.map(v => {
      const safe = _appListEsc(v);
      const attr = _appListJsEsc(v);
      return '<div class="al-row" style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #e2e8f0;background:#fff;">'
           +   '<div style="flex:1;color:#0f172a;">' + safe + '</div>'
           +   '<button onclick="_appListRename(\'preferred_cities\',\''+attr+'\')" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Rename</button>'
           +   '<button onclick="_appListDelete(\'preferred_cities\',\''+attr+'\')" style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Delete</button>'
           + '</div>';
    }).join('');
    return;
  }

  // asset_types — collapsible tree.
  const groups = _appListGroupAssetTypes();
  const totalSubs = groups.reduce((acc, g) => acc + g.subs.length, 0);
  if(countEl) countEl.textContent = groups.length + ' categor' + (groups.length === 1 ? 'y' : 'ies')
                                  + ' · ' + totalSubs + ' subtype' + (totalSubs === 1 ? '' : 's');
  if(!groups.length){
    listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#94a3b8;font-size:11px;">No categories yet — add one above.</div>';
    return;
  }

  const renameTip = 'Cascading rename: updates this row, all matching subtypes, and every deal carrying this value. Atomic.';
  const deleteTip = 'Soft delete only — existing deals keep their value. (Cascading delete is not implemented; rename to "Needs Classification" if you want to retire a category.)';

  listEl.innerHTML = groups.map(g => {
    const catSafe = _appListEsc(g.cat);
    const catAttr = _appListJsEsc(g.cat);
    const expanded = !!_appListExpanded[g.cat];
    const arrow = expanded ? '▼' : '▶';
    const blocked = g.subs.length > 0;
    const deleteBtn = blocked
      ? '<button title="Cannot delete — '+g.subs.length+' subtype'+(g.subs.length===1?'':'s')+' still active. Delete subtypes first." disabled style="background:#f1f5f9;border:1px solid #e2e8f0;color:#cbd5e1;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:not-allowed;">Delete</button>'
      : '<button title="'+_appListEsc(deleteTip)+'" onclick="_appListDelete(\'asset_types\',\''+catAttr+'\')" style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Delete</button>';

    let html = '<div class="al-cat" style="border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;background:#fff;overflow:hidden;">';
    // Category header row
    html += '<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f1f5f9;border-bottom:'+(expanded?'1px solid #e2e8f0':'none')+';">'
         +   '<button onclick="_appListToggleCategory(\''+catAttr+'\')" style="background:none;border:none;color:#64748b;font-size:11px;cursor:pointer;padding:0 4px;width:20px;text-align:center;">'+arrow+'</button>'
         +   '<div style="flex:1;font-weight:700;color:#0f172a;font-size:12px;">'+catSafe+'</div>'
         +   '<div style="font-size:10px;color:#94a3b8;">'+g.subs.length+'</div>'
         +   '<button title="'+_appListEsc(renameTip)+'" onclick="_appListRename(\'asset_types\',\''+catAttr+'\')" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Rename</button>'
         +   deleteBtn
         + '</div>';

    if(expanded){
      // Subtype rows
      if(g.subs.length){
        html += g.subs.map(sub => {
          const subSafe = _appListEsc(sub);
          // Stored value is "Category: Subtype"; we pass that whole string
          // to rename/delete so they target the right ace_app_lists row.
          const fullVal = g.cat + ': ' + sub;
          const fullAttr = _appListJsEsc(fullVal);
          return '<div style="display:flex;align-items:center;gap:6px;padding:5px 10px 5px 32px;border-bottom:1px solid #f1f5f9;">'
               +   '<div style="flex:1;color:#334155;font-size:12px;">'+subSafe+'</div>'
               +   '<button title="'+_appListEsc(renameTip)+'" onclick="_appListRename(\'asset_types\',\''+fullAttr+'\')" style="background:#f8fafc;border:1px solid #e2e8f0;color:#475569;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Rename</button>'
               +   '<button title="'+_appListEsc(deleteTip)+'" onclick="_appListDelete(\'asset_types\',\''+fullAttr+'\')" style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Delete</button>'
               + '</div>';
        }).join('');
      }else{
        html += '<div style="padding:8px 10px 8px 32px;color:#94a3b8;font-size:11px;font-style:italic;">No subtypes yet.</div>';
      }
      // Inline subtype-add input
      const inpId = 'alAddSub_' + _appListEsc(g.cat).replace(/[^a-zA-Z0-9]/g,'_');
      html += '<div style="display:flex;gap:6px;padding:6px 10px 8px 32px;background:#fafbfc;border-top:1px solid #f1f5f9;">'
           +   '<input id="'+inpId+'" placeholder="New subtype…" onkeydown="if(event.key===\'Enter\'){event.preventDefault();_appListAddSubtype(\''+catAttr+'\',\''+inpId+'\');}" style="flex:1;padding:5px 8px;border:1px solid #cbd5e1;border-radius:4px;font-size:11px;font-family:inherit;background:#fff;"/>'
           +   '<button onclick="_appListAddSubtype(\''+catAttr+'\',\''+inpId+'\')" style="background:#0f172a;color:#fff;border:none;padding:5px 12px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">+ Add subtype</button>'
           + '</div>';
    }
    html += '</div>';
    return html;
  }).join('');
}

// After any edit: reload the cache (which also rebuilds ASSET_SUBTYPES via
// _rebuildAssetSubtypes) and re-render both subsections + the Deal Board
// if it's currently visible.
export async function _appListAfterEdit(){
  await _loadAppLists();
  _appListRender('asset_types');
  _appListRender('preferred_cities');
  // v113.26: also refresh the three new lists if their containers are mounted.
  ['states','regions','counties'].forEach(k => {
    if(document.getElementById('alList' + _appListDomKey(k))) _appListRender(k);
  });
  // Re-render Deal Board if open so filter dropdowns pick up changes.
  const bar = document.getElementById('loc-compact-bar');
  if(bar && typeof renderDealBoard === 'function'){
    try{
      ['city','type'].forEach(k => {
        const inp = document.getElementById('loc-si-'+k);
        const dd  = document.getElementById('loc-dd-'+k);
        if(inp && dd && dd.style.display === 'block'){
          _locBuildDD(k, inp.value);
        }
      });
      renderDealBoard();
    }catch(e){ console.warn('deal board refresh after app list edit failed:', e.message); }
  }
}

// v113.26: edit a county row's metadata (state + regions). Simple prompt
// chain — keeps this small until we ship a proper modal. Region values are
// validated against window._appLists.regions so admins can't tag a county with a
// region that doesn't exist.
export async function _appListEditCountyMeta(value){
  const meta = _appListMeta('counties', value);
  const curState = (meta.state || 'NJ').toUpperCase();
  const stateRaw = prompt('State code for "' + value + '" (e.g. NJ, NY, PA):', curState);
  if(stateRaw === null) return;
  const state = (stateRaw || '').trim().toUpperCase();
  if(!state){ _appListStatus('State is required.', true); return; }
  if((window._appLists.states || []).length && !window._appLists.states.includes(state)){
    if(!confirm('"' + state + '" is not in the States list. Save anyway?')) return;
  }
  const curRegions = Array.isArray(meta.regions) ? meta.regions.join(', ') : '';
  const regionsRaw = prompt('Region tags for "' + value + '" — comma-separated, must match values in the Regions list (or blank for none):', curRegions);
  if(regionsRaw === null) return;
  const regions = (regionsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
  const known = new Set(window._appLists.regions || []);
  const unknown = regions.filter(r => known.size && !known.has(r));
  if(unknown.length){
    if(!confirm('These region(s) are not in the Regions list: ' + unknown.join(', ') + '\n\nSave anyway?')) return;
  }
  _appListStatus('Saving…', false);
  try{
    const rows = await _sbGet(SB_TABLES.appLists,
      'select=id&list_key=eq.counties&value=eq.' + encodeURIComponent(value)
      + '&is_active=eq.true&limit=1');
    if(!Array.isArray(rows) || !rows.length){
      _appListStatus('Row not found.', true); return;
    }
    await _sbPatch(SB_TABLES.appLists, rows[0].id, {
      metadata: { state, regions }
    });
    await _appListAfterEdit();
    _appListStatus('Updated tags for "' + value + '".', false);
  }catch(e){
    console.error('_appListEditCountyMeta failed:', e);
    _appListStatus('Save failed: ' + (e.message || 'unknown error'), true);
  }
}

// v113.26: county add. The plain "+ Add" path doesn't know which state /
// region a new county belongs to, so we ask via prompts. Same validation
// as _appListEditCountyMeta. Falls through to _appListUpsert which handles
// reactivate-over-insert semantics.
export async function _appListAddCounty(){
  const inp = document.getElementById('alInputCounties');
  if(!inp) return;
  const raw = (inp.value || '').trim();
  if(!raw){ _appListStatus('Enter a county name first.', true); return; }
  if((window._appLists.counties || []).some(v => v.toLowerCase() === raw.toLowerCase())){
    _appListStatus('"' + raw + '" is already in the list.', true); return;
  }
  const stateRaw = prompt('State code for "' + raw + '" (e.g. NJ, NY, PA):', 'NJ');
  if(stateRaw === null) return;
  const state = (stateRaw || '').trim().toUpperCase();
  if(!state){ _appListStatus('State is required.', true); return; }
  if((window._appLists.states || []).length && !window._appLists.states.includes(state)){
    if(!confirm('"' + state + '" is not in the States list. Save anyway?')) return;
  }
  const regionsRaw = prompt('Region tags for "' + raw + '" — comma-separated (e.g. "North NJ"), or blank:', '');
  if(regionsRaw === null) return;
  const regions = (regionsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
  _appListStatus('Saving…', false);
  try{
    await _appListUpsert('counties', raw, { metadata: { state, regions } });
    inp.value = '';
    await _appListAfterEdit();
    _appListStatus('Added "' + raw + '".', false);
  }catch(e){
    console.error('_appListAddCounty failed:', e);
    _appListStatus('Add failed: ' + (e.message || 'unknown error'), true);
  }
}

// v113.27: scan deals + buyer_criteria for non-canonical county values,
// show a preview, then on confirm rewrite each row to its canonical match.
//
// Why this exists: county data accumulated over time as "Monmouth",
// "Monmouth County", and "monmouth" — three rows in the filter dropdown
// for the same place. The buyer-criteria CSVs have the same problem.
// window._canonicalCounty(input) is the source of truth for "what's the right
// version" — it consults window._appLists.counties.
//
// Safety:
//   • Reads everything first, builds a delta list, shows it in a confirm dialog
//   • Only writes rows where the new value actually differs
//   • PATCHes one row at a time so a single failure doesn't poison the rest
//   • Logs every write to console for an audit trail
// v164: load + render the pending county requests in the Settings panel.
export async function _loadCountyRequests(){
  const listEl = document.getElementById('countyReqList');
  const countEl = document.getElementById('countyReqCount');
  if(!listEl) return;
  if(!isSupabase()){
    listEl.innerHTML = '<div style="color:#94a3b8;">Supabase required.</div>';
    return;
  }
  listEl.innerHTML = '<div style="color:#94a3b8;">Loading…</div>';
  try {
    const rows = await _sbGet('ace_county_requests',
      'select=id,requested_value,state,property_id,requested_by,created_at,status&status=eq.pending&order=created_at.desc&limit=200');
    const arr = Array.isArray(rows) ? rows : [];
    if(countEl) countEl.textContent = arr.length ? `(${arr.length})` : '';
    if(!arr.length){
      listEl.innerHTML = '<div style="color:#94a3b8;padding:8px;">No pending requests.</div>';
      return;
    }
    listEl.innerHTML = arr.map(r => {
      const dt = r.created_at ? new Date(r.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
      const safeVal = String(r.requested_value || '').replace(/'/g,"\\'").replace(/</g,'&lt;');
      return `<div style="background:#fff;border:1px solid #c7d2fe;border-radius:5px;padding:8px 10px;margin-bottom:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;color:#0f172a;">${String(r.requested_value||'').replace(/</g,'&lt;')}${r.state?` <span style="font-weight:500;color:#6366f1;">(${String(r.state).replace(/</g,'&lt;')})</span>`:''}</div>
          <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${dt}</div>
        </div>
        <button onclick="_approveCountyRequest('${r.id}','${safeVal}')" style="background:#16a34a;color:#fff;border:none;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;">✓ Approve</button>
        <button onclick="_rejectCountyRequest('${r.id}')" style="background:#fff;color:#b91c1c;border:1px solid #fecaca;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">✕ Reject</button>
      </div>`;
    }).join('');
  } catch(e){
    listEl.innerHTML = `<div style="color:#b91c1c;">Error loading: ${e.message||e}</div>`;
  }
}

export async function _approveCountyRequest(id, value){
  if(!confirm(`Add "${value}" to the canonical counties list?`)) return;
  try {
    // Insert into app_lists (ignore if already exists — rare race)
    const existing = await _sbGet(SB_TABLES.appLists,
      `list_key=eq.counties&value=eq.${encodeURIComponent(value)}&limit=1`);
    if(!Array.isArray(existing) || !existing.length){
      await _sbPost(SB_TABLES.appLists, {
        list_key: 'counties',
        value,
        sort_order: 9999,
        is_active: true,
      });
    }
    const userId = (typeof window._currentUser !== 'undefined' && window._currentUser && window._currentUser.id) ? window._currentUser.id : null;
    await _sbPatch('ace_county_requests', id, {
      status: 'approved',
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    });
    // Refresh canonical list cache so the rest of the app sees it
    if(typeof _loadAppLists === 'function') await _loadAppLists();
    showSaveConfirm(`✓ Added "${value}" to canonical list`);
    _loadCountyRequests();
  } catch(e){
    alert('Approve failed: ' + (e.message || 'unknown error'));
  }
}

export async function _rejectCountyRequest(id){
  const note = prompt('Reason (optional):', '');
  if(note === null) return; // cancel
  try {
    const userId = (typeof window._currentUser !== 'undefined' && window._currentUser && window._currentUser.id) ? window._currentUser.id : null;
    await _sbPatch('ace_county_requests', id, {
      status: 'rejected',
      admin_notes: note || null,
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    });
    showSaveConfirm('✕ Request rejected');
    _loadCountyRequests();
  } catch(e){
    alert('Reject failed: ' + (e.message || 'unknown error'));
  }
}

// v165: list every distinct non-canonical county value currently in use
// on ace_properties.simple_county (across all deals, ignoring soft-deletes)
// + their counts, with an Add button to push the value straight into
// canonical app_lists. The companion query also flags state samples so
// the admin can verify legitimacy before adding (e.g. "Nassau" used in NY
// vs. dirty data in NJ).
export async function _loadNonCanonCounties(){
  const listEl  = document.getElementById('countyNonCanonList');
  const countEl = document.getElementById('countyNonCanonCount');
  if(!listEl) return;
  if(!isSupabase()){
    listEl.innerHTML = '<div style="color:#94a3b8;">Supabase required.</div>';
    return;
  }
  listEl.innerHTML = '<div style="color:#94a3b8;">Loading…</div>';
  try {
    // Pull in pages so we can see every distinct value, not just the first 1000.
    // _proxyCall directly (not _sbGet) so the My-Deals agent filter doesn't apply.
    const rows = [];
    let from = 0, batch = 1000;
    while(true){
      const page = await _proxyCall({
        table: SB_TABLES.properties,
        method: 'GET',
        select: 'id,simple_county,state',
        'deleted_at': 'is.null',
        'simple_county': 'not.is.null',
        order: 'id.asc',
        limit: batch,
        offset: from,
      });
      if(!Array.isArray(page) || !page.length) break;
      rows.push(...page);
      if(page.length < batch) break;
      from += batch;
    }
    const canon = new Set((window._appLists.counties || []).map(c => String(c).toLowerCase()));
    // group by exact value (preserving case so admins see "philadelphia" vs "Philadelphia").
    const grouped = new Map();
    rows.forEach(r => {
      const v = (r.simple_county || '').trim();
      if(!v) return;
      if(canon.has(v.toLowerCase())) return; // skip canonical
      const k = v;
      if(!grouped.has(k)) grouped.set(k, { count:0, states:new Set() });
      const g = grouped.get(k);
      g.count++;
      if(r.state) g.states.add(r.state);
    });
    const arr = [...grouped.entries()]
      .map(([value, info]) => ({ value, count: info.count, states: [...info.states].sort().join(', ') }))
      .sort((a,b) => b.count - a.count || a.value.localeCompare(b.value));
    if(countEl) countEl.textContent = arr.length ? `(${arr.length} distinct, ${arr.reduce((s,x)=>s+x.count,0)} rows)` : '';
    if(!arr.length){
      listEl.innerHTML = '<div style="color:#94a3b8;padding:8px;">All counties match the canonical list. ✓</div>';
      return;
    }
    listEl.innerHTML = arr.map(x => {
      const safeVal = String(x.value).replace(/'/g,"\\'").replace(/</g,'&lt;');
      return `<div style="background:#fff;border:1px solid #fde68a;border-radius:5px;padding:6px 10px;margin-bottom:5px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <span style="font-weight:700;color:#0f172a;">${String(x.value).replace(/</g,'&lt;')}</span>
          <span style="margin-left:8px;background:#fde68a;color:#78350f;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700;">${x.count}</span>
          ${x.states?`<span style="margin-left:8px;font-size:10px;color:#94a3b8;">${String(x.states).replace(/</g,'&lt;')}</span>`:''}
        </div>
        <button onclick="_addNonCanonToList('${safeVal}')" style="background:#16a34a;color:#fff;border:none;padding:4px 12px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;">+ Add to canonical</button>
      </div>`;
    }).join('');
  } catch(e){
    listEl.innerHTML = `<div style="color:#b91c1c;">Error loading: ${e.message||e}</div>`;
  }
}

export async function _addNonCanonToList(value){
  if(!confirm(`Add "${value}" to the canonical counties list?`)) return;
  try {
    const existing = await _sbGet(SB_TABLES.appLists,
      `list_key=eq.counties&value=eq.${encodeURIComponent(value)}&limit=1`);
    if(!Array.isArray(existing) || !existing.length){
      await _sbPost(SB_TABLES.appLists, {
        list_key: 'counties', value, sort_order: 9999, is_active: true,
      });
    }
    if(typeof _loadAppLists === 'function') await _loadAppLists();
    // Clear the review flag on rows whose simple_county now matches canonical.
    // Find the affected rows then PATCH each (no bulk-by-filter PATCH in our proxy).
    const affected = await _proxyCall({
      table: SB_TABLES.properties,
      method: 'GET',
      select: 'id',
      'simple_county': 'eq.' + value,
      'deleted_at': 'is.null',
      'needs_county_review': 'eq.true',
      limit: 5000,
    });
    for(const r of (affected || [])){
      try { await _sbPatch(SB_TABLES.properties, r.id, { needs_county_review: false }); } catch(_e){}
    }
    showSaveConfirm(`✓ Added "${value}" to canonical (${(affected||[]).length} deals unflagged)`);
    _loadNonCanonCounties();
  } catch(e){
    alert('Add failed: ' + (e.message || 'unknown error'));
  }
}

// v165: backfill latitude/longitude on priority-stage deals that don't
// have them yet, so they show up on the map. Loops through one address
// at a time so we respect Google's geocoding rate limits and the user
// can watch progress live. Uses the same googleGeocodeAddress helper
// that the address autocomplete uses.
const _BACKFILL_PRIORITY_STAGES = [
  'Hot Active Listing','Active Listing','Market Price Active',
  'In Negotiations','Negotiating','Attorney Review',
  'Under Contract','Closed','Closed 2025','Closed 2026','CLOSED 2025',
];
export async function _backfillCoordsPriorityStages(){
  if(!isSupabase()){ alert('Supabase required.'); return; }
  if(!_store.get('google_places_key')){
    alert('Google Places API key not configured. Open Settings → API Keys to add one before running this.');
    return;
  }
  const btn = document.getElementById('coordBackfillBtn');
  const log = document.getElementById('coordBackfillLog');
  if(btn){ btn.disabled = true; btn.style.opacity = '0.6'; }
  if(log){ log.style.display = 'block'; log.innerHTML = '⏳ Loading deals…'; }
  try {
    // Pull every deal in the priority stages that has no coords. Use the
    // PostgREST 'in.()' filter for the stage list and 'or=()' for the
    // null-coords condition. _proxyCall directly to skip My-Deals filter.
    const stageFilter = _BACKFILL_PRIORITY_STAGES
      .map(s => `"${s.replace(/"/g,'\\"')}"`).join(',');
    const deals = [];
    let from = 0, batch = 500;
    while(true){
      const page = await _proxyCall({
        table: SB_TABLES.properties,
        method: 'GET',
        select: 'id,address,pipeline_stage,latitude,longitude,simple_county',
        'deleted_at': 'is.null',
        'pipeline_stage': `in.(${stageFilter})`,
        or: '(latitude.is.null,longitude.is.null)',
        order: 'id.asc',
        limit: batch,
        offset: from,
      });
      if(!Array.isArray(page) || !page.length) break;
      deals.push(...page);
      if(page.length < batch) break;
      from += batch;
    }
    if(log) log.innerHTML = `Geocoding ${deals.length} deals…<br/>`;
    if(!deals.length){
      if(log) log.innerHTML = '<span style="color:#16a34a;">✓ No deals need geocoding — every priority listing already has coordinates.</span>';
      return;
    }
    let ok = 0, fail = 0, skip = 0;
    for(let i = 0; i < deals.length; i++){
      const d = deals[i];
      if(!d.address || d.address.length < 5){ skip++; continue; }
      try {
        const geo = await googleGeocodeAddress(d.address);
        if(geo && geo.ok && geo.lat && geo.lng){
          const upd = { latitude: geo.lat, longitude: geo.lng };
          // Only fill county if it was empty — never overwrite
          if(!d.simple_county && geo.county){
            const c = (typeof window._canonicalCounty === 'function') ? window._canonicalCounty(geo.county) : geo.county;
            upd.simple_county = c;
          }
          await _sbPatch(SB_TABLES.properties, d.id, upd);
          // v165.1: also update the in-memory window.allDeals entry so the map
          // picks up the new coords without a page reload.
          if(typeof window.allDeals !== 'undefined' && Array.isArray(window.allDeals)){
            const entry = window.allDeals.find(x => x && x.id === d.id);
            if(entry){
              entry['Latitude']  = geo.lat;
              entry['Longitude'] = geo.lng;
              if(upd.simple_county) entry['Simple County'] = upd.simple_county;
            }
          }
          ok++;
        } else {
          fail++;
        }
      } catch(e){ fail++; }
      if(log && (i % 5 === 4 || i === deals.length - 1)){
        log.innerHTML = `Geocoding… ${i+1}/${deals.length} <span style="color:#16a34a;">(${ok} ok</span>, <span style="color:#b91c1c;">${fail} failed</span>, <span style="color:#94a3b8;">${skip} skipped)</span>`;
      }
    }
    if(log) log.innerHTML = `<span style="color:#16a34a;">✓ Done.</span> ${ok} updated, ${fail} failed, ${skip} skipped (missing address). <i>Map already updated.</i>`;
    showSaveConfirm(`✓ Coords backfilled for ${ok} deals`);
    // v165.1: refresh the Deal Board map (no-op if it isn't currently mounted)
    if(typeof dbRefreshMapPins === 'function') dbRefreshMapPins();
  } catch(e){
    if(log) log.innerHTML = `<span style="color:#b91c1c;">Error: ${e.message||e}</span>`;
  } finally {
    if(btn){ btn.disabled = false; btn.style.opacity = '1'; }
  }
}

export async function _adminNormalizeCounties(){
  if(!isSupabase()){
    alert('Supabase required for this operation.');
    return;
  }
  if(!window._appLists || !window._appLists.counties || !window._appLists.counties.length){
    alert('No canonical counties loaded. Open Settings → App Lists and seed the counties list first.');
    return;
  }
  _appListStatus('Scanning deals + buyer criteria for non-canonical county values…', false);

  // ─── Phase 1: scan deals (ace_properties.simple_county) ─────────
  // We call _proxyCall directly (rather than _sbGet) so the implicit
  // "My Deals" agent filter inside _sbGet doesn't accidentally narrow the
  // scan to just the current user's deals. Settings is admin-level work
  // and must see every deal in the database.
  let dealsToFix = [];
  try{
    const PAGE = 1000;
    let off = 0;
    let totalDeals = 0;
    while(true){
      const rows = await _proxyCall({
        table: SB_TABLES.properties,
        method: 'GET',
        select: 'id,simple_county',
        'simple_county': 'not.is.null',
        limit: PAGE,
        offset: off,
        order: 'id.asc',
      });
      if(!rows || !rows.length) break;
      totalDeals += rows.length;
      for(const r of rows){
        const old = String(r.simple_county || '').trim();
        if(!old) continue;
        const canonical = window._canonicalCounty(old);
        if(canonical && canonical !== old){
          dealsToFix.push({ id: r.id, old, canonical });
        }
      }
      if(rows.length < PAGE) break;
      off += PAGE;
    }
    console.log('[v113.27] scanned', totalDeals, 'deals →', dealsToFix.length, 'need normalization');
  }catch(e){
    console.error('[v113.27] deal scan failed:', e);
    _appListStatus('Deal scan failed: ' + (e.message || 'unknown error'), true);
    return;
  }

  // ─── Phase 2: scan buyer_criteria (preferred_counties + simple_area_preference) ─
  let bcToFix = [];
  try{
    const rows = await _sbGet(SB_TABLES.buyerCriteria,
      'select=id,preferred_counties,simple_area_preference');
    for(const r of rows || []){
      const oldPC = r.preferred_counties || null;
      const oldSAP = r.simple_area_preference || null;
      const newPC = _canonicalCountyCSV(oldPC);
      const newSAP = _canonicalCountyCSV(oldSAP);
      const pcChanged = (oldPC || null) !== (newPC || null);
      const sapChanged = (oldSAP || null) !== (newSAP || null);
      if(pcChanged || sapChanged){
        bcToFix.push({
          id: r.id,
          oldPC, newPC, pcChanged,
          oldSAP, newSAP, sapChanged,
        });
      }
    }
    console.log('[v113.27] scanned', (rows||[]).length, 'buyer criteria →', bcToFix.length, 'need normalization');
  }catch(e){
    console.error('[v113.27] buyer criteria scan failed:', e);
    _appListStatus('Buyer criteria scan failed: ' + (e.message || 'unknown error'), true);
    return;
  }

  // ─── Phase 3: build a per-old-name preview tally ──────────────────
  const dealTally = {};   // "old → canonical": count
  for(const d of dealsToFix){
    const k = d.old + ' → ' + d.canonical;
    dealTally[k] = (dealTally[k] || 0) + 1;
  }
  const bcCount = bcToFix.length;
  const dealCount = dealsToFix.length;

  if(dealCount === 0 && bcCount === 0){
    _appListStatus('All county data is already canonical. Nothing to fix.', false);
    alert('All county data is already canonical — nothing to do.');
    return;
  }

  // Build the preview message
  let msg = 'Normalize county data?\n\n';
  msg += 'DEALS (ace_properties.simple_county): ' + dealCount + ' rows will be rewritten\n';
  if(dealCount > 0){
    const lines = Object.entries(dealTally)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 20)  // cap preview at 20 distinct mappings
      .map(([k, n]) => '  • ' + k + '  (' + n + ' deal' + (n>1?'s':'') + ')');
    msg += lines.join('\n');
    if(Object.keys(dealTally).length > 20){
      msg += '\n  …and ' + (Object.keys(dealTally).length - 20) + ' more distinct mappings';
    }
  }
  msg += '\n\nBUYER CRITERIA (preferred_counties + simple_area_preference): ' + bcCount + ' rows will be rewritten';
  msg += '\n\nThis will PATCH every affected row. Proceed?';

  if(!confirm(msg)){
    _appListStatus('Cancelled — no rows were changed.', false);
    return;
  }

  // ─── Phase 4: apply ──────────────────────────────────────────────
  _appListStatus('Applying normalization (' + (dealCount + bcCount) + ' rows)…', false);
  let dealsDone = 0, dealsFailed = 0;
  let bcDone = 0, bcFailed = 0;

  for(const d of dealsToFix){
    try{
      await _sbPatch(SB_TABLES.properties, d.id, { simple_county: d.canonical });
      dealsDone++;
    }catch(e){
      dealsFailed++;
      console.warn('[v113.27] deal', d.id, 'PATCH failed:', e.message);
    }
  }
  for(const r of bcToFix){
    const patch = {};
    if(r.pcChanged)  patch.preferred_counties      = r.newPC;
    if(r.sapChanged) patch.simple_area_preference  = r.newSAP;
    try{
      await _sbPatch(SB_TABLES.buyerCriteria, r.id, patch);
      bcDone++;
    }catch(e){
      bcFailed++;
      console.warn('[v113.27] bc', r.id, 'PATCH failed:', e.message);
    }
  }

  const summary =
    'Normalization complete.\n\n' +
    'Deals: ' + dealsDone + ' fixed' + (dealsFailed?', '+dealsFailed+' failed':'') + '\n' +
    'Buyer criteria: ' + bcDone + ' fixed' + (bcFailed?', '+bcFailed+' failed':'');
  console.log('[v113.27]', summary.replace(/\n/g, ' | '));
  _appListStatus(summary, dealsFailed + bcFailed > 0);
  alert(summary);

  // Reload window.allDeals so the pipeline filter dropdown reflects the new
  // canonical names without a hard refresh.
  if(typeof loadAllDataAndRender === 'function'){
    try{ await loadAllDataAndRender(); }catch(e){ console.warn('reload failed:', e); }
  }
}

// v113.26: state add. Uses optional long-name prompt → metadata.name.
export async function _appListAddState(){
  const inp = document.getElementById('alInputStates');
  if(!inp) return;
  const raw = (inp.value || '').trim().toUpperCase();
  if(!raw){ _appListStatus('Enter a state code first.', true); return; }
  if(!/^[A-Z]{2}$/.test(raw)){
    if(!confirm('"' + raw + '" doesn\'t look like a 2-letter state code. Save anyway?')) return;
  }
  if((window._appLists.states || []).some(v => v.toUpperCase() === raw)){
    _appListStatus('"' + raw + '" is already in the list.', true); return;
  }
  const name = (prompt('Full state name for "' + raw + '" (optional):', '') || '').trim();
  _appListStatus('Saving…', false);
  try{
    await _appListUpsert('states', raw, { metadata: name ? { name } : {} });
    inp.value = '';
    await _appListAfterEdit();
    _appListStatus('Added "' + raw + '".', false);
  }catch(e){
    console.error('_appListAddState failed:', e);
    _appListStatus('Add failed: ' + (e.message || 'unknown error'), true);
  }
}

// v113.26: region add. Asks for parent state (so the buyer-intake combobox
// can scope the auto-add).
export async function _appListAddRegion(){
  const inp = document.getElementById('alInputRegions');
  if(!inp) return;
  const raw = (inp.value || '').trim();
  if(!raw){ _appListStatus('Enter a region name first.', true); return; }
  if((window._appLists.regions || []).some(v => v.toLowerCase() === raw.toLowerCase())){
    _appListStatus('"' + raw + '" is already in the list.', true); return;
  }
  const stateRaw = prompt('Parent state for "' + raw + '" (e.g. NJ). Leave blank if it spans multiple states:', '');
  if(stateRaw === null) return;
  const state = (stateRaw || '').trim().toUpperCase();
  const meta = state ? { state } : {};
  _appListStatus('Saving…', false);
  try{
    await _appListUpsert('regions', raw, { metadata: meta });
    inp.value = '';
    await _appListAfterEdit();
    _appListStatus('Added "' + raw + '".', false);
  }catch(e){
    console.error('_appListAddRegion failed:', e);
    _appListStatus('Add failed: ' + (e.message || 'unknown error'), true);
  }
}

// v102.35: add a new top-level CATEGORY (asset_types) or city. The plain
// add input only handles bare values — for asset_types this means a new
// main category. Subtypes use _appListAddSubtype below.
//
// Validation for asset_types: the value cannot contain ": " (that prefix
// is reserved for subtype rows). Show a clear error and refuse.
export async function _appListAdd(listKey){
  const domKey = _appListDomKey(listKey);
  const inp = document.getElementById('alInput' + domKey);
  if(!inp) return;
  const raw = (inp.value || '').trim();
  if(!raw){ _appListStatus('Enter a value first.', true); return; }
  if(listKey === 'asset_types' && raw.indexOf(':') !== -1){
    _appListStatus('Category names cannot contain ":". To add a subtype, expand a category and use "+ Add subtype".', true);
    return;
  }
  if((window._appLists[listKey] || []).some(v => v.toLowerCase() === raw.toLowerCase())){
    _appListStatus('"' + raw + '" is already in the list.', true);
    return;
  }
  _appListStatus('Saving…', false);
  try{
    await _appListUpsert(listKey, raw);
    inp.value = '';
    if(listKey === 'asset_types') _appListExpanded[raw] = true; // open it so user sees they can add subtypes
    await _appListAfterEdit();
    _appListStatus('Added "' + raw + '".', false);
  }catch(e){
    console.error('_appListAdd failed:', e);
    _appListStatus('Add failed: ' + (e.message || 'unknown error'), true);
  }
}

// v102.35: add a new SUBTYPE under an existing category. Stored value is
// "Category: Subtype". Subtype name can contain anything (including colons).
export async function _appListAddSubtype(category, inputId){
  const inp = document.getElementById(inputId);
  if(!inp) return;
  const raw = (inp.value || '').trim();
  if(!raw){ _appListStatus('Enter a subtype name first.', true); return; }
  const fullValue = category + ': ' + raw;
  if((window._appLists.asset_types || []).some(v => v.toLowerCase() === fullValue.toLowerCase())){
    _appListStatus('"' + fullValue + '" is already in the list.', true);
    return;
  }
  _appListStatus('Saving…', false);
  try{
    await _appListUpsert('asset_types', fullValue);
    inp.value = '';
    _appListExpanded[category] = true;
    await _appListAfterEdit();
    _appListStatus('Added "' + fullValue + '".', false);
  }catch(e){
    console.error('_appListAddSubtype failed:', e);
    _appListStatus('Add failed: ' + (e.message || 'unknown error'), true);
  }
}

// Reactivate-over-insert primitive used by both add paths.
//
// v113.26: opts object adds {sortOrder, metadata, silent}.
//   - sortOrder: numeric, defaults to 0 (callers can pass an index for seeds)
//   - metadata:  object, overrides the legacy preferred_cities default
//   - silent:    if true, throw is suppressed when row already active
//                (used by the seeder so a partial seed doesn't error out)
export async function _appListUpsert(listKey, value, opts){
  opts = opts || {};
  const q = 'select=id,is_active&list_key=eq.' + encodeURIComponent(listKey)
          + '&value=eq.' + encodeURIComponent(value) + '&limit=1';
  const existing = await _sbGet(SB_TABLES.appLists, q);
  if(Array.isArray(existing) && existing.length){
    const row = existing[0];
    if(row.is_active){
      if(opts.silent) return;
      throw new Error('"' + value + '" already exists and is active.');
    }
    const patch = { is_active: true };
    if(opts.metadata) patch.metadata = opts.metadata;
    await _sbPatch(SB_TABLES.appLists, row.id, patch);
  }else{
    let meta = opts.metadata;
    if(!meta){
      // Legacy default: preferred_cities rows are tagged with state=NJ so
      // the city autocomplete can scope results.
      meta = (listKey === 'preferred_cities') ? { state: 'NJ' } : {};
    }
    await _sbPost(SB_TABLES.appLists, {
      list_key:   listKey,
      value:      value,
      sort_order: (typeof opts.sortOrder === 'number' ? opts.sortOrder : 0),
      is_active:  true,
      metadata:   meta
    });
  }
}

// v102.35: rename. Validation rules for asset_types:
//   - If renaming a CATEGORY (no ": " in oldValue), the new name also can't
//     contain ":" — same constraint as add.
//   - If renaming a SUBTYPE (oldValue contains ": "), the new value is
//     reconstructed as "<original-category>: <new-subtype-name>" — you
//     cannot move a subtype to a different category by typing a new
//     "Category: Subtype" string. (To move it, delete and re-add.)
//
// CASCADING TO DEALS / SUBTYPES IS DEFERRED TO v102.36. The button tooltips
// in the UI explain this. Renaming "Multifamily" here will rename the row
// in ace_app_lists but will NOT touch any "Multifamily: X" rows or any
// crm_asset_classification field on existing deals.
// v102.37: type-to-confirm modal. Returns a promise that resolves to true
// (user typed the confirm phrase and clicked Confirm) or false (cancelled).
// Used for high-blast-radius operations like cascading category rename.
export function _appListConfirmTypeIn(opts){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:\'Inter\',system-ui,sans-serif;';
    const phrase = opts.confirmPhrase || 'RENAME';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;max-width:520px;width:92%;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,0.3);">
        <div style="font-size:17px;font-weight:700;color:#0f172a;margin-bottom:8px;">${opts.title || 'Confirm'}</div>
        <div style="font-size:13px;color:#334155;margin-bottom:16px;line-height:1.55;">${opts.body || ''}</div>
        ${opts.danger ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin-bottom:16px;font-size:12px;color:#991b1b;line-height:1.5;">${opts.danger}</div>` : ''}
        <div style="font-size:11px;color:#64748b;margin-bottom:6px;font-weight:600;">Type <code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;color:#0f172a;font-weight:700;">${phrase}</code> to confirm:</div>
        <input id="alConfirmInput" autocomplete="off" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:monospace;box-sizing:border-box;margin-bottom:16px;" />
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="alConfirmCancel" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
          <button id="alConfirmGo" disabled style="background:#dc2626;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:not-allowed;opacity:0.5;">${opts.confirmLabel || 'Confirm'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const inp = overlay.querySelector('#alConfirmInput');
    const goBtn = overlay.querySelector('#alConfirmGo');
    const cancelBtn = overlay.querySelector('#alConfirmCancel');
    const cleanup = result => { document.body.removeChild(overlay); resolve(result); };
    inp.addEventListener('input', () => {
      const ok = inp.value.trim() === phrase;
      goBtn.disabled = !ok;
      goBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
      goBtn.style.opacity = ok ? '1' : '0.5';
    });
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter' && !goBtn.disabled){ cleanup(true); }
      else if(e.key === 'Escape'){ cleanup(false); }
    });
    cancelBtn.addEventListener('click', () => cleanup(false));
    goBtn.addEventListener('click', () => { if(!goBtn.disabled) cleanup(true); });
    setTimeout(() => inp.focus(), 50);
  });
}

// v102.37: cascading rename. Renames a category or subtype in ace_app_lists
// AND updates every deal whose crm_asset_classification references the old
// value (handling pipe-delimited multi-pick segments correctly). The whole
// operation runs as a single Postgres function (rename_asset_type) so it's
// atomic — if any step fails, nothing is written.
//
// UI flow:
//   1. prompt() for the new value (single-line, fast)
//   2. RPC call to preview_rename_asset_type for live counts
//   3. For CATEGORY renames: type-to-confirm modal showing the deal +
//      subtype counts. For SUBTYPE renames with > 0 affected deals: a
//      simpler confirm() with the count. For 0-deal subtype renames: no
//      second confirm — just execute.
//   4. RPC call to rename_asset_type to perform the cascade
//   5. Reload window._appLists and re-render
//
// Validation (refused server-side by preview_rename_asset_type):
//   - Identical, blank, source-missing, target-already-active
//   - Category names cannot contain ":"
//   - Subtype renames must keep the same parent category
//   - Cascade collisions: any "OldCat: X" -> "NewCat: X" target already active
export async function _appListRename(listKey, oldValue){
  // preferred_cities still uses the simple in-place rename (no cascade —
  // city values aren't propagated to deal columns the same way asset types
  // are). Falls through to the legacy flow.
  if(listKey !== 'asset_types'){
    return _appListRenameSimple(listKey, oldValue);
  }

  const colonIdx = oldValue.indexOf(': ');
  const isSubtype = colonIdx !== -1;
  const oldCategory = isSubtype ? oldValue.slice(0, colonIdx) : null;
  const oldSubtype  = isSubtype ? oldValue.slice(colonIdx + 2) : null;
  const promptCurrent = isSubtype ? oldSubtype : oldValue;
  const promptLabel = isSubtype
    ? 'Rename subtype "' + oldSubtype + '" (under "' + oldCategory + '") to:'
    : 'Rename category "' + oldValue + '" to:\n\n(Cascades to all subtypes and to every deal carrying this value.)';

  const next = prompt(promptLabel, promptCurrent);
  if(next === null) return;
  const trimmed = (next || '').trim();
  if(!trimmed || trimmed === promptCurrent) return;

  // Reassemble the new full value the way the server expects it.
  let newValue;
  if(isSubtype){
    newValue = oldCategory + ': ' + trimmed;
  }else{
    if(trimmed.indexOf(':') !== -1){
      _appListStatus('Category names cannot contain ":".', true);
      return;
    }
    newValue = trimmed;
  }
  if(newValue === oldValue) return;

  _appListStatus('Computing cascade scope…', false);

  // Step 2: preview RPC for live counts.
  let preview;
  try{
    preview = await _sbRpc('preview_rename_asset_type', {
      p_old_value: oldValue, p_new_value: newValue
    });
  }catch(e){
    console.error('preview RPC failed:', e);
    _appListStatus('Preview failed: ' + (e.message || 'unknown error'), true);
    return;
  }
  if(preview && preview.error){
    _appListStatus(preview.error, true);
    return;
  }

  // Step 3: confirmation. Tier the friction by blast radius.
  const dealCount = preview.will_affect_deals || 0;
  const subCount  = preview.will_rename_subtype_rows || 0;

  if(isSubtype){
    if(dealCount > 0){
      const ok = confirm(
        'Rename "' + oldValue + '" → "' + newValue + '"?\n\n'
        + 'This will update ' + dealCount + ' deal' + (dealCount === 1 ? '' : 's')
        + ' carrying this subtype value.\n\n'
        + 'The change is atomic and reversible (rename it back to revert).'
      );
      if(!ok) return;
    }
    // 0-deal subtype rename: no second confirm needed, just execute.
  }else{
    // Category rename — always require type-to-confirm "RENAME".
    const totalAffected = dealCount + subCount;
    const dangerNote = totalAffected > 100
      ? 'High-impact change. Make sure you have a recent DB backup if you\'re unsure.'
      : '';
    const ok = await _appListConfirmTypeIn({
      title: 'Cascading rename: "' + oldValue + '" → "' + newValue + '"',
      body: 'This will atomically:'
          + '<ul style="margin:8px 0 0 18px;padding:0;font-size:12px;color:#475569;">'
          + '<li>Rename the category row in App Lists</li>'
          + '<li>Rename ' + subCount + ' subtype row' + (subCount === 1 ? '' : 's')
            + ' (e.g. "' + oldValue + ': X" → "' + newValue + ': X")</li>'
          + '<li>Rewrite <strong>' + dealCount + '</strong> deal' + (dealCount === 1 ? '' : 's')
            + '\' asset classification (handling pipe-delimited multi-picks correctly)</li>'
          + '</ul>'
          + '<div style="margin-top:10px;font-size:12px;color:#64748b;">Atomic: if any step fails, nothing is written. Reversible: rename it back.</div>',
      danger: dangerNote,
      confirmPhrase: 'RENAME',
      confirmLabel: 'Cascade rename'
    });
    if(!ok) return;
  }

  _appListStatus('Renaming…', false);
  try{
    const result = await _sbRpc('rename_asset_type', {
      p_old_value: oldValue, p_new_value: newValue
    });
    if(result && result.error){
      _appListStatus(result.error, true);
      return;
    }
    // Preserve expanded state across category renames.
    if(!isSubtype && _appListExpanded[oldValue]){
      _appListExpanded[newValue] = true;
      delete _appListExpanded[oldValue];
    }
    await _appListAfterEdit();
    const detail = (result && result.renamed_deals != null)
      ? ' Updated ' + result.renamed_deals + ' deal' + (result.renamed_deals === 1 ? '' : 's')
        + (result.renamed_subtype_rows ? ' and ' + result.renamed_subtype_rows + ' subtype row'
          + (result.renamed_subtype_rows === 1 ? '' : 's') : '')
        + '.'
      : '';
    _appListStatus('Renamed "' + oldValue + '" → "' + newValue + '".' + detail, false);
  }catch(e){
    console.error('rename RPC failed:', e);
    _appListStatus('Rename failed: ' + (e.message || 'unknown error'), true);
  }
}

// v102.37: legacy in-place rename (no cascade). Used for preferred_cities
// where the value isn't propagated into deal columns the way asset_types
// is. Same logic as the v102.35 _appListRename body.
export async function _appListRenameSimple(listKey, oldValue){
  const next = prompt('Rename "' + oldValue + '" to:', oldValue);
  if(next === null) return;
  const trimmed = (next || '').trim();
  if(!trimmed || trimmed === oldValue) return;

  _appListStatus('Renaming…', false);
  try{
    const oldRows = await _sbGet(SB_TABLES.appLists,
      'select=id&list_key=eq.' + encodeURIComponent(listKey)
      + '&value=eq.' + encodeURIComponent(oldValue)
      + '&is_active=eq.true&limit=1');
    if(!Array.isArray(oldRows) || !oldRows.length){
      _appListStatus('Original row not found.', true);
      return;
    }
    const targetRows = await _sbGet(SB_TABLES.appLists,
      'select=id,is_active&list_key=eq.' + encodeURIComponent(listKey)
      + '&value=eq.' + encodeURIComponent(trimmed) + '&limit=1');
    const targetExists = Array.isArray(targetRows) && targetRows.length;
    if(targetExists && targetRows[0].is_active){
      _appListStatus('"' + trimmed + '" already exists.', true);
      return;
    }
    await _sbPatch(SB_TABLES.appLists, oldRows[0].id, { is_active: false });
    if(targetExists){
      await _sbPatch(SB_TABLES.appLists, targetRows[0].id, { is_active: true });
    }else{
      const meta = (listKey === 'preferred_cities') ? { state: 'NJ' } : {};
      await _sbPost(SB_TABLES.appLists, {
        list_key: listKey, value: trimmed,
        sort_order: 0, is_active: true, metadata: meta
      });
    }
    await _appListAfterEdit();
    _appListStatus('Renamed to "' + trimmed + '".', false);
  }catch(e){
    console.error('_appListRenameSimple failed:', e);
    _appListStatus('Rename failed: ' + (e.message || 'unknown error'), true);
  }
}

// v102.35: delete (soft). For asset_types CATEGORIES, blocked when active
// subtypes still exist — caller must delete subtypes first. For asset_types
// SUBTYPES and for preferred_cities, just flips is_active=false.
//
// CASCADING TO DEALS IS DEFERRED TO v102.36. Deals carrying a deleted
// asset_type value will still display that value; the union in
// _dbGetAssetTypes() ensures it remains visible in the Deal Board filter.
export async function _appListDelete(listKey, value){
  const isAssetTypes = (listKey === 'asset_types');
  const colonIdx = value.indexOf(': ');
  const isCategory = isAssetTypes && colonIdx === -1;

  if(isCategory){
    // Block if active subtypes exist.
    const prefix = value + ': ';
    const orphans = (window._appLists.asset_types || []).filter(v => v.indexOf(prefix) === 0);
    if(orphans.length){
      _appListStatus('Cannot delete "' + value + '" — ' + orphans.length + ' active subtype'
        + (orphans.length === 1 ? '' : 's') + ' still exist. Delete or rename them first.', true);
      return;
    }
  }

  if(!confirm('Delete "' + value + '" from this list?\n\nThis is a soft delete — you can re-add it later and it will reactivate the existing row. Existing deals carrying this value are NOT modified.')) return;
  _appListStatus('Deleting…', false);
  try{
    const rows = await _sbGet(SB_TABLES.appLists,
      'select=id&list_key=eq.' + encodeURIComponent(listKey)
      + '&value=eq.' + encodeURIComponent(value)
      + '&is_active=eq.true&limit=1');
    if(!Array.isArray(rows) || !rows.length){
      _appListStatus('Row not found.', true);
      return;
    }
    await _sbPatch(SB_TABLES.appLists, rows[0].id, { is_active: false });
    if(isCategory) delete _appListExpanded[value];
    await _appListAfterEdit();
    _appListStatus('Deleted "' + value + '".', false);
  }catch(e){
    console.error('_appListDelete failed:', e);
    _appListStatus('Delete failed: ' + (e.message || 'unknown error'), true);
  }
}

// v246: Workbench module migrated to js/workbench/workbench.js.
// Every former export is now attached to window.* by js/main.js.

// v102.36: returns the curated asset_types list directly. The legacy union
// with deal-distinct values was removed once the v102.36 normalization
// migration cleaned up the 2,495 deals carrying emoji-decorated, comma-
// joined, or "Commercial" placeholder values. Every active deal now
// references a value that exists in ace_app_lists, so the union was
// adding nothing but noise.
//
// If a future deal somehow ends up with an off-list value (e.g. via direct
// SQL or a bug), it will simply not appear as a filter option — the agent
// can re-classify it via the deal-card asset-type editor, which writes
// canonical values from the same curated list.
export function _dbGetAssetTypes(){
  return (window._appLists.asset_types || []).slice().sort();
}

// Straight read of the curated preferred_cities list. If the cache is empty
// (load failed or hasn't run yet), fall back to the hardcoded
// window._NJ_MUNICIPALITIES constant so the dropdown never comes up blank.
export function _dbGetCities(){
  if(window._appLists.preferred_cities && window._appLists.preferred_cities.length){
    return window._appLists.preferred_cities.slice();
  }
  if(typeof window._NJ_MUNICIPALITIES !== 'undefined' && Array.isArray(window._NJ_MUNICIPALITIES)){
    return window._NJ_MUNICIPALITIES.slice();
  }
  return [];
}
