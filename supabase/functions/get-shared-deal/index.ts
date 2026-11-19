// get-shared-deal — buyer-facing portal data endpoint.
//
// Loads a deal by share token (public, no auth), applies NDA-gated field
// visibility, optionally logs a view, and accepts an offer submission.
//
// Endpoints (all under this one function):
//   GET  ?token=<t>                        → deal + share settings (no logging)
//   GET  ?token=<t>&log_view=1&viewer_email=... → same, but record a view row
//   POST { token, action:'submit_offer', ... }  → create ace_deal_offers row
//   POST { token, action:'nda_accept', viewer_email }
//   POST { token, action:'view_ping', view_id, duration_seconds, scroll_depth_pct }
//
// Verify_jwt is OFF. We use the service-role key inside the function and
// filter by token so anon traffic can read exactly one shared deal.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// Visible-on-portal columns. Sensitive internal notes stay in the CRM only.
const DEAL_FIELDS = [
  'id', 'address', 'state', 'simple_county',
  'property_type_text', 'legacy_property_type', 'crm_asset_classification',
  'property_class', 'property_condition', 'location_class', 'location_type',
  'property_highlights', 'property_description', 'location_description',
  'asking_price', 'asking_price_status', 'asking_price_explanation',
  'offer_price', 'noi', 'cap_rate_crm', 'cap_rate_proforma_crm',
  'gross_revenue_monthly', 'gross_revenue_yearly',
  'pro_forma_gross_revenue_yearly', 'expenses_yearly',
  'number_of_units', 'no_of_units', 'total_building_sf', 'square_footage',
  'net_rentable_sf', 'year_built', 'year_renovated', 'no_of_stories',
  'no_of_parking_spaces', 'parking_type', 'construction_type', 'exterior',
  'hvac', 'roof_type', 'total_lot_size', 'lot_size_unit', 'occupancy_pct',
  'photo_attachments', 'main_photo_attachment_id', 'portal_overrides',
  'authorization_source', 'commission_structure', 'commission_rate_pct',
  // Address pieces hidden until NDA acceptance when hide_address = true:
  // we null `address` client-side in that case. The CRM-side tab is
  // responsible for recording the full address; nothing else private.
]

function clientIp(req: Request): string | null {
  const h = req.headers
  return (
    h.get('x-forwarded-for')?.split(',')[0].trim() ||
    h.get('x-real-ip') ||
    h.get('cf-connecting-ip') ||
    null
  )
}

async function loadShare(token: string) {
  const { data: share, error } = await sb
    .from('ace_deal_shares')
    .select('*')
    .eq('token', token)
    .maybeSingle()
  if (error) throw error
  return share
}

function shareStatus(share: any): { ok: boolean; code: number; msg?: string } {
  if (!share) return { ok: false, code: 404, msg: 'Not found' }
  if (!share.is_published) return { ok: false, code: 410, msg: 'Not published' }
  if (share.expires_at && new Date(share.expires_at) < new Date())
    return { ok: false, code: 410, msg: 'Link expired' }
  return { ok: true, code: 200 }
}

async function fetchDeal(dealId: string) {
  const { data, error } = await sb
    .from('ace_properties')
    .select(DEAL_FIELDS.join(','))
    .eq('id', dealId)
    .maybeSingle()
  if (error) throw error
  return data
}

function applyVisibility(deal: any, share: any, ndaAccepted: boolean) {
  if (!deal) return deal
  const out = { ...deal }
  // Apply user-authored portal overrides (per-field overwrite / hide).
  const ov = (deal.portal_overrides || {}) as Record<string, any>
  const hidden: string[] = ov.__hidden || []
  for (const k of hidden) out[k] = null
  for (const [k, v] of Object.entries(ov)) {
    if (k === '__hidden' || k === '__selected_photos') continue
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  // Filter photos down to the selected subset, if the user picked one.
  if (Array.isArray(ov.__selected_photos) && Array.isArray(out.photo_attachments)) {
    const sel = new Set(ov.__selected_photos)
    out.photo_attachments = out.photo_attachments.filter((p: any) => p && sel.has(p.id))
  }
  // Hide address until NDA accepted when gating is on.
  if (share.hide_address && !ndaAccepted) {
    out.address = null
    out.simple_county = out.simple_county // keep county + state as broad locator
  }
  // Strip internal-only metadata.
  delete out.portal_overrides
  return out
}

async function handleGet(url: URL, req: Request) {
  const token = url.searchParams.get('token')
  if (!token) return j({ error: 'Missing token' }, 400)
  const share = await loadShare(token)
  const st = shareStatus(share)
  if (!st.ok) return j({ error: st.msg }, st.code)

  const deal = await fetchDeal(share.deal_id)
  if (!deal) return j({ error: 'Deal missing' }, 404)

  const ndaAccepted = url.searchParams.get('nda_accepted') === '1' || !share.nda_required
  const filtered = applyVisibility(deal, share, ndaAccepted)

  let viewId: string | null = null
  if (url.searchParams.get('log_view') === '1' || url.searchParams.get('log_view') === 'true') {
    const viewerEmail = url.searchParams.get('viewer_email') || null
    const { data: view, error: vErr } = await sb
      .from('ace_deal_views')
      .insert({
        share_id: share.id,
        viewer_email: viewerEmail,
        ip_address: clientIp(req),
        user_agent: req.headers.get('user-agent') || null,
      })
      .select('id')
      .maybeSingle()
    if (!vErr && view) viewId = view.id
  }

  return j({
    deal: filtered,
    share: {
      token: share.token,
      nda_required: share.nda_required,
      hide_address: share.hide_address,
      expires_at: share.expires_at,
      view_count: share.view_count,
    },
    view_id: viewId,
  })
}

async function handlePost(req: Request) {
  const body = await req.json().catch(() => ({})) as any
  const token = body.token as string | undefined
  const action = body.action as string | undefined
  if (!token || !action) return j({ error: 'Missing token or action' }, 400)

  const share = await loadShare(token)
  const st = shareStatus(share)
  if (!st.ok) return j({ error: st.msg }, st.code)

  if (action === 'nda_accept') {
    const viewer_email = (body.viewer_email || '').trim().toLowerCase()
    if (!viewer_email || !viewer_email.includes('@'))
      return j({ error: 'Valid email required' }, 400)
    const { data: view, error: vErr } = await sb
      .from('ace_deal_views')
      .insert({
        share_id: share.id,
        viewer_email,
        ip_address: clientIp(req),
        user_agent: req.headers.get('user-agent') || null,
      })
      .select('id')
      .maybeSingle()
    if (vErr) return j({ error: vErr.message }, 500)
    return j({ ok: true, view_id: view?.id || null })
  }

  if (action === 'view_ping') {
    const view_id = body.view_id as string | undefined
    if (!view_id) return j({ ok: true })
    await sb
      .from('ace_deal_views')
      .update({
        duration_seconds: body.duration_seconds ?? null,
        scroll_depth_pct: body.scroll_depth_pct ?? null,
      })
      .eq('id', view_id)
      .eq('share_id', share.id)
    return j({ ok: true })
  }

  if (action === 'submit_offer') {
    const amount = Number(body.amount)
    if (!(amount > 0)) return j({ error: 'Offer amount required' }, 400)
    const buyer_name = (body.buyer_name || '').trim()
    const buyer_email = (body.buyer_email || '').trim().toLowerCase()
    if (!buyer_name || !buyer_email || !buyer_email.includes('@'))
      return j({ error: 'Buyer name and email required' }, 400)
    const financing = (body.financing || '').trim() || null
    const terms = (body.terms || '').trim() || null
    const closing_date = body.closing_date || null

    // Create an offer row (type='buyer_offer') so it shows up in the Offers tab.
    const offer_notes = [
      `Submitted via buyer portal by ${buyer_name} <${buyer_email}>.`,
      financing ? `Financing: ${financing}.` : null,
      terms ? `Terms: ${terms}.` : null,
      closing_date ? `Target close: ${closing_date}.` : null,
    ].filter(Boolean).join(' ')

    const { data: offer, error: oErr } = await sb
      .from('ace_deal_offers')
      .insert({
        deal_id: share.deal_id,
        offer_type: 'buyer_offer',
        amount,
        notes: offer_notes,
        offer_date: new Date().toISOString().slice(0, 10),
      })
      .select('id')
      .maybeSingle()
    if (oErr) return j({ error: oErr.message }, 500)

    // Mark the matching view (if we can find it) as made_offer=true.
    const view_id = body.view_id as string | undefined
    if (view_id) {
      await sb
        .from('ace_deal_views')
        .update({ made_offer: true })
        .eq('id', view_id)
        .eq('share_id', share.id)
    } else if (buyer_email) {
      await sb
        .from('ace_deal_views')
        .update({ made_offer: true })
        .eq('share_id', share.id)
        .eq('viewer_email', buyer_email)
    }

    return j({ ok: true, offer_id: offer?.id || null })
  }

  return j({ error: 'Unknown action' }, 400)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = new URL(req.url)
    if (req.method === 'GET')  return await handleGet(url, req)
    if (req.method === 'POST') return await handlePost(req)
    return j({ error: 'Method not allowed' }, 405)
  } catch (e) {
    return j({ error: String((e as Error).message || e) }, 500)
  }
})
