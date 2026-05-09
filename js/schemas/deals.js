// schemas/deals.js — ace_properties ↔ Airtable-style label map.
// Single source of truth for the deal column → display-label mapping.
// Currently duplicated in the legacy <script> in index.html (line ~1019); the
// duplicate will be deleted once every consumer imports from this module.

export const SB_PROP_MAP = {
  id:'id', address:'Address', pipeline_stage:'Pipeline Stage',
  deal_tag:'Deal Tag', review_tag:'Review Tag', crm_asset_classification:'CRM Asset Classification',
  property_type_text:'Simple Text Property Type',
  legacy_property_type:'Legacy Property Type (Backup)',
  simple_county:'Simple County', region:'Region for County',
  state:'State', needs_county_review:'Needs County Review',
  next_steps:'Next Steps', deal_notes:'Deal Notes',
  general_property_notes:'General Property Notes',
  financial_property_notes:'Financial Property Notes',
  property_highlights:'Property Highlights',
  top_priority:'Top Priority', is_archived:'Is Archived',
  property_details_mode:'Property Details Mode',
  financial_analysis_mode:'Financial Analysis Mode',
  discuss_in_meeting:'Discuss in Meeting',
  date_added:'Date Added', snooze_until_date:'Snooze Until Date',
  is_snoozed:'Is Snoozed',
  asking_price:'Asking Price', asking_price_explanation:'Asking Price Explanation',
  // v169: 'priced' (default) | 'no_asking' | 'make_offer' — when seller
  // doesn't post a number, UI shows the chosen label instead of "$—".
  asking_price_status:'Asking Price Status',
  offer_price:'Offer Price', pitch_out_price:'Pitch Out Price',
  // v111.8: per-card description fields on the Offers tab. `asking_price_explanation`
  // is reused for the "Seller Original Asking" card (same field the seller-lead
  // intake form writes). The other three are new TEXT columns added for Offers.
  ace_starter_note:'Ace Starter Note',
  accepted_by_seller_note:'Accepted By Seller Note',
  pitch_out_note:'Pitch Out Note',
  gross_revenue_monthly:'Gross Revenue Monthly',
  gross_revenue_yearly:'Gross Revenue Yearly',
  expenses_yearly:'Expenses Yearly', expenses_monthly:'Expenses Monthly',
  noi:'NOI', cap_rate_crm:'Cap Rate (CRM)',
  cap_rate_proforma_crm:'Cap Rate Proforma (CRM)',
  annual_debt_service:'Annual Debt Service', dscr_manual:'DSCR (Manual)',
  gross_rental_income_monthly:'Gross Rental Income (Monthly)',
  vacancy_rate_pct:'Vacancy Rate (%)', other_income_monthly:'Other Income (Monthly)',
  rubs_cam_income_monthly:'RUBS/CAM Income (Monthly)',
  pro_forma_gross_revenue_monthly:'Pro Forma Gross Revenue Monthly',
  pro_forma_gross_revenue_yearly:'Pro Forma Gross Revenue Yearly',
  pro_forma_expenses_monthly:'Pro Forma Expenses Monthly',
  pro_forma_expenses_yearly:'Pro Forma Expenses Yearly',
  pro_forma_expense_ratio_pct:'Pro Forma Expense Ratio %',
  actual_expense_ratio_pct:'Actual Expense Ratio %',
  expense_mode:'Expense Mode',
  proforma_gross_rent_monthly:'Proforma Gross Rent (Monthly)',
  proforma_other_income_monthly:'Proforma Other Income (Monthly)',
  proforma_rubs_cam_monthly:'Proforma RUBS/CAM (Monthly)',
  proforma_vacancy_rate_pct:'Vacancy Rate Proforma (%)',
  janitorial_monthly:'Janitorial (Monthly)',
  landscaping_monthly:'Landscaping (Monthly)',
  maintenance_repair_monthly:'Maintenance & Repair Costs (Monthly)',
  maintenance_salary_monthly:'Maintenance & Repair Salary (Monthly)',
  pool_monthly:'Pool (Monthly)', supplies_monthly:'Supplies (Monthly)',
  electric_monthly:'Electric (Monthly)', gas_monthly:'Gas (Monthly)',
  water_sewer_monthly:'Water & Sewer (Monthly)', trash_monthly:'Trash (Monthly)',
  misc_expenses_monthly:'Miscellaneous Expenses (Monthly)',
  property_tax_monthly:'Property Tax (Monthly)', insurance_monthly:'Insurance (Monthly)',
  property_mgmt_fee_monthly:'Property Management Fee (Monthly)',
  capital_reserve_monthly:'Capital Reserve (Monthly)',
  admin_expenses_monthly:'Admin Expenses (Monthly)',
  // v102.4: new expense sub-category columns so every Financial Analysis input persists
  accounting_monthly:'Accounting (Monthly)',
  legal_monthly:'Legal (Monthly)',
  other_admin_monthly:'Other Admin (Monthly)',
  other_utilities_monthly:'Other Utilities (Monthly)',
  other_misc_monthly:'Other Misc (Monthly)',
  other_tax_monthly:'Other Tax (Monthly)',
  liability_insurance_monthly:'Liability Insurance (Monthly)',
  other_mgmt_monthly:'Other Mgmt (Monthly)',
  // v102.4: JSONB column for pro forma expense per-line values
  pro_forma_expense_breakdown:'Pro Forma Expense Breakdown',
  // v102.6: Final localStorage → Supabase migration. These 6 fields used to
  // only live in the fin_${dealId} localStorage blob, which meant teammates
  // couldn't see each other's updates. Now persisted to dedicated columns.
  non_revenue_units_pct:'Non-Revenue Units (%)',
  proforma_non_revenue_units_pct:'Proforma Non-Revenue Units (%)',
  gri_source:'GRI Source',
  down_payment_type:'Down Payment Type',
  proforma_down_payment_pct:'Proforma Down Payment (%)',
  proforma_down_payment_type:'Proforma Down Payment Type',
  // v102.8: Lot Size Unit radio toggle persistence (sf / acres)
  lot_size_unit:'Lot Size Unit',
  // v102.8: Total Lot Size — latent bug, input had no DB column or collect path
  total_lot_size:'Total Lot Size',
  // v102.9: lead intake asset-type-specific fields
  automotive_gas_type:'Automotive Gas Type',
  automotive_wash_type:'Automotive Wash Type',
  retail_lease_type:'Retail Lease Type',
  shopping_lease_type:'Shopping Lease Type',
  mortgage1_loan_type:'Mortgage 1 Loan Type', mortgage1_principal:'Mortgage 1 Principal Balance',
  mortgage1_amortization_yrs:'Mortgage 1 Amortization (Years)',
  mortgage1_interest_rate_pct:'Mortgage 1 Interest Rate (%)',
  mortgage1_assumable:'Mortgage 1 Assumable', mortgage1_years_remaining:'Mortgage 1 Years Remaining',
  mortgage2_loan_type:'Mortgage 2 Loan Type', mortgage2_principal:'Mortgage 2 Principal Balance',
  mortgage2_amortization_yrs:'Mortgage 2 Amortization (Years)',
  mortgage2_interest_rate_pct:'Mortgage 2 Interest Rate (%)',
  mortgage2_assumable:'Mortgage 2 Assumable', mortgage2_years_remaining:'Mortgage 2 Years Remaining',
  mortgage3_loan_type:'Mortgage 3 Loan Type', mortgage3_principal:'Mortgage 3 Principal Balance',
  mortgage3_amortization_yrs:'Mortgage 3 Amortization (Years)',
  mortgage3_interest_rate_pct:'Mortgage 3 Interest Rate (%)',
  mortgage3_assumable:'Mortgage 3 Assumable', mortgage3_years_remaining:'Mortgage 3 Years Remaining',
  square_footage:'Square Footage', number_of_units:'Number of Units',
  net_rentable_sf:'Net Rentable SF', total_building_sf:'Total Building SF',
  no_of_units:'No. of Units', no_of_buildings:'No. of Buildings',
  occupancy_pct:'Occupancy (%)', year_built:'Year Built',
  year_renovated:'Year Renovated', no_of_stories:'No. of Stories',
  no_of_parking_spaces:'No. of Parking Spaces', parking_ratio:'Parking Ratio',
  property_class:'Property Class', property_condition:'Property Condition',
  location_class:'Location Class', location_trending:'Location Trending',
  location_type:'Location Type', construction_status:'Construction Status',
  property_use:'Property Use', hvac:'HVAC', roof_type:'Roof Type',
  parking_type:'Parking Type', foundation:'Foundation', exterior:'Exterior',
  piping:'Piping', wiring:'Wiring', floor_covering:'Floor Covering', paving:'Paving',
  construction_type:'Construction Type',
  est_gross_minus_noi_monthly:'Est Gross Minus NOI (Monthly)',
  down_payment_pct:'Down Payment (%)', renovation_expense:'Renovation Expense',
  // v191: Pitch Out scenario (middle column on Financial Analysis Purchase
  // Price section). Same shape as the actual + proforma down-payment pair —
  // separate renovation budget + DP type/value so the buyer-facing Pitch Out
  // CoC can be modeled independently from asking-price and proforma scenarios.
  pitch_out_renovation_expense:'Pitch Out Renovation Expense',
  pitch_out_down_payment_type:'Pitch Out Down Payment Type',
  pitch_out_down_payment_pct:'Pitch Out Down Payment (%)',
  unit_mix_text:'Unit Mix', mf_unit_rent_data:'MF Unit Rent Data', tenant_mix_data:'Tenant Mix Data',
  noi_actual_yr:'NOI Actual Yr', noi_proforma_yr:'NOI Proforma Yr', noi_override_active:'NOI Override Active',
  target_seller_net:'Target Seller Net',
  units_efficiency:'Units Efficiency', units_efficiency_vacant:'Units Efficiency Vacant',
  units_1br:'Units 1 Bedroom', units_1br_vacant:'Units 1 Bedroom Vacant',
  units_2br:'Units 2 Bedroom', units_2br_vacant:'Units 2 Bedroom Vacant',
  units_3br:'Units 3 Bedroom', units_3br_vacant:'Units 3 Bedroom Vacant',
  units_4br:'Units 4 Bedroom', units_4br_vacant:'Units 4 Bedroom Vacant',
  units_other:'Units Other', units_other_vacant:'Units Other Vacant',
  seller_motivation_level:'Seller Motivation Level',
  seller_financial_strength:'Seller Financial Strength',
  mortgage_payments_status:'Mortgage Payments Status', why_selling:'Why Selling',
  owner_occupied:'Owner Occupied', no_financials_yet:'No Financials Yet',
  fully_vacant:'Fully Vacant', is_distressed:'Is Distressed',
  is_on_ground_lease:'Is On Ground Lease', sale_leaseback:'Sale Leaseback',
  latitude:'Latitude', longitude:'Longitude',
  property_description:'Property Description', location_description:'Location Description',
  pro_forma_breakdown:'Pro Forma Breakdown in Words',
  ace_chat_summary:'Ace Chat Text Summary', email_template_in_fub:'Email Template', email_subject_in_fub:'Email Subject', main_photo_attachment_id:'Main Photo',
  photo_attachments:'PHOTO',
  property_name:'Property Name', complex_name:'Complex Name', municipality:'Municipality',
  x_price_per_foot:'What is the price at X Price per foot',
  x_cap_rate_pct:'What is price at X Cap Rate?',
  // v102.18: removed `created_at:'Date Added'` duplicate mapping. It was
  // a latent bug — _atToSb's reverse map only keeps one entry per Airtable
  // label, so writes to 'Date Added' were targeting the auto-managed
  // created_at column instead of the nullable date_added column. The
  // loader at line ~1917 now explicitly falls back: deal['Date Added']
  // = row.date_added || row.created_at.
  fub_assigned_to:'Assigned Agent',
  ai_clarifying_notes:'AI Clarifying Notes',
  ai_parsed_at:'AI Parsed At',
  ai_autofill_log:'AI Autofill Log',
  na_fields:'NA Fields',
  // v113.70: Industrial-specific columns
  num_tenants:'Num Tenants', office_sf:'Office SF', warehouse_sf:'Warehouse SF',
  office_sf_pct:'Office SF Pct', num_loading_docks:'Num Loading Docks',
  num_drive_ins:'Num Drive Ins', ceiling_height_ft:'Ceiling Height Ft',
  other_industrial_notes:'Other Industrial Notes',
  other_unit_mix_notes:'Other Unit Mix Notes',
  // v113.76: NOI override
  noi_actual_yr:'NOI Actual Yr', noi_proforma_yr:'NOI Proforma Yr',
  noi_override_active:'NOI Override Active',
  import_source:'Import Source',
  // v102.28: portfolio grouping — nullable FK, zero default means "standalone".
  // portfolio_sort_order controls display order within a portfolio's detail view.
  portfolio_id:'Portfolio ID',
  portfolio_sort_order:'Portfolio Sort Order'
};
