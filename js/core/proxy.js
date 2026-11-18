// core/proxy.js — crm-proxy URLs + low-level call helper.
// Currently duplicated in the legacy <script> in index.html (line ~1399);
// duplicates removed once every consumer imports from this module.
// All DB calls route through the crm-proxy Edge Function — no CORS issues.

export const PROXY_URL    = 'https://eoatyremdqilsetmtyfk.supabase.co/functions/v1/crm-proxy';
export const SB_AUTH_URL  = 'https://eoatyremdqilsetmtyfk.supabase.co/auth/v1';
export const SB_ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvYXR5cmVtZHFpbHNldG10eWZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMzc2NjIsImV4cCI6MjExMDYxMzY2Mn0.S3FrojHoHnoFpV8xci2jDXy_2SXhCg6N_xrsWiSoUR8';
export const SB_STORAGE_URL = 'https://eoatyremdqilsetmtyfk.supabase.co/storage/v1';
export const SB_BUCKET    = 'ace-property-files';

export async function _proxyCall(params, body = null, opts = {}) {
  const url = new URL(PROXY_URL);
  Object.entries(params).forEach(([k,v]) => { if(v !== null && v !== undefined) url.searchParams.set(k, String(v)); });
  const fetchOpts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
  if(body) fetchOpts.body = JSON.stringify(body);
  // v113.67: keepalive lets unload-time saves (pagehide / window close)
  // finish even after the page is gone. Browsers cap keepalive bodies to
  // ~64 KB total per page, which is fine for our PATCH payloads.
  if(opts.keepalive) fetchOpts.keepalive = true;
  const res = await fetch(url.toString(), fetchOpts);
  const data = await res.json();
  if(data?.error) throw new Error(data.error);
  return data;
}
