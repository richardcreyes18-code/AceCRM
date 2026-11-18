// Admin-only user management endpoint for Ace CRM.
// Accepts a POST with { action, ...params } and performs the requested operation.
// Every request is verified to come from an admin user before anything happens.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing bearer token' }, 401);
  }
  const callerJwt = authHeader.replace('Bearer ', '');

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
  });

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  const callerId = userData.user.id;

  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerRow, error: callerErr } = await adminClient
    .from('ace_users')
    .select('role, is_active')
    .eq('id', callerId)
    .single();

  if (callerErr || !callerRow) return json({ error: 'Caller not found in ace_users' }, 403);
  if (callerRow.role !== 'admin') return json({ error: 'Admin role required' }, 403);
  if (callerRow.is_active === false) return json({ error: 'Account is disabled' }, 403);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const action = body.action;
  if (!action) return json({ error: 'Missing action' }, 400);

  try {
    switch (action) {
      case 'list': {
        // Include last_login_at — used by the Team UI as "Last Active".
        // We repurposed this column as a heartbeat timestamp, updated by the
        // touch_user_activity RPC on app load + periodically while the tab
        // is open. More meaningful than auth.last_sign_in_at when users
        // have browsers that auto-fill their password.
        const { data: aceUsers, error: e1 } = await adminClient
          .from('ace_users')
          .select('id, name, email, role, fub_name, is_active, created_at, last_login_at')
          .order('name');
        if (e1) throw e1;

        const { data: authList, error: e2 } = await adminClient.auth.admin.listUsers({
          page: 1,
          perPage: 200,
        });
        if (e2) throw e2;

        const authMap = new Map((authList?.users || []).map((u) => [u.id, u]));
        const merged = (aceUsers || []).map((u) => {
          const au = authMap.get(u.id);
          return {
            ...u,
            auth_email: au?.email || u.email,
            last_sign_in_at: au?.last_sign_in_at || null,
            // Expose as last_active_at for the client; UI shows this.
            last_active_at: u.last_login_at || null,
          };
        });
        return json({ users: merged });
      }

      case 'create': {
        const { name, email, password, role, fub_name } = body;
        if (!name || !email || !password) {
          return json({ error: 'name, email, and password are required' }, 400);
        }
        if (!['admin', 'agent', 'trainee'].includes(role || 'agent')) {
          return json({ error: 'Invalid role' }, 400);
        }

        const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { name },
        });
        if (createErr) return json({ error: createErr.message }, 400);
        if (!created?.user) return json({ error: 'Failed to create auth user' }, 500);

        const { error: insertErr } = await adminClient.from('ace_users').insert({
          id: created.user.id,
          name,
          email,
          role: role || 'agent',
          fub_name: fub_name || name,
          is_active: true,
          created_at: new Date().toISOString(),
        });

        if (insertErr) {
          await adminClient.auth.admin.deleteUser(created.user.id);
          return json({ error: `ace_users insert failed: ${insertErr.message}` }, 500);
        }
        return json({ ok: true, user_id: created.user.id });
      }

      case 'reset_password': {
        const { user_id, new_password } = body;
        if (!user_id || !new_password) {
          return json({ error: 'user_id and new_password required' }, 400);
        }
        const { error: resetErr } = await adminClient.auth.admin.updateUserById(
          user_id,
          { password: new_password }
        );
        if (resetErr) return json({ error: resetErr.message }, 400);
        return json({ ok: true });
      }

      case 'update': {
        const { user_id, name, email, role, fub_name, is_active } = body;
        if (!user_id) return json({ error: 'user_id required' }, 400);
        if (role && !['admin', 'agent', 'trainee'].includes(role)) {
          return json({ error: 'Invalid role' }, 400);
        }

        if (email) {
          const { error: emailErr } = await adminClient.auth.admin.updateUserById(
            user_id,
            { email }
          );
          if (emailErr) return json({ error: `email update failed: ${emailErr.message}` }, 400);
        }

        const patch: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        if (name !== undefined) patch.name = name;
        if (email !== undefined) patch.email = email;
        if (role !== undefined) patch.role = role;
        if (fub_name !== undefined) patch.fub_name = fub_name;
        if (is_active !== undefined) patch.is_active = !!is_active;

        const { error: updErr } = await adminClient
          .from('ace_users')
          .update(patch)
          .eq('id', user_id);
        if (updErr) return json({ error: updErr.message }, 400);
        return json({ ok: true });
      }

      case 'set_active': {
        const { user_id, is_active } = body;
        if (!user_id || typeof is_active !== 'boolean') {
          return json({ error: 'user_id and is_active required' }, 400);
        }
        if (user_id === callerId && !is_active) {
          return json({ error: 'Cannot disable your own account' }, 400);
        }
        const { error: updErr } = await adminClient
          .from('ace_users')
          .update({ is_active, updated_at: new Date().toISOString() })
          .eq('id', user_id);
        if (updErr) return json({ error: updErr.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error('admin-users error:', e);
    return json({ error: (e as Error).message || 'Internal error' }, 500);
  }
});