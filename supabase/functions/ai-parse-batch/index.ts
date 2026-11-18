import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const FIELDS = ['number_of_units','asking_price','offer_price','gross_revenue_monthly',
  'gross_revenue_yearly','noi','property_tax_monthly','insurance_monthly',
  'electric_monthly','water_sewer_monthly','occupancy_pct','total_building_sf',
  'year_built','units_1br','units_2br','units_3br','ai_clarifying_notes']

async function parseDeal(anthropicKey: string, notes: string, address: string) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content:
`Parse this commercial real estate deal note. Return ONLY valid JSON, no other text.

Property: ${address}
Notes: ${notes.substring(0, 1500)}

JSON (null if unknown, numbers only, monthly values, occupancy 0-100):
{"number_of_units":null,"asking_price":null,"offer_price":null,"gross_revenue_monthly":null,"gross_revenue_yearly":null,"noi":null,"property_tax_monthly":null,"insurance_monthly":null,"electric_monthly":null,"water_sewer_monthly":null,"occupancy_pct":null,"total_building_sf":null,"year_built":null,"units_1br":null,"units_2br":null,"units_3br":null,"ai_clarifying_notes":null}

ai_clarifying_notes = anything ambiguous needing owner confirmation, or null.`
      }]
    })
  })
  if (!resp.ok) {
    const t = await resp.text()
    throw new Error(`Claude ${resp.status}: ${t.substring(0,100)}`)
  }
  const data = await resp.json()
  const text = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { anthropic_key, batch_size = 50, offset = 0, reparse = false } = await req.json()

    if (!anthropic_key) {
      return new Response(JSON.stringify({ error: 'anthropic_key required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch next batch of unparsed deals
    let query = sb.from('ace_properties')
      .select('id, address, general_property_notes, property_description')
      .not('general_property_notes', 'is', null)
      .limit(batch_size)

    if (!reparse) {
      query = query.is('ai_parsed_at', null)
    }

    const { data: deals, error: fetchError } = await query
    if (fetchError) throw new Error(fetchError.message)
    if (!deals || deals.length === 0) {
      return new Response(JSON.stringify({ done: true, message: 'All deals parsed!' }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // Process each deal with 600ms gap to stay under rate limits
    const results = { ok: 0, err: 0, errors: [] as string[] }

    for (const deal of deals) {
      const notes = (deal.general_property_notes || deal.property_description || '').trim()
      if (notes.length < 30) {
        // Mark as parsed with empty result so we skip it next time
        await sb.from('ace_properties').update({ ai_parsed_at: new Date().toISOString() }).eq('id', deal.id)
        continue
      }

      try {
        const parsed = await parseDeal(anthropic_key, notes, deal.address || '')
        const update: Record<string, unknown> = { ai_parsed_at: new Date().toISOString() }
        FIELDS.forEach(f => { if (parsed[f] != null) update[f] = parsed[f] })
        await sb.from('ace_properties').update(update).eq('id', deal.id)
        results.ok++
      } catch (e) {
        results.err++
        results.errors.push(`${deal.address}: ${String(e).substring(0,80)}`)
        // Still mark as attempted so we don't retry failed ones endlessly
        // Unless it's a rate limit — don't mark those
        if (!String(e).includes('429') && !String(e).includes('rate_limit')) {
          await sb.from('ace_properties').update({ ai_parsed_at: new Date().toISOString() }).eq('id', deal.id)
        }
      }

      // 700ms between each call = ~85 deals/minute, well under rate limits
      await new Promise(r => setTimeout(r, 700))
    }

    // Check how many are left
    const { count } = await sb.from('ace_properties')
      .select('*', { count: 'exact', head: true })
      .is('ai_parsed_at', null)
      .not('general_property_notes', 'is', null)

    return new Response(JSON.stringify({
      done: false,
      batch_processed: deals.length,
      ok: results.ok,
      err: results.err,
      remaining: count || 0,
      errors: results.errors,
      next_offset: offset + batch_size
    }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
