// fub-calls-sync v2 — cursor pagination via nextLink
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
      return new Response(JSON.stringify({ error: 'FUB_API_KEY not configured' }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const url = new URL(req.url)
    const since = url.searchParams.get('since')
    const maxCalls = Number(url.searchParams.get('limit') || '200000')

    const fubHeaders = {
      'Authorization': 'Basic ' + btoa(apiKey + ':'),
      'X-System': 'AceCRM', 'X-System-Key': 'ace-acquisitions-crm',
      'Content-Type': 'application/json'
    }

    let inserted = 0, pages = 0, totalFetched = 0
    const errors: string[] = []

    const firstParams = new URLSearchParams({ limit: '100', sort: '-created' })
    if (since) firstParams.set('updatedAfter', since)

    let nextUrl: string | null = `https://api.followupboss.com/v1/calls?${firstParams.toString()}`

    while (nextUrl && totalFetched < maxCalls) {
      let res: Response
      try { res = await fetch(nextUrl, { headers: fubHeaders }) }
      catch (e) { errors.push(`Network error page ${pages}: ${String(e)}`); break }

      if (!res.ok) {
        if (res.status === 429) { await new Promise(r => setTimeout(r, 11000)); continue }
        errors.push(`FUB ${res.status} on page ${pages}: ${(await res.text()).slice(0, 300)}`)
        break
      }

      const json = await res.json()
      const calls = json.calls || []
      pages++
      if (calls.length === 0) break

      const rows = calls.map((c: any) => ({
        id: c.id, person_id: c.personId || null,
        created_at: c.created || null, updated_at: c.updated || null,
        direction: c.isIncoming ? 'inbound' : 'outbound',
        outcome: c.outcome || null, duration: c.duration || null,
        note: c.note || null, summary: null, transcription: null, recording_url: null,
        phone: c.phone || null, user_id: c.userId || null,
        raw: c, synced_at: new Date().toISOString()
      }))

      const { error: upsertErr } = await sb.from('fub_calls').upsert(rows, { onConflict: 'id', ignoreDuplicates: false })
      if (upsertErr) { errors.push(`DB upsert error page ${pages}: ${upsertErr.message}`); break }

      inserted += rows.length
      totalFetched += calls.length
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
