// admin/bc-taxonomy.js — runtime-editable buyer-criteria asset taxonomy.
//
// Phase 1 of the "audit page is the source of truth" refactor.
//
// What this module owns:
//   - Loading the BC taxonomy (categories + subtypes) from
//     ace_ai_settings at startup, caching it module-side AND mutating
//     window.ASSET_SUBTYPES so all legacy callers (the BC blank-form
//     picker, the AI review-modal picker, _bcAssetSectionKey) keep
//     working without per-call refactors.
//   - The Settings → Tools "BC Asset Taxonomy" admin modal, which
//     replaces the old read-only audit and adds CRUD: rename / add /
//     delete categories + subtypes. Save round-trips through
//     ace_ai_settings; next page-load (or in-place after Save) every
//     surface picks up the new vocab.
//
// What stays in legacy index.html (for now):
//   - The hardcoded ASSET_SUBTYPES literal at line ~7193 — kept as the
//     bootstrap fallback so first paint never blocks on the config
//     fetch. After _bcTaxonomyLoad resolves, window.ASSET_SUBTYPES is
//     overridden in place.
//   - bcExpandedAssetSection (the per-asset requirements field
//     renderer) — Phase 2 will move it.
//
// External deps via window.*:
//   - window.ASSET_SUBTYPES (legacy bootstrap value, mutated on load)
//   - showSaveConfirm (toast)
//   - _sbGet / _sbPost / _sbPatch (core/supabase.js)

import { _sbGet, _sbPost, _sbPatch } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';

const TABLE = 'ace_ai_settings';
const KEY   = 'bc_taxonomy';

// Module-side cache of the active taxonomy + the row id (for upserts).
let _cache = null;     // { [category: string]: string[] }
let _rowId = null;     // ace_ai_settings.id when the row exists

// ─── Loader ───────────────────────────────────────────────────────────

export async function _bcTaxonomyLoad(){
  try {
    const rows = await _sbGet(TABLE, `key=eq.${encodeURIComponent(KEY)}&select=id,value&limit=1`);
    if(Array.isArray(rows) && rows[0]){
      _rowId = rows[0].id;
      const v = rows[0].value;
      if(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0){
        _cache = _normalize(v);
        // Mutate the legacy global so every existing callsite picks up
        // the override without further changes. We replace keys in
        // place rather than reassigning (the bootstrap value was
        // declared with `var ASSET_SUBTYPES = ...` so window.ASSET_SUBTYPES
        // may differ from the local-scope binding in legacy code).
        if(typeof window.ASSET_SUBTYPES === 'object' && window.ASSET_SUBTYPES){
          for(const k in window.ASSET_SUBTYPES) delete window.ASSET_SUBTYPES[k];
          for(const [k, vv] of Object.entries(_cache)) window.ASSET_SUBTYPES[k] = vv.slice();
        } else {
          window.ASSET_SUBTYPES = _clone(_cache);
        }
        console.log('[bc-taxonomy] loaded', Object.keys(_cache).length, 'categories from ace_ai_settings');
        return _cache;
      }
    }
    // No row yet → seed from the legacy bootstrap value.
    if(typeof window.ASSET_SUBTYPES === 'object' && window.ASSET_SUBTYPES){
      _cache = _clone(window.ASSET_SUBTYPES);
      try {
        await _bcTaxonomySave(_cache);
        console.log('[bc-taxonomy] seeded ace_ai_settings from legacy ASSET_SUBTYPES');
      } catch(e){ console.warn('[bc-taxonomy] initial seed failed:', e.message); }
    }
  } catch(e){
    console.warn('[bc-taxonomy] load failed; falling back to legacy ASSET_SUBTYPES:', e.message);
  }
  return _cache;
}

export function _bcTaxonomyGet(){
  return _cache || (typeof window.ASSET_SUBTYPES === 'object' ? window.ASSET_SUBTYPES : {});
}

export async function _bcTaxonomySave(taxonomy){
  const clean = _normalize(taxonomy);
  const payload = { key: KEY, value: clean, updated_at: new Date().toISOString() };
  if(_rowId){
    await _sbPatch(TABLE, _rowId, payload);
  } else {
    const inserted = await _sbPost(TABLE, payload);
    if(Array.isArray(inserted) && inserted[0]?.id) _rowId = inserted[0].id;
    else if(inserted && inserted.id) _rowId = inserted.id;
  }
  _cache = clean;
  // Mutate the legacy global in place.
  if(typeof window.ASSET_SUBTYPES === 'object' && window.ASSET_SUBTYPES){
    for(const k in window.ASSET_SUBTYPES) delete window.ASSET_SUBTYPES[k];
    for(const [k, v] of Object.entries(clean)) window.ASSET_SUBTYPES[k] = v.slice();
  } else {
    window.ASSET_SUBTYPES = _clone(clean);
  }
  return clean;
}

// ─── Internal helpers ─────────────────────────────────────────────────

function _normalize(t){
  // Force string keys + arrays of trimmed non-empty strings, dedupe
  // case-insensitively while preserving the first-seen casing.
  const out = {};
  for(const [rawKey, rawList] of Object.entries(t || {})){
    const cat = String(rawKey || '').trim();
    if(!cat) continue;
    const seen = new Set();
    const list = [];
    for(const v of (Array.isArray(rawList) ? rawList : [])){
      const sub = String(v || '').trim();
      if(!sub) continue;
      const k = sub.toLowerCase();
      if(seen.has(k)) continue;
      seen.add(k);
      list.push(sub);
    }
    out[cat] = list;
  }
  return out;
}

function _clone(t){ return JSON.parse(JSON.stringify(t || {})); }

function esc(s){
  return String(s==null?'':s).replace(/[<&>"]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;'}[c]));
}

// ─── Admin modal ──────────────────────────────────────────────────────

export function _bcAssetTaxonomyAdmin(){
  const taxonomy = _clone(_bcTaxonomyGet());
  let dirty = false;

  const modal = document.createElement('div');
  modal.id = 'bcTaxonomyAdminModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';
  modal.onclick = (e) => {
    if(e.target !== modal) return;
    if(dirty && !confirm('Discard unsaved taxonomy changes?')) return;
    modal.remove();
  };

  function render(){
    const SECTION_LABELS = {
      multifamily: 'Multifamily', warehouse: 'Warehouse / Industrial',
      shopping: 'Shopping Center', retail: 'Retail', office: 'Office',
      land: 'Land', mixed: 'Mixed Use', automotive: 'Automotive',
      hotel: 'Hotel', storage: 'Self Storage', mhp: 'Mobile Home Park',
      healthcare: 'Healthcare', special: 'Special Purpose',
      development: 'Development',
    };
    const sectionKeyOf = (chipText) => {
      // Mirrors _bcAssetSectionKey in index.html, kept in sync here.
      const lc = String(chipText || '').toLowerCase();
      if(lc.includes('multifamily') || lc.includes('multi')) return 'multifamily';
      if(lc.includes('warehouse') || lc.includes('industrial') || lc.includes('distribution') || lc.includes('flex')) return 'warehouse';
      if(lc.includes('shopping')) return 'shopping';
      if(lc.includes('retail')) return 'retail';
      if(lc.includes('office')) return 'office';
      if(lc.includes('land')) return 'land';
      if(lc.includes('mixed')) return 'mixed';
      if(lc.includes('automotive') || lc.includes('auto')) return 'automotive';
      if(lc.includes('hotel') || lc.includes('hospitality')) return 'hotel';
      if(lc.includes('self storage') || lc.includes('self-storage') || lc.includes('storage')) return 'storage';
      if(lc.includes('mobile') || lc.includes('mhp') || lc.includes('manufactured')) return 'mhp';
      if(lc.includes('healthcare') || lc.includes('medical')) return 'healthcare';
      if(lc.includes('special')) return 'special';
      if(lc.includes('development')) return 'development';
      return 'misc__' + lc.replace(/[^a-z0-9]+/g, '_');
    };

    let totalChips = 0, chipsWithSection = 0;
    const blocks = Object.entries(taxonomy).map(([cat, subs], catIdx) => {
      const safeCat = esc(cat);
      const catKey = sectionKeyOf(cat);
      const catHasSection = !catKey.startsWith('misc__');
      totalChips++; if(catHasSection) chipsWithSection++;
      const subRows = (subs || []).map((sub, subIdx) => {
        const fullChip = `${cat}: ${sub}`;
        const sk = sectionKeyOf(fullChip);
        const has = !sk.startsWith('misc__');
        totalChips++; if(has) chipsWithSection++;
        return `<tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:5px 8px;color:#475569;">
            <input type="text" value="${esc(sub)}" data-sub-edit="${catIdx}|${subIdx}" style="width:100%;padding:3px 6px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;"/>
          </td>
          <td style="padding:5px 8px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;font-size:10px;">${esc(sk)}${SECTION_LABELS[sk] ? ' <span style="color:#cbd5e1;">(' + esc(SECTION_LABELS[sk]) + ')</span>' : ''}</td>
          <td style="padding:5px 8px;font-size:11px;">${has ? '<span style="color:#15803d;">✓</span>' : '<span style="color:#b91c1c;">⚠ no section</span>'}</td>
          <td style="padding:5px 8px;text-align:right;">
            <button data-action="del-sub" data-cat="${catIdx}" data-sub="${subIdx}" title="Delete subtype" style="background:transparent;border:none;color:#b91c1c;cursor:pointer;font-size:14px;padding:0 4px;">✕</button>
          </td>
        </tr>`;
      }).join('');
      return `
      <details ${subs.length === 0 || !catHasSection ? 'open' : ''} style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;background:#fff;overflow:hidden;">
        <summary style="padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;flex:1;">
            <input type="text" value="${safeCat}" data-cat-edit="${catIdx}" onclick="event.stopPropagation()" style="font-size:13px;font-weight:700;color:#0f172a;padding:4px 8px;border:1px solid transparent;border-radius:4px;background:transparent;flex:1;max-width:280px;" onfocus="this.style.background='#fff';this.style.border='1px solid #cbd5e1';" onblur="this.style.background='transparent';this.style.border='1px solid transparent';"/>
            <span style="font-size:10px;color:${catHasSection?'#15803d':'#b91c1c'};font-weight:600;">${catHasSection ? '✓ section: ' + esc(catKey) : '⚠ no section'}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="font-size:11px;color:#64748b;">${subs.length} subtype${subs.length===1?'':'s'}</span>
            <button data-action="del-cat" data-cat="${catIdx}" onclick="event.stopPropagation()" title="Delete category" style="background:transparent;border:1px solid #fecaca;color:#b91c1c;cursor:pointer;font-size:11px;padding:3px 8px;border-radius:4px;">Delete</button>
          </div>
        </summary>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-size:10px;">
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Subtype</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Resolves to</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Status</th>
              <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #e2e8f0;width:36px;"></th>
            </tr>
          </thead>
          <tbody>
            ${subRows || '<tr><td colspan="4" style="padding:8px 12px;color:#94a3b8;font-style:italic;">No subtypes yet — add one below.</td></tr>'}
            <tr style="border-top:1px solid #e2e8f0;background:#f8fafc;">
              <td colspan="4" style="padding:6px 8px;">
                <input type="text" placeholder="New subtype name…" data-add-sub="${catIdx}" style="width:60%;padding:4px 8px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;"/>
                <button data-action="add-sub" data-cat="${catIdx}" style="background:#1a3a6e;color:#fff;border:none;padding:4px 12px;font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;margin-left:6px;">+ Add subtype</button>
              </td>
            </tr>
          </tbody>
        </table>
      </details>`;
    }).join('');

    const coverage = totalChips ? Math.round((chipsWithSection / totalChips) * 100) : 0;
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:1100px;width:96%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
        <div style="padding:16px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:16px;font-weight:700;color:#0f172a;">🗂 BC Asset Taxonomy</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">${Object.keys(taxonomy).length} categories · ${totalChips} chip variants · ${chipsWithSection}/${totalChips} resolve to a requirements section (${coverage}%) ${dirty ? '<span style="color:#b45309;font-weight:600;margin-left:8px;">● unsaved changes</span>' : ''}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button data-action="cancel" style="background:transparent;border:1px solid #cbd5e1;color:#64748b;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">Cancel</button>
            <button data-action="save" style="background:linear-gradient(135deg,#1a3a6e,#0e2244);color:#fff;border:none;padding:7px 18px;font-size:12px;font-weight:700;border-radius:8px;cursor:pointer;font-family:inherit;${dirty?'':'opacity:0.5;'}">${dirty ? '✓ Save changes' : 'No changes'}</button>
          </div>
        </div>
        <div style="flex:1;min-height:0;overflow:auto;padding:16px 22px;background:#f8fafc;">
          ${blocks || '<div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">No categories yet — add one below to start.</div>'}
          <div style="margin-top:14px;padding:12px;border:1.5px dashed #cbd5e1;border-radius:8px;background:#fff;display:flex;gap:8px;align-items:center;">
            <input type="text" placeholder="New category name (e.g. Entertainment)…" id="bcTaxNewCat" style="flex:1;padding:7px 10px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;"/>
            <button data-action="add-cat" style="background:#15803d;color:#fff;border:none;padding:7px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">+ Add category</button>
          </div>
        </div>
        <div style="padding:10px 22px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;background:#fff;">
          <strong style="color:#0f172a;">Note:</strong> Saving updates the picker (BC blank form + AI review modal) and the AI's vocabulary. Changes apply immediately for new BC opens / AI runs. Categories with "⚠ no section" still work as picker chips, but their requirements field section is missing — Phase 2 will let you author requirements fields here too.
        </div>
      </div>`;

    // Wire all event handlers (delegation).
    modal.onclick = (e) => {
      if(e.target === modal){
        if(dirty && !confirm('Discard unsaved taxonomy changes?')) return;
        modal.remove();
        return;
      }
      const t = e.target.closest('[data-action]');
      if(!t) return;
      const action = t.getAttribute('data-action');
      if(action === 'cancel'){
        if(dirty && !confirm('Discard unsaved taxonomy changes?')) return;
        modal.remove();
        return;
      }
      if(action === 'save'){
        if(!dirty) return;
        _bcTaxonomySave(taxonomy).then(() => {
          dirty = false;
          if(typeof showSaveConfirm === 'function') showSaveConfirm('✓ Taxonomy saved');
          render();
        }).catch(err => alert('Save failed: ' + (err.message || err)));
        return;
      }
      if(action === 'add-cat'){
        const inp = modal.querySelector('#bcTaxNewCat');
        const v = inp ? String(inp.value || '').trim() : '';
        if(!v) return;
        if(taxonomy[v]){ alert('Category already exists.'); return; }
        taxonomy[v] = [];
        dirty = true;
        render();
        return;
      }
      if(action === 'del-cat'){
        const idx = parseInt(t.getAttribute('data-cat'), 10);
        const cats = Object.keys(taxonomy);
        const cat = cats[idx];
        if(!cat) return;
        if(!confirm(`Delete category "${cat}" and its ${taxonomy[cat].length} subtypes? (Won't be saved until you click Save.)`)) return;
        delete taxonomy[cat];
        dirty = true;
        render();
        return;
      }
      if(action === 'del-sub'){
        const cIdx = parseInt(t.getAttribute('data-cat'), 10);
        const sIdx = parseInt(t.getAttribute('data-sub'), 10);
        const cat = Object.keys(taxonomy)[cIdx];
        if(!cat) return;
        taxonomy[cat] = (taxonomy[cat] || []).filter((_, i) => i !== sIdx);
        dirty = true;
        render();
        return;
      }
      if(action === 'add-sub'){
        const cIdx = parseInt(t.getAttribute('data-cat'), 10);
        const cat = Object.keys(taxonomy)[cIdx];
        if(!cat) return;
        const inp = modal.querySelector(`[data-add-sub="${cIdx}"]`);
        const v = inp ? String(inp.value || '').trim() : '';
        if(!v) return;
        if((taxonomy[cat] || []).some(s => s.toLowerCase() === v.toLowerCase())){ alert('Subtype already exists.'); return; }
        taxonomy[cat] = (taxonomy[cat] || []).concat([v]);
        dirty = true;
        render();
        return;
      }
    };
    // Inline-edit handlers for the rename inputs.
    modal.oninput = (e) => {
      const t = e.target;
      if(t.matches('[data-cat-edit]')){
        const idx = parseInt(t.getAttribute('data-cat-edit'), 10);
        const oldCat = Object.keys(taxonomy)[idx];
        const newCat = String(t.value || '').trim();
        if(!newCat || newCat === oldCat) return;
        // Rebuild taxonomy preserving order.
        const next = {};
        for(const [k, v] of Object.entries(taxonomy)){
          next[k === oldCat ? newCat : k] = v;
        }
        // Reassign without re-rendering (would lose focus).
        for(const k in taxonomy) delete taxonomy[k];
        Object.assign(taxonomy, next);
        dirty = true;
        // Update header tally without rerender — minimum fuss.
        const dirtyMark = modal.querySelector('div[style*="margin-top:2px"]');
        if(dirtyMark && !/unsaved/.test(dirtyMark.innerHTML)) dirtyMark.innerHTML += ' <span style="color:#b45309;font-weight:600;margin-left:8px;">● unsaved changes</span>';
      } else if(t.matches('[data-sub-edit]')){
        const [cIdxStr, sIdxStr] = String(t.getAttribute('data-sub-edit')).split('|');
        const cIdx = parseInt(cIdxStr, 10);
        const sIdx = parseInt(sIdxStr, 10);
        const cat = Object.keys(taxonomy)[cIdx];
        if(!cat || !taxonomy[cat]) return;
        const newSub = String(t.value || '').trim();
        if(!newSub) return;
        taxonomy[cat][sIdx] = newSub;
        dirty = true;
      }
    };
  }

  document.body.appendChild(modal);
  render();
}
