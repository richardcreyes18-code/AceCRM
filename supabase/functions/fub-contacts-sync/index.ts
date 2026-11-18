// fub-contacts-sync v1 — cursor-paginated FUB people sync
// Usage:
//   POST /functions/v1/fub-contacts-sync            → full sync
//   POST /functions/v1/fub-contacts-sync?since=ISO  → incremental (updatedAfter)
//   POST /functions/v1/fub-contacts-sync?limit=500  → cap (for testing)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const startMs = Date.now()

  try {
    const apiKey = Deno.env.get('FUB_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'FUB_API_KEY not configured' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const url = new URL(req.url)
    const since = url.searchParams.get('since')
    const maxRows = Number(url.searchParams.get('limit') || '200000')

    const fubHeaders = {
      'Authorization': 'Basic ' + btoa(apiKey + ':'),
      'X-System': 'AceCRM',
      'X-System-Key': 'ace-acquisitions-crm',
      'Content-Type': 'application/json'
    }

    let inserted = 0, pages = 0, totalFetched = 0
    const errors: string[] = []

    const firstParams = new URLSearchParams({
      limit: '100',
      sort: '-updated',
      includeTrash: 'false'
    })
    if (since) firstParams.set('updatedAfter', since)

    let nextUrl: string | null = `https://api.followupboss.com/v1/people?${firstParams.toString()}`

    while (nextUrl && totalFetched < maxRows) {
      let res: Response
      try {
        res = await fetch(nextUrl, { headers: fubHeaders })
      } catch (e) {
        errors.push(`Network error page ${pages}: ${String(e)}`)
        break
      }

      if (!res.ok) {
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 11000))
          continue
        }
        const body = await res.text()
        errors.push(`FUB ${res.status} on page ${pages}: ${body.slice(0, 300)}`)
        break
      }

      const json = await res.json()
      const people = json.people || []
      pages++
      if (people.length === 0) break

      const rows = people.map((p: any) => ({
        id: p.id, name: p.name || null, first_name: p.firstName || null,
        last_name: p.lastName || null, type: p.type || null, stage: p.stage || null,
        source: p.source || null, assigned_to: p.assignedTo || null,
        assigned_user_id: p.assignedUserId || null,
        tags: Array.isArray(p.tags) ? p.tags : null,
        phones: p.phones || null, emails: p.emails || null, addresses: p.addresses || null,
        price: p.price || null, deal_status: p.dealStatus || null, deal_stage: p.dealStage || null,
        deal_name: p.dealName || null, deal_price: p.dealPrice || null,
        created_at: p.created || null, updated_at: p.updated || null,
        last_activity: p.lastActivity || null, synced_at: new Date().toISOString()
      }))

      const { error: upsertErr } = await sb.from('fub_contacts')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: false })
      if (upsertErr) { errors.push(`DB upsert error page ${pages}: ${upsertErr.message}`); break }

      inserted += rows.length
      totalFetched += people.length
      nextUrl = json._metadata?.nextLink || json._metadata?.next || null
      await new Promise(r => setTimeout(r, 50))
    }

    return new Response(JSON.stringify({
      ok: errors.length === 0, upserted: inserted, total_fetched: totalFetched, pages,
      elapsed_ms: Date.now() - startMs, errors: errors.length ? errors : undefined
    }), {
      status: errors.length ? 207 : 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), elapsed_ms: Date.now() - startMs }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
