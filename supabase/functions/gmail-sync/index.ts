// gmail-sync v2 (v113.31)
// v2: bubbles up the first 3 error messages per mailbox in the response
// so we can debug the "23 message(s) failed during sync" case.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const MAX_PER_RUN = 250;
const PAGE_SIZE   = 100;

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + await res.text());
  return await res.json();
}

function base64urlDecodeToString(b64url: string): string {
  if (!b64url) return '';
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

function extractBodies(payload: any, out: { text: string, html: string }) {
  if (!payload) return;
  const mime = (payload.mimeType || '').toLowerCase();
  const data = payload.body?.data;
  if (data) {
    if (mime === 'text/plain') out.text += base64urlDecodeToString(data);
    else if (mime === 'text/html') out.html += base64urlDecodeToString(data);
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) extractBodies(p, out);
  }
}

function parseAddrList(s?: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  s.split(',').forEach(part => {
    const m = part.match(/<([^>]+)>/);
    const addr = (m ? m[1] : part).trim().toLowerCase();
    if (addr && addr.includes('@')) out.push(addr);
  });
  return out;
}

function parseFrom(s?: string): { name: string|null, email: string } {
  if (!s) return { name: null, email: '' };
  const m = s.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) {
    return {
      name:  m[1].replace(/(^['"\s]+|['"\s]+$)/g, '').trim() || null,
      email: m[2].trim().toLowerCase(),
    };
  }
  return { name: null, email: s.trim().toLowerCase() };
}

function headerVal(headers: any[], name: string): string {
  if (!Array.isArray(headers)) return '';
  const h = headers.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? (h.value || '') : '';
}

async function findContactIdByEmail(
  supabaseUrl: string, serviceKey: string, email: string
): Promise<string | null> {
  if (!email) return null;
  const e = email.toLowerCase();
  const url =
    `${supabaseUrl}/rest/v1/ace_contacts` +
    `?select=id&deleted_at=is.null` +
    `&or=(email.eq.${encodeURIComponent(e)},secondary_email.eq.${encodeURIComponent(e)})` +
    `&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]) return rows[0].id;
  } catch { /* fall through */ }
  return null;
}

async function getExistingMessageIds(
  supabaseUrl: string, serviceKey: string, userEmail: string, ids: string[]
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const inList = ids.map(x => encodeURIComponent(x)).join(',');
  const url =
    `${supabaseUrl}/rest/v1/ace_emails` +
    `?select=gmail_message_id` +
    `&user_email=eq.${encodeURIComponent(userEmail)}` +
    `&gmail_message_id=in.(${inList})`;
  try {
    const res = await fetch(url, { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } });
    const rows = await res.json();
    return new Set((rows || []).map((r: any) => r.gmail_message_id));
  } catch { return new Set(); }
}

async function syncOneMailbox(
  integration: any,
  env: { CLIENT_ID: string, CLIENT_SECRET: string, SUPABASE_URL: string, SERVICE_KEY: string }
) {
  const userEmail = integration.user_email as string;
  const gmailEmail = (integration.gmail_email || '').toLowerCase();

  let { access_token, refresh_token, token_expiry, id: integrationId, sync_backfill_done } = integration;
  const sample_errors: string[] = [];
  const recordErr = (msg: string) => {
    if (sample_errors.length < 3) sample_errors.push(msg.slice(0, 500));
  };

  const expiryMs = token_expiry ? new Date(token_expiry).getTime() : 0;
  if (!access_token || Date.now() > expiryMs - 120_000) {
    const refreshed = await refreshAccessToken(refresh_token, env.CLIENT_ID, env.CLIENT_SECRET);
    access_token = refreshed.access_token;
    const newExpiry = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000).toISOString();
    await fetch(`${env.SUPABASE_URL}/rest/v1/ace_user_email_integrations?id=eq.${integrationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': env.SERVICE_KEY, 'Authorization': `Bearer ${env.SERVICE_KEY}` },
      body: JSON.stringify({ access_token, token_expiry: newExpiry }),
    });
  }

  const lookback = sync_backfill_done ? '7d' : '90d';
  const q = `newer_than:${lookback}`;

  const allIds: string[] = [];
  let pageToken: string | undefined;
  while (allIds.length < MAX_PER_RUN) {
    const params = new URLSearchParams({ q, maxResults: String(PAGE_SIZE) });
    if (pageToken) params.set('pageToken', pageToken);
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    if (!listRes.ok) {
      const txt = await listRes.text();
      throw new Error(`messages.list failed: ${txt}`);
    }
    const list = await listRes.json();
    const ids = (list.messages || []).map((m: any) => m.id as string);
    allIds.push(...ids);
    pageToken = list.nextPageToken;
    if (!pageToken || !ids.length) break;
  }

  const candidates = allIds.slice(0, MAX_PER_RUN);
  const existing = await getExistingMessageIds(env.SUPABASE_URL, env.SERVICE_KEY, userEmail, candidates);
  const toFetch = candidates.filter(id => !existing.has(id));

  let inserted = 0;
  let errors = 0;
  let skipped_no_contact = 0;

  for (const msgId of toFetch) {
    try {
      const fullRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
        { headers: { 'Authorization': `Bearer ${access_token}` } }
      );
      if (!fullRes.ok) {
        errors++;
        recordErr(`msg ${msgId} get failed: ${fullRes.status} ${await fullRes.text()}`);
        continue;
      }
      const full = await fullRes.json();

      const headers = full.payload?.headers || [];
      const fromHeader = headerVal(headers, 'From');
      const toHeader   = headerVal(headers, 'To');
      const ccHeader   = headerVal(headers, 'Cc');
      const bccHeader  = headerVal(headers, 'Bcc');
      const subject    = headerVal(headers, 'Subject');
      const dateStr    = headerVal(headers, 'Date');
      const messageIdHeader  = headerVal(headers, 'Message-ID');
      const inReplyToHeader  = headerVal(headers, 'In-Reply-To');
      const referencesHeader = headerVal(headers, 'References');

      const fp = parseFrom(fromHeader);
      const fromEmail = fp.email;
      const fromName  = fp.name;
      const toEmails  = parseAddrList(toHeader);
      const ccEmails  = parseAddrList(ccHeader);
      const bccEmails = parseAddrList(bccHeader);

      const direction = fromEmail === gmailEmail ? 'outbound' : 'inbound';
      const lookupEmail = direction === 'outbound' ? toEmails[0] : fromEmail;
      let contactId: string | null = null;
      if (lookupEmail) {
        contactId = await findContactIdByEmail(env.SUPABASE_URL, env.SERVICE_KEY, lookupEmail);
      }
      if (!contactId) { skipped_no_contact++; continue; }

      let sentAtIso = new Date().toISOString();
      if (dateStr) {
        const t = Date.parse(dateStr);
        if (!isNaN(t)) sentAtIso = new Date(t).toISOString();
      } else if (full.internalDate) {
        sentAtIso = new Date(Number(full.internalDate)).toISOString();
      }

      const bodies = { text: '', html: '' };
      extractBodies(full.payload, bodies);

      const insertRow: any = {
        gmail_message_id: msgId,
        gmail_thread_id:  full.threadId,
        user_email:       userEmail,
        contact_id:       contactId,
        deal_id:          null,
        direction,
        from_email:       fromEmail,
        from_name:        fromName,
        to_emails:        toEmails,
        cc_emails:        ccEmails.length ? ccEmails : null,
        bcc_emails:       bccEmails.length ? bccEmails : null,
        subject:          subject || null,
        snippet:          full.snippet || null,
        body_text:        bodies.text || null,
        body_html:        bodies.html || null,
        message_id_header:  messageIdHeader || null,
        in_reply_to_header: inReplyToHeader || null,
        references_header:  referencesHeader || null,
        is_read:          direction === 'outbound',
        sent_at:          sentAtIso,
        raw_headers:      headers,
      };

      const insRes = await fetch(`${env.SUPABASE_URL}/rest/v1/ace_emails?on_conflict=gmail_message_id,user_email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': env.SERVICE_KEY,
          'Authorization': `Bearer ${env.SERVICE_KEY}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(insertRow),
      });
      if (insRes.ok) {
        inserted++;
      } else {
        errors++;
        const txt = await insRes.text();
        recordErr(`insert ${insRes.status}: ${txt} | dir=${direction} from=${fromEmail} to=${(toEmails[0]||'').slice(0,40)} sub=${(subject||'').slice(0,40)}`);
      }
    } catch (e) {
      errors++;
      recordErr(`msg ${msgId} threw: ${String(e).slice(0,300)}`);
    }
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/ace_user_email_integrations?id=eq.${integrationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SERVICE_KEY, 'Authorization': `Bearer ${env.SERVICE_KEY}` },
    body: JSON.stringify({
      sync_backfill_done: true,
      last_sync_at: new Date().toISOString(),
      sync_error: errors ? `${errors} message(s) failed during sync` : null,
    }),
  });

  return { user_email: userEmail, processed: candidates.length, inserted, errors, skipped_no_contact, sample_errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const env = {
    CLIENT_ID:     Deno.env.get('GOOGLE_CLIENT_ID')          ?? '',
    CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET')      ?? '',
    SUPABASE_URL:  Deno.env.get('SUPABASE_URL')              ?? '',
    SERVICE_KEY:   Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  };

  const t0 = Date.now();
  try {
    let targetUser: string | null = null;
    if (req.method === 'POST') {
      try { const j = await req.json(); targetUser = j?.user_email || null; } catch { /* ok */ }
    }

    let intUrl = `${env.SUPABASE_URL}/rest/v1/ace_user_email_integrations?select=*&is_active=eq.true`;
    if (targetUser) intUrl += `&user_email=eq.${encodeURIComponent(targetUser)}`;

    const intRes = await fetch(intUrl, { headers: { 'apikey': env.SERVICE_KEY, 'Authorization': `Bearer ${env.SERVICE_KEY}` } });
    const integrations = await intRes.json();
    if (!Array.isArray(integrations)) {
      return new Response(JSON.stringify({ error: 'Failed to load integrations', got: integrations }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const results = [];
    for (const integ of integrations) {
      try {
        const r = await syncOneMailbox(integ, env);
        results.push(r);
      } catch (e) {
        results.push({ user_email: integ.user_email, error: String(e) });
        await fetch(`${env.SUPABASE_URL}/rest/v1/ace_user_email_integrations?id=eq.${integ.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'apikey': env.SERVICE_KEY, 'Authorization': `Bearer ${env.SERVICE_KEY}` },
          body: JSON.stringify({ sync_error: String(e).slice(0, 500) }),
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify({ synced: results, total_ms: Date.now() - t0 }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), total_ms: Date.now() - t0 }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
