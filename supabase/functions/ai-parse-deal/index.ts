import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deal_id, notes, address, anthropic_key } = await req.json()
    if (!deal_id || !notes || !anthropic_key) {
      return new Response(JSON.stringify({ error: 'Missing deal_id, notes, or anthropic_key' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // Call Anthropic API server-side (no CORS issues)
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropic_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content:
`Parse this commercial real estate deal note. Return ONLY valid JSON, no other text.

Property: ${address || 'unknown'}
Notes: ${notes.substring(0, 1500)}

JSON (null if unknown, numbers only no $ signs, monthly values, occupancy 0-100):
{"number_of_units":null,"asking_price":null,"offer_price":null,"gross_revenue_monthly":null,"gross_revenue_yearly":null,"noi":null,"property_tax_monthly":null,"insurance_monthly":null,"electric_monthly":null,"water_sewer_monthly":null,"occupancy_pct":null,"total_building_sf":null,"year_built":null,"units_1br":null,"units_2br":null,"units_3br":null,"ai_clarifying_notes":null}

ai_clarifying_notes = note anything ambiguous or needing owner confirmation. null if everything is clear.`
        }]
      })
    })

    if (!claudeResp.ok) {
      const errText = await claudeResp.text()
      return new Response(JSON.stringify({ error: `Claude ${claudeResp.status}: ${errText.substring(0,200)}` }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const claudeData = await claudeResp.json()
    const rawText = (claudeData.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(rawText)

    // Write results directly to Supabase
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const update: Record<string, unknown> = { ai_parsed_at: new Date().toISOString() }
    const fields = ['number_of_units','asking_price','offer_price','gross_revenue_monthly',
      'gross_revenue_yearly','noi','property_tax_monthly','insurance_monthly',
      'electric_monthly','water_sewer_monthly','occupancy_pct','total_building_sf',
      'year_built','units_1br','units_2br','units_3br','ai_clarifying_notes']
    fields.forEach(f => { if (parsed[f] != null) update[f] = parsed[f] })

    const { error: updateError } = await sb.from('ace_properties').update(update).eq('id', deal_id)
    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ ok: true, fields_set: Object.keys(update).length - 1, clarifying: parsed.ai_clarifying_notes }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
