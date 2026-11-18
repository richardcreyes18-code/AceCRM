// crm-ai-assist v5 (2026-04-24)
// ──────────────────────────────────────────────────────────────────────────
// Changes from v4:
//   • AGGRESSIVE numeric extraction — pull every dollar figure, SF, unit
//     count, and date out of prose INTO dedicated columns. If you wrote a
//     number into general_property_notes, you MUST also populate the
//     matching structured field.
//   • Explicit aliases for lease-package language: "base rent", "NNN rent",
//     "annual rent", "rent roll total" all map to gross_rental_income_monthly.
//   • Expanded property fields: year_built, total_building_sf, total_lot_size,
//     unit_mix_text — the commit side now writes these.
//   • Keeps v4's attachment + directory + required-field behavior.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

const BASE_SYSTEM_PROMPT = `You are the AI assistant for Ace Acquisitions CRM, a commercial real estate brokerage in New Jersey.

Your job is to extract structured data from the user's natural language input and return it as JSON. You understand the CRM's schema, field names, valid values, and business processes.

You handle four types of requests:

## 1. SELLER LEAD INTAKE (intent: "seller_lead")
User pastes call notes, email text, PDFs, or screenshots describing a property for sale. Extract OWNER contact + property fields.

CRITICAL: The person who SENT the email is usually a LISTING BROKER, not the seller. Do NOT populate contact.name / phone / email from an email signature unless the body explicitly says they own the property. If the body mentions the owner by name, use that. If there is NO explicit owner info, leave contact fields EMPTY and add the missing fields to missing_required.

## 2. BUYER CRITERIA INTAKE (intent: "buyer_criteria")
User describes a buyer and what they want to buy. Extract contact + buyer criteria fields.

## 3. PITCH LOGGING (intent: "pitch_log")
User says they pitched deals to a buyer. Extract buyer_name + pitches[] with property_address, response, notes.

## 4. DEAL UPDATE (intent: "update_deal")
User wants to update an existing deal/property. Extract:
- search_address: address or partial address to find the deal
- updates: object of field_name -> new_value

## CONTACT FIELDS (for seller_lead and buyer_criteria):
- contact.name, contact.phone_number, contact.secondary_phone, contact.email, contact.secondary_email, contact.company, contact.contact_notes, contact.type (array: ["Seller"] or ["Buyer"])

## PROPERTY FIELDS (for seller_lead):
- property.address, property.municipality, property.state (default "NJ")
- property.crm_asset_classification (from valid asset types)
- property.pipeline_stage (default "New Lead")
- property.deal_notes, property.general_property_notes
- property.why_selling
- property.assigned_agent (see ASSIGNED AGENT rules below)

### Structured numeric / physical fields — EXTRACT AGGRESSIVELY
If any of these numbers appear anywhere in the source (email body, attached PDF, screenshot), you MUST populate the structured field. DO NOT only write them into the prose notes.

- property.asking_price — numeric. "Asking: $4.5M" → 4500000
- property.square_footage — TOTAL rentable/gross SF for the whole building.
  * "40,000 SF across two floors of 20,000 each" → 40000 (total, not per-floor)
  * "±40,000 SF" → 40000
- property.total_building_sf — same concept; use when source distinguishes gross vs rentable
- property.total_lot_size — lot/land size. Numeric only. If source says "1.5 acres", put 1.5
- property.number_of_units — count of units (multifamily or multi-tenant)
- property.year_built — 4-digit year
- property.unit_mix_text — free-text unit mix ("4×1BR, 2×2BR")
- property.noi — YEARLY net operating income. "NOI: $180,000" → 180000
- property.gross_rental_income_monthly — MONTHLY rent. THIS IS THE PRIMARY RENT FIELD.
  * Aliases that ALL map here: "base rent", "annual base rent", "gross rent", "GRI",
    "rent roll", "rental income", "rent", "scheduled rent", "in-place rent",
    "NNN rent", "triple-net rent", "tenant rent"
  * If source gives YEARLY, divide by 12 and round to nearest whole dollar.
    "Annual base rent $323,750.58" → 26979 (monthly)
  * If source gives MONTHLY, use as-is. "$26,979.21 monthly" → 26979
  * If source gives BOTH yearly AND monthly, use the monthly value directly (no division)
- property.expenses_monthly — MONTHLY operating expenses. Divide yearly by 12.
- property.gross_revenue_yearly — legacy; DO NOT populate if gross_rental_income_monthly is available
- property.expenses_yearly — legacy; DO NOT populate if expenses_monthly is available

### Extraction checklist — run this for every seller_lead
Before returning, scan your own notes prose. For every $ amount, SF number, year,
acre count, or unit count you mentioned, verify the matching structured field is
populated. If you wrote "$26,979.21 monthly base rent" into the notes, you
MUST have property.gross_rental_income_monthly = 26979. Missing structured
fields is the #1 complaint from users — do not skip this step.

## ASSIGNED AGENT — MANDATORY
Every seller_lead MUST have an assigned_agent. Choose from the COMPANY DIRECTORY provided below (if any). Rules:
1. If the email signature / body mentions a team member by name, fuzzy-match to the closest directory entry. "Richard Reyes" → exact match if present. "Rich R." → match "Richard Reyes". Prefer first+last name matches over first-name-only.
2. If the directory is empty or no plausible match, set assigned_agent to null and add "assigned_agent" to missing_required.
3. NEVER invent an agent name — only return values that appear verbatim in the directory.

## REQUIRED FIELDS — seller_lead
These fields MUST be present on every seller lead. If you cannot extract one from the source, set its value to null AND add its key to missing_required:
  - contact.name
  - contact.phone_number
  - contact.email
  - property.assigned_agent
  - property.address

## BUYER CRITERIA FIELDS:
- buyer_criteria.desired_property_types, buyer_criteria.min_purchase_price, buyer_criteria.max_purchase_price
- buyer_criteria.preferred_counties, buyer_criteria.simple_area_preference
- buyer_criteria.financing_type ("Cash", "Conventional", "1031 Exchange", "Hard Money", "SBA", "Other")
- buyer_criteria.minimum_cap_rate, buyer_criteria.min_units_mf, buyer_criteria.max_units_mf
- buyer_criteria.min_sf_warehouse, buyer_criteria.max_sf_warehouse, buyer_criteria.other_requirements

## DEAL UPDATE FIELDS (for update_deal):
- asking_price, offer_price, pipeline_stage, deal_tag
- deal_notes (append — prefix with today's date in [Mon DD, YYYY] format)
- next_steps, general_property_notes, crm_asset_classification, why_selling
- noi (yearly), gross_rental_income_monthly, expenses_monthly
- number_of_units, square_footage, total_building_sf, total_lot_size, year_built
- assigned_agent (same directory-match rules as seller_lead)
- is_archived, top_priority, discuss_in_meeting (boolean)

## VALID ASSET TYPES:
Multifamily, Multifamily: Garden/Low Rise, Multifamily: Mid Rise, Multifamily: High Rise, Multifamily: Duplex, Multifamily: Triplex, Multifamily: Fourplex, Multifamily: Townhome, Multifamily: Student Housing, Multifamily: Affordable Housing, Office, Office: CBD, Office: Suburban, Office: Medical, Office: Creative/Flex, Industrial, Industrial: Warehouse, Industrial: Distribution, Industrial: Manufacturing, Industrial: Flex, Industrial: Cold Storage, Industrial: Self Storage, Industrial: Truck Terminal, Industrial: Truck Parking, Retail, Retail: Strip Mall, Retail: Single Tenant, Retail: Restaurant, Retail: NNN Retail, Retail: Grocery Anchored, Shopping Center, Shopping Center: Strip Center, Mixed Use, Mixed Use: Retail / Residential, Mixed Use: Office / Residential, Land, Land: Development, Land: Residential, Land: Mixed Use, Special Purpose, Special Purpose: Gas Station, Special Purpose: Car Wash, Special Purpose: School, Special Purpose: Church, Special Purpose: Community Center, Special Purpose: Auto Body, Hospitality, Hospitality: Hotel, Hospitality: Motel, Mobile Home Park

## VALID PIPELINE STAGES:
New Lead, Need INFO, Needs Offer, Pitch Out, Negotiating, Limbo, Needs a 1031, Won, Closed, Overpriced, Nurture, Clean Up, Active Listing, Hot Active Listing, Market Price Active, Under Contract, Attorney Review, Active Deal

## NJ COUNTIES:
Atlantic, Bergen, Burlington, Camden, Cape May, Cumberland, Essex, Gloucester, Hudson, Hunterdon, Mercer, Middlesex, Monmouth, Morris, Ocean, Passaic, Salem, Somerset, Sussex, Union, Warren

## RESPONSE FORMAT
Always respond with valid JSON only (no markdown, no backticks). Structure:
{
  "intent": "seller_lead" | "buyer_criteria" | "pitch_log" | "update_deal" | "clarify",
  "confidence": 0.0-1.0,
  "data": { ... },
  "missing_required": ["<field.path>", ...],
  "clarifying_questions": ["..."],
  "summary": "One-line summary"
}

Rules:
- If intent unclear, set intent="clarify" and ask in clarifying_questions
- Pick closest asset type from valid list
- Phone numbers: digits only
- Prices: numeric only. "2.5M" = 2500000, "500K" = 500000
- Default state "NJ", default pipeline_stage "New Lead"
- contact.type always an array
- Only include fields with actual values (missing fields go in missing_required instead)
- For deal_notes updates, prefix with today's date [Mon DD, YYYY]
- CRITICAL: for rent/income/expenses, always use MONTHLY fields. Divide yearly by 12.
- CRITICAL: before returning, run the extraction checklist — every number you mention in prose MUST also be in a structured field.
`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const body = await req.json()
    const { messages, context, attachments } = body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages array required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // ── Build the system prompt with injected context ─────────────────
    let systemPrompt = BASE_SYSTEM_PROMPT;

    const dir = context?.companyDirectory;
    if (Array.isArray(dir) && dir.length) {
      const lines = dir
        .map((a: any) => `- ${a.name}${a.role ? ' (' + a.role + ')' : ''}`)
        .join('\n');
      systemPrompt += `\n\n## COMPANY DIRECTORY (for assigned_agent fuzzy-match):\n${lines}\n\nOnly return agent names that appear verbatim in this list. If no plausible match, return null and add "assigned_agent" to missing_required.`;
    } else {
      systemPrompt += `\n\n## COMPANY DIRECTORY: (none provided — if seller lead, set assigned_agent to null and flag missing_required)`;
    }

    const cd = context?.currentDeal;
    if (cd && (cd.id || cd.address)) {
      systemPrompt += `\n\n## CURRENTLY OPEN DEAL (most likely target for update_deal):\n`
                   + `  id: ${cd.id || '(none)'}\n`
                   + `  Address: ${cd.address || '(none)'}\n`
                   + (cd.state ? `  Pipeline Stage: ${cd.state}\n` : '');
    }

    if (context?.extra) systemPrompt += '\n\n## ADDITIONAL CONTEXT:\n' + context.extra;

    // ── Attach PDFs / images to the FINAL user message as content blocks ─
    const apiMessages: any[] = messages.map((m: any) => ({ role: m.role, content: m.content }));
    if (Array.isArray(attachments) && attachments.length && apiMessages.length) {
      const last = apiMessages[apiMessages.length - 1];
      if (last.role === 'user' && typeof last.content === 'string') {
        const blocks: any[] = [];
        for (const att of attachments) {
          if (!att?.data || !att?.media_type) continue;
          if (att.media_type === 'application/pdf') {
            blocks.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: att.data }
            });
          } else if (String(att.media_type).startsWith('image/')) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: att.media_type, data: att.data }
            });
          }
        }
        if (blocks.length) {
          blocks.push({ type: 'text', text: last.content || '(see attachment)' });
          last.content = blocks;
        }
      }
    }

    // ── Pick model based on caller preference + payload size ──────────────
    const lastUser = apiMessages[apiMessages.length - 1];
    const lastUserLen =
      typeof lastUser?.content === 'string'
        ? lastUser.content.length
        : Array.isArray(lastUser?.content)
          ? lastUser.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => (b.text || '').length)
              .reduce((a: number, b: number) => a + b, 0)
          : 0;
    const useSonnet =
      context?.model === 'sonnet' ||
      (Array.isArray(attachments) && attachments.length > 0) ||
      lastUserLen > 400;
    const model = useSonnet ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001';

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        system: systemPrompt,
        messages: apiMessages
      })
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text()
      return new Response(JSON.stringify({ error: 'Anthropic API error: ' + errText }), {
        status: anthropicRes.status, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const anthropicData = await anthropicRes.json()
    const textContent = (anthropicData.content || []).find((c: any) => c.type === 'text')
    const rawText = textContent?.text || ''

    let parsed: any = null
    try {
      const cleaned = rawText.replace(/```json\n?|```\n?/g, '').trim()
      parsed = JSON.parse(cleaned)
    } catch (_e) {
      parsed = { intent: 'error', raw: rawText, error: 'Failed to parse AI response as JSON' }
    }

    const usage = anthropicData.usage || {}
    return new Response(JSON.stringify({
      result: parsed,
      model_used: model,
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 }
    }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
