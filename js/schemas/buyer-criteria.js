// schemas/buyer-criteria.js — ace_buyer_criteria ↔ Airtable-style label map.
// 103+ fields covering every asset class plus AI auto-fill audit trail.

export const SB_BC_MAP = {
  id:'id', desired_property_types:'Simple Text Desired Property Type',
  simple_area_preference:'Simple Area Preference',
  location_preferences:'Location Preferences',
  preferred_cities:'Preferred Cities',
  preferred_states:'Preferred States',
  minimum_cap_rate:'Minumum Cap Rate',
  min_purchase_price:'Min Purchase Price', max_purchase_price:'Max Purchase Price',
  date_added:'Date Added Buyer',
  mf_min_units:'Minimum # of Units MF', mf_max_units:'Max # of Units MF',
  mf_style_preference:'MF Style Preference',
  warehouse_min_sf:'Warehouse Min Square Footage',
  warehouse_max_sf:'Warehouse Max Square Footage',
  warehouse_features:'Warehouse Features',
  retail_min_tenants:'Retail Min Tenants', retail_tenant_type:'Retail Tenant Type',
  retail_min_occupancy:'Retail Min Occupancy',
  office_min_sf:'Office Min SF', office_class_preference:'Office Class Preference',
  land_min_acreage:'Land Min Acreage', land_intended_use:'Land Intended Use',
  other_requirements:'Other Requirements ', deals_sent_notes:'Deals Sent Notes',
  is_vip_buyer:'Is VIP Buyer',
  // v102.9: columns added for buyer lead intake fields that were previously
  // collected in the UI but dropped on submit due to missing SB_BC_MAP entries
  preferred_counties:'Preferred Counties',
  automotive_gas_preference:'Automotive Gas Preference',
  automotive_type_preference:'Automotive Type Preference',
  land_zoning_preference:'Land Zoning Preference',
  retail_anchor_preference:'Retail Anchor Preference',
  retail_lease_preference:'Retail Lease Preference',
  warehouse_profile_preference:'Warehouse Profile Preference',
  // v102.14: buyer intake form redesign — "How They Buy" card + office tenant range
  budget_is_deal_dependent:'Budget Deal Dependent',
  financing_type:'Financing Type',
  office_max_sf:'Office Max SF',
  office_min_tenants:'Office Min Tenants',
  office_max_tenants:'Office Max Tenants',
  // v102.15: buyer criteria detail page symmetry — every intake field needs a column
  mf_class_preference:'MF Class Preference',
  mf_deal_profile:'MF Deal Profile',
  mf_max_price_per_unit:'MF Max Price Per Unit',
  warehouse_min_clear_height:'Warehouse Min Clear Height',
  warehouse_min_docks:'Warehouse Min Docks',
  warehouse_investor_or_owner:'Warehouse Investor or Owner',
  retail_min_sf:'Retail Min SF',
  retail_max_sf:'Retail Max SF',
  land_max_acreage:'Land Max Acreage',
  mixeduse_min_residential:'MixedUse Min Residential',
  mixeduse_min_commercial:'MixedUse Min Commercial',
  mixeduse_min_sf:'MixedUse Min SF',
  automotive_min_bays:'Automotive Min Bays',
  shopping_min_sf:'Shopping Min SF',
  shopping_max_sf:'Shopping Max SF',
  shopping_min_tenants:'Shopping Min Tenants',
  // v102.17: agent attribution for dashboard scoping
  fub_assigned_to:'Assigned Agent',
  // v111: per-field status JSONB (Collected / No Preference / Not Available)
  field_status:'Field Status',
  // v203: AI Auto-Fill log (mirrors ace_properties.ai_autofill_log) —
  // append-only array of snapshots, one per AI run on this buyer.
  ai_autofill_log:'AI Autofill Log',
  // v235: backing columns for the asset sections that previously had no
  // persistence (Hotel, Self Storage, Mobile Home Park, Healthcare,
  // Special Purpose, Development) plus per-asset target_sf for the
  // "single ballpark" SF case ("~10k SF") that should NOT collapse into
  // min=max.
  hotel_min_keys:            'Hotel Min Keys',
  hotel_max_keys:            'Hotel Max Keys',
  hotel_flag_preference:     'Hotel Flag Preference',
  hotel_notes:               'Hotel Notes',
  storage_min_units:         'Storage Min Units',
  storage_min_net_sf:        'Storage Min Net SF',
  storage_climate:           'Storage Climate',
  mhp_min_pads:              'MHP Min Pads',
  mhp_max_pads:              'MHP Max Pads',
  mhp_ownership:             'MHP Ownership',
  healthcare_min_sf:         'Healthcare Min SF',
  healthcare_max_sf:         'Healthcare Max SF',
  healthcare_subtype:        'Healthcare Sub-Type',
  special_purpose_use:       'Special Purpose Use',
  development_project_type:  'Development Project Type',
  development_stage:         'Development Stage',
  development_min_size:      'Development Min Size',
  development_max_size:      'Development Max Size',
  warehouse_target_sf:       'Warehouse Target SF',
  retail_target_sf:          'Retail Target SF',
  office_target_sf:          'Office Target SF',
  shopping_target_sf:        'Shopping Target SF',
  mixeduse_target_sf:        'MixedUse Target SF',
  // v237: "Other Notes" column per asset section. hotel_notes already
  // exists (v235) and special_purpose_use covers Special Purpose, so they
  // are intentionally omitted here.
  multifamily_notes:         'Multifamily Notes',
  warehouse_notes:           'Warehouse Notes',
  retail_notes:              'Retail Notes',
  office_notes:              'Office Notes',
  shopping_notes:            'Shopping Notes',
  mixeduse_notes:            'MixedUse Notes',
  automotive_notes:          'Automotive Notes',
  land_notes:                'Land Notes',
  storage_notes:             'Storage Notes',
  mhp_notes:                 'MHP Notes',
  healthcare_notes:          'Healthcare Notes',
  development_notes:         'Development Notes'
};
