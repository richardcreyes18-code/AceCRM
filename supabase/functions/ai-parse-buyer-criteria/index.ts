// ai-parse-buyer-criteria — dry-run AI extraction for ace_buyer_criteria rows.
// Mirrors the contract of ai-parse-deal-v2 but for buyer-side criteria.
// The client owns the apply path; this function is read-only.
//
// v270 (2026-05): tag-aware iteration loop kickoff.
//   - Model: claude-sonnet-4-6 with prompt caching on the static system block
//   - Accepts `contact_tags: string[]` in the request body
//   - System prompt rewritten with: buy-intent determination, tag→field rules,
//     stated-vs-aspirational rules, recency rules, source citation requirement,
//     confidence labels, 2 few-shot examples
//   - Each proposed_change now carries `cite` + `confidence`
//   - Response includes top-level `prompt_version` + `diagnostic` block
//
// Prompt versioning: when iterating the system prompt below, bump
// PROMPT_VERSION so the frontend's Copy diagnostic blob captures which
// version produced which output.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// v279: model is now per-request. Default = "auto" (Sonnet 4.6 for big
// note sets, Haiku 4.5 for small ones). Callers can force "sonnet" or
// "haiku" by passing the model field directly.
const MODEL_SONNET = 'claude-sonnet-4-6'
const MODEL_HAIKU  = 'claude-haiku-4-5'
const MODEL_DEFAULT = MODEL_SONNET
const MODEL_ALIASES: Record<string, string> = {
  sonnet:               MODEL_SONNET,
  'sonnet-4-6':         MODEL_SONNET,
  'claude-sonnet-4-6':  MODEL_SONNET,
  haiku:                MODEL_HAIKU,
  'haiku-4-5':          MODEL_HAIKU,
  'claude-haiku-4-5':   MODEL_HAIKU,
}
function resolveModel(raw: unknown): string | null {
  // Returns null when the caller asked for "auto" (or didn't specify);
  // routing is then decided after we know how much source text we have.
  if (typeof raw !== 'string' || !raw.trim()) return null
  const norm = raw.trim().toLowerCase()
  if (norm === 'auto') return null
  return MODEL_ALIASES[norm] || MODEL_DEFAULT
}

// v281/v283: auto-routing thresholds. Big / multi-note buyers go to
// Sonnet so dual-role detection + recency-conflict reasoning stays
// sharp; smaller ones go to Haiku to save ~3x on tokens.
//
// Tuned 2026-05-09 against bc-distribution-stats over the full 5,939-
// buyer-tagged population. Result: 1800 chars maps to ~p87, 6 notes
// maps to ~p82. Either condition routes ~13% of buyers to Sonnet —
// the genuinely complex set where dual-role + multi-signal reasoning
// pays off. The other 87% go to Haiku at ~3x cost savings.
//
// Re-run bc-distribution-stats to see current distribution and adjust.
const AUTO_ROUTING = {
  // Either condition triggers Sonnet:
  source_chars_threshold: 1800,
  note_count_threshold:    6,
}
// v313: BC responses are typically 500-1500 output tokens (15-25 fields
// + na/uncertain arrays). 4096 was generous and slowed wall time because
// Claude keeps emitting until it decides it's done. 2048 is still ~2x
// headroom over the largest observed real response. Direct latency win.
const MAX_TOKENS = 2048
const PROMPT_VERSION = 'bc-v1.12'

// Maps a FIELD_SPEC.group to the asset-class label(s) (from ASSET_TYPE_VOCAB)
// that the field is scoped to. If the buyer's proposed/current
// desired_property_types doesn't include at least one of these (matched by
// category, ignoring any ": Subtype" suffix), the field is out of scope and
// dropped server-side. Groups not in this map are NEVER asset-gated
// (Asset Types / Pricing / Location / Misc / Development).
//
// v272: synced to the new vocab labels:
//   - "Warehouse / Industrial" → "Industrial"
//   - "Retail Strip Mall"      → "Retail"
//   - "Hotel"                  → "Hotel & Motel"
//   - "Healthcare"             → "Health Care"
//   - "Self Storage" group     → "Industrial" (Self Storage is now an
//     Industrial subtype; chips like "Industrial: Self Storage" still
//     activate the Self Storage field group via category match)
//   - "Mobile Home Park" group → "Residential Income" (MHP is a subtype)
const GROUP_REQUIRED_ASSET: Record<string, string[]> = {
  'Multifamily':       ['Multifamily', 'Residential Income'],
  'Warehouse':         ['Industrial'],
  'Office':            ['Office'],
  'Retail':            ['Retail', 'Shopping Center'],
  'Shopping Center':   ['Shopping Center', 'Retail'],
  'Mixed Use':         ['Mixed Use'],
  'Land':              ['Land', 'Agricultural'],
  'Automotive':        ['Automotive'],
  'Mobile Home Park':  ['Residential Income'],
  'Self Storage':      ['Industrial'],
  'Hotel':             ['Hotel & Motel'],
  'Healthcare':        ['Health Care', 'Senior Housing'],
  'Special Purpose':   ['Special Purpose'],
}

type FieldType = 'number' | 'text' | 'boolean' | 'csv' | 'enum' | 'multienum'
interface FieldDef { col: string; label: string; type: FieldType; group: string; hint: string; options?: string[] }

// v207: enum/multienum vocab — the AI must pick from these. Server-side
// coerce() drops any out-of-vocab values so the apply path can rely on
// canonical labels matching the BC edit form's pickers.
// v272: vocab synced to the Buyer Criteria blank form's category list
// (index.html ASSET_SUBTYPES, line ~7193). The review modal renders these
// as chips; the form's chip-picker accepts any of them as bare categories
// or as "Category: Subtype" combinations. Keep this list byte-identical
// with the form keys so values round-trip cleanly through the BC apply
// path.
const ASSET_TYPE_VOCAB = [
  'Multifamily', 'Office', 'Industrial', 'Retail', 'Shopping Center',
  'Mixed Use', 'Land', 'Agricultural', 'Hotel & Motel', 'Senior Housing',
  'Health Care', 'Sport & Entertainment', 'Special Purpose', 'Automotive',
  'Residential Income',
]

// v272: parallel to ASSET_SUBTYPES in index.html line ~7193. Used to (a)
// validate "Category: Subtype" chip forms and (b) hint subtype labels in
// the prompt so the AI can produce specific chips like "Retail: Grocery
// Anchored" or "Industrial: Self Storage" when notes warrant it.
const ASSET_SUBTYPES: Record<string, string[]> = {
  'Multifamily':           ['Garden/Low Rise','Mid Rise','High Rise','Duplex','Triplex','Fourplex','Townhome','Student Housing','Military Housing','Affordable Housing','Mixed Income'],
  'Office':                ['CBD','Suburban','Medical','Creative/Flex','Government','R&D','Owner/User'],
  'Industrial':            ['Warehouse','Distribution','Manufacturing','Flex','Cold Storage','Data Center','Truck Terminal','Self Storage','R&D','Showroom'],
  'Retail':                ['Strip Mall','Power Center','Neighborhood Center','Community Center','Regional Mall','Single Tenant','Restaurant','Auto Dealership','Drug Store','Bank','Value Add Strip','NNN Retail','Grocery Anchored'],
  'Shopping Center':       ['Strip Center','Neighborhood Center','Community Center','Power Center','Lifestyle Center','Regional Mall','Super Regional Mall','Outlet Center'],
  'Mixed Use':             ['Retail / Residential (Ground Floor Retail + Upper Residential)','Office / Residential','Retail / Office','Live-Work','Mixed Commercial','Ground Floor Retail + Apartments'],
  'Land':                  ['Commercial','Residential','Industrial','Agricultural','Mixed Use','Infill','Pad Site','Development'],
  'Agricultural':          ['Row Crops','Orchards/Vineyards','Livestock','Dairy','Poultry','Timberland','Irrigation'],
  'Hotel & Motel':         ['Full Service','Select Service','Extended Stay','Budget/Economy','Boutique','Resort','Motel','Hostel'],
  'Senior Housing':        ['Independent Living','Assisted Living','Memory Care','Skilled Nursing','CCRC','Active Adult'],
  'Health Care':           ['Medical Office','Urgent Care','Surgery Center','Hospital','Rehabilitation','Behavioral Health','Lab/Life Science'],
  'Sport & Entertainment': ['Arena/Stadium','Movie Theater','Bowling','Golf Course','Fitness/Gym','Marina','Event Venue','Amusement'],
  'Special Purpose':       ['Car Wash','Gas Station','Parking Lot/Garage','Cemetery','Church/Religious','School','Community Center','Government','Funeral Home'],
  'Automotive':            ['Auto Body Shop','Auto Repair / Mechanic','Auto Dealership (New)','Auto Dealership (Used)','Auto Parts Store','Tire Shop','Oil Change / Lube','Towing Facility','Auto Auction','Car Wash'],
  'Residential Income':    ['Single Family Rental','Duplex','Triplex','Fourplex','Small Multifamily (5-20)','Large Multifamily (21+)','Mobile Home Park'],
}
const FINANCING_TYPES = ['Cash', 'Financing', '1031', 'Mix']
const MF_STYLES = ['Garden', 'Mid-rise', 'High-rise', 'Walk-up', 'Townhome', 'Mixed']
const MF_CLASSES = ['A', 'B', 'C', 'A/B', 'B/C']
const MF_DEAL_PROFILES = ['Value-add', 'Stabilized', 'Heavy lift', 'Distressed', 'Development']
const OFFICE_CLASSES = ['A', 'B', 'C', 'A/B', 'B/C']
const INVESTOR_OR_OWNER = ['Investor', 'Owner-User', 'Either']
const ANCHOR_PREFS = ['Anchored', 'Non-anchored', 'Either']
const LEASE_PREFS = ['NNN', 'Absolute Net', 'Modified Gross', 'Gross', 'Either']
const AUTO_GAS = ['With Gas', 'Without Gas', 'Either']
const AUTO_TYPES = ['Gas Station', 'Auto Repair', 'Car Wash', 'Tire Shop', 'Dealership', 'Body Shop', 'Other']
// v235
const HOTEL_FLAG_PREFS = ['Branded', 'Independent', 'Boutique', 'Either']
const STORAGE_CLIMATE = ['Climate', 'NonClimate', 'Either']
const MHP_OWNERSHIP = ['POH', 'TOH', 'Mix', 'Either']
const HEALTHCARE_SUBTYPES = ['MOB', 'Surgery', 'Senior', 'Skilled', 'Other']

const FIELD_SPEC: FieldDef[] = [
  // Asset Types
  { col: 'desired_property_types', label: 'Desired Property Types', type: 'multienum', group: 'Asset Types',
    options: ASSET_TYPE_VOCAB,
    hint: 'Comma-separated list of asset classes the buyer is interested in. Pick ONLY from the allowed options.' },

  // Location
  { col: 'location_preferences', label: 'Location Preferences (free-form)', type: 'text', group: 'Location',
    hint: 'Free-form description of areas the buyer wants — e.g. "North Jersey, within 1 hour of Newark", "anywhere in the Sun Belt".' },
  { col: 'simple_area_preference', label: 'Simple Area Preference', type: 'text', group: 'Location',
    hint: 'Short comma-separated list of region labels the buyer named (e.g. "North NJ, Central NJ"). The client picker only accepts curated region labels — if the buyer named a county or city, put that in preferred_counties / preferred_cities, NOT here.' },
  { col: 'preferred_counties', label: 'Preferred Counties', type: 'csv', group: 'Location',
    hint: 'Comma-separated counties formatted as "<County> County, <ST>" (e.g. "Essex County, NJ, Bergen County, NJ").' },
  { col: 'preferred_states', label: 'Preferred States', type: 'csv', group: 'Location',
    hint: 'Comma-separated 2-letter state codes (e.g. "NJ, PA, NY").' },
  { col: 'preferred_cities', label: 'Preferred Cities', type: 'csv', group: 'Location',
    hint: 'Comma-separated city names the buyer mentioned.' },

  // Pricing
  { col: 'min_purchase_price', label: 'Min Purchase Price', type: 'number', group: 'Pricing',
    hint: 'Lowest TOTAL dollar price the buyer will pay for a whole property. Number only, no $ or commas. CRITICAL: do NOT use per-square-foot or per-acre or per-unit prices here — those are different fields.' },
  { col: 'max_purchase_price', label: 'Max Purchase Price', type: 'number', group: 'Pricing',
    hint: 'Highest TOTAL dollar price / budget ceiling for a whole property. Number only. CRITICAL: ignore $/SF, $/acre, $/unit figures — those go to other fields.' },
  { col: 'budget_is_deal_dependent', label: 'Budget Depends On Deal', type: 'boolean', group: 'Pricing',
    hint: 'true if the buyer says budget "depends on the deal" / has no fixed cap; false if they gave a hard number.' },
  { col: 'financing_type', label: 'Financing Type', type: 'enum', group: 'Pricing',
    options: FINANCING_TYPES,
    hint: 'How the buyer is paying. Pick from the allowed options only.' },
  { col: 'minimum_cap_rate', label: 'Minimum Cap Rate', type: 'number', group: 'Pricing',
    hint: 'Lowest cap rate the buyer will accept, as a percent (e.g. 6.5 not 0.065).' },

  // Multifamily
  { col: 'mf_min_units', label: 'MF Min Units', type: 'number', group: 'Multifamily',
    hint: 'Minimum unit count for multifamily deals (integer). Only set when the buyer explicitly states a lower bound.' },
  { col: 'mf_max_units', label: 'MF Max Units', type: 'number', group: 'Multifamily',
    hint: 'Maximum unit count for multifamily deals (integer). Only set when the buyer explicitly states an upper bound. NEVER copy mf_min_units into here for a single estimate.' },
  { col: 'mf_style_preference', label: 'MF Style', type: 'enum', group: 'Multifamily',
    options: MF_STYLES,
    hint: 'Building style preference. Pick from the allowed options only.' },
  { col: 'mf_class_preference', label: 'MF Class', type: 'enum', group: 'Multifamily',
    options: MF_CLASSES,
    hint: 'Asset class preference. Pick from the allowed options only.' },
  { col: 'mf_deal_profile', label: 'MF Deal Profile', type: 'enum', group: 'Multifamily',
    options: MF_DEAL_PROFILES,
    hint: 'Strategy preference. Pick from the allowed options only.' },
  { col: 'mf_max_price_per_unit', label: 'MF Max Price / Unit', type: 'number', group: 'Multifamily',
    hint: 'Maximum dollars-per-unit the buyer will pay (number only).' },

  // Warehouse
  { col: 'warehouse_min_sf', label: 'Warehouse Min SF', type: 'number', group: 'Warehouse',
    hint: 'Minimum building square footage for warehouse/industrial. Only set when the buyer states a lower bound ("at least 5k", "5k-20k SF"). For a single ballpark like "~10k SF", LEAVE BLANK and put the estimate in warehouse_target_sf instead.' },
  { col: 'warehouse_max_sf', label: 'Warehouse Max SF', type: 'number', group: 'Warehouse',
    hint: 'Maximum building square footage. Only set when the buyer states an upper bound ("under 20k", "5k-20k SF"). NEVER copy warehouse_min_sf into here for a single estimate. For "~10k SF" alone, leave blank and use warehouse_target_sf.' },
  { col: 'warehouse_target_sf', label: 'Warehouse Target SF', type: 'number', group: 'Warehouse',
    hint: 'Single approximate SF target. Use ONLY when the buyer states a ballpark ("~10k SF", "around 10k", "about 10,000") with no explicit min/max range. Do not set this AND warehouse_min_sf/max_sf on the same buyer for the same SF figure.' },
  { col: 'warehouse_features', label: 'Warehouse Features', type: 'text', group: 'Warehouse',
    hint: 'Notable feature requirements — e.g. "drive-in doors", "rail access", "outside storage".' },
  { col: 'warehouse_profile_preference', label: 'Warehouse Profile', type: 'text', group: 'Warehouse',
    hint: 'Investment profile — e.g. "Stabilized NNN", "Value-add", "Owner-user".' },
  { col: 'warehouse_min_clear_height', label: 'Warehouse Min Clear Height (ft)', type: 'number', group: 'Warehouse',
    hint: 'Minimum clear ceiling height in feet (integer).' },
  { col: 'warehouse_min_docks', label: 'Warehouse Min Loading Docks', type: 'number', group: 'Warehouse',
    hint: 'Minimum loading-dock count (integer).' },
  { col: 'warehouse_investor_or_owner', label: 'Warehouse Investor/Owner-User', type: 'enum', group: 'Warehouse',
    options: INVESTOR_OR_OWNER,
    hint: 'Whether the buyer wants this as an investment or to occupy. Pick from allowed options only.' },

  // Office
  { col: 'office_min_sf', label: 'Office Min SF', type: 'number', group: 'Office',
    hint: 'Minimum office building square footage. Same range/single-estimate rule as warehouse_min_sf — use office_target_sf for ballpark.' },
  { col: 'office_max_sf', label: 'Office Max SF', type: 'number', group: 'Office',
    hint: 'Maximum office building square footage. NEVER copy office_min_sf here for a single estimate.' },
  { col: 'office_target_sf', label: 'Office Target SF', type: 'number', group: 'Office',
    hint: 'Single approximate SF target for office ("~8k SF"). Same single-estimate rule as warehouse_target_sf.' },
  { col: 'office_class_preference', label: 'Office Class', type: 'enum', group: 'Office',
    options: OFFICE_CLASSES,
    hint: 'Office class preference. Pick from the allowed options only.' },
  { col: 'office_min_tenants', label: 'Office Min Tenants', type: 'number', group: 'Office',
    hint: 'Minimum number of tenants (integer).' },
  { col: 'office_max_tenants', label: 'Office Max Tenants', type: 'number', group: 'Office',
    hint: 'Maximum number of tenants (integer). Never copy office_min_tenants here.' },

  // Retail
  { col: 'retail_min_tenants', label: 'Retail Min Tenants', type: 'number', group: 'Retail',
    hint: 'Minimum tenant count for retail strip malls.' },
  { col: 'retail_tenant_type', label: 'Retail Tenant Type', type: 'text', group: 'Retail',
    hint: 'Tenant mix preferences — e.g. "national credit tenants", "service-oriented", "no restaurants".' },
  { col: 'retail_min_occupancy', label: 'Retail Min Occupancy %', type: 'number', group: 'Retail',
    hint: 'Minimum occupancy percentage 0-100 (integer).' },
  { col: 'retail_min_sf', label: 'Retail Min SF', type: 'number', group: 'Retail',
    hint: 'Minimum gross leasable square footage for retail. Same range/single-estimate rule as warehouse_min_sf — use retail_target_sf for ballpark.' },
  { col: 'retail_max_sf', label: 'Retail Max SF', type: 'number', group: 'Retail',
    hint: 'Maximum gross leasable square footage for retail. NEVER copy retail_min_sf here for a single estimate.' },
  { col: 'retail_target_sf', label: 'Retail Target SF', type: 'number', group: 'Retail',
    hint: 'Single approximate SF target for retail. Same single-estimate rule as warehouse_target_sf.' },
  { col: 'retail_anchor_preference', label: 'Retail Anchor Preference', type: 'enum', group: 'Retail',
    options: ANCHOR_PREFS,
    hint: 'Whether the buyer wants an anchor tenant. Pick from allowed options only.' },
  { col: 'retail_lease_preference', label: 'Retail Lease Preference', type: 'enum', group: 'Retail',
    options: LEASE_PREFS,
    hint: 'Lease structure preference. Pick from allowed options only.' },

  // Shopping Center
  { col: 'shopping_min_sf', label: 'Shopping Center Min SF', type: 'number', group: 'Shopping Center',
    hint: 'Minimum total square footage for shopping centers. Same range/single-estimate rule as warehouse_min_sf — use shopping_target_sf for ballpark.' },
  { col: 'shopping_max_sf', label: 'Shopping Center Max SF', type: 'number', group: 'Shopping Center',
    hint: 'Maximum total square footage for shopping centers. NEVER copy shopping_min_sf here for a single estimate.' },
  { col: 'shopping_target_sf', label: 'Shopping Center Target SF', type: 'number', group: 'Shopping Center',
    hint: 'Single approximate SF target for shopping centers. Same single-estimate rule as warehouse_target_sf.' },
  { col: 'shopping_min_tenants', label: 'Shopping Center Min Tenants', type: 'number', group: 'Shopping Center',
    hint: 'Minimum tenant count for shopping centers.' },

  // Mixed Use
  { col: 'mixeduse_min_residential', label: 'Mixed-Use Min Residential Units', type: 'number', group: 'Mixed Use',
    hint: 'Minimum residential unit count in a mixed-use building.' },
  { col: 'mixeduse_min_commercial', label: 'Mixed-Use Min Commercial Units', type: 'number', group: 'Mixed Use',
    hint: 'Minimum commercial unit count in a mixed-use building.' },
  { col: 'mixeduse_min_sf', label: 'Mixed-Use Min Total SF', type: 'number', group: 'Mixed Use',
    hint: 'Minimum total square footage for the mixed-use building. Same range/single-estimate rule as warehouse_min_sf — use mixeduse_target_sf for ballpark.' },
  { col: 'mixeduse_target_sf', label: 'Mixed-Use Target SF', type: 'number', group: 'Mixed Use',
    hint: 'Single approximate SF target for mixed-use. Same single-estimate rule as warehouse_target_sf.' },

  // Automotive
  { col: 'automotive_gas_preference', label: 'Automotive Gas Preference', type: 'enum', group: 'Automotive',
    options: AUTO_GAS,
    hint: 'Whether buyer wants gas pumps included. Pick from allowed options only.' },
  { col: 'automotive_type_preference', label: 'Automotive Type', type: 'enum', group: 'Automotive',
    options: AUTO_TYPES,
    hint: 'Auto-business sub-type. Pick from allowed options only.' },
  { col: 'automotive_min_bays', label: 'Automotive Min Bays', type: 'number', group: 'Automotive',
    hint: 'Minimum service-bay count (integer).' },

  // Hotel (v235)
  { col: 'hotel_min_keys', label: 'Hotel Min Keys / Rooms', type: 'number', group: 'Hotel',
    hint: 'Minimum room/key count for hotels. Only set when the buyer states a lower bound.' },
  { col: 'hotel_max_keys', label: 'Hotel Max Keys / Rooms', type: 'number', group: 'Hotel',
    hint: 'Maximum room/key count. Never copy hotel_min_keys here for a single estimate.' },
  { col: 'hotel_flag_preference', label: 'Hotel Flag Preference', type: 'enum', group: 'Hotel',
    options: HOTEL_FLAG_PREFS,
    hint: 'Brand preference. Pick from allowed options only.' },
  { col: 'hotel_notes', label: 'Hotel Notes', type: 'text', group: 'Hotel',
    hint: 'Free-form notes on operating model — e.g. "limited service", "extended stay", "must be franchise".' },

  // Self Storage (v235)
  { col: 'storage_min_units', label: 'Storage Min Units / Doors', type: 'number', group: 'Self Storage',
    hint: 'Minimum unit / door count for self-storage facilities (integer).' },
  { col: 'storage_min_net_sf', label: 'Storage Min Net Rentable SF', type: 'number', group: 'Self Storage',
    hint: 'Minimum net rentable square footage.' },
  { col: 'storage_climate', label: 'Storage Climate-Controlled?', type: 'enum', group: 'Self Storage',
    options: STORAGE_CLIMATE,
    hint: 'Whether buyer requires climate-controlled units. Pick from allowed options only.' },

  // Mobile Home Park (v235)
  { col: 'mhp_min_pads', label: 'MHP Min Pads', type: 'number', group: 'Mobile Home Park',
    hint: 'Minimum pad / lot count for mobile home parks (integer).' },
  { col: 'mhp_max_pads', label: 'MHP Max Pads', type: 'number', group: 'Mobile Home Park',
    hint: 'Maximum pad / lot count. Never copy mhp_min_pads here for a single estimate.' },
  { col: 'mhp_ownership', label: 'MHP Ownership Model', type: 'enum', group: 'Mobile Home Park',
    options: MHP_OWNERSHIP,
    hint: 'Park-owned vs tenant-owned vs mix. Pick from allowed options only.' },

  // Healthcare (v235)
  { col: 'healthcare_min_sf', label: 'Healthcare Min SF', type: 'number', group: 'Healthcare',
    hint: 'Minimum SF for healthcare/medical buildings.' },
  { col: 'healthcare_max_sf', label: 'Healthcare Max SF', type: 'number', group: 'Healthcare',
    hint: 'Maximum SF. Never copy healthcare_min_sf here for a single estimate.' },
  { col: 'healthcare_subtype', label: 'Healthcare Sub-Type', type: 'enum', group: 'Healthcare',
    options: HEALTHCARE_SUBTYPES,
    hint: 'Sub-type within healthcare. Pick from allowed options only.' },

  // Special Purpose (v235)
  { col: 'special_purpose_use', label: 'Special Purpose Use', type: 'text', group: 'Special Purpose',
    hint: 'Free-form description of what the buyer wants for special-purpose property — e.g. "religious", "day care", "marina", "post office".' },

  // Development (v235)
  { col: 'development_project_type', label: 'Development Project Type', type: 'text', group: 'Development',
    hint: 'What is being built — e.g. "ground-up multifamily", "hotel", "mixed-use", "self-storage".' },
  { col: 'development_stage', label: 'Development Stage', type: 'text', group: 'Development',
    hint: 'Project stage — e.g. "approvals in place", "raw land", "tear-down", "permits ready".' },
  { col: 'development_min_size', label: 'Development Min Buildable Size', type: 'number', group: 'Development',
    hint: 'Minimum buildable size (square footage or unit count, whichever the buyer references).' },
  { col: 'development_max_size', label: 'Development Max Buildable Size', type: 'number', group: 'Development',
    hint: 'Maximum buildable size. Never copy development_min_size here for a single estimate.' },

  // Land
  { col: 'land_min_acreage', label: 'Land Min Acreage', type: 'number', group: 'Land',
    hint: 'Minimum acreage (decimal allowed, e.g. 2.5). Only set when the buyer states a lower bound.' },
  { col: 'land_max_acreage', label: 'Land Max Acreage', type: 'number', group: 'Land',
    hint: 'Maximum acreage. Never copy land_min_acreage here for a single estimate.' },
  { col: 'land_intended_use', label: 'Land Intended Use', type: 'text', group: 'Land',
    hint: 'Buyer plans for the land — e.g. "ground-up multifamily", "self-storage development", "hold for appreciation".' },
  { col: 'land_zoning_preference', label: 'Land Zoning Preference', type: 'text', group: 'Land',
    hint: 'Zoning preferences — e.g. "industrial", "C-2 commercial", "approvals already in place".' },

  // Special / Misc
  { col: 'other_requirements', label: 'Other Requirements', type: 'text', group: 'Misc',
    hint: 'Anything else the buyer cares about that does not fit another field — short paragraph.' },
  { col: 'deals_sent_notes', label: 'Deals Already Sent', type: 'text', group: 'Misc',
    hint: 'References to specific properties or deals previously shown to this buyer (addresses, deal nicknames, etc.).' },
  { col: 'is_vip_buyer', label: 'VIP Buyer', type: 'boolean', group: 'Misc',
    hint: 'true ONLY when notes/tags clearly mark the buyer as VIP / top-tier / trusted / high-priority. Default false; do not propose true on weak signals.' },
]

const FIELD_SPEC_COLS = new Set(FIELD_SPEC.map(f => f.col))

interface BodyShape {
  buyer_criteria_id?: string
  dry_run?: boolean
  only_fill_empty?: boolean
  additional_text?: string
  contact_tags?: string[]   // v270
  model?: string            // v279 — "sonnet" | "haiku" | full model id
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function capText(s: unknown, max: number): string {
  if (s == null) return ''
  const str = String(s)
  return str.length > max ? str.slice(0, max) : str
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string' && v.trim() === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  return false
}

function tryRepairJson(raw: string): string {
  // v309: handle more Claude failure modes — trailing commas (common when
  // the response gets cut off mid-list), smart quotes, and stray content
  // before/after the JSON object. The caller still wraps this in a JSON.parse
  // try/catch so anything not fixable bubbles up as 502.
  let s = raw.replace(/```json|```/g, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1)
  // Replace common smart quotes that LLMs sometimes emit when echoing user prose.
  s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
  // Strip trailing commas before } or ] (most common LLM mistake when
  // a list is being progressively built and the response is cut early).
  s = s.replace(/,(\s*[}\]])/g, '$1')
  return s
}

function coerce(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return null
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(v)) return true
      if (['false', 'no', 'n', '0'].includes(v)) return false
    }
    return null
  }
  if (type === 'number') {
    if (typeof value === 'number' && isFinite(value)) return value
    if (typeof value === 'string') {
      const cleaned = value.replace(/[$,%\s]/g, '')
      const n = Number(cleaned)
      return isFinite(n) ? n : null
    }
    return null
  }
  if (type === 'csv') {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean).join(', ')
    if (typeof value === 'string') return value.trim() || null
    return null
  }
  if (type === 'enum' || type === 'multienum') {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean).join(', ')
    if (typeof value === 'string') return value.trim() || null
    return null
  }
  if (typeof value === 'string') return value.trim() || null
  return String(value)
}

function matchOption(raw: string, options: string[]): string | null {
  const norm = raw.trim().toLowerCase()
  if (!norm) return null
  for (const o of options) {
    if (o.toLowerCase() === norm) return o
  }
  const loose = norm.replace(/[^a-z0-9]/g, '')
  for (const o of options) {
    if (o.toLowerCase().replace(/[^a-z0-9]/g, '') === loose) return o
  }
  return null
}

function validateEnumProposal(value: unknown, type: FieldType, options: string[], subtypeMap?: Record<string, string[]>): string | null {
  // v287: subtypeMap optional override (used for runtime taxonomy from
  // ace_ai_settings). Defaults to the module-level ASSET_SUBTYPES const.
  const subMap = subtypeMap || ASSET_SUBTYPES
  if (value === null || value === undefined) return null
  const str = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(String).join(', ')
      : String(value)
  if (type === 'enum') return matchOption(str, options)
  const parts = str.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
  const matched: string[] = []
  for (const p of parts) {
    // v272: support "Category: Subtype" chips (e.g. "Retail: Grocery
    // Anchored", "Industrial: Self Storage"). Validate the category against
    // the vocab; if a subtype is present and recognized in subMap,
    // re-attach it. If the subtype isn't recognized, fall back to the bare
    // category rather than dropping the chip entirely.
    const colonIdx = p.indexOf(':')
    if (colonIdx > 0) {
      const cat = p.slice(0, colonIdx).trim()
      const sub = p.slice(colonIdx + 1).trim()
      const matchedCat = matchOption(cat, options)
      if (matchedCat) {
        const subVocab = subMap[matchedCat] || []
        const matchedSub = sub ? matchOption(sub, subVocab) : null
        const canonical = matchedSub ? `${matchedCat}: ${matchedSub}` : matchedCat
        if (!matched.includes(canonical)) matched.push(canonical)
        continue
      }
    }
    const m = matchOption(p, options)
    if (m && !matched.includes(m)) matched.push(m)
  }
  return matched.length ? matched.join(', ') : null
}

async function fetchSb(url: string, serviceKey: string): Promise<unknown> {
  const r = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Supabase ${r.status} on ${url}: ${txt.slice(0, 200)}`)
  }
  return r.json()
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — STATIC PORTION
// ═══════════════════════════════════════════════════════════════════════
// This is the prompt-cached block. It MUST stay byte-identical across calls
// to hit the Anthropic prompt cache (90% off cached input tokens, 5-min TTL).
// Any per-buyer dynamic content goes into the user message instead.
//
// When iterating: bump PROMPT_VERSION above so the diagnostic blob shows
// which version of the prompt produced which output.
// ═══════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT_STATIC = `You are an extraction engine for a commercial real-estate buyer-criteria CRM.

You read communication notes about a contact and output a JSON description
of what they want to buy. You receive THREE inputs and produce ONE output.

INPUTS:
  1. CONTACT TAGS — chips on the contact card (e.g. "Buyer", "Seller",
     "asset - multi family", "1031 Investor", "VIP"). High-signal,
     deterministic. Trust them more than free-text notes.
  2. COMMUNICATION NOTES — call summaries, FUB notes, Ace contact notes,
     contact-record fields. Most-recent-first.
  3. USER ADDITIONAL CONTEXT — free-form text the agent typed before
     pressing the AI Auto-Fill button.

OUTPUT: a single JSON object (no preamble, no code fences) — schema below.

═══════════════════════════════════════════════════════════════════════
STEP 1 — DETERMINE BUY-INTENT BEFORE EXTRACTING ANYTHING
═══════════════════════════════════════════════════════════════════════
Decide if this contact is a buyer at all. Set "buy_intent" to one of:
"buyer" | "seller_only" | "both" | "ambiguous".

TAG-BASED RULES (highest priority):
  - "Buyer" tag present → "buyer". High confidence; proceed with full
    extraction.
  - "Buyer" + "Seller" tags both present → "both". Still proceed with
    buyer extraction (their seller-side activity is logged separately).
  - "Seller" tag alone (no "Buyer") → "seller_only". Return mostly empty
    "fields"; add to top_level_notes: "appears seller-only — confirm
    before extracting buyer criteria."
  - NO TAGS AT ALL → infer from the notes:
      Positive buyer signals: "looking for", "wants to buy", "seeking",
        "in the market for", "investor", "1031 exchange", "would buy at
        the right price".
      Negative buyer signals: "trying to sell", "my listing", "asking
        price for my building", "selling my property".
      If positive signals dominate → "buyer".
      If negative dominate → "seller_only".
      If both/neither → "ambiguous"; return mostly empty fields and add
        top_level_notes: "could not confirm buyer intent from notes."

OTHER TAG RULES (apply when buy_intent is "buyer" or "both"):
  - "asset - <type>" (e.g. "asset - multi family", "asset - warehouse",
    "asset - retail", "asset - office", "asset - land") → seed the
    matching asset class. Always include the matched type in
    desired_property_types. Set the cite for desired_property_types as
    "tag: asset - <type>" so it's clear the source was a tag.
    ASSET-CLASS TAGS ARE SOURCE-OF-TRUTH. NEVER QUESTION OR REMOVE THEM.
    If the contact is tagged "asset - multi family" but the notes are
    silent about MF or focused on something else, the contact IS still
    a multifamily buyer — agents curate these tags deliberately. Your
    job is NOT to ask the agent to confirm the tag; your job is to
    keep "Multifamily" in desired_property_types regardless of whether
    you find MF buy-box detail in the notes.
       - If notes have NO MF-specific detail: propose only the bare
         category ("Multifamily"). Leave mf_min_units / mf_max_units /
         mf_class_preference / etc. EMPTY. Do NOT mark them na, do
         NOT flag them as uncertain. The buyer is a known MF buyer
         whose buy-box detail just isn't captured yet.
       - If notes DO mention MF detail anywhere: extract that detail
         normally per Step 2 rules.
       - If notes mention OTHER asset classes alongside MF (e.g. they
         also discuss retail), include BOTH in desired_property_types.
         Tags don't go away just because notes show breadth.
       - NEVER add a top_level_notes line saying "MF tag may be an
         error" or "agent should confirm tag". The tag is correct.
    Tag → vocab category mapping:
      "asset - multi family"    → "Multifamily"
      "asset - warehouse"       → "Industrial"  (Industrial covers
                                  warehouse, distribution, flex,
                                  manufacturing, cold storage, self
                                  storage, etc.)
      "asset - retail"          → "Retail" AND/OR "Shopping Center"
                                  (use Shopping Center when notes
                                  mention 100k+ SF or grocery-anchored
                                  centers; use Retail for smaller
                                  inline / strip / single-tenant)
      "asset - office"          → "Office"
      "asset - land"            → "Land"
      "asset - hotel"           → "Hotel & Motel"
      "asset - mobile home"     → "Residential Income" (with subtype
                                  "Mobile Home Park" if notes warrant)
      "asset - self storage"    → "Industrial: Self Storage"
      "asset - repair shop"     → "Automotive: Auto Repair / Mechanic"
      "asset - auto repair"     → "Automotive: Auto Repair / Mechanic"
      "asset - mechanic"        → "Automotive: Auto Repair / Mechanic"
      "asset - body shop"       → "Automotive: Auto Body Shop"
      "asset - auto body"       → "Automotive: Auto Body Shop"
      "asset - car wash"        → "Automotive: Car Wash" (sometimes
                                  also "Special Purpose: Car Wash"
                                  — keep both if BC already has both)
      "asset - tire shop"       → "Automotive: Tire Shop"
      "asset - dealership"      → "Automotive: Auto Dealership (New)" or "(Used)"
      "asset - gas station"     → "Special Purpose: Gas Station"
      "asset - mixed use"       → "Mixed Use"
      "asset - medical"         → "Health Care: Medical Office"
      "asset - mhp"             → "Residential Income: Mobile Home Park"
      "asset - business"        → leave existing chips; "Business" isn't
                                  a vocab category by itself — needs notes
                                  to disambiguate which Automotive /
                                  Special Purpose / Industrial bucket fits
      UNKNOWN "asset - X" tag — if X doesn't match any mapping above,
      do NOT clear or change desired_property_types. Find the closest
      vocab category in your judgment and ADD it to the existing
      chips (don't replace). If no obvious match exists, leave
      desired_property_types untouched and put "Tag 'asset - X' had
      no clean vocab match — agent should classify manually" in
      other_requirements.
  - "1031 Investor" or "1031" → bias financing_type to "1031".
  - "VIP" → set is_vip_buyer = true. Cite: "tag: VIP".
  - "Bounced" → ignore. Email deliverability flag, not a buying signal.
  - U.S. STATE-NAME tags ("New Jersey", "Pennsylvania", "New York",
    "Florida", etc.) → include the 2-letter code in preferred_states.
    Cite: "tag: <Tag value>".
  - COUNTY-NAME tags ("Union county", "Essex County", "Bergen County",
    "Suffolk County", any tag matching "<Name> [Cc]ount[yi](?:es)?"):
    promote into preferred_counties as "<Name> County, <ST>" — infer
    the state from other state-level signals (state tag, notes,
    state-name in the tag itself). Cite: "tag: <Tag value>".
  - PERSON-NAME tags (a tag that looks like "First Last", e.g.
    "Daniel Keenan") → IGNORE. These are usually the agent who created
    the contact, not a buy signal.
  - SYSTEM / CRM tags ("fub export", "hl_engaged", "imported",
    "Bounced", any tag starting with a lowercase prefix that looks
    like a system flag) → IGNORE. Not buy signals.
  - HIGH-ENGAGEMENT tags ("hl_engaged", "engaged buyer", "active buyer",
    "warm") → on their own DO NOT trigger is_vip_buyer. Use them only
    in combination with explicit VIP language in the notes.

═══════════════════════════════════════════════════════════════════════
STEP 1.5 — DETECT DUAL-ROLE (BUYER + SELLER) CONTACTS
═══════════════════════════════════════════════════════════════════════
A contact tagged "Buyer" can ALSO be the seller of a specific property
within the same set of notes. This is common: a contact's 2024 notes
show their buy-box ("Multi Fam 4-6 Units") and their 2026 notes show
them selling their own property. When this happens, you MUST identify
which notes are buyer-side vs seller-side and treat them as separate
data streams.

SELLER-SIDE PHRASING (the contact owns the property being discussed):
  - "Asking: $X" / "He's asking $X" / "the asking is $X"
  - "owes $X in a loan" / "current debt is $X" / "mortgage balance"
  - "his property" / "his building" / "her listing" / "their unit"
  - "Offered him $X" / "I offered him $X" / "another guy offered him"
  - "he wants $X for it" / "she'll take $X net"
  - Detailed financials about ONE specific property (rent roll,
    NOI breakdown, expenses, parking income, tax/insurance/water)
    when the conversational frame is about that single property
  - "I told him to move on the offer" / "told her to take it"

BUYER-SIDE PHRASING (the contact wants to buy):
  - "Looking for X-Y units" / "Multi Fam 4-6 Units"
  - "Sent him a property" / "sent <address> to him"
  - "He sounded interested" / "she'd like to see"
  - "In the market for", "wants to buy", "seeking"
  - Stated criteria with NO specific property attached
  - "1031 exchange", "1031 buyer"

Rules:
  - When BOTH kinds appear → buy_intent stays "buyer" (or upgrade to
    "both" when there's also a Seller tag). But you MUST mark each
    note in your reasoning as BUYER-SIDE or SELLER-SIDE before
    extracting any values.
  - SELLER-SIDE notes contribute ZERO to buy-box fields. Asking
    prices, offer amounts, debt balances, and rent rolls on the
    contact's OWN property NEVER feed: max_purchase_price,
    min_purchase_price, financing_type, mf_min_units, any *_sf
    field, minimum_cap_rate, etc. Even if those numbers are the
    only price signal in the entire note set.
  - SELLER-SIDE activity goes in other_requirements as context only:
    "Note: contact also has seller-side activity — owns/sells
    [address] [period]. Numbers from that side were not used for
    the buy-box."
  - NEVER hallucinate a buyer-side reading of seller-side data. Do
    not treat "Asking: $1.45m -owes $250K" as "buyer is pursuing a
    $1.45M deal." That is the contact's ASKING price on a property
    THEY own. It is NOT their buy-box.

═══════════════════════════════════════════════════════════════════════
STEP 2 — READ THE NOTES, FILL FIELDS
═══════════════════════════════════════════════════════════════════════

NOTES-READING RULES:

1. STATED vs ASPIRATIONAL vs HISTORICAL:
   - STATED buy-box ("looking for 20-40 units") → fill min/max fields.
   - ASPIRATIONAL ("would love a 200-unit one day", "dream deal would be")
     → DO NOT fill min/max. Optionally mention in *_notes free-text.
   - HISTORICAL ("we owned a strip mall in 2019", "I previously bought")
     → DO NOT fill. Past ownership is not buy-box.

1a. STATED BUY-BOX ALWAYS WINS — PAST DEAL ACTIVITY DOES NOT OVERRIDE.
   When the notes contain an explicit min/max range (especially if it
   appears more than once: "Multi Fam 4-6 Units", "Multi Fam 4-6 Units"),
   you MUST populate the structured min/max fields with that range,
   even when other notes show the buyer pursued a deal slightly outside
   the range ("sent 8U, sounded interested" when stated buy-box is 4-6).

   Rationale: downstream buyer search applies a ±N "forgiveness" slider.
   A 4-6 unit buyer with a ±2 forgiveness is found for any 2-8 unit
   deal. If you leave mf_min_units / mf_max_units empty because of an
   8-unit data point, the buyer becomes invisible to the search and
   the forgiveness has nothing to flex against.

   Specifically:
   - If a stated range is repeated in 2+ notes, treat it as canonical
     buy-box. Fill it with HIGH confidence. Mention any out-of-range
     deal activity in other_requirements as a flexibility note —
     "Showed interest in an 8-unit in Aug 2024, slightly above stated
     4-6 range." Do NOT flag the min/max as uncertain.
   - If two stated ranges conflict (e.g. "4-6 units" in 2024, "10-20
     units" in 2026), the recent one wins per rule #2 (RECENCY).
   - Only flag a stated range as uncertain when there is GENUINE
     ambiguity in the most-recent stated buy-box itself, not when
     past deal activity merely flexed beyond the stated range.

2. RECENCY: When two notes conflict, prefer the more-recent one.
   created_at timestamps are provided in [brackets] before each note.

3. SOURCE WEIGHTING:
   - Agent-written call summaries are higher signal than marketing emails.
   - Numbers in agent notes outweigh numbers in auto-generated emails.
   - First-person buyer quotes ("I want X") are highest signal.
   - "Additional context" (user-supplied) is high-signal — that's the
     agent telling you something specific.

4. CONFLICTING VALUES: If the same field appears multiple times with
   different values, take the most recent. Optionally put the alternative
   in the matching free-text *_notes field.

5. EMPTY ≠ N/A: Leave a field unset (omit from "fields") when there's
   no signal. Mark a field as "na" ONLY when the buyer EXPLICITLY
   excluded it ("no preference on X", "doesn't matter", "anything works").

5a. NEVER PROPOSE N/A FOR desired_property_types WHEN CHIPS OR TAGS
   EXIST. Existing asset-class chips on the BC and "asset - <type>"
   tags on the contact are source-of-truth — agents curate them
   deliberately. You are FORBIDDEN from proposing
   desired_property_types as "na" / "no_preference" / "no_pref" /
   "any" / "doesn't matter" when EITHER:
     (a) the BC's current desired_property_types value is non-empty
         (the BEFORE column in the review modal shows chips), OR
     (b) the contact has ANY "asset - <type>" tag.
   Sparse / transactional call notes ("send property X to him",
   "left voicemail", "looking at deal") are NOT evidence the buyer
   has no asset preference — they're evidence the agent didn't
   restate the buy-box in that call. The chips and tags ARE the
   buy-box. Preserve them.
   The only legitimate way for desired_property_types to lose a
   chip is if the buyer EXPLICITLY says "I don't do <X> anymore"
   or "drop <X> from my criteria" — and even then, propose a
   targeted edit (remove just that chip) via a top_level_notes
   line; do NOT clear the whole field.
   If you're tempted to write "Will clear current value" or
   "no_preference" on desired_property_types because the call
   notes are thin — STOP. Omit the field from "fields" entirely
   and from "na". The existing value stays.

6. GEOGRAPHY MUST BE DECOMPOSED — ALL FOUR STRUCTURED FIELDS REQUIRED
   WHEN THE SIGNALS ARE PRESENT. When the notes describe a region in
   prose ("Boston to Philadelphia corridor extending into central PA
   and the Hudson Valley"), do NOT just dump it into
   location_preferences. ALWAYS also fill these structured fields when
   the signal exists:

     - preferred_states (REQUIRED when ANY geographic signal exists):
       Comma-separated 2-letter codes covering the prose. "Boston to
       Philly" implies MA, RI, CT, NY, NJ, PA. "Hudson Valley" implies
       NY. Be over-inclusive at the state level. State-name tags
       ("Pennsylvania") add their 2-letter code.

     - preferred_cities (REQUIRED when ANY city is named in the notes):
       Every city the notes name by name MUST go here, comma-separated.
       This is non-optional. If the call note says "Pennsville,
       Burlington" — both cities. If the note says "looking in
       Elizabeth" — Elizabeth. If 5 cities are named — all 5. The
       only reason to leave this blank is if NO cities are named at
       all in any note.

     - preferred_counties (REQUIRED when a county is named outright):
       Format: "<County> County, <ST>" — e.g. "Bergen County, NJ",
       "Suffolk County, NY". Don't infer counties from cities. But
       DO read county tags ("Union county", "Essex county", "Bergen
       County") as direct signals — promote those into
       preferred_counties.

     - simple_area_preference (REQUIRED when notes use a curated
       region phrase): The known curated labels are:
         "North Jersey", "Central Jersey", "South Jersey",
         "North NJ", "Central NJ", "South NJ",
         "North FL", "Central FL", "South FL",
         "Greater Boston", "Greater NYC", "Greater Philadelphia",
         "Hudson Valley", "Capital Region", "Sun Belt",
         "Mid-Atlantic", "Gulf Coast", "Bay Area", "Tri-State"
       If the notes use one of these phrases (or close variants like
       "South Jersey" or "developed RT in South Jersey"), put it
       verbatim in simple_area_preference. The picker on the form
       accepts these labels exactly. If multiple curated regions
       appear, comma-separate them.

   The free-form location_preferences field stays for the full
   prose description; the structured fields exist ALONGSIDE it. NEVER
   populate location_preferences while leaving preferred_cities or
   preferred_states empty when the underlying signal is present in
   the notes.

═══════════════════════════════════════════════════════════════════════
STEP 2.4 — DESIRED PROPERTY TYPES: CATEGORIES + SUBTYPES
═══════════════════════════════════════════════════════════════════════
⚠ THIS IS THE MOST IMPORTANT FIELD. Asset types are the agent's
primary tool for matching buyers to deals — every other field is
secondary. You MUST:
  1. SCAN EVERY LINE of every note, every call note body, every
     contact tag, and every email/message snippet for asset-type
     mentions. Do not stop at the first match.
  2. BIAS TOWARD INCLUSION. If a note says "Mixed Use Buyer
     $500K–$2.5M" alongside an "asset - multi family" tag,
     emit BOTH "Multifamily" AND "Mixed Use". A buyer can want
     several categories — chips are additive, not mutually
     exclusive.
  3. Any of these phrasings = a chip MUST be added:
       "X buyer" / "buys X" / "buying X"
       "looking for X" / "wants X" / "interested in X"
       "active in X" / "does X" / "focuses on X"
       "X investor" (e.g. "MF investor", "retail investor")
       a bare list ("MF, retail, mixed use")
       "X buyer $A-$B" (price range pattern — chip + price hint)
       an asset name appearing in a profile / summary line
         ("Mixed Use Buyer", "Self Storage Investor")
       an "asset - X" tag (per Step 2.0 mapping)
  4. ABSENCE in the notes is NOT a reason to drop an existing
     chip (per rule 5a above). But PRESENCE in the notes is
     ALWAYS a reason to add a chip when one isn't there yet.
  5. If you finish parsing and desired_property_types has fewer
     chips than the count of distinct asset-type mentions you
     saw, GO BACK and add the missed ones. Better to add a
     bare category that's only mentioned once than to omit it.

desired_property_types is multi-select against this canonical category
vocab (matches the BC blank-form picker exactly):

  Multifamily | Office | Industrial | Retail | Shopping Center |
  Mixed Use | Land | Agricultural | Hotel & Motel | Senior Housing |
  Health Care | Sport & Entertainment | Special Purpose | Automotive |
  Residential Income

Each chip can be either a bare category or "Category: Subtype". Use a
subtype when the notes are specific enough to justify it. Reference
subtypes:
  Multifamily:        Garden/Low Rise, Mid Rise, High Rise, Duplex,
                      Triplex, Fourplex, Townhome, Student Housing,
                      Military Housing, Affordable Housing, Mixed Income
  Office:             CBD, Suburban, Medical, Creative/Flex, Government,
                      R&D, Owner/User
  Industrial:         Warehouse, Distribution, Manufacturing, Flex,
                      Cold Storage, Data Center, Truck Terminal,
                      Self Storage, R&D, Showroom
  Retail:             Strip Mall, Power Center, Neighborhood Center,
                      Community Center, Regional Mall, Single Tenant,
                      Restaurant, Auto Dealership, Drug Store, Bank,
                      Value Add Strip, NNN Retail, Grocery Anchored
  Shopping Center:    Strip Center, Neighborhood Center, Community Center,
                      Power Center, Lifestyle Center, Regional Mall,
                      Super Regional Mall, Outlet Center
  Mixed Use:          Retail / Residential, Office / Residential,
                      Retail / Office, Live-Work, Mixed Commercial,
                      Ground Floor Retail + Apartments
  Land:               Commercial, Residential, Industrial, Agricultural,
                      Mixed Use, Infill, Pad Site, Development
  Hotel & Motel:      Full Service, Select Service, Extended Stay,
                      Budget/Economy, Boutique, Resort, Motel, Hostel
  Senior Housing:     Independent Living, Assisted Living, Memory Care,
                      Skilled Nursing, CCRC, Active Adult
  Health Care:        Medical Office, Urgent Care, Surgery Center,
                      Hospital, Rehabilitation, Behavioral Health,
                      Lab/Life Science
  Special Purpose:    Car Wash, Gas Station, Parking Lot/Garage, Cemetery,
                      Church/Religious, School, Community Center,
                      Government, Funeral Home
  Automotive:         Auto Body Shop, Auto Repair / Mechanic,
                      Auto Dealership (New/Used), Auto Parts Store,
                      Tire Shop, Oil Change / Lube, Towing Facility,
                      Auto Auction, Car Wash
  Residential Income: Single Family Rental, Duplex, Triplex, Fourplex,
                      Small Multifamily (5-20), Large Multifamily (21+),
                      Mobile Home Park

Rules:
  - Always pick from this exact category vocab. The server validates
    each chip and drops anything not on the list.
  - Output bare category when notes don't specify subtype detail.
  - Output "Category: Subtype" when notes name a specific subtype.
    SUBTYPE KEYWORDS — if the notes mention any of these, prefer the
    Category: Subtype form:
      "showroom" / "showroom space"      → "Industrial: Showroom"
      "self storage" / "storage units"   → "Industrial: Self Storage"
      "warehouse"                        → "Industrial: Warehouse"
      "distribution" / "distro"          → "Industrial: Distribution"
      "manufacturing" / "manufacturer"   → "Industrial: Manufacturing"
      "flex space" / "flex industrial"   → "Industrial: Flex"
      "cold storage" / "refrigerated"    → "Industrial: Cold Storage"
      "data center"                      → "Industrial: Data Center"
      "truck terminal"                   → "Industrial: Truck Terminal"
      "garden-style" / "garden style"    → "Multifamily: Garden/Low Rise"
      "high rise" / "high-rise"          → "Multifamily: High Rise"
      "mid rise" / "mid-rise"            → "Multifamily: Mid Rise"
      "duplex"                           → "Multifamily: Duplex"
      "triplex"                          → "Multifamily: Triplex"
      "fourplex" / "4-plex"              → "Multifamily: Fourplex"
      "townhome" / "townhouse"           → "Multifamily: Townhome"
      "student housing"                  → "Multifamily: Student Housing"
      "affordable housing" / "LIHTC"     → "Multifamily: Affordable Housing"
      "grocery anchored" / "grocery-anchored":
        → "Retail: Grocery Anchored" if notes are about smaller retail
        → "Shopping Center: Neighborhood Center" if 100k+ SF or "centers"
      "strip mall" / "strip center"      → "Retail: Strip Mall"
      "power center"                     → "Retail: Power Center"
      "neighborhood center"              → "Retail: Neighborhood Center"
        OR "Shopping Center: Neighborhood Center" depending on scale
      "single tenant" / "STNL"           → "Retail: Single Tenant"
      "NNN" / "triple net"               → "Retail: NNN Retail"
      "lifestyle center"                 → "Shopping Center: Lifestyle Center"
      "outlet center" / "outlet mall"    → "Shopping Center: Outlet Center"
      "regional mall"                    → "Shopping Center: Regional Mall"
      "medical office" / "MOB"           → "Health Care: Medical Office"
      "urgent care"                      → "Health Care: Urgent Care"
      "surgery center"                   → "Health Care: Surgery Center"
      "boutique hotel"                   → "Hotel & Motel: Boutique"
      "extended stay"                    → "Hotel & Motel: Extended Stay"
      "select service"                   → "Hotel & Motel: Select Service"
      "full service"                     → "Hotel & Motel: Full Service"
      "independent living"               → "Senior Housing: Independent Living"
      "assisted living"                  → "Senior Housing: Assisted Living"
      "memory care"                      → "Senior Housing: Memory Care"
      "skilled nursing" / "SNF"          → "Senior Housing: Skilled Nursing"
      "CCRC"                             → "Senior Housing: CCRC"
      "auto repair" / "mechanic shop"    → "Automotive: Auto Repair / Mechanic"
      "auto body" / "body shop"          → "Automotive: Auto Body Shop"
      "tire shop"                        → "Automotive: Tire Shop"
      "gas station"                      → "Special Purpose: Gas Station"
      "parking lot" / "parking garage"   → "Special Purpose: Parking Lot/Garage"
      "church" / "religious building"    → "Special Purpose: Church/Religious"
      "mobile home park" / "MHP"         → "Residential Income: Mobile Home Park"
      "single family rental" / "SFR"     → "Residential Income: Single Family Rental"
  - You may include MULTIPLE chips when the buyer's interest spans
    several categories. Comma-separated.
  - Do NOT invent categories outside the list above.

AMBIGUOUS SUBTYPES — when a keyword appears under multiple categories,
propose ALL matching chips (the user picks the right one in the UI; we
don't guess for them). Specifically:
      "car wash"                  → "Automotive: Car Wash" AND
                                    "Special Purpose: Car Wash"
                                    (both chips, comma-separated)
      "strip mall" / "strip center"
                                  → "Retail: Strip Mall" AND
                                    "Shopping Center: Strip Center"
      "neighborhood center"       → "Retail: Neighborhood Center" AND
                                    "Shopping Center: Neighborhood Center"
      "power center"              → "Retail: Power Center" AND
                                    "Shopping Center: Power Center"
      "community center"          → "Retail: Community Center" AND
                                    "Shopping Center: Community Center" AND
                                    "Special Purpose: Community Center"
      "regional mall"             → "Retail: Regional Mall" AND
                                    "Shopping Center: Regional Mall"
      "R&D" / "research and development"
                                  → "Office: R&D" AND
                                    "Industrial: R&D"
General rule: if you'd reasonably pick one of N category-disambiguated
chips for a keyword and there's no contextual signal narrowing it to
just one, output ALL N. The user toggles the right ones in the review
modal — never guess for them.

═══════════════════════════════════════════════════════════════════════
STEP 2.5 — ASSET-CLASS SCOPE GATE
═══════════════════════════════════════════════════════════════════════
Each asset-class field group (Multifamily / Warehouse / Office / Retail /
Shopping Center / Mixed Use / Land / Automotive / Mobile Home Park /
Self Storage / Hotel / Healthcare / Special Purpose) is RESERVED for
buyers who actually want that asset class.

Rules:
  - You may ONLY propose a value for a field in group X if X (or its
    matching asset-vocab entry) appears in your proposed
    desired_property_types.
  - If the buyer is retail-only ("asset - retail" tag, only retail
    notes), DO NOT propose ANY values in the Multifamily, Office,
    Warehouse, Hotel, Storage, MHP, Healthcare, Automotive, Land, or
    Special Purpose groups. Even if those fields have stale "before"
    values from a prior bad fill, leave them alone — the apply path
    has a clear-field option and the user will use it.
  - If a buyer mentions a second asset class only in passing ("we
    might also explore warehouse"), include that second class in
    desired_property_types so its fields become eligible. But only
    fill specific fields in that secondary class if there's a real
    signal (e.g. "Smallest 140K SqFt" attached to the warehouse
    mention → could fill warehouse_min_sf with high uncertainty;
    prefer marking it uncertain unless the attribution is unambiguous).
  - This rule has no exceptions. Out-of-scope fields are the most
    common form of bad output.

═══════════════════════════════════════════════════════════════════════
STEP 3 — CITE EVERY VALUE
═══════════════════════════════════════════════════════════════════════
For EVERY field you put in "fields", you MUST also include an entry in
"citations" with a short quote from the source that justifies the value.

Format: "from <source> @ <date>: '<short quote>'" or "tag: <tag value>".
Example: "from call @ 2026-04-12: 'looking for 20 to 40 units'"
Example: "tag: asset - multi family"

If you cannot cite, OMIT THE FIELD. No citation = no value. This rule has
no exceptions.

For each field, also include a "confidence" entry: "high" / "medium" /
"low". High = explicit, recent, unambiguous. Medium = stated but with some
hedging or older. Low = inferred from indirect language.

═══════════════════════════════════════════════════════════════════════
STEP 4 — OUTPUT SHAPE
═══════════════════════════════════════════════════════════════════════
Return EXACTLY this JSON shape — no preamble, no code fences:

{
  "buy_intent": "buyer" | "seller_only" | "both" | "ambiguous",
  "top_level_notes": "1-2 sentences only if something stands out about
                       this contact's buy-intent or extraction confidence.
                       Empty string if nothing to flag.",
  "fields": {
    "<col>": <value>,
    ...
  },
  "citations": {
    "<col>": "<short citation>",
    ...
  },
  "confidence": {
    "<col>": "high" | "medium" | "low",
    ...
  },
  "explanations": {
    "<col>": "<1-line WHY this value>",
    ...
  },
  "na":        [ { "field": "<col>", "reason": "<why explicitly excluded>" } ],
  "uncertain": [ { "field": "<col>", "reason": "<what's ambiguous>" } ]
}

Numbers as numbers (no $, no commas). Percentages as 0-100.
Booleans as true/false. CSV fields as a single comma-separated string.
For enum / multienum, use ONLY values from the field's ALLOWED VALUES.

═══════════════════════════════════════════════════════════════════════
RULES THAT NEVER BEND
═══════════════════════════════════════════════════════════════════════
0. ASSET-CLASS SCOPE: Never propose a value in an asset-class field
   group whose asset isn't in your proposed desired_property_types.
   See Step 2.5. This is the single most common failure mode and the
   server WILL drop these silently — saving them costs you the slot.
1. Never invent. If a value is not stated or strongly implied, omit it.
2. Every field in "fields" needs a matching entry in "citations".
3. min_purchase_price / max_purchase_price are TOTAL prices for the whole
   property. NEVER put $/SF, $/acre, or $/unit numbers there. Per-foot
   land pricing goes in "other_requirements".
3a. PURCHASE PRICE FIELDS REQUIRE A STATED PORTFOLIO BUDGET — NOT
   DEAL-SPECIFIC NUMBERS. min_purchase_price / max_purchase_price
   may ONLY be filled when the buyer has stated their own budget /
   ceiling / floor in general terms:
     OK: "I'm looking up to $4M total", "max budget is $10M",
         "anything between $1M and $3M", "won't pay over $2M"
     NOT OK: an asking price on a specific property, a competing
         offer, the buyer's own offer on a specific deal, NOI
         multiples, a seller's net number, an LOI amount the
         buyer submitted on a deal, a bid / offer the buyer made
         on a specific property (active, pending, or dead — all
         deal-specific), a contract price the buyer is under
         contract for. These are deal-specific data points, not
         portfolio buy-box budgets.
   If the only price signal is an asking price ("Asking: $1.45m") —
   leave max_purchase_price empty. If the contact is the SELLER of
   the property the asking price is attached to (per Step 1.5),
   the asking price is GUARANTEED not the contact's buy-box.
   DO NOT RATIONALIZE A DEAL-SPECIFIC BID INTO A BUY-BOX. An LOI on
   Deal A says nothing about whether the buyer would pay the same
   for Deal B. Explanations like "treated as the current deal
   ceiling" or "no other price signal exists, so use this" are
   forbidden — they all break this rule. If the only price signal
   is a deal-specific offer / LOI / bid / contract price, leave
   max_purchase_price empty and surface the LOI context in
   other_requirements (e.g. "Submitted LOI at $1.05M on Linden
   deal Sept 2025 — historic bid, not a stated buy-box budget").
3b. financing_type is the BUYER'S preferred way to fund their
   acquisitions. Offer amounts STRUCTURED with cash/financing
   options that someone offered ON the contact's own property
   (e.g. "Offered: $785K all cash quick close & $900K with
   financing") tell you NOTHING about the contact's BUYING
   financing preference. Those are seller-side numbers — leave
   financing_type empty unless the buyer's own pattern is stated
   ("I always pay cash", "1031 buyer", "needs financing").
4. SF / RANGE / TARGET-SF:
   a) EXPLICIT range with TWO numbers ("5,000 to 20,000 SF",
      "between 1k and 10k", "5-20k") → set *_min_sf and *_max_sf.
      The numbers MUST be different.
   b) SINGLE ballpark ("~10k SF", "around 10k", "about 10,000",
      "approximately 50k", "10k SF" with no qualifier) → DO NOT set
      min/max. Set *_target_sf instead.
   c) NEVER write the same number to both min and max. If you only
      have one number, it's a target_sf.
   d) Same rule for unit counts, pad counts, key counts, tenant counts,
      acreage.
5. is_vip_buyer = true ONLY when notes/tags clearly mark the buyer as
   VIP / top-tier / "our best buyer" / etc., OR a "VIP" tag is present.
6. CRM ADMIN TERMINOLOGY — DO NOT MISREAD THESE AS DOLLAR AMOUNTS.
   The team uses these abbreviations as CAMPAIGN CADENCE / CONTACT
   ADMIN markers throughout the notes. They are NEVER prices.
     "12M FUB"  → 12-month follow-up campaign cadence
     "12mo FUB" / "12 mo FUB" / "12 month FUB" → same
     "6M FUB" / "6mo FUB" / "3M FUB" / "3mo FUB" → 6/3-month follow-up
     "FUB"       → "Follow Up Boss" CRM contact / a follow-up entry
     "CM"        → ContactMatcher / call-monitor / contact metadata
     "AA"        → an agent's initials at end of note (signature)
     "Mojo Dialer" / "Mojo" → outbound dialer system
     "via: COLE - <date> - Sheet1.csv" → import provenance
     "Just call" → action item ("just give them a call")
     A bare "M" / "mo" after a small integer (1M, 3M, 6M, 12M, 24M)
       with NO leading $ → MONTHS, not millions.
     A bare "K" / "k" after a small number with NO leading $ → could
       be units of thousand-something (e.g. "10k SF") — context-
       dependent.
   ONLY treat as a dollar amount when the number has a leading "$"
   or words like "million" / "thousand" or "budget" / "asking" /
   "offer" attach it explicitly to a price context. "12M FUB" alone
   is NEVER $12 million. If you've seen any prior BC record show
   max_purchase_price = 12000000 with no real cite, that's almost
   certainly this exact mistake — flag it as na with reason
   "stale unsourced value, likely from 12M-FUB misread".
7. DEAL-ACTIVITY MARKERS — these signal a DEAL-SPECIFIC bid, NOT a
   portfolio budget. Per rule 3a, never use the dollar amount
   attached to any of these as min/max_purchase_price:
     "LOI" / "loi" / "letter of intent"     — buyer submitted an LOI on a deal
     "submitted offer" / "offered $X on"    — buyer's bid on a specific deal
     "bid $X on" / "bid of $X"              — same
     "under contract" / "UC at $X"          — buyer is in contract on a specific deal
     "accepted offer of $X"                 — the seller accepted the buyer's deal-specific offer
   When you see one of these, route the price into
   other_requirements with the deal address / date if known, NOT
   into max_purchase_price. The buy-box describes future deals,
   not the current one the buyer is already pursuing.

═══════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════

EXAMPLE 1 — Strong multifamily value-add buyer with rich notes.

INPUT TAGS: ["Buyer", "asset - multi family", "1031 Investor", "VIP"]

INPUT NOTES:
[call @ 2026-04-12] John Smith called. He's buying 20-40 unit value-add
multifamily in North Jersey. Cash + 1031 from a recent sale. Min cap
6.5%. Budget up to $4M total. Doesn't care about office or retail.

[note @ 2026-03-30] John ideally wants Bergen or Essex County. Class B/C,
value-add. Not interested in Class A trophy assets.

[marketing email @ 2026-02-01] John would love a 200-unit one day.
(NOTE: this is aspirational, not buy-box — should NOT fill min/max.)

OUTPUT:
{
  "buy_intent": "buyer",
  "top_level_notes": "Strong MF value-add buyer; 1031-backed; explicit 20-40 unit range; VIP per tag.",
  "fields": {
    "desired_property_types": "Multifamily",
    "mf_min_units": 20,
    "mf_max_units": 40,
    "mf_class_preference": "B/C",
    "mf_deal_profile": "Value-add",
    "max_purchase_price": 4000000,
    "minimum_cap_rate": 6.5,
    "financing_type": "1031",
    "preferred_states": "NJ",
    "preferred_counties": "Bergen County, NJ, Essex County, NJ",
    "is_vip_buyer": true
  },
  "citations": {
    "desired_property_types":  "tag: asset - multi family",
    "mf_min_units":            "from call @ 2026-04-12: 'buying 20-40 unit value-add multifamily'",
    "mf_max_units":            "from call @ 2026-04-12: '20-40 unit value-add multifamily'",
    "mf_class_preference":     "from note @ 2026-03-30: 'Class B/C, value-add'",
    "mf_deal_profile":         "from note @ 2026-03-30: 'value-add. Not interested in Class A trophy'",
    "max_purchase_price":      "from call @ 2026-04-12: 'Budget up to $4M total'",
    "minimum_cap_rate":        "from call @ 2026-04-12: 'Min cap 6.5%'",
    "financing_type":          "from call @ 2026-04-12: 'Cash + 1031 from a recent sale'",
    "preferred_states":        "from note @ 2026-03-30: 'Bergen or Essex County' (NJ counties)",
    "preferred_counties":      "from note @ 2026-03-30: 'Bergen or Essex County'",
    "is_vip_buyer":            "tag: VIP"
  },
  "confidence": {
    "desired_property_types": "high",
    "mf_min_units": "high", "mf_max_units": "high",
    "mf_class_preference": "high", "mf_deal_profile": "high",
    "max_purchase_price": "high", "minimum_cap_rate": "high",
    "financing_type": "high",
    "preferred_states": "high", "preferred_counties": "high",
    "is_vip_buyer": "high"
  },
  "explanations": {
    "mf_min_units":      "Explicit lower bound in 2026-04-12 call.",
    "mf_max_units":      "Explicit upper bound in same call.",
    "max_purchase_price":"Hard ceiling 'up to $4M' in 2026-04-12 call.",
    "minimum_cap_rate":  "Stated 6.5% min cap in 2026-04-12 call.",
    "financing_type":    "Cash + 1031 from recent sale, plus 1031 tag — 1031 is the canonical label.",
    "is_vip_buyer":      "VIP tag is the source of truth here."
  },
  "na":        [{ "field": "office_min_sf",  "reason": "Buyer explicitly said 'doesn't care about office or retail'." }],
  "uncertain": []
}

NOTE: The 200-unit aspirational mention from 2026-02-01 was DROPPED. It is
not buy-box — it's a wish, not a stated range. min/max stay 20/40.

═══════════════════════════════════════════════════════════════════════

EXAMPLE 2 — No tags, ambiguous buy-intent.

INPUT TAGS: []

INPUT NOTES:
[call @ 2026-05-01] Talked to Maria. She mentioned the listing on
100 Main St — wants $2.5M for it. Said she might want to 1031 if it sells
into something MF in Florida.

OUTPUT:
{
  "buy_intent": "ambiguous",
  "top_level_notes": "No tags. Notes show seller-side activity (her listing) plus a conditional 1031 IF her property sells. Not enough commitment to extract buyer criteria — flagging ambiguous.",
  "fields": {},
  "citations": {},
  "confidence": {},
  "explanations": {},
  "na": [],
  "uncertain": [
    { "field": "financing_type", "reason": "Mentioned 1031 IF the listing sells — too conditional to set financing_type." },
    { "field": "desired_property_types", "reason": "Mentioned MF in Florida but only conditionally; no concrete buy-box." }
  ]
}

═══════════════════════════════════════════════════════════════════════

EXAMPLE 3 — Retail-only buyer with noisy tags + multi-state corridor.
This case demonstrates: tag noise filtering, asset-class scope (no MF
fields proposed even though stale "before" values exist), and geography
decomposition (corridor prose → preferred_states + preferred_cities).

INPUT TAGS:
  ["Daniel Keenan", "Buyer", "asset - retail", "Pennsylvania",
   "hl_engaged", "fub export"]
  (Daniel Keenan = the agent who created this contact, IGNORE.
   "fub export" = system tag, IGNORE.
   "hl_engaged" = engagement-only flag, NOT a VIP signal on its own.
   "Pennsylvania" = state-name tag → preferred_states gets "PA".)

INPUT NOTES:
[note @ 2026-01-13] Preferably grocery anchored retail, 100,000 to
400,000 SF, generally in the Boston to Philadelphia corridor extending
out into central PA and up into the Hudson Valley/Capital region.
Distressed/over leveraged is a plus.

[call @ 2026-01-19] Owns 4 centers in NJ and dev sites in NJ.
Warehouse explore. South Jersey - Developed RT. Pennsville, Burlington.
South Jersey. Smallest 140K SqFt.

OUTPUT:
{
  "buy_intent": "buyer",
  "top_level_notes": "Retail buyer (Shopping Center scale, 100k-400k SF, grocery-anchored). Mentions warehouse exploration in passing — included as a secondary asset class but no concrete warehouse buy-box numbers (140k SqFt is ambiguous between retail and warehouse).",
  "fields": {
    "desired_property_types":  "Shopping Center: Neighborhood Center, Industrial",
    "retail_anchor_preference":"Anchored",
    "shopping_min_sf":         100000,
    "shopping_max_sf":         400000,
    "preferred_states":        "MA, RI, CT, NY, NJ, PA",
    "preferred_cities":        "Pennsville, Burlington",
    "simple_area_preference":  "South Jersey",
    "location_preferences":    "Boston to Philadelphia corridor extending into central PA and the Hudson Valley/Capital region. South Jersey developed corridors (Pennsville, Burlington).",
    "other_requirements":      "Distressed or over-leveraged situations preferred. Owns 4 centers in NJ plus development sites in NJ. Exploring warehouse opportunities in South Jersey, smallest target ~140k SF (uncertain whether that minimum applies to warehouse, retail, or both)."
  },
  "citations": {
    "desired_property_types":  "tag: asset - retail; from call @ 2026-01-19: 'Warehouse explore'",
    "retail_anchor_preference":"from note @ 2026-01-13: 'Preferably grocery anchored retail'",
    "shopping_min_sf":         "from note @ 2026-01-13: '100,000 to 400,000 SF'",
    "shopping_max_sf":         "from note @ 2026-01-13: '100,000 to 400,000 SF'",
    "preferred_states":        "from note @ 2026-01-13: 'Boston to Philadelphia corridor extending out into central PA and up into the Hudson Valley/Capital region'; tag: Pennsylvania",
    "preferred_cities":        "from call @ 2026-01-19: 'Pennsville, Burlington'",
    "simple_area_preference":  "from call @ 2026-01-19: 'South Jersey - Developed RT' and 'South Jersey'",
    "location_preferences":    "from note @ 2026-01-13: 'Boston to Philadelphia corridor...'; from call @ 2026-01-19: 'South Jersey - Developed RT, Pennsville, Burlington'",
    "other_requirements":      "from note @ 2026-01-13: 'Distressed/over leveraged is a plus'; from call @ 2026-01-19: 'Owns 4 centers in NJ and dev sites in NJ, Warehouse explore, Smallest 140K SqFt'"
  },
  "confidence": {
    "desired_property_types":  "high",
    "retail_anchor_preference":"high",
    "shopping_min_sf":         "high",
    "shopping_max_sf":         "high",
    "preferred_states":        "high",
    "preferred_cities":        "high",
    "simple_area_preference":  "high",
    "location_preferences":    "high",
    "other_requirements":      "medium"
  },
  "explanations": {
    "desired_property_types":  "Retail tag + 100k-400k SF maps cleanly to Shopping Center scale. Warehouse added as secondary because of the call-note 'Warehouse explore' line.",
    "preferred_states":        "Boston→Philly corridor covers MA/RI/CT/NY/NJ/PA; Hudson Valley adds NY. PA also confirmed by tag.",
    "shopping_min_sf":         "Explicit 100k floor in 2026-01-13 note.",
    "shopping_max_sf":         "Explicit 400k ceiling in same note."
  },
  "na": [],
  "uncertain": [
    { "field": "warehouse_min_sf", "reason": "'Warehouse explore' and 'Smallest 140K SqFt' appear in the same call note, but it's ambiguous whether 140k applies to warehouse, retail, or both." },
    { "field": "financing_type",   "reason": "No financing method mentioned." }
  ]
}

NOTES on what this example does NOT propose:
  - NO mf_* fields. There is zero multifamily signal — even though a
    stale "Garden" or other MF value might be present in "before",
    leave it alone. The Step 2.5 scope gate forbids proposing MF here.
  - NO is_vip_buyer = true. "hl_engaged" alone is not a VIP signal.
  - NO "Daniel Keenan" or "fub export" influence on any field. They
    are noise.

═══════════════════════════════════════════════════════════════════════

EXAMPLE 4 — Dual-role contact: buyer in 2024, seller in 2026.
This case demonstrates Step 1.5 (dual-role detection) AND rule 1a.
The contact has clear buyer signals from 2024 ("Multi Fam 4-6 Units")
AND seller signals from 2026 (his own property at 560-562 3rd Ave,
asking $1.45M, owes $250K in a loan, being offered $785K all-cash
and $900K with financing). The 2026 numbers are SELLER-SIDE — they
contribute zero to the buy-box.

INPUT TAGS:
  ["Bounced", "Buyer", "asset - multi family", "Union county",
   "Buyers - MULTI FAMILY", "hl_engaged"]
  (Bounced = ignore; "Union county" = county tag → preferred_counties;
   "Buyers - MULTI FAMILY" = collection tag, ignore for buy-box;
   "hl_engaged" = engagement, not VIP.)

INPUT NOTES:
[note @ 2024-05-30] Buyer Elizabeth Multi Fam 4-6 Units. Just call.
  → BUYER-SIDE. Stated buy-box.
[note @ 2024-06-06] Buyer Elizabeth Multi Fam 4-6 Units. 12M FUB.
  → BUYER-SIDE. Stated buy-box repeated.
[note @ 2024-08-12] Sent Elizabeth 8U sounded interested. AA
  → BUYER-SIDE. Past deal sent to him; he sounded interested.
    Out-of-range vs the stated 4-6 range (rule 1a).
[note @ 2026-04-06] 718 Monroe Ave, Elizabeth — Duplex + Bonus.
560-562 3rd Ave, Elizabeth — 6 unit MF. Rent $8650/m. NOI $65,834.
Asking: $1.45m. owes $250,000 in a loan.
  → SELLER-SIDE. "Asking $1.45m" + "owes $250K in a loan" + detailed
    rent roll/NOI on this single property = contact is the OWNER
    selling 560-562 3rd Ave. ZERO contribution to buy-box.
[note @ 2026-04-15] Offered: $785K net all cash quick close & $900K
net with financing. Another guy offered him $1.2m.
  → SELLER-SIDE. "Offered him $1.2m" pronoun targets the contact —
    he's the SELLER receiving offers. The "$785K all cash & $900K
    with financing" is the agent (or competing buyer) offering
    structures TO BUY from him. ZERO contribution to buy-box.

OUTPUT:
{
  "buy_intent": "buyer",
  "top_level_notes": "Multifamily buyer in Elizabeth, NJ (Union County). Stated buy-box: 4-6 units (repeated). ALSO has seller-side activity in 2026 (sells 560-562 3rd Ave at $1.45M asking) — those numbers are not used for the buy-box.",
  "fields": {
    "desired_property_types":  "Multifamily",
    "mf_min_units":            4,
    "mf_max_units":            6,
    "preferred_states":        "NJ",
    "preferred_counties":      "Union County, NJ",
    "preferred_cities":        "Elizabeth",
    "location_preferences":    "Elizabeth, NJ (Union County)",
    "other_requirements":      "Stated buy-box: 4-6 unit multifamily in Elizabeth. Showed interest in an 8-unit in Aug 2024 — slightly above stated range, suggests some flex on the upper bound. 12-month FUB cadence noted. Note: contact also has seller-side activity in Apr 2026 — owns 560-562 3rd Ave (6-unit, $1.45M asking) and 718 Monroe Ave; numbers from those listings were not used for the buy-box per dual-role rule."
  },
  "citations": {
    "desired_property_types":  "tag: asset - multi family",
    "mf_min_units":            "from note @ 2024-05-30: 'Multi Fam 4-6 Units' (repeated 2024-06-06)",
    "mf_max_units":            "from note @ 2024-05-30: 'Multi Fam 4-6 Units' (repeated 2024-06-06)",
    "preferred_states":        "from note @ 2024-05-30: 'Buyer Elizabeth' (Elizabeth is in NJ)",
    "preferred_counties":      "tag: Union county",
    "preferred_cities":        "from note @ 2024-05-30: 'Buyer Elizabeth Multi Fam'",
    "location_preferences":    "from note @ 2024-05-30: 'Buyer Elizabeth Multi Fam'; tag: Union county",
    "other_requirements":      "from note @ 2024-05-30: 'Multi Fam 4-6 Units'; from note @ 2024-08-12: 'Sent Elizabeth 8U sounded interested'; from note @ 2026-04-06 (seller-side): 'Asking: $1.45m'; from note @ 2026-04-15 (seller-side): 'Offered him $1.2m'"
  },
  "confidence": {
    "desired_property_types":  "high",
    "mf_min_units":            "high",
    "mf_max_units":            "high",
    "preferred_states":        "high",
    "preferred_counties":      "high",
    "preferred_cities":        "high",
    "location_preferences":    "high",
    "other_requirements":      "high"
  },
  "explanations": {
    "mf_min_units":            "Stated buy-box '4-6 units' repeated across two May/June 2024 notes — canonical range.",
    "mf_max_units":            "Same source. Aug 2024 8-unit interest is past activity, not a redefinition of the buy-box; flexibility noted in other_requirements per rule 1a.",
    "other_requirements":      "Captures buy-box flexibility AND flags seller-side activity so future agents know not to confuse the asking price for a buying budget."
  },
  "na": [],
  "uncertain": []
}

NOTES on what this example does NOT do:
  - Does NOT propose max_purchase_price = $1.45M. The asking price
    on the contact's OWN property is seller-side data — never a
    buying budget. Per rule 3a, only stated portfolio budgets
    qualify. Leave the field empty.
  - Does NOT propose max_purchase_price from an LOI / offer / bid
    the buyer submitted on a specific deal. An LOI amount is
    deal-specific — the buyer's bid on one property — not their
    portfolio buy-box ceiling. Per rule 3a, leave the field empty
    and surface the LOI in other_requirements (e.g. "Submitted
    LOI at $1.05M on Linden deal Sept 2025") so future agents
    know the buyer has bid in that price range historically.
    Explanations like "treated as the current deal ceiling" or
    "broader portfolio budget not stated, so use this as the
    ceiling" are forbidden rationalizations of this exact rule.
  - Does NOT propose financing_type = "Mix" from the "$785K all cash
    & $900K with financing" line. Those are someone else's offers
    TO the contact for HIS property — not his own buying preference.
    Per rule 3b, leave financing_type empty.
  - Does NOT propose minimum_cap_rate from the NOI / asking ratio.
    The implied yield on a property the contact is SELLING tells
    you nothing about what cap rate he'd accept on a property he'd
    BUY.
  - Does NOT leave mf_min_units / mf_max_units empty just because of
    the 8-unit interest. The stated 4-6 range wins; the 8-unit
    interest is past activity that goes in other_requirements.
  - Does NOT flag mf_max_units as uncertain. There's no genuine
    ambiguity in the stated buy-box itself.

═══════════════════════════════════════════════════════════════════════

EXAMPLE 5 — Tagged buyer with no asset-specific detail in notes.
This case demonstrates: asset-class tags are source-of-truth. When
the contact is tagged "asset - multi family" but the notes don't
contain any MF-specific buy-box detail (no unit count, no class, no
deal profile), still propose desired_property_types = "Multifamily"
and leave MF subfields empty. NEVER question the tag.

It also demonstrates subtype recognition: a stray "showroom" mention
in the notes drives an Industrial: Showroom chip even when the
buyer's main interest is multifamily.

INPUT TAGS:
  ["Buyer", "asset - multi family", "Bergen County"]

INPUT NOTES:
[note @ 2024-09-15] Said she's also open to a small showroom space
for her side business if the right one comes up. North Jersey only.
[note @ 2023-08-02] Got her on the phone — keep her on the list.
[note @ 2022-03-11] New buyer lead from referral.

OUTPUT:
{
  "buy_intent": "buyer",
  "top_level_notes": "Tagged multifamily buyer. Notes have no MF buy-box detail — buyer is on the list as a known MF target with specifics TBD. One stray mention of openness to a showroom space (Industrial: Showroom) added as secondary.",
  "fields": {
    "desired_property_types":  "Multifamily, Industrial: Showroom",
    "preferred_states":        "NJ",
    "preferred_counties":      "Bergen County, NJ",
    "simple_area_preference":  "North Jersey",
    "other_requirements":      "Open to a small showroom space (Industrial: Showroom) for her side business if the right one comes up — secondary interest. MF buy-box detail not yet captured in notes."
  },
  "citations": {
    "desired_property_types":  "tag: asset - multi family; from note @ 2024-09-15: 'small showroom space'",
    "preferred_states":        "from note @ 2024-09-15: 'North Jersey only'; tag: Bergen County",
    "preferred_counties":      "tag: Bergen County",
    "simple_area_preference":  "from note @ 2024-09-15: 'North Jersey only'",
    "other_requirements":      "from note @ 2024-09-15: 'open to a small showroom space ... if the right one comes up'"
  },
  "confidence": {
    "desired_property_types":  "high",
    "preferred_states":        "high",
    "preferred_counties":      "high",
    "simple_area_preference":  "high",
    "other_requirements":      "medium"
  },
  "explanations": {
    "desired_property_types":  "MF tag is canonical; showroom mention triggers Industrial: Showroom subtype."
  },
  "na": [],
  "uncertain": []
}

NOTES on what this example does NOT do:
  - Does NOT add a top_level_notes line saying "MF tag may be wrong"
    or "agent should confirm MF". The tag is correct.
  - Does NOT mark mf_min_units / mf_max_units / mf_class_preference /
    mf_deal_profile as uncertain or na. They're just empty — buy-box
    detail not yet captured.
  - Does NOT drop the showroom mention as too vague. "Open to a
    showroom" is a real (if soft) buy signal — the right place for
    it is Industrial: Showroom in desired_property_types plus a note
    in other_requirements that says it's secondary.
`

function buildEligibleFieldsList(args: {
  currentValues: Record<string, unknown>
  currentNa: string[]
  onlyFillEmpty: boolean
}): string {
  const naSet = new Set(args.currentNa)
  const eligible = FIELD_SPEC.filter(f => {
    if (naSet.has(f.col)) return false
    if (!args.onlyFillEmpty) return true
    return isEmptyValue(args.currentValues[f.col])
  })
  return eligible
    .map(f => {
      const opts = f.options && f.options.length
        ? `\n      ALLOWED VALUES (use ONLY these${f.type === 'multienum' ? ', multiple allowed' : ''}): ${f.options.join(' | ')}`
        : ''
      return `  - "${f.col}" [${f.type}, group=${f.group}]: ${f.hint}${opts}`
    })
    .join('\n')
}

function buildUserMessage(args: {
  contactName: string
  contactTags: string[]
  context: string
  currentValues: Record<string, unknown>
  currentNa: string[]
  onlyFillEmpty: boolean
  guardrails: string[]
  additional_text: string
  // v288: optional runtime extra-field defs + the BC's existing
  // extra_fields JSONB. When provided, extras are listed alongside the
  // hardcoded fields in the user message so the AI can propose them.
  extraFields?: Array<FieldDef & { _category?: string }>
  extraValues?: Record<string, unknown>
}): string {
  const { contactName, contactTags, context, currentValues, currentNa, onlyFillEmpty, guardrails, additional_text } = args
  const extraFields = args.extraFields || []
  const extraValues = args.extraValues || {}
  const fieldList = buildEligibleFieldsList({ currentValues, currentNa, onlyFillEmpty })
  const extraFieldList = extraFields.length
    ? extraFields.map(f => {
        const opts = f.options && f.options.length
          ? `\n      ALLOWED VALUES (use ONLY these${f.type === 'multienum' ? ', multiple allowed' : ''}): ${f.options.join(' | ')}`
          : ''
        return `  - "${f.col}" [${f.type}, group=${f.group}, EXTRA / category=${f._category || ''}]: ${f.hint || '(no hint provided)'}${opts}`
      }).join('\n')
    : ''
  const extraCurrentLines = extraFields.length
    ? extraFields.map(f => {
        const cur = extraValues[f.col]
        if (isEmptyValue(cur)) return `  - ${f.col}: (empty) [extra]`
        return `  - ${f.col}: ${JSON.stringify(cur)} [extra]`
      }).join('\n')
    : ''
  const currentLines = FIELD_SPEC
    .map(f => {
      const cur = currentValues[f.col]
      if (isEmptyValue(cur)) return `  - ${f.col}: (empty)`
      return `  - ${f.col}: ${JSON.stringify(cur)}`
    })
    .concat(extraCurrentLines ? [extraCurrentLines] : [])
    .join('\n')
  const naContext = currentNa.length
    ? `FIELDS ALREADY MARKED N/A (do NOT propose values OR re-suggest as N/A): ${currentNa.join(', ')}`
    : 'FIELDS ALREADY MARKED N/A: (none)'
  const guardrailsBlock = guardrails.length
    ? '\nUSER-DEFINED GUARDRAILS (apply with the same weight as the rules above):\n' +
      guardrails.map((g, i) => `  ${i + 1}. ${g}`).join('\n')
    : ''
  const tagsLine = contactTags.length
    ? JSON.stringify(contactTags)
    : '[]  (no tags — fall back to inferring buy-intent from notes per Step 1)'

  return [
    `PROMPT_VERSION: ${PROMPT_VERSION}`,
    '',
    `BUYER NAME: ${contactName || '(unknown)'}`,
    '',
    `CONTACT TAGS: ${tagsLine}`,
    '',
    naContext,
    '',
    'CURRENT BUYER-CRITERIA ROW VALUES (do not echo unless overwriting):',
    currentLines,
    '',
    'ELIGIBLE FIELDS YOU MAY FILL:',
    fieldList || '  (none — all fields are already filled or marked N/A)',
    // v288: extras are runtime-defined per-category fields. The model
    // proposes values for them just like native fields. Marker
    // [EXTRA / category=X] in the descriptor tells you which category
    // they belong to so you can apply asset-class scope rules.
    extraFieldList ? `\nEXTRA FIELDS (runtime-defined per category — propose values for these too):\n${extraFieldList}` : '',
    guardrailsBlock,
    additional_text ? `\nUSER ADDITIONAL CONTEXT:\n${additional_text}` : '',
    '',
    '=== BUYER COMMUNICATION NOTES (most recent first) ===',
    context.slice(0, 16000),
    '=== END NOTES ===',
    '',
    'Now produce the JSON output per the schema in the system prompt.',
  ].filter(s => s !== null && s !== undefined).join('\n')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    if (req.method !== 'POST') {
      return jsonResp({ ok: false, error: 'POST required' }, 405)
    }

    const body = (await req.json().catch(() => ({}))) as BodyShape
    const buyer_criteria_id = body.buyer_criteria_id
    const dry_run = body.dry_run === true
    const only_fill_empty = body.only_fill_empty === true
    const additional_text = capText(body.additional_text, 6000)
    const contact_tags: string[] = Array.isArray(body.contact_tags)
      ? body.contact_tags.map(s => String(s)).filter(Boolean).slice(0, 50)
      : []
    // v279/v281: model can be explicit ("sonnet" / "haiku") or "auto".
    // Explicit choice locks immediately; auto routing is decided below
    // once we know source_chars + note counts.
    const explicitModel = resolveModel(body.model)
    const modelChoiceRaw = (typeof body.model === 'string' && body.model.trim()) ? body.model.trim().toLowerCase() : 'auto'

    if (!buyer_criteria_id || typeof buyer_criteria_id !== 'string') {
      return jsonResp({ ok: false, error: 'buyer_criteria_id (uuid) is required' }, 400)
    }
    if (!dry_run) {
      return jsonResp({ ok: false, error: 'This function only supports dry_run=true. Apply path is client-side.' }, 400)
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResp({ ok: false, error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, 500)
    }
    if (!ANTHROPIC_KEY) {
      return jsonResp({ ok: false, error: 'Server misconfigured: ANTHROPIC_API_KEY missing' }, 500)
    }

    const bcRows = (await fetchSb(
      `${SUPABASE_URL}/rest/v1/ace_buyer_criteria?id=eq.${encodeURIComponent(buyer_criteria_id)}&select=*`,
      SERVICE_KEY,
    )) as Array<Record<string, unknown>>
    if (!bcRows || bcRows.length === 0) {
      return jsonResp({ ok: false, error: 'buyer_criteria row not found' }, 404)
    }
    const bc = bcRows[0]
    const contact_id = bc.contact_id as string | null

    // v313: Step 1 — fetch the contact row (needed because fub_contact_id
    // is the join key for fub_calls / fub_notes). Other fetches that
    // don't depend on the contact row can start once we have the
    // contact_id (which we already have from the BC row), in parallel.
    // Saves 2-3 round-trips of serial latency per request (~150-400ms).
    let contact: Record<string, unknown> | null = null
    const aceNotesPromise: Promise<Array<{ body?: string | null; kind?: string | null; created_at?: string | null }>> | null =
      contact_id
        ? (fetchSb(
            `${SUPABASE_URL}/rest/v1/ace_contact_notes?contact_id=eq.${encodeURIComponent(contact_id)}&select=body,kind,created_at&order=created_at.desc&limit=50`,
            SERVICE_KEY,
          ) as Promise<Array<{ body?: string | null; kind?: string | null; created_at?: string | null }>>)
            .catch(() => [] as Array<{ body?: string | null; kind?: string | null; created_at?: string | null }>)
        : null

    if (contact_id) {
      // v270: also pull fub_tags here as a server-side fallback if the client
      // didn't include contact_tags in the body. The client SHOULD pass them,
      // but we can't trust it.
      const contactRows = (await fetchSb(
        `${SUPABASE_URL}/rest/v1/ace_contacts?id=eq.${encodeURIComponent(contact_id)}&select=name,phone_number,email,company,contact_notes,fub_contact_id,fub_tags`,
        SERVICE_KEY,
      )) as Array<Record<string, unknown>>
      contact = contactRows[0] || null
    }

    // Prefer client-supplied tags; fall back to server-fetched tags.
    const effective_tags: string[] = contact_tags.length
      ? contact_tags
      : (Array.isArray(contact?.fub_tags)
          ? (contact!.fub_tags as unknown[]).map(s => String(s)).filter(Boolean)
          : [])

    const fubId = contact?.fub_contact_id ? String(contact.fub_contact_id) : ''

    // v313: fub_calls + fub_notes can run in parallel with each other
    // (both keyed on the same fubId, no interdependency). aceNotes was
    // already kicked off above — await all three together.
    const fubCallsPromise: Promise<Array<{ note?: string | null; created_at?: string | null }>> = fubId
      ? (fetchSb(
          `${SUPABASE_URL}/rest/v1/fub_calls?person_id=eq.${encodeURIComponent(fubId)}&select=note,created_at&order=created_at.desc&limit=30`,
          SERVICE_KEY,
        ) as Promise<Array<{ note?: string | null; created_at?: string | null }>>)
          .catch(() => [] as Array<{ note?: string | null; created_at?: string | null }>)
      : Promise.resolve([])
    const fubNotesPromise: Promise<Array<{ body?: string | null; created_at?: string | null }>> = fubId
      ? (fetchSb(
          `${SUPABASE_URL}/rest/v1/fub_notes?person_id=eq.${encodeURIComponent(fubId)}&select=body,created_at&order=created_at.desc&limit=30`,
          SERVICE_KEY,
        ) as Promise<Array<{ body?: string | null; created_at?: string | null }>>)
          .catch(() => [] as Array<{ body?: string | null; created_at?: string | null }>)
      : Promise.resolve([])

    const [fubCalls, fubNotes, aceNotes] = await Promise.all([
      fubCallsPromise,
      fubNotesPromise,
      aceNotesPromise || Promise.resolve([] as Array<{ body?: string | null; kind?: string | null; created_at?: string | null }>),
    ])

    const sourceParts: string[] = []
    const source_breakdown: Record<string, string> = {}
    if (contact) {
      const lines = [
        `Contact: ${contact.name || '(no name)'}`,
        contact.email ? `Email: ${contact.email}` : '',
        contact.phone_number ? `Phone: ${contact.phone_number}` : '',
        contact.company ? `Company: ${contact.company}` : '',
        contact.contact_notes ? `\nContact notes:\n${capText(contact.contact_notes, 4000)}` : '',
      ].filter(Boolean)
      const block = lines.join('\n')
      sourceParts.push('--- CONTACT ---\n' + block)
      source_breakdown.contact_record = block
    }
    if (aceNotes.length) {
      const block = aceNotes
        .filter(n => n.body && String(n.body).trim())
        .map(n => `[${n.kind || 'note'} @ ${n.created_at || ''}] ${capText(n.body, 800)}`)
        .join('\n\n')
      sourceParts.push('--- ACE CONTACT NOTES (newest first) ---\n' + block)
      source_breakdown.ace_contact_notes = block
    }
    if (fubCalls.length) {
      const block = fubCalls
        .filter(c => c.note && String(c.note).trim())
        .map(c => `[call @ ${c.created_at || ''}] ${capText(c.note, 800)}`)
        .join('\n\n')
      sourceParts.push('--- FUB CALL NOTES (newest first) ---\n' + block)
      source_breakdown.fub_call_notes = block
    }
    if (fubNotes.length) {
      const block = fubNotes
        .filter(n => n.body && String(n.body).trim())
        .map(n => `[note @ ${n.created_at || ''}] ${capText(n.body, 800)}`)
        .join('\n\n')
      sourceParts.push('--- FUB NOTES (newest first) ---\n' + block)
      source_breakdown.fub_notes = block
    }
    if (additional_text) {
      sourceParts.push('--- ADDITIONAL CONTEXT (user-supplied) ---\n' + additional_text)
      source_breakdown.additional_text = additional_text
    }

    const contextText = sourceParts.join('\n\n')
    const source_chars = contextText.length

    // v281: auto-routing — pick Sonnet for big / multi-note buyers,
    // Haiku for smaller ones. Explicit body.model wins.
    const _aceNotesCount = aceNotes.filter(n => n.body && String(n.body).trim()).length
    const _fubNotesCount = fubNotes.filter(n => n.body && String(n.body).trim()).length
    const _fubCallsCount = fubCalls.filter(c => c.note && String(c.note).trim()).length
    const _totalNoteCount = _aceNotesCount + _fubNotesCount + _fubCallsCount
    let MODEL: string
    let modelRoutingReason: string
    if (explicitModel) {
      MODEL = explicitModel
      modelRoutingReason = `explicit: caller requested "${modelChoiceRaw}"`
    } else {
      const bigBySource = source_chars >= AUTO_ROUTING.source_chars_threshold
      const bigByCount  = _totalNoteCount >= AUTO_ROUTING.note_count_threshold
      if (bigBySource || bigByCount) {
        MODEL = MODEL_SONNET
        const reasons: string[] = []
        if (bigBySource) reasons.push(`source_chars=${source_chars} ≥ ${AUTO_ROUTING.source_chars_threshold}`)
        if (bigByCount)  reasons.push(`notes=${_totalNoteCount} ≥ ${AUTO_ROUTING.note_count_threshold}`)
        modelRoutingReason = `auto → sonnet (${reasons.join(', ')})`
      } else {
        MODEL = MODEL_HAIKU
        modelRoutingReason = `auto → haiku (source_chars=${source_chars} < ${AUTO_ROUTING.source_chars_threshold}, notes=${_totalNoteCount} < ${AUTO_ROUTING.note_count_threshold})`
      }
    }

    const fieldStatusRaw = bc.field_status
    const fieldStatus: Record<string, unknown> =
      (fieldStatusRaw && typeof fieldStatusRaw === 'object' && !Array.isArray(fieldStatusRaw))
        ? (fieldStatusRaw as Record<string, unknown>)
        : {}
    const currentNa: string[] = Object.entries(fieldStatus)
      .filter(([k, v]) => FIELD_SPEC_COLS.has(k) && (v === 'no_preference' || v === 'not_available' || v === 'na' || v === 'NA'))
      .map(([k]) => k)

    const contactName = (contact?.name as string) || ''

    let userGuardrails: string[] = []
    try {
      const guardRows = (await fetchSb(
        `${SUPABASE_URL}/rest/v1/ace_ai_settings?key=eq.bc_guardrails&select=value&limit=1`,
        SERVICE_KEY,
      )) as Array<{ value?: unknown }>
      const raw = guardRows?.[0]?.value
      if (Array.isArray(raw)) {
        userGuardrails = raw
          .map(s => String(s == null ? '' : s).trim())
          .filter(s => s.length > 0 && s.length < 500)
          .slice(0, 20)
      }
    } catch (_) { /* table may not exist yet — ignore */ }

    // v287: pull the runtime BC asset taxonomy from ace_ai_settings.
    // If a row exists, its categories + subtypes override the hardcoded
    // ASSET_TYPE_VOCAB / ASSET_SUBTYPES for THIS request. The vocab is
    // also injected into the user message as an "AUTHORITATIVE VOCAB"
    // block so the model sees the override, not just the static prompt.
    let activeVocab: string[] = ASSET_TYPE_VOCAB
    let activeSubtypes: Record<string, string[]> = ASSET_SUBTYPES
    let taxonomyRuntimeOverride = false
    try {
      const taxRows = (await fetchSb(
        `${SUPABASE_URL}/rest/v1/ace_ai_settings?key=eq.bc_taxonomy&select=value&limit=1`,
        SERVICE_KEY,
      )) as Array<{ value?: unknown }>
      const raw = taxRows?.[0]?.value
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const dynCats: string[] = []
        const dynSubs: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const cat = String(k || '').trim()
          if (!cat) continue
          dynCats.push(cat)
          dynSubs[cat] = Array.isArray(v)
            ? (v as unknown[]).map(s => String(s || '').trim()).filter(Boolean)
            : []
        }
        if (dynCats.length > 0) {
          activeVocab = dynCats
          activeSubtypes = dynSubs
          taxonomyRuntimeOverride = true
        }
      }
    } catch (_) { /* fall back to hardcoded */ }

    // v288: Phase-2 runtime field definitions. ace_ai_settings row
    // 'bc_field_definitions' holds per-category extra fields whose
    // values live in ace_buyer_criteria.extra_fields (JSONB). Append
    // to FIELD_SPEC at request time so the AI proposes values for
    // them just like native fields. Marker `_extra=true` + `_category`
    // tells the apply path to route values through extra_fields.
    type ExtraFieldDef = FieldDef & { _extra: true; _category: string }
    const extraFieldDefs: ExtraFieldDef[] = []
    try {
      const fieldRows = (await fetchSb(
        `${SUPABASE_URL}/rest/v1/ace_ai_settings?key=eq.bc_field_definitions&select=value&limit=1`,
        SERVICE_KEY,
      )) as Array<{ value?: unknown }>
      const raw = fieldRows?.[0]?.value
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [cat, listUnknown] of Object.entries(raw as Record<string, unknown>)) {
          // v292: skip the meta key (`_other_notes`) — handled below.
          // v294: also skip _native_overrides — handled in the FIELD_SPEC
          // override loop further down.
          if (cat === '_other_notes' || cat === '_native_overrides') continue
          if (!Array.isArray(listUnknown)) continue
          for (const fUnknown of listUnknown) {
            const f = fUnknown as Record<string, unknown>
            const col   = String(f?.col   || '').trim()
            const label = String(f?.label || '').trim()
            const type  = String(f?.type  || 'text') as FieldType
            if (!col || !label) continue
            if (!['text', 'number', 'boolean', 'enum', 'multienum', 'csv'].includes(type)) continue
            const hint  = String(f?.hint  || '')
            const opts  = Array.isArray(f?.options)
              ? (f.options as unknown[]).map(s => String(s || '')).filter(Boolean)
              : undefined
            extraFieldDefs.push({
              col,
              label,
              type,
              group: `Custom: ${cat}`,
              hint,
              options: opts,
              _extra: true,
              _category: String(cat || ''),
            })
          }
        }
        // v292: synthesize an Other Notes field per enabled scope.
        // Stored under extra_fields[`other_notes_<slug>`] so each
        // scope has its own bucket. The AI proposes free-text content
        // summarizing anything else specific to that asset class.
        const otherNotesMeta = (raw as Record<string, unknown>)._other_notes
        if (otherNotesMeta && typeof otherNotesMeta === 'object' && !Array.isArray(otherNotesMeta)) {
          for (const [scope, cfgUnknown] of Object.entries(otherNotesMeta as Record<string, unknown>)) {
            const cfg = (cfgUnknown && typeof cfgUnknown === 'object') ? cfgUnknown as Record<string, unknown> : {}
            if (cfg.enabled === false) continue
            const slug = String(scope || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
            if (!slug) continue
            const placeholder = typeof cfg.placeholder === 'string' && cfg.placeholder.trim()
              ? cfg.placeholder
              : 'Anything else specific to this asset class — preferences, dealbreakers, agent observations, etc.'
            extraFieldDefs.push({
              col:        `other_notes_${slug}`,
              label:      `Other Notes — ${scope}`,
              type:       'text',
              group:      `Custom: ${scope}`,
              hint:       placeholder,
              _extra:     true,
              _category:  String(scope || ''),
            })
          }
        }
      }
    } catch (_) { /* extras absent — continue without them */ }

    // v294: per-scope native-field overrides. Storage shape:
    //   _native_overrides: { "<Category>": { "<col>": { hidden?, label?, hint? } } }
    // Hidden fields are dropped from FIELD_SPEC for THIS request so the
    // model never proposes values for them. Label / hint overrides
    // reach the model via the eligible-fields list. Lookup keys against
    // the BC's desired_property_types so subtype chips inherit overrides
    // from the bare category.
    const nativeOverridesByCol = new Map<string, { hidden?: boolean; label?: string; hint?: string; options?: string[] }>()
    try {
      const fieldRows2 = (await fetchSb(
        `${SUPABASE_URL}/rest/v1/ace_ai_settings?key=eq.bc_field_definitions&select=value&limit=1`,
        SERVICE_KEY,
      )) as Array<{ value?: unknown }>
      const raw2 = fieldRows2?.[0]?.value
      const meta = (raw2 && typeof raw2 === 'object' && !Array.isArray(raw2))
        ? (raw2 as Record<string, unknown>)._native_overrides
        : null
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        // Active scopes for this BC — bare-category names of the chips
        // currently selected in desired_property_types.
        const dpt = String((bc.desired_property_types as string) || '')
        const activeScopes = new Set(
          dpt.split(/[,;]+/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => { const i = s.indexOf(':'); return i > 0 ? s.slice(0, i).trim() : s })
        )
        for (const [scope, perScope] of Object.entries(meta as Record<string, unknown>)) {
          if (!activeScopes.has(scope)) continue
          if (!perScope || typeof perScope !== 'object' || Array.isArray(perScope)) continue
          for (const [col, ov] of Object.entries(perScope as Record<string, unknown>)) {
            if (!ov || typeof ov !== 'object' || Array.isArray(ov)) continue
            const o = ov as Record<string, unknown>
            const out: { hidden?: boolean; label?: string; hint?: string; options?: string[] } = {}
            if (o.hidden === true) out.hidden = true
            if (typeof o.label === 'string' && o.label.trim()) out.label = o.label.trim()
            if (typeof o.hint  === 'string' && o.hint.trim())  out.hint  = o.hint.trim()
            // v295: enum options override.
            if (Array.isArray(o.options)) {
              const opts = (o.options as unknown[]).map(s => String(s || '').trim()).filter(Boolean)
              if (opts.length) out.options = opts
            }
            // Last-write-wins across scopes; in practice scopes don't
            // overlap on the same col so this is fine.
            nativeOverridesByCol.set(col, out)
          }
        }
      }
    } catch (_) { /* native overrides absent — continue */ }

    // Materialize the FIELD_SPEC to use for THIS request: native + extras.
    // Native fields look up `before` from bc[col]; extras look up from
    // bc.extra_fields[col]. Native fields with hidden=true are dropped
    // from the request entirely (model doesn't see them, won't propose).
    const ALL_FIELDS_FOR_REQ: Array<FieldDef & { _extra?: boolean; _category?: string }> =
      [
        ...FIELD_SPEC
          .filter(f => !nativeOverridesByCol.get(f.col)?.hidden)
          .map(f => {
            const ov = nativeOverridesByCol.get(f.col)
            if (!ov || (!ov.label && !ov.hint && !ov.options)) return f
            return {
              ...f,
              ...(ov.label   ? { label:   ov.label   } : {}),
              ...(ov.hint    ? { hint:    ov.hint    } : {}),
              // v295: override options replace the hardcoded enum vocab
              // for this request (model + validateEnumProposal both honor it).
              ...(ov.options ? { options: ov.options } : {}),
            }
          }),
        ...extraFieldDefs,
      ]
    const ALL_FIELD_COLS_FOR_REQ = new Set(ALL_FIELDS_FOR_REQ.map(f => f.col))
    const extraColsSet = new Set(extraFieldDefs.map(f => f.col))
    const bcExtras: Record<string, unknown> =
      (bc.extra_fields && typeof bc.extra_fields === 'object' && !Array.isArray(bc.extra_fields))
        ? (bc.extra_fields as Record<string, unknown>)
        : {}
    const beforeOf = (col: string): unknown =>
      extraColsSet.has(col) ? (bcExtras[col] ?? null) : (bc[col] ?? null)

    const buildAllFields = (proposedMap: Record<string, { proposed: unknown; before: unknown; explanation?: string; cite?: string; confidence?: string }>,
                             naProps: Array<{ col: string; reason: string }>) =>
      ALL_FIELDS_FOR_REQ.map(f => ({
        col: f.col,
        label: f.label,
        group: f.group,
        type: f.type,
        options: f.options || null,
        hint: f.hint,
        before: beforeOf(f.col),
        proposed: proposedMap[f.col]?.proposed ?? null,
        explanation: proposedMap[f.col]?.explanation ?? null,
        cite: proposedMap[f.col]?.cite ?? null,
        confidence: proposedMap[f.col]?.confidence ?? null,
        na: currentNa.includes(f.col),
        proposed_na: naProps.find(p => p.col === f.col)?.reason || null,
        _extra: f._extra || false,
        _category: f._category || null,
      }))

    if (!contextText.trim() && effective_tags.length === 0) {
      return jsonResp({
        ok: true,
        prompt_version: PROMPT_VERSION,
        proposed_changes: {},
        na_proposals: [],
        current_na_fields: currentNa,
        uncertain_fields: [{ col: '*', label: '(all)', why: 'No notes / context AND no tags available for this buyer.' }],
        all_fields: buildAllFields({}, []),
        source_chars,
        source_breakdown,
        model: MODEL,
        diagnostic: {
          input_summary: {
            tags: effective_tags,
            contact_tags_from_client: contact_tags,
            ace_notes_used: 0, fub_notes_used: 0, fub_calls_used: 0,
            tokens_in: 0, tokens_out: 0,
          },
          buy_intent: 'ambiguous',
          top_level_notes: 'No data to extract from.',
        },
      })
    }

    let userMessage = buildUserMessage({
      contactName,
      contactTags: effective_tags,
      context: contextText,
      currentValues: bc,
      currentNa,
      onlyFillEmpty: only_fill_empty,
      guardrails: userGuardrails,
      additional_text,
      // v288: pass runtime extras + their current values so the AI can propose them.
      extraFields:  extraFieldDefs,
      extraValues:  bcExtras,
    })

    // v287: prepend an AUTHORITATIVE VOCAB block when the runtime
    // taxonomy differs from the hardcoded one. The model is told this
    // list wins over Step 2.4 in the static prompt — lets the user
    // edit the taxonomy in Settings without redeploying the prompt.
    if (taxonomyRuntimeOverride) {
      const subtypeLines = activeVocab
        .map(cat => `  ${cat}: ${(activeSubtypes[cat] || []).join(', ') || '(no subtypes)'}`)
        .join('\n')

      // v307: when a word appears BOTH as a top-level category AND as
      // a subtype under another category in the active taxonomy, the
      // model historically collapsed it into the "Parent: Sub" form
      // (e.g. notes mention "land, development" → "Land: Development"
      // instead of two separate chips "Land" + "Development"). Build
      // an explicit DISAMBIGUATION list so the model picks the
      // top-level chip unless the notes clearly tie the word to the
      // parent category.
      const catLowerSet = new Set(activeVocab.map(c => c.toLowerCase()))
      const ambiguousWords: Array<{ word: string; topLevel: string; alsoSubOf: string[] }> = []
      for (const cat of activeVocab) {
        const subList = activeSubtypes[cat] || []
        for (const sub of subList) {
          const subLc = sub.toLowerCase()
          if (catLowerSet.has(subLc) && subLc !== cat.toLowerCase()) {
            const topLevel = activeVocab.find(c => c.toLowerCase() === subLc) || sub
            const existing = ambiguousWords.find(a => a.word.toLowerCase() === subLc)
            if (existing) {
              if (!existing.alsoSubOf.includes(cat)) existing.alsoSubOf.push(cat)
            } else {
              ambiguousWords.push({ word: topLevel, topLevel, alsoSubOf: [cat] })
            }
          }
        }
      }
      const ambiguousLines = ambiguousWords.length
        ? `\nDISAMBIGUATION — words that are BOTH a top-level category AND a\n` +
          `subtype somewhere else. When notes mention these as standalone\n` +
          `interests (e.g. "they like X" or "X, Y, and Z" as a list),\n` +
          `emit the TOP-LEVEL chip on its own — do NOT combine with the\n` +
          `parent category. Only use "Parent: Word" when the notes\n` +
          `explicitly tie the word to that parent (e.g. "land for Word",\n` +
          `"Word-style Parent properties"):\n` +
          ambiguousWords
            .map(a => `  "${a.word}" → prefer chip "${a.topLevel}" (not "${a.alsoSubOf.join(': ' + a.word + '" or "')}: ${a.word}")`)
            .join('\n') +
          `\n`
        : ''

      // v316: dynamically build a SUBTYPE KEYWORD TRIGGERS map from the
      // runtime taxonomy. The static prompt's Step 2.4 has a frozen
      // keyword map, but the user can add new subtypes via Settings →
      // BC Asset Taxonomy (e.g. "Laundromat" under Special Purpose).
      // The AI was emitting the bare category when those new subtype
      // names appeared in notes because it had no trigger to graduate
      // them to "Category: Subtype" form.
      //
      // Group by lowercase subtype name so collisions across categories
      // (e.g. Car Wash is under both Automotive AND Special Purpose)
      // become one line with an OR clause — model can choose or
      // propose both.
      const subtypeTriggers = new Map<string, string[]>()  // lowercase keyword → ["Cat: Sub", ...]
      for (const cat of activeVocab) {
        const subList = activeSubtypes[cat] || []
        for (const sub of subList) {
          const key = sub.toLowerCase().trim()
          if (!key) continue
          // Skip if the subtype is identical to its parent category — the
          // bare category chip is correct in that case (e.g. Land under Land).
          if (key === cat.toLowerCase()) continue
          // Skip subtype keywords that ARE a top-level category by themselves
          // (handled by the DISAMBIGUATION block above — they should emit
          // the standalone chip, not "Parent: Word").
          if (catLowerSet.has(key)) continue
          const chip = `${cat}: ${sub}`
          const arr = subtypeTriggers.get(key) || []
          if (!arr.includes(chip)) arr.push(chip)
          subtypeTriggers.set(key, arr)
        }
      }
      // Sort keys alphabetically so the prompt is deterministic (helps
      // the v270 ephemeral prompt cache stay warm between requests).
      const subtypeTriggerKeys = [...subtypeTriggers.keys()].sort()
      const subtypeTriggerLines = subtypeTriggerKeys
        .map(key => {
          const chips = subtypeTriggers.get(key) || []
          if (chips.length === 1) return `  "${key}" → "${chips[0]}"`
          // Multi-category collision — propose both unless notes disambiguate.
          return `  "${key}" → ${chips.map(c => `"${c}"`).join(' OR ')} (pick whichever fits the notes; if ambiguous, propose both)`
        })
        .join('\n')
      const subtypeTriggerBlock = subtypeTriggerKeys.length
        ? `\nSUBTYPE KEYWORD TRIGGERS (auto-built from your runtime taxonomy —\n` +
          `${subtypeTriggerKeys.length} keywords across ${activeVocab.length} categories):\n` +
          subtypeTriggerLines +
          `\n`
        : ''

      const overrideBlock =
        `═══════════════════════════════════════════════════════════════════════\n` +
        `AUTHORITATIVE ASSET-TYPE VOCAB (runtime override — replaces Step 2.4)\n` +
        `═══════════════════════════════════════════════════════════════════════\n` +
        `desired_property_types is multi-select against THIS list ONLY. The\n` +
        `Step 2.4 list in the system prompt is the historical baseline; if\n` +
        `they disagree, this list wins. The agent edited the taxonomy at\n` +
        `runtime via Settings → Tools → BC Asset Taxonomy.\n\n` +
        `Categories (${activeVocab.length}):\n` +
        `  ${activeVocab.join(' | ')}\n\n` +
        `Subtypes (use as "Category: Subtype" chips when notes warrant):\n` +
        subtypeLines +
        `\n` +
        ambiguousLines +
        subtypeTriggerBlock +
        `\nLIST-OF-ASSETS RULE: when notes enumerate multiple property types\n` +
        `as a comma- or "and"-separated list ("multifamily, land, and\n` +
        `development"), emit one chip per listed type, each as the BARE\n` +
        `top-level category from the Categories list above. Do NOT collapse\n` +
        `two list items into a "Parent: Sub" chip unless the notes\n` +
        `EXPLICITLY tie one to the other ("land for development", "land\n` +
        `with development potential" → "Land: Development" stands).\n` +
        `\nSUBTYPE-PRIORITY RULE: when a note contains ANY keyword from the\n` +
        `SUBTYPE KEYWORD TRIGGERS list above, the resulting chip MUST be in\n` +
        `the "Category: Subtype" form — NEVER the bare category alone.\n` +
        `Bare-category chips are only correct when the notes describe the\n` +
        `buyer's interest at the category level WITHOUT naming a specific\n` +
        `subtype:\n` +
        `  - "interested in special purpose properties"  → bare "Special Purpose"\n` +
        `  - "laundromat investor"                       → "Special Purpose: Laundromat"\n` +
        `  - "they buy mechanic shops and tire shops"    → BOTH "Automotive: Auto Repair / Mechanic"\n` +
        `                                                  AND "Automotive: Tire Shop"\n` +
        `If the notes mention multiple subtypes under the same category,\n` +
        `emit a chip per subtype — do NOT collapse into a single bare\n` +
        `category chip when subtype detail is present.\n` +
        `\nNORMALIZATION-FIRST RULE: agents type abbreviations constantly.\n` +
        `BEFORE checking the SUBTYPE KEYWORD TRIGGERS list, expand every\n` +
        `abbreviation in the notes to its canonical word, then re-check the\n` +
        `trigger list against the expanded text. Full CRE expansion table:\n` +
        `\n` +
        `  GENERAL PROPERTY TYPES\n` +
        `  ──────────────────────\n` +
        `  MF / mf / MFR / multifam       → multifamily\n` +
        `  apts / apt / apartments        → multifamily (Garden/Mid/High based on context)\n` +
        `  SFR / SFH / SFD                → single family rental (Residential Income)\n` +
        `  TH / townhouse / townhome      → townhome (Multifamily: Townhome)\n` +
        `  duplex / 2-plex / 2plex        → Multifamily: Duplex OR Residential Income: Duplex\n` +
        `  triplex / 3-plex / 3plex       → Multifamily: Triplex OR Residential Income: Triplex\n` +
        `  fourplex / 4-plex / 4plex / quad → Multifamily: Fourplex OR Residential Income: Fourplex\n` +
        `  GA / garden / garden-style     → Multifamily: Garden/Low Rise\n` +
        `  LR / low rise                  → Multifamily: Garden/Low Rise\n` +
        `  MR / mid rise / mid-rise       → Multifamily: Mid Rise\n` +
        `  HR / high rise / high-rise     → Multifamily: High Rise\n` +
        `  BTR / build to rent            → Multifamily: Garden/Low Rise (BTR is a development pattern, route to MF)\n` +
        `  LIHTC / Section 42 / sec 42    → Multifamily: Affordable Housing\n` +
        `  affordable / workforce housing → Multifamily: Affordable Housing\n` +
        `  student / student housing      → Multifamily: Student Housing\n` +
        `  military / on-base / barracks  → Multifamily: Military Housing\n` +
        `  MHP / mobile home park / MH    → Residential Income: Mobile Home Park\n` +
        `  manufactured home / man. home  → Residential Income: Mobile Home Park\n` +
        `  RV park                        → (no exact subtype — bare Residential Income + note in other_requirements)\n` +
        `\n` +
        `  INDUSTRIAL\n` +
        `  ──────────\n` +
        `  WH / whse / wh                 → Industrial: Warehouse\n` +
        `  warehouse / w/h                → Industrial: Warehouse\n` +
        `  distro / distribution / DC     → Industrial: Distribution\n` +
        `  fulfillment center / FC        → Industrial: Distribution\n` +
        `  mfg / manufacturing / mfr      → Industrial: Manufacturing\n` +
        `  flex / flex space / flex industrial → Industrial: Flex\n` +
        `  cold storage / refrigerated / freezer → Industrial: Cold Storage\n` +
        `  data center / DC tier-3        → Industrial: Data Center\n` +
        `  truck terminal / T-park / truck park / truck parking → Industrial: Truck Terminal\n` +
        `  IOS / outdoor storage / industrial outdoor → Industrial: Truck Terminal (closest existing subtype unless taxonomy has "Outdoor Storage")\n` +
        `  self storage / SS / mini storage / storage units → Industrial: Self Storage\n` +
        `  R&D / R and D / research & development → Industrial: R&D OR Office: R&D (route based on prose)\n` +
        `  showroom / showroom space      → Industrial: Showroom\n` +
        `\n` +
        `  OFFICE\n` +
        `  ──────\n` +
        `  CBD / downtown office          → Office: CBD\n` +
        `  suburban office / subOff       → Office: Suburban\n` +
        `  medical office / MOB           → Office: Medical OR Health Care: Medical Office (emit BOTH if unsure)\n` +
        `  creative office / loft / brick-and-beam → Office: Creative/Flex\n` +
        `  govt / government / fed lease  → Office: Government\n` +
        `  owner-user / OU / owner occupied → Office: Owner/User\n` +
        `\n` +
        `  RETAIL / SHOPPING CENTER\n` +
        `  ────────────────────────\n` +
        `  RT / retail                    → Retail (use subtype if specified)\n` +
        `  strip / strip mall / strip ctr → Retail: Strip Mall OR Shopping Center: Strip Center\n` +
        `  VAS / value-add strip          → Retail: Value Add Strip\n` +
        `  power center                   → Retail: Power Center OR Shopping Center: Power Center\n` +
        `  neighborhood ctr / neighborhood center → Shopping Center: Neighborhood Center OR Retail: Neighborhood Center\n` +
        `  community center               → Shopping Center: Community Center OR Retail: Community Center\n` +
        `  lifestyle ctr / lifestyle center → Shopping Center: Lifestyle Center\n` +
        `  regional mall / mall           → Shopping Center: Regional Mall\n` +
        `  outlet / outlet mall / outlet ctr → Shopping Center: Outlet Center\n` +
        `  grocery anchored / grocery-anchored / GAC → Retail: Grocery Anchored\n` +
        `  STNL / NNN / triple net / single tenant net lease → Retail: NNN Retail or Retail: Single Tenant (emit both if unsure)\n` +
        `  drug store / CVS / Walgreens / Rite Aid → Retail: Drug Store\n` +
        `  bank branch / bank             → Retail: Bank\n` +
        `  restaurant / sit-down / fast casual → Retail: Restaurant\n` +
        `  QSR / quick service / drive thru / fast food → Retail: Restaurant\n` +
        `  auto dealer / dealership / car dealer → Retail: Auto Dealership OR Automotive: Auto Dealership (New) / (Used)\n` +
        `\n` +
        `  MIXED USE\n` +
        `  ─────────\n` +
        `  MU / mixed use / mixed-use     → Mixed Use\n` +
        `  ground floor retail + apts     → Mixed Use: Ground Floor Retail + Apartments\n` +
        `  live-work / live/work          → Mixed Use: Live-Work\n` +
        `\n` +
        `  HOTEL & MOTEL\n` +
        `  ─────────────\n` +
        `  hotel / motel / inn            → Hotel & Motel (use subtype if specified)\n` +
        `  full service / FS hotel        → Hotel & Motel: Full Service\n` +
        `  select service / SS hotel      → Hotel & Motel: Select Service\n` +
        `  extended stay / ES / ext stay  → Hotel & Motel: Extended Stay\n` +
        `  budget / economy / motel 6 / red roof → Hotel & Motel: Budget/Economy\n` +
        `  boutique / lifestyle hotel     → Hotel & Motel: Boutique\n` +
        `  resort                         → Hotel & Motel: Resort\n` +
        `  B&B / bed and breakfast        → Hotel & Motel: Hostel (closest) — or note in other_requirements\n` +
        `\n` +
        `  SENIOR HOUSING / HEALTH CARE\n` +
        `  ────────────────────────────\n` +
        `  ILF / independent living       → Senior Housing: Independent Living\n` +
        `  ALF / assisted living          → Senior Housing: Assisted Living\n` +
        `  MC / memory care               → Senior Housing: Memory Care\n` +
        `  SNF / skilled nursing / nursing home → Senior Housing: Skilled Nursing\n` +
        `  CCRC / life plan community     → Senior Housing: CCRC\n` +
        `  55+ / active adult / age-restricted → Senior Housing: Active Adult\n` +
        `  urgent care / UC               → Health Care: Urgent Care\n` +
        `  surgery / ASC / ambulatory surgery → Health Care: Surgery Center\n` +
        `  hospital                       → Health Care: Hospital\n` +
        `  rehab / rehabilitation         → Health Care: Rehabilitation\n` +
        `  behavioral / psych / mental health → Health Care: Behavioral Health\n` +
        `  lab / life science / R&D lab   → Health Care: Lab/Life Science\n` +
        `\n` +
        `  AUTOMOTIVE\n` +
        `  ──────────\n` +
        `  ABS / body shop / collision    → Automotive: Auto Body Shop\n` +
        `  mechanic / auto repair / garage / shop → Automotive: Auto Repair / Mechanic\n` +
        `  dealer / dealership            → Automotive: Auto Dealership (New) or (Used) — pick by context\n` +
        `  parts store / NAPA / AutoZone / O'Reilly → Automotive: Auto Parts Store\n` +
        `  tire shop / tire store / tire center → Automotive: Tire Shop\n` +
        `  oil change / lube / Jiffy Lube → Automotive: Oil Change / Lube\n` +
        `  towing / tow yard              → Automotive: Towing Facility\n` +
        `  auction / auto auction         → Automotive: Auto Auction\n` +
        `  CW / car wash / wash           → Automotive: Car Wash AND/OR Special Purpose: Car Wash (emit both unless prose disambiguates)\n` +
        `\n` +
        `  SPECIAL PURPOSE / LAND / OTHER\n` +
        `  ──────────────────────────────\n` +
        `  gas / gas station / convenience / c-store → Special Purpose: Gas Station\n` +
        `  parking lot / parking garage / pkg → Special Purpose: Parking Lot/Garage\n` +
        `  cemetery                       → Special Purpose: Cemetery\n` +
        `  church / religious / synagogue / mosque → Special Purpose: Church/Religious\n` +
        `  school / daycare / charter school → Special Purpose: School\n` +
        `  funeral home / mortuary        → Special Purpose: Funeral Home\n` +
        `  laundromat / wash & fold       → Special Purpose: Laundromat (if in taxonomy)\n` +
        `  cellular / cell tower / cell site → Special Purpose (note subtype in other_requirements)\n` +
        `  arena / stadium                → Sport & Entertainment: Arena/Stadium\n` +
        `  theater / cinema / movie       → Sport & Entertainment: Movie Theater\n` +
        `  bowling / bowling alley        → Sport & Entertainment: Bowling\n` +
        `  golf / golf course             → Sport & Entertainment: Golf Course\n` +
        `  gym / fitness / 24-hour fitness / planet fitness → Sport & Entertainment: Fitness/Gym\n` +
        `  marina / boat slip             → Sport & Entertainment: Marina\n` +
        `  event venue / banquet hall     → Sport & Entertainment: Event Venue\n` +
        `  Dev / dev / development        → Development (top-level if in taxonomy) OR Land: Development\n` +
        `  Resi / residential land        → Land: Residential\n` +
        `  Comm / commercial land         → Land: Commercial\n` +
        `  Indy land / industrial land    → Land: Industrial\n` +
        `  Ag / agricultural land         → Land: Agricultural OR Agricultural (top-level)\n` +
        `  infill / urban infill          → Land: Infill\n` +
        `  pad site                       → Land: Pad Site\n` +
        `  Bizz / business                → no clean vocab match (note in other_requirements)\n` +
        `\n` +
        `If your own explanation text says "X is a warehouse" / "X is a\n` +
        `laundromat" / "X is a mobile home park" / etc., that is a TELL\n` +
        `that you normalized but forgot to apply the SUBTYPE-PRIORITY RULE.\n` +
        `Go back and graduate the chip to "Category: Subtype". The rule\n` +
        `applies to EVERY category in the taxonomy — Industrial, Special\n` +
        `Purpose, Automotive, Residential Income, Senior Housing, Health\n` +
        `Care, Hotel & Motel, Retail, Shopping Center, Multifamily, Mixed\n` +
        `Use, Office, Sport & Entertainment, Agricultural, Land — no\n` +
        `exceptions.\n` +
        `\nMULTI-CHIP IS GOOD: agents search the buyer list by both bare\n` +
        `category AND Category: Subtype. A buyer interested in "warehouse\n` +
        `and truck parking" should appear in BOTH "Industrial: Warehouse"\n` +
        `AND "Industrial: Truck Terminal" search results — so emit BOTH\n` +
        `chips, not just one. The bar for adding a chip is LOW: if the\n` +
        `notes name any subtype, that's enough. Bias toward MORE chips,\n` +
        `not fewer. Worked examples:\n` +
        `  Notes: "looking for WH, distro, and flex space in NJ"\n` +
        `    → "Industrial: Warehouse", "Industrial: Distribution",\n` +
        `      "Industrial: Flex"  (3 chips, not 1)\n` +
        `  Notes: "MOB or surgery center, North Jersey"\n` +
        `    → "Health Care: Medical Office", "Health Care: Surgery Center"\n` +
        `      (2 chips — possibly also "Office: Medical" if MOB might\n` +
        `      be the office-leasing version of the same property)\n` +
        `  Notes: "car wash buyer up to $1M"\n` +
        `    → "Automotive: Car Wash" AND "Special Purpose: Car Wash"\n` +
        `      (both — agent disambiguates in review)\n` +
        `  Notes: "MHP and SFR portfolio"\n` +
        `    → "Residential Income: Mobile Home Park",\n` +
        `      "Residential Income: Single Family Rental"\n` +
        `  Notes: "buys multifamily 4-6 units and student housing"\n` +
        `    → "Multifamily: Fourplex", "Multifamily: Small Multifamily (5-20)"\n` +
        `      (if those subtypes exist), AND "Multifamily: Student Housing"\n` +
        `\n═══════════════════════════════════════════════════════════════════════\n\n`
      userMessage = overrideBlock + userMessage
    }

    // v270: prompt caching on the static system block. Anthropic's ephemeral
    // cache gives ~90% off cached input tokens for 5 minutes. Keeps cost flat
    // when the agent runs the auto-fill multiple times in a row during an
    // iteration session.
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT_STATIC,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userMessage }],
      }),
    })

    if (!aiResp.ok) {
      const errText = await aiResp.text().catch(() => '')
      return jsonResp({
        ok: false,
        error: `Anthropic ${aiResp.status}: ${errText.slice(0, 400)}`,
        prompt_version: PROMPT_VERSION,
      }, 502)
    }

    const aiData = await aiResp.json()
    const stop_reason = aiData?.stop_reason || ''
    const usage = aiData?.usage || {}
    const rawText: string = (aiData?.content?.[0]?.text || '{}')
      .replace(/```json|```/g, '')
      .trim()

    let parsed: {
      buy_intent?: string
      top_level_notes?: string
      fields?: Record<string, unknown>
      citations?: Record<string, string>
      confidence?: Record<string, string>
      explanations?: Record<string, string>
      na?: Array<{ field: string; reason: string }>
      uncertain?: Array<{ field: string; reason: string }>
    } = {}
    try { parsed = JSON.parse(rawText) }
    catch (_) {
      try { parsed = JSON.parse(tryRepairJson(rawText)) }
      catch (_) {
        return jsonResp({
          ok: false,
          error: 'Model returned non-JSON',
          prompt_version: PROMPT_VERSION,
          stop_reason,
          raw_head: rawText.slice(0, 600),
          raw_tail: rawText.slice(-600),
        }, 502)
      }
    }

    const fieldsRaw = (parsed.fields && typeof parsed.fields === 'object') ? parsed.fields : {}
    const explanationsRaw = (parsed.explanations && typeof parsed.explanations === 'object')
      ? (parsed.explanations as Record<string, string>) : {}
    const citationsRaw = (parsed.citations && typeof parsed.citations === 'object')
      ? (parsed.citations as Record<string, string>) : {}
    const confidenceRaw = (parsed.confidence && typeof parsed.confidence === 'object')
      ? (parsed.confidence as Record<string, string>) : {}
    const naRaw = Array.isArray(parsed.na) ? parsed.na : []
    const uncertainRaw = Array.isArray(parsed.uncertain) ? parsed.uncertain : []

    const proposed_changes: Record<string, {
      proposed: unknown
      before: unknown
      explanation?: string
      cite?: string
      confidence?: string
      _extra?: boolean
      _category?: string
    }> = {}
    // v271: server-side guardrail counters — surfaced in diagnostic so the
    // user can see what the safety nets dropped vs what the model proposed.
    const dropped: Record<string, string[]> = {
      no_cite: [],
      out_of_scope_asset: [],
    }

    // v276: when the AI proposed the SAME value already in the BC record,
    // we still want to surface that as "AI confirmed current value" in the
    // review modal — instead of dropping it silently. The frontend renders
    // these with a green check + locked apply box so the user can see the
    // AI looked at the field and agreed.
    const confirmed_fields: Record<string, {
      value: unknown
      cite?: string
      confidence?: string
      explanation?: string
      _extra?: boolean
      _category?: string
    }> = {}

    for (const f of ALL_FIELDS_FOR_REQ) {
      if (currentNa.includes(f.col)) continue
      if (!(f.col in fieldsRaw)) continue
      let propV = coerce(fieldsRaw[f.col], f.type)
      if (propV === null || propV === undefined) continue
      if (typeof propV === 'string' && propV.trim() === '') continue
      if ((f.type === 'enum' || f.type === 'multienum') && f.options) {
        // v287: desired_property_types validates against the runtime
        // taxonomy override (categories + subtypes from ace_ai_settings).
        // Other enum/multienum fields keep their hardcoded vocab.
        const isAssetField = f.col === 'desired_property_types'
        const opts    = isAssetField ? activeVocab    : f.options
        const subMap  = isAssetField ? activeSubtypes : undefined
        const matched = validateEnumProposal(propV, f.type, opts, subMap)
        if (!matched) continue
        propV = matched
      }
      const before = beforeOf(f.col)
      const expl = typeof explanationsRaw[f.col] === 'string' ? explanationsRaw[f.col].slice(0, 280) : undefined
      const cite = typeof citationsRaw[f.col] === 'string' ? citationsRaw[f.col].slice(0, 280) : undefined
      const confRaw = typeof confidenceRaw[f.col] === 'string' ? confidenceRaw[f.col].toLowerCase().trim() : ''
      const confidence = (['high', 'medium', 'low'] as const).find(x => x === confRaw)

      // v276: AI agrees with current value → confirmed_fields, not a change.
      if (JSON.stringify(propV) === JSON.stringify(before)) {
        if (cite && cite.trim()) {
          confirmed_fields[f.col] = {
            value: propV,
            cite,
            ...(confidence ? { confidence } : {}),
            ...(expl ? { explanation: expl } : {}),
            ...(f._extra ? { _extra: true, _category: f._category || '' } : {}),
          }
        }
        continue
      }

      if (only_fill_empty && !isEmptyValue(before)) continue

      // v271 GUARDRAIL: no cite = no proposal. The system prompt requires
      // a citation for every field; if the model skipped one, drop the
      // field rather than ship a value the user can't trace.
      if (!cite || !cite.trim()) {
        dropped.no_cite.push(f.col)
        continue
      }

      proposed_changes[f.col] = {
        proposed: propV,
        before,
        ...(expl ? { explanation: expl } : {}),
        cite,
        ...(confidence ? { confidence } : {}),
        ...(f._extra ? { _extra: true, _category: f._category || '' } : {}),
      }
    }

    // v271 GUARDRAIL: asset-class scope. After we've materialized
    // proposed_changes, look at what desired_property_types ended up being
    // (proposed value if present, else current bc.desired_property_types).
    // For every field whose group is asset-gated, drop the proposal if
    // none of its required asset-vocab entries appear in the active
    // desired_property_types set.
    const dptProposed = proposed_changes['desired_property_types']?.proposed
    const dptCurrent  = bc['desired_property_types']
    const dptActiveStr = (typeof dptProposed === 'string' && dptProposed.trim())
      ? dptProposed
      : (typeof dptCurrent === 'string' ? dptCurrent : '')
    // v272: chips can be "Category" or "Category: Subtype" — when checking
    // asset-class scope, compare against the bare category only.
    const activeAssets = new Set(
      String(dptActiveStr || '')
        .split(/[,;]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const i = s.indexOf(':')
          return i > 0 ? s.slice(0, i).trim() : s
        })
    )
    if (activeAssets.size > 0) {
      for (const f of FIELD_SPEC) {
        const required = GROUP_REQUIRED_ASSET[f.group]
        if (!required) continue
        if (!proposed_changes[f.col]) continue
        const inScope = required.some(a => activeAssets.has(a))
        if (!inScope) {
          dropped.out_of_scope_asset.push(f.col)
          delete proposed_changes[f.col]
        }
      }
    }

    // v232 SAFETY NET: drop any min/max pair where the model still ended up
    // writing the same number to both. Now also covers hotel keys, mhp pads,
    // healthcare SF, and development size (added v235).
    const RANGE_PAIRS: Array<[string, string]> = [
      ['warehouse_min_sf', 'warehouse_max_sf'],
      ['retail_min_sf', 'retail_max_sf'],
      ['office_min_sf', 'office_max_sf'],
      ['shopping_min_sf', 'shopping_max_sf'],
      ['mf_min_units', 'mf_max_units'],
      ['office_min_tenants', 'office_max_tenants'],
      ['land_min_acreage', 'land_max_acreage'],
      ['min_purchase_price', 'max_purchase_price'],
      ['hotel_min_keys', 'hotel_max_keys'],
      ['mhp_min_pads', 'mhp_max_pads'],
      ['healthcare_min_sf', 'healthcare_max_sf'],
      ['development_min_size', 'development_max_size'],
    ]
    for (const [minCol, maxCol] of RANGE_PAIRS) {
      const pMin = proposed_changes[minCol]?.proposed
      const pMax = proposed_changes[maxCol]?.proposed
      if (typeof pMin === 'number' && typeof pMax === 'number' && pMin === pMax) {
        delete proposed_changes[minCol]
        delete proposed_changes[maxCol]
      }
    }

    // v235: target_sf vs min/max conflict. If the model proposed BOTH a
    // *_target_sf and a *_min_sf or *_max_sf for the same asset, prefer the
    // explicit min/max range and drop target_sf.
    const TARGET_SF_PAIRS: Array<[string, string, string]> = [
      ['warehouse_target_sf', 'warehouse_min_sf', 'warehouse_max_sf'],
      ['retail_target_sf', 'retail_min_sf', 'retail_max_sf'],
      ['office_target_sf', 'office_min_sf', 'office_max_sf'],
      ['shopping_target_sf', 'shopping_min_sf', 'shopping_max_sf'],
      ['mixeduse_target_sf', 'mixeduse_min_sf', 'mixeduse_min_sf'],
    ]
    for (const [tCol, minCol, maxCol] of TARGET_SF_PAIRS) {
      if (proposed_changes[tCol] && (proposed_changes[minCol] || proposed_changes[maxCol])) {
        delete proposed_changes[tCol]
      }
    }

    const seenNa = new Set<string>()
    const na_proposals: Array<{ col: string; label: string; explanation?: string }> = []
    for (const item of naRaw) {
      const col = (item as { field?: string }).field
      if (!col || !ALL_FIELD_COLS_FOR_REQ.has(col)) continue
      if (currentNa.includes(col)) continue
      if (proposed_changes[col]) continue
      if (seenNa.has(col)) continue
      seenNa.add(col)
      const def = ALL_FIELDS_FOR_REQ.find(f => f.col === col)!
      const reason = String((item as { reason?: string }).reason || '').slice(0, 240)
      na_proposals.push({ col, label: def.label, ...(reason ? { explanation: reason } : {}) })
    }

    const uncertain_fields: Array<{ col: string; label: string; why: string }> = []
    const seenUnc = new Set<string>()
    for (const item of uncertainRaw) {
      const col = (item as { field?: string }).field
      if (!col || (col !== '*' && !ALL_FIELD_COLS_FOR_REQ.has(col))) continue
      if (seenUnc.has(col)) continue
      seenUnc.add(col)
      const def = col === '*' ? null : ALL_FIELDS_FOR_REQ.find(f => f.col === col)!
      uncertain_fields.push({
        col,
        label: def?.label || '(all)',
        why: String((item as { reason?: string }).reason || '').slice(0, 240),
      })
    }

    return jsonResp({
      ok: true,
      prompt_version: PROMPT_VERSION,
      proposed_changes,
      confirmed_fields,
      na_proposals,
      current_na_fields: currentNa,
      uncertain_fields,
      all_fields: buildAllFields(proposed_changes, na_proposals.map(p => ({ col: p.col, reason: p.explanation || '' }))),
      source_chars,
      source_breakdown,
      model: MODEL,
      stop_reason,
      // v270: diagnostic block for the Copy diagnostic flow.
      // v271: now also reports server-side guardrail drops so the user
      // can see when the model proposed something invalid.
      diagnostic: {
        input_summary: {
          tags: effective_tags,
          contact_tags_from_client: contact_tags,
          ace_notes_used: aceNotes.filter(n => n.body && String(n.body).trim()).length,
          fub_notes_used: fubNotes.filter(n => n.body && String(n.body).trim()).length,
          fub_calls_used: fubCalls.filter(c => c.note && String(c.note).trim()).length,
          tokens_in:               usage.input_tokens || 0,
          tokens_out:              usage.output_tokens || 0,
          tokens_cached_read:      usage.cache_read_input_tokens || 0,
          tokens_cached_write:     usage.cache_creation_input_tokens || 0,
        },
        buy_intent:       String(parsed.buy_intent || ''),
        top_level_notes:  String(parsed.top_level_notes || ''),
        guardrail_drops: {
          no_cite:              dropped.no_cite,
          out_of_scope_asset:   dropped.out_of_scope_asset,
        },
        // v281: auto-routing decision (which model + why).
        model_routing: {
          requested:  modelChoiceRaw,
          decided:    MODEL,
          reason:     modelRoutingReason,
          source_chars,
          note_count: _totalNoteCount,
          thresholds: AUTO_ROUTING,
        },
        // v287: was the runtime taxonomy override active for this run?
        taxonomy: {
          source:               taxonomyRuntimeOverride ? 'ace_ai_settings.bc_taxonomy' : 'hardcoded',
          category_count:       activeVocab.length,
          subtype_total:        Object.values(activeSubtypes).reduce((n, arr) => n + (arr?.length || 0), 0),
        },
        // v288: how many runtime extra fields were merged into FIELD_SPEC for this run.
        extra_fields: {
          count:        extraFieldDefs.length,
          categories:   Array.from(new Set(extraFieldDefs.map(f => f._category))).filter(Boolean),
        },
      },
    })
  } catch (e) {
    return jsonResp({ ok: false, error: String((e as Error)?.message || e), prompt_version: PROMPT_VERSION }, 500)
  }
})
