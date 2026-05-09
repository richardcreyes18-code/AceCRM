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

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 4096
const PROMPT_VERSION = 'bc-v1.0'

type FieldType = 'number' | 'text' | 'boolean' | 'csv' | 'enum' | 'multienum'
interface FieldDef { col: string; label: string; type: FieldType; group: string; hint: string; options?: string[] }

// v207: enum/multienum vocab — the AI must pick from these. Server-side
// coerce() drops any out-of-vocab values so the apply path can rely on
// canonical labels matching the BC edit form's pickers.
const ASSET_TYPE_VOCAB = [
  'Multifamily', 'Warehouse / Industrial', 'Office', 'Retail Strip Mall',
  'Shopping Center', 'Mixed Use', 'Land', 'Automotive', 'Mobile Home Park',
  'Self Storage', 'Hotel', 'Healthcare', 'Special Purpose',
]
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
  let s = raw.replace(/```json|```/g, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1)
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

function validateEnumProposal(value: unknown, type: FieldType, options: string[]): string | null {
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
  - "1031 Investor" or "1031" → bias financing_type to "1031".
  - "VIP" → set is_vip_buyer = true. Cite: "tag: VIP".
  - "Bounced" → ignore. Email deliverability flag, not a buying signal.

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
1. Never invent. If a value is not stated or strongly implied, omit it.
2. Every field in "fields" needs a matching entry in "citations".
3. min_purchase_price / max_purchase_price are TOTAL prices for the whole
   property. NEVER put $/SF, $/acre, or $/unit numbers there. Per-foot
   land pricing goes in "other_requirements".
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
}): string {
  const { contactName, contactTags, context, currentValues, currentNa, onlyFillEmpty, guardrails, additional_text } = args
  const fieldList = buildEligibleFieldsList({ currentValues, currentNa, onlyFillEmpty })
  const currentLines = FIELD_SPEC
    .map(f => {
      const cur = currentValues[f.col]
      if (isEmptyValue(cur)) return `  - ${f.col}: (empty)`
      return `  - ${f.col}: ${JSON.stringify(cur)}`
    })
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

    let contact: Record<string, unknown> | null = null
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

    let fubCalls: Array<{ note?: string | null; created_at?: string | null }> = []
    if (fubId) {
      try {
        fubCalls = (await fetchSb(
          `${SUPABASE_URL}/rest/v1/fub_calls?person_id=eq.${encodeURIComponent(fubId)}&select=note,created_at&order=created_at.desc&limit=30`,
          SERVICE_KEY,
        )) as Array<{ note?: string | null; created_at?: string | null }>
      } catch (_) { fubCalls = [] }
    }

    let fubNotes: Array<{ body?: string | null; created_at?: string | null }> = []
    if (fubId) {
      try {
        fubNotes = (await fetchSb(
          `${SUPABASE_URL}/rest/v1/fub_notes?person_id=eq.${encodeURIComponent(fubId)}&select=body,created_at&order=created_at.desc&limit=30`,
          SERVICE_KEY,
        )) as Array<{ body?: string | null; created_at?: string | null }>
      } catch (_) { fubNotes = [] }
    }

    let aceNotes: Array<{ body?: string | null; kind?: string | null; created_at?: string | null }> = []
    if (contact_id) {
      try {
        aceNotes = (await fetchSb(
          `${SUPABASE_URL}/rest/v1/ace_contact_notes?contact_id=eq.${encodeURIComponent(contact_id)}&select=body,kind,created_at&order=created_at.desc&limit=50`,
          SERVICE_KEY,
        )) as Array<{ body?: string | null; kind?: string | null; created_at?: string | null }>
      } catch (_) { aceNotes = [] }
    }

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

    const buildAllFields = (proposedMap: Record<string, { proposed: unknown; before: unknown; explanation?: string; cite?: string; confidence?: string }>,
                             naProps: Array<{ col: string; reason: string }>) =>
      FIELD_SPEC.map(f => ({
        col: f.col,
        label: f.label,
        group: f.group,
        type: f.type,
        options: f.options || null,
        hint: f.hint,
        before: bc[f.col] ?? null,
        proposed: proposedMap[f.col]?.proposed ?? null,
        explanation: proposedMap[f.col]?.explanation ?? null,
        cite: proposedMap[f.col]?.cite ?? null,
        confidence: proposedMap[f.col]?.confidence ?? null,
        na: currentNa.includes(f.col),
        proposed_na: naProps.find(p => p.col === f.col)?.reason || null,
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

    const userMessage = buildUserMessage({
      contactName,
      contactTags: effective_tags,
      context: contextText,
      currentValues: bc,
      currentNa,
      onlyFillEmpty: only_fill_empty,
      guardrails: userGuardrails,
      additional_text,
    })

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
    }> = {}
    for (const f of FIELD_SPEC) {
      if (currentNa.includes(f.col)) continue
      if (!(f.col in fieldsRaw)) continue
      let propV = coerce(fieldsRaw[f.col], f.type)
      if (propV === null || propV === undefined) continue
      if (typeof propV === 'string' && propV.trim() === '') continue
      if ((f.type === 'enum' || f.type === 'multienum') && f.options) {
        const matched = validateEnumProposal(propV, f.type, f.options)
        if (!matched) continue
        propV = matched
      }
      const before = bc[f.col] ?? null
      if (JSON.stringify(propV) === JSON.stringify(before)) continue
      if (only_fill_empty && !isEmptyValue(before)) continue
      const expl = typeof explanationsRaw[f.col] === 'string' ? explanationsRaw[f.col].slice(0, 280) : undefined
      const cite = typeof citationsRaw[f.col] === 'string' ? citationsRaw[f.col].slice(0, 280) : undefined
      const confRaw = typeof confidenceRaw[f.col] === 'string' ? confidenceRaw[f.col].toLowerCase().trim() : ''
      const confidence = (['high', 'medium', 'low'] as const).find(x => x === confRaw)
      proposed_changes[f.col] = {
        proposed: propV,
        before,
        ...(expl ? { explanation: expl } : {}),
        ...(cite ? { cite } : {}),
        ...(confidence ? { confidence } : {}),
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
      if (!col || !FIELD_SPEC_COLS.has(col)) continue
      if (currentNa.includes(col)) continue
      if (proposed_changes[col]) continue
      if (seenNa.has(col)) continue
      seenNa.add(col)
      const def = FIELD_SPEC.find(f => f.col === col)!
      const reason = String((item as { reason?: string }).reason || '').slice(0, 240)
      na_proposals.push({ col, label: def.label, ...(reason ? { explanation: reason } : {}) })
    }

    const uncertain_fields: Array<{ col: string; label: string; why: string }> = []
    const seenUnc = new Set<string>()
    for (const item of uncertainRaw) {
      const col = (item as { field?: string }).field
      if (!col || (col !== '*' && !FIELD_SPEC_COLS.has(col))) continue
      if (seenUnc.has(col)) continue
      seenUnc.add(col)
      const def = col === '*' ? null : FIELD_SPEC.find(f => f.col === col)!
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
      na_proposals,
      current_na_fields: currentNa,
      uncertain_fields,
      all_fields: buildAllFields(proposed_changes, na_proposals.map(p => ({ col: p.col, reason: p.explanation || '' }))),
      source_chars,
      source_breakdown,
      model: MODEL,
      stop_reason,
      // v270: diagnostic block for the Copy diagnostic flow.
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
      },
    })
  } catch (e) {
    return jsonResp({ ok: false, error: String((e as Error)?.message || e), prompt_version: PROMPT_VERSION }, 500)
  }
})
