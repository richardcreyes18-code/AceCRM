import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

// v27 — Tenant Mix: never drop unnamed tenants; auto-name "Tenant N".
//   Previously, server-side coerce dropped any tenant with a blank name,
//   so "3 retail tenants paying $X each" would emit 3 rows but server
//   silently filtered them all out. Fix: blank names are now auto-filled
//   to "Tenant 1", "Tenant 2"… Prompt rule 17 also tells the LLM to use
//   "Tenant N" placeholder names when source has no actual names.
// v26 — Pitch-out defaults to asking price; cap-target derivation removed.
//   - Server no longer derives pitch_out_price from pitch_out_cap_target
//     (the cap-rate path was over-eager and produced wrong pitches).
//   - When source has no separate Pitch Out dollar, server now defaults
//     pitch_out_price = asking_price.
//   - Prompt rule 19 rewritten: "asking $X" / "listed at $X" / email-
//     template "Asking price: $X" all set BOTH asking_price AND
//     pitch_out_price = X by default. pitch_out_cap_target marked
//     deprecated in field hint and rule 19; LLM is told NEVER to emit it.
// v25 — Auto-N/A on empty + email template > notes priority.
//   (1) When the source has no information for a field, the LLM should
//       propose it for N/A by default — except for calc-only fields (cap
//       rates, derived percentages) and for "uncertain" cases where the
//       LLM has partial info but can't confirm. Old behavior: the LLM
//       was conservative and left empty fields silently empty, forcing
//       the user to manually mark N/A on each one. Updated rule 16.
//   (2) When email-template content conflicts with deal_notes / general
//       _property_notes / etc., prefer the email-template version. The
//       agent curated those outbound messages — they're usually more
//       accurate than raw inbox notes (which can be paraphrased or
//       outdated). Updated rule 21.
//
// v24 — Rent-roll extraction hardening. v22 deployed as v23 was emitting
//   units arrays with stub entries (empty label, rent:0) because:
//   (a) the LLM was sometimes using alt key names (name, monthly_rent,
//       current_rent, bedroom_type) instead of the exact (label,type,rent),
//   (b) it was sometimes emitting nested rent objects {current, proforma},
//   (c) the prompt didn't include a concrete worked-example JSON.
//   Fixes:
//   - coerce() unitMix accepts label||name||unit, type||bedroom_type||
//     unit_type||bedrooms, rent||monthly_rent||current_rent (incl. nested
//     {current,proforma}), status||occupancy.
//   - coerce() drops stub units (empty label AND rent<=0) before emitting.
//   - rule 11 gains a concrete worked example with exact JSON shape.
//
// v22/v23 — mf_unit_rent_data: emit BOTH byType and units when source supports
//   each. Previously the LLM had to pick one mode (rule 11 said "picking
//   byType vs byUnit") and the coerce() unitMix branch dropped the
//   non-chosen side. Result: a per-unit rent roll like "Apt A: 2 Bed/1
//   Bath – $1,500" through "Apt G: 1 Bed/1 Bath – $1,300" got summarized
//   into byType averages and the individual unit info was lost. The CRM
//   side (v135) now derives byType averages from the units array, so AI
//   should always emit the rent roll when one exists. Both shapes coexist.
//
// v28 — Estimated Expenses residual is now sized so itemized + residual
//   exactly = (Gross − NOI), preserving the source's NOI even when only a
//   subset of expenses is itemized (e.g. Property Taxes + Water given,
//   everything else lumped). Rule 18 + field hint updated accordingly; the
//   server-side guard (formerly !hasItemizedExp only) now also runs when
//   itemized line items are present and rebalances the residual bucket.
//
// v21 — NOI routing fix + construction_type + est_gross_minus_noi_monthly.
//   When source has Gross Income + NOI but no itemized expense breakdown,
//   the AI used to flip noi_override_active=true and skip the math. That
//   left the Operating Expenses table empty so the displayed NOI relied
//   on a manual override instead of falling out of EGI − Expenses.
//   New behavior: compute monthly_est = (gross_yearly - noi_yearly) / 12 and
//   route it to est_gross_minus_noi_monthly (the new "Estimated Expenses"
//   row in the financial UI). Emit `noi` (the source's actual NOI) too so
//   the cap-rate row reflects reality. Skip the override.
//
// v20 — other_industrial_notes / other_unit_mix_notes overflow buckets.
// v19 — email templates as additional context.
// v18 — per-field explanations.

const ASSET_SUBTYPES: Record<string, string[]> = {
  'Multifamily':        ['Garden/Low Rise','Mid Rise','High Rise','Duplex','Triplex','Fourplex','Townhome','Student Housing','Military Housing','Affordable Housing','Mixed Income'],
  'Office':             ['CBD','Suburban','Medical','Creative/Flex','Government','R&D','Owner/User'],
  'Industrial':         ['Warehouse','Distribution','Manufacturing','Flex','Cold Storage','Data Center','Truck Terminal','Self Storage','R&D','Showroom'],
  'Retail':             ['Strip Mall','Power Center','Neighborhood Center','Community Center','Regional Mall','Single Tenant','Restaurant','Auto Dealership','Drug Store','Bank','Value Add Strip','NNN Retail','Grocery Anchored'],
  'Shopping Center':    ['Strip Center','Neighborhood Center','Community Center','Power Center','Lifestyle Center','Regional Mall','Super Regional Mall','Outlet Center'],
  'Mixed Use':          ['Retail / Residential (Ground Floor Retail + Upper Residential)','Office / Residential','Retail / Office','Live-Work','Mixed Commercial','Ground Floor Retail + Apartments'],
  'Land':               ['Commercial','Residential','Industrial','Agricultural','Mixed Use','Infill','Pad Site','Development'],
  'Agricultural':       ['Row Crops','Orchards/Vineyards','Livestock','Dairy','Poultry','Timberland','Irrigation'],
  'Hotel & Motel':      ['Full Service','Select Service','Extended Stay','Budget/Economy','Boutique','Resort','Motel','Hostel'],
  'Senior Housing':     ['Independent Living','Assisted Living','Memory Care','Skilled Nursing','CCRC','Active Adult'],
  'Health Care':        ['Medical Office','Urgent Care','Surgery Center','Hospital','Rehabilitation','Behavioral Health','Lab/Life Science'],
  'Sport & Entertainment': ['Arena/Stadium','Movie Theater','Bowling','Golf Course','Fitness/Gym','Marina','Event Venue','Amusement'],
  'Special Purpose':    ['Car Wash','Gas Station','Parking Lot/Garage','Cemetery','Church/Religious','School','Community Center','Government','Funeral Home'],
  'Automotive':         ['Auto Body Shop','Auto Repair / Mechanic','Auto Dealership (New)','Auto Dealership (Used)','Auto Parts Store','Tire Shop','Oil Change / Lube','Towing Facility','Auto Auction','Car Wash'],
  'Residential Income': ['Single Family Rental','Duplex','Triplex','Fourplex','Small Multifamily (5-20)','Large Multifamily (21+)','Mobile Home Park']
}

const ASSET_VALUES: string[] = (() => {
  const out: string[] = []
  for (const [cat, subs] of Object.entries(ASSET_SUBTYPES)) {
    out.push(cat)
    for (const s of subs) out.push(cat + ': ' + s)
  }
  out.push('Commercial', 'Residential', 'Vacant Building')
  return out
})()

const ENUM_OPTIONS: Record<string, string[]> = {
  property_use:        ['Investment/Cash Flow', 'Owner/User', 'Vacant', 'Turnaround', 'Business Also For Sale'],
  property_class:      ['A','B','C','D'],
  property_condition:  ['Excellent','Good','Average','Fair','Poor'],
  location_class:      ['A','B','C','D'],
  location_trending:   ['Up-and-coming','Stable','Declining'],
  location_type:       ['Urban','Suburban','Rural'],
  construction_status: ['Existing','Under Construction','Proposed'],
  is_property_listed:  ['Listed','Off-Market','Pocket Listing'],
  expense_mode:        ['itemized','ratio'],
  lot_size_unit:       ['acres','square_feet'],
  seller_motivation_level: ['Highly Motivated','Motivated','Lukewarm','Not Motivated'],
  seller_financial_strength: ['Strong','Average','Weak'],
  mortgage_payments_status:  ['Current','Late','Default','Free and Clear'],
  crm_asset_classification: ASSET_VALUES,
  property_type_text:        ASSET_VALUES,
}

const TENANT_LEASE_TYPES = new Set(['NNN','NN','N','Gross','Modified Gross','Full Service','Absolute NNN','Percentage','Month-to-Month','Other'])

const FIELD_SPEC: Array<{col:string, type:string, hint:string, group:string}> = [
  { col:'asking_price',                     type:'number',  group:'Pricing', hint:'Seller plain asking price in dollars. Use for unqualified "asking $X", "price $X", "listed at $X". When the source uses "$X wants to Net" pattern (X is the seller net target) and there is no separate asking value, also set asking_price = X.' },
  { col:'target_seller_net',                type:'number',  group:'Pricing', hint:'Seller TARGET NET price. The dollar amount associated with "wants to Net" / "net to seller". Note: in the convention used by these notes, the dollar amount IMMEDIATELY BEFORE "wants to Net" is the net target, NOT the dollar after.' },
  { col:'pitch_out_price',                  type:'number',  group:'Pricing', hint:'Pitch-out price to buyers. The dollar amount immediately before "Pitch Out" / immediately preceding "Pitch Out @ N Cap" or "Pitch Out @ $X". When source has only an asking/listed price and no separate Pitch Out dollar, default pitch_out_price = asking_price (the asking IS the pitch out by default until the agent enters a separate pitch). Cap-rate targets ("Pitch Out @ 7 Cap" with no dollar) are descriptive only — IGNORE them and use asking_price as the pitch.' },
  { col:'pitch_out_cap_target',             type:'percent', group:'Pricing', hint:'DEPRECATED — do not emit. Cap-rate targets are descriptive only; the server no longer derives pitch_out_price from cap. Use pitch_out_price directly (default to asking_price when no separate dollar pitch is given).' },
  { col:'seller_original_purchase_price',   type:'number',  group:'Pricing', hint:'What the seller originally paid' },
  { col:'seller_original_purchase_date',    type:'date',    group:'Pricing', hint:'When seller originally bought (YYYY-MM-DD)' },
  { col:'date_went_on_market',              type:'date',    group:'Pricing', hint:'When the property went on market (YYYY-MM-DD)' },
  { col:'commission_split_pct',             type:'percent', group:'Pricing', hint:'Commission split %' },
  { col:'is_property_listed',               type:'enum',    group:'Pricing', hint:'EXACTLY one of: "Listed" / "Off-Market" / "Pocket Listing"' },
  { col:'gross_revenue_yearly',             type:'number',  group:'Income', hint:'Total gross yearly income (rent + other). The CRM auto-calculates the monthly equivalent — fill yearly only.' },
  { col:'gross_rental_income_monthly',      type:'number',  group:'Income', hint:'Rental income only (no other) — monthly' },
  { col:'other_income_monthly',             type:'number',  group:'Income', hint:'"Plus: Other Income" section — non-rent income, monthly. Includes laundry net to owner, parking, vending, storage, pet fees, application fees.' },
  { col:'rubs_cam_income_monthly',          type:'number',  group:'Income', hint:'RUBS / CAM reimbursements — monthly' },
  { col:'vacancy_rate_pct',                 type:'percent', group:'Income', hint:'Current vacancy rate as a percent (0-100)' },
  { col:'occupancy_pct',                    type:'percent', group:'Income', hint:'Current occupancy as a percent (0-100)' },
  { col:'non_revenue_units_pct',            type:'percent', group:'Income', hint:'Non-revenue units as a percent (0-100)' },
  { col:'noi',                              type:'number',  group:'Returns', hint:'Net operating income, yearly (the source\'s actual NOI). Emit whenever the source provides a NOI number AND has either gross income OR an itemized expense breakdown. Do NOT use noi_override when gross income is also given — the CRM derives expenses from (Gross − NOI) and lets NOI fall out of EGI − Expenses naturally.' },
  { col:'noi_actual_yr',                    type:'number',  group:'Returns', hint:'Custom NOI Override - ACTUAL yearly. ONLY use when source has NOI and NO gross income AND no itemized expenses. If gross income is given, route the (Gross − NOI) gap to est_gross_minus_noi_monthly instead.' },
  { col:'noi_proforma_yr',                  type:'number',  group:'Returns', hint:'Custom NOI Override - PROFORMA yearly. Same rules as noi_actual_yr.' },
  { col:'noi_override_active',              type:'boolean', group:'Returns', hint:'TRUE only when noi_actual_yr / noi_proforma_yr is the authoritative NOI (i.e. neither gross income nor itemized expenses available).' },
  { col:'expense_mode',                     type:'enum',    group:'Expenses', hint:'EXACTLY one of: "itemized" / "ratio". Use "itemized" when source has line items OR when gross-NOI gap is being routed to est_gross_minus_noi_monthly. Use "ratio" only when source gives nothing but a percent.' },
  { col:'expenses_yearly',                  type:'number',  group:'Expenses', hint:'Total expenses, yearly. ONLY emit when source has an itemized breakdown that totals to this. Do NOT emit when gross-NOI gap is being routed to est_gross_minus_noi_monthly (that path uses the monthly column).' },
  { col:'actual_expense_ratio_pct',         type:'percent', group:'Expenses', hint:'Actual expense ratio as percent. ONLY fill if expense_mode is "ratio".' },
  { col:'pro_forma_expense_ratio_pct',      type:'percent', group:'Expenses', hint:'Pro-forma expense ratio as percent. ONLY fill if expense_mode is "ratio".' },
  { col:'property_tax_monthly',             type:'number', group:'Expense Details', hint:'Property tax monthly.' },
  { col:'insurance_monthly',                type:'number', group:'Expense Details', hint:'Insurance monthly' },
  { col:'electric_monthly',                 type:'number', group:'Expense Details', hint:'Electric monthly' },
  { col:'gas_monthly',                      type:'number', group:'Expense Details', hint:'Gas monthly' },
  { col:'water_sewer_monthly',              type:'number', group:'Expense Details', hint:'Water/sewer monthly' },
  { col:'trash_monthly',                    type:'number', group:'Expense Details', hint:'Trash / waste removal monthly' },
  { col:'janitorial_monthly',               type:'number', group:'Expense Details', hint:'Janitorial monthly' },
  { col:'landscaping_monthly',              type:'number', group:'Expense Details', hint:'Landscaping / snow removal monthly' },
  { col:'maintenance_repair_monthly',       type:'number', group:'Expense Details', hint:'Maintenance & repair monthly' },
  { col:'maintenance_salary_monthly',       type:'number', group:'Expense Details', hint:'Maintenance staff salary monthly' },
  { col:'pool_monthly',                     type:'number', group:'Expense Details', hint:'Pool monthly' },
  { col:'supplies_monthly',                 type:'number', group:'Expense Details', hint:'Supplies monthly' },
  { col:'misc_expenses_monthly',            type:'number', group:'Expense Details', hint:'Miscellaneous / reserves monthly' },
  { col:'property_mgmt_fee_monthly',        type:'number', group:'Expense Details', hint:'Property mgmt fee monthly' },
  { col:'capital_reserve_monthly',          type:'number', group:'Expense Details', hint:'Capital reserves monthly' },
  { col:'admin_expenses_monthly',           type:'number', group:'Expense Details', hint:'Admin monthly' },
  { col:'accounting_monthly',               type:'number', group:'Expense Details', hint:'Accounting monthly' },
  { col:'legal_monthly',                    type:'number', group:'Expense Details', hint:'Legal monthly' },
  { col:'liability_insurance_monthly',      type:'number', group:'Expense Details', hint:'Liability insurance monthly' },
  { col:'est_gross_minus_noi_monthly',      type:'number', group:'Expense Details', hint:'Residual / balancing monthly expense bucket. Formula: (Gross_yearly − NOI_yearly − sum_of_itemized_expenses_yearly) / 12. Always sized so that itemized expenses + this bucket = (Gross − NOI) exactly, so reported NOI is preserved. Emit whenever both Gross and NOI are present and the residual is positive — even when itemized line items (taxes, water, etc.) are also present. If sum_of_itemized already equals (Gross − NOI) within $1, omit this field.' },
  { col:'proforma_gross_rent_monthly',      type:'number',  group:'Pro Forma', hint:'Pro-forma rent monthly' },
  { col:'proforma_other_income_monthly',    type:'number',  group:'Pro Forma', hint:'Pro-forma other income monthly (laundry, parking, vending, etc.)' },
  { col:'proforma_rubs_cam_monthly',        type:'number',  group:'Pro Forma', hint:'Pro-forma RUBS/CAM monthly' },
  { col:'proforma_vacancy_rate_pct',        type:'percent', group:'Pro Forma', hint:'Pro-forma vacancy %' },
  { col:'proforma_non_revenue_units_pct',   type:'percent', group:'Pro Forma', hint:'Pro-forma non-revenue %' },
  { col:'pro_forma_gross_revenue_yearly',   type:'number',  group:'Pro Forma', hint:'Pro-forma gross revenue yearly.' },
  { col:'pro_forma_expenses_yearly',        type:'number',  group:'Pro Forma', hint:'Pro-forma expenses yearly.' },
  { col:'mortgage1_loan_type',              type:'text',    group:'Mortgages', hint:'Loan 1 type' },
  { col:'mortgage1_principal',              type:'number',  group:'Mortgages', hint:'Loan 1 principal' },
  { col:'mortgage1_interest_rate_pct',      type:'percent', group:'Mortgages', hint:'Loan 1 rate %' },
  { col:'mortgage1_amortization_yrs',       type:'integer', group:'Mortgages', hint:'Loan 1 amortization yrs' },
  { col:'mortgage1_assumable',              type:'boolean', group:'Mortgages', hint:'Loan 1 assumable?' },
  { col:'mortgage1_years_remaining',        type:'integer', group:'Mortgages', hint:'Loan 1 years left' },
  { col:'mortgage2_loan_type',              type:'text',    group:'Mortgages', hint:'Loan 2 type' },
  { col:'mortgage2_principal',              type:'number',  group:'Mortgages', hint:'Loan 2 principal' },
  { col:'mortgage2_interest_rate_pct',      type:'percent', group:'Mortgages', hint:'Loan 2 rate %' },
  { col:'mortgage2_amortization_yrs',       type:'integer', group:'Mortgages', hint:'Loan 2 amort yrs' },
  { col:'mortgage2_assumable',              type:'boolean', group:'Mortgages', hint:'Loan 2 assumable' },
  { col:'mortgage2_years_remaining',        type:'integer', group:'Mortgages', hint:'Loan 2 years left' },
  { col:'annual_debt_service',              type:'number',  group:'Mortgages', hint:'Annual debt service total' },
  { col:'dscr_manual',                      type:'number',  group:'Mortgages', hint:'DSCR (e.g. 1.25)' },
  { col:'down_payment_pct',                 type:'percent', group:'Financing', hint:'Down payment %' },
  { col:'down_payment_type',                type:'text',    group:'Financing', hint:'Down payment type' },
  { col:'renovation_expense',               type:'number',  group:'Financing', hint:'Total renovation budget' },
  { col:'square_footage',                   type:'number',  group:'Physical', hint:'Total building SF' },
  { col:'total_building_sf',                type:'integer', group:'Physical', hint:'Total building SF (integer)' },
  { col:'net_rentable_sf',                  type:'integer', group:'Physical', hint:'Net rentable SF' },
  { col:'total_lot_size',                   type:'number',  group:'Physical', hint:'Lot size (acres unless lot_size_unit says SF)' },
  { col:'lot_size_unit',                    type:'enum',    group:'Physical', hint:'EXACTLY one of: "acres" / "square_feet"' },
  { col:'no_of_buildings',                  type:'integer', group:'Physical', hint:'Number of buildings' },
  { col:'no_of_units',                      type:'integer', group:'Physical', hint:'Total units' },
  { col:'number_of_units',                  type:'integer', group:'Physical', hint:'Total units (legacy)' },
  { col:'no_of_stories',                    type:'integer', group:'Physical', hint:'Number of floors' },
  { col:'no_of_parking_spaces',             type:'integer', group:'Physical', hint:'Parking spaces' },
  { col:'parking_ratio',                    type:'text',    group:'Physical', hint:'Parking ratio e.g. "3:1000"' },
  { col:'year_built',                       type:'integer', group:'Physical', hint:'Year built' },
  { col:'year_renovated',                   type:'integer', group:'Physical', hint:'Year of last renovation' },
  { col:'location_description',             type:'text',    group:'Quality', hint:'Short location/neighborhood description (1-3 sentences)' },
  { col:'property_class',                   type:'enum',    group:'Quality',  hint:'EXACTLY one of: "A"/"B"/"C"/"D"' },
  { col:'property_condition',               type:'enum',    group:'Quality',  hint:'EXACTLY one of: "Excellent"/"Good"/"Average"/"Fair"/"Poor"' },
  { col:'location_class',                   type:'enum',    group:'Quality',  hint:'EXACTLY one of: "A"/"B"/"C"/"D"' },
  { col:'location_trending',                type:'enum',    group:'Quality',  hint:'EXACTLY one of: "Up-and-coming"/"Stable"/"Declining"' },
  { col:'location_type',                    type:'enum',    group:'Quality',  hint:'EXACTLY one of: "Urban"/"Suburban"/"Rural"' },
  { col:'construction_status',              type:'enum',    group:'Quality',  hint:'EXACTLY one of: "Existing" / "Under Construction" / "Proposed"' },
  { col:'property_use',                     type:'enum',    group:'Quality',  hint:'EXACTLY one of: "Investment/Cash Flow" / "Owner/User" / "Vacant" / "Turnaround" / "Business Also For Sale". Asset class belongs in crm_asset_classification, NOT here.' },
  { col:'hvac',                             type:'text',    group:'Components', hint:'HVAC type / condition' },
  { col:'roof_type',                        type:'text',    group:'Components', hint:'Roof type (Flat / Pitched / Hip / Gable / Metal / Rubber / Other)' },
  { col:'construction_type',                type:'text',    group:'Components', hint:'Construction type (Brick / Wood Frame / Steel Frame / Concrete Block / Masonry / Other)' },
  { col:'parking_type',                     type:'text',    group:'Components', hint:'Parking type' },
  { col:'foundation',                       type:'text',    group:'Components', hint:'Foundation type' },
  { col:'exterior',                         type:'text',    group:'Components', hint:'Exterior material' },
  { col:'piping',                           type:'text',    group:'Components', hint:'Plumbing material/condition' },
  { col:'wiring',                           type:'text',    group:'Components', hint:'Electrical wiring type/condition' },
  { col:'floor_covering',                   type:'text',    group:'Components', hint:'Floor covering' },
  { col:'paving',                           type:'text',    group:'Components', hint:'Paving' },
  { col:'units_efficiency',                 type:'integer', group:'Unit Mix', hint:'Studio/efficiency count' },
  { col:'units_efficiency_vacant',          type:'integer', group:'Unit Mix', hint:'Vacant studios' },
  { col:'units_1br',                        type:'integer', group:'Unit Mix', hint:'1BR count' },
  { col:'units_1br_vacant',                 type:'integer', group:'Unit Mix', hint:'Vacant 1BR' },
  { col:'units_2br',                        type:'integer', group:'Unit Mix', hint:'2BR count' },
  { col:'units_2br_vacant',                 type:'integer', group:'Unit Mix', hint:'Vacant 2BR' },
  { col:'units_3br',                        type:'integer', group:'Unit Mix', hint:'3BR count' },
  { col:'units_3br_vacant',                 type:'integer', group:'Unit Mix', hint:'Vacant 3BR' },
  { col:'units_4br',                        type:'integer', group:'Unit Mix', hint:'4BR+ count' },
  { col:'units_4br_vacant',                 type:'integer', group:'Unit Mix', hint:'Vacant 4BR+' },
  { col:'units_other',                      type:'integer', group:'Unit Mix', hint:'Other unit count' },
  { col:'units_other_vacant',               type:'integer', group:'Unit Mix', hint:'Vacant other' },
  { col:'mf_unit_rent_data',                type:'unitMix', group:'Unit Mix', hint:'MULTIFAMILY / MIXED-USE rent-roll JSON. Populate BOTH byType AND units when both are available. byType={eff,1br,2br,3br,4br,oth} for per-bedroom averages. units=[{label,type,rent,status}] for a per-unit rent roll (e.g. "Apt A: 2 Bed/1 Bath – $1,500"). When the source contains a per-unit roll, populate units (the CRM auto-derives byType averages from it). When the source has only per-bedroom averages, populate byType. Both is fine.' },
  { col:'other_unit_mix_notes',             type:'text',    group:'Unit Mix', hint:'Free-form OVERFLOW text for the unit mix — use ONLY for context that does not fit any other unit/MF field. Examples: "Owner lives in unit 2A", "3 units kept off-market for rehab", "All units have W/D hookups". Quote the source verbatim when concise.' },
  { col:'tenant_mix_data',                  type:'tenantMix', group:'Tenant Mix', hint:'COMMERCIAL tenant roster. Array of tenant records. ALWAYS extract any named tenant with ANY lease detail. Per-tenant fields: "Tenant / Business Name" (REQUIRED), "Industry", "Unit / Suite", "Square Footage", "Years in Unit", "Monthly Rent" (auto-calc from SF*PSF/12 if you skip it), "Rent Per SF (Annual)", "CAM Charges (Monthly)", "Lease Type" (NNN/NN/N/Gross/Modified Gross/Full Service/Absolute NNN/Percentage/Month-to-Month/Other), "Lease Term (Years)", "Years Remaining", "Lease Start Date", "Lease End Date", "Options to Renew", "Annual Increases", "Security Deposit", "Sort Order", "First Right of Refusal", "Personal Guarantee", "Lease Document URL", "Tenant Notes". OMIT per-tenant fields not in source. NEVER for multifamily.' },
  { col:'num_tenants',                      type:'integer', group:'Industrial', hint:'Number of tenants in the building (industrial / commercial). 1 = single tenant.' },
  { col:'office_sf',                        type:'integer', group:'Industrial', hint:'Office portion square feet (industrial).' },
  { col:'warehouse_sf',                     type:'integer', group:'Industrial', hint:'Warehouse / non-office portion square feet (industrial)' },
  { col:'office_sf_pct',                    type:'percent', group:'Industrial', hint:'Office portion as percent of total building (0-100).' },
  { col:'num_loading_docks',                type:'integer', group:'Industrial', hint:'Number of dock-high loading doors (industrial)' },
  { col:'num_drive_ins',                    type:'integer', group:'Industrial', hint:'Number of drive-in / grade-level doors (industrial)' },
  { col:'ceiling_height_ft',                type:'number',  group:'Industrial', hint:'Clear ceiling height in feet (industrial)' },
  { col:'other_industrial_notes',           type:'text',    group:'Industrial', hint:'Free-form OVERFLOW text for industrial deals — use for owner-occupied details, additional tenant info, special-purpose use, anything industrial-specific that does not fit a structured field. ALWAYS fill this when the source says owner-occupied=true and gives a quoted explanation. Examples: "Owner uses 3-4 of the units personally and hasn\'t tried to rent them out", "Tenant on month-to-month", "Single drive-in is dock-high but truck-bay only." Quote the source verbatim when concise.' },
  { col:'automotive_gas_type',              type:'text',    group:'Asset-Specific', hint:'Gas station type if automotive' },
  { col:'automotive_wash_type',             type:'text',    group:'Asset-Specific', hint:'Car wash type' },
  { col:'retail_lease_type',                type:'text',    group:'Asset-Specific', hint:'Retail lease type (NNN, NN, gross, etc.)' },
  { col:'shopping_lease_type',              type:'text',    group:'Asset-Specific', hint:'Shopping center lease type' },
  { col:'seller_motivation_level',          type:'enum',    group:'Seller', hint:'EXACTLY one of: "Highly Motivated" / "Motivated" / "Lukewarm" / "Not Motivated"' },
  { col:'seller_financial_strength',        type:'enum',    group:'Seller', hint:'EXACTLY one of: "Strong" / "Average" / "Weak"' },
  { col:'mortgage_payments_status',         type:'enum',    group:'Seller', hint:'EXACTLY one of: "Current" / "Late" / "Default" / "Free and Clear"' },
  { col:'why_selling',                      type:'text',    group:'Seller', hint:'Why the seller is selling (one short sentence)' },
  { col:'owner_occupied',                   type:'boolean', group:'Flags', hint:'Owner currently occupying?' },
  { col:'no_financials_yet',                type:'boolean', group:'Flags', hint:'Seller has not shared financials' },
  { col:'fully_vacant',                     type:'boolean', group:'Flags', hint:'100% vacant' },
  { col:'is_distressed',                    type:'boolean', group:'Flags', hint:'Distressed sale' },
  { col:'is_on_ground_lease',               type:'boolean', group:'Flags', hint:'On ground lease' },
  { col:'sale_leaseback',                   type:'boolean', group:'Flags', hint:'Sale-leaseback' },
  { col:'property_type_text',               type:'enum',    group:'Identity', hint:'Asset classification in "Top: Subtype" form. EXACT match against the master list. Pick the MOST SPECIFIC option. Same value should match crm_asset_classification.' },
  { col:'crm_asset_classification',         type:'enum',    group:'Identity', hint:'Asset classification in "Top: Subtype" form. EXACT match against the master list. Pick the MOST SPECIFIC option. NEVER propose a less-specific value than what is currently saved (no downgrades).' },
]

const ASSET_CLASS_COLS = new Set(['crm_asset_classification','property_type_text'])
const TRANSIENT_COLS = new Set(['pitch_out_cap_target'])

function buildPrompt(ctx: { address: string, contextText: string, currentValues: Record<string, unknown>, currentNa: string[], onlyFillEmpty: boolean }) {
  const { address, contextText, currentValues, currentNa, onlyFillEmpty } = ctx
  const naSet = new Set(currentNa)
  const eligible = FIELD_SPEC.filter(f => {
    if (naSet.has(f.col)) return false
    if (!onlyFillEmpty) return true
    const cur = currentValues?.[f.col]
    return cur === null || cur === undefined || cur === ''
  })
  const fieldList = eligible.map(f => '  - "' + f.col + '" [' + f.type + ']: ' + f.hint).join('\n')
  const naContext = currentNa.length
    ? '\nFIELDS ALREADY MARKED N/A (do NOT propose values for these and do NOT re-suggest as N/A): ' + currentNa.join(', ') + '\n'
    : ''
  const assetMenu = Object.entries(ASSET_SUBTYPES)
    .map(([cat, subs]) => '  - ' + cat + ': [' + subs.join(', ') + ']')
    .join('\n')
  const lines = [
    'You are an expert commercial real-estate analyst. Extract every quantified fact from the supplied property text and return them as a single JSON object.',
    '',
    'PROPERTY ADDRESS: ' + (address || '(unknown)'),
    naContext,
    '=== CONTEXT TEXT ===',
    contextText.slice(0, 16000),
    '=== END CONTEXT ===',
    '',
    'RULES:',
    '1. Output VALID JSON only - no preamble, no code fences, no comments.',
    '2. Top-level shape: { "fields": { ... }, "explanations": { ... }, "na": [...], "uncertain": [...] }',
    '3. ONLY include fields you can fill from context. OMIT what you cannot fill.',
    '4. Numbers as numbers (no $, no commas, no units). Percentages 0-100. Dates YYYY-MM-DD.',
    '5. Booleans as true/false (not strings).',
    '6. Enum fields MUST EXACTLY match a documented option. Server drops unknowns.',
    '7. NEVER invent. If a value is not explicitly in the context, omit it. NEVER fill construction details (roof_type, construction_type, foundation, exterior, floor_covering, piping, wiring, paving, hvac) unless the source explicitly mentions them — a generic property listing does not imply "Pitched" or "Brick".',
    '8. Revenue/expense: only fill the YEARLY column for gross_revenue_yearly, expenses_yearly, pro_forma_gross_revenue_yearly, pro_forma_expenses_yearly. Do NOT also fill a monthly counterpart.',
    '9. Cap rates are calc-only EXCEPT pitch_out_cap_target.',
    '10. EXPENSE MODE: "itemized" if any line items appear OR if you are routing the gross-NOI gap to est_gross_minus_noi_monthly. "ratio" only if source gives nothing but a percent.',
    '11. UNIT MIX (multifamily AND mixed-use): emit mf_unit_rent_data with BOTH byType and units when available. If source contains a per-unit rent roll ("Apt A: 2 Bed/1 Bath – $1,500", "Unit 1: 1BR $1,300"), populate units=[{label,type,rent,status}] for every listed unit — do NOT skip this in favor of averages, the CRM derives the bedroom averages from the units. If source only has per-bedroom averages ("avg 2BR $1,500"), populate byType. If both signals appear, populate both. Always also fill units_* counts.\n    EXACT JSON SHAPE for units (use these EXACT lowercase keys, not name/monthly_rent/etc):\n      [{"label":"Apt A","type":"2 Bedroom","rent":1500,"status":"Occupied"}, ...]\n    type MUST be one of: Efficiency, 1 Bedroom, 2 Bedroom, 3 Bedroom, 4 Bedroom, Other.\n    status MUST be one of: Occupied, Vacant, Owner-Occupied, Section 8.\n    rent is a single integer for the CURRENT/in-place rent (NOT pro-forma) — if source says "$1,500 (increasing to $1,700)", use rent:1500. Never emit nested {current,proforma} objects, never emit "rent":0 placeholders.\n    WORKED EXAMPLE — source:\n      "7-Unit Multifamily Property. Apt A: 2 Bed/1 Bath – $1,500. Apt B: 2 Bed/1 Bath – $1,500. Apt C: 3 Bed/1 Bath – $2,000. Apt D: Large 1 Bed/1 Bath – $1,200. Apt E: 2 Bed/1 Bath – $1,800. Apt F: Efficiency – $700. Apt G: 1 Bed/1 Bath – $1,300."\n    emit mf_unit_rent_data:\n      {"mode":"byUnit","byType":{},"units":[{"label":"Apt A","type":"2 Bedroom","rent":1500,"status":"Occupied"},{"label":"Apt B","type":"2 Bedroom","rent":1500,"status":"Occupied"},{"label":"Apt C","type":"3 Bedroom","rent":2000,"status":"Occupied"},{"label":"Apt D","type":"1 Bedroom","rent":1200,"status":"Occupied"},{"label":"Apt E","type":"2 Bedroom","rent":1800,"status":"Occupied"},{"label":"Apt F","type":"Efficiency","rent":700,"status":"Occupied"},{"label":"Apt G","type":"1 Bedroom","rent":1300,"status":"Occupied"}]}',
    '12. INCOME ROUTING: "Laundry net to owner", "Parking income", "Vending", "Storage fees" -> other_income_monthly.',
    '13. INDUSTRIAL FIELDS: only fill on industrial / warehouse / flex.',
    '14. ASSET CLASSIFICATION (CRITICAL): both crm_asset_classification AND property_type_text take a value from the allow-list below. Always emit "Top: Subtype" form when a subtype fits. Pick MOST SPECIFIC. NEVER propose a less-specific value than current value (no downgrades). Allow-list:',
    assetMenu,
    '    Plus standalones: Commercial, Residential, Vacant Building.',
    '15. PROPERTY_USE vs CRM_ASSET_CLASSIFICATION: do NOT confuse these.',
    '16. N/A PROPOSALS (BE AGGRESSIVE): for every field NOT in the "fields" object, decide between "na" and "uncertain" based on this rule:\n    - "na" array — use this when (a) the field is inherently inapplicable to this property type (e.g. units_3br on a single-family rental, num_loading_docks on multifamily, automotive_gas_type on residential), OR (b) the source genuinely contains NO information about the field AND the field has a meaningful "Not Applicable" interpretation (e.g. mortgage1_principal when source says "free and clear", num_drive_ins on retail, pool_monthly when no pool mentioned). DEFAULT to N/A whenever you have no info — the user wants empty fields auto-marked N/A so they don\'t pile up as TODOs.\n    - "uncertain" — use this ONLY when you have partial / conflicting / ambiguous information and need the user to decide. Do NOT use uncertain just because info is missing — that goes in "na".\n    - DO NOT propose N/A for these calc-only / derived fields (they recompute from inputs): pitch_out_cap_target, actual_expense_ratio_pct, pro_forma_expense_ratio_pct (when expense_mode=itemized), or any field starting with "noi_" when the canonical noi is being filled.\n    - For any field genuinely missing from source AND not calc-only, prefer N/A over silence.',
    '17. TENANT MIX (retail / industrial / flex / office / mixed-use - NEVER multifamily): ALWAYS emit tenant_mix_data when ANY tenant appears with ANY lease detail (named OR unnamed). Server auto-derives Monthly Rent = SF*PSF/12 when both present. Tenant/Business name is REQUIRED — if no actual name appears in the source (e.g. "3 retail tenants paying $X each", "owner + 2 unnamed tenants"), use "Tenant 1", "Tenant 2", "Tenant 3" in the order they appear. Server fills any blank names as a safety net but you should emit them so the user sees the right count.',
    '18. NOI ROUTING (CRITICAL): the rule below ensures the reported NOI is preserved exactly, regardless of which expenses the source itemizes.',
    '    - Source has GROSS + NOI + itemized expenses → emit `noi`, the itemized expense_*_monthly fields, AND est_gross_minus_noi_monthly = max(0, (gross_yearly − noi_yearly − sum_of_itemized_yearly) / 12). The residual bucket absorbs every dollar of expense the source doesn\'t itemize so total expenses = (Gross − NOI) and the displayed NOI matches the source. Do NOT use override.',
    '    - Source has GROSS + NOI but NO itemized expense breakdown → emit:',
    '         est_gross_minus_noi_monthly = (gross_yearly − noi_yearly) / 12',
    '         expense_mode = "itemized"',
    '         noi = source_noi_yearly  (the actual NOI from the notes)',
    '      Do NOT emit noi_actual_yr or noi_override_active. The CRM\'s Operating Expenses table will show the gap under the "Estimated Expenses" category and NOI will fall out of EGI − Expenses naturally.',
    '    - Source has ONLY NOI (no gross income, no expense breakdown) → emit noi_actual_yr (and noi_proforma_yr if separate) AND noi_override_active = true. Do NOT emit `noi`.',
    '    - WORKED EXAMPLE A — gross + NOI, no line items: "Gross 321,120 / NOI 250,000" → est_gross_minus_noi_monthly = (321120 − 250000)/12 = 5926.67, expense_mode = "itemized", noi = 250000, gross_revenue_yearly = 321120.',
    '    - WORKED EXAMPLE B — gross + NOI + line items: "Gross $156,000, NOI $93,600, Property Taxes $15,700/yr, Water $1,000/yr" → gross_revenue_yearly=156000, noi=93600, property_tax_monthly=1308.33, water_sewer_monthly=83.33, est_gross_minus_noi_monthly = (156000 − 93600 − 15700 − 1000)/12 = 3808.33. Itemized + residual = 16700 + 45700 = 62400 = (156000 − 93600), so the displayed NOI stays $93,600. Do NOT skip est_gross_minus_noi_monthly when items are partial — that would inflate Total Expenses and depress reported NOI.',
    '19. PRICE LANGUAGE ROUTING (CRITICAL - read carefully, this is NOT standard English grammar):',
    '    The dollar amount IMMEDIATELY BEFORE a price phrase belongs to that phrase.',
    '    - PATTERN "$X wants to Net" -> X is the seller net target -> target_seller_net = X. If no separate "asking $Y" appears, ALSO set asking_price = X (seller net == seller asking when no other asking is given).',
    '    - PATTERN "$Y Pitch Out @ N Cap" or "$Y Pitch Out" -> Y is the dollar pitch -> pitch_out_price = Y. The cap N is descriptive only when a dollar pitch is given.',
    '    - PATTERN "Pitch Out @ N Cap" with NO preceding dollar -> IGNORE the cap. Default pitch_out_price = asking_price (or seller net target if no asking). Do NOT emit pitch_out_cap_target — the server no longer derives from cap rates.',
    '    - PATTERN unqualified "asking $X", "listed at $X", "price $X" -> asking_price = X. ALSO set pitch_out_price = X by default (the asking IS the pitch out until the agent enters a separate pitch).',
    '    - PATTERN email-template-derived price: when an "--- email_template_<id> ---" block contains a clear listed/asking price (e.g. "Asking price: $5,800,000", "Listed for $X", "Offered at $X"), set BOTH asking_price = X AND pitch_out_price = X by default. The agent\'s outbound template price IS the default pitch out.',
    '    - GRAMMAR WARNING: do NOT read "X wants to Net Y" as "X is the asking and Y is the net" — in these notes the structure means "X is the seller-net amount; Y is the dollar attached to whatever phrase follows". Always parse left-to-right with each dollar attaching to its IMMEDIATELY FOLLOWING price phrase, not preceding.',
    '    - WORKED EXAMPLE - "$1,800,000 wants to Net $1,925,000 Pitch Out @ 7 Cap" with NOI 135K -> target_seller_net=1800000, asking_price=1800000 (no other asking), pitch_out_price=1925000 (cap is descriptive only).',
    '    - WORKED EXAMPLE - "Asking $1.5M, wants to Net $1.4M, Pitch Out @ 7 Cap" -> asking_price=1500000, target_seller_net=1400000, pitch_out_price=1500000 (no dollar attached to Pitch Out, so default to the asking; cap is IGNORED, NEVER emit pitch_out_cap_target).',
    '    - WORKED EXAMPLE - "Asking $2M Pitch Out $2.2M" -> asking_price=2000000, pitch_out_price=2200000.',
    '    - WORKED EXAMPLE - email template body contains "Asking price: $5,800,000" and deal_notes have no Pitch Out clause -> asking_price=5800000, pitch_out_price=5800000.',
    '    - NEVER fill offer_price (Ace Starter) - it is always a manual entry.',
    '20. EXPLANATIONS (REQUIRED): For every field you put in "fields", also add a SHORT entry in "explanations" keyed by the same column name. Value is a <=160-char source quote or paraphrase that justifies the proposed value. Prefer the EXACT phrase from the context (in quotes) when one exists. For derived numbers (e.g. SF*PSF/12 monthly rent, cap-derived pitch-out, gross-NOI gap), say so concisely: e.g. "derived: (321120 − 250000)/12 = 5927". Do NOT invent justifications - if the only source signal is the number itself, quote the surrounding clause that contains it.',
    '21. EMAIL TEMPLATES (PRIORITY OVER NOTES): source blocks labeled "--- email_template_<id> ---" are saved marketing emails written by the agent for THIS property. Treat them as authoritative descriptive text — e.g. "15,500 SF mixed-use", "3 industrial tenants", "NNN lease", "ground floor retail with 4 apartments above". They often contain SF, tenant counts, lease type, asset classification, and condition signals that don\'t appear in deal_notes.\n    CONFLICT RESOLUTION: when an email template and the deal_notes / general_property_notes / property_description disagree on the SAME field (e.g. notes say 5,000 SF but template says 50,000 SF), prefer the email template value. The agent curated the template for outbound use — it\'s usually more accurate than inbox notes which may be paraphrased or outdated. Quote the email-template wording in the explanation when this conflict-resolution rule fires (e.g. "email template says 50,000 SF; deal_notes says 5,000 — preferring template per rule 21").',
    '22. OVERFLOW TEXT: When the source contains a sentence or phrase that adds context but does not match any structured field, capture it in other_industrial_notes (industrial deals) or other_unit_mix_notes (multifamily). Quote the source verbatim when short. Examples: "Owner uses 3 of the units personally and hasn\'t tried to rent them out" → owner_occupied=true AND other_industrial_notes captures the verbatim quote so the detail survives.',
    '',
    'FIELDS YOU MAY FILL (or mark N/A):',
    fieldList,
    '',
    'Respond with the JSON object only.',
  ]
  return lines.join('\n')
}

function coerce(value: unknown, type: string, col?: string) {
  if (value === null || value === undefined || value === '') return null
  switch (type) {
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.\-]/g, ''))
      return isFinite(n) ? (type === 'integer' ? Math.round(n) : n) : null
    }
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.\-]/g, ''))
      return isFinite(n) ? n : null
    }
    case 'capRate': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.\-]/g, ''))
      if (!isFinite(n)) return null
      return n > 1 ? n / 100 : n
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        const v = value.toLowerCase().trim()
        if (['true','yes','y'].includes(v)) return true
        if (['false','no','n'].includes(v)) return false
      }
      return null
    case 'date': {
      const s = String(value).trim()
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
    }
    case 'enum': {
      const s = String(value).trim()
      if (col && ENUM_OPTIONS[col]) {
        return ENUM_OPTIONS[col].includes(s) ? s : null
      }
      return s || null
    }
    case 'unitMix': {
      // v22/v24: byType and units coexist; alt-key tolerant; stubs filtered.
      // The LLM has been observed to emit alternative key names (name vs
      // label, monthly_rent vs rent, bedroom_type vs type) and to emit
      // nested rent objects {current,proforma}. We accept these variants
      // and normalize to the canonical shape. Stub units (empty label AND
      // no rent) are filtered out so they don't pollute the rent roll.
      let obj: any = value
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj) } catch { return null }
      }
      if (!obj || typeof obj !== 'object') return null
      const num = (v: unknown): number => {
        if (v === null || v === undefined || v === '') return 0
        if (typeof v === 'number') return isFinite(v) ? v : 0
        if (typeof v === 'object') {
          // Nested rent — try common shapes: {current, proforma}, {monthly},
          // {amount}. Fall back to first numeric value found.
          const o = v as any
          if (o.current != null) return num(o.current)
          if (o.monthly != null) return num(o.monthly)
          if (o.amount != null) return num(o.amount)
          for (const k of Object.keys(o)) {
            const x = num(o[k])
            if (x > 0) return x
          }
          return 0
        }
        const n = Number(String(v).replace(/[^\d.\-]/g, ''))
        return isFinite(n) ? n : 0
      }
      const byTypeIn = (obj.byType && typeof obj.byType === 'object') ? obj.byType : {}
      const byType = {
        eff: num(byTypeIn.eff ?? byTypeIn.efficiency ?? byTypeIn.studio),
        '1br': num(byTypeIn['1br'] ?? byTypeIn['1bedroom'] ?? byTypeIn['1 Bedroom']),
        '2br': num(byTypeIn['2br'] ?? byTypeIn['2bedroom'] ?? byTypeIn['2 Bedroom']),
        '3br': num(byTypeIn['3br'] ?? byTypeIn['3bedroom'] ?? byTypeIn['3 Bedroom']),
        '4br': num(byTypeIn['4br'] ?? byTypeIn['4bedroom'] ?? byTypeIn['4 Bedroom']),
        oth: num(byTypeIn.oth ?? byTypeIn.other ?? byTypeIn.Other),
      }
      const hasByType = Object.values(byType).some(v => Number(v) > 0)
      const allowedTypes = new Set(['Efficiency','1 Bedroom','2 Bedroom','3 Bedroom','4 Bedroom','Other'])
      const allowedStatus = new Set(['Occupied','Vacant','Owner-Occupied','Section 8'])
      // Normalize a free-form bedroom-type string into one of the allowed
      // values. Handles "2BR" / "2-bedroom" / "2 bed" / "studio" / "eff" / etc.
      const normalizeType = (raw: any): string => {
        if (typeof raw !== 'string') return '1 Bedroom'
        if (allowedTypes.has(raw)) return raw
        const s = raw.toLowerCase().trim()
        if (!s) return '1 Bedroom'
        if (/^(stu|eff)/.test(s)) return 'Efficiency'
        if (/^other/.test(s)) return 'Other'
        const m = s.match(/(\d)\s*(?:b|bed|br)/)
        if (m) {
          const n = Number(m[1])
          if (n === 0) return 'Efficiency'
          if (n >= 1 && n <= 4) return n + ' Bedroom'
        }
        return '1 Bedroom'
      }
      const normalizeStatus = (raw: any): string => {
        if (typeof raw !== 'string') return 'Occupied'
        if (allowedStatus.has(raw)) return raw
        const s = raw.toLowerCase().trim()
        if (s === 'vacant' || s === 'empty') return 'Vacant'
        if (s.includes('owner')) return 'Owner-Occupied'
        if (s.includes('section')) return 'Section 8'
        return 'Occupied'
      }
      const unitsIn = Array.isArray(obj.units) ? obj.units : []
      const units = unitsIn.map((u: any) => {
        if (!u || typeof u !== 'object') return null
        const labelRaw = u.label ?? u.name ?? u.unit ?? u.unit_label ?? u.apartment ?? ''
        const typeRaw = u.type ?? u.bedroom_type ?? u.unit_type ?? u.bedrooms ?? u.bed ?? u.bedroom_count
        const rentRaw = u.rent ?? u.monthly_rent ?? u.current_rent ?? u.rent_amount ?? u.monthly ?? u.rent_current
        const statusRaw = u.status ?? u.occupancy ?? u.state
        return {
          label: String(labelRaw || '').slice(0, 40),
          type: normalizeType(typeRaw),
          rent: num(rentRaw),
          status: normalizeStatus(statusRaw),
        }
      }).filter((u: any) => u !== null)
      // Drop stubs: units with empty label AND no rent are placeholders
      // the LLM emitted as filler. Keep units that have at least a label
      // OR a rent (a vacant unit might legitimately have rent=0 with a
      // status of "Vacant" — those are kept because the label is set).
      const cleanedUnits = units.filter((u: any) => {
        if (Number(u.rent) > 0) return true
        if (u.label && u.label.trim()) return true
        return false
      })
      const hasUnits = cleanedUnits.some((u: any) => Number(u.rent) > 0)
      if (!hasByType && !hasUnits) return null
      const mode = hasUnits ? 'byUnit' : 'byType'
      return JSON.stringify({ mode, byType, units: cleanedUnits })
    }
    case 'tenantMix': {
      let arr: any = value
      if (typeof arr === 'string') {
        try { arr = JSON.parse(arr) } catch { return null }
      }
      if (!Array.isArray(arr)) return null
      const num = (v: unknown) => {
        if (v === null || v === undefined || v === '') return null
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-]/g, ''))
        return isFinite(n) ? n : null
      }
      const bool = (v: unknown) => {
        if (typeof v === 'boolean') return v
        if (typeof v === 'string') {
          const s = v.toLowerCase().trim()
          if (['true','yes','y'].includes(s)) return true
          if (['false','no','n'].includes(s)) return false
        }
        return false
      }
      const datestr = (v: unknown) => {
        const s = String(v || '').trim()
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
      }
      const tenants = arr.map((t: any, i: number) => {
        if (!t || typeof t !== 'object') return null
        // v27: Tenant/Business name is REQUIRED but may be missing in source
        // (e.g. "3 retail tenants paying $X each" with no names). Fall back
        // to "Tenant N" so the row survives instead of getting dropped.
        let name = String(t['Tenant / Business Name'] || t.tenant || t.name || '').trim().slice(0, 200)
        if (!name) name = 'Tenant ' + (i + 1)
        const lease = String(t['Lease Type'] || '').trim()
        const out: Record<string, unknown> = {
          id: 'tm_' + Date.now() + '_' + i,
          'Tenant / Business Name': name,
        }
        if (t['Industry'])             out['Industry']           = String(t['Industry']).trim().slice(0, 100)
        if (t['Unit / Suite'])         out['Unit / Suite']       = String(t['Unit / Suite']).trim().slice(0, 50)
        const sf = num(t['Square Footage']);  if (sf !== null) out['Square Footage'] = sf
        const yu = num(t['Years in Unit']);   if (yu !== null) out['Years in Unit']  = yu
        let mr = num(t['Monthly Rent'])
        const psf = num(t['Rent Per SF (Annual)']); if (psf !== null) out['Rent Per SF (Annual)'] = psf
        if ((mr === null || mr === 0) && sf !== null && psf !== null && sf > 0 && psf > 0) {
          mr = Math.round((sf * psf) / 12)
        }
        if (mr !== null && mr !== 0) out['Monthly Rent'] = mr
        const cam = num(t['CAM Charges (Monthly)']); if (cam !== null) out['CAM Charges (Monthly)'] = cam
        if (lease && TENANT_LEASE_TYPES.has(lease)) out['Lease Type'] = lease
        const lt = num(t['Lease Term (Years)']); if (lt !== null) out['Lease Term (Years)'] = lt
        const yr = num(t['Years Remaining']);  if (yr !== null) out['Years Remaining'] = yr
        const ls = datestr(t['Lease Start Date']); if (ls) out['Lease Start Date'] = ls
        const le = datestr(t['Lease End Date']);   if (le) out['Lease End Date']   = le
        if (t['Options to Renew']) out['Options to Renew'] = String(t['Options to Renew']).trim().slice(0, 100)
        if (t['Annual Increases']) out['Annual Increases'] = String(t['Annual Increases']).trim().slice(0, 100)
        const dep = num(t['Security Deposit']); if (dep !== null) out['Security Deposit'] = dep
        const so = num(t['Sort Order']); if (so !== null) out['Sort Order'] = Math.round(so)
        out['First Right of Refusal'] = bool(t['First Right of Refusal'])
        out['Personal Guarantee']     = bool(t['Personal Guarantee'])
        if (t['Lease Document URL']) out['Lease Document URL'] = String(t['Lease Document URL']).trim().slice(0, 500)
        if (t['Tenant Notes'])       out['Tenant Notes']       = String(t['Tenant Notes']).trim().slice(0, 2000)
        return out
      }).filter(Boolean)
      if (!tenants.length) return null
      return JSON.stringify(tenants)
    }
    default:
      return String(value).trim() || null
  }
}

function tryRepairJson(s: string): string {
  let txt = s.trim()
  txt = txt.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim()
  const opens = (txt.match(/\{/g) || []).length
  const closes = (txt.match(/\}/g) || []).length
  const opensB = (txt.match(/\[/g) || []).length
  const closesB = (txt.match(/\]/g) || []).length
  const quoteCount = (txt.match(/(?<!\\)"/g) || []).length
  if (quoteCount % 2 === 1) txt += '"'
  txt = txt.replace(/,\s*$/, '')
  txt = txt + ']'.repeat(Math.max(0, opensB - closesB)) + '}'.repeat(Math.max(0, opens - closes))
  return txt
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json()
    const property_id: string | undefined = body.property_id
    const dry_run: boolean = body.dry_run !== false
    const only_fill_empty: boolean = body.only_fill_empty !== false
    const accept_na: string[] = Array.isArray(body.accept_na) ? body.accept_na : []
    const remove_na: string[] = Array.isArray(body.remove_na) ? body.remove_na : []

    const anthropic_key = Deno.env.get('ANTHROPIC_API_KEY')?.trim()
    if (!property_id) {
      return new Response(JSON.stringify({ error: 'property_id is required' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (!anthropic_key) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set as a Supabase Edge Function secret.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: row, error: rowErr } = await sb.from('ace_properties').select('*').eq('id', property_id).single()
    if (rowErr || !row) {
      return new Response(JSON.stringify({ error: 'property not found', details: rowErr?.message }),
        { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    let templates: Array<{ id: string, name: string, subject: string, body: string }> = []
    try {
      const { data: tplRows } = await sb.from('ace_user_email_templates')
        .select('id, name, subject, body')
        .eq('property_id', property_id)
        .limit(20)
      if (Array.isArray(tplRows)) {
        templates = tplRows.map((t: any) => ({
          id: String(t.id),
          name: String(t.name || ''),
          subject: String(t.subject || ''),
          body: String(t.body || ''),
        })).filter(t => t.body && t.body.trim().length > 0)
      }
    } catch (_e) { /* non-fatal: continue without templates */ }

    const fieldSpecCols = new Set(FIELD_SPEC.map(f => f.col))
    const currentNaRaw = (row as any).na_fields
    const currentNa: string[] = Array.isArray(currentNaRaw)
      ? currentNaRaw.filter((s: any) => typeof s === 'string' && fieldSpecCols.has(s))
      : (typeof currentNaRaw === 'string' ? (() => { try { const a = JSON.parse(currentNaRaw); return Array.isArray(a) ? a.filter((s:any) => typeof s === 'string' && fieldSpecCols.has(s)) : [] } catch { return [] } })() : [])

    const noteCols = ['property_description','deal_notes','general_property_notes','ai_clarifying_notes',
      'location_description','financial_property_notes','asking_price_explanation',
      'ace_starter_note','accepted_by_seller_note','pitch_out_note','ace_chat_summary',
      'other_industrial_notes','other_unit_mix_notes']
    const noteBlocks = noteCols.map(c => {
      const v = (row as any)[c]
      if (!v || !String(v).trim()) return ''
      return '--- ' + c + ' ---\n' + String(v).trim()
    }).filter(Boolean)

    const tplBlocks = templates.map(t => {
      const header = '--- email_template_' + t.id + ' (' + (t.name || t.subject || 'Untitled') + ') ---'
      const sub    = t.subject ? 'Subject: ' + t.subject + '\n' : ''
      return header + '\n' + sub + t.body.trim()
    })
    const contextText = noteBlocks.concat(tplBlocks).join('\n\n')

    if (!contextText.trim()) {
      const all_fields_empty = FIELD_SPEC.map(f => ({
        col: f.col, group: f.group, hint: f.hint,
        current: (row as any)[f.col] ?? null, proposed: null, na: currentNa.includes(f.col),
        explanation: null,
      }))
      return new Response(JSON.stringify({
        ok: true, dry_run, proposed_changes: {}, na_proposals: [], current_na_fields: currentNa,
        all_fields: all_fields_empty,
        uncertain_fields: [{ field: '*', reason: 'no notes/description on the property to extract from' }],
        applied: 0, raw_ai: '', prompt_chars: 0, response_chars: 0, source_breakdown: {},
      }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const prompt = buildPrompt({ address: (row as any).address || '', contextText, currentValues: row as Record<string, unknown>, currentNa, onlyFillEmpty: only_fill_empty })

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropic_key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!claudeResp.ok) {
      const errText = await claudeResp.text()
      return new Response(JSON.stringify({ error: 'Claude ' + claudeResp.status + ': ' + errText.slice(0,400) }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const claudeData = await claudeResp.json()
    const stopReason = claudeData.stop_reason || ''
    const rawText = (claudeData.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim()
    let parsed: { fields?: Record<string, unknown>, explanations?: Record<string, string>, na?: Array<{field:string, reason:string}>, uncertain?: Array<{field:string, reason:string}> } = {}
    let parseError = ''
    try { parsed = JSON.parse(rawText) }
    catch (e) {
      parseError = String(e)
      try { parsed = JSON.parse(tryRepairJson(rawText)) }
      catch (e2) {
        return new Response(JSON.stringify({
          error: 'Claude returned non-JSON', stop_reason: stopReason, parse_error: parseError,
          raw_ai_head: rawText.slice(0,800), raw_ai_tail: rawText.slice(-800), response_chars: rawText.length,
        }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    const proposedRaw = parsed.fields || {}
    const explanationsRaw: Record<string, string> = (parsed.explanations && typeof parsed.explanations === 'object') ? parsed.explanations : {}
    const naRaw = Array.isArray(parsed.na) ? parsed.na : []
    const uncertain = Array.isArray(parsed.uncertain) ? parsed.uncertain : []

    const cleanExplanation = (col: string): string | null => {
      const v = explanationsRaw[col]
      if (v == null) return null
      const s = String(v).trim().replace(/\s+/g, ' ').slice(0, 240)
      return s || null
    }

    const proposed_changes: Record<string, { current: unknown, proposed: unknown, explanation: string | null }> = {}
    for (const f of FIELD_SPEC) {
      if (currentNa.includes(f.col)) continue
      if (TRANSIENT_COLS.has(f.col)) continue
      const propV = coerce(proposedRaw[f.col], f.type, f.col)
      if (propV === null || propV === undefined) continue
      const cur = (row as any)[f.col]
      const isEmpty = cur === null || cur === undefined || cur === '' || (typeof cur === 'number' && cur === 0 && f.type !== 'capRate')
      if (only_fill_empty && !isEmpty) continue
      if (ASSET_CLASS_COLS.has(f.col) && cur && typeof cur === 'string' && typeof propV === 'string') {
        const curStr = String(cur).trim()
        const propStr = String(propV).trim()
        if (curStr.includes(':') && !propStr.includes(':')) {
          const curTop = curStr.split(':')[0].trim()
          if (curTop === propStr) continue
        }
      }
      proposed_changes[f.col] = { current: cur ?? null, proposed: propV, explanation: cleanExplanation(f.col) }
    }

    if (!proposed_changes.pitch_out_price) {
      const askProp = proposed_changes.asking_price?.proposed
      const askRow = (row as any).asking_price
      const ask = Number(askProp || askRow || 0)
      if (ask > 0) {
        const cur = (row as any).pitch_out_price
        const isEmpty = cur === null || cur === undefined || cur === '' || (typeof cur === 'number' && cur === 0)
        if (!only_fill_empty || isEmpty) {
          proposed_changes.pitch_out_price = {
            current: cur ?? null,
            proposed: ask,
            explanation: 'defaulted to asking price (no separate Pitch Out dollar in source)',
          }
        }
      }
    }

    if (proposed_changes.expense_mode) {
      const mode = proposed_changes.expense_mode.proposed
      if (mode === 'itemized') {
        delete proposed_changes.actual_expense_ratio_pct
        delete proposed_changes.pro_forma_expense_ratio_pct
      } else if (mode === 'ratio') {
        for (const k of Object.keys(proposed_changes)) {
          if (k.endsWith('_monthly') && FIELD_SPEC.find(f => f.col === k && f.group === 'Expense Details')) {
            delete proposed_changes[k]
          }
        }
      }
    }

    // v21/v28: server-side guard ensures total expenses = (Gross − NOI)
    // exactly, so the displayed NOI matches the source no matter how many
    // (or how few) line items the LLM extracts. Two branches:
    //   (a) gross + NOI + zero itemized → est_gross_minus_noi_monthly =
    //       (Gross − NOI) / 12. Drop any noi_override path.
    //   (b) gross + NOI + partial itemized → est_gross_minus_noi_monthly is
    //       the residual: (Gross − NOI − sum_itemized_yearly) / 12.
    //       This is the v28 fix for the user-reported bug where a partial
    //       itemized list (e.g. Property Tax $15,700) was double-counted on
    //       top of (Gross − NOI), depressing reported NOI.
    const propGross = Number(proposed_changes.gross_revenue_yearly?.proposed ?? (row as any).gross_revenue_yearly ?? 0)
    const propNoi   = Number(proposed_changes.noi?.proposed ?? proposed_changes.noi_actual_yr?.proposed ?? (row as any).noi ?? 0)
    // Sum every itemized monthly expense column proposed-or-current.
    // Excludes income side (gross/other/rubs) and the residual bucket itself.
    const ITEMIZED_MONTHLY_COLS = [
      'property_tax_monthly','other_tax_monthly','insurance_monthly','liability_insurance_monthly',
      'electric_monthly','gas_monthly','water_sewer_monthly','trash_monthly','other_utilities_monthly',
      'janitorial_monthly','landscaping_monthly','maintenance_repair_monthly','maintenance_salary_monthly',
      'pool_monthly','supplies_monthly','admin_expenses_monthly','accounting_monthly','legal_monthly',
      'other_admin_monthly','misc_expenses_monthly','other_misc_monthly','property_mgmt_fee_monthly',
      'other_mgmt_monthly','capital_reserve_monthly',
    ]
    let sumItemizedYearly = 0
    let countItemizedFilled = 0
    for (const col of ITEMIZED_MONTHLY_COLS) {
      const v = Number(proposed_changes[col]?.proposed ?? (row as any)[col] ?? 0)
      if (v > 0) { sumItemizedYearly += v * 12; countItemizedFilled++ }
    }
    // expenses_yearly (rare aggregate column) also counts as itemized.
    const expensesYearly = Number(proposed_changes.expenses_yearly?.proposed ?? (row as any).expenses_yearly ?? 0)
    if (expensesYearly > 0) sumItemizedYearly = Math.max(sumItemizedYearly, expensesYearly)
    const hasItemizedExp = countItemizedFilled > 0 || expensesYearly > 0

    if (propGross > 0 && propNoi > 0 && propGross > propNoi) {
      const totalGap = propGross - propNoi
      const residualYearly = Math.max(0, totalGap - sumItemizedYearly)
      // If itemized already equals (Gross − NOI) within $1, drop the residual.
      const dropResidual = Math.abs(totalGap - sumItemizedYearly) < 1
      const computedMonthly = Math.round((residualYearly / 12) * 100) / 100

      if (dropResidual) {
        // Itemized total already balances — remove any LLM-proposed residual
        // so it doesn't double-count.
        if (proposed_changes.est_gross_minus_noi_monthly) delete proposed_changes.est_gross_minus_noi_monthly
      } else {
        const explanation = hasItemizedExp
          ? 'residual: (' + propGross.toLocaleString() + ' − ' + propNoi.toLocaleString() + ' − ' + Math.round(sumItemizedYearly).toLocaleString() + ' itemized) / 12 = ' + computedMonthly.toLocaleString()
          : 'derived: (' + propGross.toLocaleString() + ' − ' + propNoi.toLocaleString() + ') / 12 = ' + computedMonthly.toLocaleString()
        proposed_changes.est_gross_minus_noi_monthly = {
          current: (row as any).est_gross_minus_noi_monthly ?? null,
          proposed: computedMonthly,
          explanation,
        }
      }

      // No-itemized branch also strips the override path.
      if (!hasItemizedExp) {
        if (proposed_changes.noi_actual_yr) delete proposed_changes.noi_actual_yr
        if (proposed_changes.noi_proforma_yr) delete proposed_changes.noi_proforma_yr
        if (proposed_changes.noi_override_active && proposed_changes.noi_override_active.proposed === true) delete proposed_changes.noi_override_active
      }
      // Promote noi (the source's actual NOI) to be present.
      if (!proposed_changes.noi) {
        proposed_changes.noi = {
          current: (row as any).noi ?? null,
          proposed: propNoi,
          explanation: hasItemizedExp ? 'source NOI — itemized + residual reconciled' : 'source NOI — expenses derived from gross-NOI gap',
        }
      }
      // Force expense_mode to itemized.
      if (!proposed_changes.expense_mode) {
        proposed_changes.expense_mode = {
          current: (row as any).expense_mode ?? null,
          proposed: 'itemized',
          explanation: hasItemizedExp ? 'itemized line items + residual gap' : 'itemized via Estimated Expenses (gross-NOI gap)',
        }
      }
    }

    if (proposed_changes.noi && proposed_changes.noi_actual_yr) {
      delete proposed_changes.noi
    }
    if ((proposed_changes.noi_actual_yr || proposed_changes.noi_proforma_yr) && !proposed_changes.noi_override_active) {
      const cur = (row as any).noi_override_active
      if (!cur) proposed_changes.noi_override_active = {
        current: cur ?? null,
        proposed: true,
        explanation: 'auto: NOI override is active because noi_actual_yr / noi_proforma_yr was filled',
      }
    }

    const na_proposals: Array<{col:string, reason:string}> = []
    const seenNaProp = new Set<string>()
    for (const item of naRaw) {
      const col = (item && typeof item === 'object') ? (item as any).field : null
      if (typeof col !== 'string') continue
      if (!fieldSpecCols.has(col)) continue
      if (currentNa.includes(col)) continue
      if (proposed_changes[col]) continue
      if (seenNaProp.has(col)) continue
      seenNaProp.add(col)
      na_proposals.push({ col, reason: String((item as any).reason || '').slice(0, 200) })
    }

    const all_fields = FIELD_SPEC.map(f => ({
      col: f.col, group: f.group, hint: f.hint,
      current: (row as any)[f.col] ?? null,
      proposed: proposed_changes[f.col]?.proposed ?? null,
      explanation: proposed_changes[f.col]?.explanation ?? null,
      na: currentNa.includes(f.col),
      na_proposed: seenNaProp.has(f.col),
      na_reason: na_proposals.find(p => p.col === f.col)?.reason || null,
    }))

    const source_breakdown: Record<string, string> = {}
    for (const c of noteCols) {
      const v = (row as any)[c]
      if (v && String(v).trim()) source_breakdown[c] = String(v)
    }
    for (const t of templates) {
      const key = 'email_template_' + t.id
      const label = t.name || t.subject || 'Untitled template'
      const body = (t.subject ? 'Subject: ' + t.subject + '\n\n' : '') + t.body
      source_breakdown[key] = '[' + label + ']\n' + body
    }

    let applied = 0
    if (!dry_run) {
      const update: Record<string, unknown> = {}
      let hasUpdate = false
      if (Object.keys(proposed_changes).length) {
        update.ai_parsed_at = new Date().toISOString()
        for (const [col, diff] of Object.entries(proposed_changes)) update[col] = diff.proposed
        applied = Object.keys(proposed_changes).length
        hasUpdate = true
      }
      if (accept_na.length || remove_na.length) {
        const next = new Set(currentNa)
        for (const c of accept_na) if (fieldSpecCols.has(c)) next.add(c)
        for (const c of remove_na) next.delete(c)
        update.na_fields = Array.from(next)
        hasUpdate = true
      }
      if (uncertain.length) {
        const summary = uncertain.map(u => '• ' + u.field + ': ' + u.reason).join('\n')
        const existing = (row as any).ai_clarifying_notes || ''
        update.ai_clarifying_notes = (existing ? existing + '\n\n' : '')
          + '--- AI uncertain (' + new Date().toISOString().slice(0,10) + ') ---\n' + summary
        hasUpdate = true
      }
      if (hasUpdate) {
        const { error: upErr } = await sb.from('ace_properties').update(update).eq('id', property_id)
        if (upErr) {
          return new Response(JSON.stringify({ error: 'Update failed: ' + upErr.message, proposed_changes, na_proposals, uncertain_fields: uncertain }),
            { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true, dry_run, applied,
      proposed_changes, na_proposals, current_na_fields: currentNa, all_fields,
      uncertain_fields: uncertain, stop_reason: stopReason,
      source_breakdown,
      template_count: templates.length,
      raw_ai: rawText.slice(0, 4000), prompt_chars: prompt.length, response_chars: rawText.length,
    }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), stack: (err as Error).stack }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
