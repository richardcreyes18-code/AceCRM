// bc-bulk-sandbox — sandbox bulk-test for the BC AI auto-fill loop.
//
// Picks N (default 15) buyer-criteria records stratified across the
// Haiku / Sonnet routing spectrum, runs each through the existing
// /functions/v1/ai-parse-buyer-criteria endpoint with dry_run=true,
// and aggregates the proposals into a single report. ZERO database
// writes anywhere in this flow.
//
// Per-BC report includes:
//   - source_chars / note_count   (so we see why each got Haiku or Sonnet)
//   - bc_filled_field_count       (how rich the BC was before the run)
//   - bc_total_field_count
//   - bc_fill_density_pct         (filled / total)
//   - proposed_count              (would change a value)
//   - confirmed_count             (AI agreed with current value)
//   - na_count                    (proposed clearing a stale value)
//   - uncertain_count
//   - would_override_count        (proposals that would replace a non-null BEFORE value)
//
// The "would_override_count" is the safety check: on a rich BC it
// should be near zero (most proposals should be either confirms or
// fills-empty). Any spike there is a flag to investigate before
// running real bulk apply.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('PROJECT_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || ''
// Function gateway requires a JWT-format key; the new "sb_..." service-
// role keys aren't JWTs. Use the anon JWT for fn-to-fn calls instead;
// the AI function does its own service-role DB auth via env.
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') || ''

// Same caps + thresholds the AI fn uses (mirrored for source-text length).
const CAP_CONTACT_NOTES = 4000
const CAP_NOTE_BODY     = 800
const LIMIT_ACE_NOTES   = 50
const LIMIT_FUB_NOTES   = 30
const LIMIT_FUB_CALLS   = 30
const SOURCE_THRESHOLD  = 1800
const NOTE_THRESHOLD    = 6

// Metadata cols on ace_buyer_criteria that should NOT count toward
// "filled field" density (they're system-managed).
const META_COLS = new Set([
  'id', 'contact_id', 'created_at', 'updated_at', 'deleted_at',
  'date_added', 'fub_assigned_to', 'ai_autofill_log',
  'last_ai_autofill_at', 'field_status', 'review_status',
  'review_status_updated_at', 'review_status_set_by',
  'merged_into', 'import_source',
])

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'content-type': 'application/json' },
  })
}

async function sbFetch(path: string): Promise<unknown[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
  })
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

function capText(s: unknown, max: number): string {
  if (s == null) return ''
  const str = String(s)
  return str.length > max ? str.slice(0, max) : str
}

// Mirrors ai-parse-buyer-criteria source-text assembly + note-counting.
function measureBuyer(args: {
  contact: Record<string, unknown> | null
  aceNotes: Array<{ body?: string | null; created_at?: string | null }>
  fubCalls: Array<{ note?: string | null; created_at?: string | null }>
  fubNotes: Array<{ body?: string | null; created_at?: string | null }>
}): { source_chars: number; note_count: number } {
  const { contact, aceNotes, fubCalls, fubNotes } = args
  const sourceParts: string[] = []
  if (contact) {
    const lines = [
      `Contact: ${(contact.name as string) || '(no name)'}`,
      contact.email ? `Email: ${contact.email}` : '',
      contact.phone_number ? `Phone: ${contact.phone_number}` : '',
      contact.company ? `Company: ${contact.company}` : '',
      contact.contact_notes ? `\nContact notes:\n${capText(contact.contact_notes, CAP_CONTACT_NOTES)}` : '',
    ].filter(Boolean)
    sourceParts.push('--- CONTACT ---\n' + lines.join('\n'))
  }
  const aceNon = aceNotes.filter(n => n.body && String(n.body).trim()).slice(0, LIMIT_ACE_NOTES)
  if (aceNon.length) sourceParts.push('--- ACE CONTACT NOTES (newest first) ---\n' + aceNon
    .map(n => `[note @ ${n.created_at || ''}] ${capText(n.body, CAP_NOTE_BODY)}`).join('\n\n'))
  const callsNon = fubCalls.filter(c => c.note && String(c.note).trim()).slice(0, LIMIT_FUB_CALLS)
  if (callsNon.length) sourceParts.push('--- FUB CALL NOTES (newest first) ---\n' + callsNon
    .map(c => `[call @ ${c.created_at || ''}] ${capText(c.note, CAP_NOTE_BODY)}`).join('\n\n'))
  const notesNon = fubNotes.filter(n => n.body && String(n.body).trim()).slice(0, LIMIT_FUB_NOTES)
  if (notesNon.length) sourceParts.push('--- FUB NOTES (newest first) ---\n' + notesNon
    .map(n => `[note @ ${n.created_at || ''}] ${capText(n.body, CAP_NOTE_BODY)}`).join('\n\n'))
  return {
    source_chars: sourceParts.join('\n\n').length,
    note_count:   aceNon.length + callsNon.length + notesNon.length,
  }
}

function countFilled(bc: Record<string, unknown>): { filled: number; total: number } {
  let filled = 0, total = 0
  for (const [k, v] of Object.entries(bc)) {
    if (META_COLS.has(k)) continue
    total++
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (typeof v === 'object' && Array.isArray(v) && v.length === 0) continue
    filled++
  }
  return { filled, total }
}

async function runAiOnBuyer(bcId: string, gatewayAuth: string, gatewayApikey: string): Promise<Record<string, unknown>> {
  // Retry-with-backoff for Anthropic 429s (org rate limit ~30k input
  // tokens/min). Backoff is jittered: 4s, 9s, 18s — total worst-case
  // ~31s of waits across 3 retries, fits under the 150s function
  // timeout when combined with bounded concurrency.
  const RETRY_DELAYS_MS = [4000, 9000, 18000]
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/ai-parse-buyer-criteria`, {
      method: 'POST',
      headers: {
        apikey: gatewayApikey,
        Authorization: gatewayAuth,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        buyer_criteria_id: bcId,
        dry_run:           true,
        only_fill_empty:   false,
        model:             'auto',
      }),
    })
    const raw = await r.text()
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (_) {
      return { ok: false, error: `HTTP ${r.status} non-JSON: ${raw.slice(0, 240)}` }
    }
    const errStr = String(parsed.error || '')
    const isRateLimit = /429|rate_limit_error|rate limit/i.test(errStr) || /429|rate_limit_error|rate limit/i.test(raw.slice(0, 240))
    if (parsed.ok || !isRateLimit || attempt >= RETRY_DELAYS_MS.length) {
      if (!parsed.ok && !parsed.error) parsed.error = `HTTP ${r.status}: ${raw.slice(0, 240)}`
      return parsed
    }
    const base = RETRY_DELAYS_MS[attempt]
    const jitter = Math.floor(Math.random() * 1500)
    await new Promise(res => setTimeout(res, base + jitter))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResp({ ok: false, error: 'Service key / URL not configured' }, 500)
    }

    // Forward the caller's gateway auth to fn-to-fn calls. The function
    // gateway requires a JWT and the SUPABASE_ANON_KEY env secret isn't
    // necessarily one (newer "sb_..." formats aren't JWTs). Whoever
    // invoked us already sent a valid JWT, so reuse it.
    const gatewayAuth   = req.headers.get('authorization') || ''
    const gatewayApikey = req.headers.get('apikey') || ''
    if (!gatewayAuth || !gatewayApikey) {
      return jsonResp({ ok: false, error: 'authorization + apikey headers required' }, 401)
    }

    let sample_size = 15
    let concurrency = 3
    let excludeBcIds = new Set<string>()
    try {
      const b = await req.json().catch(() => ({}))
      if (b && typeof b.sample_size === 'number' && b.sample_size > 0) {
        sample_size = Math.min(b.sample_size, 50)
      }
      if (b && typeof b.concurrency === 'number' && b.concurrency > 0) {
        concurrency = Math.min(b.concurrency, 15)
      }
      if (b && Array.isArray(b.exclude_bc_ids)) {
        excludeBcIds = new Set(b.exclude_bc_ids.map((s: unknown) => String(s)))
      }
    } catch (_) { /* GET/no body */ }

    const t0 = Date.now()

    // --- 1. Pull all BCs whose contact is buyer-tagged. We need:
    //   - bc.id, contact_id, all BC fields (for fill-density)
    //   - contact name + tags + notes pointers
    // Strategy: pull buyer-tagged contacts → join with their BCs.
    const buyerContacts = (await sbFetch(
      `ace_contacts?deleted_at=is.null&fub_tags=cs.{Buyer}&select=id,name,email,phone_number,company,contact_notes,fub_contact_id,fub_tags&order=id.asc&limit=10000`,
    )) as Array<{
      id: string; name: string | null; email: string | null;
      phone_number: string | null; company: string | null;
      contact_notes: string | null; fub_contact_id: string | null;
      fub_tags: string[] | null;
    }>
    const contactById = new Map(buyerContacts.map(c => [c.id, c]))
    const buyerContactIds = buyerContacts.map(c => c.id)

    // Pull all BCs for these contacts. Use chunked IN-queries.
    const allBcs: Array<Record<string, unknown>> = []
    const CHUNK = 200
    for (let i = 0; i < buyerContactIds.length; i += CHUNK) {
      const slice = buyerContactIds.slice(i, i + CHUNK)
      const inList = slice.map(id => `"${id}"`).join(',')
      const rows = (await sbFetch(
        `ace_buyer_criteria?deleted_at=is.null&contact_id=in.(${inList})&select=*`,
      )) as Array<Record<string, unknown>>
      allBcs.push(...rows)
    }

    // --- 2. Pull notes for these contacts (chunked) so we can compute
    // source_chars per buyer to stratify the sample.
    const aceNotesBy = new Map<string, Array<{ body?: string | null; created_at?: string | null }>>()
    const fubCallsBy = new Map<string, Array<{ note?: string | null; created_at?: string | null }>>()
    const fubNotesBy = new Map<string, Array<{ body?: string | null; created_at?: string | null }>>()
    for (let i = 0; i < buyerContacts.length; i += 100) {
      const slice = buyerContacts.slice(i, i + 100)
      const sliceContactIds = slice.map(c => c.id)
      const slicePersonIds  = slice.map(c => c.fub_contact_id).filter((x): x is string => !!x)
      const inContact = sliceContactIds.map(id => `"${id}"`).join(',')
      const inPerson  = slicePersonIds.map(id => `"${id}"`).join(',')
      const [a, c, n] = await Promise.all([
        inContact ? sbFetch(
          `ace_contact_notes?contact_id=in.(${inContact})&select=contact_id,body,created_at&order=created_at.desc&limit=5000`,
        ) : Promise.resolve([]),
        inPerson ? sbFetch(
          `fub_calls?person_id=in.(${inPerson})&select=person_id,note,created_at&order=created_at.desc&limit=5000`,
        ) : Promise.resolve([]),
        inPerson ? sbFetch(
          `fub_notes?person_id=in.(${inPerson})&select=person_id,body,created_at&order=created_at.desc&limit=5000`,
        ) : Promise.resolve([]),
      ]) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>]
      for (const row of a) {
        const k = String(row.contact_id || ''); if (!k) continue
        const arr = aceNotesBy.get(k) || []; if (arr.length < LIMIT_ACE_NOTES) arr.push({ body: row.body as string, created_at: row.created_at as string })
        aceNotesBy.set(k, arr)
      }
      for (const row of c) {
        const k = String(row.person_id || ''); if (!k) continue
        const arr = fubCallsBy.get(k) || []; if (arr.length < LIMIT_FUB_CALLS) arr.push({ note: row.note as string, created_at: row.created_at as string })
        fubCallsBy.set(k, arr)
      }
      for (const row of n) {
        const k = String(row.person_id || ''); if (!k) continue
        const arr = fubNotesBy.get(k) || []; if (arr.length < LIMIT_FUB_NOTES) arr.push({ body: row.body as string, created_at: row.created_at as string })
        fubNotesBy.set(k, arr)
      }
    }

    // --- 3. Score each BC by source_chars + fill density.
    type Scored = {
      bc_id:               string
      contact_id:          string
      contact_name:        string | null
      source_chars:        number
      note_count:          number
      bc_filled:           number
      bc_total:            number
      bc_fill_density_pct: number
      would_route:         'sonnet' | 'haiku'
    }
    const scored: Scored[] = []
    for (const bc of allBcs) {
      const contactId = String(bc.contact_id || '')
      const contact = contactById.get(contactId)
      if (!contact) continue
      const aceN  = aceNotesBy.get(contactId) || []
      const callN = contact.fub_contact_id ? (fubCallsBy.get(contact.fub_contact_id) || []) : []
      const noteN = contact.fub_contact_id ? (fubNotesBy.get(contact.fub_contact_id) || []) : []
      const { source_chars, note_count } = measureBuyer({ contact, aceNotes: aceN, fubCalls: callN, fubNotes: noteN })
      const { filled, total } = countFilled(bc)
      const route = (source_chars >= SOURCE_THRESHOLD || note_count >= NOTE_THRESHOLD) ? 'sonnet' : 'haiku'
      scored.push({
        bc_id:               String(bc.id),
        contact_id:          contactId,
        contact_name:        contact.name,
        source_chars,
        note_count,
        bc_filled:           filled,
        bc_total:            total,
        bc_fill_density_pct: total ? Math.round((filled / total) * 100) : 0,
        would_route:         route,
      })
    }

    // --- 4. Stratified sample: aim for diverse coverage.
    //   - 5 Haiku low-density (richer audit on small buyers)
    //   - 5 Sonnet (any density — includes the rich-history cases)
    //   - 5 Haiku medium-to-high density (verify "don't override rich BCs")
    const haikus  = scored.filter(s => s.would_route === 'haiku'  && !excludeBcIds.has(s.bc_id))
    const sonnets = scored.filter(s => s.would_route === 'sonnet' && !excludeBcIds.has(s.bc_id))

    // Skip BCs with zero notes AND zero fill — pointless to test.
    const usefulHaikus = haikus.filter(h => h.note_count > 0 || h.bc_filled > 0)
    const haikusByDensity = [...usefulHaikus].sort((a, b) => a.bc_fill_density_pct - b.bc_fill_density_pct)
    const sonnetsByChars  = [...sonnets].sort((a, b) => b.source_chars - a.source_chars)

    const sample: Scored[] = []
    const sampleIds = new Set<string>()
    const tryAdd = (s: Scored) => {
      if (!sampleIds.has(s.bc_id)) { sample.push(s); sampleIds.add(s.bc_id) }
    }
    // 5 Sonnet (top by source_chars, but skip near-duplicates).
    for (let i = 0, picked = 0; i < sonnetsByChars.length && picked < 5; i++) {
      tryAdd(sonnetsByChars[i]); picked = sample.filter(s => s.would_route === 'sonnet').length
    }
    // 5 Haiku low-density (start at sparsest).
    for (let i = 0, picked = 0; i < haikusByDensity.length && picked < 5; i++) {
      tryAdd(haikusByDensity[i]); picked = sample.filter(s => s.would_route === 'haiku' && s.bc_fill_density_pct < 30).length
    }
    // 5 Haiku high-density (the "don't override" check).
    for (let i = haikusByDensity.length - 1, picked = 0; i >= 0 && picked < 5; i--) {
      tryAdd(haikusByDensity[i]); picked = sample.filter(s => s.would_route === 'haiku' && s.bc_fill_density_pct >= 30).length
    }
    // If we underfilled (small population), top up from anywhere.
    for (let i = 0; i < scored.length && sample.length < sample_size; i++) {
      tryAdd(scored[i])
    }
    const finalSample = sample.slice(0, sample_size)

    // --- 5. Run the AI dry-run on each. Bounded concurrency.
    type Result = Scored & {
      ai_ok:                 boolean
      ai_error?:             string
      ai_model_used?:        string
      ai_routing_reason?:    string
      proposed_count?:       number
      confirmed_count?:      number
      na_count?:             number
      uncertain_count?:      number
      would_override_count?: number
      proposed_changes?:     Record<string, { proposed: unknown; before: unknown; cite?: string; confidence?: string }>
      confirmed_fields?:     Record<string, { value: unknown; cite?: string }>
      na_proposals?:         Array<{ col: string; explanation?: string }>
      uncertain_fields?:     Array<{ col: string; why: string }>
      tokens_in?:            number
      tokens_out?:           number
    }
    const results: Result[] = []
    let cursor = 0
    async function worker() {
      while (cursor < finalSample.length) {
        const idx = cursor++
        const s = finalSample[idx]
        try {
          const aiResp = await runAiOnBuyer(s.bc_id, gatewayAuth, gatewayApikey) as Record<string, unknown>
          if (!aiResp.ok) {
            results[idx] = { ...s, ai_ok: false, ai_error: String(aiResp.error || 'unknown') }
            continue
          }
          const proposed = (aiResp.proposed_changes  || {}) as Record<string, { proposed: unknown; before: unknown; cite?: string; confidence?: string }>
          const confirmed= (aiResp.confirmed_fields  || {}) as Record<string, { value: unknown; cite?: string }>
          const na       = (aiResp.na_proposals      || []) as Array<{ col: string; explanation?: string }>
          const uncertain= (aiResp.uncertain_fields  || []) as Array<{ col: string; why: string }>
          const diag     = (aiResp.diagnostic        || {}) as Record<string, unknown>
          const inputSum = (diag.input_summary       || {}) as Record<string, unknown>
          const routing  = (diag.model_routing       || {}) as Record<string, unknown>
          // would_override = proposals where the BEFORE value was non-null/non-empty
          let wouldOverride = 0
          for (const v of Object.values(proposed)) {
            const b = v.before
            const empty = (b === null || b === undefined ||
              (typeof b === 'string' && b.trim() === '') ||
              (Array.isArray(b) && b.length === 0))
            if (!empty) wouldOverride++
          }
          results[idx] = {
            ...s,
            ai_ok:                 true,
            ai_model_used:         String(aiResp.model || ''),
            ai_routing_reason:     String(routing.reason || ''),
            proposed_count:        Object.keys(proposed).length,
            confirmed_count:       Object.keys(confirmed).length,
            na_count:              na.length,
            uncertain_count:       uncertain.length,
            would_override_count:  wouldOverride,
            proposed_changes:      proposed,
            confirmed_fields:      confirmed,
            na_proposals:          na,
            uncertain_fields:      uncertain,
            tokens_in:             Number(inputSum.tokens_in)  || 0,
            tokens_out:            Number(inputSum.tokens_out) || 0,
          }
        } catch (e) {
          results[idx] = { ...s, ai_ok: false, ai_error: String((e as Error)?.message || e) }
        }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, finalSample.length) }, () => worker())
    await Promise.all(workers)

    // --- 6. Aggregate summary.
    const summary = {
      total_tested:           results.length,
      sonnet_runs:            results.filter(r => r.ai_ok && /sonnet/i.test(r.ai_model_used || '')).length,
      haiku_runs:             results.filter(r => r.ai_ok && /haiku/i.test(r.ai_model_used || '')).length,
      errors:                 results.filter(r => !r.ai_ok).length,
      total_proposed:         results.reduce((s, r) => s + (r.proposed_count        || 0), 0),
      total_confirmed:        results.reduce((s, r) => s + (r.confirmed_count       || 0), 0),
      total_na:               results.reduce((s, r) => s + (r.na_count              || 0), 0),
      total_uncertain:        results.reduce((s, r) => s + (r.uncertain_count       || 0), 0),
      total_would_override:   results.reduce((s, r) => s + (r.would_override_count  || 0), 0),
      tokens_in:              results.reduce((s, r) => s + (r.tokens_in             || 0), 0),
      tokens_out:             results.reduce((s, r) => s + (r.tokens_out            || 0), 0),
    }
    const cost_estimate_usd = Math.round(
      ((summary.tokens_in / 1_000_000)  * 1.5  +    // mixed sonnet/haiku input
       (summary.tokens_out / 1_000_000) * 7.5) * 100,
    ) / 100

    return jsonResp({
      ok: true,
      generated_at: new Date().toISOString(),
      runtime_ms:   Date.now() - t0,
      summary:      { ...summary, cost_estimate_usd },
      population: {
        buyer_tagged_total: buyerContacts.length,
        bcs_in_scope:       scored.length,
        sampled:            finalSample.length,
      },
      results,
    })
  } catch (e) {
    return jsonResp({ ok: false, error: String((e as Error)?.message || e) }, 500)
  }
})
