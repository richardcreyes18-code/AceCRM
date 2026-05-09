// admin/bc-native-fields.js — read-only mirror of the hardcoded fields
// rendered by `bcExpandedAssetSection` in index.html (~lines 30896-31096).
//
// Phase 4a of the "audit page is the source of truth" refactor. Lets
// the BC Asset Taxonomy admin SHOW every native (hardcoded) field so
// the user can see the full picture per scope, not just the runtime-
// defined custom fields.
//
// THIS IS A MIRROR ONLY. `bcExpandedAssetSection` in index.html
// remains the canonical rendering source of truth. If a field is added
// or changed there, this catalog should be updated too. Phase 4b may
// flip the relationship and make `bcExpandedAssetSection` consult
// this catalog as the source of truth — at which point this comment
// goes away.

// Section keys mirror _bcAssetSectionKey() output
// (`js/admin/bc-taxonomy.js` line ~139, also inlined in `index.html`'s
// _bcAssetSectionKey at line ~31135).
//
// v294: each entry includes `inputId` — the legacy DOM id used by
// bcExpandedAssetSection helpers. Lets the post-processor look up
// the wrapping div by id and apply hide/label overrides.
export const NATIVE_FIELDS_BY_SECTION = Object.freeze({
  multifamily: [
    { col: 'mf_min_units',          inputId: 'bcf_minunits',  label: 'Min # of Units',      type: 'number' },
    { col: 'mf_max_units',          inputId: 'bcf_maxunits',  label: 'Max # of Units',      type: 'number' },
    { col: 'mf_class_preference',   inputId: 'bcf_mf_class',  label: 'MF Class',            type: 'enum',
      options: ['A', 'B', 'C', 'B/C'] },
    { col: 'mf_deal_profile',       inputId: 'bcf_mf_profile',label: 'Deal Profile',        type: 'enum',
      options: ['Value Add', 'Turn-Key', 'Stabilized', 'Core Plus', 'Opportunistic'] },
    { col: 'mf_style_preference',   inputId: 'bcf_mf_style',  label: 'Style Preference',    type: 'text',
      hint: 'e.g. Garden, Mid-Rise…' },
    { col: 'mf_max_price_per_unit', inputId: 'bcf_mf_maxppu', label: 'Max Price Per Unit',  type: 'number' },
    { col: 'multifamily_notes',     inputId: 'bcf_mf_notes',  label: 'Other Notes (Multifamily)', type: 'textarea',
      hint: 'Anything else specific to multifamily — preferred unit mix, rent comps, in-place rents, etc.' },
  ],
  warehouse: [
    { col: 'warehouse_min_sf',           inputId: 'bcf_minSF',         label: 'Min SF',                   type: 'number' },
    { col: 'warehouse_max_sf',           inputId: 'bcf_maxSF',         label: 'Max SF',                   type: 'number' },
    { col: 'warehouse_target_sf',        inputId: 'bcf_wh_targetSF',   label: 'Target SF (single estimate)', type: 'number' },
    { col: 'warehouse_min_clear_height', inputId: 'bcf_wh_height',     label: 'Min Clear Height (ft)',    type: 'number' },
    { col: 'warehouse_min_docks',        inputId: 'bcf_wh_docks',      label: 'Min # Loading Docks',      type: 'number' },
    { col: 'warehouse_investor_or_owner',inputId: 'bcf_wh_invown',     label: 'Investor or Owner-Occ?',   type: 'enum',
      options: ['Either', 'Investor', 'Owner-Occupier'] },
    { col: 'warehouse_profile_preference',inputId: 'bcf_wh_profile',   label: 'Deal Profile',             type: 'enum',
      options: ['Value Add', 'NNN', 'Stabilized', 'Vacant'] },
    { col: 'warehouse_features',         inputId: 'bcf_wh_features',   label: 'Dock Doors / Features',    type: 'text',
      hint: 'e.g. Drive-in, Dock High, Rail access…' },
    { col: 'warehouse_notes',            inputId: 'bcf_wh_notes',      label: 'Other Notes (Warehouse)',  type: 'textarea',
      hint: 'Anything else specific to warehouse / industrial — yard storage, power requirements, rail access details, etc.' },
  ],
  shopping: [
    { col: 'shopping_min_sf',     inputId: 'bcf_shop_minSF',     label: 'Min SF',                       type: 'number' },
    { col: 'shopping_max_sf',     inputId: 'bcf_shop_maxSF',     label: 'Max SF',                       type: 'number' },
    { col: 'shopping_target_sf',  inputId: 'bcf_shop_targetSF',  label: 'Target SF (single estimate)',  type: 'number' },
    { col: 'shopping_min_tenants',inputId: 'bcf_shop_mintenants',label: 'Min # of Tenants',             type: 'number' },
    { col: 'shopping_notes',      inputId: 'bcf_shop_notes',     label: 'Other Notes (Shopping Center)',type: 'textarea',
      hint: 'Anything else specific to shopping centers — anchor pad needs, parking ratio, target demographics, etc.' },
  ],
  retail: [
    { col: 'retail_min_sf',            inputId: 'bcf_ret_minSF',    label: 'Min SF',                       type: 'number' },
    { col: 'retail_max_sf',            inputId: 'bcf_ret_maxSF',    label: 'Max SF',                       type: 'number' },
    { col: 'retail_target_sf',         inputId: 'bcf_ret_targetSF', label: 'Target SF (single estimate)',  type: 'number' },
    { col: 'retail_min_tenants',       inputId: 'bcf_ret_minunits', label: 'Min # of Tenants',             type: 'number' },
    { col: 'retail_lease_preference',  inputId: 'bcf_ret_lease',    label: 'Lease Preference',             type: 'enum',
      options: ['NNN Preferred', 'Gross OK', 'Mixed'] },
    { col: 'retail_anchor_preference', inputId: 'bcf_ret_anchor',   label: 'Anchor Preference',            type: 'enum',
      options: ['No Preference', 'Anchored Preferred', 'Unanchored OK'] },
    { col: 'retail_min_occupancy',     inputId: 'bcf_ret_occ',      label: 'Min Occupancy (%)',            type: 'number' },
    { col: 'retail_tenant_type',       inputId: 'bcf_ret_tenants',  label: 'Tenant Type Preference',       type: 'text',
      hint: 'e.g. NNN, Credit tenants…' },
    { col: 'retail_notes',             inputId: 'bcf_ret_notes',    label: 'Other Notes (Retail)',         type: 'textarea',
      hint: 'Anything else specific to retail — co-tenancy needs, traffic counts, lease terms, etc.' },
  ],
  office: [
    { col: 'office_min_sf',           inputId: 'bcf_off_minSF',     label: 'Min SF',                      type: 'number' },
    { col: 'office_max_sf',           inputId: 'bcf_off_maxSF',     label: 'Max SF',                      type: 'number' },
    { col: 'office_target_sf',        inputId: 'bcf_off_targetSF',  label: 'Target SF (single estimate)', type: 'number' },
    { col: 'office_class_preference', inputId: 'bcf_off_class',     label: 'Class Preference',            type: 'enum',
      options: ['A', 'B', 'C', 'Medical'] },
    { col: 'office_min_tenants',      inputId: 'bcf_off_mintenants',label: 'Min # of Tenants',            type: 'number' },
    { col: 'office_max_tenants',      inputId: 'bcf_off_maxtenants',label: 'Max # of Tenants',            type: 'number' },
    { col: 'office_notes',            inputId: 'bcf_off_notes',     label: 'Other Notes (Office)',        type: 'textarea',
      hint: 'Anything else specific to office — parking ratio, build-out preferences, lease structure, etc.' },
  ],
  land: [
    { col: 'land_min_acreage',       inputId: 'bcf_land_min',    label: 'Min Acres',                type: 'number' },
    { col: 'land_max_acreage',       inputId: 'bcf_land_max',    label: 'Max Acres',                type: 'number' },
    { col: 'land_zoning_preference', inputId: 'bcf_land_zoning', label: 'Zoning Preference',        type: 'enum',
      options: ['Residential', 'Commercial', 'Industrial', 'Mixed'] },
    { col: 'land_intended_use',      inputId: 'bcf_land_use',    label: 'Intended Use',             type: 'text',
      hint: 'e.g. Development, Parking…' },
    { col: 'land_notes',             inputId: 'bcf_land_notes',  label: 'Other Notes (Land)',       type: 'textarea',
      hint: 'Anything else specific to land — utilities access, frontage, environmental considerations, entitlements, etc.' },
  ],
  mixed: [
    { col: 'mixeduse_min_residential', inputId: 'bcf_mu_minres',   label: 'Min Residential Units',     type: 'number' },
    { col: 'mixeduse_min_commercial',  inputId: 'bcf_mu_mincom',   label: 'Min Commercial Spaces',     type: 'number' },
    { col: 'mixeduse_min_sf',          inputId: 'bcf_mu_minsf',    label: 'Min Building SF',           type: 'number' },
    { col: 'mixeduse_target_sf',       inputId: 'bcf_mu_targetSF', label: 'Target SF (single estimate)', type: 'number' },
    { col: 'mixeduse_notes',           inputId: 'bcf_mu_notes',    label: 'Other Notes (Mixed Use)',   type: 'textarea',
      hint: 'Anything else specific to mixed-use — preferred ground-floor tenants, residential rent ceiling, etc.' },
  ],
  automotive: [
    { col: 'automotive_min_bays',         inputId: 'bcf_auto_bays',   label: 'Min # of Bays',           type: 'number' },
    { col: 'automotive_gas_preference',   inputId: 'bcf_auto_gas',    label: 'Gas Station Needed?',     type: 'enum',
      options: ['No Preference', 'Yes', 'No'] },
    { col: 'automotive_type_preference',  inputId: 'bcf_auto_type',   label: 'Owner-Occ or Investor?',  type: 'enum',
      options: ['Either', 'Owner-Occupier', 'Investor'] },
    { col: 'automotive_notes',            inputId: 'bcf_auto_notes',  label: 'Other Notes (Automotive)',type: 'textarea',
      hint: 'Anything else specific to automotive — service base, traffic counts, environmental, brand approvals, etc.' },
  ],
  hotel: [
    { col: 'hotel_min_keys',         inputId: 'bcf_hotel_minkeys', label: 'Min # of Keys / Rooms',  type: 'number' },
    { col: 'hotel_max_keys',         inputId: 'bcf_hotel_maxkeys', label: 'Max # of Keys / Rooms',  type: 'number' },
    { col: 'hotel_flag_preference',  inputId: 'bcf_hotel_flag',    label: 'Flag / Brand Preference',type: 'enum',
      options: ['Branded only', 'Independent OK', 'Boutique'] },
    { col: 'hotel_notes',            inputId: 'bcf_hotel_notes',   label: 'Operating model / notes',type: 'text',
      hint: 'e.g. Limited service, extended stay, must be franchise…' },
  ],
  storage: [
    { col: 'storage_min_units', inputId: 'bcf_storage_minunits', label: 'Min # of Units / Doors', type: 'number' },
    { col: 'storage_min_net_sf',inputId: 'bcf_storage_minsf',    label: 'Min Net Rentable SF',    type: 'number' },
    { col: 'storage_climate',   inputId: 'bcf_storage_climate',  label: 'Climate-Controlled?',    type: 'enum',
      options: ['Either', 'Climate-Controlled Required', 'Non-Climate OK'] },
    { col: 'storage_notes',     inputId: 'bcf_storage_notes',    label: 'Other Notes (Self Storage)', type: 'textarea',
      hint: 'Anything else specific to self-storage — drive-up vs interior, expansion potential, on-site management, etc.' },
  ],
  mhp: [
    { col: 'mhp_min_pads',  inputId: 'bcf_mhp_minpads',  label: 'Min # of Pads / Lots',                  type: 'number' },
    { col: 'mhp_max_pads',  inputId: 'bcf_mhp_maxpads',  label: 'Max # of Pads / Lots',                  type: 'number' },
    { col: 'mhp_ownership', inputId: 'bcf_mhp_ownership',label: 'Park-Owned vs Tenant-Owned Homes',      type: 'enum',
      options: ['Either', 'Park-Owned Homes', 'Tenant-Owned Homes', 'Mix OK'] },
    { col: 'mhp_notes',     inputId: 'bcf_mhp_notes',    label: 'Other Notes (Mobile Home Park)',        type: 'textarea',
      hint: 'Anything else specific to MHPs — utility billing, well/septic vs city, age restrictions, etc.' },
  ],
  healthcare: [
    { col: 'healthcare_min_sf',    inputId: 'bcf_health_minSF', label: 'Min SF',                         type: 'number' },
    { col: 'healthcare_max_sf',    inputId: 'bcf_health_maxSF', label: 'Max SF',                         type: 'number' },
    { col: 'healthcare_subtype',   inputId: 'bcf_health_sub',   label: 'Sub-Type',                       type: 'enum',
      options: ['Medical Office Building', 'Surgery / Ambulatory', 'Senior Living / Assisted', 'Skilled Nursing', 'Other'] },
    { col: 'healthcare_notes',     inputId: 'bcf_health_notes', label: 'Other Notes (Healthcare)',       type: 'textarea',
      hint: 'Anything else specific to healthcare — credit-tenant requirements, parking ratio, ADA / build-out preferences, etc.' },
  ],
  special: [
    { col: 'special_purpose_use',  inputId: 'bcf_special_use',  label: "Use case / what they're looking for", type: 'text',
      hint: 'e.g. Religious, school, marina, post office, day care…' },
  ],
  development: [
    { col: 'development_project_type', inputId: 'bcf_dev_project', label: 'Project Type',                type: 'text',
      hint: 'e.g. Ground-up multifamily, hotel, mixed-use' },
    { col: 'development_stage',        inputId: 'bcf_dev_stage',   label: 'Stage',                       type: 'text',
      hint: 'e.g. Approvals in place, raw land, tear-down' },
    { col: 'development_min_size',     inputId: 'bcf_dev_minsize', label: 'Min Buildable SF / Units',    type: 'number' },
    { col: 'development_max_size',     inputId: 'bcf_dev_maxsize', label: 'Max Buildable SF / Units',    type: 'number' },
    { col: 'development_notes',        inputId: 'bcf_dev_notes',   label: 'Other Notes (Development)',   type: 'textarea',
      hint: 'Anything else specific to development — entitlements, environmental, contractor relationships, financing structure, etc.' },
  ],
});

// Section labels match the asset-class names the user sees in the
// taxonomy admin (these are also used by bc-taxonomy.js's SECTION_LABELS).
const SECTION_LABEL_BY_KEY = Object.freeze({
  multifamily: 'Multifamily',
  warehouse:   'Warehouse / Industrial',
  shopping:    'Shopping Center',
  retail:      'Retail',
  office:      'Office',
  land:        'Land',
  mixed:       'Mixed Use',
  automotive:  'Automotive',
  hotel:       'Hotel',
  storage:     'Self Storage',
  mhp:         'Mobile Home Park',
  healthcare:  'Healthcare',
  special:     'Special Purpose',
  development: 'Development',
});

// Mirrors _bcAssetSectionKey() in index.html — kept inline so the
// catalog lookup doesn't depend on bc-taxonomy.js or the legacy global.
function _sectionKeyOf(chipText){
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
  return '';   // no native section
}

export function _bcNativeFieldsForScope(scopeOrChip){
  const sectionKey = _sectionKeyOf(scopeOrChip);
  if(!sectionKey) return [];
  return (NATIVE_FIELDS_BY_SECTION[sectionKey] || []).slice();
}

// Returns HTML for the editable "Built-in fields" panel. Empty string
// when the scope has no native section (e.g. Agricultural, Senior
// Housing). v294: each row now has a hide checkbox + label override
// input. Inputs carry `data-native-override="<col>"` and
// `data-native-prop="<hidden|label|hint>"` so the bc-fields.js admin
// modal can collect them on Save.
export function _bcRenderNativeFieldsPanel(scopeOrChip){
  const fields = _bcNativeFieldsForScope(scopeOrChip);
  if(!fields.length) return '';

  const sectionKey = _sectionKeyOf(scopeOrChip);
  const sectionLabel = SECTION_LABEL_BY_KEY[sectionKey] || sectionKey;

  // Subtype scopes share their native fields with the parent category;
  // overrides also live at the parent category scope (subtype scope
  // doesn't override native fields). Surface that in the header so it
  // doesn't surprise the user.
  const isSubtypeScope = String(scopeOrChip || '').includes(':');
  const overrideScope = isSubtypeScope ? sectionLabel : scopeOrChip;
  const overrides = (typeof window._bcNativeOverridesGet === 'function')
    ? window._bcNativeOverridesGet(overrideScope) : {};

  const headerHint = isSubtypeScope
    ? `Inherited from <strong>${esc(sectionLabel)}</strong> — Built-in fields (${fields.length})`
    : `Built-in fields (${fields.length})`;
  const editingNote = isSubtypeScope
    ? 'Overrides edit the parent category — they apply to all subtype chips automatically.'
    : 'Hide unused fields, override labels per-scope. Saving applies to every BC of this asset class.';

  const esc_ = esc;
  const rows = fields.map(f => {
    const ov = overrides[f.col] || {};
    const isHidden = ov.hidden === true;
    const labelOv  = ov.label || '';
    const optsHtml = (f.type === 'enum' || f.type === 'multienum') && Array.isArray(f.options) && f.options.length
      ? `<div style="font-size:10px;color:#64748b;margin-top:2px;">Options: ${f.options.map(esc_).join(' · ')}</div>`
      : '';
    const hintHtml = f.hint
      ? `<div style="font-size:10px;color:#94a3b8;font-style:italic;margin-top:3px;">${esc_(f.hint)}</div>`
      : '';
    return `
      <div style="border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;background:${isHidden ? '#fef2f2' : '#fff'};display:grid;grid-template-columns:auto 1fr 1fr 70px;gap:10px;align-items:center;">
        <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:${isHidden?'#b91c1c':'#475569'};font-weight:600;white-space:nowrap;" title="Uncheck to hide this field on every BC for this asset class">
          <input type="checkbox" data-native-override="${esc_(f.col)}" data-native-prop="hidden" ${isHidden ? '' : 'checked'} style="margin:0;"/>
          ${isHidden ? 'Hidden' : 'Visible'}
        </label>
        <div>
          <div style="font-size:11px;color:#0f172a;font-weight:600;">${esc_(f.label)} <span style="color:#94a3b8;font-weight:400;">(default)</span></div>
          ${optsHtml}
          ${hintHtml}
        </div>
        <div>
          <input type="text" data-native-override="${esc_(f.col)}" data-native-prop="label" value="${esc_(labelOv)}" placeholder="Override label (blank = use default)" style="width:100%;padding:5px 8px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;font-family:inherit;" title="Override the label shown to the user. Leave blank to use the default."/>
          <div style="font-size:9px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;margin-top:2px;">${esc_(f.col)} · ${esc_(f.type)}</div>
        </div>
        <button data-native-override="${esc_(f.col)}" data-native-prop="reset" style="background:transparent;border:1px solid #e2e8f0;color:#64748b;cursor:pointer;font-size:10px;padding:4px 8px;border-radius:4px;font-family:inherit;" title="Clear all overrides for this field — restore default visibility + label.">Reset</button>
      </div>`;
  }).join('');

  return `
    <div style="border:1.5px solid #e0e7ff;background:#eef2ff;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;gap:8px;">
        <div>
          <div style="font-size:13px;font-weight:700;color:#3730a3;">🏛 ${headerHint}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">${editingNote}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${rows}
      </div>
    </div>`;
}

function esc(s){
  return String(s==null?'':s).replace(/[<&>"]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;'}[c]));
}

// v294: post-process the HTML rendered by bcExpandedAssetSection to
// apply native-field overrides for the chip's bare-category scope.
//   - hidden=true  → remove the wrapping <div> for that field
//   - label=string → replace the .bc-label text with the override
//
// Called from bcExpandedAssetSection AFTER its template literal is
// built. Uses a temp DOM to walk by inputId — robust against helper
// changes since each helper produces an <input|select|textarea>
// with the canonical id and a sibling <div class="bc-label">.
//
// Returns the (possibly modified) HTML string. No-op when no
// overrides exist for the scope or _bcNativeOverridesGet isn't loaded.
export function _bcNativeApplyOverrides(html, scopeOrChip){
  if(!html || typeof html !== 'string') return html;
  const isSubtype = String(scopeOrChip || '').includes(':');
  const baseScope = isSubtype ? String(scopeOrChip).split(':')[0].trim() : scopeOrChip;
  const overrides = (typeof window._bcNativeOverridesGet === 'function')
    ? window._bcNativeOverridesGet(baseScope) : {};
  if(!overrides || !Object.keys(overrides).length) return html;
  const sectionKey = _sectionKeyOf(scopeOrChip);
  const fields = NATIVE_FIELDS_BY_SECTION[sectionKey] || [];
  if(!fields.length) return html;

  // Build a temp wrapper so we can use querySelector. innerHTML
  // round-trips correctly for the helpers' simple <div>...</div> output.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  for(const f of fields){
    const ov = overrides[f.col];
    if(!ov) continue;
    if(!f.inputId) continue;
    const el = tmp.querySelector(`#${cssEscape(f.inputId)}`);
    if(!el) continue;
    // Walk to the wrapping <div> the helper produced.
    let wrap = el.parentElement;
    // Helpers produce <div> > <div class="bc-label"> + <input/select/textarea>
    // OR for textareas: <div style="grid-column:1/-1"> > <div class="bc-label"> + <textarea>
    // Keep walking up until we find a div that's a direct child of the
    // grid (i.e. its parent isn't a label-wrapper). Simplest: use the
    // immediate parent div in all cases — every helper wraps in one
    // outer div with the label inside.
    if(!wrap) continue;
    if(ov.hidden){
      wrap.remove();
      continue;
    }
    if(typeof ov.label === 'string' && ov.label.trim()){
      const labelEl = wrap.querySelector('.bc-label');
      if(labelEl) labelEl.textContent = ov.label.trim();
    }
  }
  return tmp.innerHTML;
}

function cssEscape(s){
  if(typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(s));
  return String(s).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
