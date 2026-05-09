// email/library.js — email templates library / folder browser.
//
// Phase 4 commit 4 of 11. Part B of "Email Region 2" — the library UI:
// folder list, template table, link-to-property modal, auto-link worker,
// row-level link/unlink/save/delete actions.
//
// Part A of Region 2 (state declarations + _propertyTemplateMap helpers
// at lines ~29734–29773 in legacy) STAYS in legacy because it's
// interleaved with the task-notification block which migrates separately
// later. This module reads `window._emailTplsLibState` and
// `window._propertyTemplateMap` directly — both have been converted to
// `var` in legacy so they auto-attach to the global object.
//
// External dependencies on window.* / function decls (auto-attached):
//   state:    window._emailTplsLibState (legacy `let` → `var` in this commit),
//             window._propertyTemplateMap, window.allDeals, window._currentUser
//   functions: _ddEsc, _normalizeAddr, _addrMatches, _propertyTemplateMap helpers
//   schema:   EMAIL_TPL_FIELDS / DEFAULTS / PLACEHOLDERS — already in
//             window.* via the email/templates module (commit v258)

import { _sbGet, _sbPatch, _sbPost, _sbDelete } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

// ═══════════════════════════════════════════════════════════════════════
// LEGACY BLOCK BELOW — copied from index.html with `export` added to
// top-level functions. Many functions in this block are assigned via
// `window.X = function(...){...}` directly — those auto-register on the
// global object when this module loads, so main.js doesn't need to
// re-attach them via the Object.entries loop.
// ═══════════════════════════════════════════════════════════════════════

// Mutators — keep the map in sync after link/unlink/delete actions so
// the indicators update without a full reload.
export function _ptmInc(propertyId){
  if(!propertyId) return;
  window._propertyTemplateMap.set(propertyId, (window._propertyTemplateMap.get(propertyId)||0) + 1);
}
export function _ptmDec(propertyId){
  if(!propertyId) return;
  const cur = window._propertyTemplateMap.get(propertyId) || 0;
  if(cur <= 1) window._propertyTemplateMap.delete(propertyId);
  else window._propertyTemplateMap.set(propertyId, cur - 1);
}

// Click handler used by both folder list rows and the breadcrumb
// "← Folders" link. Resets search when navigating.
window._emailTplsOpenFolder = function(folder){
  window._emailTplsLibState.activeFolder = folder;
  window._emailTplsLibState.search = '';
  _emailTplsLibPaint();
};

// v113.49: per-template editor modal. Opens on row click, lets the user
// view / edit / save / delete the template. Mirrors the FUB "Edit Email
// Template" dialog.
window._emailTplsOpenEditor = function(templateId){
  const t = (window._emailTplsLibState.rows || []).find(r => r.id === templateId);
  if(!t) return;
  document.getElementById('emailTplsEditorModal')?.remove();

  const propById = new Map();
  for(const d of (window.allDeals||[])) if(d?.id) propById.set(d.id, d);
  const contactById = new Map();
  for(const c of (allContacts||[])) if(c?.id) contactById.set(c.id, c);
  const prop = t.property_id ? propById.get(t.property_id) : null;
  const ownerId = prop?.['Owner']?.[0];
  const owner = ownerId ? contactById.get(ownerId) : null;

  const modal = document.createElement('div');
  modal.id = 'emailTplsEditorModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.onclick = (e) => { if(e.target === modal) modal.remove(); };

  const created = t.created_at ? new Date(t.created_at).toLocaleDateString() : '';
  const updated = t.updated_at && t.updated_at !== t.created_at ? new Date(t.updated_at).toLocaleDateString() : '';
  // v166.1: shared library — surface the template owner so an agent
  // browsing someone else's template knows whose it is, and visually
  // disable the Save/Delete buttons when they can't mutate.
  const _canMutate = _emailTplCanMutate(t);
  const _ownerLine = t.user_email
    ? `<span style="display:inline-block;background:${_canMutate?'#dcfce7':'#fef3c7'};color:${_canMutate?'#15803d':'#92400e'};border:1px solid ${_canMutate?'#86efac':'#fde68a'};border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-left:6px;">✉ ${_ddEsc(t.user_email)}${_canMutate?' (you)':''}</span>`
    : '';
  const _readOnlyAttr = _canMutate ? '' : 'readonly';
  const _saveBtnDisabled = _canMutate ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"';
  const _deleteBtnDisabled = _canMutate ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:780px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
      <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-size:15px;font-weight:700;color:#0f172a;">📧 ${_canMutate?'Edit':'View'} Email Template${_ownerLine}</div>
          <div style="font-size:11px;color:#64748b;margin-top:3px;">
            ${created ? `Created ${created}` : ''}
            ${updated ? ` · Updated ${updated}` : ''}
            ${!_canMutate ? ' · <span style="color:#92400e;">read-only — owned by another user</span>' : ''}
          </div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            ${prop
              ? `<span onclick="openDeal(window.allDeals.find(d=>d.id==='${prop.id}'))" style="display:inline-block;background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">🏢 ${_ddEsc((prop['Address']||'').slice(0,60))}</span>
                 <button onclick="_emailTplsUnlink('${t.id}')" title="Unlink from this property — pick a different one or leave unlinked" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">✕ Unlink</button>
                 <button onclick="_emailTplsLinkPicker('${t.id}'); this.closest('#emailTplsEditorModal').remove();" title="Replace the linked property" style="background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">🔗 Change link</button>`
              : (_emailTplIsNoLinkNeeded(t)
                  ? `<span ${t.no_link_needed ? `onclick="_emailTplsToggleNoLink('${t.id}', false); this.closest('#emailTplsEditorModal').remove();" title="Click to mark as needing a property link" style="cursor:pointer;"` : 'style=""'} style="display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;${t.no_link_needed ? 'cursor:pointer;' : ''}">📎 No link needed</span>
                     <button onclick="_emailTplsLinkPicker('${t.id}'); this.closest('#emailTplsEditorModal').remove();" title="Link this template to a property" style="background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">🔗 Link to property</button>`
                  : `<span onclick="_emailTplsToggleNoLink('${t.id}', true); this.closest('#emailTplsEditorModal').remove();" title="Remove this template from Unlinked — mark as no-link-needed" style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">🔗 Unlinked</span>
                     <button onclick="_emailTplsLinkPicker('${t.id}'); this.closest('#emailTplsEditorModal').remove();" title="Link this template to a property" style="background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">🔗 Link to property</button>`)}
            ${owner ? `<span onclick="openContactModal('${owner.id}')" style="display:inline-block;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;">👤 ${_ddEsc(owner['Name']||'')}</span>` : ''}
            ${prop && prop['Assigned Agent'] ? (typeof _agentList === 'function' ? _agentList(prop['Assigned Agent']) : String(prop['Assigned Agent']).split('|').map(s=>s.trim()).filter(Boolean)).map(a => `<span style="display:inline-block;background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;" title="${_ddEsc(a)}">🤵 ${_ddEsc(typeof _agentDisplayName==='function'?_agentDisplayName(a):a)}</span>`).join('') : ''}
            ${/^\(FUB IMPORT/.test(t.name||'') ? '<span style="display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;">📥 FUB Import</span>' : ''}
          </div>
        </div>
        <button onclick="this.closest('#emailTplsEditorModal').remove()" style="background:none;border:none;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;">×</button>
      </div>
      <div style="padding:16px 20px;overflow-y:auto;flex:1;">
        <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:5px;">Template Name</div>
        <input id="_etplName" type="text" value="${_ddEsc(t.name||'')}" ${_readOnlyAttr}
          style="width:100%;padding:8px 10px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:14px;box-sizing:border-box;outline:none;${_canMutate?'':'background:#f8fafc;color:#475569;'}" />
        <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:5px;">Subject</div>
        <input id="_etplSubject" type="text" value="${_ddEsc(t.subject||'')}" ${_readOnlyAttr}
          style="width:100%;padding:8px 10px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:14px;box-sizing:border-box;outline:none;${_canMutate?'':'background:#f8fafc;color:#475569;'}" />
        <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:5px;">Body</div>
        <textarea id="_etplBody" rows="16" ${_readOnlyAttr}
          style="width:100%;padding:10px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;font-family:inherit;line-height:1.5;box-sizing:border-box;resize:vertical;outline:none;${_canMutate?'':'background:#f8fafc;color:#475569;'}">${_ddEsc(t.body||'')}</textarea>
        <div style="margin-top:8px;font-size:10px;color:#94a3b8;">
          Placeholders like %sender_name%, %contact_first_name% are filled at send-time.
        </div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button onclick="_emailTplsDeleteOne('${t.id}')" ${_deleteBtnDisabled} style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;padding:7px 14px;font-size:11px;font-weight:600;cursor:pointer;">🗑 Delete</button>
          ${!prop ? `<button onclick="_emailTplsToggleNoLink('${t.id}', ${!t.no_link_needed}); this.closest('#emailTplsEditorModal').remove();" title="${t.no_link_needed ? 'Move back to the Unlinked folder' : 'Remove this template from Unlinked — admin / marketing, no property needed'}" style="background:${t.no_link_needed ? '#fef3c7' : '#f1f5f9'};color:${t.no_link_needed ? '#92400e' : '#475569'};border:1px solid ${t.no_link_needed ? '#fde68a' : '#cbd5e1'};border-radius:6px;padding:7px 14px;font-size:11px;font-weight:600;cursor:pointer;">${t.no_link_needed ? '🔗 Mark as Unlinked' : '📎 Remove from Unlinked'}</button>` : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button onclick="this.closest('#emailTplsEditorModal').remove()" style="background:#fff;color:#475569;border:1px solid #cbd5e1;border-radius:6px;padding:7px 14px;font-size:11px;font-weight:600;cursor:pointer;">Close</button>
          <button onclick="_emailTplsSaveOne('${t.id}')" ${_saveBtnDisabled} style="background:#1a3a6e;color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:11px;font-weight:700;cursor:pointer;">${_canMutate?'✓ Save':'🔒 Read-only'}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  // Focus the name field for quick edits
  requestAnimationFrame(() => document.getElementById('_etplName')?.focus());
};

// v166.1: shared library guard — only the template's owner or an admin
// can edit / delete a template. Other agents can view and copy/use it
// but never mutate it.
export function _emailTplCanMutate(row){
  if(!row) return false;
  const isAdmin = !!(window._currentUser && window._currentUser.role === 'admin');
  if(isAdmin) return true;
  const myEmail = (window._currentUser && window._currentUser.email || '').toLowerCase();
  const owner   = String(row.user_email || '').toLowerCase();
  return !!myEmail && myEmail === owner;
}

window._emailTplsSaveOne = async function(id){
  const r = (window._emailTplsLibState.rows || []).find(x => x.id === id);
  if(!_emailTplCanMutate(r)){
    alert('You can only edit your own templates. Ask the owner ('+(r?.user_email || '?')+') or an admin to make changes.');
    return;
  }
  const name    = document.getElementById('_etplName')?.value || '';
  const subject = document.getElementById('_etplSubject')?.value || '';
  const body    = document.getElementById('_etplBody')?.value || '';
  if(!name.trim()){ alert('Name is required.'); return; }
  try {
    await _sbPatch('ace_user_email_templates', id, { name, subject, body });
    if(r){ r.name = name; r.subject = subject; r.body = body; r.updated_at = new Date().toISOString(); }
    if(typeof showSaveConfirm === 'function') showSaveConfirm('✓ Template saved');
    document.getElementById('emailTplsEditorModal')?.remove();
    _emailTplsLibPaint();
  } catch(e){ alert('Save failed: '+e.message); }
};

window._emailTplsDeleteOne = async function(id){
  const r = (window._emailTplsLibState.rows || []).find(x => x.id === id);
  if(!r) return;
  if(!_emailTplCanMutate(r)){
    alert('You can only delete your own templates. Ask the owner ('+(r.user_email || '?')+') or an admin to remove this one.');
    return;
  }
  if(!confirm(`Delete template:\n\n${r.name}\n\nThis cannot be undone.`)) return;
  try {
    await _sbDelete('ace_user_email_templates', id);
    if(r.property_id) _ptmDec(r.property_id);
    window._emailTplsLibState.rows = (window._emailTplsLibState.rows || []).filter(x => x.id !== id);
    if(typeof showSaveConfirm === 'function') showSaveConfirm('✓ Template deleted');
    document.getElementById('emailTplsEditorModal')?.remove();
    _emailTplsLibPaint();
    if(typeof _refreshPipelineBody === 'function') _refreshPipelineBody();
  } catch(e){ alert('Delete failed: '+e.message); }
};

export async function _emailTplsTabRender(){
  const root = document.getElementById('emailTplsTabRoot');
  if(!root) return;
  root.innerHTML = `<div style="padding:30px;text-align:center;color:#64748b;font-size:13px;">Loading templates…</div>`;
  const userEmail = window._currentUser?.email;
  if(!userEmail){
    root.innerHTML = `<div style="padding:30px;color:#b91c1c;">Sign in first.</div>`;
    return;
  }
  let rows;
  try {
    // v166.1: shared template library — pull every user's templates so
    // agents see the same folder/template tree the admin sees. Editing
    // and deleting is still locked to template owner + admin (handled in
    // _emailTplsSaveOne / _emailTplsDeleteOne).
    rows = await _sbGet('ace_user_email_templates',
      `select=*&order=created_at.desc&limit=5000`);
  } catch(e){
    root.innerHTML = `<div style="padding:30px;color:#b91c1c;">Failed to load: ${_ddEsc(e.message)}</div>`;
    return;
  }
  window._emailTplsLibState.rows = Array.isArray(rows) ? rows : [];
  // v127: pull any properties referenced by the templates that aren't already
  // in window.allDeals (personal pipeline filter excludes deals owned by other
  // agents — without this, those templates render as "Unlinked"). Fire this
  // before the first paint so the badges are correct.
  if(typeof _emailTplsLoadMissingProps === 'function'){
    try { await _emailTplsLoadMissingProps(); } catch(_){}
  }
  // Reset to folder list when (re-)rendering.
  window._emailTplsLibState.activeFolder = null;
  window._emailTplsLibState.search = '';
  _emailTplsLibPaint();
}

// v127: lazy-fetched property cache for email templates. window.allDeals is filtered
// in personal pipeline mode, so a template with property_id pointing at a
// deal owned by another agent disappears from the lookup. We fetch any
// missing property_ids from ace_properties on-demand and cache them here so
// the Linked badge + Open Deal button render correctly.
window._emailTplsExtraProps = window._emailTplsExtraProps || new Map();
export async function _emailTplsLoadMissingProps(){
  const rows = (typeof window._emailTplsLibState !== 'undefined' && window._emailTplsLibState?.rows) || [];
  const inAllDeals = new Set((window.allDeals||[]).map(d => d?.id).filter(Boolean));
  const need = [];
  for(const r of rows){
    if(!r.property_id) continue;
    if(inAllDeals.has(r.property_id)) continue;
    if(window._emailTplsExtraProps.has(r.property_id)) continue;
    need.push(r.property_id);
  }
  if(!need.length) return false;
  try {
    const ids = need.map(s => `"${s}"`).join(',');
    const fresh = await _sbGet(SB_TABLES.properties,
      `id=in.(${ids})&select=id,address,fub_assigned_to,owner_contact_id&deleted_at=is.null&limit=${need.length}`);
    if(!Array.isArray(fresh)) return false;
    for(const p of fresh){
      // Match the Airtable-style shape the renderer expects.
      window._emailTplsExtraProps.set(p.id, {
        id: p.id,
        'Address': p.address,
        'Assigned Agent': p.fub_assigned_to || '',
        'Owner': p.owner_contact_id ? [p.owner_contact_id] : [],
      });
    }
    return true;
  } catch(e){
    console.warn('[email-tpls] missing-prop fetch failed:', e.message);
    return false;
  }
}

// v127: link an unlinked template to a property the user picks. Shows a
// modal with a search input, lists matching properties from window.allDeals (and
// the lazy cache), and on selection PATCHes the template + auto-sets
// is_official=true when no other official template exists for that property.
window._emailTplsLinkPicker = function(tplId){
  const tpl = (window._emailTplsLibState.rows || []).find(r => r.id === tplId);
  if(!tpl){ alert('Template not found.'); return; }

  // Build candidate property list (window.allDeals union with lazy cache).
  // v140: skip any entry flagged Is Archived (post-merge soft-delete) so
  // merged-loser properties never appear in the user-facing picker.
  // The merge handler already calls _purgeMergedFromMemory; this is a
  // defensive belt-and-suspenders for stale state from prior sessions.
  const seen = new Set();
  const candidates = [];
  const seedHint = (tpl.subject || tpl.name || '').toLowerCase();
  for(const d of (window.allDeals||[])){
    if(!d?.id || seen.has(d.id)) continue;
    if(d['Is Archived']) continue;
    seen.add(d.id);
    candidates.push({ id: d.id, address: d['Address'] || '', agent: d['Assigned Agent'] || '' });
  }
  for(const [id, d] of window._emailTplsExtraProps.entries()){
    if(seen.has(id)) continue;
    if(d && d['Is Archived']) continue;
    seen.add(id);
    candidates.push({ id, address: d['Address'] || '', agent: d['Assigned Agent'] || '' });
  }

  const modal = document.createElement('div');
  modal.id = 'emailTplsLinkModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.onclick = (e) => { if(e.target === modal) modal.remove(); };

  const renderList = (q) => {
    const ql = String(q||'').trim().toLowerCase();
    // v144: normalized-address match catches spelling variants in the
    // search box ("first ave" / "1st avenue", "NJ-77" / "Highway 77").
    const qlNorm = ql ? _normalizeAddr(ql) : '';
    const list = ql
      ? candidates.filter(c => {
          if(c.address.toLowerCase().includes(ql)) return true;
          if(c.agent.toLowerCase().includes(ql)) return true;
          if(qlNorm && _normalizeAddr(c.address).indexOf(qlNorm) !== -1) return true;
          return false;
        })
      : candidates.slice(0, 50);
    if(!list.length) return '<div style="padding:20px;text-align:center;font-size:12px;color:#94a3b8;">No properties match.</div>';
    return list.slice(0, 200).map(c => `
      <div onclick="_emailTplsConfirmLink('${tplId}','${c.id}')" style="padding:9px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:12px;color:#0f172a;" onmouseenter="this.style.background='#f1f5f9'" onmouseleave="this.style.background=''">
        <div style="font-weight:600;">${_ddEsc(c.address || '(no address)')}</div>
        ${c.agent?`<div style="font-size:10px;color:#64748b;margin-top:2px;">🤵 ${_ddEsc(c.agent)}</div>`:''}
      </div>`).join('');
  };

  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:560px;max-width:94vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
      <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
        <div style="font-size:13px;font-weight:700;color:#0f172a;">Link template to a property</div>
        <div style="font-size:11px;color:#64748b;margin-top:3px;">${_ddEsc((tpl.name || '').slice(0, 120))}${(tpl.name||'').length>120?'…':''}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:4px;">Once linked, this template is auto-set as the property's official template if none exists yet.</div>
      </div>
      <div style="padding:12px 20px;border-bottom:1px solid #e2e8f0;">
        <input id="emailTplsLinkSearch" type="text" autofocus
          oninput="_emailTplsLinkSearchInput(this.value)"
          placeholder="Search by address, city, or agent…${seedHint?'  (seeded from template name)':''}"
          value="${_ddEsc((tpl.subject || tpl.name || '').replace(/[%].*?[%]/g, '').replace(/\(FUB IMPORT[^)]*\)/g, '').slice(0, 80).trim())}"
          style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;outline:none;box-sizing:border-box;"/>
      </div>
      <div id="emailTplsLinkList" style="overflow-y:auto;flex:1;">${renderList(document.getElementById('emailTplsLinkSearch')?.value || '')}</div>
      <div style="padding:10px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;background:#f8fafc;">
        <button onclick="this.closest('#emailTplsLinkModal').remove()" style="background:#fff;color:#475569;border:1px solid #cbd5e1;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  // Re-render the list with whatever the seeded search is showing
  setTimeout(()=>{
    const inp = document.getElementById('emailTplsLinkSearch');
    if(inp){
      const list = document.getElementById('emailTplsLinkList');
      if(list) list.innerHTML = renderList(inp.value);
      inp.focus();
      try { inp.setSelectionRange(0, inp.value.length); } catch(_){}
    }
  }, 30);
  // Stash the helper closures so the inline handlers can reach them.
  modal._renderList = renderList;
  modal._candidates = candidates;
};

window._emailTplsLinkSearchInput = function(q){
  const modal = document.getElementById('emailTplsLinkModal');
  const list  = document.getElementById('emailTplsLinkList');
  if(!modal || !list || typeof modal._renderList !== 'function') return;
  list.innerHTML = modal._renderList(q);
};

// v141: bulk auto-link unlinked templates by extracting an address from the
// subject + body and matching against window.allDeals. Skips ambiguous matches
// (multiple candidate properties) and templates from no-link folders.
// On a unique match: sets property_id and auto-flips is_official=true if
// the property has no other official template yet.
window._emailTplsAutoLinkUnlinked = async function(){
  const btn = document.getElementById('emailTplsAutoLinkBtn');
  // v142: scan ALL unlinked templates — including ones in no-link folders —
  // so any that happen to mention a real street address still get caught
  // before being filed away as marketing. The classifier is the fallback,
  // not a hard exclusion.
  const candidates = (window._emailTplsLibState.rows || []).filter(r => !r.property_id);
  if(!candidates.length){ alert('No unlinked templates to auto-link.'); return; }
  if(!confirm(`Scan ${candidates.length} unlinked template${candidates.length===1?'':'s'} for an address and auto-link to the matching property?\n\n• Templates whose body or subject contains a uniquely-matching property address get linked.\n• Ambiguous matches (multiple candidates) are skipped — left unlinked for manual review.\n• Linked templates auto-set as official if the property has no official yet.`)) return;

  if(btn){ btn.disabled = true; btn.textContent = 'Scanning…'; }
  // v144: use the unified _normalizeAddr so spelling variants collapse
  // ("1st" / "first", "NJ-77" / "Highway 77" / "Route 77" all match).
  const norm = (typeof _normalizeAddr === 'function')
    ? _normalizeAddr
    : (s) => String(s||'').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const STREET_WORDS = '(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|hwy|highway|pkwy|parkway|ter|terrace|cir|circle|sq|square|trl|trail|expy|expressway|loop)';
  // Address regex: digits + 1-6 words + street suffix (case-insensitive).
  const ADDR_RE = new RegExp('\\b(\\d{1,6}(?:\\s+[A-Za-z0-9.\\-]+){1,6}\\s+' + STREET_WORDS + '\\b\\.?)', 'gi');

  // Index: for each deal, pre-compute the normalized "street + number" prefix
  // we'll match against. Skip deals without a usable address.
  const dealIndex = [];
  for(const d of (window.allDeals||[])){
    const a = String(d['Address'] || '').trim();
    if(!a) continue;
    const m = a.match(ADDR_RE);
    if(!m || !m.length) continue;
    dealIndex.push({ id: d.id, address: a, normFirst: norm(m[0]) });
  }

  let linked = 0, skippedAmbiguous = 0, skippedNoMatch = 0;
  const failures = [];

  for(let i = 0; i < candidates.length; i++){
    const tpl = candidates[i];
    if(btn) btn.textContent = `Scanning ${i+1}/${candidates.length}…`;
    // Try subject first, then body. For each candidate address the AI/regex
    // pulls out, look up which deals match.
    const haystack = (String(tpl.subject||'') + '\n' + String(tpl.body||''));
    const found = haystack.match(ADDR_RE) || [];
    if(!found.length){ skippedNoMatch++; continue; }
    // For each found address, find deals whose normalized first-line matches.
    const candDealIds = new Set();
    for(const raw of found){
      const n = norm(raw);
      // Prefix match — deal address must start with this normalized chunk
      // (or vice versa, in case the source has more context like a unit).
      for(const d of dealIndex){
        if(d.normFirst === n || d.normFirst.startsWith(n) || n.startsWith(d.normFirst)){
          candDealIds.add(d.id);
        }
      }
      if(candDealIds.size > 1) break; // already ambiguous, no need to keep checking
    }
    if(candDealIds.size === 0){ skippedNoMatch++; continue; }
    if(candDealIds.size > 1){ skippedAmbiguous++; continue; }
    const propId = [...candDealIds][0];
    try {
      const existing = await _sbGet('ace_user_email_templates',
        `user_email=eq.${encodeURIComponent(window._currentUser?.email||'')}&property_id=eq.${propId}&is_official=eq.true&select=id&limit=1`);
      const shouldBeOfficial = !(Array.isArray(existing) && existing.length > 0);
      const patch = { property_id: propId };
      if(shouldBeOfficial) patch.is_official = true;
      await _sbPatch('ace_user_email_templates', tpl.id, patch);
      const wasLinked = !!tpl.property_id;
      if(wasLinked && tpl.property_id !== propId) _ptmDec(tpl.property_id);
      _ptmInc(propId);
      tpl.property_id = propId;
      if(shouldBeOfficial) tpl.is_official = true;
      linked++;
    } catch(e){
      failures.push({ name: tpl.name, error: e.message });
    }
  }

  // Refresh the missing-prop cache so newly-linked properties render.
  if(typeof _emailTplsLoadMissingProps === 'function'){
    try { await _emailTplsLoadMissingProps(); } catch(_){}
  }
  _emailTplsLibPaint();

  const lines = [
    `✓ Linked ${linked}`,
    skippedAmbiguous ? `⚠ Skipped ${skippedAmbiguous} ambiguous (multiple candidate properties — left for manual review)` : '',
    skippedNoMatch ? `· Skipped ${skippedNoMatch} (no address found / no matching property)` : '',
    failures.length ? `✗ ${failures.length} failed` : '',
  ].filter(Boolean);
  alert('Auto-link complete:\n\n' + lines.join('\n') + (failures.length ? '\n\nFirst failure: ' + failures[0].error : ''));
};

// v147: unlink an email template from its property. Sets property_id=null
// and clears is_official (no longer the official template for that prop).
// User can then click "Link to property" to pick a new one, or leave it
// unlinked / mark "no link needed".
window._emailTplsUnlink = async function(tplId){
  const r = (window._emailTplsLibState.rows || []).find(x => x.id === tplId);
  if(!r) return;
  if(!confirm('Unlink this template from its property?\n\n' +
              'It will appear in the Unlinked folder until you link it again or mark it as "no link needed".'))
    return;
  try {
    const prevPropId = r.property_id;
    await _sbPatch('ace_user_email_templates', tplId, { property_id: null, is_official: false });
    if(prevPropId) _ptmDec(prevPropId);
    r.property_id = null;
    r.is_official = false;
    document.getElementById('emailTplsEditorModal')?.remove();
    if(typeof _emailTplsLibPaint === 'function') _emailTplsLibPaint();
    if(typeof _refreshPipelineBody === 'function') _refreshPipelineBody();
    if(typeof showSaveConfirm === 'function') showSaveConfirm('✓ Unlinked');
    // Re-open the editor so the user can immediately pick a new link.
    setTimeout(() => { if(typeof window._emailTplsOpenEditor === 'function') window._emailTplsOpenEditor(tplId); }, 50);
  } catch(e){
    alert('Unlink failed: ' + (e?.message || e));
  }
};

window._emailTplsConfirmLink = async function(tplId, propertyId){
  const modal = document.getElementById('emailTplsLinkModal');
  if(modal) modal.remove();
  try {
    // Check whether this property already has an official template.
    const existing = await _sbGet('ace_user_email_templates',
      `user_email=eq.${encodeURIComponent(window._currentUser?.email||'')}&property_id=eq.${propertyId}&is_official=eq.true&select=id&limit=1`);
    const shouldBeOfficial = !(Array.isArray(existing) && existing.length > 0);
    const patch = { property_id: propertyId };
    if(shouldBeOfficial) patch.is_official = true;
    await _sbPatch('ace_user_email_templates', tplId, patch);
    // Update in-memory state + repaint.
    const r = (window._emailTplsLibState.rows || []).find(x => x.id === tplId);
    const prevPropId = r?.property_id;
    if(r){
      r.property_id = propertyId;
      if(shouldBeOfficial) r.is_official = true;
    }
    if(prevPropId && prevPropId !== propertyId) _ptmDec(prevPropId);
    if(propertyId !== prevPropId) _ptmInc(propertyId);
    // Make sure the property is in our lookup cache.
    if(typeof _emailTplsLoadMissingProps === 'function') await _emailTplsLoadMissingProps();
    if(typeof _emailTplsLibPaint === 'function') _emailTplsLibPaint();
    if(typeof _refreshPipelineBody === 'function') _refreshPipelineBody();
    if(typeof showSaveConfirm === 'function') showSaveConfirm('✓ Linked' + (shouldBeOfficial ? ' + made official' : ''));
  } catch(e){
    alert('Link failed: ' + e.message);
  }
};

// v127: open a deal by id, pulling from window.allDeals or extraProps cache so we
// don't break in personal pipeline mode (where the property may not be in
// window.allDeals).
window._emailTplsOpenDealById = function(propertyId){
  const d = (window.allDeals||[]).find(x => x.id === propertyId);
  if(d){ if(typeof openDeal === 'function') openDeal(d); return; }
  // Fallback: trigger a load + open.
  alert('This deal is outside your current view scope (personal pipeline filter). Switch to the full company pipeline to open it.');
};

// Pull the FUB source-folder embedded in template name:
//   "(FUB IMPORT — Hot Deal Email Temp) Subject…"  ->  "Hot Deal Email Temp"
//   "(FUB IMPORT) Subject…"                          ->  "FUB Import (no folder)"
//   "Custom user template name"                      ->  null (= user-created)
export function _emailTplsExtractFolder(name){
  const m = String(name||'').match(/^\(FUB IMPORT(?:\s+—\s+([^)]+))?\)/);
  if(!m) return null;
  return m[1] ? m[1].trim() : 'FUB Import (no folder)';
}

// v141: folders whose templates are admin / marketing / generic outreach and
// don't need a property link. Templates in these folders are excluded from
// the "Unlinked" bucket so it stops cluttering with stuff that has no
// physical property to point to. They still appear in their own folder and
// in "All Email Templates" — they just stop nagging for a link.
const _EMAIL_TPL_NO_LINK_FOLDERS = new Set([
  'Follow Up Boss',
  'Sale Inquiry',
  'On Boarding',
  '2025 Cold Reach Out',
  // v142: FUB templates that came in without a folder label fall into the
  // "FUB Import (no folder)" bucket — these are all marketing / generic
  // outreach (Text Vm, About Us, Are you there?, Check in, Decision math
  // in 10, Curious What Your Property Is Worth Today?, Triple Net Retail
  // Portfolio, Another 1031 buyer, Attention Required - Investment
  // Property Inquiry, etc.). None of them describe a specific property —
  // they're recipient-targeted, not property-targeted. Marked no-link.
  'FUB Import (no folder)',
]);

export function _emailTplIsNoLinkNeeded(row){
  if(!row) return false;
  // v143: per-template manual flag wins. Even a template from a folder
  // that normally needs a link (e.g. Active Deal Email Temp) can be
  // user-marked as "no link needed" — useful when the user looks at a
  // specific template and decides it's actually generic.
  if(row.no_link_needed === true) return true;
  const f = _emailTplsExtractFolder(row.name);
  return !!(f && _EMAIL_TPL_NO_LINK_FOLDERS.has(f));
}

// v143: toggle a template's no_link_needed flag. Updates DB, in-memory
// state, and repaints the library. Called from the edit modal AND from
// clicking the "🔗 Unlinked" badge on a row to flip it to "📎 No link
// needed". Reverse direction (un-mark) is also supported — click the
// 📎 No link needed badge to flip it back to 🔗 Unlinked.
window._emailTplsToggleNoLink = async function(tplId, value){
  const r = (window._emailTplsLibState.rows || []).find(x => x.id === tplId);
  if(!r){ alert('Template not found.'); return; }
  const next = (typeof value === 'boolean') ? value : !r.no_link_needed;
  try {
    await _sbPatch('ace_user_email_templates', tplId, { no_link_needed: next });
    r.no_link_needed = next;
    if(typeof _emailTplsLibPaint === 'function') _emailTplsLibPaint();
    if(typeof showSaveConfirm === 'function'){
      showSaveConfirm(next ? '📎 Marked as no link needed' : '🔗 Marked as needing a property link');
    }
  } catch(e){
    alert('Update failed: ' + e.message);
  }
};

export function _emailTplsLibPaint(){
  const root = document.getElementById('emailTplsTabRoot');
  if(!root) return;
  // v126: capture focus + caret on the search input BEFORE we rebuild
  // root.innerHTML — otherwise every keystroke destroys the element and
  // the user has to click back in. Restore after the repaint.
  const active = document.activeElement;
  const wasSearch = active && active.id === 'emailTplsSearchInput';
  const caret = wasSearch ? active.selectionStart : null;
  if(window._emailTplsLibState.activeFolder == null){
    _emailTplsLibPaintFolders();
  } else {
    _emailTplsLibPaintTemplates(window._emailTplsLibState.activeFolder);
  }
  if(wasSearch){
    const newInput = document.getElementById('emailTplsSearchInput');
    if(newInput){
      newInput.focus();
      try { newInput.setSelectionRange(caret, caret); } catch(_){}
    }
  }
}

export function _emailTplsLibPaintFolders(){
  const root = document.getElementById('emailTplsTabRoot');
  const rows = window._emailTplsLibState.rows || [];

  // FUB-folder bucket counts
  const folderCounts = new Map();
  let userCreatedCount = 0;
  for(const r of rows){
    const f = _emailTplsExtractFolder(r.name);
    if(f){
      folderCounts.set(f, (folderCounts.get(f) || 0) + 1);
    } else {
      userCreatedCount++;
    }
  }

  const total    = rows.length;
  const linked   = rows.filter(r => !!r.property_id).length;
  // v141: Unlinked count excludes templates in admin/marketing folders that
  // don't need a property link (Follow Up Boss, Sale Inquiry, etc.) so the
  // bucket only counts templates that genuinely need attention.
  const unlinked = rows.filter(r => !r.property_id && !_emailTplIsNoLinkNeeded(r)).length;
  const noLinkNeeded = rows.filter(r => !r.property_id && _emailTplIsNoLinkNeeded(r)).length;
  const fubTotal = rows.filter(r => /^\(FUB IMPORT/.test(r.name||'')).length;

  // Sort FUB folders by count desc, then name asc.
  const fubFolders = [...folderCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const safeQ = _ddEsc(window._emailTplsLibState.search || '');
  const q = (window._emailTplsLibState.search || '').trim().toLowerCase();
  const visibleFolders = q
    ? fubFolders.filter(([name]) => name.toLowerCase().includes(q))
    : fubFolders;

  const specialRow = (icon, name, count, target) => `
    <tr style="border-top:1px solid #e2e8f0;cursor:pointer;"
      onclick="_emailTplsOpenFolder('${target.replace(/'/g, "\\'")}')"
      onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''">
      <td style="padding:11px 14px;font-size:13px;color:#0f172a;">${icon} ${_ddEsc(name)}</td>
      <td style="padding:11px 14px;font-size:12px;color:#475569;text-align:right;">${count.toLocaleString()}</td>
      <td style="padding:11px 14px;text-align:right;width:60px;color:#94a3b8;font-size:12px;">›</td>
    </tr>`;

  const fubRow = (name, count) => `
    <tr style="border-top:1px solid #e2e8f0;cursor:pointer;"
      onclick="_emailTplsOpenFolder('fub:${name.replace(/'/g, "\\'")}')"
      onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''">
      <td style="padding:11px 14px;font-size:13px;color:#0f172a;">📁 ${_ddEsc(name)}</td>
      <td style="padding:11px 14px;font-size:12px;color:#475569;text-align:right;">${count.toLocaleString()}</td>
      <td style="padding:11px 14px;text-align:right;color:#94a3b8;font-size:12px;">›</td>
    </tr>`;

  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:13px;color:#64748b;">
        ${total.toLocaleString()} email template${total===1?'':'s'} across ${(fubFolders.length + (userCreatedCount?1:0)).toLocaleString()} folder${(fubFolders.length+(userCreatedCount?1:0))===1?'':'s'}.
      </div>
      <input type="text" id="emailTplsSearchInput" value="${safeQ}"
        oninput="window._emailTplsLibState.search=this.value; _emailTplsLibPaint();"
        placeholder="Search folders…"
        style="width:220px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;outline:none;" />
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f8fafc;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">
            <th style="padding:8px 14px;text-align:left;font-weight:600;">Name</th>
            <th style="padding:8px 14px;text-align:right;font-weight:600;width:140px;">Email Templates</th>
            <th style="padding:8px 14px;text-align:right;font-weight:600;width:60px;"></th>
          </tr>
        </thead>
        <tbody>
          ${specialRow('📂', 'All Email Templates', total,    'all')}
          ${specialRow('🏢', 'Linked to a Property', linked,  'linked')}
          ${specialRow('🔗', 'Unlinked',             unlinked,'unlinked')}
          ${noLinkNeeded ? specialRow('📎', 'No Link Needed (admin/marketing)', noLinkNeeded, 'nolink') : ''}
          ${userCreatedCount ? specialRow('✏️', 'User-Created (non-FUB)', userCreatedCount, 'usercreated') : ''}
          ${visibleFolders.map(([name, count]) => fubRow(name, count)).join('')}
          ${visibleFolders.length === 0 && q ? `<tr><td colspan="3" style="padding:18px;text-align:center;font-size:12px;color:#64748b;">No folders match "${safeQ}"</td></tr>` : ''}
        </tbody>
      </table>
    </div>`;
}

export function _emailTplsLibPaintTemplates(folder){
  const root = document.getElementById('emailTplsTabRoot');
  const allRows = window._emailTplsLibState.rows || [];

  // Resolve which rows belong to the active folder.
  let rows;
  let folderLabel;
  if(folder === 'all')              { rows = allRows.slice();                   folderLabel = 'All Email Templates'; }
  else if(folder === 'linked')      { rows = allRows.filter(r => !!r.property_id); folderLabel = '🏢 Linked to a Property'; }
  // v141: Unlinked excludes no-link-needed admin/marketing templates.
  else if(folder === 'unlinked')    { rows = allRows.filter(r => !r.property_id && !_emailTplIsNoLinkNeeded(r)); folderLabel = '🔗 Unlinked'; }
  else if(folder === 'nolink')      { rows = allRows.filter(r => !r.property_id && _emailTplIsNoLinkNeeded(r)); folderLabel = '📎 No Link Needed (admin/marketing)'; }
  else if(folder === 'usercreated') { rows = allRows.filter(r => !_emailTplsExtractFolder(r.name)); folderLabel = '✏️ User-Created (non-FUB)'; }
  else if(folder.startsWith('fub:')){
    const f = folder.slice(4);
    rows = allRows.filter(r => _emailTplsExtractFolder(r.name) === f);
    folderLabel = `📁 ${f}`;
  } else { rows = []; folderLabel = folder; }

  const propById = new Map();
  for(const d of (window.allDeals||[])) if(d?.id) propById.set(d.id, d);
  // v127: lazy-fetched properties for templates whose property_id is real but
  // outside the user's window.allDeals view (e.g. personal pipeline filter excludes
  // deals assigned to other agents). Without this, DB-linked templates render
  // as "Unlinked" / "no deal" even though property_id is set.
  if(typeof window._emailTplsExtraProps !== 'undefined' && window._emailTplsExtraProps){
    for(const [id, d] of window._emailTplsExtraProps.entries()) propById.set(id, d);
  }
  const contactById = new Map();
  for(const c of (allContacts||[])) if(c?.id) contactById.set(c.id, c);

  // Search within the folder.
  const q = (window._emailTplsLibState.search || '').trim().toLowerCase();
  const filtered = q
    ? rows.filter(r => {
        const haystack = [r.name, r.subject, r.body, propById.get(r.property_id)?.['Address']]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : rows;

  const safeQ = _ddEsc(window._emailTplsLibState.search || '');

  const rowsHtml = filtered.map(r => {
    const prop = r.property_id ? propById.get(r.property_id) : null;
    const ownerId = prop?.['Owner']?.[0];
    const owner = ownerId ? contactById.get(ownerId) : null;
    const subjectPreview = (r.subject || '').slice(0, 90);
    const bodyPreview    = (r.body || '').replace(/\s+/g, ' ').slice(0, 120);

    // v113.50: full chip set — Property, Owner, Agent, FUB, Unlinked, Official.
    let tags = '';
    const isNoLinkNeeded = _emailTplIsNoLinkNeeded(r);
    if(prop){
      tags += `<span onclick="event.stopPropagation(); openDeal(window.allDeals.find(d=>d.id==='${prop.id}'))"
        title="${_ddEsc(prop['Address']||'')}"
        style="display:inline-block;background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;margin-right:4px;margin-bottom:3px;">
        🏢 ${_ddEsc((prop['Address']||'').slice(0, 40))}${(prop['Address']||'').length > 40 ? '…' : ''}
      </span>`;
    } else if(isNoLinkNeeded){
      // v141: admin / marketing folders don't need a link — show a calmer
      // badge that doesn't read like an action item.
      // v143: badge is clickable when the no-link state was set manually
      //   (no_link_needed = true on the row) so the user can flip it back
      //   if they marked something by mistake. Folder-classified templates
      //   stay non-clickable — to "un-classify" those, edit the folder set.
      const userMarked = r.no_link_needed === true;
      if(userMarked){
        tags += `<span onclick="event.stopPropagation(); _emailTplsToggleNoLink('${r.id}', false)"
          title="Click to mark as needing a property link"
          style="display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-right:4px;margin-bottom:3px;cursor:pointer;">
          📎 No link needed
        </span>`;
      } else {
        tags += `<span style="display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-right:4px;margin-bottom:3px;">
          📎 No link needed
        </span>`;
      }
    } else {
      // v143: clicking the Unlinked badge flips the template to "no link
      // needed" so the user can clear individual templates from the
      // Unlinked folder without opening the editor. Right-side button
      // path (Link to property…) still works for actually linking.
      tags += `<span onclick="event.stopPropagation(); _emailTplsToggleNoLink('${r.id}', true)"
        title="Click to mark this template as no-link-needed (removes it from Unlinked)"
        style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-right:4px;margin-bottom:3px;cursor:pointer;">
        🔗 Unlinked
      </span>`;
    }
    if(owner){
      tags += `<span onclick="event.stopPropagation(); openContactModal('${owner.id}')"
        title="${_ddEsc(owner['Name']||'')}"
        style="display:inline-block;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;cursor:pointer;margin-right:4px;margin-bottom:3px;">
        👤 ${_ddEsc(owner['Name']||'(no name)')}
      </span>`;
    }
    // Agent pill — pulls 'Assigned Agent' from the property. May be a
    // pipe-delimited list ("Daniel Keenan|Aidan Alverson"); show each as
    // its own chip.
    if(prop && prop['Assigned Agent']){
      const agents = (typeof _agentList === 'function' ? _agentList(prop['Assigned Agent']) : String(prop['Assigned Agent']).split('|').map(s => s.trim()).filter(Boolean));
      for(const a of agents){
        const display = (typeof _agentDisplayName === 'function') ? _agentDisplayName(a) : a;
        tags += `<span style="display:inline-block;background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-right:4px;margin-bottom:3px;" title="${_ddEsc(a)}">
          🤵 ${_ddEsc(display)}
        </span>`;
      }
    }
    if(/^\(FUB IMPORT/.test(r.name||'')){
      tags += `<span style="display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-right:4px;margin-bottom:3px;">
        📥 FUB Import
      </span>`;
    }
    if(r.is_official){
      tags += `<span style="display:inline-block;background:#fef9c3;color:#854d0e;border:1px solid #fde68a;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:600;margin-right:4px;margin-bottom:3px;">
        ★ Official
      </span>`;
    }

    return `
      <tr style="border-top:1px solid #e2e8f0;cursor:pointer;"
        onclick="_emailTplsOpenEditor('${r.id}')"
        onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''">
        <td style="padding:9px 10px;vertical-align:top;font-size:12px;color:#0f172a;max-width:340px;">
          <div style="font-weight:600;line-height:1.3;color:#1d4ed8;">${_ddEsc(r.name || '(unnamed)')}</div>
          <div style="margin-top:4px;">${tags}</div>
        </td>
        <td style="padding:9px 10px;vertical-align:top;font-size:11px;color:#475569;max-width:280px;">
          <div style="font-weight:600;color:#334155;">${_ddEsc(subjectPreview)}${(r.subject||'').length>90?'…':''}</div>
          <div style="margin-top:3px;color:#64748b;font-size:10px;line-height:1.4;">${_ddEsc(bodyPreview)}${(r.body||'').length>120?'…':''}</div>
        </td>
        <td style="padding:9px 10px;vertical-align:top;text-align:right;white-space:nowrap;">
          ${prop
            ? `<button onclick="event.stopPropagation(); _emailTplsOpenDealById('${prop.id}')" style="background:#1a3a6e;color:#fff;border:none;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;">Open Deal →</button>`
            : (isNoLinkNeeded
              ? `<span style="font-size:10px;color:#94a3b8;font-style:italic;">—</span>`
              : `<button onclick="event.stopPropagation(); _emailTplsLinkPicker('${r.id}')" style="background:#fff;color:#1d4ed8;border:1px solid #93c5fd;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;">🔗 Link to property…</button>`)}
        </td>
      </tr>`;
  }).join('');

  // v141: show the auto-link bulk action only on the Unlinked folder.
  const showAutoLink = (folder === 'unlinked' && rows.length > 0);
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:13px;color:#0f172a;">
        <a href="javascript:void(0)" onclick="_emailTplsOpenFolder(null)"
          style="color:#2563eb;text-decoration:none;font-weight:500;">← Folders</a>
        <span style="color:#94a3b8;margin:0 8px;">/</span>
        <span style="font-weight:600;">${_ddEsc(folderLabel)}</span>
        <span style="color:#64748b;font-weight:400;font-size:12px;margin-left:8px;">${rows.length.toLocaleString()} template${rows.length===1?'':'s'}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        ${showAutoLink ? `<button id="emailTplsAutoLinkBtn" onclick="_emailTplsAutoLinkUnlinked()" style="background:#1a3a6e;color:#fff;border:none;border-radius:6px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;" title="Scan body + subject for an address and auto-link to the matching property. Skips ambiguous matches.">✦ Auto-link from text</button>` : ''}
        <input type="text" id="emailTplsSearchInput" value="${safeQ}"
          oninput="window._emailTplsLibState.search=this.value; _emailTplsLibPaint();"
          placeholder="Search this folder…"
          style="width:260px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;outline:none;" />
      </div>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      ${filtered.length === 0
        ? `<div style="padding:30px;text-align:center;font-size:12px;color:#64748b;">No templates match.</div>`
        : `<table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8fafc;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">
                <th style="padding:7px 10px;text-align:left;font-weight:600;">Name + Tags</th>
                <th style="padding:7px 10px;text-align:left;font-weight:600;">Subject / Preview</th>
                <th style="padding:7px 10px;text-align:right;font-weight:600;width:120px;"></th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>`}
    </div>
    <div style="margin-top:10px;font-size:11px;color:#64748b;">
      Showing ${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} in this folder
      ${q ? `· search: "${_ddEsc(q)}"` : ''}
    </div>`;
}
