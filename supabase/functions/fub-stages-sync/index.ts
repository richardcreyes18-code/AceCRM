// fub-stages-sync v7 — fix: remove fields=allFields (not a valid FUB param).
//
// Changes vs v6:
//   * Remove &fields=allFields from deals fetch URL (caused FUB 400 error)
//   * Remove ?fields=allFields from people fetch URL (same issue)
//   * fubStructuredAddr still built from d.propertyStreet/City/State/Zip if FUB
//     returns those fields natively; falls back to deal-name extraction if empty.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

const CRM_KNOWN_STAGES = new Set([
  'Lead', 'Attempted Contact', 'Top G Review', 'Needs Offer', 'Nurture',
  'Active Listing', 'Hot Active Listing', 'In Negotiations', 'Under Contract',
  'Closed', 'Lease Listing', 'Market Price Active', 'New Lead',
  'Attorney Review', 'Pitch Out', 'GHL', 'Overpriced', 'Limbo', 'Clean Up',
  'Negotiating', 'Closed 2025', 'Closed 2026', 'Active Deal', 'Need INFO',
  'Needs a 1031'
])

const SKIP_PIPELINES = new Set(['Buyers', 'Sellers KW - NOT ACE', 'Biz Deals'])

const FUB_TO_CRM_STAGE_MAP: Record<string, string> = {
  'Overpriced / Unmotivated': 'Overpriced',
  'CLOSED 2025': 'Closed 2025',
  'CLOSED 2026': 'Closed 2026',
}

const AUTO_CREATE_STAGES = new Set([
  'Hot Active Listing', 'Active Listing', 'Market Price Active', 'Lease Listing',
  'Needs Offer', 'Top G Review', 'In Negotiations', 'Under Contract',
  'Attorney Review', 'Pitch Out', 'Negotiating', 'Active Deal', 'Need INFO',
  'Needs a 1031',
])

const MIN_ADDR_SCORE = 4

const NON_ADDR_UNIT_RE = /^(rooms?|units?|u\b|sf|sqft|k\s*sf|floors?|stories?|story|buildings?|lots?|homes?|apts?|apartments?)/i

const STATE_ABBR: Record<string, string> = {
  'New Jersey': 'NJ', 'Pennsylvania': 'PA', 'New York': 'NY',
  'Connecticut': 'CT', 'Delaware': 'DE', 'Maryland': 'MD',
  'Florida': 'FL', 'Texas': 'TX', 'California': 'CA',
}

function mapStage(fubStage: string | null | undefined): string | null {
  if (!fubStage) return null
  const mapped = FUB_TO_CRM_STAGE_MAP[fubStage] ?? fubStage
  return CRM_KNOWN_STAGES.has(mapped) ? mapped : null
}

function normalizeAddr(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).toLowerCase()
    .replace(/,\s*usa$/i, '')
    .replace(/\s+nj\s+\d{5}[-\d]*/i, ' nj')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function extractAddressFromDealName(n: string | null | undefined): string {
  if (!n) return ''
  let s = String(n).replace(/\s*[-\u2013]\s*[A-Z]{1,6}(\/[A-Z]{1,6})?\s*$/i, '')
  const parts = s.split(/\s*[-\u2013]\s*/)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    const numMatch = part.match(/^(\d+[-\u2013]?\d*)\s+(\S+)/)
    if (!numMatch) continue
    if (NON_ADDR_UNIT_RE.test(numMatch[2])) continue
    return parts.slice(i).join(' ').trim()
  }
  return ''
}

function addressScore(a: string, b: string): number {
  if (a.length < 4 || b.length < 4) return 0
  let score = 0
  for (let i = 0; i <= a.length - 4; i += 2) {
    const gram = a.substring(i, i + 4)
    if (b.includes(gram)) score++
  }
  return score
}

function extractStreetNum(normalized: string): string {
  return normalized.match(/^(\d+)/)?.[1] || ''
}

function extractStreetWord(normalized: string): string {
  for (const w of normalized.split(' ')) {
    if (w.length >= 4 && !/^\d/.test(w) && !NON_ADDR_UNIT_RE.test(w)) return w
  }
  return ''
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const startMs = Date.now()

  try {
    const apiKey = Deno.env.get('FUB_API_KEY')
    if (!apiKey) return new Response(JSON.stringify({ error: 'FUB_API_KEY not configured' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    let body: any = {}
    if (req.method === 'POST') { try { body = await req.json() } catch (_) {} }
    const dryRun = body.dry_run !== false
    const pipelineFilter: string | null = body.pipeline_filter || null
    const autoCreateContacts = body.auto_create_contacts !== false
    const startingCursor: string | null = body.starting_cursor || null
    const providedSyncLogId: string | null = body.sync_log_id || null
    const chunkSize = Math.min(500, Math.max(50, Number(body.chunk_size || 300)))
    const maxElapsedMs = Math.min(140000, Math.max(30000, Number(body.max_elapsed_ms || 110000)))
    const triggeredBy = body.triggered_by || {}

    let syncLogId: string
    let existingStats: any = null
    if (providedSyncLogId) {
      const { data: existing, error: exErr } = await sb.from('ace_fub_sync_log')
        .select('*').eq('id', providedSyncLogId).single()
      if (exErr || !existing)
        return new Response(JSON.stringify({ error: 'sync_log_id not found', details: exErr }),
          { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
      if (existing.status !== 'running')
        return new Response(JSON.stringify({ error: `sync_log ${providedSyncLogId} status is ${existing.status}, cannot resume` }),
          { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
      syncLogId = existing.id
      existingStats = existing
    } else {
      const { data: inProgress } = await sb.from('ace_fub_sync_log')
        .select('id, started_at').is('ended_at', null).limit(1)
      if (inProgress && inProgress.length > 0)
        return new Response(JSON.stringify({
          error: 'A sync is already in progress',
          existing_sync_id: inProgress[0].id, started_at: inProgress[0].started_at
        }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
      const { data: logRow, error: logErr } = await sb.from('ace_fub_sync_log')
        .insert({
          dry_run: dryRun, pipeline_filter: pipelineFilter, status: 'running',
          triggered_by_user_id: triggeredBy.id || null,
          triggered_by_name: triggeredBy.name || null
        }).select('id').single()
      if (logErr || !logRow)
        return new Response(JSON.stringify({ error: 'Failed to create sync log', details: logErr }),
          { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      syncLogId = logRow.id
    }

    let totalProcessed  = existingStats?.total_processed || 0
    let totalMatched    = existingStats?.total_matched || 0
    let totalStageUpdated = existingStats?.total_stage_updated || 0
    let totalArchived   = existingStats?.total_archived || 0
    let totalUnmatched  = existingStats?.total_unmatched || 0
    let totalSkipped    = existingStats?.total_skipped || 0
    let totalLowConf    = existingStats?.stage_change_summary?.low_confidence || 0
    let totalConflicts  = existingStats?.stage_change_summary?.property_already_claimed || 0
    let totalContacts   = existingStats?.stage_change_summary?.contacts_created || 0
    let totalAddrFallback = existingStats?.stage_change_summary?.addr_fallback_matched || 0
    let totalAutoCreated = existingStats?.stage_change_summary?.auto_created || 0
    let totalWouldCreate = existingStats?.stage_change_summary?.would_auto_create || 0
    const stageChangeSummary: Record<string, number> = existingStats?.stage_change_summary?.changes || {}
    const unknownStageSummary: Record<string, number> = existingStats?.stage_change_summary?.unknown_fub_stages || {}
    const errors: string[] = []
    const claimedInThisChunk = new Set<string>()
    let chunkProcessed = 0

    const authHeader = 'Basic ' + btoa(apiKey + ':')
    const fubHeaders = {
      'Authorization': authHeader,
      'X-System': 'AceCRM', 'X-System-Key': 'ace-acquisitions-crm',
      'Content-Type': 'application/json'
    }

    // No fields= param — use FUB default response (includes all standard deal fields)
    let nextUrl: string | null = startingCursor
      ? startingCursor
      : 'https://api.followupboss.com/v1/deals?limit=100&sort=-created'

    while (nextUrl) {
      if (chunkProcessed >= chunkSize) break
      if (Date.now() - startMs >= maxElapsedMs) break

      let res: Response
      try { res = await fetch(nextUrl, { headers: fubHeaders }) }
      catch (e) { errors.push(`Network error: ${String(e)}`); break }

      if (!res.ok) {
        if (res.status === 429) { await new Promise(r => setTimeout(r, 11000)); continue }
        errors.push(`FUB ${res.status}: ${(await res.text()).slice(0, 300)}`)
        break
      }

      const json = await res.json()
      const deals: any[] = json.deals || []
      if (deals.length === 0) { nextUrl = null; break }

      for (const d of deals) {
        totalProcessed++
        chunkProcessed++

        if (pipelineFilter && d.pipelineName !== pipelineFilter) { totalSkipped++; continue }
        if (SKIP_PIPELINES.has(d.pipelineName || '')) { totalSkipped++; continue }

        const fubDealId: number   = d.id
        const fubDealName: string = d.name || ''
        const fubStageName: string = d.stageName || ''
        const fubStatus: string   = d.status || ''
        const people: any[]       = Array.isArray(d.people) ? d.people : []
        const ownerFubId: number | null  = people.length > 0 ? (people[0].id || null) : null
        const ownerFubName: string       = people.length > 0 ? (people[0].name || '') : ''

        let newStage: string | null = null
        let archive = false
        if (fubStatus === 'Trash' || fubStageName === 'Trash') {
          archive = true
        } else {
          newStage = mapStage(fubStageName)
          if (newStage == null)
            unknownStageSummary[fubStageName] = (unknownStageSummary[fubStageName] || 0) + 1
        }
        const canAutoCreate = !archive && newStage != null && AUTO_CREATE_STAGES.has(newStage)

        // Build structured address from FUB property fields (returned natively on some deal types)
        const stateRaw = d.propertyState || ''
        const stateAbbrev = STATE_ABBR[stateRaw] || (stateRaw.length <= 3 ? stateRaw : '')
        const fubStructuredAddr = [
          d.propertyStreet || '', d.propertyCity || '', stateAbbrev, d.propertyZip || ''
        ].map(s => String(s).trim()).filter(Boolean).join(', ')

        // Resolve ace_contact
        let aceContactId: string | null = null
        if (ownerFubId) {
          const { data: cRows } = await sb.from('ace_contacts')
            .select('id').eq('fub_contact_id', ownerFubId).limit(1)
          aceContactId = cRows && cRows.length > 0 ? cRows[0].id : null

          if (!aceContactId && autoCreateContacts && !dryRun) {
            try {
              const pRes = await fetch(`https://api.followupboss.com/v1/people/${ownerFubId}`, { headers: fubHeaders })
              if (pRes.ok) {
                const person: any = await pRes.json()
                const emails = Array.isArray(person.emails) ? person.emails : []
                const phones = Array.isArray(person.phones) ? person.phones : []
                const { data: cc, error: cErr } = await sb.from('ace_contacts').insert({
                  name: person.name || ownerFubName,
                  phone_number: phones[0]?.value || null,
                  email: emails[0]?.value || null,
                  fub_contact_id: ownerFubId,
                  date_added: person.created
                    ? new Date(person.created).toISOString().slice(0, 10)
                    : new Date().toISOString().slice(0, 10),
                  type: ['Seller']
                }).select('id').single()
                if (cErr) errors.push(`Contact insert fub_id=${ownerFubId}: ${cErr.message}`)
                else if (cc?.id) { aceContactId = cc.id; totalContacts++ }
              }
            } catch (e) {
              errors.push(`Contact create fub_id=${ownerFubId}: ${String(e).slice(0, 100)}`)
            }
          }
        }

        const fubAddrRaw  = extractAddressFromDealName(fubDealName)
        const hasAddress  = fubAddrRaw.length >= 4
        const fubAddrNorm = normalizeAddr(fubAddrRaw)

        const bestAddrForCreate =
          fubStructuredAddr.length >= 4 ? fubStructuredAddr
          : fubAddrRaw.length >= 4       ? fubAddrRaw
          : fubDealName

        const logUnmatched = async (note: string) => {
          await sb.from('ace_fub_unmatched_deals').upsert({
            sync_log_id: syncLogId,
            fub_deal_id: fubDealId, fub_deal_name: fubDealName,
            fub_stage_name: fubStageName, fub_pipeline_name: d.pipelineName || null,
            fub_contact_id: ownerFubId, fub_contact_name: ownerFubName,
            fub_users: d.users || [],
            last_seen_at: new Date().toISOString(),
            resolution: 'pending', resolution_notes: note
          }, { onConflict: 'fub_deal_id', ignoreDuplicates: false })
          totalUnmatched++
        }

        const autoCreate = async (reason: string) => {
          if (dryRun) {
            totalWouldCreate++
            await logUnmatched('would_auto_create:' + reason)
            return
          }
          const { data: np, error: ne } = await sb.from('ace_properties').insert({
            address: bestAddrForCreate,
            property_name: fubDealName.slice(0, 500),
            pipeline_stage: newStage,
            asking_price: d.price ? Number(d.price) : null,
            fub_deal_id: fubDealId,
            owner_contact_id: aceContactId || null,
            fub_assigned_to: d.users?.[0]?.name || null,
            import_source: 'fub_sync_auto',
            date_added: d.created
              ? new Date(d.created).toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10),
          }).select('id').single()
          if (ne || !np) {
            errors.push(`Auto-create deal ${fubDealId}: ${ne?.message || 'no row returned'}`)
            await logUnmatched(reason + '_create_failed')
            return
          }
          totalAutoCreated++
          await sb.from('ace_fub_unmatched_deals').upsert({
            sync_log_id: syncLogId,
            fub_deal_id: fubDealId, fub_deal_name: fubDealName,
            fub_stage_name: fubStageName, fub_pipeline_name: d.pipelineName || null,
            fub_contact_id: ownerFubId, fub_contact_name: ownerFubName,
            fub_users: d.users || [],
            last_seen_at: new Date().toISOString(),
            resolution: 'linked',
            resolution_notes: `auto_created:${reason}`,
            resolved_property_id: np.id,
            resolved_at: new Date().toISOString(),
          }, { onConflict: 'fub_deal_id', ignoreDuplicates: false })
        }

        // Step 1: direct fub_deal_id match
        let candidates: any[] = []
        if (fubDealId) {
          const { data: direct } = await sb.from('ace_properties')
            .select('id, address, pipeline_stage, owner_contact_id, fub_deal_id, is_archived')
            .eq('fub_deal_id', fubDealId).limit(2)
          if (direct && direct.length > 0) candidates = direct
        }

        // Step 2: contact-based match
        if (candidates.length === 0 && aceContactId) {
          const { data: props } = await sb.from('ace_properties')
            .select('id, address, pipeline_stage, owner_contact_id, fub_deal_id, is_archived')
            .eq('owner_contact_id', aceContactId).limit(50)
          candidates = props || []
        }

        // Step 3: address ILIKE fallback
        if (candidates.length === 0 && hasAddress) {
          const sn = extractStreetNum(fubAddrNorm)
          const sw = extractStreetWord(fubAddrNorm)
          if (sn && sw) {
            const { data: ap } = await sb.from('ace_properties')
              .select('id, address, pipeline_stage, owner_contact_id, fub_deal_id, is_archived')
              .ilike('address', `%${sn}%${sw}%`)
              .limit(20)
            if (ap && ap.length > 0) { candidates = ap; totalAddrFallback++ }
          }
        }

        if (candidates.length === 0) {
          if (canAutoCreate) { await autoCreate('no_candidates'); continue }
          await logUnmatched('no_candidates')
          continue
        }

        let target = candidates[0]
        let bestScore = 0
        if (candidates.length > 1) {
          for (const c of candidates) {
            const s = addressScore(fubAddrNorm, normalizeAddr(c.address))
            if (s > bestScore) { target = c; bestScore = s }
          }
        } else if (hasAddress) {
          bestScore = addressScore(fubAddrNorm, normalizeAddr(target.address))
        }

        if (hasAddress && bestScore < MIN_ADDR_SCORE) {
          if (canAutoCreate) { await autoCreate(`low_conf_${bestScore}`); continue }
          await logUnmatched(`low_confidence_score_${bestScore}`)
          totalLowConf++
          continue
        }

        if (claimedInThisChunk.has(target.id)) {
          if (canAutoCreate) { await autoCreate('conflict_claimed'); continue }
          await logUnmatched('property_already_claimed_this_run')
          totalConflicts++
          continue
        }

        if (target.fub_deal_id && target.fub_deal_id !== fubDealId) {
          if (canAutoCreate) { await autoCreate(`conflict_fub_${target.fub_deal_id}`); continue }
          await logUnmatched(`fub_deal_id_conflict_with_${target.fub_deal_id}`)
          totalConflicts++
          continue
        }

        // Matched!
        totalMatched++
        claimedInThisChunk.add(target.id)

        const updates: Record<string, any> = {}
        if (!target.fub_deal_id) updates.fub_deal_id = fubDealId
        if (newStage && newStage !== target.pipeline_stage) {
          updates.pipeline_stage = newStage
          const key = `${target.pipeline_stage || '(null)'} \u2192 ${newStage}`
          stageChangeSummary[key] = (stageChangeSummary[key] || 0) + 1
          totalStageUpdated++
        }
        if (archive && !target.is_archived) {
          updates.is_archived = true
          totalArchived++
        }

        if (Object.keys(updates).length > 0 && !dryRun) {
          const { error: ue } = await sb.from('ace_properties')
            .update(updates).eq('id', target.id)
          if (ue) errors.push(`Update prop ${target.id} deal ${fubDealId}: ${ue.message}`)
        }
      }

      nextUrl = json._metadata?.nextLink || null
      if (!nextUrl) break
      await new Promise(r => setTimeout(r, 50))
    }

    const done = nextUrl === null
    const elapsedMs = Date.now() - startMs
    const finalStatus = done ? (errors.length > 0 ? 'failed' : 'completed') : 'running'

    const updatePayload: any = {
      total_processed: totalProcessed, total_matched: totalMatched,
      total_stage_updated: totalStageUpdated, total_archived: totalArchived,
      total_unmatched: totalUnmatched, total_skipped: totalSkipped,
      stage_change_summary: {
        changes: stageChangeSummary,
        unknown_fub_stages: unknownStageSummary,
        contacts_created: totalContacts,
        low_confidence: totalLowConf,
        property_already_claimed: totalConflicts,
        addr_fallback_matched: totalAddrFallback,
        auto_created: totalAutoCreated,
        would_auto_create: totalWouldCreate,
      },
      error_details: errors.length > 0
        ? errors.join('\n').slice(0, 4000)
        : existingStats?.error_details || null,
      status: finalStatus,
    }
    if (done) updatePayload.ended_at = new Date().toISOString()
    await sb.from('ace_fub_sync_log').update(updatePayload).eq('id', syncLogId)

    return new Response(JSON.stringify({
      ok: errors.length === 0, sync_log_id: syncLogId, dry_run: dryRun, done,
      next_cursor: done ? null : nextUrl,
      chunk_processed: chunkProcessed,
      total_processed: totalProcessed, total_matched: totalMatched,
      total_stage_updated: totalStageUpdated, total_archived: totalArchived,
      total_unmatched: totalUnmatched, total_skipped: totalSkipped,
      total_contacts_created: totalContacts,
      total_low_confidence: totalLowConf,
      total_conflicts: totalConflicts,
      total_addr_fallback: totalAddrFallback,
      total_auto_created: totalAutoCreated,
      total_would_create: totalWouldCreate,
      stage_change_summary: stageChangeSummary,
      unknown_fub_stages: unknownStageSummary,
      elapsed_ms: elapsedMs,
      errors: errors.length ? errors.slice(0, 20) : undefined
    }, null, 2), {
      status: errors.length > 0 ? 207 : 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), elapsed_ms: Date.now() - startMs }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
