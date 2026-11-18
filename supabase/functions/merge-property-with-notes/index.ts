// merge-property-with-notes v2 — merge a shadow/duplicate property into a
// surviving property, applying the user-confirmed conflict policy.
//
// v2 (2026-04-25): Corrected pipeline_stage rule. The only throwaway stage
// is 'Clean Up'. All other stages (Nurture, Lead, Attempted Contact, GHL,
// Closed, Closed 2025, Hot Active Listing, etc.) are real CRM
// classifications and must be preserved on the survivor.
//
//   • Text curated fields (address, property_name, deal_tag, next_steps, ...):
//       same         → keep survivor
//       survivor null → take loser's value
//       conflict     → keep survivor, append loser's value to deal_notes
//   • deal_notes / general_property_notes / other notes: concatenate
//   • pipeline_stage:
//       survivor in any non-'Clean Up' stage → keep survivor (preserve real stage)
//       survivor 'Clean Up' AND loser non-'Clean Up' → take loser's stage (promote)
//       both 'Clean Up' → leave as 'Clean Up'
//   • Boolean fields: survivor wins (no override)
//   • Numeric / other fields:
//       survivor null → take loser's value
//       conflict     → keep survivor, append note to general_property_notes
//   • Agents: implicit UNION via ace_agent_pipeline_deals (handled by
//     merge_properties RPC repointing deal_id, dedup'd on (pipeline_id, deal_id))
//
// Flow:
//   1. Load survivor + losers (ace_properties.*)
//   2. Compute resolved field values per policy
//   3. (unless dry_run) UPDATE survivor with non-curated diffs
//   4. (unless dry_run) Invoke merge_properties RPC with p_field_values='{}'
//   5. (unless dry_run) PATCH ace_property_merge_log.surviving_before to the
//                       pre-step-3 snapshot, so undo_merge() restores correctly

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

// The throwaway/staging stage. Any other stage value is a real CRM
// classification and is preserved on merge.
const THROWAWAY_STAGE = 'Clean Up'

// Text fields that should NOT receive merged-in content from the loser
// directly — conflicts get noted in deal_notes instead. (Survivor's value
// is the canonical one once merged.)
const TEXT_CURATED_FIELDS = new Set<string>([
  'address', 'property_name', 'deal_tag', 'next_steps',
  'crm_asset_classification', 'fub_assigned_to', 'airtable_id',
  'property_type_text', 'legacy_property_type', 'simple_county',
  'region', 'asking_price_explanation', 'is_property_listed',
  'mortgage1_loan_type', 'mortgage2_loan_type', 'mortgage3_loan_type',
  'parking_ratio', 'property_class', 'property_condition',
  'location_class', 'location_trending', 'location_type',
  'construction_status', 'property_use', 'hvac', 'roof_type',
  'parking_type', 'foundation', 'exterior', 'piping', 'wiring',
  'floor_covering', 'paving', 'unit_mix_text', 'mf_unit_rent_data',
  'seller_motivation_level', 'seller_financial_strength',
  'mortgage_payments_status', 'why_selling', 'email_template_in_fub',
  'main_photo_attachment_id', 'complex_name', 'municipality',
  'address_raw', 'property_details_mode', 'financial_analysis_mode',
  'pitch_out_markup_type', 'import_source', 'gri_source',
  'down_payment_type', 'proforma_down_payment_type', 'lot_size_unit',
  'automotive_gas_type', 'automotive_wash_type', 'retail_lease_type',
  'shopping_lease_type', 'expense_mode', 'email_subject_in_fub',
])

// Notes columns: concatenate, never "conflict".
const NOTES_FIELDS = new Set<string>([
  'deal_notes', 'general_property_notes', 'financial_property_notes',
  'pro_forma_breakdown', 'ace_chat_summary', 'property_description',
  'location_description', 'ai_clarifying_notes', 'ace_starter_note',
  'accepted_by_seller_note', 'pitch_out_note',
])

// Survivor wins on these — never overridden.
const BOOLEAN_FIELDS = new Set<string>([
  'top_priority', 'is_archived', 'discuss_in_meeting', 'is_snoozed',
  'mortgage1_assumable', 'mortgage2_assumable', 'mortgage3_assumable',
  'owner_occupied', 'no_financials_yet', 'fully_vacant',
  'is_distressed', 'is_on_ground_lease', 'sale_leaseback',
  'needs_county_review',
])

// pipeline_stage handled separately. These are auto-managed or identifiers
// — never merged from loser.
const SKIP_FIELDS = new Set<string>([
  'id', 'created_at', 'updated_at', 'deleted_at',
  'pipeline_stage',           // special: only Clean Up is throwaway
  'deal_notes',                // appended to via conflict notes
  'general_property_notes',    // appended to via field-conflict notes
  'photo_attachments',         // jsonb — surviving wins; loser's photos lost
  'pro_forma_expense_breakdown',
  'seller_type',               // ARRAY — survivor wins for now (no UNION)
  'portfolio_id', 'portfolio_sort_order',
  'accepted_offer_id',         // FK to deal-specific offer
  'ai_parsed_at',
])

function resolveFields(survivor: Record<string, any>, losers: Record<string, any>[]) {
  const resolved: Record<string, any> = {}
  const dealNoteLines: string[] = []
  const generalNoteLines: string[] = []

  // 1. pipeline_stage — only Clean Up is throwaway.
  const sStage: string | null = survivor.pipeline_stage
  const sIsThrowaway = sStage == null || sStage === THROWAWAY_STAGE
  if (sIsThrowaway) {
    // Promote to first loser stage that is NOT Clean Up.
    const realFromLoser = losers.find(l => l.pipeline_stage && l.pipeline_stage !== THROWAWAY_STAGE)
    if (realFromLoser) {
      resolved.pipeline_stage = realFromLoser.pipeline_stage
    }
    // else: every row is Clean Up — leave survivor as-is.
  }
  // else: survivor already has a real stage — preserve it.

  // 2. Walk every column on the survivor row.
  for (const col of Object.keys(survivor)) {
    if (SKIP_FIELDS.has(col)) continue
    if (BOOLEAN_FIELDS.has(col)) continue   // survivor wins

    const sVal = resolved[col] !== undefined ? resolved[col] : survivor[col]

    for (const loser of losers) {
      const lVal = loser[col]
      if (lVal === null || lVal === undefined) continue

      if (sVal === null || sVal === undefined) {
        // Survivor is empty → take loser's value (first non-null wins).
        resolved[col] = lVal
        break
      }

      if (deepEqual(sVal, lVal)) continue

      // Conflict
      if (TEXT_CURATED_FIELDS.has(col)) {
        dealNoteLines.push(`${col}: "${truncate(String(lVal), 240)}" (from ${shortId(loser.id)})`)
      } else {
        generalNoteLines.push(`${col}=${truncate(String(lVal), 240)} (from ${shortId(loser.id)})`)
      }
    }
  }

  // 3. Notes columns: concatenate
  for (const col of NOTES_FIELDS) {
    const survivorNote: string = (survivor[col] ?? '').toString()
    const loserNotes: string[] = []
    for (const loser of losers) {
      const lVal: string = (loser[col] ?? '').toString()
      if (!lVal.trim()) continue
      if (lVal.trim() === survivorNote.trim()) continue
      if (survivorNote.includes(lVal.trim())) continue
      loserNotes.push(`--- merged from ${shortId(loser.id)} ---\n${lVal.trim()}`)
    }
    if (loserNotes.length > 0) {
      const merged = [survivorNote.trim(), ...loserNotes].filter(Boolean).join('\n\n')
      resolved[col] = merged
    }
  }

  // 4. Append conflict-tracking notes
  if (dealNoteLines.length > 0) {
    const existing = (resolved.deal_notes ?? survivor.deal_notes ?? '').toString().trim()
    const block = `--- merge conflicts (kept survivor) ---\n${dealNoteLines.join('\n')}`
    resolved.deal_notes = existing ? `${existing}\n\n${block}` : block
  }
  if (generalNoteLines.length > 0) {
    const existing = (resolved.general_property_notes ?? survivor.general_property_notes ?? '').toString().trim()
    const block = `--- merge field overrides (kept survivor) ---\n${generalNoteLines.join('\n')}`
    resolved.general_property_notes = existing ? `${existing}\n\n${block}` : block
  }

  return { resolved, dealNoteLines, generalNoteLines }
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}
function shortId(id: string): string { return String(id).slice(0, 8) }
function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) + '…' }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }),
      { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    let body: any
    try { body = await req.json() } catch (_) {
      return new Response(JSON.stringify({ error: 'Body must be JSON' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const surviving_id: string | undefined = body.surviving_id
    const loser_ids: string[] | undefined = body.loser_ids
    const dry_run: boolean = body.dry_run !== false   // default TRUE for safety
    const user_id: string | null = body.user_id || null
    const parent_contact_merge_id: string | null = body.parent_contact_merge_id || null

    if (!surviving_id || !loser_ids || !Array.isArray(loser_ids) || loser_ids.length === 0) {
      return new Response(JSON.stringify({
        error: 'Required: { surviving_id: uuid, loser_ids: uuid[] }'
      }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (loser_ids.includes(surviving_id)) {
      return new Response(JSON.stringify({ error: 'surviving_id cannot also be in loser_ids' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // 1. Load survivor + losers
    const allIds = [surviving_id, ...loser_ids]
    const { data: rows, error: loadErr } = await sb.from('ace_properties')
      .select('*').in('id', allIds).is('deleted_at', null)
    if (loadErr) {
      return new Response(JSON.stringify({ error: 'Failed to load properties', details: loadErr }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const survivor = (rows || []).find((r: any) => r.id === surviving_id)
    const losers   = (rows || []).filter((r: any) => loser_ids.includes(r.id))
    if (!survivor) {
      return new Response(JSON.stringify({ error: `Survivor ${surviving_id} not found or already deleted` }),
        { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (losers.length !== loser_ids.length) {
      const found = new Set(losers.map((l: any) => l.id))
      const missing = loser_ids.filter(id => !found.has(id))
      return new Response(JSON.stringify({
        error: 'One or more losers not found or already deleted', missing
      }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // 2. Compute resolved field values
    const { resolved, dealNoteLines, generalNoteLines } = resolveFields(survivor, losers)
    const changedKeys = Object.keys(resolved)

    if (dry_run) {
      return new Response(JSON.stringify({
        dry_run: true,
        surviving_id,
        loser_ids,
        survivor_address: survivor.address,
        loser_addresses: losers.map((l: any) => l.address),
        resolved_field_changes: changedKeys.reduce((acc: Record<string, any>, k) => {
          acc[k] = { from: survivor[k], to: resolved[k] }
          return acc
        }, {}),
        deal_notes_appended: dealNoteLines,
        general_property_notes_appended: generalNoteLines,
        agent_union_note: 'agents are unioned implicitly via ace_agent_pipeline_deals repoint',
      }, null, 2), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // 3. UPDATE survivor with resolved field changes
    if (changedKeys.length > 0) {
      const { error: updErr } = await sb.from('ace_properties')
        .update(resolved).eq('id', surviving_id)
      if (updErr) {
        return new Response(JSON.stringify({
          error: 'Failed to update survivor with resolved fields',
          details: updErr,
        }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    // 4. Invoke merge_properties RPC
    const { data: mergeResult, error: mergeErr } = await sb.rpc('merge_properties', {
      p_surviving_id: surviving_id,
      p_loser_ids: loser_ids,
      p_field_values: {},
      p_user_id: user_id,
      p_parent_contact_merge_id: parent_contact_merge_id,
    })
    if (mergeErr) {
      const restorePatch: Record<string, any> = {}
      for (const k of changedKeys) restorePatch[k] = survivor[k]
      if (changedKeys.length > 0) {
        await sb.from('ace_properties').update(restorePatch).eq('id', surviving_id)
      }
      return new Response(JSON.stringify({
        error: 'merge_properties RPC failed (survivor changes rolled back)',
        details: mergeErr,
      }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const merge_log_id: string | null = (mergeResult as any)?.merge_log_id ?? null

    // 5. PATCH the merge log so undo restores to the true pre-merge state.
    if (merge_log_id) {
      const { data: postRow } = await sb.from('ace_properties')
        .select('*').eq('id', surviving_id).single()
      await sb.from('ace_property_merge_log').update({
        surviving_before: survivor,
        surviving_after: postRow ?? null,
      }).eq('id', merge_log_id)
    }

    return new Response(JSON.stringify({
      ok: true,
      dry_run: false,
      surviving_id,
      loser_ids,
      merge_log_id,
      fk_repointed_count: (mergeResult as any)?.fk_repointed_count ?? 0,
      losers_archived:    (mergeResult as any)?.losers_archived ?? loser_ids.length,
      resolved_field_changes_count: changedKeys.length,
      deal_notes_appended_count: dealNoteLines.length,
      general_property_notes_appended_count: generalNoteLines.length,
      undo_hint: merge_log_id ? `SELECT undo_merge('${merge_log_id}'::uuid, '${user_id}'::uuid);` : null,
    }, null, 2), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), stack: (err as Error).stack }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
