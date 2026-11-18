// fub-templates-sync v2 — pull email templates from FUB into ace_email_templates.
// v2: maps `folder` from `categories[0].name` (the FUB shape).
//   POST /functions/v1/fub-templates-sync           → full sync
//   POST /functions/v1/fub-templates-sync?limit=500 → cap (for testing)
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
    const maxRows = Number(url.searchParams.get('limit') || '5000')

    const fubHeaders = {
      'Authorization': 'Basic ' + btoa(apiKey + ':'),
      'X-System': 'AceCRM', 'X-System-Key': 'ace-acquisitions-crm',
      'Content-Type': 'application/json'
    }

    let upserted = 0, pages = 0, totalFetched = 0
    const errors: string[] = []
    let nextUrl: string | null = `https://api.followupboss.com/v1/templates?limit=100`

    while (nextUrl && totalFetched < maxRows) {
      let res: Response
      try { res = await fetch(nextUrl, { headers: fubHeaders }) }
      catch (e) { errors.push(`Network error page ${pages}: ${String(e)}`); break }
      if (!res.ok) {
        if (res.status === 429) { await new Promise(r => setTimeout(r, 11000)); continue }
        errors.push(`FUB ${res.status} on page ${pages}: ${(await res.text()).slice(0, 300)}`)
        break
      }
      const json = await res.json()
      const items: any[] = Array.isArray(json) ? json : (json.templates || json.emailTemplates || json.items || json.data || [])
      pages++
      if (!Array.isArray(items)) { errors.push(`Unexpected shape on page ${pages}`); break }
      if (items.length === 0) break

      const nowIso = new Date().toISOString()
      const rows = items.map((t: any) => {
        const cats = Array.isArray(t.categories) ? t.categories : []
        const folder = cats[0]?.name || null
        return {
          fub_template_id: t.id, name: t.name || '(no name)', subject: t.subject ?? null,
          body_html: t.body ?? t.bodyHtml ?? t.html ?? null,
          body_plain: t.bodyPlain ?? t.plainBody ?? null,
          merge_fields: t.mergeFields ?? null, folder,
          is_shared: typeof t.isShared === 'boolean' ? t.isShared : null,
          fub_created_at: t.created ?? null, fub_updated_at: t.updated ?? null,
          raw_data: t, last_synced_at: nowIso, updated_at: nowIso
        }
      }).filter((r: any) => r.fub_template_id != null)

      if (rows.length === 0) { errors.push(`Page ${pages}: items had no usable id field`); break }

      const { error: upsertErr } = await sb.from('ace_email_templates')
        .upsert(rows, { onConflict: 'fub_template_id', ignoreDuplicates: false })
      if (upsertErr) { errors.push(`DB upsert error page ${pages}: ${upsertErr.message}`); break }

      upserted += rows.length
      totalFetched += items.length
      nextUrl = json._metadata?.nextLink || json._metadata?.next || null
      await new Promise(r => setTimeout(r, 50))
    }

    return new Response(JSON.stringify({
      ok: errors.length === 0, upserted, total_fetched: totalFetched, pages,
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
