// gmail-oauth-callback v3 (v113.31)
// Fixed in v3: upsert URL now includes ?on_conflict=user_email so re-connecting
// an already-connected mailbox updates the existing row.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // NOTE: CRM_URL and REDIRECT_URI need to be updated for the new project.
  // Henry's project values are left as-is here — fork up to parent to swap.
  const CRM_URL       = 'https://ace-crm-eight.vercel.app';
  const REDIRECT_URI  = 'https://kxtuegjptvzqycgyzehj.supabase.co/functions/v1/gmail-oauth-callback';
  const CLIENT_ID     = Deno.env.get('GOOGLE_CLIENT_ID')          ?? '';
  const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')       ?? '';
  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')               ?? '';
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')  ?? '';

  if (error) return Response.redirect(`${CRM_URL}?gmail_error=${encodeURIComponent(error)}`, 302);
  if (!code || !state) return Response.redirect(`${CRM_URL}?gmail_error=missing_params`, 302);

  const userEmail = decodeURIComponent(state);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('Token exchange failed:', await tokenRes.text());
      return Response.redirect(`${CRM_URL}?gmail_error=token_exchange_failed`, 302);
    }
    const tokens = await tokenRes.json();
    const { access_token, refresh_token, expires_in, scope } = tokens;

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};
    const gmailEmail = userInfo.email || userEmail;

    const expiry = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();
    const body: Record<string, any> = {
      user_email: userEmail, gmail_email: gmailEmail, access_token,
      token_expiry: expiry, scopes: scope ?? '', is_active: true,
      connected_at: new Date().toISOString(),
      sync_backfill_done: false, sync_error: null,
    };
    if (refresh_token) body.refresh_token = refresh_token;

    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ace_user_email_integrations?on_conflict=user_email`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(body),
      }
    );
    if (!upsertRes.ok) {
      console.error('DB upsert failed:', await upsertRes.text());
      return Response.redirect(`${CRM_URL}?gmail_error=db_failed`, 302);
    }

    return Response.redirect(
      `${CRM_URL}?gmail_connected=1&gmail_email=${encodeURIComponent(gmailEmail)}`, 302
    );
  } catch (err) {
    console.error('OAuth callback error:', err);
    return Response.redirect(`${CRM_URL}?gmail_error=${encodeURIComponent(String(err))}`, 302);
  }
});
