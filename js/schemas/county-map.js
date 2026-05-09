// schemas/county-map.js — county/state/region lookups + canonicalization.
//
// 11 exports: 6 constants (NJ_NORTH_COUNTIES, NJ_CENTRAL_COUNTIES,
// NJ_SOUTH_COUNTIES, PIPELINE_COUNTY_TO_STATE, PIPELINE_BAD_COUNTY_NAMES,
// PIPELINE_REGION_CHIPS) + 5 functions (_countyState, _countyRegions,
// _isBadCountyName, _canonicalCounty, _canonicalCountyCSV).
//
// External dependency: window._appLists (the canonical curated lists,
// declared in app-lists / admin module — still in legacy at this point).
// _canonicalCounty reads .counties off it. _appLists is a `let` in legacy
// so it must be addressed via window.*; alternative is a `var` conversion
// later when app-lists migrates.

// NJ county → region mapping. Standard NJ regional split used by brokers.
export const NJ_NORTH_COUNTIES    = ['Bergen','Passaic','Essex','Hudson','Union','Morris','Sussex','Warren','Hunterdon'];
export const NJ_CENTRAL_COUNTIES  = ['Middlesex','Somerset','Mercer','Monmouth','Ocean'];
export const NJ_SOUTH_COUNTIES    = ['Burlington','Camden','Gloucester','Salem','Cumberland','Atlantic','Cape May'];

// ═══════════════════════════════════════════════════════════════
//  PIPELINE STATE / REGION LOOKUP (Phase A — frontend-only)
// ═══════════════════════════════════════════════════════════════
// Maps county names (as they appear in ace_properties.simple_county) to state
// abbreviations. Used by the Pipeline filter UI so admins can filter by state
// and by NJ region without requiring a dedicated state column in the database.
//
// Ambiguous counties (same name in multiple states) are resolved per Ricky's
// explicit instruction to the most common state in Ace's dataset:
//   Essex County      → NJ  (not NY, MA, VT)
//   Middlesex County  → NJ  (not MA, CT)
//   Montgomery County → PA  (not NY, MD, AL, TX)
// Phase B will replace this frontend lookup with a real state column
// backfilled from parsed addresses, which will catch cases where an
// "Essex County" deal actually turns out to be in NY.
//
// Counties not in this map are treated as "Other" state in the filter.
// Each county appears EXACTLY ONCE to avoid JS object duplicate-key bugs.
export const PIPELINE_COUNTY_TO_STATE = {
  // NJ — 21 counties. Essex/Middlesex locked to NJ per Ricky.
  'Atlantic County':'NJ','Bergen County':'NJ','Burlington County':'NJ',
  'Camden County':'NJ','Cape May County':'NJ','Cumberland County':'NJ',
  'Essex County':'NJ','Gloucester County':'NJ','Hudson County':'NJ',
  'Hunterdon County':'NJ','Mercer County':'NJ','Middlesex County':'NJ',
  'Monmouth County':'NJ','Morris County':'NJ','Ocean County':'NJ',
  'Passaic County':'NJ','Salem County':'NJ','Somerset County':'NJ',
  'Sussex County':'NJ','Union County':'NJ','Warren County':'NJ',

  // NY — counties in Ace's dataset
  'New York County':'NY','Kings County':'NY','Queens County':'NY',
  'Bronx County':'NY','Richmond County':'NY','Nassau County':'NY',
  'Suffolk County':'NY','Westchester County':'NY','Rockland County':'NY',
  'Dutchess County':'NY','Ulster County':'NY','Albany County':'NY',
  'Rensselaer County':'NY','Broome County':'NY','Chemung County':'NY',
  'Chenango County':'NY','Oneida County':'NY','Oswego County':'NY',
  'Cayuga County':'NY','Tompkins County':'NY','Niagara County':'NY',
  'Otsego County':'NY','Allegany County':'NY','Madison County':'NY',
  // Orange County is ambiguous (NY vs CA vs FL). Keeping as NY — Ricky's
  // dataset has 9 "Orange County" rows and his work is NE-focused.
  'Orange County':'NY',

  // PA — Montgomery locked to PA per Ricky.
  'Philadelphia County':'PA','Allegheny County':'PA','Montgomery County':'PA',
  'Bucks County':'PA','Chester County':'PA','Delaware County':'PA',
  'Lancaster County':'PA','Lehigh County':'PA','Northampton County':'PA',
  'Berks County':'PA','York County':'PA','Dauphin County':'PA',
  'Luzerne County':'PA','Lackawanna County':'PA','Pike County':'PA',
  'Schuylkill County':'PA','Beaver County':'PA','Armstrong County':'PA',
  'Cambria County':'PA','Lawrence County':'PA','Montour County':'PA',

  // CT — traditional counties plus post-2022 planning regions
  'Fairfield County':'CT','Hartford County':'CT','New Haven County':'CT',
  'New London County':'CT','Litchfield County':'CT','Tolland County':'CT',
  'Windham County':'CT',
  'Capitol Planning Region':'CT',
  'Lower Connecticut River Valley Planning Region':'CT',
  'South Central Connecticut Planning Region':'CT',
  'Western Connecticut Planning Region':'CT',

  // FL
  'Miami-Dade County':'FL','Broward County':'FL','Palm Beach County':'FL',
  'Hillsborough County':'FL','Pinellas County':'FL','Duval County':'FL',
  'Lee County':'FL','Collier County':'FL','Sarasota County':'FL',
  'Brevard County':'FL','Volusia County':'FL','Polk County':'FL',
  'Alachua County':'FL','Seminole County':'FL','Osceola County':'FL',
  'Pasco County':'FL','Manatee County':'FL','Marion County':'FL',
  'Indian River County':'FL','Okaloosa County':'FL',

  // TX
  'Harris County':'TX','Dallas County':'TX','Tarrant County':'TX',
  'Bexar County':'TX','Travis County':'TX','Collin County':'TX',
  'Denton County':'TX','Fort Bend County':'TX','Williamson County':'TX',
  'Galveston County':'TX','McLennan County':'TX',

  // CA
  'Los Angeles County':'CA','San Diego County':'CA','Riverside County':'CA',
  'San Bernardino County':'CA','Santa Clara County':'CA','Alameda County':'CA',
  'Sacramento County':'CA','Contra Costa County':'CA','Fresno County':'CA',
  'Kern County':'CA','San Francisco County':'CA','Ventura County':'CA',
  'San Mateo County':'CA','San Joaquin County':'CA','Stanislaus County':'CA',
  'Sonoma County':'CA','Tulare County':'CA','Solano County':'CA',
  'Madera County':'CA',
};

// Known-bad county values that get a yellow ⚠ badge in Pipeline view.
// Phase B will persist this as a `needs_county_review` column in the DB.
// Deals with these county values need manual review or cleanup.
export const PIPELINE_BAD_COUNTY_NAMES = new Set([
  '',                          // empty / missing
  'Mounmouth County',          // typo — should be Monmouth
  'Monmouth',                  // missing "County" suffix
  'N County', 'E County', 'Of County',  // junk parser output
  // International / non-US admin divisions that slipped into the field
  'City of Onkaparinga','Greater London','Giessen','Glasgow City',
  'Kawartha Lakes','Parry Sound District','Hastings County',
]);

// Preferred regions in display order for the Pipeline filter chip bar.
// `kind` tells applyPipelineFilters() how to match:
//   'state'  → any county whose state === value
//   'region' → any county whose NJ region array includes value
//   'states' → any county whose state is in the value array
export const PIPELINE_REGION_CHIPS = [
  { id: 'all_nj',     label: 'All NJ',     kind: 'state',  value: 'NJ'        },
  { id: 'north_nj',   label: 'North NJ',   kind: 'region', value: 'North NJ'  },
  { id: 'central_nj', label: 'Central NJ', kind: 'region', value: 'Central NJ'},
  { id: 'south_nj',   label: 'South NJ',   kind: 'region', value: 'South NJ'  },
  { id: 'tri_state',  label: 'Tri-State',  kind: 'states', value: ['NJ','NY','PA'] },
];

// Resolve a county name to its state. Returns '' (empty) for unknown counties.
// PHASE B: if a deal object is passed as a second arg and has a 'State' field
// from the database, that takes priority over the hardcoded county map.
export function _countyState(county, deal){
  // Phase B preference: use the DB-populated state column if available
  if(deal && deal['State']) return deal['State'];
  if(!county) return '';
  return PIPELINE_COUNTY_TO_STATE[county] || '';
}

// Resolve a county name to its NJ region(s). Returns an ARRAY because some
// counties appear in multiple regions:
//   Ocean → [Central NJ, South NJ]    (per Ricky)
//   Hunterdon → [North NJ, Central NJ] (per Ricky)
// All other NJ counties return a single-element array; non-NJ returns [].
export function _countyRegions(county){
  if(!county) return [];
  const bare = county.replace(/\s+County$/i, '');
  const regions = [];
  if(NJ_NORTH_COUNTIES.includes(bare))   regions.push('North NJ');
  if(NJ_CENTRAL_COUNTIES.includes(bare)) regions.push('Central NJ');
  if(NJ_SOUTH_COUNTIES.includes(bare))   regions.push('South NJ');
  // Ocean County is already in Central via NJ_CENTRAL_COUNTIES. Add South.
  if(bare === 'Ocean' && !regions.includes('South NJ')) regions.push('South NJ');
  // Hunterdon is already in North via NJ_NORTH_COUNTIES. Add Central.
  if(bare === 'Hunterdon' && !regions.includes('Central NJ')) regions.push('Central NJ');
  return regions;
}

// True if this county name looks wrong/junk and should be flagged for review.
// PHASE B: if a deal object is passed and has the DB-backed needs_county_review
// flag set, that takes priority over the hardcoded set.
export function _isBadCountyName(county, deal){
  if(deal && deal['Needs County Review'] === true) return true;
  return PIPELINE_BAD_COUNTY_NAMES.has(county || '');
}

// v113.27: maps any county input to the canonical entry in
// window._appLists.counties. Used both at write-time (so new deals get clean
// names) and by the migration tool that fixes existing dirty data.
//
// Match strategy (each step short-circuits on first hit):
//   1. exact match in canonical list
//   2. case-insensitive exact match
//   3. strip " County" / " Co." suffix from input, then case-insensitive match
//      against canonical list (also stripped of suffix for comparison)
//
// If no match, returns the input trimmed (caller can decide what to do).
// Returns '' for empty/whitespace input.
//
// Examples (with canonical list ['Monmouth','Ocean','Hunterdon']):
//   _canonicalCounty('Monmouth')        → 'Monmouth'
//   _canonicalCounty('monmouth')        → 'Monmouth'
//   _canonicalCounty('Monmouth County') → 'Monmouth'
//   _canonicalCounty('MONMOUTH CO.')    → 'Monmouth'
//   _canonicalCounty('  ocean  ')       → 'Ocean'
//   _canonicalCounty('Random Place')    → 'Random Place'  (unchanged)
//   _canonicalCounty('')                → ''
export function _canonicalCounty(input){
  const raw = String(input || '').trim();
  if(!raw) return '';
  const list = (window._appLists && window._appLists.counties) ? window._appLists.counties : [];
  // 1. exact match
  if(list.indexOf(raw) >= 0) return raw;
  // 2. case-insensitive exact match
  const lc = raw.toLowerCase();
  for(const c of list){
    if(c.toLowerCase() === lc) return c;
  }
  // 3. suffix-stripped match. " County" or " Co." (case-insensitive)
  const stripSuffix = (s) => String(s||'').replace(/\s+(?:county|co\.)\s*$/i, '').trim();
  const rawStripped = stripSuffix(raw).toLowerCase();
  if(rawStripped){
    for(const c of list){
      if(stripSuffix(c).toLowerCase() === rawStripped) return c;
    }
  }
  // No canonical match — return input as-is (trimmed) so we don't clobber
  // legitimately new county names that haven't been added to App Lists yet.
  return raw;
}

// v113.27: normalize a CSV string of counties (used for buyer_criteria's
// preferred_counties / simple_area_preference columns). Returns null when
// the result is empty so we don't write empty strings.
export function _canonicalCountyCSV(csv){
  if(!csv) return null;
  const parts = String(csv).split(',').map(s => _canonicalCounty(s)).filter(Boolean);
  // Dedupe while preserving order
  const seen = new Set();
  const unique = [];
  for(const p of parts){
    if(!seen.has(p)){ seen.add(p); unique.push(p); }
  }
  return unique.length ? unique.join(', ') : null;
}
