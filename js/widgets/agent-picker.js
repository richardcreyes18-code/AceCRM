// widgets/agent-picker.js — agent assignment popup + helper utils.
//
// Click the agent pill in a deal header / Summary page → floating popup
// lists every member of ace_company_directory grouped by role. Selecting
// one writes 'Assigned Agent' on ace_properties, updates currentDeal in
// memory, re-renders header + current tab. 'Unassigned' clears the agent.
//
// 14 exports: _loadAgentDirectory, _agentDisplayName, _agentList, _agentJoin,
// _agentHas, _agentAdd, _agentRemove, _agentPgFilter, _renderAgentPill,
// openAgentPicker, _clampAgentPicker, closeAgentPicker, pickAgent,
// removeAgentFromDeal.
//
// External dependencies on window.* (legacy still owns these):
//   state:    window._companyDirectory, window._companyDirLastLoadMs
//             (both `let` → `var` in this commit), window.currentDeal,
//             window.allDeals, window._currentUser
//   functions: getConfig, isSupabase, _aceSyncPost (function decls)

import { _sbGet, _sbPatch } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

// ═══════════════════════════════════════════════════════════════════════
// v102.22 — AGENT PICKER
// ═══════════════════════════════════════════════════════════════════════
// Click the agent pill in a deal header (or Summary page) → floating
// popup lists every member of ace_company_directory grouped by role.
// Selecting one writes 'Assigned Agent' (→ fub_assigned_to column) on
// ace_properties, updates window.currentDeal in memory, re-renders header +
// current tab. 'Unassigned' option at top clears the agent.
//
// Directory is cached in memory for 5 minutes, shared with the Company
// page (window._companyDirectory) so we don't double-fetch.
// ─────────────────────────────────────────────────────────────────────────

// Load the directory for the picker. Reuses window._companyDirectory cache
// from the Company page if present. Returns array sorted by sort_order.
export async function _loadAgentDirectory(){
  // window._companyDirectory is declared at line ~15097; check it's populated and fresh
  if(typeof window._companyDirectory !== 'undefined' && window._companyDirectory.length
     && typeof window._companyDirLastLoadMs !== 'undefined'
     && (Date.now() - window._companyDirLastLoadMs) < 300000){
    return window._companyDirectory;
  }
  try {
    const rows = await _sbGet('ace_company_directory', 'select=*&order=sort_order.asc');
    if(typeof window._companyDirectory !== 'undefined'){
      window._companyDirectory.length = 0;
      (rows||[]).forEach(r => window._companyDirectory.push(r));
      if(typeof window._companyDirLastLoadMs !== 'undefined') window._companyDirLastLoadMs = Date.now();
    }
    return rows || [];
  } catch(e) {
    console.warn('[agent picker] directory load failed:', e.message);
    return [];
  }
}

// Compact display name: "First L." — same pattern the header uses today,
// but works for any name (not just the hardcoded HDR_NAME_MAP).
export function _agentDisplayName(fullName){
  if(!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  if(parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length-1][0].toUpperCase() + '.';
}

// ─── Multi-agent helpers ─────────────────────────────────────────
// Storage format: single name OR pipe-delimited with spaces, e.g. "Alice | Bob".
// Legacy single-agent values remain valid (treated as a 1-element list).
// Empty / null / whitespace → empty list.
export function _agentList(val){
  if(!val) return [];
  return String(val).split('|').map(s => s.trim()).filter(Boolean);
}
export function _agentJoin(arr){
  const cleaned = (arr||[]).map(s => String(s||'').trim()).filter(Boolean);
  // De-dup while preserving order (case-insensitive)
  const seen = new Set(); const out = [];
  for(const n of cleaned){ const k = n.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(n); } }
  return out.join(' | ');
}
export function _agentHas(val, name){
  if(!name) return false;
  const needle = String(name).trim().toLowerCase();
  return _agentList(val).some(n => n.toLowerCase() === needle);
}
export function _agentAdd(val, name){
  return _agentJoin([..._agentList(val), name]);
}
export function _agentRemove(val, name){
  const needle = String(name||'').trim().toLowerCase();
  return _agentJoin(_agentList(val).filter(n => n.toLowerCase() !== needle));
}
// PostgREST filter that matches agentName whether stored solo OR as one entry
// in a pipe-delimited list. Returns a URL-ready fragment WITHOUT the leading "?"
// or "&" — callers concatenate with their query. Format we match against:
//   "Alice"              → eq.Alice
//   "Alice | Bob"        → ilike."Alice | *" or "* | Alice" or "* | Alice | *"
// NOTE: PostgREST uses * as its ilike wildcard (no need for literal %).
export function _agentPgFilter(agentName, column){
  const col = column || 'fub_assigned_to';
  const name = String(agentName||'').trim();
  if(!name) return '';
  // encodeURIComponent handles spaces, pipe, etc. safely for URL params.
  const e = encodeURIComponent(name);
  // Quote any embedded commas/dots in the value — PostgREST treats . and , as
  // separators inside or=(...). We use the same "double-quote" escape PostgREST
  // supports (wrap value in %22...%22). Simpler: rely on encodeURIComponent;
  // agent names don't normally contain . or , so we accept that edge case.
  return `or=(${col}.eq.${e},${col}.ilike.${e}%20%7C%20*,${col}.ilike.*%20%7C%20${e},${col}.ilike.*%20%7C%20${e}%20%7C%20*)`;
}

// Render the pill HTML for a given agent name. Used in both the deal header
// and the Summary KPI cell. Always renders something — dashed gray pill
// when unassigned so the user can still click to pick someone.
export function _renderAgentPill(dealId, agentFull, size){
  // size: 'sm' (header, 11px) | 'md' (summary KPI, 13px)
  // Renders a row of pills — one per agent in the pipe-delimited value.
  // Each pill: click body to open picker (add another), click × to remove just that one.
  // Empty value → single dashed "Unassigned" pill that opens the picker.
  const s = size === 'md' ? {
    fs:'13px', pad:'4px 12px', emoji:'', xFs:'12px', gap:'6px', addFs:'12px', addPad:'3px 10px'
  } : {
    fs:'11px', pad:'2px 9px', emoji:'👤 ', xFs:'10px', gap:'4px', addFs:'10px', addPad:'2px 8px'
  };
  const list = _agentList(agentFull);
  const wrapOpen  = `<span class="agent-pill-row" data-deal-id="${dealId}" style="display:inline-flex;flex-wrap:wrap;align-items:center;gap:${s.gap};vertical-align:middle;">`;
  const wrapClose = `</span>`;
  if(list.length === 0){
    return wrapOpen + `<span class="agent-pill" data-deal-id="${dealId}"
      onclick="event.stopPropagation(); openAgentPicker(this, '${dealId}')"
      title="Click to assign an agent"
      style="background:#f8fafc;color:#64748b;font-size:${s.fs};font-weight:600;padding:${s.pad};border-radius:99px;white-space:nowrap;cursor:pointer;border:1px dashed #cbd5e1;display:inline-block;"
      onmouseenter="this.style.background='#eef2fb';this.style.borderColor='#93c5fd';this.style.color='#1a3a6e'"
      onmouseleave="this.style.background='#f8fafc';this.style.borderColor='#cbd5e1';this.style.color='#64748b'">${s.emoji}Unassigned</span>` + wrapClose;
  }
  const pills = list.map(name => {
    const disp = _agentDisplayName(name);
    const safe = name.replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return `<span class="agent-pill" data-deal-id="${dealId}" data-agent="${safe}"
      title="${safe} — click to add another"
      style="background:#1a3a6e;color:#fff;font-size:${s.fs};font-weight:600;padding:${s.pad};border-radius:99px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;cursor:pointer;"
      onclick="event.stopPropagation(); openAgentPicker(this, '${dealId}')"
      onmouseenter="this.style.background='#2c4f8a'; var x=this.querySelector('.agent-pill-x'); if(x) x.style.opacity='1';"
      onmouseleave="this.style.background='#1a3a6e'; var x=this.querySelector('.agent-pill-x'); if(x) x.style.opacity='.55';"
      >${s.emoji}${disp}<span class="agent-pill-x"
        onclick="event.stopPropagation(); removeAgentFromDeal('${dealId}', '${safe}')"
        title="Remove this agent"
        style="opacity:.55;font-size:${s.xFs};line-height:1;padding:0 2px;cursor:pointer;">×</span></span>`;
  }).join('');
  // "+ Add" chip — opens picker in add mode (same picker, but knows more agents may exist)
  const addChip = `<span class="agent-pill-add" data-deal-id="${dealId}"
    onclick="event.stopPropagation(); openAgentPicker(this, '${dealId}')"
    title="Add another agent"
    style="background:#f8fafc;color:#64748b;font-size:${s.addFs};font-weight:600;padding:${s.addPad};border-radius:99px;white-space:nowrap;cursor:pointer;border:1px dashed #cbd5e1;display:inline-block;"
    onmouseenter="this.style.background='#eef2fb';this.style.borderColor='#93c5fd';this.style.color='#1a3a6e'"
    onmouseleave="this.style.background='#f8fafc';this.style.borderColor='#cbd5e1';this.style.color='#64748b'">+ Add</span>`;
  return wrapOpen + pills + addChip + wrapClose;
}

let _agentPickerCurrent = null; // the popup element currently open, if any

export async function openAgentPicker(anchorEl, dealId){
  // Close any existing picker first
  closeAgentPicker();

  const deal = window.allDeals.find(d => d.id === dealId);
  if(!deal){ console.warn('[agent picker] deal not found:', dealId); return; }
  const currentList = _agentList(deal['Assigned Agent'] || '');
  const assignedSet = new Set(currentList.map(n => n.toLowerCase()));

  // Create the popup shell with a loading state — it renders immediately
  // so the user gets feedback while we fetch the directory.
  const popup = document.createElement('div');
  popup.id = 'agentPickerPopup';
  popup.style.cssText = 'position:fixed;z-index:99999;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.15);min-width:260px;max-width:320px;max-height:70vh;overflow-y:auto;font-family:inherit;';
  popup.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div>
        <div style="font-size:11px;font-weight:700;color:#1a3a6e;text-transform:uppercase;letter-spacing:.05em;">Assign Agents</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:2px;">Click to add or remove — multiple allowed</div>
      </div>
      <span onclick="closeAgentPicker()" style="cursor:pointer;color:#94a3b8;font-size:16px;line-height:1;padding:0 4px;">×</span>
    </div>
    <div id="agentPickerBody" style="padding:6px 0;">
      <div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px;">Loading team...</div>
    </div>`;
  document.body.appendChild(popup);
  _agentPickerCurrent = popup;

  // Position the popup below the anchor. getBoundingClientRect gives viewport coords
  // which is what position:fixed wants.
  const rect = anchorEl.getBoundingClientRect();
  popup.style.top  = (rect.bottom + 6) + 'px';
  popup.style.left = rect.left + 'px';
  // After we render the body, we may need to flip/clamp if it overflows viewport
  requestAnimationFrame(() => _clampAgentPicker(popup, rect));

  // Click-outside dismissal — attached on next tick so the click that opened
  // the popup doesn't immediately close it.
  setTimeout(() => {
    const onDocClick = (e) => {
      if(!popup.contains(e.target) && !anchorEl.contains(e.target)){
        closeAgentPicker();
        document.removeEventListener('click', onDocClick);
      }
    };
    document.addEventListener('click', onDocClick);
    popup._docClickHandler = onDocClick;
  }, 50);

  // Fetch directory and paint
  const dir = await _loadAgentDirectory();
  // Guard: user may have closed the popup before fetch returned
  if(_agentPickerCurrent !== popup) return;

  const body = popup.querySelector('#agentPickerBody');
  if(!body) return;

  if(dir.length === 0){
    body.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px;">Team directory is empty.<br>Add members in the Company tab.</div>';
    return;
  }

  // Group by role, role order from the Company page paint
  const roleOrder = ['Agent','Transaction Coordinator','Marketing','Admin','Other'];
  const roleColors = {
    'Agent':'#1e40af','Transaction Coordinator':'#7c3aed',
    'Marketing':'#db2777','Admin':'#059669','Other':'#64748b'
  };
  const groups = {};
  dir.forEach(r => {
    const role = r.role || 'Other';
    if(!groups[role]) groups[role] = [];
    groups[role].push(r);
  });
  const sortedRoles = Object.keys(groups).sort((a,b) => {
    const ai = roleOrder.indexOf(a), bi = roleOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // "Clear all" row at top (only meaningful if someone is currently assigned)
  const isUnassigned = assignedSet.size === 0;
  let html = `
    <div onclick="pickAgent('${dealId}', null, 'clear')"
      style="display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;${isUnassigned?'background:#f1f5f9;':''}"
      onmouseenter="this.style.background='#f8fafc'"
      onmouseleave="this.style.background='${isUnassigned?'#f1f5f9':'transparent'}'">
      <span style="width:28px;height:28px;border-radius:50%;background:#f1f5f9;border:1px dashed #cbd5e1;display:inline-flex;align-items:center;justify-content:center;color:#94a3b8;font-size:14px;flex-shrink:0;">—</span>
      <span style="flex:1;">${isUnassigned ? 'Unassigned' : 'Clear all agents'}</span>
      ${isUnassigned ? '<span style="color:#1a3a6e;font-size:14px;">✓</span>' : ''}
    </div>
  `;

  for(const role of sortedRoles){
    const color = roleColors[role] || '#64748b';
    html += `<div style="padding:8px 14px 4px;font-size:9px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.08em;">${role}s</div>`;
    for(const p of groups[role]){
      const name = (p.name||'').trim();
      if(!name) continue;
      const initials = name.split(/\s+/).map(s=>s[0]).filter(Boolean).slice(0,2).join('').toUpperCase();
      const isActive = assignedSet.has(name.toLowerCase());
      // Escape quotes in name for the onclick attribute
      const safeName = name.replace(/'/g,"\\'").replace(/"/g,'&quot;');
      // Active → clicking removes just this agent. Inactive → clicking adds.
      const action = isActive ? 'remove' : 'add';
      html += `
        <div onclick="pickAgent('${dealId}', '${safeName}', '${action}')"
          style="display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;font-size:13px;color:#0f172a;${isActive?'background:'+color+'15;':''}"
          onmouseenter="this.style.background='${color}10'"
          onmouseleave="this.style.background='${isActive?color+'15':'transparent'}'">
          <span style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,${color},${color}cc);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${initials}</span>
          <span style="flex:1;">${name.replace(/</g,'&lt;')}</span>
          ${isActive
            ? `<span style="color:${color};font-size:14px;" title="Assigned — click to remove">✓</span>`
            : `<span style="color:#94a3b8;font-size:16px;line-height:1;" title="Click to add">+</span>`}
        </div>`;
    }
  }

  body.innerHTML = html;
  // Re-clamp in case content changed height
  requestAnimationFrame(() => _clampAgentPicker(popup, rect));
}

// Keep the popup inside the viewport — flip upward if bottom overflows,
// and clamp left if right-edge overflows.
export function _clampAgentPicker(popup, anchorRect){
  const pr = popup.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  // Vertical flip: if bottom overflows, put the popup ABOVE the anchor
  if(pr.bottom > vh - 8){
    const flipped = anchorRect.top - pr.height - 6;
    popup.style.top = Math.max(8, flipped) + 'px';
  }
  // Horizontal clamp
  if(pr.right > vw - 8){
    popup.style.left = Math.max(8, vw - pr.width - 8) + 'px';
  }
}

export function closeAgentPicker(){
  if(_agentPickerCurrent){
    if(_agentPickerCurrent._docClickHandler){
      document.removeEventListener('click', _agentPickerCurrent._docClickHandler);
    }
    _agentPickerCurrent.remove();
    _agentPickerCurrent = null;
  }
}

// Actions:
//   'add'     → append agentName to the current pipe-delimited list (no-op if already present)
//   'remove'  → drop agentName from the list
//   'clear'   → drop everyone (agentName ignored)
//   undefined → legacy replace-all (kept for any old call sites); if agentName falsy, clears
export async function pickAgent(dealId, agentName, action){
  closeAgentPicker();
  const deal = window.allDeals.find(d => d.id === dealId);
  if(!deal) return;
  const currentVal = deal['Assigned Agent'] || '';
  let nextVal;
  if(action === 'add')         nextVal = _agentAdd(currentVal, agentName);
  else if(action === 'remove') nextVal = _agentRemove(currentVal, agentName);
  else if(action === 'clear')  nextVal = '';
  else                         nextVal = agentName ? _agentJoin([agentName]) : ''; // legacy replace-all
  // Persist as null when empty so the column stays clean (not empty string)
  const writeVal = nextVal ? nextVal : null;
  // airtableUpdate routes through _atToSb which maps 'Assigned Agent' → fub_assigned_to
  const ok = await airtableUpdate(dealId, { 'Assigned Agent': writeVal });
  if(!ok){ alert('Failed to save agent. Check your connection.'); return; }
  // Update in-memory deal
  deal['Assigned Agent'] = writeVal;
  if(window.currentDeal && window.currentDeal.id === dealId){
    window.currentDeal['Assigned Agent'] = writeVal;
    if(typeof renderDealPage === 'function') renderDealPage();
    if(currentTab === 'summary'){
      const tabContentEl = document.getElementById('tabContent');
      if(tabContentEl) tabContentEl.innerHTML = renderSummaryTab(window.currentDeal);
    }
  }
  // v113.54: auto-sync relationships — every agent on the deal gets a
  // relationship row linking them to the property's owner contact.
  if(action !== 'remove' && action !== 'clear'){
    _relSyncFromDeal(deal);
  }
  // Confirm toast
  let msg;
  if(action === 'remove')      msg = `Removed ${agentName} ✓`;
  else if(action === 'clear')  msg = 'Agents cleared ✓';
  else if(action === 'add' && !_agentHas(currentVal, agentName)) msg = `Added ${agentName} ✓`;
  else if(action === 'add')    msg = `${agentName} already assigned`;
  else                         msg = writeVal ? `Agent set to ${writeVal} ✓` : 'Agent cleared ✓';
  showSaveConfirm(msg);
}

// Called from the × on each agent pill to remove just that one agent
// without opening the picker. Thin wrapper over pickAgent(..., 'remove').
export async function removeAgentFromDeal(dealId, agentName){
  return pickAgent(dealId, agentName, 'remove');
}
