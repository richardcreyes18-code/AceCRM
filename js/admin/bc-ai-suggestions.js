// admin/bc-ai-suggestions.js — v326 AI field suggestions inbox.
//
// Reads ace_ai_settings.bc_field_suggestions (a running array the
// edge function UPSERTs into on every BC AI run that produced
// field_suggestions[]). Surfaces the `pending` ones in a modal so
// the agent can:
//   - "Add to taxonomy" → opens _bcFieldsAdminForCategory(scope)
//                          pre-loaded with the suggested col / type / options;
//                          agent reviews + saves; suggestion gets marked accepted.
//   - "Dismiss"           → marks the suggestion dismissed (still in the
//                          JSONB array as audit, but off the inbox view).
//
// Status values: 'pending' | 'accepted' | 'dismissed'. Inbox view
// only renders pending; the others stay in storage for history.

import { _sbGet, _sbPatch, _sbPost } from '../core/supabase.js';

const TABLE = 'ace_ai_settings';
const KEY   = 'bc_field_suggestions';

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _fmtWhen(iso){
  if(!iso) return '—';
  const t = new Date(iso);
  if(isNaN(t)) return esc(iso);
  return t.toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// Slugify same as the edge function so client-side dedup matches.
function _norm(s){
  return String(s || '').toLowerCase().replace(/\s+/g,' ').trim();
}

let _cache = { rowId: null, items: [] };

async function _load(){
  try {
    const rows = await _sbGet(TABLE, `key=eq.${encodeURIComponent(KEY)}&select=id,value&limit=1`);
    const r = Array.isArray(rows) && rows[0];
    if(r){
      _cache.rowId = r.id;
      _cache.items = Array.isArray(r.value) ? r.value.slice() : [];
    } else {
      _cache.rowId = null;
      _cache.items = [];
    }
  } catch(e){
    console.warn('[bc-ai-suggestions] load failed:', e.message);
    _cache.items = [];
  }
}

async function _save(){
  const payload = { key: KEY, value: _cache.items, updated_at: new Date().toISOString() };
  try {
    if(_cache.rowId){
      await _sbPatch(TABLE, _cache.rowId, payload);
    } else {
      const inserted = await _sbPost(TABLE, payload);
      if(Array.isArray(inserted) && inserted[0]?.id) _cache.rowId = inserted[0].id;
      else if(inserted && inserted.id) _cache.rowId = inserted.id;
    }
  } catch(e){
    alert('Failed to save: ' + (e.message || e));
    throw e;
  }
}

function _findIdx(scope, label){
  const sk = _norm(scope), lk = _norm(label);
  return _cache.items.findIndex(it => _norm(it.scope) === sk && _norm(it.label) === lk);
}

// ─── Modal ────────────────────────────────────────────────────────────

export async function _bcAiSuggestionsOpen(){
  document.getElementById('bcAiSuggestionsModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'bcAiSuggestionsModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';
  modal.onclick = (e) => { if(e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:96%;max-width:1100px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
      <div style="padding:16px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:16px;font-weight:700;color:#0f172a;">💡 AI field suggestions inbox</div>
          <div id="bcAiSuggestionsStatus" style="font-size:11px;color:#64748b;margin-top:2px;">Loading…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="bcAiSuggestionsView" onchange="window._bcAiSuggestionsRender()" style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;font-family:inherit;background:#fff;">
            <option value="pending" selected>Pending only</option>
            <option value="all">All (incl. accepted &amp; dismissed)</option>
          </select>
          <button onclick="window._bcAiSuggestionsRefresh()" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#0f172a;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">↻ Refresh</button>
          <button onclick="document.getElementById('bcAiSuggestionsModal')?.remove()" style="background:transparent;border:1px solid #cbd5e1;color:#64748b;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">Close</button>
        </div>
      </div>
      <div id="bcAiSuggestionsBody" style="flex:1;overflow:auto;padding:0;">
        <div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">Loading…</div>
      </div>
      <div style="padding:10px 22px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;background:#fff;">
        Suggestions accumulate from BC AI auto-fill runs. "Add to taxonomy →" opens the matching scope's
        Fields admin pre-populated. After saving the field there, the suggestion drops off the inbox.
      </div>
    </div>`;
  document.body.appendChild(modal);

  window._bcAiSuggestionsRender = _render;
  window._bcAiSuggestionsRefresh = async () => { await _load(); _render(); };

  await _load();
  _render();
}

function _render(){
  const body = document.getElementById('bcAiSuggestionsBody');
  const status = document.getElementById('bcAiSuggestionsStatus');
  if(!body) return;
  const view = document.getElementById('bcAiSuggestionsView')?.value || 'pending';
  let rows = _cache.items.slice();
  if(view === 'pending') rows = rows.filter(r => (r.status || 'pending') === 'pending');
  rows.sort((a, b) => (Number(b.seen_count)||0) - (Number(a.seen_count)||0));

  const pendingCount   = _cache.items.filter(r => (r.status||'pending') === 'pending').length;
  const acceptedCount  = _cache.items.filter(r => r.status === 'accepted').length;
  const dismissedCount = _cache.items.filter(r => r.status === 'dismissed').length;
  if(status){
    status.textContent = `${_cache.items.length} total · ${pendingCount} pending · ${acceptedCount} accepted · ${dismissedCount} dismissed`;
  }

  if(!rows.length){
    body.innerHTML = `<div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">
      ${view === 'pending'
        ? 'No pending suggestions. Run the bulk AI auto-fill — when it spots patterns worth promoting from free-text into dedicated fields, they show up here.'
        : 'No suggestions yet.'}
    </div>`;
    return;
  }

  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Suggestion</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Reason</th>
          <th style="padding:9px 14px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Seen</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Last seen</th>
          <th style="padding:9px 14px;text-align:center;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Status</th>
          <th style="padding:9px 14px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const statusVal = r.status || 'pending';
          const statusChip = statusVal === 'accepted'
            ? `<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:#dcfce7;color:#14532d;border:1px solid #86efac;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">accepted</span>`
            : statusVal === 'dismissed'
            ? `<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">dismissed</span>`
            : `<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">pending</span>`;
          const typeChip = `<span style="display:inline-block;padding:0 6px;border-radius:99px;background:#dbeafe;color:#1e40af;font-size:9px;font-weight:700;font-family:ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em;margin-left:4px;">${esc(r.type||'text')}</span>`;
          const optionsLine = (r.type === 'enum' && Array.isArray(r.options) && r.options.length)
            ? `<div style="font-size:10px;color:#475569;margin-top:2px;">Options: ${r.options.map(o => `<code style="background:#f1f5f9;padding:0 4px;border-radius:3px;font-size:10px;">${esc(o)}</code>`).join(' · ')}</div>`
            : '';
          const actions = statusVal === 'pending'
            ? `<button data-action="accept" data-scope="${esc(r.scope)}" data-label="${esc(r.label)}" style="background:#2563eb;color:#fff;border:none;padding:4px 10px;font-size:11px;font-weight:700;border-radius:6px;cursor:pointer;margin-right:4px;font-family:inherit;">Add to taxonomy →</button>
               <button data-action="dismiss" data-scope="${esc(r.scope)}" data-label="${esc(r.label)}" style="background:#fff;border:1px solid #cbd5e1;color:#64748b;padding:4px 10px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;font-family:inherit;">Dismiss</button>`
            : `<button data-action="reopen" data-scope="${esc(r.scope)}" data-label="${esc(r.label)}" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#475569;padding:4px 10px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;font-family:inherit;">Reopen</button>`;
          return `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:9px 14px;color:#0f172a;">
                <div style="font-weight:600;">${esc(r.label||'(unlabeled)')}${typeChip}</div>
                <div style="font-size:10px;color:#64748b;margin-top:2px;"><code style="background:#f1f5f9;padding:0 4px;border-radius:3px;font-size:10px;">${esc(r.scope||'(no scope)')}</code></div>
                ${optionsLine}
              </td>
              <td style="padding:9px 14px;color:#475569;max-width:340px;">${esc(r.reason||'')}</td>
              <td style="padding:9px 14px;text-align:right;color:#0f172a;font-weight:700;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">${r.seen_count||1}</td>
              <td style="padding:9px 14px;color:#64748b;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;font-size:11px;">${_fmtWhen(r.last_seen_at)}</td>
              <td style="padding:9px 14px;text-align:center;">${statusChip}</td>
              <td style="padding:9px 14px;text-align:right;">${actions}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  // Wire the per-row action buttons.
  body.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.getAttribute('data-action');
      const scope = btn.getAttribute('data-scope');
      const label = btn.getAttribute('data-label');
      const idx = _findIdx(scope, label);
      if(idx < 0) return;
      if(action === 'accept'){
        // Close this modal, open the scope's Fields admin pre-populated.
        document.getElementById('bcAiSuggestionsModal')?.remove();
        if(typeof window._bcFieldsAdminForCategory === 'function'){
          // Stash the suggestion so the fields admin can read it via
          // the existing _bcFieldsAdminForCategory open-time hook
          // (extends the admin signature to consult window._bcAiPendingSuggestion
          // on first render).
          window._bcAiPendingSuggestion = { ..._cache.items[idx] };
          window._bcFieldsAdminForCategory(scope, async () => {
            // After the fields admin closes, refetch the latest
            // bc_field_definitions to check whether a matching col was
            // saved. Cheapest signal: compare label against any def in
            // the scope. If found, mark accepted; else leave pending.
            let added = false;
            try {
              const defs = (typeof window._bcFieldsGet === 'function')
                ? window._bcFieldsGet(scope) || [] : [];
              const lk = _norm(label);
              added = defs.some(d => _norm(d.label) === lk);
            } catch(_) {}
            if(added){
              _cache.items[idx].status = 'accepted';
              _cache.items[idx].accepted_at = new Date().toISOString();
              try { await _save(); } catch(_) {}
            }
            window._bcAiPendingSuggestion = null;
          });
        }
        return;
      }
      if(action === 'dismiss'){
        _cache.items[idx].status = 'dismissed';
        _cache.items[idx].dismissed_at = new Date().toISOString();
        try { await _save(); _render(); } catch(_) {}
        return;
      }
      if(action === 'reopen'){
        _cache.items[idx].status = 'pending';
        delete _cache.items[idx].accepted_at;
        delete _cache.items[idx].dismissed_at;
        try { await _save(); _render(); } catch(_) {}
        return;
      }
    });
  });
}
