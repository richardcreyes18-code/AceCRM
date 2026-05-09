// email/gmail.js — per-agent Gmail OAuth + send via gmail-send edge function.
//
// 6 exports + 3 constants. Self-contained except for:
//   - window._currentUser (var) — read for the agent's email
//   - _esc, getConfig, showSaveConfirm (function decls / imports) — accessible
//
// State lives on window._gmailConnected (NOT a module-scope let) because
// legacy code at lines ~14028, 27173, 27180, 27211, 44040, 44043, 44046
// reads it bare via the global env. Same pattern as _currentPortfolioId.

import { _sbGet, _sbPatch } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';

export const GMAIL_CLIENT_ID = '419384865839-s1dc2k1r2pe3e76ga4dp2g0vnq2mblam.apps.googleusercontent.com';
export const GMAIL_REDIRECT  = 'https://kxtuegjptvzqycgyzehj.supabase.co/functions/v1/gmail-oauth-callback';
// v113.31: gmail.readonly added so the inbound sync (gmail-sync edge fn)
// can list + fetch messages on the user's behalf. Existing connections
// granted before this version need to click "Connect Gmail" once more to
// authorize the new scope — sending still works without it.
export const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email';

// Build the Google OAuth URL and redirect the agent to Google's consent page.
export function _gmailConnect(){
  const email = window._currentUser?.email || '';
  if(!email){ alert('You must be signed in to connect Gmail.'); return; }
  const params = new URLSearchParams({
    client_id:     GMAIL_CLIENT_ID,
    redirect_uri:  GMAIL_REDIRECT,
    response_type: 'code',
    scope:         GMAIL_SCOPES,
    access_type:   'offline',
    prompt:        'consent',          // always get refresh_token
    state:         encodeURIComponent(email),
  });
  window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Check if the current user has Gmail connected (queries DB via crm-proxy).
export async function _gmailCheckStatus(){
  const email = window._currentUser?.email;
  if(!email){ window._gmailConnected = false; _gmailUpdateBadge(); return; }
  try{
    const rows = await _sbGet('ace_user_email_integrations',
      `user_email=eq.${encodeURIComponent(email)}&is_active=eq.true&select=gmail_email,last_used_at&limit=1`);
    if(Array.isArray(rows) && rows.length){
      window._gmailConnected = { email: rows[0].gmail_email, last_used: rows[0].last_used_at };
    } else {
      window._gmailConnected = false;
    }
  }catch(e){ window._gmailConnected = false; }
  _gmailUpdateBadge();
}

// Update the sidebar Gmail badge.
export function _gmailUpdateBadge(){
  const el = document.getElementById('gmailStatusBadge');
  if(!el) return;
  if(window._gmailConnected && window._gmailConnected.email){
    el.innerHTML = `<span style="font-size:10px;color:#16a34a;">✓ Gmail: ${_esc(window._gmailConnected.email)}</span>
      <a onclick="_gmailDisconnect()" style="font-size:10px;color:#94a3b8;margin-left:6px;cursor:pointer;">disconnect</a>`;
  } else {
    el.innerHTML = `<a onclick="_gmailConnect()" style="font-size:10px;color:#3b82f6;cursor:pointer;">📧 Connect Gmail</a>
      <span style="font-size:10px;color:#94a3b8;margin-left:4px;">(send from CRM)</span>`;
  }
}

// Disconnect Gmail — mark is_active=false in DB.
export async function _gmailDisconnect(){
  const email = window._currentUser?.email;
  if(!email || !window._gmailConnected) return;
  if(!confirm('Disconnect Gmail? You can reconnect at any time.')) return;
  try{
    await _sbPatch('ace_user_email_integrations', null,
      { is_active: false },
      `user_email=eq.${encodeURIComponent(email)}`);
  }catch(e){ /* best effort */ }
  window._gmailConnected = false;
  _gmailUpdateBadge();
}

// Send an email via the gmail-send edge function.
// Falls back to Gmail compose URL if not connected.
// Returns { sent: true } or { sent: false, fallback: true }
// v113.31: added inReplyToMessageId + contactId so replies thread properly
// in Gmail and the resulting ace_emails row is linked to the right contact.
export async function _gmailSend({ to, subject, body, dealId, contactId, inReplyToMessageId, onSuccess, onError }){
  if(!window._gmailConnected || !window._gmailConnected.email){
    // Not connected — open compose URL as before
    const url = 'https://mail.google.com/mail/?view=cm&fs=1'
      + (to ? '&to='+encodeURIComponent(to) : '')
      + '&su='+encodeURIComponent(subject||'')
      + '&body='+encodeURIComponent(body||'');
    window.open(url, '_blank');
    return { sent: false, fallback: true };
  }
  try{
    const cfg = getConfig();
    const res = await fetch(cfg.url + '/functions/v1/gmail-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_email: window._currentUser.email,
        to, subject, body,
        deal_id: dealId || null,
        contact_id: contactId || null,
        in_reply_to_message_id: inReplyToMessageId || null
      })
    });
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    if(onSuccess) onSuccess(data);
    return { sent: true, message_id: data.message_id, thread_id: data.thread_id };
  }catch(e){
    if(onError) onError(e);
    else alert('Send failed: ' + e.message);
    return { sent: false, error: e.message };
  }
}

// On page load: check if we're returning from Google OAuth callback.
export function _gmailHandleCallback(){
  const params = new URLSearchParams(window.location.search);
  if(params.get('gmail_connected')){
    const gmailEmail = params.get('gmail_email') || '';
    window._gmailConnected = { email: gmailEmail };
    _gmailUpdateBadge();
    // Clean the URL without a full reload
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);
    // Show success toast
    setTimeout(() => {
      showSaveConfirm('✓ Gmail connected: ' + gmailEmail + '. Emails will now send directly from your account.');
    }, 500);
  } else if(params.get('gmail_error')){
    const err = params.get('gmail_error');
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);
    const msgs = {
      access_denied:         'You cancelled the Gmail connection.',
      no_refresh_token:      'No refresh token returned. Please try again.',
      token_exchange_failed: 'Google rejected the token exchange. Try reconnecting.',
      db_failed:             'Connected but failed to save tokens. Please try again.',
    };
    alert('Gmail connection failed: ' + (msgs[err] || err));
  }
}
