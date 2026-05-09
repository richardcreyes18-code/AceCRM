// core/auth.js — Supabase auth: session save/load/refresh, JWT parse, signIn.
// Currently duplicated in the legacy <script> (lines ~2085–2203).
//
// Reads/writes shared state via window._currentUser, window._viewMode,
// window._authToken, window._refreshToken. The legacy script's `let`
// declarations were converted to `var` in Phase 3 so they auto-attach to
// window — that keeps legacy and ES-module state in sync until state.js
// owns the auth state in a later phase.
//
// Domain-side hooks called from _signIn (e.g. _loadMyRelationships,
// _myPipelineLoad) are looked up on window at call time so this module
// stays decoupled from those features until they migrate.

import { SB_AUTH_URL, SB_ANON_KEY, _proxyCall } from './proxy.js';

// Bump SESSION_VERSION to force every logged-in user to re-authenticate on next load.
export const SESSION_VERSION = 1;

export function _saveSession(token, user, refreshToken) {
  window._authToken    = token;
  window._currentUser  = user;
  if(refreshToken !== undefined) window._refreshToken = refreshToken;
  localStorage.setItem('ace_auth_token', token);
  localStorage.setItem('ace_auth_user', JSON.stringify(user));
  localStorage.setItem('ace_session_version', String(SESSION_VERSION));
  if(refreshToken) localStorage.setItem('ace_refresh_token', refreshToken);
}

export function _clearSession() {
  window._authToken    = null;
  window._refreshToken = null;
  window._currentUser  = null;
  // _myRelationships lives in legacy still; reset there if available.
  if(typeof window._myRelationships !== 'undefined') window._myRelationships = new Map();
  if(typeof window._myRelationshipsLoadMs !== 'undefined') window._myRelationshipsLoadMs = 0;
  localStorage.removeItem('ace_auth_token');
  localStorage.removeItem('ace_auth_user');
  localStorage.removeItem('ace_refresh_token');
  localStorage.removeItem('ace_session_version');
}

export function _loadSession() {
  const storedVersion = parseInt(localStorage.getItem('ace_session_version') || '0', 10);
  if(storedVersion !== SESSION_VERSION) {
    _clearSession();
    return false;
  }
  const token = localStorage.getItem('ace_auth_token');
  const user  = localStorage.getItem('ace_auth_user');
  const refresh = localStorage.getItem('ace_refresh_token');
  if(token && user) {
    window._authToken    = token;
    window._refreshToken = refresh || null;
    window._currentUser  = JSON.parse(user);
    return true;
  }
  return false;
}

// Parse a JWT without verification and return its payload, or null if invalid.
export function _parseJwtPayload(token){
  try{
    const parts = (token||'').split('.');
    if(parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
  }catch(e){ return null; }
}

// Returns true if the current access token expires within `bufferSeconds`
// (default 5 minutes). If we can't parse it, assume expiring so we refresh.
export function _isTokenExpiring(bufferSeconds = 300){
  const tok = window._authToken;
  if(!tok) return true;
  const payload = _parseJwtPayload(tok);
  if(!payload || !payload.exp) return true;
  const now = Math.floor(Date.now()/1000);
  return (payload.exp - now) < bufferSeconds;
}

// Exchange the stored refresh token for a new access token. Returns the new
// access token on success, or null on failure (caller should clear session).
// Uses a module-level promise to deduplicate concurrent refresh attempts.
let _refreshInFlight = null;
export async function _refreshAccessToken(){
  if(_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try{
      const refresh = window._refreshToken;
      if(!refresh) return null;
      const resp = await fetch(`${SB_AUTH_URL}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'apikey': SB_ANON_KEY },
        body: JSON.stringify({ refresh_token: refresh })
      });
      const data = await resp.json();
      if(!resp.ok || !data.access_token){
        console.warn('Token refresh failed:', data.error_description || data.msg || resp.status);
        return null;
      }
      // Save the new tokens — Supabase rotates refresh tokens too.
      window._authToken = data.access_token;
      if(data.refresh_token) window._refreshToken = data.refresh_token;
      localStorage.setItem('ace_auth_token', window._authToken);
      if(data.refresh_token) localStorage.setItem('ace_refresh_token', data.refresh_token);
      return window._authToken;
    }catch(e){
      console.warn('Token refresh error:', e.message);
      return null;
    }finally{
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

export async function _signIn(email, password) {
  const resp = await fetch(`${SB_AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SB_ANON_KEY },
    body: JSON.stringify({ email, password })
  });
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error_description || data.msg || 'Login failed');

  // Get user profile
  const profile = await _proxyCall({ table:'ace_users', method:'GET', select:'*', id: data.user.id });
  const user = Array.isArray(profile) ? profile[0] : profile;
  if(!user) throw new Error('User profile not found. Contact admin.');

  _saveSession(data.access_token, user, data.refresh_token);
  // Domain hooks — call if defined by legacy script.
  if(typeof window._loadMyRelationships === 'function') window._loadMyRelationships(true);
  if(typeof window._myPipelineLoad === 'function') window._myPipelineLoad(true); // v113.1
  return user;
}
