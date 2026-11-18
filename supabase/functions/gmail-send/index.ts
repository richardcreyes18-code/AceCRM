// gmail-send v4 (v113.31)
// Sends an email on behalf of a CRM agent using their connected Gmail account.
// Auto-refreshes the access token if expired.
//
// v113.31 changes vs v3:
//   * Accepts in_reply_to_message_id (a Gmail msg id) — when set, fetches
//     the original's Message-ID & References headers and threads the reply.
//   * After a successful send, fetches the just-sent message via
//     messages.get and inserts a row into ace_emails so the contact card
//     can render the conversation.
//   * Best-effort matches contact_id by recipient email if not provided.
//
// Request body:
// {
//   user_email: string,                  // agent's CRM email (used to look up tokens)
//   to: string,                          // recipient(s), comma-separated
//   subject: string,
//   body: string,                        // plain text body
//   reply_to?: string,                   // Reply-To header
//   deal_id?: string,                    // optional CRM deal context
//   contact_id?: string,                 // optional CRM contact context (uuid)
//   in_reply_to_message_id?: string      // Gmail msg id we're replying to
// }
//
// Response: { success: true, message_id, thread_id, db_email_id? }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

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

function buildRfc2822(opts: {
  from: string,
  to: string,
  subject: string,
  body: string,
  replyTo?: string,
  inReplyTo?: string,        // the original Message-ID header value (with <> brackets)
  references?: string,       // full References chain
}): string {
  const lines: (string|null)[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    opts.replyTo  ? `Reply-To: ${opts.replyTo}` : null,
    opts.inReplyTo  ? `In-Reply-To: ${opts.inReplyTo}` : null,
    opts.references ? `References: ${opts.references}` : null,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    opts.body,
  ];
  return lines.filter(l => l !== null).join('\r\n');
}

function base64url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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

// Walk a Gmail payload tree, accumulating text/plain and text/html bodies.
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
  // Quick & dirty: split on commas not inside quotes; pull out anything inside <>.
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
  // Match against email, secondary_email, or any entry in all_emails (jsonb).
  // PostgREST: use OR with three clauses.
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const CLIENT_ID     = Deno.env.get('GOOGLE_CLIENT_ID')          ?? '';
  const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')       ?? '';
  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')               ?? '';
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')  ?? '';

  try {
    const {
      user_email, to, subject, body, reply_to, deal_id, contact_id,
      in_reply_to_message_id,
    } = await req.json();

    if (!user_email || !to || !subject || !body) {
      return new Response(JSON.stringify({ error: 'user_email, to, subject, body are required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── 1. Load tokens from DB ────────────────────────────────────────────
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ace_user_email_integrations?user_email=eq.${encodeURIComponent(user_email)}&is_active=eq.true&limit=1`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const rows = await dbRes.json();
    if (!Array.isArray(rows) || !rows.length) {
      return new Response(JSON.stringify({ error: 'Gmail not connected for this user. Connect at Profile → Gmail.' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    // deno-lint-ignore prefer-const
    let { access_token, refresh_token, token_expiry, gmail_email, id: integrationId } = rows[0];

    // ── 2. Refresh access token if needed ─────────────────────────────────
    const expiryMs = token_expiry ? new Date(token_expiry).getTime() : 0;
    if (!access_token || Date.now() > expiryMs - 120_000) {
      const refreshed = await refreshAccessToken(refresh_token, CLIENT_ID, CLIENT_SECRET);
      access_token = refreshed.access_token;
      const newExpiry = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000).toISOString();
      await fetch(`${SUPABASE_URL}/rest/v1/ace_user_email_integrations?id=eq.${integrationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ access_token, token_expiry: newExpiry, last_used_at: new Date().toISOString() }),
      });
    }

    // ── 3. If this is a reply, fetch the original to get threading headers ─
    let inReplyToHeader = '';
    let referencesHeader = '';
    let threadIdForSend = '';
    if (in_reply_to_message_id) {
      try {
        const origRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(in_reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`,
          { headers: { 'Authorization': `Bearer ${access_token}` } }
        );
        if (origRes.ok) {
          const orig = await origRes.json();
          threadIdForSend = orig.threadId || '';
          const headers = orig.payload?.headers || [];
          const origMsgId = headerVal(headers, 'Message-ID');
          const origRefs  = headerVal(headers, 'References');
          if (origMsgId) {
            inReplyToHeader = origMsgId;
            referencesHeader = origRefs ? (origRefs + ' ' + origMsgId) : origMsgId;
          }
        }
      } catch (e) {
        console.warn('[gmail-send] reply-context fetch failed:', e);
      }
    }

    // ── 4. Build & send via Gmail API ─────────────────────────────────────
    const raw = base64url(buildRfc2822({
      from:       gmail_email,
      to, subject, body,
      replyTo:    reply_to,
      inReplyTo:  inReplyToHeader || undefined,
      references: referencesHeader || undefined,
    }));

    const sendBody: any = { raw };
    if (threadIdForSend) sendBody.threadId = threadIdForSend;

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sendBody),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      return new Response(JSON.stringify({ error: 'Gmail API error: ' + err }), {
        status: sendRes.status, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const sent = await sendRes.json();
    const messageId = sent.id as string;
    const threadId  = sent.threadId as string;

    // ── 5. Best-effort: log to ace_emails so the contact card sees it ─────
    let dbEmailId: string | null = null;
    try {
      // Fetch the just-sent message with full payload so we get exact headers
      // (Message-ID, Date) and the body Gmail actually delivered.
      const fullRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
        { headers: { 'Authorization': `Bearer ${access_token}` } }
      );
      let bodies = { text: '', html: '' };
      let messageIdHeader = '';
      let snippet = '';
      let sentAtIso = new Date().toISOString();
      let actualSubject = subject;
      let toEmails: string[] = parseAddrList(to);
      let fromName: string | null = null;
      let rawHeaders: any = null;
      if (fullRes.ok) {
        const full = await fullRes.json();
        snippet = full.snippet || '';
        const h = full.payload?.headers || [];
        rawHeaders = h;
        const dateStr = headerVal(h, 'Date');
        if (dateStr) {
          const t = Date.parse(dateStr);
          if (!isNaN(t)) sentAtIso = new Date(t).toISOString();
        } else if (full.internalDate) {
          sentAtIso = new Date(Number(full.internalDate)).toISOString();
        }
        messageIdHeader = headerVal(h, 'Message-ID');
        actualSubject   = headerVal(h, 'Subject') || subject;
        const toHeader  = headerVal(h, 'To');
        if (toHeader) toEmails = parseAddrList(toHeader);
        const fromHeader = headerVal(h, 'From');
        const fp = parseFrom(fromHeader);
        fromName = fp.name;
        extractBodies(full.payload, bodies);
      }

      // Resolve contact_id if caller didn't supply one.
      let resolvedContactId: string | null = contact_id || null;
      if (!resolvedContactId && toEmails[0]) {
        resolvedContactId = await findContactIdByEmail(SUPABASE_URL, SERVICE_KEY, toEmails[0]);
      }

      const insertRow: any = {
        gmail_message_id: messageId,
        gmail_thread_id:  threadId,
        user_email:       user_email,
        contact_id:       resolvedContactId,
        deal_id:          deal_id || null,
        direction:        'outbound',
        from_email:       (gmail_email || '').toLowerCase(),
        from_name:        fromName,
        to_emails:        toEmails,
        subject:          actualSubject,
        snippet:          snippet,
        body_text:        bodies.text || body,
        body_html:        bodies.html || null,
        message_id_header:  messageIdHeader || null,
        in_reply_to_header: inReplyToHeader || null,
        references_header:  referencesHeader || null,
        is_read:          true,
        sent_at:          sentAtIso,
        raw_headers:      rawHeaders,
      };

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/ace_emails?on_conflict=gmail_message_id,user_email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Prefer': 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(insertRow),
      });
      if (insertRes.ok) {
        const ins = await insertRes.json();
        if (Array.isArray(ins) && ins[0]?.id) dbEmailId = ins[0].id;
      } else {
        const t = await insertRes.text();
        console.warn('[gmail-send] ace_emails insert failed:', t);
      }
    } catch (e) {
      console.warn('[gmail-send] db logging failed (non-blocking):', e);
    }

    // Update last_used_at — best-effort, fire-and-forget
    fetch(`${SUPABASE_URL}/rest/v1/ace_user_email_integrations?id=eq.${integrationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      message_id: messageId,
      thread_id:  threadId,
      db_email_id: dbEmailId,
    }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
