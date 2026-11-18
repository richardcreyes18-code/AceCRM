// Probe v9 — count all Hot Active deals in FUB and check against our CRM

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const apiKey = Deno.env.get('FUB_API_KEY')!
  const authHeader = 'Basic ' + btoa(apiKey + ':')
  const fubHeaders = {
    'Authorization': authHeader,
    'X-System': 'AceCRM', 'X-System-Key': 'ace-acquisitions-crm',
    'Content-Type': 'application/json'
  }

  const hotActives: any[] = []
  const allStageCounts: Record<string, number> = {}
  let nextUrl: string | null = 'https://api.followupboss.com/v1/deals?limit=100&sort=-created'
  let pages = 0
  while (nextUrl && pages < 120) {
    const r = await fetch(nextUrl, { headers: fubHeaders })
    if (!r.ok) break
    const j = await r.json()
    const deals = j.deals || []
    if (deals.length === 0) break
    for (const d of deals) {
      if (d.pipelineName === 'Buyers') continue
      const key = `${d.pipelineName || '?'} :: ${d.stageName || '?'}`
      allStageCounts[key] = (allStageCounts[key] || 0) + 1
      if (d.stageName === 'Hot Active Listing' && d.status === 'Active') {
        hotActives.push({
          id: d.id, name: d.name, pipeline: d.pipelineName, status: d.status,
          price: d.price, owner: d.people?.[0]?.name || null,
          ownerFubId: d.people?.[0]?.id || null
        })
      }
    }
    nextUrl = j._metadata?.nextLink || null
    pages++
    await new Promise(r => setTimeout(r, 30))
  }

  return new Response(JSON.stringify({
    total_hot_active_in_fub: hotActives.length, hot_actives: hotActives, pages,
    top_stages_nonbuyer: Object.entries(allStageCounts).sort((a,b)=>b[1]-a[1]).slice(0, 20)
  }, null, 2), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } })
})
