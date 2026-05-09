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
export const NATIVE_FIELDS_BY_SECTION = Object.freeze({
  multifamily: [
    { col: 'mf_min_units',          label: 'Min # of Units',      type: 'number' },
    { col: 'mf_max_units',          label: 'Max # of Units',      type: 'number' },
    { col: 'mf_class_preference',   label: 'MF Class',            type: 'enum',
      options: ['A', 'B', 'C', 'B/C'] },
    { col: 'mf_deal_profile',       label: 'Deal Profile',        type: 'enum',
      options: ['Value Add', 'Turn-Key', 'Stabilized', 'Core Plus', 'Opportunistic'] },
    { col: 'mf_style_preference',   label: 'Style Preference',    type: 'text',
      hint: 'e.g. Garden, Mid-Rise…' },
    { col: 'mf_max_price_per_unit', label: 'Max Price Per Unit',  type: 'number' },
    { col: 'multifamily_notes',     label: 'Other Notes (Multifamily)', type: 'textarea',
      hint: 'Anything else specific to multifamily — preferred unit mix, rent comps, in-place rents, etc.' },
  ],
  warehouse: [
    { col: 'warehouse_min_sf',           label: 'Min SF',                   type: 'number' },
    { col: 'warehouse_max_sf',           label: 'Max SF',                   type: 'number' },
    { col: 'warehouse_target_sf',        label: 'Target SF (single estimate)', type: 'number' },
    { col: 'warehouse_min_clear_height', label: 'Min Clear Height (ft)',    type: 'number' },
    { col: 'warehouse_min_docks',        label: 'Min # Loading Docks',      type: 'number' },
    { col: 'warehouse_investor_or_owner',label: 'Investor or Owner-Occ?',   type: 'enum',
      options: ['Either', 'Investor', 'Owner-Occupier'] },
    { col: 'warehouse_profile_preference',label:'Deal Profile',             type: 'enum',
      options: ['Value Add', 'NNN', 'Stabilized', 'Vacant'] },
    { col: 'warehouse_features',         label: 'Dock Doors / Features',    type: 'text',
      hint: 'e.g. Drive-in, Dock High, Rail access…' },
    { col: 'warehouse_notes',            label: 'Other Notes (Warehouse)',  type: 'textarea',
      hint: 'Anything else specific to warehouse / industrial — yard storage, power requirements, rail access details, etc.' },
  ],
  shopping: [
    { col: 'shopping_min_sf',     label: 'Min SF',                       type: 'number' },
    { col: 'shopping_max_sf',     label: 'Max SF',                       type: 'number' },
    { col: 'shopping_target_sf',  label: 'Target SF (single estimate)',  type: 'number' },
    { col: 'shopping_min_tenants',label: 'Min # of Tenants',             type: 'number' },
    { col: 'shopping_notes',      label: 'Other Notes (Shopping Center)',type: 'textarea',
      hint: 'Anything else specific to shopping centers — anchor pad needs, parking ratio, target demographics, etc.' },
  ],
  retail: [
    { col: 'retail_min_sf',            label: 'Min SF',                       type: 'number' },
    { col: 'retail_max_sf',            label: 'Max SF',                       type: 'number' },
    { col: 'retail_target_sf',         label: 'Target SF (single estimate)',  type: 'number' },
    { col: 'retail_min_tenants',       label: 'Min # of Tenants',             type: 'number' },
    { col: 'retail_lease_preference',  label: 'Lease Preference',             type: 'enum',
      options: ['NNN Preferred', 'Gross OK', 'Mixed'] },
    { col: 'retail_anchor_preference', label: 'Anchor Preference',            type: 'enum',
      options: ['No Preference', 'Anchored Preferred', 'Unanchored OK'] },
    { col: 'retail_min_occupancy',     label: 'Min Occupancy (%)',            type: 'number' },
    { col: 'retail_tenant_type',       label: 'Tenant Type Preference',       type: 'text',
      hint: 'e.g. NNN, Credit tenants…' },
    { col: 'retail_notes',             label: 'Other Notes (Retail)',         type: 'textarea',
      hint: 'Anything else specific to retail — co-tenancy needs, traffic counts, lease terms, etc.' },
  ],
  office: [
    { col: 'office_min_sf',           label: 'Min SF',                      type: 'number' },
    { col: 'office_max_sf',           label: 'Max SF',                      type: 'number' },
    { col: 'office_target_sf',        label: 'Target SF (single estimate)', type: 'number' },
    { col: 'office_class_preference', label: 'Class Preference',            type: 'enum',
      options: ['A', 'B', 'C', 'Medical'] },
    { col: 'office_min_tenants',      label: 'Min # of Tenants',            type: 'number' },
    { col: 'office_max_tenants',      label: 'Max # of Tenants',            type: 'number' },
    { col: 'office_notes',            label: 'Other Notes (Office)',        type: 'textarea',
      hint: 'Anything else specific to office — parking ratio, build-out preferences, lease structure, etc.' },
  ],
  land: [
    { col: 'land_min_acreage',       label: 'Min Acres',                type: 'number' },
    { col: 'land_max_acreage',       label: 'Max Acres',                type: 'number' },
    { col: 'land_zoning_preference', label: 'Zoning Preference',        type: 'enum',
      options: ['Residential', 'Commercial', 'Industrial', 'Mixed'] },
    { col: 'land_intended_use',      label: 'Intended Use',             type: 'text',
      hint: 'e.g. Development, Parking…' },
    { col: 'land_notes',             label: 'Other Notes (Land)',       type: 'textarea',
      hint: 'Anything else specific to land — utilities access, frontage, environmental considerations, entitlements, etc.' },
  ],
  mixed: [
    { col: 'mixeduse_min_residential', label: 'Min Residential Units',     type: 'number' },
    { col: 'mixeduse_min_commercial',  label: 'Min Commercial Spaces',     type: 'number' },
    { col: 'mixeduse_min_sf',          label: 'Min Building SF',           type: 'number' },
    { col: 'mixeduse_target_sf',       label: 'Target SF (single estimate)', type: 'number' },
    { col: 'mixeduse_notes',           label: 'Other Notes (Mixed Use)',   type: 'textarea',
      hint: 'Anything else specific to mixed-use — preferred ground-floor tenants, residential rent ceiling, etc.' },
  ],
  automotive: [
    { col: 'automotive_min_bays',         label: 'Min # of Bays',           type: 'number' },
    { col: 'automotive_gas_preference',   label: 'Gas Station Needed?',     type: 'enum',
      options: ['No Preference', 'Yes', 'No'] },
    { col: 'automotive_type_preference',  label: 'Owner-Occ or Investor?',  type: 'enum',
      options: ['Either', 'Owner-Occupier', 'Investor'] },
    { col: 'automotive_notes',            label: 'Other Notes (Automotive)',type: 'textarea',
      hint: 'Anything else specific to automotive — service base, traffic counts, environmental, brand approvals, etc.' },
  ],
  hotel: [
    { col: 'hotel_min_keys',         label: 'Min # of Keys / Rooms',  type: 'number' },
    { col: 'hotel_max_keys',         label: 'Max # of Keys / Rooms',  type: 'number' },
    { col: 'hotel_flag_preference',  label: 'Flag / Brand Preference',type: 'enum',
      options: ['Branded only', 'Independent OK', 'Boutique'] },
    { col: 'hotel_notes',            label: 'Operating model / notes',type: 'text',
      hint: 'e.g. Limited service, extended stay, must be franchise…' },
  ],
  storage: [
    { col: 'storage_min_units', label: 'Min # of Units / Doors', type: 'number' },
    { col: 'storage_min_net_sf',label: 'Min Net Rentable SF',    type: 'number' },
    { col: 'storage_climate',   label: 'Climate-Controlled?',    type: 'enum',
      options: ['Either', 'Climate-Controlled Required', 'Non-Climate OK'] },
    { col: 'storage_notes',     label: 'Other Notes (Self Storage)', type: 'textarea',
      hint: 'Anything else specific to self-storage — drive-up vs interior, expansion potential, on-site management, etc.' },
  ],
  mhp: [
    { col: 'mhp_min_pads',  label: 'Min # of Pads / Lots',                  type: 'number' },
    { col: 'mhp_max_pads',  label: 'Max # of Pads / Lots',                  type: 'number' },
    { col: 'mhp_ownership', label: 'Park-Owned vs Tenant-Owned Homes',      type: 'enum',
      options: ['Either', 'Park-Owned Homes', 'Tenant-Owned Homes', 'Mix OK'] },
    { col: 'mhp_notes',     label: 'Other Notes (Mobile Home Park)',        type: 'textarea',
      hint: 'Anything else specific to MHPs — utility billing, well/septic vs city, age restrictions, etc.' },
  ],
  healthcare: [
    { col: 'healthcare_min_sf',    label: 'Min SF',                         type: 'number' },
    { col: 'healthcare_max_sf',    label: 'Max SF',                         type: 'number' },
    { col: 'healthcare_subtype',   label: 'Sub-Type',                       type: 'enum',
      options: ['Medical Office Building', 'Surgery / Ambulatory', 'Senior Living / Assisted', 'Skilled Nursing', 'Other'] },
    { col: 'healthcare_notes',     label: 'Other Notes (Healthcare)',       type: 'textarea',
      hint: 'Anything else specific to healthcare — credit-tenant requirements, parking ratio, ADA / build-out preferences, etc.' },
  ],
  special: [
    { col: 'special_purpose_use',  label: "Use case / what they're looking for", type: 'text',
      hint: 'e.g. Religious, school, marina, post office, day care…' },
  ],
  development: [
    { col: 'development_project_type', label: 'Project Type',                type: 'text',
      hint: 'e.g. Ground-up multifamily, hotel, mixed-use' },
    { col: 'development_stage',        label: 'Stage',                       type: 'text',
      hint: 'e.g. Approvals in place, raw land, tear-down' },
    { col: 'development_min_size',     label: 'Min Buildable SF / Units',    type: 'number' },
    { col: 'development_max_size',     label: 'Max Buildable SF / Units',    type: 'number' },
    { col: 'development_notes',        label: 'Other Notes (Development)',   type: 'textarea',
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

// Returns HTML for a read-only "Built-in fields" panel. Empty string
// when the scope has no native section (e.g. Agricultural, Senior
// Housing). Used by _bcFieldsAdminForCategory in bc-fields.js.
export function _bcRenderNativeFieldsPanel(scopeOrChip){
  const fields = _bcNativeFieldsForScope(scopeOrChip);
  if(!fields.length) return '';

  const sectionKey = _sectionKeyOf(scopeOrChip);
  const sectionLabel = SECTION_LABEL_BY_KEY[sectionKey] || sectionKey;

  // If scope is a "Cat: Sub" chip, the native fields are inherited
  // from the bare category — surface that in the header.
  const isSubtypeScope = String(scopeOrChip || '').includes(':');
  const headerHint = isSubtypeScope
    ? `Inherited from <strong>${esc(sectionLabel)}</strong> — Built-in fields (${fields.length})`
    : `Built-in fields (${fields.length})`;

  const esc_ = esc;
  const rows = fields.map(f => {
    const optsHtml = (f.type === 'enum' || f.type === 'multienum') && Array.isArray(f.options) && f.options.length
      ? `<div style="font-size:10px;color:#64748b;margin-top:2px;">Options: ${f.options.map(esc_).join(' · ')}</div>`
      : '';
    const hintHtml = f.hint
      ? `<div style="font-size:10px;color:#94a3b8;font-style:italic;margin-top:3px;">${esc_(f.hint)}</div>`
      : '';
    return `
      <div style="border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;background:#fff;display:grid;grid-template-columns:1fr 200px 90px;gap:10px;align-items:start;">
        <div>
          <div style="font-size:12px;color:#0f172a;font-weight:600;">${esc_(f.label)}</div>
          ${optsHtml}
          ${hintHtml}
        </div>
        <div style="font-size:10px;color:#64748b;font-family:ui-monospace,Menlo,monospace;align-self:center;">${esc_(f.col)}</div>
        <div style="font-size:10px;color:#475569;align-self:center;">
          <span style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:99px;padding:2px 8px;font-weight:600;">${esc_(f.type)}</span>
        </div>
      </div>`;
  }).join('');

  return `
    <div style="border:1.5px solid #e0e7ff;background:#eef2ff;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;">
        <div style="font-size:13px;font-weight:700;color:#3730a3;">🏛 ${headerHint}</div>
        <div style="font-size:10px;color:#64748b;font-style:italic;text-align:right;line-height:1.4;">
          Read-only — these render automatically on every BC for this asset class.<br>Phase 4b will move them to admin-controlled.
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
