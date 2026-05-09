// bc-bulk-stats — Phase 1 of the BC AI bulk-fill plan.
//
// Returns counts so we know what we're working with before kicking off
// the bulk dry-run sweep:
//   - total_contacts
//   - buyer_tagged_contacts          (fub_tags contains "Buyer")
//   - buyer_tagged_with_bc           (have at least one ace_buyer_criteria row)
//   - buyer_tagged_without_bc        (need a blank BC row backfilled)
//   - bc_total                       (total active BC rows)
//   - bc_with_any_field_filled       (rough "has data" proxy)
//   - bc_completely_empty            (would benefit most from AI fill)
//
// Read-only. Service key only used for table access. Authenticated calls
// only — anon JWT is rejected.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('PROJECT_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || ''

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  })
}

async function sbCount(path: string): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'HEAD',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  })
  const range = r.headers.get('content-range') || ''
  const m = range.match(/\/(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

async function sbFetch(path: string): Promise<unknown[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
  })
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResp({ ok: false, error: 'Service key / URL not configured' }, 500)
    }

    // Total contacts (active = not soft-deleted)
    const total_contacts = await sbCount('ace_contacts?deleted_at=is.null')

    // Buyer-tagged: contacts whose fub_tags array contains "Buyer".
    // PostgREST array-contains operator is `cs` for jsonb / `cs.{val}` for
    // text[]. fub_tags is text[].
    const buyer_tagged_contacts = await sbCount(
      'ace_contacts?deleted_at=is.null&fub_tags=cs.{Buyer}',
    )

    // BCs total (active)
    const bc_total = await sbCount('ace_buyer_criteria?deleted_at=is.null')

    // Reverse join: pull all BC contact IDs (capped at ~610), then check
    // which of THOSE contacts are buyer-tagged. Avoids the PostgREST
    // 1000-row default limit that bites when paginating 5.9k buyer rows.
    const bcRows = (await sbFetch(
      `ace_buyer_criteria?deleted_at=is.null&select=contact_id&limit=10000`,
    )) as Array<{ contact_id: string }>
    const bcContactIds = Array.from(new Set(bcRows.map(r => r.contact_id).filter(Boolean)))

    let buyer_tagged_with_bc = 0
    if (bcContactIds.length) {
      const CHUNK = 200
      for (let i = 0; i < bcContactIds.length; i += CHUNK) {
        const slice = bcContactIds.slice(i, i + CHUNK)
        const inList = slice.map(id => `"${id}"`).join(',')
        // Count how many of these BC-bearing contacts are buyer-tagged.
        const c = await sbCount(
          `ace_contacts?deleted_at=is.null&fub_tags=cs.{Buyer}&id=in.(${inList})`,
        )
        buyer_tagged_with_bc += c
      }
    }
    const buyer_tagged_without_bc = buyer_tagged_contacts - buyer_tagged_with_bc

    // Rough "completely empty BC" count — contacts whose only BC has
    // every important field empty. Cheap proxy: desired_property_types
    // is null/empty AND mf_min_units is null AND other_requirements is
    // null. Not perfect but good enough for Phase 1.
    const bc_completely_empty = await sbCount(
      'ace_buyer_criteria?deleted_at=is.null&desired_property_types=is.null&mf_min_units=is.null&other_requirements=is.null',
    )
    const bc_with_any_field_filled = bc_total - bc_completely_empty

    // Sample of buyer-tagged contacts without a BC, for sanity-checking.
    let sample_no_bc: Array<{ id: string; name: string | null; tags: string[] | null }> = []
    if (buyer_tagged_without_bc > 0) {
      const candidates = (await sbFetch(
        'ace_contacts?deleted_at=is.null&fub_tags=cs.{Buyer}&select=id,name,fub_tags&limit=300',
      )) as Array<{ id: string; name: string | null; fub_tags: string[] | null }>
      const withBcSet = new Set(bcContactIds)
      sample_no_bc = candidates
        .filter(c => !withBcSet.has(c.id))
        .slice(0, 10)
        .map(c => ({ id: c.id, name: c.name, tags: c.fub_tags }))
    }

    return jsonResp({
      ok: true,
      generated_at: new Date().toISOString(),
      counts: {
        total_contacts,
        buyer_tagged_contacts,
        buyer_tagged_with_bc,
        buyer_tagged_without_bc,
        bc_total,
        bc_with_any_field_filled,
        bc_completely_empty,
      },
      sample_no_bc,
    })
  } catch (e) {
    return jsonResp({ ok: false, error: String((e as Error)?.message || e) }, 500)
  }
})
