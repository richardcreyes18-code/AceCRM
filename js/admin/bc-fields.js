// admin/bc-fields.js — runtime-editable per-category requirements fields.
//
// Phase 2 of the "audit page is the source of truth" refactor.
// Pairs with admin/bc-taxonomy.js (Phase 1).
//
// What this module owns:
//   - Loading per-category EXTRA field definitions from
//     ace_ai_settings (key='bc_field_definitions') at startup. Caches.
//   - Rendering those extra fields inline in the BC expanded view via
//     _bcRenderExtraFields(category, record). Collects values via
//     _bcCollectExtraFields(category) for save.
//   - The "Edit fields →" admin modal launched per-category from the
//     Phase-1 taxonomy admin (bc-taxonomy.js).
//
// Storage shape (ace_ai_settings.bc_field_definitions.value):
//   {
//     "Multifamily": [
//       { "col": "deal_size", "label": "Preferred deal size",
//         "type": "text", "hint": "e.g. $1M-$5M" },
//       ...
//     ],
//     "Agricultural": [
//       { "col": "ag_acreage_min", "label": "Min acreage",
//         "type": "number" },
//       ...
//     ]
//   }
//
// Storage of VALUES per-record: ace_buyer_criteria.extra_fields
// (JSONB column, added in v288). Keyed by field col → value. The
// hardcoded SB_BC_MAP'd columns are NOT touched by this module.
//
// What stays in legacy index.html (for now):
//   - bcExpandedAssetSection (the per-asset-class hardcoded section
//     renderer at ~line 30820). Phase 2 layers extra fields on top of
//     each section without rewriting it. Phase 3+ may migrate the
//     hardcoded sections themselves into this config.
//
// External deps via window.*:
//   - _sbGet / _sbPost / _sbPatch (core/supabase.js)
//   - showSaveConfirm (core/toast.js)

import { _sbGet, _sbPost, _sbPatch } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';

const TABLE = 'ace_ai_settings';
const KEY   = 'bc_field_definitions';

const FIELD_TYPES = ['text', 'number', 'boolean', 'enum', 'multienum'];

// Module-side cache of the active definitions + the row id (for upserts).
let _cache = null;     // { [category: string]: FieldDef[] }
let _rowId = null;     // ace_ai_settings.id when the row exists

// ─── Loader ───────────────────────────────────────────────────────────

export async function _bcFieldsLoad(){
  try {
    const rows = await _sbGet(TABLE, `key=eq.${encodeURIComponent(KEY)}&select=id,value&limit=1`);
    if(Array.isArray(rows) && rows[0]){
      _rowId = rows[0].id;
      const v = rows[0].value;
      if(v && typeof v === 'object' && !Array.isArray(v)){
        _cache = _normalize(v);
        console.log('[bc-fields] loaded extra-field defs for', Object.keys(_cache).length, 'categories');
        return _cache;
      }
    }
    // No row yet — start with an empty config.
    _cache = {};
    try {
      const inserted = await _sbPost(TABLE, {
        key: KEY,
        value: {},
        updated_at: new Date().toISOString(),
      });
      if(Array.isArray(inserted) && inserted[0]?.id) _rowId = inserted[0].id;
      else if(inserted && inserted.id) _rowId = inserted.id;
    } catch(e){ console.warn('[bc-fields] empty seed insert failed:', e.message); }
  } catch(e){
    console.warn('[bc-fields] load failed:', e.message);
    _cache = {};
  }
  return _cache;
}

export function _bcFieldsGet(category){
  if(!_cache) return [];
  if(!category) return _cache;
  if(category === META_KEY) return [];          // v292: meta key is not a scope
  if(category === NATIVE_META_KEY) return [];   // v294: meta key is not a scope
  return Array.isArray(_cache[category]) ? _cache[category].slice() : [];
}

// v294: per-scope native-field overrides ({ col: { hidden?, label?, hint? } }).
// Getter returns a shallow clone so callers can safely mutate.
export function _bcNativeOverridesGet(scope){
  const meta = (_cache && _cache[NATIVE_META_KEY]) || {};
  const perScope = meta[scope] || {};
  const clone = {};
  for(const [k, v] of Object.entries(perScope)) clone[k] = { ...v };
  return clone;
}

// Setter merges + saves. Pass `null` for a col's value to delete that
// override (revert to hardcoded defaults). Pass {} for an override
// object to clear it.
export async function _bcNativeOverridesSet(scope, perScopeOverrides){
  if(!_cache) _cache = {};
  if(!_cache[NATIVE_META_KEY] || typeof _cache[NATIVE_META_KEY] !== 'object' || Array.isArray(_cache[NATIVE_META_KEY])){
    _cache[NATIVE_META_KEY] = {};
  }
  const cleanPerScope = {};
  for(const [col, ov] of Object.entries(perScopeOverrides || {})){
    if(!ov || typeof ov !== 'object') continue;
    const out = {};
    if(ov.hidden === true) out.hidden = true;
    if(typeof ov.label === 'string' && ov.label.trim()) out.label = ov.label.trim();
    if(typeof ov.hint  === 'string' && ov.hint.trim())  out.hint  = ov.hint.trim();
    if(Object.keys(out).length) cleanPerScope[col] = out;
  }
  if(Object.keys(cleanPerScope).length){
    _cache[NATIVE_META_KEY][scope] = cleanPerScope;
  } else {
    delete _cache[NATIVE_META_KEY][scope];
  }
  return _bcFieldsSave(_cache);
}

// v292: per-scope Other Notes settings. Defaults to enabled=true with
// the standard placeholder when nothing is configured.
export function _bcOtherNotesGet(scope){
  const meta = (_cache && _cache[META_KEY]) || {};
  const cfg  = meta[scope] || {};
  return {
    enabled:     cfg.enabled === false ? false : true,
    placeholder: typeof cfg.placeholder === 'string' && cfg.placeholder.trim()
                   ? cfg.placeholder
                   : OTHER_NOTES_DEFAULT_PLACEHOLDER,
  };
}

export async function _bcOtherNotesSet(scope, cfg){
  if(!_cache) _cache = {};
  if(!_cache[META_KEY] || typeof _cache[META_KEY] !== 'object' || Array.isArray(_cache[META_KEY])){
    _cache[META_KEY] = {};
  }
  _cache[META_KEY][scope] = {
    enabled:     cfg && cfg.enabled === false ? false : true,
    placeholder: cfg && typeof cfg.placeholder === 'string' ? cfg.placeholder : '',
  };
  return _bcFieldsSave(_cache);
}

export async function _bcFieldsSave(definitions){
  const clean = _normalize(definitions);
  const payload = { key: KEY, value: clean, updated_at: new Date().toISOString() };
  if(_rowId){
    await _sbPatch(TABLE, _rowId, payload);
  } else {
    const inserted = await _sbPost(TABLE, payload);
    if(Array.isArray(inserted) && inserted[0]?.id) _rowId = inserted[0].id;
    else if(inserted && inserted.id) _rowId = inserted.id;
  }
  _cache = clean;
  return clean;
}

// ─── Internal helpers ─────────────────────────────────────────────────

// v292: storage shape can include a special `_other_notes` meta key
// alongside the per-scope field arrays. Shape:
//   {
//     "Multifamily": [...fields],
//     "Multifamily: Garden": [...fields],
//     "_other_notes": {
//       "Multifamily": { "enabled": true, "placeholder": "Anything else MF-specific..." },
//       "Multifamily: Garden": { "enabled": false }
//     },
//     "_native_overrides": {                                // v294 (Phase 4b)
//       "Multifamily": {
//         "mf_min_units":         { "label": "Minimum Units" },
//         "mf_max_price_per_unit":{ "hidden": true }
//       }
//     }
//   }
// Normalize preserves the meta keys untouched while still validating field
// arrays. Getters skip the meta keys when iterating scopes.
const META_KEY = '_other_notes';
const NATIVE_META_KEY = '_native_overrides';   // v294
const OTHER_NOTES_DEFAULT_PLACEHOLDER = 'Anything else specific to this asset class…';

function _normalize(defs){
  const out = {};
  for(const [rawCat, rawList] of Object.entries(defs || {})){
    const cat = String(rawCat || '').trim();
    if(!cat) continue;
    if(cat === NATIVE_META_KEY){
      // v294: per-scope native-field overrides — { scope: { col: { hidden?, label?, hint? } } }
      const meta = (rawList && typeof rawList === 'object' && !Array.isArray(rawList)) ? rawList : {};
      const cleanMeta = {};
      for(const [scope, perScopeRaw] of Object.entries(meta)){
        const scopeKey = String(scope || '').trim();
        if(!scopeKey) continue;
        const perScope = (perScopeRaw && typeof perScopeRaw === 'object' && !Array.isArray(perScopeRaw)) ? perScopeRaw : {};
        const cleanPerScope = {};
        for(const [colRaw, ovRaw] of Object.entries(perScope)){
          const col = String(colRaw || '').trim();
          if(!col) continue;
          const ov = (ovRaw && typeof ovRaw === 'object' && !Array.isArray(ovRaw)) ? ovRaw : {};
          const ovOut = {};
          if(ov.hidden === true) ovOut.hidden = true;
          if(typeof ov.label === 'string' && ov.label.trim()) ovOut.label = ov.label.trim();
          if(typeof ov.hint  === 'string' && ov.hint.trim())  ovOut.hint  = ov.hint.trim();
          // v295: enum options override — array of strings, deduped + trimmed.
          if(Array.isArray(ov.options)){
            const seen = new Set();
            const opts = [];
            for(const o of ov.options){
              const s = String(o || '').trim();
              if(!s) continue;
              const k = s.toLowerCase();
              if(seen.has(k)) continue;
              seen.add(k); opts.push(s);
            }
            if(opts.length) ovOut.options = opts;
          }
          if(Object.keys(ovOut).length) cleanPerScope[col] = ovOut;
        }
        if(Object.keys(cleanPerScope).length) cleanMeta[scopeKey] = cleanPerScope;
      }
      out[NATIVE_META_KEY] = cleanMeta;
      continue;
    }
    if(cat === META_KEY){
      // Preserve the meta object as-is, with light shape validation.
      const meta = (rawList && typeof rawList === 'object' && !Array.isArray(rawList))
        ? rawList : {};
      const cleanMeta = {};
      for(const [scope, cfg] of Object.entries(meta)){
        const scopeKey = String(scope || '').trim();
        if(!scopeKey) continue;
        const c = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
        cleanMeta[scopeKey] = {
          enabled:     c.enabled === false ? false : true,
          placeholder: typeof c.placeholder === 'string' ? c.placeholder : '',
        };
      }
      out[META_KEY] = cleanMeta;
      continue;
    }
    const list = (Array.isArray(rawList) ? rawList : [])
      .map(_normalizeField)
      .filter(Boolean);
    out[cat] = list;
  }
  return out;
}

function _normalizeField(f){
  if(!f || typeof f !== 'object') return null;
  const col = String(f.col || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if(!col) return null;
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
  const out = {
    col,
    label: String(f.label || col).trim(),
    type,
    hint:  String(f.hint || '').trim(),
  };
  if(type === 'enum' || type === 'multienum'){
    out.options = (Array.isArray(f.options) ? f.options : [])
      .map(s => String(s || '').trim())
      .filter(Boolean);
  }
  if(typeof f.sort_order === 'number') out.sort_order = f.sort_order;
  return out;
}

function esc(s){
  return String(s==null?'':s).replace(/[<&>"]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;'}[c]));
}

// ─── BC form integration ──────────────────────────────────────────────

// Returns HTML for the extra fields of a given chip text, pre-filled
// from record.extra_fields. Slots into bcExpandedAssetSection after
// the hardcoded fields.
//
// chipText accepts EITHER a bare category ("Multifamily") or a full
// "Category: Subtype" chip ("Multifamily: Garden/Low Rise"). When the
// chip names a subtype, BOTH the category-level fields AND any
// subtype-specific fields render, in that order — category-level first,
// subtype below. v290.
//
// Input ids are namespaced "bcf_extra_<scope-slug>_<col>" so the
// collector can disambiguate even when category + subtype define the
// same column key (last writer in DOM wins for collection).
export function _bcRenderExtraFields(chipText, record){
  const chip = String(chipText || '').trim();
  if(!chip) return '';
  const colonIdx = chip.indexOf(':');
  const category = colonIdx > 0 ? chip.slice(0, colonIdx).trim() : chip;
  const subtype  = colonIdx > 0 ? chip.slice(colonIdx + 1).trim() : '';
  const fullKey  = subtype ? `${category}: ${subtype}` : '';

  const catDefs = _bcFieldsGet(category) || [];
  const subDefs = fullKey ? (_bcFieldsGet(fullKey) || []) : [];
  if(!catDefs.length && !subDefs.length) return '';

  const extra = (record?.extra_fields && typeof record.extra_fields === 'object')
    ? record.extra_fields
    : {};

  const block = (scopeLabel, scopeKey, defs) => {
    const slug = _categorySlug(scopeKey);
    const onCfg = _bcOtherNotesGet(scopeKey);
    // v292: render the block when EITHER custom fields exist OR the
    // Other Notes textarea is enabled for this scope. Skip entirely
    // only when both are absent.
    if(!defs.length && !onCfg.enabled) return '';
    const rows = defs.map(d => {
      const id  = `bcf_extra_${slug}_${d.col}`;
      const val = extra[d.col];
      return _renderFieldRow(d, id, val);
    }).join('');
    // v292: standard "Other Notes" textarea, configurable per scope.
    // Stored under extra_fields[`other_notes_${slug}`] so each scope
    // has its own bucket (no clobber across categories/subtypes).
    let otherNotesHtml = '';
    if(onCfg.enabled){
      const onCol = `other_notes_${slug}`;
      const onId  = `bcf_extra_${slug}_${onCol}`;
      const onVal = (extra[onCol] === 0 || extra[onCol]) ? String(extra[onCol]) : '';
      otherNotesHtml = `
        <div data-extra-field="${esc(onCol)}" data-extra-type="text" style="grid-column:span 2;margin-top:6px;">
          <label for="${esc(onId)}" style="font-size:11px;color:#475569;font-weight:600;display:block;margin-bottom:3px;">📝 Other Notes</label>
          <textarea id="${esc(onId)}" rows="3" placeholder="${esc(onCfg.placeholder)}" style="border:1px solid #cbd5e1;border-radius:6px;padding:6px 9px;font-size:12px;width:100%;box-sizing:border-box;font-family:inherit;resize:vertical;">${esc(onVal)}</textarea>
        </div>`;
    }
    const summaryParts = [];
    if(defs.length)      summaryParts.push(`${defs.length} field${defs.length===1?'':'s'}`);
    if(onCfg.enabled)    summaryParts.push('+ other notes');
    return `
      <div class="info-box" data-bc-extra-section="${esc(slug)}" style="margin-top:10px;border:1px dashed #c0d0e8;background:#fbfdff;">
        <div class="info-box-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>${esc(scopeLabel)} — Custom Requirements</span>
          <span style="font-size:9px;color:#94a3b8;font-weight:500;">${summaryParts.join(' · ')}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;">
          ${rows}
          ${otherNotesHtml}
        </div>
      </div>`;
  };
  return [
    block(category, category, catDefs),
    block(fullKey, fullKey, subDefs),
  ].join('');
}

function _renderFieldRow(d, id, val){
  const labelHtml = `<label for="${id}" style="font-size:11px;color:#475569;font-weight:600;display:block;margin-bottom:3px;">${esc(d.label)}</label>`;
  const hintHtml  = d.hint ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">${esc(d.hint)}</div>` : '';
  const baseInput = `border:1px solid #cbd5e1;border-radius:6px;padding:6px 9px;font-size:12px;width:100%;box-sizing:border-box;font-family:inherit;`;
  if(d.type === 'boolean'){
    const v = val === true || val === 'true';
    return `<div data-extra-field="${esc(d.col)}" data-extra-type="boolean">${labelHtml}<select id="${esc(id)}" style="${baseInput}"><option value="">—</option><option value="true" ${v?'selected':''}>Yes</option><option value="false" ${val===false||val==='false'?'selected':''}>No</option></select>${hintHtml}</div>`;
  }
  if(d.type === 'number'){
    const v = (val === 0 || val) ? String(val) : '';
    return `<div data-extra-field="${esc(d.col)}" data-extra-type="number">${labelHtml}<input id="${esc(id)}" type="number" value="${esc(v)}" placeholder="${esc(d.hint || '')}" style="${baseInput}"/>${hintHtml}</div>`;
  }
  if(d.type === 'enum'){
    const opts = Array.isArray(d.options) ? d.options : [];
    const sel = String(val == null ? '' : val);
    return `<div data-extra-field="${esc(d.col)}" data-extra-type="enum">${labelHtml}<select id="${esc(id)}" style="${baseInput}"><option value="">—</option>${opts.map(o => `<option value="${esc(o)}" ${o===sel?'selected':''}>${esc(o)}</option>`).join('')}</select>${hintHtml}</div>`;
  }
  if(d.type === 'multienum'){
    const opts = Array.isArray(d.options) ? d.options : [];
    const selSet = new Set(
      Array.isArray(val) ? val.map(String) :
      (typeof val === 'string' ? val.split(/[,;]/).map(s => s.trim()).filter(Boolean) : [])
    );
    const chips = opts.map(o => {
      const isSel = selSet.has(o);
      return `<label style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font-size:10px;border:1px solid ${isSel?'#7c3aed':'#cbd5e1'};background:${isSel?'#ede9fe':'#fff'};color:${isSel?'#5b21b6':'#475569'};border-radius:99px;cursor:pointer;font-weight:${isSel?'600':'500'};margin:1px;"><input type="checkbox" value="${esc(o)}" ${isSel?'checked':''} style="margin:0;display:none;" onchange="this.parentElement.style.background=this.checked?'#ede9fe':'#fff';this.parentElement.style.color=this.checked?'#5b21b6':'#475569';this.parentElement.style.borderColor=this.checked?'#7c3aed':'#cbd5e1';this.parentElement.style.fontWeight=this.checked?'600':'500';"/>${esc(o)}</label>`;
    }).join('');
    return `<div data-extra-field="${esc(d.col)}" data-extra-type="multienum" id="${esc(id)}-chips" style="grid-column:span 2;">${labelHtml}<div style="display:flex;flex-wrap:wrap;">${chips}</div>${hintHtml}</div>`;
  }
  // Default: text
  const v = (val === 0 || val) ? String(val) : '';
  return `<div data-extra-field="${esc(d.col)}" data-extra-type="text">${labelHtml}<input id="${esc(id)}" type="text" value="${esc(v)}" placeholder="${esc(d.hint || '')}" style="${baseInput}"/>${hintHtml}</div>`;
}

function _categorySlug(cat){
  return String(cat || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Walks the DOM under any [data-bc-extra-section] containers, collects
// field values, returns a single object keyed by col. Caller merges
// this into the BC's extra_fields JSONB on save.
export function _bcCollectExtraFields(){
  const out = {};
  const containers = document.querySelectorAll('[data-bc-extra-section]');
  containers.forEach(container => {
    container.querySelectorAll('[data-extra-field]').forEach(host => {
      const col = host.getAttribute('data-extra-field');
      const type = host.getAttribute('data-extra-type') || 'text';
      if(!col) return;
      if(type === 'multienum'){
        const checked = Array.from(host.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
        out[col] = checked;
        return;
      }
      const inp = host.querySelector('input,select,textarea');
      if(!inp) return;
      const raw = String(inp.value ?? '').trim();
      if(type === 'boolean'){
        if(raw === '') out[col] = null;
        else out[col] = raw === 'true';
      } else if(type === 'number'){
        if(raw === '') out[col] = null;
        else { const n = Number(raw.replace(/[^\d.\-]/g, '')); out[col] = isFinite(n) ? n : null; }
      } else {
        out[col] = raw === '' ? null : raw;
      }
    });
  });
  return out;
}

// ─── Per-category fields admin modal ──────────────────────────────────

// Opened from the taxonomy admin's "Edit fields →" button per category.
// Closes back to the taxonomy admin (caller is responsible for re-rendering).
export function _bcFieldsAdminForCategory(category, onClose){
  const defs = (_bcFieldsGet(category) || []).slice();
  // v292: per-scope Other Notes settings — local copy that the modal
  // mutates inline; persisted on Save alongside the field defs.
  const otherNotes = { ..._bcOtherNotesGet(category) };
  // v294: per-scope native-field overrides. Subtype scopes share with
  // the parent category — bare-category scope holds the overrides.
  const isSubtypeScope = String(category || '').includes(':');
  const nativeOverrideScope = isSubtypeScope ? category.split(':')[0].trim() : category;
  const nativeOverrides = _bcNativeOverridesGet(nativeOverrideScope);
  let dirty = false;

  const modal = document.createElement('div');
  modal.id = 'bcFieldsAdminModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';
  modal.onclick = (e) => {
    if(e.target !== modal) return;
    if(dirty && !confirm('Discard unsaved field changes?')) return;
    modal.remove();
    if(typeof onClose === 'function') onClose();
  };

  function rerender(){
    const list = defs.map((d, idx) => {
      const optsHtml = (d.type === 'enum' || d.type === 'multienum')
        ? `<div style="grid-column:span 2;">
             <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Options (one per line)</label>
             <textarea data-field-edit="${idx}" data-prop="options" rows="3" style="width:100%;padding:6px 9px;font-size:11px;border:1px solid #cbd5e1;border-radius:6px;font-family:ui-monospace,Menlo,monospace;">${esc((d.options || []).join('\n'))}</textarea>
           </div>`
        : '';
      return `
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:10px;background:#fff;">
          <div style="display:grid;grid-template-columns:1fr 1fr 100px auto;gap:8px;align-items:end;">
            <div>
              <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Label (shown to user)</label>
              <input type="text" data-field-edit="${idx}" data-prop="label" value="${esc(d.label)}" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;"/>
            </div>
            <div>
              <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Column key (snake_case, no spaces)</label>
              <input type="text" data-field-edit="${idx}" data-prop="col" value="${esc(d.col)}" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;font-family:ui-monospace,Menlo,monospace;"/>
            </div>
            <div>
              <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Type</label>
              <select data-field-edit="${idx}" data-prop="type" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;">
                ${FIELD_TYPES.map(t => `<option value="${t}" ${t===d.type?'selected':''}>${t}</option>`).join('')}
              </select>
            </div>
            <button data-field-action="del" data-field-idx="${idx}" title="Delete field" style="background:transparent;border:1px solid #fecaca;color:#b91c1c;cursor:pointer;font-size:11px;padding:6px 10px;border-radius:6px;height:33px;">Delete</button>
          </div>
          <div style="margin-top:8px;">
            <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Hint / placeholder (optional)</label>
            <input type="text" data-field-edit="${idx}" data-prop="hint" value="${esc(d.hint)}" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;"/>
          </div>
          ${optsHtml ? `<div style="margin-top:8px;display:grid;grid-template-columns:1fr;">${optsHtml}</div>` : ''}
        </div>`;
    }).join('');

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:920px;width:96%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
        <div style="padding:14px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:15px;font-weight:700;color:#0f172a;">📋 Custom requirements — ${esc(category)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">${defs.length} field${defs.length===1?'':'s'} defined ${dirty ? '<span style="color:#b45309;font-weight:600;margin-left:8px;">● unsaved changes</span>' : ''}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button data-modal-action="cancel" style="background:transparent;border:1px solid #cbd5e1;color:#64748b;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">Cancel</button>
            <button data-modal-action="save" style="background:linear-gradient(135deg,#1a3a6e,#0e2244);color:#fff;border:none;padding:7px 18px;font-size:12px;font-weight:700;border-radius:8px;cursor:pointer;font-family:inherit;${dirty?'':'opacity:0.5;'}">${dirty ? '✓ Save fields' : 'No changes'}</button>
          </div>
        </div>
        <div style="flex:1;min-height:0;overflow:auto;padding:14px 22px;background:#f8fafc;">
          ${(typeof window._bcRenderNativeFieldsPanel === 'function')
              ? (window._bcRenderNativeFieldsPanel(category) || '')
              : ''}
          <!-- v292: per-scope Other Notes settings. Renders at the
               bottom of every BC requirements section. Toggle off to
               hide for this scope; edit placeholder to customize. -->
          <div style="border:1.5px solid ${otherNotes.enabled ? '#bfdbfe' : '#fecaca'};background:${otherNotes.enabled ? '#eff6ff' : '#fef2f2'};border-radius:8px;padding:12px 14px;margin-bottom:14px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
              <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600;color:#0f172a;">
                <input type="checkbox" id="bcOtherNotesEnabled" ${otherNotes.enabled ? 'checked' : ''} style="margin:0;"/>
                📝 Show "Other Notes" textarea on this scope
              </label>
              <span style="font-size:11px;color:#64748b;">— renders at the bottom of every BC's ${esc(category)} requirements section</span>
            </div>
            <div>
              <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Placeholder text (shown to user inside the textarea)</label>
              <input type="text" id="bcOtherNotesPlaceholder" value="${esc(otherNotes.placeholder)}" placeholder="${esc(OTHER_NOTES_DEFAULT_PLACEHOLDER)}" style="width:100%;padding:7px 10px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px;"/>
            </div>
          </div>
          ${list || '<div style="padding:30px;text-align:center;color:#94a3b8;font-size:12px;">No custom fields yet. Add one below to make new requirements show up on every BC for this category.</div>'}
          <div style="margin-top:8px;padding:14px;border:1.5px dashed #cbd5e1;border-radius:8px;background:#fff;">
            <div style="font-size:12px;font-weight:600;color:#0f172a;margin-bottom:8px;">+ Add new field</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 120px auto;gap:8px;align-items:end;">
              <div>
                <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Label</label>
                <input type="text" id="bcFieldNewLabel" placeholder="e.g. Min building size" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;"/>
              </div>
              <div>
                <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Column key</label>
                <input type="text" id="bcFieldNewCol" placeholder="e.g. min_building_size" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;font-family:ui-monospace,Menlo,monospace;"/>
              </div>
              <div>
                <label style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">Type</label>
                <select id="bcFieldNewType" style="width:100%;padding:6px 9px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;">
                  ${FIELD_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}
                </select>
              </div>
              <button data-modal-action="add" style="background:#15803d;color:#fff;border:none;padding:7px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">+ Add</button>
            </div>
          </div>
        </div>
        <div style="padding:10px 22px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;background:#fff;">
          <strong style="color:#0f172a;">How values store:</strong> custom fields land in <code>ace_buyer_criteria.extra_fields</code> (JSONB). The AI auto-fill picks them up from the same definitions and proposes values for them like any other field.
        </div>
      </div>`;
  }

  modal.addEventListener('click', (e) => {
    if(e.target === modal) return;  // outer click handled above
    const target = e.target.closest('[data-modal-action], [data-field-action]');
    if(!target) return;
    if(target.matches('[data-modal-action]')){
      const a = target.getAttribute('data-modal-action');
      if(a === 'cancel'){
        if(dirty && !confirm('Discard unsaved field changes?')) return;
        modal.remove();
        if(typeof onClose === 'function') onClose();
      } else if(a === 'save'){
        if(!dirty) return;
        const next = (_cache && typeof _cache === 'object') ? Object.assign({}, _cache) : {};
        next[category] = defs.slice();
        // v292: persist Other Notes settings under the meta key.
        const meta = (next[META_KEY] && typeof next[META_KEY] === 'object' && !Array.isArray(next[META_KEY]))
          ? Object.assign({}, next[META_KEY]) : {};
        meta[category] = {
          enabled:     otherNotes.enabled !== false,
          placeholder: otherNotes.placeholder || '',
        };
        next[META_KEY] = meta;
        // v294: persist native-field overrides for the bare-category scope.
        const nativeMeta = (next[NATIVE_META_KEY] && typeof next[NATIVE_META_KEY] === 'object' && !Array.isArray(next[NATIVE_META_KEY]))
          ? Object.assign({}, next[NATIVE_META_KEY]) : {};
        const cleanScope = {};
        for(const [col, ov] of Object.entries(nativeOverrides || {})){
          if(!ov || typeof ov !== 'object') continue;
          const out = {};
          if(ov.hidden === true) out.hidden = true;
          if(typeof ov.label === 'string' && ov.label.trim()) out.label = ov.label.trim();
          if(typeof ov.hint  === 'string' && ov.hint.trim())  out.hint  = ov.hint.trim();
          // v295: enum options override.
          if(Array.isArray(ov.options) && ov.options.length){
            out.options = ov.options.map(s => String(s || '').trim()).filter(Boolean);
          }
          if(Object.keys(out).length) cleanScope[col] = out;
        }
        if(Object.keys(cleanScope).length){
          nativeMeta[nativeOverrideScope] = cleanScope;
        } else {
          delete nativeMeta[nativeOverrideScope];
        }
        next[NATIVE_META_KEY] = nativeMeta;
        _bcFieldsSave(next).then(() => {
          dirty = false;
          if(typeof showSaveConfirm === 'function') showSaveConfirm('✓ Fields saved');
          rerender();
        }).catch(err => alert('Save failed: ' + (err.message || err)));
      } else if(a === 'add'){
        const labelEl = modal.querySelector('#bcFieldNewLabel');
        const colEl   = modal.querySelector('#bcFieldNewCol');
        const typeEl  = modal.querySelector('#bcFieldNewType');
        const label = labelEl ? String(labelEl.value || '').trim() : '';
        let col   = colEl   ? String(colEl.value || '').trim()   : '';
        const type  = typeEl  ? String(typeEl.value || 'text')    : 'text';
        if(!label){ alert('Label is required.'); return; }
        if(!col){ col = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
        if(!col){ alert('Column key required.'); return; }
        if(defs.some(d => d.col === col)){ alert('A field with that column key already exists in this category.'); return; }
        defs.push(_normalizeField({ col, label, type }));
        dirty = true;
        rerender();
      }
    } else if(target.matches('[data-native-override][data-native-prop="reset"]')){
      // v294: clear all overrides for this native field.
      const col = target.getAttribute('data-native-override');
      if(col && nativeOverrides[col]){
        delete nativeOverrides[col];
        dirty = true;
        rerender();
      }
    } else if(target.matches('[data-field-action]')){
      const idx = parseInt(target.getAttribute('data-field-idx'), 10);
      if(target.getAttribute('data-field-action') === 'del'){
        const f = defs[idx];
        if(!f) return;
        if(!confirm(`Delete field "${f.label}"? Existing values stored under extra_fields.${f.col} will remain in the DB but become orphaned.`)) return;
        defs.splice(idx, 1);
        dirty = true;
        rerender();
      }
    }
  });
  modal.addEventListener('input', (e) => {
    const t = e.target;
    // v292: Other Notes placeholder text edits.
    if(t.id === 'bcOtherNotesPlaceholder'){
      otherNotes.placeholder = String(t.value || '');
      dirty = true;
      return;
    }
    // v294: native-field label-override edits.
    if(t.matches('[data-native-override][data-native-prop="label"]')){
      const col = t.getAttribute('data-native-override');
      if(!col) return;
      const v = String(t.value || '').trim();
      const ov = nativeOverrides[col] || {};
      if(v) ov.label = v; else delete ov.label;
      if(Object.keys(ov).length) nativeOverrides[col] = ov;
      else delete nativeOverrides[col];
      dirty = true;
      return;
    }
    // v295: hint override edits.
    if(t.matches('[data-native-override][data-native-prop="hint"]')){
      const col = t.getAttribute('data-native-override');
      if(!col) return;
      const v = String(t.value || '').trim();
      const ov = nativeOverrides[col] || {};
      if(v) ov.hint = v; else delete ov.hint;
      if(Object.keys(ov).length) nativeOverrides[col] = ov;
      else delete nativeOverrides[col];
      dirty = true;
      return;
    }
    // v295: enum options override edits (textarea, one per line).
    if(t.matches('[data-native-override][data-native-prop="options"]')){
      const col = t.getAttribute('data-native-override');
      if(!col) return;
      const lines = String(t.value || '').split(/\n/).map(s => s.trim()).filter(Boolean);
      const ov = nativeOverrides[col] || {};
      if(lines.length) ov.options = lines; else delete ov.options;
      if(Object.keys(ov).length) nativeOverrides[col] = ov;
      else delete nativeOverrides[col];
      dirty = true;
      return;
    }
    if(!t.matches('[data-field-edit]')) return;
    const idx = parseInt(t.getAttribute('data-field-edit'), 10);
    const prop = t.getAttribute('data-prop');
    const f = defs[idx];
    if(!f) return;
    if(prop === 'options'){
      f.options = String(t.value || '').split(/\n/).map(s => s.trim()).filter(Boolean);
    } else {
      f[prop] = String(t.value || '').trim();
    }
    dirty = true;
    // For type changes that affect the visible options textarea, rerender.
    if(prop === 'type'){
      defs[idx] = _normalizeField(f);
      rerender();
    }
  });

  // v292: checkbox change for Other Notes enabled toggle. Re-render so
  // the colored border around the panel reflects the new state.
  modal.addEventListener('change', (e) => {
    if(e.target && e.target.id === 'bcOtherNotesEnabled'){
      otherNotes.enabled = !!e.target.checked;
      dirty = true;
      rerender();
      return;
    }
    // v294: native-field hidden-toggle change. Checkbox is "Visible"
    // (checked = visible). The override stores hidden=true when
    // unchecked. Re-render so the row's red/white background updates.
    if(e.target && e.target.matches('[data-native-override][data-native-prop="hidden"]')){
      const col = e.target.getAttribute('data-native-override');
      if(!col) return;
      const isVisible = !!e.target.checked;
      const ov = nativeOverrides[col] || {};
      if(isVisible) delete ov.hidden;
      else ov.hidden = true;
      if(Object.keys(ov).length) nativeOverrides[col] = ov;
      else delete nativeOverrides[col];
      dirty = true;
      rerender();
    }
  });

  document.body.appendChild(modal);
  rerender();
}
