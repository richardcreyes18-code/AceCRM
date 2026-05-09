// contacts/relationships.js — agent ↔ contact ownership (ace_agent_contacts).
//
// Phase 5 commit 4 of 4. Personal relationship list per agent. A contact
// can belong to multiple agents' lists (shared-claim model). In My Deals
// mode, the Contacts tab shows (my relationships) ∪ (contacts on my deals).
//
// Module-internal state (3 declarations):
//   _myRelationships, _myRelationshipsLoadMs, _relAllUsers
//
// External dependency: window._currentUser (already `var`). Function
// declarations like buildSidebar / _renderAgentPill / etc. resolve via
// the global env lookup chain. Note: js/core/auth.js calls
// window._loadMyRelationships from _signIn — main.js attaches it via
// the standard window-alias loop so this keeps working.

import { _sbGet, _sbPost, _sbDelete, _sbPatch } from '../core/supabase.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

// ─── AGENT RELATIONSHIPS (ace_agent_contacts) ────────────────────
// Personal relationship list per agent. A contact can belong to
// multiple agents' lists (shared-claim model). In My Deals mode,
// the Contacts tab shows the union of (my relationships) + (contacts
// tied to my deals). Admins behave like everyone else here — they
// have their own personal list.
//
// _myRelationships maps: contactId (string) -> junction row id (string)
// Storing the junction row id lets us delete via _sbDelete without
// needing a PostgREST filter helper. Presence of a key = "in my list".
let _myRelationships = new Map();
let _myRelationshipsLoadMs = 0;

export async function _loadMyRelationships(force) {
  if(!window._currentUser || !window._currentUser.id){ _myRelationships = new Map(); return; }
  // 120s cache unless forced
  if(!force && _myRelationshipsLoadMs && (Date.now() - _myRelationshipsLoadMs) < 120000) return;
  try {
    const rows = await _sbGet('ace_agent_contacts',
      `select=id,contact_id&user_id=eq.${window._currentUser.id}&limit=10000`);
    const m = new Map();
    (rows||[]).forEach(r => m.set(r.contact_id, r.id));
    _myRelationships = m;
    _myRelationshipsLoadMs = Date.now();
  } catch(e){
    console.warn('_loadMyRelationships failed:', e.message);
    // Don't wipe existing state on transient failure
  }
}

export function _isMyRelationship(contactId){
  return _myRelationships.has(contactId);
}

// Toggle add/remove. Optimistic: update Map first, revert on failure.
// Returns the new state (true = now in list, false = now removed).
export async function _toggleMyRelationship(contactId){
  if(!window._currentUser || !window._currentUser.id){
    alert('You must be logged in to manage relationships.');
    return null;
  }
  const wasIn = _myRelationships.has(contactId);
  if(wasIn){
    // Remove
    const rowId = _myRelationships.get(contactId);
    _myRelationships.delete(contactId); // optimistic
    try {
      await _sbDelete('ace_agent_contacts', rowId);
      return false;
    } catch(e){
      _myRelationships.set(contactId, rowId); // revert
      alert('Could not remove from relationships: ' + e.message);
      throw e;
    }
  } else {
    // Add — optimistic with placeholder id, replace with real id on success
    _myRelationships.set(contactId, '__pending__');
    try {
      const created = await _sbPost('ace_agent_contacts', {
        user_id: window._currentUser.id,
        contact_id: contactId,
        source: 'manual',                         // v113.54
        since_date: new Date().toISOString().slice(0,10),
      });
      const row = Array.isArray(created) ? created[0] : created;
      if(row && row.id){
        _myRelationships.set(contactId, row.id);
      }
      return true;
    } catch(e){
      _myRelationships.delete(contactId); // revert
      // Friendlier message for the unique-violation case (already in list
      // via another tab/session — just reload)
      if(String(e.message||'').includes('duplicate') || String(e.message||'').includes('unique')){
        await _loadMyRelationships(true);
        return _myRelationships.has(contactId);
      }
      alert('Could not add to relationships: ' + e.message);
      throw e;
    }
  }
}

// ─── v113.54: AGENT RELATIONSHIPS (multi-agent per contact) ──────────────
// Sits on top of ace_agent_contacts (same table the ★ button writes to).
// New columns: since_date, source, source_ref_id, updated_at.
//
// Helper: cached list of all users so the dropdown doesn't refetch per render.
let _relAllUsers = null;
export async function _relLoadUsers(force){
  if(!force && _relAllUsers) return _relAllUsers;
  try {
    const rows = await _sbGet('ace_users', 'select=id,name,fub_name,role&order=fub_name.asc');
    _relAllUsers = Array.isArray(rows) ? rows : [];
  } catch(e){ console.warn('[_relLoadUsers] failed:', e.message); _relAllUsers = []; }
  return _relAllUsers;
}

export async function _relListForContact(contactId){
  if(!contactId) return [];
  try {
    const rows = await _sbGet('ace_agent_contacts',
      `select=id,user_id,since_date,notes,source,source_ref_id,created_at,relationship_level,last_viewed_at,last_communicated_at&contact_id=eq.${contactId}&order=since_date.asc.nullslast,created_at.asc&limit=100`);
    return Array.isArray(rows) ? rows : [];
  } catch(e){ console.warn('[_relListForContact] failed:', e.message); return []; }
}

// UPSERT helper. If (contact, user) already exists, returns existing row.
// `source`: 'manual' / 'property_assignment' / 'buyer_criteria_edit'
export async function _relAddAgent(contactId, userId, opts){
  opts = opts || {};
  if(!contactId || !userId) return null;
  // Quick existence check
  try {
    const existing = await _sbGet('ace_agent_contacts',
      `select=id&contact_id=eq.${contactId}&user_id=eq.${userId}&limit=1`);
    if(Array.isArray(existing) && existing[0]) return existing[0];
  } catch(_){}
  const payload = {
    user_id: userId,
    contact_id: contactId,
    source: opts.source || 'manual',
    source_ref_id: opts.sourceRefId || null,
    since_date: opts.sinceDate || new Date().toISOString().slice(0,10),
    notes: opts.notes || null,
  };
  try {
    const created = await _sbPost('ace_agent_contacts', payload);
    return Array.isArray(created) ? created[0] : created;
  } catch(e){
    if(String(e.message||'').includes('duplicate') || String(e.message||'').includes('unique')){
      // race condition — re-fetch
      const rows = await _sbGet('ace_agent_contacts',
        `select=id&contact_id=eq.${contactId}&user_id=eq.${userId}&limit=1`);
      return rows?.[0] || null;
    }
    console.warn('[_relAddAgent] failed:', e.message);
    return null;
  }
}

export async function _relRemoveAgent(rowId){
  if(!rowId) return false;
  try { await _sbDelete('ace_agent_contacts', rowId); return true; }
  catch(e){ alert('Could not remove relationship: '+e.message); return false; }
}

export async function _relUpdateRow(rowId, patch){
  if(!rowId || !patch) return false;
  try { await _sbPatch('ace_agent_contacts', rowId, patch); return true; }
  catch(e){ alert('Could not save: '+e.message); return false; }
}

// v190: bump last_viewed_at / last_communicated_at on the (current user, contact)
// junction row. Upserts the row if it doesn't exist (cheap relationship side-effect
// — the user is engaging with the contact, so a relationship is implicit).
// Fire-and-forget; errors logged but never thrown.
export async function _relTouchActivity(contactId, kind){
  if(!contactId || !window._currentUser?.id) return;
  const col = kind === 'communicated' ? 'last_communicated_at' : 'last_viewed_at';
  const now = new Date().toISOString();
  try {
    const existing = await _sbGet('ace_agent_contacts',
      `select=id&user_id=eq.${window._currentUser.id}&contact_id=eq.${contactId}&limit=1`);
    if(Array.isArray(existing) && existing[0]){
      await _sbPatch('ace_agent_contacts', existing[0].id, { [col]: now });
    } else {
      await _sbPost('ace_agent_contacts', {
        user_id: window._currentUser.id,
        contact_id: contactId,
        source: 'manual',
        since_date: now.slice(0,10),
        [col]: now,
      });
    }
  } catch(e){
    console.warn('[_relTouchActivity] failed:', e.message);
  }
}

// Render the section into <div id="rp_relationships_{contactId}">.
export async function _relRenderForContact(contactId){
  const host = document.getElementById('rp_relationships_'+contactId);
  if(!host) return;
  const [users, rows] = await Promise.all([_relLoadUsers(), _relListForContact(contactId)]);
  const userById = new Map(users.map(u => [u.id, u]));
  const inSet = new Set(rows.map(r => r.user_id));
  const available = users.filter(u => !inSet.has(u.id));

  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const sourceLabel = {
    'manual':              '✋ Manual',
    'property_assignment': '🏢 Property',
    'buyer_criteria_edit': '🎯 Buyer Criteria',
    'fub_import_backfill': '📥 FUB Import',
  };

  const fmtTs = ts => {
    if(!ts) return '—';
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const opts = sameDay
        ? { hour:'numeric', minute:'2-digit' }
        : { month:'short', day:'numeric', year: d.getFullYear()===now.getFullYear()?undefined:'2-digit' };
      return d.toLocaleString('en-US', opts);
    } catch(_){ return '—'; }
  };

  const rowsHtml = rows.map(r => {
    const u = userById.get(r.user_id);
    const name  = u ? (u.name || u.fub_name) : ('user '+String(r.user_id).slice(0,8));
    const since = r.since_date || '';
    const notes = r.notes || '';
    const src   = sourceLabel[r.source] || (r.source ? esc(r.source) : '—');
    const lvl   = (r.relationship_level==null) ? '' : String(r.relationship_level);
    const levelOpts = [['','—']].concat([1,2,3,4,5,6,7,8,9,10].map(n => [String(n), String(n)]))
      .map(([v,l]) => `<option value="${v}"${v===lvl?' selected':''}>${l}</option>`).join('');
    return `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong style="font-size:13px;color:#0f172a;">👤 ${esc(name)}</strong>
            <span style="font-size:10px;color:#64748b;background:#f1f5f9;padding:2px 7px;border-radius:99px;">${src}</span>
          </div>
          <button onclick="_relRowRemove('${r.id}','${contactId}')"
            title="Remove relationship"
            style="background:none;border:none;color:#94a3b8;font-size:14px;cursor:pointer;padding:2px 6px;">✕</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
          <label style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Since</label>
          <input type="date" value="${esc(since)}"
            onchange="_relRowPatch('${r.id}', {since_date: this.value || null})"
            style="font-size:12px;padding:3px 6px;border:1px solid #cbd5e1;border-radius:5px;outline:none;" />
          <label style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-left:6px;" title="Relationship strength 1-10">Level</label>
          <select onchange="_relRowPatch('${r.id}', {relationship_level: this.value===''?null:parseInt(this.value,10)})"
            style="font-size:12px;padding:3px 6px;border:1px solid #cbd5e1;border-radius:5px;outline:none;background:#fff;">
            ${levelOpts}
          </select>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#64748b;margin-bottom:6px;">
          <span>👁 Last viewed: <strong style="color:#334155;font-weight:600;">${fmtTs(r.last_viewed_at)}</strong></span>
          <span>💬 Last comm: <strong style="color:#334155;font-weight:600;">${fmtTs(r.last_communicated_at)}</strong></span>
        </div>
        <textarea rows="2" placeholder="Relationship notes — e.g. 'Met at NJBIZ event, interested in self-storage', referral source, deal preferences…"
          onchange="_relRowPatch('${r.id}', {notes: this.value || null})"
          style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #cbd5e1;border-radius:5px;font-family:inherit;line-height:1.45;box-sizing:border-box;outline:none;resize:vertical;">${esc(notes)}</textarea>
      </div>`;
  }).join('');

  const dropdownOptions = available
    .map(u => `<option value="${u.id}">${esc(u.name || u.fub_name)}${u.role ? ' · '+esc(u.role) : ''}</option>`)
    .join('');
  const addRow = available.length ? `
    <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
      <select id="rp_rel_add_${contactId}"
        style="flex:1;font-size:12px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;">
        <option value="">+ Add an agent…</option>
        ${dropdownOptions}
      </select>
      <button onclick="_relAddFromDropdown('${contactId}')"
        style="background:#1a3a6e;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;">Add</button>
    </div>` : '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">All agents are already linked.</div>';

  host.innerHTML = `
    <div>
      <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">
        <span>🤝 Relationships${rows.length ? ` (${rows.length})` : ''}</span>
      </label>
      ${rows.length ? rowsHtml : '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:14px;font-size:12px;color:#94a3b8;text-align:center;">No agents linked yet.</div>'}
      ${addRow}
    </div>`;
}

window._relAddFromDropdown = async function(contactId){
  const sel = document.getElementById('rp_rel_add_'+contactId);
  const userId = sel?.value;
  if(!userId) return;
  const row = await _relAddAgent(contactId, userId, { source: 'manual' });
  if(row){ _relRenderForContact(contactId); }
};

window._relRowRemove = async function(rowId, contactId){
  if(!confirm('Remove this agent from the contact\'s relationships?')) return;
  const ok = await _relRemoveAgent(rowId);
  if(ok){ _relRenderForContact(contactId); }
};

window._relRowPatch = async function(rowId, patch){
  await _relUpdateRow(rowId, patch);
};

// v113.54: auto-sync relationships from a deal/property record. For each
// agent in the deal's Assigned Agent list, ensure ace_agent_contacts has a
// row linking them to the deal's owner_contact_id. Adds only — never removes.
export async function _relSyncFromDeal(deal){
  if(!deal) return;
  const ownerId = Array.isArray(deal['Owner']) ? deal['Owner'][0] : null;
  if(!ownerId) return;
  const agentList = (typeof _agentList === 'function')
    ? _agentList(deal['Assigned Agent'] || '')
    : String(deal['Assigned Agent']||'').split('|').map(s => s.trim()).filter(Boolean);
  if(!agentList.length) return;
  const users = await _relLoadUsers();
  // Name aliases mirror the SQL backfill
  const ALIAS = {
    'Dan Keenan':'Daniel Keenan', 'Joe Domenech':'Joseph Domenech',
    'Joe Spinella':'Joseph Spinella', 'Tim Emrich':'Timothy Emrich',
    'William Hartgers':'Will Hartgers', 'Everett James':'Everett McNulty',
  };
  for(const raw of agentList){
    const name = ALIAS[raw] || raw;
    const u = users.find(x => x.fub_name === name || x.name === name);
    if(!u) continue;
    await _relAddAgent(ownerId, u.id, { source: 'property_assignment', sourceRefId: deal.id });
  }
}

// v113.54: same idea for buyer-criteria edits — ensure the current user
// has a relationship with the criteria's contact. Only the current user
// (since they're the one editing).
export async function _relSyncFromBuyerCriteriaEdit(criteria){
  if(!criteria) return;
  const contactId = criteria.contact_id || (criteria['Contact ID']) || null;
  if(!contactId) return;
  if(!window._currentUser?.id) return;
  await _relAddAgent(contactId, window._currentUser.id, {
    source: 'buyer_criteria_edit',
    sourceRefId: criteria.id || null,
  });
}
