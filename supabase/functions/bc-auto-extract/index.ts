// bc-auto-extract — uses Claude Haiku 4.5 to extract structured buy-box criteria
// from each buyer's other_requirements + FUB call history.
//
// HARD-CODED MODEL: claude-haiku-4-5
// This function will never use any other model. If you want a different model,
// edit this file and redeploy. The model name appears exactly once below.
//
// MODE FLAGS:
//   ?dry_run=1         — compute extractions but do NOT write to the database.
//                        Returns the extracted data so you can inspect quality.
//   ?buyer_ids=a,b,c   — only process these specific buyer criteria IDs.
//                        Useful for testing on a small set first.
//   ?limit=N           — process at most N buyers (applies after filters).
//
// WRITE POLICY:
//   • confidence === 'high'   AND !needs_review  → WRITE data, mark 'ai_suggestions_applied'
//   • confidence === 'high'   AND  needs_review  → WRITE data, mark 'needs_human_review'
//   • confidence === 'medium'                    → WRITE data, mark 'needs_human_review'
//   • confidence === 'low'                       → WRITE NOTHING, mark 'needs_human_review'
//
// SAFETY RULES:
//   1. Never overwrites a field that already has a value — only fills blanks.
//   2. Low confidence NEVER writes data, regardless of the needs_review flag.
//   3. Every write is tagged reviewed_by='ai-haiku-4-5' with timestamp for audit.
//   4. review_reason is always saved to review_notes when present.
//   5. review_status values must match the ace_buyer_criteria_review_status_check
//      constraint: not_reviewed, ai_suggestions_applied, needs_human_review,
//      completed, no_ai_suggestions.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MODEL = 'claude-haiku-4-5'  // <-- HARD CODE. DO NOT CHANGE AT RUNTIME.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

const SYSTEM_PROMPT = `You are a data extraction assistant for a commercial real estate CRM.

Your job: read unstructured notes and call history about a buyer, and extract their structured buy-box criteria as JSON.

CRITICAL RULES:
1. Be CONSERVATIVE. When in doubt about a specific field, leave that field null rather than guessing.
2. NEVER guess or fabricate data. Only extract what is explicitly stated or very strongly implied.
3. Phone numbers are NOT price ranges. A string like "201-233-9720" is a phone number, not $201M-$233M.
4. Distinguish between the buyer's OWN properties (where they already own or live) and what they WANT to buy. Only extract what they want to buy.
5. "6 unit in West New York" usually refers to a specific deal being discussed, not a general unit range preference. Don't extract unitsMin=6 from this.
6. Rate your confidence honestly:
   - "high"   = you are certain about most core fields (asset type, location, budget range). The data is clear and unambiguous.
   - "medium" = you extracted real data but there's some ambiguity (mixed property interests, unclear ranges, fragmented notes). A human should double-check but your extraction is probably usable.
   - "low"    = you cannot extract reliable buy-box data. The notes are unrelated, empty, about someone else, or too vague to act on. DO NOT fill in guesses.
7. Set needs_human_review=true whenever:
   - Confidence is medium or low
   - Notes contain conflicting information
   - You're uncertain whether values refer to a specific deal vs a general preference
   - The buyer's name in the notes doesn't match the stated buyer name

OUTPUT SCHEMA (return ONLY valid JSON, no markdown, no preamble):
{
  "asset_types": ["multifamily" | "retail" | "office" | "warehouse" | "mixed_use" | "land" | "hotel" | "auto" | "storage" | "medical" | "daycare" | "restaurant"],
  "states": ["NJ", "NY", "FL", ...] (2-letter US state codes),
  "counties": ["Essex County, NJ", "Volusia County, FL", ...] (include state suffix),
  "cities": ["West New York", "Newark", ...],
  "price_min": number or null (in whole dollars, e.g. 1000000 for $1M),
  "price_max": number or null,
  "units_min": number or null (multifamily unit count),
  "units_max": number or null,
  "min_cap_rate": number or null (percentage, e.g. 6.5),
  "style_prefs": ["value-add", "blue collar rentals", "turnkey", ...] or [],
  "location_notes": "short free-text location description" or null,
  "confidence": "high" | "medium" | "low",
  "needs_human_review": true | false,
  "review_reason": "explanation of what was unclear or conflicting" or null
}
`

async function callHaiku(apiKey: string, userPrompt: string): Promise<{ parsed: any, raw: string, usage: any }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`)
  }

  const json = await res.json()
  const raw = json.content?.[0]?.text || ''
  if (!raw) throw new Error('Empty response from Anthropic')

  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`Could not parse JSON from model: ${cleaned.slice(0, 300)}`)
  }

  return { parsed, raw, usage: json.usage }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const startMs = Date.now()

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Supabase secrets' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const url = new URL(req.url)
    const dryRun = url.searchParams.get('dry_run') === '1'
    const limit = Number(url.searchParams.get('limit') || '10')
    const buyerIdsParam = url.searchParams.get('buyer_ids') || ''
    const specificIds = buyerIdsParam ? buyerIdsParam.split(',').map(s => s.trim()).filter(Boolean) : []

    let buyers: any[] = []
    if (specificIds.length > 0) {
      const { data, error } = await sb.from('ace_buyer_criteria')
        .select('id,contact_id,desired_property_types,preferred_states,simple_area_preference,preferred_cities,min_purchase_price,max_purchase_price,mf_min_units,mf_max_units,minimum_cap_rate,mf_style_preference,location_preferences,other_requirements,review_status,ace_contacts(name,fub_contact_id)')
        .in('id', specificIds)
      if (error) throw new Error('Fetch buyers: ' + error.message)
      buyers = data || []
    } else {
      const { data, error } = await sb.from('ace_buyer_criteria')
        .select('id,contact_id,desired_property_types,preferred_states,simple_area_preference,preferred_cities,min_purchase_price,max_purchase_price,mf_min_units,mf_max_units,minimum_cap_rate,mf_style_preference,location_preferences,other_requirements,review_status,ace_contacts(name,fub_contact_id)')
        .or('review_status.is.null,review_status.eq.not_reviewed')
        .limit(limit)
      if (error) throw new Error('Fetch buyers: ' + error.message)
      buyers = data || []
    }

    const fubIds = [...new Set(buyers.map(b => b.ace_contacts?.fub_contact_id).filter(Boolean))]
    const callNotesByFubId: Record<number, string[]> = {}
    if (fubIds.length > 0) {
      const { data: callRows } = await sb.from('fub_calls')
        .select('person_id,note')
        .in('person_id', fubIds)
        .not('note', 'is', null)
        .limit(3000)
      for (const row of (callRows || [])) {
        if (!row.person_id || !row.note) continue
        if (!callNotesByFubId[row.person_id]) callNotesByFubId[row.person_id] = []
        if (callNotesByFubId[row.person_id].length < 10) {
          callNotesByFubId[row.person_id].push(String(row.note).substring(0, 500))
        }
      }
    }

    const results: any[] = []
    let autoApplied = 0, needsReview = 0, errors = 0, skipped = 0
    let lowConfNoWrite = 0
    let totalInputTokens = 0, totalOutputTokens = 0

    for (const buyer of buyers) {
      const fubId = buyer.ace_contacts?.fub_contact_id
      const callNotes = (fubId && callNotesByFubId[fubId]) ? callNotesByFubId[fubId].join(' | ') : ''
      const otherReqs = buyer.other_requirements || ''
      const combined = [otherReqs, callNotes].filter(Boolean).join(' || ')

      if (!combined.trim()) {
        skipped++
        results.push({ buyer_id: buyer.id, name: buyer.ace_contacts?.name, skipped: 'no source text' })
        continue
      }

      const userPrompt = `BUYER NAME: ${buyer.ace_contacts?.name || 'Unknown'}\n\nNOTES AND CALL HISTORY:\n${combined.substring(0, 8000)}\n\nExtract the buy-box criteria as JSON following the schema.`

      let extraction: any
      try {
        const result = await callHaiku(apiKey, userPrompt)
        extraction = result.parsed
        totalInputTokens += result.usage?.input_tokens || 0
        totalOutputTokens += result.usage?.output_tokens || 0
      } catch (e) {
        errors++
        results.push({ buyer_id: buyer.id, name: buyer.ace_contacts?.name, error: String(e).slice(0, 200) })
        continue
      }

      const conf = extraction.confidence
      const isHigh   = conf === 'high'
      const isMedium = conf === 'medium'
      const isLow    = conf === 'low'
      const shouldWriteData = isHigh || isMedium
      const isCleanHigh = isHigh && extraction.needs_human_review === false

      const updates: Record<string, any> = {}
      const written: string[] = []
      const skippedExisting: string[] = []

      const tryFill = (col: string, currentVal: any, newVal: any, label: string) => {
        if (newVal === null || newVal === undefined || newVal === '' || (Array.isArray(newVal) && newVal.length === 0)) return
        const hasCurrent = currentVal !== null && currentVal !== undefined && currentVal !== ''
        if (hasCurrent) {
          skippedExisting.push(label)
          return
        }
        updates[col] = Array.isArray(newVal) ? newVal.join(', ') : newVal
        written.push(label)
      }

      if (shouldWriteData) {
        tryFill('desired_property_types', buyer.desired_property_types, extraction.asset_types, 'asset_types')
        tryFill('preferred_states', buyer.preferred_states, extraction.states, 'states')
        tryFill('simple_area_preference', buyer.simple_area_preference, extraction.counties, 'counties')
        tryFill('preferred_cities', buyer.preferred_cities, extraction.cities, 'cities')
        tryFill('min_purchase_price', buyer.min_purchase_price, extraction.price_min, 'price_min')
        tryFill('max_purchase_price', buyer.max_purchase_price, extraction.price_max, 'price_max')
        tryFill('mf_min_units', buyer.mf_min_units, extraction.units_min, 'units_min')
        tryFill('mf_max_units', buyer.mf_max_units, extraction.units_max, 'units_max')
        tryFill('minimum_cap_rate', buyer.minimum_cap_rate, extraction.min_cap_rate, 'min_cap_rate')
        tryFill('mf_style_preference', buyer.mf_style_preference, extraction.style_prefs, 'style_prefs')
        tryFill('location_preferences', buyer.location_preferences, extraction.location_notes, 'location_notes')
      }

      const resultEntry: any = {
        buyer_id: buyer.id,
        name: buyer.ace_contacts?.name,
        confidence: conf,
        needs_review_flag: extraction.needs_human_review,
        review_reason: extraction.review_reason,
        would_write: written,
        would_skip_existing: skippedExisting,
        low_confidence_no_write: isLow,
        extraction: dryRun ? extraction : undefined
      }

      if (!dryRun) {
        let newReviewStatus: string
        if (isCleanHigh && Object.keys(updates).length > 0) {
          newReviewStatus = 'ai_suggestions_applied'
          autoApplied++
        } else if (isCleanHigh && Object.keys(updates).length === 0) {
          newReviewStatus = 'completed'
          skipped++
        } else {
          newReviewStatus = 'needs_human_review'
          needsReview++
          if (isLow) lowConfNoWrite++
        }

        updates.review_status = newReviewStatus
        updates.review_notes = extraction.review_reason || null
        updates.reviewed_at = new Date().toISOString()
        updates.reviewed_by = 'ai-haiku-4-5'

        const { error: upErr } = await sb.from('ace_buyer_criteria')
          .update(updates)
          .eq('id', buyer.id)

        if (upErr) {
          errors++
          resultEntry.write_error = upErr.message
          if (newReviewStatus === 'ai_suggestions_applied') autoApplied--
          else if (newReviewStatus === 'needs_human_review') needsReview--
        } else {
          resultEntry.applied_status = newReviewStatus
          resultEntry.wrote_data_fields = written.length > 0
        }
      } else {
        if (isCleanHigh && Object.keys(updates).length > 0) autoApplied++
        else if (isCleanHigh) skipped++
        else {
          needsReview++
          if (isLow) lowConfNoWrite++
        }
      }

      results.push(resultEntry)
    }

    const estCostUSD = (totalInputTokens / 1_000_000) * 1 + (totalOutputTokens / 1_000_000) * 5

    return new Response(JSON.stringify({
      ok: true,
      model: MODEL,
      dry_run: dryRun,
      total_processed: buyers.length,
      auto_applied: autoApplied,
      needs_review: needsReview,
      low_conf_no_write: lowConfNoWrite,
      skipped: skipped,
      errors: errors,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      estimated_cost_usd: Number(estCostUSD.toFixed(4)),
      elapsed_ms: Date.now() - startMs,
      results: results
    }, null, 2), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err),
      elapsed_ms: Date.now() - startMs
    }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
