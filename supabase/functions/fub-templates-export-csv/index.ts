// fub-templates-export-csv v1 — streams ace_email_templates as a CSV download.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '""'
  let s: string
  if (typeof v === 'object') {
    try { s = JSON.stringify(v) } catch { s = String(v) }
  } else { s = String(v) }
  return '"' + s.replace(/"/g, '""') + '"'
}

function stripHtml(html: string | null): string {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const url = new URL(req.url)
    const folderFilter = url.searchParams.get('folder')
    const stripHtmlFlag = url.searchParams.get('strip_html') === '1'

    let query = sb.from('ace_email_templates')
      .select('fub_template_id, name, folder, subject, body_html, body_plain, merge_fields, is_shared, fub_created_at, fub_updated_at')
      .is('deleted_at', null)
      .order('folder', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true })
      .limit(2000)

    if (folderFilter) query = query.eq('folder', folderFilter)

    const { data, error } = await query
    if (error) {
      return new Response(JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const rows = data || []
    const headers = ['fub_template_id', 'name', 'folder', 'subject', 'body_html', 'body_plain', 'merge_fields', 'is_shared', 'fub_created_at', 'fub_updated_at']
    if (stripHtmlFlag) headers.push('body_plain_text')

    const lines: string[] = []
    lines.push(headers.map(csvCell).join(','))
    for (const r of rows) {
      const cells = [
        csvCell(r.fub_template_id), csvCell(r.name), csvCell(r.folder),
        csvCell(r.subject), csvCell(r.body_html), csvCell(r.body_plain),
        csvCell(r.merge_fields), csvCell(r.is_shared),
        csvCell(r.fub_created_at), csvCell(r.fub_updated_at)
      ]
      if (stripHtmlFlag) cells.push(csvCell(stripHtml(r.body_html)))
      lines.push(cells.join(','))
    }

    const csv = '﻿' + lines.join('\r\n') + '\r\n'
    const filenameSafe = folderFilter
      ? folderFilter.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'folder'
      : 'all'
    const filename = `fub_email_templates_${filenameSafe}.csv`

    return new Response(csv, {
      status: 200,
      headers: {
        ...cors, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Row-Count': String(rows.length), 'Cache-Control': 'no-store'
      }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
