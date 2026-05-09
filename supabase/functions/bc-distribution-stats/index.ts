// bc-distribution-stats — empirical threshold tuning for the BC AI
// auto-router (Sonnet vs Haiku).
//
// Replicates the source-text assembly logic from
// ai-parse-buyer-criteria/index.ts:1495-1584 byte-for-byte across the
// entire buyer-tagged population, then returns:
//   - distribution percentiles (p10/p25/p50/p75/p90/p95/p99) for both
//     source_chars and note_count
//   - routing simulation at the current AUTO_ROUTING constants
//   - threshold sweep table (what % go Sonnet vs Haiku at various cutoffs)
//   - sample buyers near each percentile so the user can spot-check
//
// ZERO Anthropic calls — only Supabase REST. Cost ≈ pennies. Used to
// pick a defensible threshold instead of guessing.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('PROJECT_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || ''

// Mirrors AUTO_ROUTING in ai-parse-buyer-criteria/index.ts:52-56.
const CURRENT_THRESHOLDS = {
  source_chars_threshold: 3000,
  note_count_threshold:   5,
}

// Per-call cost estimates (post-cache amortization, from real Carlos run).
// Only used for the threshold-sweep $$ projection — not authoritative.
const SONNET_COST_PER_CALL = 0.029
const HAIKU_COST_PER_CALL  = 0.010

// Cap constants matching ai-parse-buyer-criteria.
const CAP_CONTACT_NOTES   = 4000
const CAP_NOTE_BODY       = 800
const LIMIT_ACE_NOTES     = 50
const LIMIT_FUB_NOTES     = 30
const LIMIT_FUB_CALLS     = 30

// Pagination.
const CONTACT_PAGE_SIZE   = 1000   // PostgREST max
const CHUNK_SIZE          = 100    // for note batched IN-queries

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
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

// Replicates ai-parse-buyer-criteria source-text assembly (lines 1540-1584).
function buildSourceText(args: {
  contact: {
    name?: string | null
    email?: string | null
    phone_number?: string | null
    company?: string | null
    contact_notes?: string | null
  }
  aceNotes: Array<{ body?: string | null; kind?: string | null; created_at?: string | null }>
  fubCalls: Array<{ note?: string | null; created_at?: string | null }>
  fubNotes: Array<{ body?: string | null; created_at?: string | null }>
}): { source_chars: number; note_count: number } {
  const { contact, aceNotes, fubCalls, fubNotes } = args
  const sourceParts: string[] = []

  if (contact) {
    const lines = [
      `Contact: ${contact.name || '(no name)'}`,
      contact.email ? `Email: ${contact.email}` : '',
      contact.phone_number ? `Phone: ${contact.phone_number}` : '',
      contact.company ? `Company: ${contact.company}` : '',
      contact.contact_notes ? `\nContact notes:\n${capText(contact.contact_notes, CAP_CONTACT_NOTES)}` : '',
    ].filter(Boolean)
    sourceParts.push('--- CONTACT ---\n' + lines.join('\n'))
  }

  const aceNonEmpty = aceNotes.filter(n => n.body && String(n.body).trim())
  if (aceNonEmpty.length) {
    sourceParts.push('--- ACE CONTACT NOTES (newest first) ---\n' + aceNonEmpty
      .map(n => `[${n.kind || 'note'} @ ${n.created_at || ''}] ${capText(n.body, CAP_NOTE_BODY)}`)
      .join('\n\n'))
  }

  const fubCallsNonEmpty = fubCalls.filter(c => c.note && String(c.note).trim())
  if (fubCallsNonEmpty.length) {
    sourceParts.push('--- FUB CALL NOTES (newest first) ---\n' + fubCallsNonEmpty
      .map(c => `[call @ ${c.created_at || ''}] ${capText(c.note, CAP_NOTE_BODY)}`)
      .join('\n\n'))
  }

  const fubNotesNonEmpty = fubNotes.filter(n => n.body && String(n.body).trim())
  if (fubNotesNonEmpty.length) {
    sourceParts.push('--- FUB NOTES (newest first) ---\n' + fubNotesNonEmpty
      .map(n => `[note @ ${n.created_at || ''}] ${capText(n.body, CAP_NOTE_BODY)}`)
      .join('\n\n'))
  }

  const contextText = sourceParts.join('\n\n')
  const note_count = aceNonEmpty.length + fubCallsNonEmpty.length + fubNotesNonEmpty.length
  return { source_chars: contextText.length, note_count }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[idx]
}

function summarize(values: number[]) {
  if (!values.length) {
    return { count: 0, min: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, stddev: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((s, v) => s + v, 0)
  const mean = sum / values.length
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length
  return {
    count: values.length,
    min: sorted[0],
    p10: percentile(sorted, 0.10),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.50),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.90),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: Math.round(mean),
    stddev: Math.round(Math.sqrt(variance)),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResp({ ok: false, error: 'Service key / URL not configured' }, 500)
    }

    // Optional `sample_size` body param to cap how many buyers we measure.
    // Defaults to "all" — useful for first-run validation against a smaller
    // subset.
    let sampleSize: number | null = null
    try {
      const b = await req.json().catch(() => ({}))
      if (b && typeof b.sample_size === 'number' && b.sample_size > 0) {
        sampleSize = Math.min(b.sample_size, 10000)
      }
    } catch (_) { /* GET or no body — fine */ }

    const t0 = Date.now()

    // --- 1. Pull all buyer-tagged contacts (paginated past 1000-row limit).
    const allBuyers: Array<{
      id: string
      name: string | null
      email: string | null
      phone_number: string | null
      company: string | null
      contact_notes: string | null
      fub_contact_id: string | null
    }> = []
    let offset = 0
    while (true) {
      const page = (await sbFetch(
        `ace_contacts?deleted_at=is.null&fub_tags=cs.{Buyer}&select=id,name,email,phone_number,company,contact_notes,fub_contact_id&order=id.asc&limit=${CONTACT_PAGE_SIZE}&offset=${offset}`,
      )) as Array<typeof allBuyers[number]>
      if (!page.length) break
      allBuyers.push(...page)
      if (page.length < CONTACT_PAGE_SIZE) break
      offset += CONTACT_PAGE_SIZE
      if (sampleSize && allBuyers.length >= sampleSize) break
    }
    const buyers = sampleSize ? allBuyers.slice(0, sampleSize) : allBuyers

    // --- 2. Build chunks; for each chunk, batch-fetch the three note tables.
    // Maps: contact_id → ace_contact_notes[], fub_contact_id → fub_*[].
    type Note   = { contact_id?: string; person_id?: string; body?: string | null; note?: string | null; kind?: string | null; created_at?: string | null }
    const aceNotesByContact = new Map<string, Note[]>()
    const fubCallsByPerson  = new Map<string, Note[]>()
    const fubNotesByPerson  = new Map<string, Note[]>()

    for (let i = 0; i < buyers.length; i += CHUNK_SIZE) {
      const slice = buyers.slice(i, i + CHUNK_SIZE)
      const contactIds = slice.map(b => b.id)
      const personIds  = slice.map(b => b.fub_contact_id).filter((x): x is string => !!x)

      const inContact = contactIds.map(id => `"${id}"`).join(',')
      const inPerson  = personIds.map(id => `"${id}"`).join(',')

      // Run all three table queries in parallel for this chunk.
      // Pull MORE than the per-contact limit so in-memory grouping can
      // top-N each contact independently. Using 5000 ceiling per chunk =
      // 50 notes/contact * 100 contacts on the hot edge.
      const ACE_PULL  = 5000
      const FUB_PULL  = 5000
      // Note: ace_contact_notes has no `kind` column — the source-text
      // assembly always falls back to `'note'`, so we don't need it for
      // char counting either.
      const aceP = inContact ? sbFetch(
        `ace_contact_notes?contact_id=in.(${inContact})&select=contact_id,body,created_at&order=created_at.desc&limit=${ACE_PULL}`,
      ) : Promise.resolve([] as Note[])
      const callP = inPerson ? sbFetch(
        `fub_calls?person_id=in.(${inPerson})&select=person_id,note,created_at&order=created_at.desc&limit=${FUB_PULL}`,
      ) : Promise.resolve([] as Note[])
      const noteP = inPerson ? sbFetch(
        `fub_notes?person_id=in.(${inPerson})&select=person_id,body,created_at&order=created_at.desc&limit=${FUB_PULL}`,
      ) : Promise.resolve([] as Note[])

      const [aceRows, callRows, noteRows] = await Promise.all([aceP, callP, noteP]) as [Note[], Note[], Note[]]

      for (const r of aceRows) {
        const k = r.contact_id || ''
        if (!k) continue
        const arr = aceNotesByContact.get(k) || []
        if (arr.length < LIMIT_ACE_NOTES) arr.push(r)
        aceNotesByContact.set(k, arr)
      }
      for (const r of callRows) {
        const k = r.person_id || ''
        if (!k) continue
        const arr = fubCallsByPerson.get(k) || []
        if (arr.length < LIMIT_FUB_CALLS) arr.push(r)
        fubCallsByPerson.set(k, arr)
      }
      for (const r of noteRows) {
        const k = r.person_id || ''
        if (!k) continue
        const arr = fubNotesByPerson.get(k) || []
        if (arr.length < LIMIT_FUB_NOTES) arr.push(r)
        fubNotesByPerson.set(k, arr)
      }
    }

    // --- 3. Compute source_chars + note_count per buyer.
    const measurements: Array<{
      buyer_id: string
      name: string | null
      source_chars: number
      note_count: number
    }> = []
    for (const b of buyers) {
      const aceNotes = aceNotesByContact.get(b.id) || []
      const fubCalls = b.fub_contact_id ? (fubCallsByPerson.get(b.fub_contact_id) || []) : []
      const fubNotes = b.fub_contact_id ? (fubNotesByPerson.get(b.fub_contact_id) || []) : []
      const { source_chars, note_count } = buildSourceText({
        contact: {
          name: b.name, email: b.email, phone_number: b.phone_number,
          company: b.company, contact_notes: b.contact_notes,
        },
        aceNotes:  aceNotes.map(n => ({ body: n.body, kind: n.kind, created_at: n.created_at })),
        fubCalls:  fubCalls.map(n => ({ note: n.note, created_at: n.created_at })),
        fubNotes:  fubNotes.map(n => ({ body: n.body, created_at: n.created_at })),
      })
      measurements.push({ buyer_id: b.id, name: b.name, source_chars, note_count })
    }

    // --- 4. Aggregate.
    const charSummary = summarize(measurements.map(m => m.source_chars))
    const noteSummary = summarize(measurements.map(m => m.note_count))

    // --- 5. Routing simulation at current thresholds.
    const total = measurements.length
    let sonnetCount = 0
    for (const m of measurements) {
      if (m.source_chars >= CURRENT_THRESHOLDS.source_chars_threshold ||
          m.note_count   >= CURRENT_THRESHOLDS.note_count_threshold) sonnetCount++
    }
    const haikuCount = total - sonnetCount
    const currentRouting = {
      thresholds:           CURRENT_THRESHOLDS,
      would_route_sonnet:   sonnetCount,
      would_route_haiku:    haikuCount,
      sonnet_pct:           total ? `${(sonnetCount / total * 100).toFixed(1)}%` : '0%',
      haiku_pct:            total ? `${(haikuCount / total * 100).toFixed(1)}%` : '0%',
      estimated_full_sweep_cost_usd:
        Math.round((sonnetCount * SONNET_COST_PER_CALL + haikuCount * HAIKU_COST_PER_CALL) * 100) / 100,
    }

    // --- 6. Threshold sweep — vary source_chars cutoff, hold note_count fixed.
    const sweepCutoffs = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000]
    const threshold_sweep = sweepCutoffs.map(cut => {
      let s = 0
      for (const m of measurements) {
        if (m.source_chars >= cut || m.note_count >= CURRENT_THRESHOLDS.note_count_threshold) s++
      }
      const h = total - s
      return {
        source_chars_cutoff: cut,
        note_count_cutoff:   CURRENT_THRESHOLDS.note_count_threshold,
        sonnet:              s,
        haiku:               h,
        sonnet_pct:          total ? `${(s / total * 100).toFixed(1)}%` : '0%',
        cost_usd:            Math.round((s * SONNET_COST_PER_CALL + h * HAIKU_COST_PER_CALL) * 100) / 100,
      }
    })

    // --- 7. Sample buyers near each percentile (5 per anchor).
    const sortedByChars = [...measurements].sort((a, b) => a.source_chars - b.source_chars)
    const pickAt = (p: number) => {
      const targetIdx = Math.floor(sortedByChars.length * p)
      const start = Math.max(0, targetIdx - 2)
      const end   = Math.min(sortedByChars.length, targetIdx + 3)
      return sortedByChars.slice(start, end).map(m => ({
        buyer_contact_id: m.buyer_id,
        name:             m.name,
        source_chars:     m.source_chars,
        note_count:       m.note_count,
      }))
    }
    const sample_buyers_by_decile = {
      p10: pickAt(0.10),
      p25: pickAt(0.25),
      p50: pickAt(0.50),
      p75: pickAt(0.75),
      p90: pickAt(0.90),
      p99: pickAt(0.99),
    }

    return jsonResp({
      ok: true,
      generated_at: new Date().toISOString(),
      runtime_ms: Date.now() - t0,
      population: {
        buyer_tagged_total: allBuyers.length,
        sampled:            measurements.length,
      },
      source_chars: charSummary,
      note_count:   noteSummary,
      current_routing: currentRouting,
      threshold_sweep,
      sample_buyers_by_decile,
    })
  } catch (e) {
    return jsonResp({ ok: false, error: String((e as Error)?.message || e) }, 500)
  }
})
