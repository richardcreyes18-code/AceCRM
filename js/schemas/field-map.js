// schemas/field-map.js — bidirectional Supabase row ↔ Airtable-style field
// mapping helpers. Used by every feature that round-trips DB rows through
// the legacy display-key shape (deal['Address'], buyer['Phone Number'], etc.).
//
// Currently inlined as private copies in workbench/portfolios modules and
// declared in legacy at index.html ~line 1363. Phase 4.5 makes this module
// the single source of truth.

// Convert a Supabase row → Airtable-style display-key object using the
// snake_case → 'Display Label' map (e.g. SB_PROP_MAP, SB_BC_MAP).
// Skips null/undefined values so downstream code that does
// `out['Some Field'] === undefined` still works for unset columns.
export function _sbToAt(row, map) {
  const out = {};
  for (const [sbCol, atField] of Object.entries(map)) {
    if (row[sbCol] !== undefined && row[sbCol] !== null) out[atField] = row[sbCol];
  }
  return out;
}

// Convert Airtable-style fields → Supabase column object (for PATCH/POST).
// `id` is filtered out (PostgREST rejects updates to it). Empty strings
// become null (Supabase int/bool columns reject ""). undefined values are
// skipped entirely; null and false and 0 pass through.
export function _atToSb(fields, map) {
  const rev = Object.fromEntries(Object.entries(map).map(([k,v])=>[v,k]));
  const out = {};
  for (const [atField, val] of Object.entries(fields)) {
    const sbCol = rev[atField];
    if (!sbCol || sbCol === 'id') continue;
    if (val === undefined) continue;
    if (val === '') out[sbCol] = null;
    else out[sbCol] = val;
  }
  return out;
}
