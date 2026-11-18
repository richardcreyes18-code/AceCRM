// crm-email-gen v2 (2026-04-24)
// v113.18: enforce inclusion of every caller-supplied field. If the agent
// checks a field in the template picker, it MUST appear in the generated
// email verbatim — no summarization ("multifamily in Belmar" when the full
// address '105 10th Ave' was provided), no dropping, no renaming.
// ──────────────────────────────────────────────────────────────────────────
// Request body:
// {
//   fields: { label: value, ... },   // already resolved & stringified by caller
//   signature: string,                // sign-off name (from Marketing settings)
//   tone: string,                     // tone description
//   extraInstructions?: string,       // user's optional tweaks (Marketing defaults + per-deal)
//   recipient?: { name?, company? }   // optional — personalizes greeting
// }
//
// Response:
// { email: "<markdown email text>", model_used, usage }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const fields: Record<string, unknown> = body?.fields || {};
    const signature: string = String(body?.signature || 'Richard Reyes, KW Commercial');
    const tone: string = String(body?.tone || 'Professional, concise, and compelling');
    const extraInstructions: string = String(body?.extraInstructions || '').trim();
    const recipient = body?.recipient || {};

    // Drop empty fields so the prompt only includes real data — this matches
    // the "skip missing details" behavior the Airtable template has.
    const populated: [string, string][] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (!s) continue;
      populated.push([k, s]);
    }

    if (!populated.length) {
      return new Response(JSON.stringify({
        error: 'No deal fields provided. Select at least one field to include in the email.'
      }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const fieldsBlock = populated.map(([k, v]) => `- ${k}: ${v}`).join('\n');

    const recipientLine = recipient?.name
      ? `The recipient is ${recipient.name}${recipient.company ? ' at ' + recipient.company : ''}. Address them by first name.`
      : 'Use a generic "Hi" opening — no specific recipient name.';

    // v113.18: explicit checklist language. The agent has already decided what
    // to include by checking boxes in the UI; our job here is copywriting,
    // not curation. Every supplied field must appear.
    const systemPrompt = `You write marketing emails for Ace Acquisitions CRM, a commercial real estate brokerage in New Jersey.

Your output is a complete email (subject line + body) ready to copy into an email client. Output format:

Subject: <one line>

<greeting>

<body — can include short bullet lists when useful>

<call to action>

<sign-off>
${signature}

HARD RULES — THESE ARE NOT NEGOTIABLE:
1. EVERY field listed under "Property details" below MUST appear in the email. The agent has explicitly selected these fields; dropping one is a bug. For example, if "Address: 105 10th Ave, Belmar, NJ 07719" is supplied, the email must contain the full address — not just "Belmar". If "# of Units: 4" is supplied, the email must say 4 units, not 2.
2. Use the VALUES EXACTLY as supplied. Do not round, relabel, translate, or approximate. If the value is "$1,750,000" use "$1,750,000", not "$1.75M" or "$1.7M".
3. Do NOT invent additional numbers or facts that are not in the list.
4. If a field feels awkward to weave into prose, put it in a short bullet list — but include it.
5. Never mention, apologize for, or flag missing information.
6. Tone: ${tone}.
7. Keep paragraphs tight — the goal is one scannable screen. Bullets are encouraged when you have 3+ quantitative data points.
8. Lead with the strongest selling point (biggest number, rare feature, or location advantage).
9. Close with a clear call to action: offer to share the OM, schedule a call, or set a tour.
10. Sign off exactly with: ${signature}

After writing, silently audit your draft: for every line in the "Property details" block, confirm its value appears somewhere in your email. If any are missing, rewrite before responding.
`;

    const userPrompt = `${recipientLine}

Property details — every one of these must appear in the email:
${fieldsBlock}

${extraInstructions ? `Additional instructions from the agent:\n${extraInstructions}\n\n` : ''}Write the email now. Remember: every detail above must appear verbatim in the output.`;

    // Sonnet 4.5 — worth the tokens for marketing copy.
    const model = 'claude-sonnet-4-5-20250929';

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return new Response(JSON.stringify({ error: 'Anthropic API error: ' + errText }), {
        status: anthropicRes.status, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const data = await anthropicRes.json();
    const textContent = (data.content || []).find((c: any) => c.type === 'text');
    const emailText = (textContent?.text || '').trim();

    const usage = data.usage || {};
    return new Response(JSON.stringify({
      email: emailText,
      model_used: model,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0
      }
    }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});
