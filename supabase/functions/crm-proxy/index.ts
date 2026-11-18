import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const body = req.method === 'POST' ? await req.json().catch(() => null) : null
    const url = new URL(req.url)
    const table = url.searchParams.get('table')
    const method = url.searchParams.get('method') || req.method
    const idRaw = url.searchParams.get('id')
    const rpc = url.searchParams.get('rpc')

    // ── v102.37: RPC passthrough ────────────────────────────
    if (rpc) {
      const { data, error } = await sb.rpc(rpc, body || {})
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      return new Response(JSON.stringify(data), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    if (!table) {
      return new Response(JSON.stringify({ error: 'table or rpc required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    // v9: strip the 'eq.' prefix from id if present.
    const id = idRaw && idRaw.startsWith('eq.') ? idRaw.slice(3) : idRaw

    // v10 (2026-04-19): URL-decode filter values, but fall back to the raw
    // string if decodeURIComponent throws (e.g. ilike.%foo% where %foo isn't
    // a valid escape).
    const safeDecode = (s: string): string => {
      try { return decodeURIComponent(s) } catch { return s }
    }

    let result, error

    if (method === 'GET') {
      let query = sb.from(table).select(url.searchParams.get('select') || '*')
      const limit = url.searchParams.get('limit')
      const offset = url.searchParams.get('offset')
      const order = url.searchParams.get('order')
      if (limit) query = query.limit(Number(limit))
      if (offset && limit) query = query.range(Number(offset), Number(offset) + Number(limit) - 1)
      // v13 (2026-04-25): support comma-separated multi-column orders so the
      // load path can use a stable tiebreak like
      // `order=created_at.desc,id.asc`. The previous version split on '.'
      // once and parsed `dir='desc,id'`, which silently turned every
      // multi-column desc query into ASCENDING (because 'desc,id' !==
      // 'desc'). Combined with offset+limit pagination on ~9k rows, the
      // resulting unstable order leaked / dropped rows across pages so
      // allDeals ended up missing ~2200 of 8300 rows.
      if (order) {
        for (const clause of order.split(',')) {
          const [col, dir] = clause.trim().split('.')
          if (col) query = query.order(col, { ascending: dir !== 'desc' })
        }
      }
      if (id) {
        if (id.startsWith('in.(')) {
          const ids = id.slice(4, -1).split(',').map(x => safeDecode(x.trim()))
          query = query.in('id', ids)
        } else {
          query = query.eq('id', id)
        }
      }
      // ── v8: OR filter support ─────────────────────────────
      const orParam = url.searchParams.get('or')
      if (orParam) {
        let raw = orParam
        if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
        query = query.or(raw)
      }
      // All other filter params
      for (const [k, v] of url.searchParams.entries()) {
        if (['table','method','id','select','limit','offset','order','rpc','or'].includes(k)) continue
        if (v === 'is.null')         { query = query.is(k, null) }
        else if (v === 'not.is.null') { query = query.not(k, 'is', null) }
        else if (v === 'eq.true')     { query = query.eq(k, true) }
        else if (v === 'eq.false')    { query = query.eq(k, false) }
        else if (v.startsWith('eq.'))   { query = query.eq(k, safeDecode(v.slice(3))) }
        else if (v.startsWith('neq.'))  { query = query.neq(k, safeDecode(v.slice(4))) }
        else if (v.startsWith('ilike.')){ query = query.ilike(k, safeDecode(v.slice(6))) }
        else if (v.startsWith('like.')) { query = query.like(k, safeDecode(v.slice(5))) }
        else if (v.startsWith('in.('))  { query = query.in(k, v.slice(4,-1).split(',').map(x => safeDecode(x.trim()))) }
        else if (v.startsWith('gte.'))  { query = query.gte(k, v.slice(4)) }
        else if (v.startsWith('lte.'))  { query = query.lte(k, v.slice(4)) }
      }
      ;({ data: result, error } = await query)

    } else if (method === 'PATCH' && id && body) {
      const { data, error: e } = await sb.from(table).update(body).eq('id', id).select()
      result = data?.[0] || {}; error = e

    } else if (method === 'POST' && body) {
      const { data, error: e } = await sb.from(table).insert(body).select()
      result = data?.[0] || {}; error = e

    } else if (method === 'DELETE' && id) {
      const { error: e } = await sb.from(table).delete().eq('id', id)
      result = { deleted: true }; error = e

    } else {
      return new Response(JSON.stringify({ error: 'Invalid: method=' + method + ' id=' + id }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
