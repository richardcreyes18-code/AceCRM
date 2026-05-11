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

// ─── Usage scanning ───────────────────────────────────────────────────
//
// v320: scans ace_buyer_criteria.desired_property_types and
// ace_properties.crm_asset_classification (+ property_type_text fallback)
// to count which chips are actually in use. Powers the count badges,
// the "view tagged" click-through, and the safe-delete-with-reassign
// flow in the taxonomy admin.

// Normalize a chip token for matching (lowercase + collapsed whitespace).
function _normChip(s){
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Split a multi-chip field value (BC uses commas, deals use pipes) into
// individual chip strings. Returns an array of trimmed non-empty tokens.
function _splitChips(val, sep){
  if(val == null) return [];
  return String(val).split(sep).map(s => s.trim()).filter(Boolean);
}

// Build a usage report for the taxonomy admin. Returns:
//   {
//     bcsByChip:    Map<lowercaseChip, Array<{id, name, value}>>,
//     dealsByChip:  Map<lowercaseChip, Array<{id, address, value}>>,
//   }
// Each value array holds the records tagged with that chip. Use
// .length for counts, render the rows for the view-tagged modal.
async function _bcTaxonomyLoadUsage(){
  const out = { bcsByChip: new Map(), dealsByChip: new Map() };
  // Pull both populations in parallel.
  const tbl = (window.SB_TABLES && window.SB_TABLES.buyerCriteria) || 'ace_buyer_criteria';
  const propTbl = (window.SB_TABLES && window.SB_TABLES.properties) || 'ace_properties';
  let bcRows = [], dealRows = [];
  try {
    [bcRows, dealRows] = await Promise.all([
      _sbGet(tbl, 'desired_property_types=not.is.null&select=id,contact_id,desired_property_types&limit=10000').catch(() => []),
      _sbGet(propTbl, 'select=id,address,crm_asset_classification,property_type_text&limit=20000').catch(() => []),
    ]);
  } catch(e){ console.warn('[bc-taxonomy] usage load failed:', e.message); }

  // Need contact names for BC rows so the view-tagged modal is useful.
  const contactIds = [...new Set((bcRows || []).map(r => r.contact_id).filter(Boolean))];
  const contactsById = new Map();
  if(contactIds.length){
    const CHUNK = 100;
    for(let i = 0; i < contactIds.length; i += CHUNK){
      const chunk = contactIds.slice(i, i + CHUNK);
      try {
        const cs = await _sbGet('ace_contacts', `id=in.(${chunk.join(',')})&select=id,name`);
        for(const c of (cs || [])){ contactsById.set(c.id, c.name || ''); }
      } catch(e){ /* skip */ }
    }
  }

  for(const r of (bcRows || [])){
    const chips = _splitChips(r.desired_property_types, ',');
    for(const chip of chips){
      const key = _normChip(chip);
      if(!key) continue;
      const list = out.bcsByChip.get(key) || [];
      list.push({
        id: r.id,
        contactId: r.contact_id,
        name: contactsById.get(r.contact_id) || '(no name)',
        value: chip,
      });
      out.bcsByChip.set(key, list);
    }
  }
  for(const r of (dealRows || [])){
    // Deals use pipe-joined CRM Asset Classification; fall back to
    // property_type_text (comma-joined) when classification is empty.
    const chips = r.crm_asset_classification
      ? _splitChips(r.crm_asset_classification, '|')
      : _splitChips(r.property_type_text, ',');
    for(const chip of chips){
      const key = _normChip(chip);
      if(!key) continue;
      const list = out.dealsByChip.get(key) || [];
      list.push({ id: r.id, address: r.address || '(no address)', value: chip });
      out.dealsByChip.set(key, list);
    }
  }
  return out;
}

// Look up tagged records for a category. Returns array of {bcs, deals}
// joined into a flat list so the view-tagged modal can show both.
function _usageForChip(usage, chipText){
  const key = _normChip(chipText);
  return {
    bcs:   usage.bcsByChip.get(key)   || [],
    deals: usage.dealsByChip.get(key) || [],
  };
}

// Count helper.
function _usageCount(usage, chipText){
  const u = _usageForChip(usage, chipText);
  return { bcs: u.bcs.length, deals: u.deals.length, total: u.bcs.length + u.deals.length };
}

// Render a small count chip used inline next to taxonomy rows.
function _countBadgeHTML(usage, chipText){
  const c = _usageCount(usage, chipText);
  if(c.total === 0){
    return `<span title="No BCs or deals tagged with this chip" style="font-size:10px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;padding:1px 6px;border-radius:99px;background:#f1f5f9;border:1px solid #e2e8f0;">0</span>`;
  }
  const parts = [];
  if(c.bcs) parts.push(`<span style="color:#1e40af;">${c.bcs} BC${c.bcs===1?'':'s'}</span>`);
  if(c.deals) parts.push(`<span style="color:#15803d;">${c.deals} deal${c.deals===1?'':'s'}</span>`);
  return `<span data-action="view-usage" data-chip="${esc(chipText)}" title="Click to view tagged BCs / deals" style="font-size:10px;font-family:ui-monospace,Menlo,monospace;padding:1px 6px;border-radius:99px;background:#eff6ff;border:1px solid #bfdbfe;cursor:pointer;">${parts.join(' · ')}</span>`;
}

// View-tagged modal — opens on top of the taxonomy admin. Read-only
// list of every BC + deal tagged with the chip. Each row has an
// "Open" link that navigates to the record.
function _openViewTaggedModal(chipText, usage){
  const u = _usageForChip(usage, chipText);
  const total = u.bcs.length + u.deals.length;
  const modal = document.createElement('div');
  modal.id = 'bcTaxViewTaggedModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';
  modal.onclick = (e) => { if(e.target === modal) modal.remove(); };
  const bcRows = u.bcs.map(r => `
    <tr style="border-top:1px solid #f1f5f9;">
      <td style="padding:6px 12px;color:#0f172a;font-weight:600;">${esc(r.name)}</td>
      <td style="padding:6px 12px;color:#475569;">${esc(r.value)}</td>
      <td style="padding:6px 12px;text-align:right;">
        <button onclick="document.getElementById('bcTaxViewTaggedModal')?.remove();document.getElementById('bcTaxonomyAdminModal')?.remove();if(typeof bcOpenExpanded==='function')bcOpenExpanded('${esc(r.id)}');" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#0f172a;padding:3px 10px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">Open BC →</button>
      </td>
    </tr>`).join('');
  const dealRows = u.deals.map(r => `
    <tr style="border-top:1px solid #f1f5f9;">
      <td style="padding:6px 12px;color:#0f172a;font-weight:600;">${esc(r.address)}</td>
      <td style="padding:6px 12px;color:#475569;">${esc(r.value)}</td>
      <td style="padding:6px 12px;text-align:right;">
        <button onclick="document.getElementById('bcTaxViewTaggedModal')?.remove();document.getElementById('bcTaxonomyAdminModal')?.remove();if(typeof openDeal==='function')openDeal('${esc(r.id)}');" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#0f172a;padding:3px 10px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">Open Deal →</button>
      </td>
    </tr>`).join('');
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:900px;width:96%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
      <div style="padding:16px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div>
          <div style="font-size:16px;font-weight:700;color:#0f172a;">Tagged with "${esc(chipText)}"</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;">${u.bcs.length} BC${u.bcs.length===1?'':'s'} · ${u.deals.length} deal${u.deals.length===1?'':'s'} · ${total} total</div>
        </div>
        <button onclick="document.getElementById('bcTaxViewTaggedModal')?.remove();" style="background:transparent;border:1px solid #cbd5e1;color:#64748b;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">Close</button>
      </div>
      <div style="flex:1;overflow:auto;padding:0;">
        ${u.bcs.length ? `
          <div style="padding:10px 22px;background:#eff6ff;font-size:11px;font-weight:700;color:#1e40af;text-transform:uppercase;letter-spacing:.06em;">Buyer Criteria (${u.bcs.length})</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-size:10px;">
                <th style="padding:7px 12px;text-align:left;border-bottom:1px solid #e2e8f0;">Contact</th>
                <th style="padding:7px 12px;text-align:left;border-bottom:1px solid #e2e8f0;">Tag value</th>
                <th style="padding:7px 12px;text-align:right;border-bottom:1px solid #e2e8f0;"></th>
              </tr>
            </thead>
            <tbody>${bcRows}</tbody>
          </table>` : ''}
        ${u.deals.length ? `
          <div style="padding:10px 22px;background:#f0fdf4;font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.06em;">Deals (${u.deals.length})</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-size:10px;">
                <th style="padding:7px 12px;text-align:left;border-bottom:1px solid #e2e8f0;">Address</th>
                <th style="padding:7px 12px;text-align:left;border-bottom:1px solid #e2e8f0;">Tag value</th>
                <th style="padding:7px 12px;text-align:right;border-bottom:1px solid #e2e8f0;"></th>
              </tr>
            </thead>
            <tbody>${dealRows}</tbody>
          </table>` : ''}
        ${total === 0 ? `<div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">No BCs or deals tagged with this chip — safe to delete.</div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// Reassign-before-delete flow. When a chip with usage is targeted for
// deletion, this modal lists the affected records + a replacement
// picker. On confirm: every BC's desired_property_types is rewritten
// to swap chipText → replacementChip (or remove if "(delete chip
// without replacement)" is picked), every deal's crm_asset_classification
// gets the same treatment, then resolve(true) so the caller can drop
// the chip from the taxonomy. Resolve(false) on cancel.
function _openReassignModal(chipText, usage, taxonomy){
  return new Promise(resolve => {
    const u = _usageForChip(usage, chipText);
    const total = u.bcs.length + u.deals.length;
    if(total === 0){ resolve(true); return; }
    const modal = document.createElement('div');
    modal.id = 'bcTaxReassignModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';
    // Build replacement picker — every chip in taxonomy EXCEPT the one
    // being deleted. Includes both bare categories and Category: Subtype.
    const candidates = [];
    for(const [cat, subs] of Object.entries(taxonomy || {})){
      if(_normChip(cat) !== _normChip(chipText)) candidates.push(cat);
      for(const sub of (subs || [])){
        const fullChip = `${cat}: ${sub}`;
        if(_normChip(fullChip) !== _normChip(chipText)) candidates.push(fullChip);
      }
    }
    candidates.sort((a, b) => a.localeCompare(b));
    const options = candidates.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:640px;width:96%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
        <div style="padding:16px 22px;border-bottom:1px solid #e2e8f0;">
          <div style="font-size:16px;font-weight:700;color:#0f172a;">Reassign before delete</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;line-height:1.5;">
            <strong>"${esc(chipText)}"</strong> is tagged on ${u.bcs.length} BC${u.bcs.length===1?'':'s'} and ${u.deals.length} deal${u.deals.length===1?'':'s'}. Pick a replacement chip and click "Reassign &amp; delete" — every tagged record will be rewritten before the chip is removed.
          </div>
        </div>
        <div style="flex:1;overflow:auto;padding:16px 22px;">
          <div style="font-size:11px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Replace with</div>
          <select id="bcTaxReassignPick" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:inherit;background:#fff;margin-bottom:14px;">
            <option value="__remove__">— Remove the chip without replacement (records lose this tag entirely) —</option>
            ${options}
          </select>
          <div style="font-size:11px;color:#64748b;line-height:1.5;background:#fef9c3;border:1px solid #fde68a;padding:10px 12px;border-radius:6px;">
            <strong style="color:#854d0e;">Heads up:</strong> this rewrites <strong>${total}</strong> live record${total===1?'':'s'} in the database. Cannot be undone in bulk — you'd have to revert each record manually. Make sure the replacement chip is a sensible substitute, or pick "Remove without replacement" if the chip is genuinely meaningless.
          </div>
        </div>
        <div style="padding:14px 22px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button id="bcTaxReassignCancel" style="background:transparent;border:1px solid #cbd5e1;color:#64748b;padding:8px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">Cancel</button>
          <button id="bcTaxReassignGo" style="background:#b91c1c;color:#fff;border:none;padding:8px 18px;font-size:12px;font-weight:700;border-radius:8px;cursor:pointer;font-family:inherit;">Reassign &amp; delete</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const cleanup = () => modal.remove();
    modal.querySelector('#bcTaxReassignCancel').onclick = () => { cleanup(); resolve(false); };
    modal.querySelector('#bcTaxReassignGo').onclick = async () => {
      const pick = modal.querySelector('#bcTaxReassignPick').value;
      const goBtn = modal.querySelector('#bcTaxReassignGo');
      goBtn.disabled = true; goBtn.textContent = 'Rewriting…';
      try {
        await _applyReassign(chipText, pick === '__remove__' ? null : pick, u);
        cleanup();
        resolve(true);
      } catch(e){
        alert('Reassign failed: ' + (e.message || e));
        goBtn.disabled = false; goBtn.textContent = 'Reassign & delete';
      }
    };
  });
}

// Actually rewrite the tagged records. For each BC: split, swap or
// remove the chip, rejoin, _sbPatch. Same for each deal but with
// pipe separators.
async function _applyReassign(oldChip, newChip, usage){
  const oldNorm = _normChip(oldChip);
  // BCs.
  for(const r of usage.bcs){
    try {
      const cur = await _sbGet('ace_buyer_criteria', `id=eq.${r.id}&select=desired_property_types&limit=1`);
      const val = (Array.isArray(cur) && cur[0]?.desired_property_types) || '';
      const chips = _splitChips(val, ',');
      const kept = [];
      for(const c of chips){
        if(_normChip(c) === oldNorm){
          if(newChip && !kept.some(k => _normChip(k) === _normChip(newChip))) kept.push(newChip);
        } else {
          if(!kept.some(k => _normChip(k) === _normChip(c))) kept.push(c);
        }
      }
      await _sbPatch('ace_buyer_criteria', r.id, { desired_property_types: kept.join(', ') });
    } catch(e){ console.warn('[bc-taxonomy] BC reassign failed for', r.id, e.message); }
  }
  // Deals — use pipe separator in crm_asset_classification.
  for(const r of usage.deals){
    try {
      const cur = await _sbGet('ace_properties', `id=eq.${r.id}&select=crm_asset_classification,property_type_text&limit=1`);
      const row = (Array.isArray(cur) && cur[0]) || {};
      const patch = {};
      if(row.crm_asset_classification){
        const chips = _splitChips(row.crm_asset_classification, '|');
        const kept = [];
        let touched = false;
        for(const c of chips){
          if(_normChip(c) === oldNorm){
            touched = true;
            if(newChip && !kept.some(k => _normChip(k) === _normChip(newChip))) kept.push(newChip);
          } else {
            if(!kept.some(k => _normChip(k) === _normChip(c))) kept.push(c);
          }
        }
        if(touched) patch.crm_asset_classification = kept.join(' | ');
      }
      if(row.property_type_text){
        const chips = _splitChips(row.property_type_text, ',');
        const kept = [];
        let touched = false;
        for(const c of chips){
          if(_normChip(c) === oldNorm){
            touched = true;
            if(newChip && !kept.some(k => _normChip(k) === _normChip(newChip))) kept.push(newChip);
          } else {
            if(!kept.some(k => _normChip(k) === _normChip(c))) kept.push(c);
          }
        }
        if(touched) patch.property_type_text = kept.join(', ');
      }
      if(Object.keys(patch).length){
        await _sbPatch('ace_properties', r.id, patch);
      }
    } catch(e){ console.warn('[bc-taxonomy] deal reassign failed for', r.id, e.message); }
  }
}

// ─── Admin modal ──────────────────────────────────────────────────────

export function _bcAssetTaxonomyAdmin(){
  const taxonomy = _clone(_bcTaxonomyGet());
  let dirty = false;
  let usage = { bcsByChip: new Map(), dealsByChip: new Map() };
  let usageLoading = true;

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
      // v321: synthetic row for the BARE category chip (e.g. "Multifamily"
      // with no subtype). Lots of legacy records are tagged at the
      // category level only; this surfaces them in the same table as
      // the subtypes so the agent can view + reassign them without
      // deleting the whole category. Label is read-only, no per-fields
      // button (handled by the header's 📋 Fields button), and the
      // delete is replaced with a Reassign-only action because removing
      // the bare chip = removing the category (which the header
      // already supports).
      const bareSk = sectionKeyOf(cat);
      const bareHas = !bareSk.startsWith('misc__');
      const bareUsage = _countBadgeHTML(usage, cat);
      const bareStatusHTML = bareHas
        ? '<span style="color:#15803d;" title="Built-in requirements fields section exists for this category — fields like Min Units / Class Preference render on the BC when this chip is added.">✓ Built-in fields</span>'
        : '<span style="color:#64748b;" title="Chip works in the BC picker, the AI vocab, and the buyer match — only the optional built-in requirements fields form is not defined for this section yet. You can still author per-chip fields via the 📋 Fields button.">ℹ Picker + AI · no built-in fields</span>';
      const bareRow = `<tr style="border-top:1px solid #f1f5f9;background:#fafbff;">
        <td style="padding:5px 8px;color:#94a3b8;font-style:italic;font-size:11px;">(no subtype — bare "${esc(cat)}")</td>
        <td style="padding:5px 8px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;font-size:10px;">${esc(bareSk)}${SECTION_LABELS[bareSk] ? ' <span style="color:#cbd5e1;">(' + esc(SECTION_LABELS[bareSk]) + ')</span>' : ''}</td>
        <td style="padding:5px 8px;font-size:11px;">${bareStatusHTML}</td>
        <td style="padding:5px 8px;text-align:left;">${bareUsage}</td>
        <td style="padding:5px 8px;text-align:right;white-space:nowrap;">
          <button data-action="reassign-bare" data-cat-name="${esc(cat)}" title="Reassign the records currently tagged with bare &quot;${esc(cat)}&quot; (no subtype) to a different chip. Category itself stays in the taxonomy — use the header's Delete button to remove it entirely." style="background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:4px;font-weight:600;">↪ Reassign</button>
        </td>
      </tr>`;
      const subRows = (subs || []).map((sub, subIdx) => {
        const fullChip = `${cat}: ${sub}`;
        const sk = sectionKeyOf(fullChip);
        const has = !sk.startsWith('misc__');
        totalChips++; if(has) chipsWithSection++;
        // v290: per-subtype custom-fields editor entry point. Same
        // _bcFieldsAdminForCategory call as the category-level button,
        // but the scope key is the full "Category: Subtype" chip text
        // so storage stays cleanly partitioned.
        const subFieldCount = (typeof window._bcFieldsGet === 'function')
          ? (window._bcFieldsGet(fullChip) || []).length : 0;
        const subUsage = _countBadgeHTML(usage, fullChip);
        // v322: status label reworded — "no section" was misleading.
        // The chip works fine in the picker AND the AI vocab regardless
        // of section status. What's actually conditional is whether a
        // per-category REQUIREMENTS FIELDS section renders on the BC
        // expanded form. has=true → built-in fields section renders;
        // has=false → no built-in fields, but custom fields via the
        // 📋 Fields button still work.
        const subStatusHTML = has
          ? '<span style="color:#15803d;" title="Built-in requirements fields section exists for this chip — fields like Min Units / Class Preference render on the BC when this chip is added.">✓ Built-in fields</span>'
          : '<span style="color:#64748b;" title="Chip works in the BC picker, the AI vocab, and the buyer match — only the optional built-in requirements fields form is not defined for this section yet. You can still author per-chip fields via the 📋 Fields button.">ℹ Picker + AI · no built-in fields</span>';
        return `<tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:5px 8px;color:#475569;">
            <input type="text" value="${esc(sub)}" data-sub-edit="${catIdx}|${subIdx}" style="width:100%;padding:3px 6px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;"/>
          </td>
          <td style="padding:5px 8px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;font-size:10px;">${esc(sk)}${SECTION_LABELS[sk] ? ' <span style="color:#cbd5e1;">(' + esc(SECTION_LABELS[sk]) + ')</span>' : ''}</td>
          <td style="padding:5px 8px;font-size:11px;">${subStatusHTML}</td>
          <td style="padding:5px 8px;text-align:left;">${subUsage}</td>
          <td style="padding:5px 8px;text-align:right;white-space:nowrap;">
            <button data-action="edit-sub-fields" data-cat-name="${esc(cat)}" data-sub-name="${esc(sub)}" title="Edit custom requirements fields for ${esc(fullChip)}" style="background:#ede9fe;border:1px solid #c4b5fd;color:#5b21b6;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:4px;font-weight:600;margin-right:4px;">📋${subFieldCount?` ${subFieldCount}`:''}</button>
            <button data-action="del-sub" data-cat="${catIdx}" data-sub="${subIdx}" data-chip="${esc(fullChip)}" title="Delete subtype" style="background:transparent;border:none;color:#b91c1c;cursor:pointer;font-size:14px;padding:0 4px;">✕</button>
          </td>
        </tr>`;
      }).join('');
      const catUsageBadge = _countBadgeHTML(usage, cat);
      return `
      <details ${subs.length === 0 || !catHasSection ? 'open' : ''} style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;background:#fff;overflow:hidden;">
        <summary style="padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;flex:1;">
            <input type="text" value="${safeCat}" data-cat-edit="${catIdx}" onclick="event.stopPropagation()" style="font-size:13px;font-weight:700;color:#0f172a;padding:4px 8px;border:1px solid transparent;border-radius:4px;background:transparent;flex:1;max-width:280px;" onfocus="this.style.background='#fff';this.style.border='1px solid #cbd5e1';" onblur="this.style.background='transparent';this.style.border='1px solid transparent';"/>
            <span title="${catHasSection ? 'Built-in requirements fields section exists — fields render on the BC when a chip from this category is added.' : 'Chip works in the BC picker, the AI vocab, and the buyer match — only the optional built-in requirements fields form is not defined for this category yet. Use the 📋 Fields button to author your own.'}" style="font-size:10px;color:${catHasSection?'#15803d':'#64748b'};font-weight:600;">${catHasSection ? '✓ built-in: ' + esc(catKey) : 'ℹ picker + AI · no built-in fields'}</span>
            ${catUsageBadge}
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="font-size:11px;color:#64748b;">${subs.length} subtype${subs.length===1?'':'s'}</span>
            ${(() => {
              // v288: per-category custom-fields editor entry point.
              // Reads the count via window._bcFieldsGet to give a hint
              // of how many extra fields are defined for this category.
              const fieldCount = (typeof window._bcFieldsGet === 'function')
                ? (window._bcFieldsGet(cat) || []).length : 0;
              return `<button data-action="edit-fields" data-cat-name="${esc(cat)}" onclick="event.stopPropagation()" title="Edit custom requirements fields for ${esc(cat)}" style="background:#ede9fe;border:1px solid #c4b5fd;color:#5b21b6;cursor:pointer;font-size:11px;padding:3px 10px;border-radius:4px;font-weight:600;">📋 Fields${fieldCount?` (${fieldCount})`:''}</button>`;
            })()}
            <button data-action="del-cat" data-cat="${catIdx}" data-chip="${esc(cat)}" onclick="event.stopPropagation()" title="Delete category" style="background:transparent;border:1px solid #fecaca;color:#b91c1c;cursor:pointer;font-size:11px;padding:3px 8px;border-radius:4px;">Delete</button>
          </div>
        </summary>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-size:10px;">
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Subtype</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Resolves to</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Status</th>
              <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e2e8f0;">Usage</th>
              <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #e2e8f0;width:36px;"></th>
            </tr>
          </thead>
          <tbody>
            ${bareRow}
            ${subRows || '<tr><td colspan="5" style="padding:8px 12px;color:#94a3b8;font-style:italic;">No subtypes yet — add one below.</td></tr>'}
            <tr style="border-top:1px solid #e2e8f0;background:#f8fafc;">
              <td colspan="5" style="padding:6px 8px;">
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
            <div style="font-size:11px;color:#64748b;margin-top:2px;">${Object.keys(taxonomy).length} categories · ${totalChips} chip variants · ${chipsWithSection}/${totalChips} have a built-in requirements fields section (${coverage}%). Every chip works in the picker + AI regardless. ${dirty ? '<span style="color:#b45309;font-weight:600;margin-left:8px;">● unsaved changes</span>' : ''}</div>
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
          <strong style="color:#0f172a;">Note:</strong> Saving updates the picker (BC blank form + AI review modal) and the AI's vocabulary. Changes apply immediately for new BC opens / AI runs. Every chip — including those marked "ℹ picker + AI · no built-in fields" — is fully usable: it shows up in the BC picker, the AI proposes it, and buyer-match searches find it. The only thing missing for "ℹ" chips is the hardcoded per-category <strong>requirements fields form</strong> (e.g. Multifamily's Min Units / Class Preference). You can still author custom requirements fields for any chip via the <span style="color:#5b21b6;font-weight:600;">📋 Fields</span> button.
        </div>
      </div>`;

  }

  // v289: attach delegated handlers ONCE in capture phase. Bubble-phase
  // attachment was getting blocked by inline `event.stopPropagation()`
  // on buttons inside <summary> (added so clicks didn't toggle the
  // <details>). Capture runs before the target's inline handler, so
  // stopPropagation in the bubble phase doesn't affect us.
  // Listeners are bound once outside render() — render() only rewrites
  // modal.innerHTML, so re-rendering doesn't stack duplicate listeners.
  modal.addEventListener('click', (e) => {
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
    if(action === 'edit-fields'){
      // v288: open the per-category fields admin modal. On close
      // (Save or Cancel) re-render the parent so the field-count
      // badge reflects the latest state.
      const cat = t.getAttribute('data-cat-name');
      if(!cat) return;
      if(typeof window._bcFieldsAdminForCategory === 'function'){
        window._bcFieldsAdminForCategory(cat, () => render());
      } else {
        alert('Fields admin not loaded yet.');
      }
      return;
    }
    if(action === 'edit-sub-fields'){
      // v290: per-subtype fields scope. Same fields-admin function but
      // the scope key is the full "Category: Subtype" chip text. Field
      // defs are stored under that exact key in
      // ace_ai_settings.bc_field_definitions.
      const cat = t.getAttribute('data-cat-name');
      const sub = t.getAttribute('data-sub-name');
      if(!cat || !sub) return;
      const scope = `${cat}: ${sub}`;
      if(typeof window._bcFieldsAdminForCategory === 'function'){
        window._bcFieldsAdminForCategory(scope, () => render());
      } else {
        alert('Fields admin not loaded yet.');
      }
      return;
    }
    if(action === 'view-usage'){
      const chip = t.getAttribute('data-chip');
      if(chip) _openViewTaggedModal(chip, usage);
      return;
    }
    if(action === 'reassign-bare'){
      // v321: reassign records tagged with the BARE category chip (no
      // subtype) to a different chip. Does NOT remove the category
      // itself — that's what the header's Delete button is for.
      const cat = t.getAttribute('data-cat-name');
      if(!cat) return;
      const count = _usageCount(usage, cat).total;
      if(count === 0){
        alert(`Nothing to reassign — no BCs or deals are tagged with bare "${cat}".`);
        return;
      }
      _openReassignModal(cat, usage, taxonomy).then(async ok => {
        if(!ok) return;
        try { usage = await _bcTaxonomyLoadUsage(); } catch(_) {}
        if(typeof showSaveConfirm === 'function') showSaveConfirm(`✓ Bare "${cat}" records reassigned`);
        render();
      });
      return;
    }
    if(action === 'del-cat'){
      const idx = parseInt(t.getAttribute('data-cat'), 10);
      const cats = Object.keys(taxonomy);
      const cat = cats[idx];
      if(!cat) return;
      // v320: also check usage across subtypes — deleting a category
      // implicitly orphans every "Category: Subtype" chip too. Sum up
      // category + all its subtypes for the confirmation.
      const subList = taxonomy[cat] || [];
      let totalTagged = _usageCount(usage, cat).total;
      for(const sub of subList) totalTagged += _usageCount(usage, `${cat}: ${sub}`).total;
      if(totalTagged === 0){
        if(!confirm(`Delete category "${cat}" and its ${subList.length} subtypes? No BCs or deals are tagged with these chips — safe to delete. (Won't be saved until you click Save.)`)) return;
        delete taxonomy[cat];
        dirty = true;
        render();
        return;
      }
      // Has usage — open the reassign modal scoped to the BARE category
      // chip. Subtype chips would need separate reassignment if the user
      // wants to be precise; for now, deleting a category with N
      // category-level taggings reassigns just those.
      _openReassignModal(cat, usage, taxonomy).then(async ok => {
        if(!ok) return;
        // After reassign succeeds, refetch usage so subsequent decisions
        // see the latest state, then drop the category from the cached
        // taxonomy.
        try { usage = await _bcTaxonomyLoadUsage(); } catch(_) {}
        delete taxonomy[cat];
        dirty = true;
        if(typeof showSaveConfirm === 'function') showSaveConfirm(`✓ "${cat}" reassigned; click Save to commit taxonomy change`);
        render();
      });
      return;
    }
    if(action === 'del-sub'){
      const cIdx = parseInt(t.getAttribute('data-cat'), 10);
      const sIdx = parseInt(t.getAttribute('data-sub'), 10);
      const cat = Object.keys(taxonomy)[cIdx];
      if(!cat) return;
      const sub = (taxonomy[cat] || [])[sIdx];
      if(!sub) return;
      const fullChip = `${cat}: ${sub}`;
      const count = _usageCount(usage, fullChip).total;
      if(count === 0){
        // No records tagged — drop immediately.
        taxonomy[cat] = (taxonomy[cat] || []).filter((_, i) => i !== sIdx);
        dirty = true;
        render();
        return;
      }
      // Has usage — open the reassign modal before allowing the drop.
      _openReassignModal(fullChip, usage, taxonomy).then(async ok => {
        if(!ok) return;
        try { usage = await _bcTaxonomyLoadUsage(); } catch(_) {}
        taxonomy[cat] = (taxonomy[cat] || []).filter((_, i) => i !== sIdx);
        dirty = true;
        if(typeof showSaveConfirm === 'function') showSaveConfirm(`✓ "${fullChip}" reassigned; click Save to commit taxonomy change`);
        render();
      });
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
  }, true);

  // Inline-edit handlers for rename inputs (capture phase, same reason).
  modal.addEventListener('input', (e) => {
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
      for(const k in taxonomy) delete taxonomy[k];
      Object.assign(taxonomy, next);
      dirty = true;
      // Update header tally without rerender so we don't lose focus.
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
  }, true);

  document.body.appendChild(modal);
  render();

  // v320: fetch usage counts in the background. First render shows
  // placeholder "0" chips for every row; once the usage promise
  // resolves we re-render with real counts. Non-fatal on failure —
  // taxonomy CRUD still works without the badges.
  _bcTaxonomyLoadUsage().then(u => {
    usage = u;
    usageLoading = false;
    render();
  }).catch(e => {
    usageLoading = false;
    console.warn('[bc-taxonomy] usage scan failed:', e.message);
  });
}
