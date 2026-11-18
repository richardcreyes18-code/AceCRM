// ai-clean-description — generate a clean, polished property description
// from the raw merged notes on a property. Reads general_property_notes,
// deal_notes, ai_clarifying_notes, financial_property_notes, location_description,
// asking_price_explanation, ace_starter_note, accepted_by_seller_note, pitch_out_note.
// Writes the result to ace_properties.property_description (overwrites). Returns
// the generated text so the frontend can show a confirmation toast.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json()
    const property_id: string | undefined = body.property_id
    const dry_run: boolean = !!body.dry_run

    if (!property_id) {
      return new Response(JSON.stringify({ error: 'property_id is required' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const anthropic_key = Deno.env.get('ANTHROPIC_API_KEY')?.trim()
    if (!anthropic_key) {
      return new Response(JSON.stringify({
        error: 'ANTHROPIC_API_KEY is not set as a Supabase Edge Function secret.'
      }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: row, error: rowErr } = await sb.from('ace_properties').select('*').eq('id', property_id).single()
    if (rowErr || !row) {
      return new Response(JSON.stringify({ error: 'property not found', details: rowErr?.message }),
        { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const r = row as any
    const sourceCols = [
      'general_property_notes', 'deal_notes', 'ai_clarifying_notes',
      'financial_property_notes', 'location_description',
      'asking_price_explanation', 'ace_starter_note',
      'accepted_by_seller_note', 'pitch_out_note', 'ace_chat_summary',
    ]
    const sourceText = sourceCols.map(c => {
      const v = r[c]
      if (!v || !String(v).trim()) return ''
      return `--- ${c} ---\n${String(v).trim()}`
    }).filter(Boolean).join('\n\n').slice(0, 12000)

    if (!sourceText.trim()) {
      return new Response(JSON.stringify({
        error: 'No source notes to summarize. Add details to General Property Notes (Notes tab) first.'
      }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // Light asset-class hint helps the model pick the right framing.
    const assetClass = r.crm_asset_classification || r.simple_text_property_type || '(unknown)'
    const address = r.address || '(unknown)'
    const askingPrice = r.asking_price || null

    const prompt = `You are an expert commercial real-estate broker writing a clean, polished property description for a CRE listing / Offering Memorandum.

PROPERTY: ${address}
ASSET CLASS: ${assetClass}
${askingPrice ? `ASKING PRICE: $${Number(askingPrice).toLocaleString()}` : ''}

RAW SOURCE NOTES (merged from multiple FUB / CRM imports — may contain duplicates, contradictions, typos, and broker shorthand):

${sourceText}

=== END SOURCE ===

INSTRUCTIONS:
1. Write a clean, polished Property Description in 3-6 short paragraphs.
2. Lead with the strongest 1-2 facts (asset type, size, lease structure, key tenants).
3. Cover: property type, square footage, key physical features (loading docks, ceiling heights, office/warehouse split for industrial; unit mix for MF; etc.), tenancy summary, lease structure if applicable.
4. Plain professional CRE broker tone. Active voice. Concise sentences.
5. NO emoji, NO marketing fluff ("once-in-a-lifetime", "turn-key", "prestigious"), NO superlatives, NO bullet points.
6. Resolve duplicates and contradictions silently — pick the most consistent / latest-looking value. Don't mention the source noise.
7. NEVER invent facts not in the source. If a number conflicts (e.g. tenant 1 rent listed as both 10k and 10.5k), state the range or pick the more frequently-mentioned value.
8. Output the description text ONLY — no preamble, no headers, no "Here's a description...".`

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropic_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!claudeResp.ok) {
      const errText = await claudeResp.text()
      return new Response(JSON.stringify({ error: `Claude ${claudeResp.status}: ${errText.slice(0,400)}` }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const claudeData = await claudeResp.json()
    const description = (claudeData.content?.[0]?.text || '').trim()
    if (!description) {
      return new Response(JSON.stringify({ error: 'Claude returned no text', stop_reason: claudeData.stop_reason }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (!dry_run) {
      const { error: upErr } = await sb.from('ace_properties').update({
        property_description: description,
        ai_parsed_at: new Date().toISOString(),
      }).eq('id', property_id)
      if (upErr) {
        return new Response(JSON.stringify({ error: 'Update failed: ' + upErr.message, description }),
          { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    return new Response(JSON.stringify({
      ok: true, dry_run,
      description,
      source_chars: sourceText.length,
      response_chars: description.length,
    }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), stack: (err as Error).stack }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
