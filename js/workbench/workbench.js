// workbench/workbench.js — per-agent private triage queue.
//
// Phase 4a: parallel ES module. The legacy block in index.html
// (lines ~17145–18206) still owns runtime; this module is dead code
// during Phase 4a (smoke test only). Phase 4b deletes the legacy block
// and attaches these exports as window.* so inline onclick handlers
// in the rendered HTML resolve to them.
//
// Storage: ace_workbench_items table, one row per (user_id, deal_id) or
// (user_id, contact_id). Server-side RPCs (workbench_add, workbench_remove,
// workbench_move) handle position math atomically.
//
// External dependencies still on window.* (the legacy script owns these):
//   - window._currentUser, window.allDeals, window.allBuyerCriteria,
//     window.allBuyerContacts
//   - window.openDeal, window.setNav, window.openContactModal,
//     window._contactTabSwitch, window.bcOpenExpanded, window.openDealSnapshot
//   - window._omGetOrderedPhotos, window.isSupabase

import { _sbGet, _sbPatch, _sbRpc } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';
import { SB_PROP_MAP } from '../schemas/deals.js';
import { SB_BC_MAP } from '../schemas/buyer-criteria.js';
import { _sbToAt } from '../schemas/field-map.js';

// ═══════════════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════════════

let _workbenchItems = []; // [{id, deal_id, position, notes, deal: <ref into allDeals>}]
let _workbenchSelectedDealId = null;
let _workbenchNotesSaveTimer = null;

// v102.39: contact-side state (independent positions, separate selection)
let _workbenchContacts = []; // [{id, contact_id, position, notes, contact: <hydrated row>}]
let _workbenchSelectedContactId = null;
let _workbenchActiveTab = 'properties'; // 'properties' | 'contacts' | 'meeting'

// Session cache of contact_ids currently on this user's Workbench, with their
// positions. Lets us render the "+ Add to Workbench" button in its
// already-added state without making a DB call every time we paint a
// contact card or a buyer criteria card.
const _wbContactPositions = new Map(); // contact_id -> position number

// _sbToAt now imported from js/schemas/field-map.js (Phase 4.5).

// ═══════════════════════════════════════════════════════════════════════
// CACHE WARM-UP (called by app boot, before any contact-add button paints)
// ═══════════════════════════════════════════════════════════════════════
// v102.39: keep the Workbench contact-id cache primed so "+ Add to Workbench"
// buttons render in their already-added state without a DB roundtrip.
// Called during initial syncData(); silent failure is OK — UI just falls
// back to all buttons rendering as "+ Add to Workbench".
export async function _wbWarmContactCache(){
  const cu = window._currentUser;
  if(!cu || !cu.id) return;
  const wbRows = await _sbGet(SB_TABLES.workbench,
    'select=contact_id,position'
    + '&user_id=eq.' + encodeURIComponent(cu.id)
    + '&item_type=eq.contact&limit=500');
  if(Array.isArray(wbRows)){
    _wbContactPositions.clear();
    wbRows.forEach(r => { if(r.contact_id) _wbContactPositions.set(r.contact_id, r.position); });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CONTACT ADD-BUTTON SYNC
// ═══════════════════════════════════════════════════════════════════════
// Apply the cached state to every contact-add button currently on screen.
// Buttons are marked with class "wb-add-contact-btn" and data-contact-id.
export function _wbSyncContactAddButtons(contactId, position){
  const sel = contactId
    ? '.wb-add-contact-btn[data-contact-id="' + contactId + '"]'
    : '.wb-add-contact-btn';
  document.querySelectorAll(sel).forEach(btn => {
    const cid = btn.dataset.contactId;
    if(!cid) return;
    const pos = (typeof position === 'number')
      ? position
      : _wbContactPositions.get(cid);
    if(pos){
      btn.disabled = false;
      btn.textContent = '✓ On Workbench (#' + pos + ')';
      btn.style.background = '#16a34a';
    }else{
      btn.disabled = false;
      btn.textContent = '+ Add to Workbench';
      btn.style.background = '#1e3a8a';
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ADD / LOAD — PROPERTIES
// ═══════════════════════════════════════════════════════════════════════

export async function addToWorkbench(dealId, btnEl){
  const cu = window._currentUser;
  if(!cu || !cu.id){
    showSaveConfirm('Sign in to use Workbench');
    return;
  }
  if(!dealId){ console.warn('addToWorkbench: no dealId'); return; }
  const origText = btnEl ? btnEl.textContent : '';
  if(btnEl){ btnEl.disabled = true; btnEl.textContent = 'Adding…'; }
  try{
    const result = await _sbRpc('workbench_add', {
      p_user_id: cu.id, p_deal_id: dealId, p_notes: ''
    });
    if(result && result.error){
      showSaveConfirm('Workbench: ' + result.error);
      if(btnEl){ btnEl.disabled = false; btnEl.textContent = origText; }
      return;
    }
    if(result.already_present){
      showSaveConfirm('Already on Workbench (position ' + result.position + ')');
    }else{
      showSaveConfirm('Added to Workbench (position ' + result.position + ')');
    }
    if(btnEl){
      btnEl.disabled = false;
      btnEl.textContent = '✓ On Workbench (#' + result.position + ')';
      btnEl.style.background = '#16a34a';
    }
  }catch(e){
    console.error('addToWorkbench failed:', e);
    showSaveConfirm('Workbench: ' + (e.message || 'add failed'));
    if(btnEl){ btnEl.disabled = false; btnEl.textContent = origText; }
  }
}

export async function _wbLoadItems(){
  const cu = window._currentUser;
  if(!cu || !cu.id){
    _workbenchItems = [];
    return;
  }
  const rows = await _sbGet(SB_TABLES.workbench,
    'select=id,deal_id,position,notes,created_at,updated_at'
    + '&user_id=eq.' + encodeURIComponent(cu.id)
    + '&item_type=eq.property'
    + '&order=position.asc&limit=500');
  const list = Array.isArray(rows) ? rows : [];
  const dealMap = {};
  const allDeals = window.allDeals || [];
  allDeals.forEach(d => { if(d && d.id) dealMap[d.id] = d; });
  const missingIds = list.map(r => r.deal_id).filter(id => !dealMap[id]);
  if(missingIds.length){
    try{
      const filter = 'in.(' + missingIds.map(encodeURIComponent).join(',') + ')';
      const fetched = await _sbGet(SB_TABLES.properties,
        'select=*&id=' + filter);
      (Array.isArray(fetched) ? fetched : []).forEach(row => {
        const deal = _sbToAt(row, SB_PROP_MAP);
        deal.id = row.id;
        dealMap[row.id] = deal;
      });
    }catch(e){ console.warn('Workbench: missing-deal fetch failed:', e.message); }
  }
  _workbenchItems = list.map(r => ({
    id: r.id, deal_id: r.deal_id, position: r.position, notes: r.notes || '',
    deal: dealMap[r.deal_id] || null
  }));
}

// ═══════════════════════════════════════════════════════════════════════
// ADD / LOAD — CONTACTS
// ═══════════════════════════════════════════════════════════════════════

export async function addContactToWorkbench(contactId, btnEl){
  const cu = window._currentUser;
  if(!cu || !cu.id){
    showSaveConfirm('Sign in to use Workbench');
    return;
  }
  if(!contactId){ console.warn('addContactToWorkbench: no contactId'); return; }
  const origText = btnEl ? btnEl.textContent : '';
  if(btnEl){ btnEl.disabled = true; btnEl.textContent = 'Adding…'; }
  try{
    const result = await _sbRpc('workbench_add_contact', {
      p_user_id: cu.id, p_contact_id: contactId, p_notes: ''
    });
    if(result && result.error){
      showSaveConfirm('Workbench: ' + result.error);
      if(btnEl){ btnEl.disabled = false; btnEl.textContent = origText; }
      return;
    }
    if(result.already_present){
      showSaveConfirm('Already on Workbench (position ' + result.position + ')');
    }else{
      showSaveConfirm('Added to Workbench (position ' + result.position + ')');
    }
    _wbContactPositions.set(contactId, result.position);
    _wbSyncContactAddButtons(contactId, result.position);
  }catch(e){
    console.error('addContactToWorkbench failed:', e);
    showSaveConfirm('Workbench: ' + (e.message || 'add failed'));
    if(btnEl){ btnEl.disabled = false; btnEl.textContent = origText; }
  }
}

export async function _wbLoadContacts(){
  const cu = window._currentUser;
  if(!cu || !cu.id){
    _workbenchContacts = [];
    return;
  }
  const rows = await _sbGet(SB_TABLES.workbench,
    'select=id,contact_id,position,notes,created_at,updated_at'
    + '&user_id=eq.' + encodeURIComponent(cu.id)
    + '&item_type=eq.contact'
    + '&order=position.asc&limit=500');
  const list = Array.isArray(rows) ? rows : [];
  const contactMap = {};
  if(list.length){
    try{
      const filter = 'in.(' + list.map(r => encodeURIComponent(r.contact_id)).join(',') + ')';
      const fetched = await _sbGet(SB_TABLES.contacts,
        'select=id,name,phone_number,email,company,type,date_added&id=' + filter);
      (Array.isArray(fetched) ? fetched : []).forEach(c => { contactMap[c.id] = c; });
    }catch(e){
      console.error('Workbench: contact fetch failed —', e.message);
      showSaveConfirm('Workbench: contact load failed (' + (e.message||'unknown') + ')');
    }
  }
  // For the buyer-criteria count badge, batch a count per contact_id.
  const bcCounts = {};
  if(list.length){
    try{
      const filter = 'in.(' + list.map(r => encodeURIComponent(r.contact_id)).join(',') + ')';
      const bcRows = await _sbGet(SB_TABLES.buyerCriteria,
        'select=id,contact_id&contact_id=' + filter + '&limit=2000');
      (Array.isArray(bcRows) ? bcRows : []).forEach(r => {
        bcCounts[r.contact_id] = (bcCounts[r.contact_id] || 0) + 1;
      });
    }catch(e){ console.warn('Workbench: buyer criteria count fetch failed:', e.message); }
  }
  _workbenchContacts = list.map(r => ({
    id: r.id, contact_id: r.contact_id, position: r.position, notes: r.notes || '',
    contact: contactMap[r.contact_id] || null,
    bcCount: bcCounts[r.contact_id] || 0
  }));
  _wbContactPositions.clear();
  _workbenchContacts.forEach(it => _wbContactPositions.set(it.contact_id, it.position));
  _wbSyncContactAddButtons();
}

// ═══════════════════════════════════════════════════════════════════════
// FORMATTING HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function _wbMainPhotoUrl(deal){
  if(!deal) return null;
  try{
    const photos = (typeof window._omGetOrderedPhotos === 'function')
      ? window._omGetOrderedPhotos(deal) : [];
    if(photos.length && photos[0].url) return photos[0].url;
  }catch(e){}
  return null;
}

export function _wbRelDate(iso){
  if(!iso) return '—';
  const then = new Date(iso);
  if(isNaN(then.getTime())) return '—';
  const now = new Date();
  const diffMs = now - then;
  const diffDay = Math.floor(diffMs / 86400000);
  if(diffDay < 0) return then.toLocaleDateString('en-US', {month:'short', day:'numeric'});
  if(diffDay === 0) return 'today';
  if(diffDay === 1) return 'yesterday';
  if(diffDay < 7) return diffDay + 'd ago';
  if(diffDay < 30) return Math.floor(diffDay/7) + 'w ago';
  return then.toLocaleDateString('en-US', {month:'short', day:'numeric'});
}

export function _wbFmtPrice(n){
  const v = Number(n);
  if(!v || isNaN(v)) return '—';
  if(v >= 1000000) return '$' + (v/1000000).toFixed(2) + 'M';
  if(v >= 1000)    return '$' + Math.round(v/1000) + 'K';
  return '$' + v;
}

export function _wbLastActivity(deal){
  if(!deal) return null;
  return deal['Last Modified'] || deal['Updated At'] || deal['updated_at']
      || deal['Last Activity'] || deal['Date Added'] || null;
}

export function _wbContactInitials(name){
  const n = (name || '').trim();
  if(!n) return '?';
  const parts = n.split(/\s+/);
  if(parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}

// ═══════════════════════════════════════════════════════════════════════
// PAGE ENTRY + SHELL
// ═══════════════════════════════════════════════════════════════════════

export async function showWorkbenchPage(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  const cu = window._currentUser;
  if(!cu || !cu.id){
    main.innerHTML = '<div style="padding:60px;text-align:center;color:#64748b;font-size:14px;">Sign in to use Workbench.</div>';
    return;
  }
  main.innerHTML = '<div style="padding:60px;text-align:center;color:#94a3b8;font-size:13px;">Loading your Workbench…</div>';
  try{
    await Promise.all([_wbLoadItems(), _wbLoadContacts(), _wbEnsureMeetingData()]);
  }catch(e){
    console.error('Workbench load failed:', e);
    main.innerHTML = '<div style="padding:60px;text-align:center;color:#dc2626;font-size:13px;">Workbench load failed: ' + (e.message||'unknown') + '</div>';
    return;
  }
  if(!_workbenchSelectedDealId || !_workbenchItems.find(it => it.deal_id === _workbenchSelectedDealId)){
    _workbenchSelectedDealId = _workbenchItems.length ? _workbenchItems[0].deal_id : null;
  }
  if(!_workbenchSelectedContactId || !_workbenchContacts.find(it => it.contact_id === _workbenchSelectedContactId)){
    _workbenchSelectedContactId = _workbenchContacts.length ? _workbenchContacts[0].contact_id : null;
  }
  _wbRenderShell();
}

export function _wbRenderShell(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  const tabBase = 'background:transparent;border:none;border-bottom:3px solid transparent;padding:12px 18px;font-size:13px;font-weight:600;color:#64748b;cursor:pointer;margin-bottom:-1px;';
  const tabActive = 'background:transparent;border:none;border-bottom:3px solid #1e3a8a;padding:12px 18px;font-size:13px;font-weight:700;color:#1e3a8a;cursor:pointer;margin-bottom:-1px;';
  const propCount = _workbenchItems.length;
  const contactCount = _workbenchContacts.length;
  const meetingCounts = _wbCountMeetingItems();
  const meetingCount = meetingCounts.leads + meetingCounts.buyers;
  const onProps = (_workbenchActiveTab === 'properties');
  const onContacts = (_workbenchActiveTab === 'contacts');
  const onMeeting = (_workbenchActiveTab === 'meeting');
  const totalCount = onProps ? propCount : onContacts ? contactCount : meetingCount;
  const noun = onProps ? ('deal' + (propCount===1?'':'s'))
              : onContacts ? ('contact' + (contactCount===1?'':'s'))
              : ('new today');
  const bodyHTML = onMeeting
    ? `<div style="flex:1;min-height:0;overflow-y:auto;background:#f8fafc;">
         <div id="wbMeetingBody" style="max-width:1200px;margin:0 auto;padding:18px 24px;"></div>
       </div>`
    : `<div style="flex:1;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:0;min-height:0;">
         <div id="wbList" style="overflow-y:auto;border-right:1px solid #e2e8f0;padding:12px;background:#f8fafc;"></div>
         <div id="wbDetail" style="overflow-y:auto;background:#fff;padding:22px 24px;"></div>
       </div>`;
  main.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;background:#f8fafc;font-family:'Inter',system-ui,sans-serif;">
      <div style="padding:18px 24px 0;background:#fff;border-bottom:1px solid #e2e8f0;">
        <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:10px;">
          <div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;">My Workbench</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">${onMeeting ? "Today's new seller leads and buyer criteria — for your meeting." : 'Your private triage queue. Drag rows or type a position number to reorder.'}</div>
          </div>
          <div style="flex:1;"></div>
          <div id="wbCount" style="font-size:12px;color:#64748b;padding-top:4px;">${totalCount} ${noun}</div>
        </div>
        <div style="display:flex;gap:2px;border-bottom:1px solid transparent;">
          <button onclick="_wbSwitchTab('properties')" style="${onProps ? tabActive : tabBase}">
            Properties <span style="background:${onProps?'#dbeafe':'#f1f5f9'};color:${onProps?'#1e40af':'#64748b'};font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;font-weight:600;">${propCount}</span>
          </button>
          <button onclick="_wbSwitchTab('contacts')" style="${onContacts ? tabActive : tabBase}">
            Buyers <span style="background:${onContacts?'#dbeafe':'#f1f5f9'};color:${onContacts?'#1e40af':'#64748b'};font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;font-weight:600;">${contactCount}</span>
          </button>
          <button onclick="_wbSwitchTab('meeting')" style="${onMeeting ? tabActive : tabBase}">
            📅 Meeting <span style="background:${onMeeting?'#dbeafe':'#f1f5f9'};color:${onMeeting?'#1e40af':'#64748b'};font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;font-weight:600;">${meetingCount}</span>
          </button>
        </div>
      </div>
      ${bodyHTML}
    </div>`;
  if(onMeeting){
    _wbRenderMeeting();
  } else {
    _wbRenderList();
    _wbRenderDetail();
  }
}

export function _wbSwitchTab(which){
  if(which !== 'properties' && which !== 'contacts' && which !== 'meeting') return;
  if(_workbenchActiveTab === which) return;
  if(_workbenchNotesSaveTimer){ clearTimeout(_workbenchNotesSaveTimer); _workbenchNotesSaveTimer = null; _wbSaveNotes(true); }
  _workbenchActiveTab = which;
  _wbRenderShell();
}

// ═══════════════════════════════════════════════════════════════════════
// MEETING TAB
// ═══════════════════════════════════════════════════════════════════════
// v173: list new seller leads + new buyer criteria from today.

export function _wbTodayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

export function _wbCountMeetingItems(){
  const today = _wbTodayStr();
  const allDeals = window.allDeals;
  const allBC = window.allBuyerCriteria;
  const leads = (Array.isArray(allDeals))
    ? allDeals.filter(d => String(d['Date Added']||'').slice(0,10) === today).length : 0;
  const buyers = (Array.isArray(allBC))
    ? allBC.filter(r => String((r.fields&&r.fields['Date Added Buyer'])||'').slice(0,10) === today).length : 0;
  return {leads, buyers};
}

export function _wbGetTodaysLeads(){
  const today = _wbTodayStr();
  const allDeals = window.allDeals;
  if(!Array.isArray(allDeals)) return [];
  return allDeals.filter(d => String(d['Date Added']||'').slice(0,10) === today);
}

export function _wbGetTodaysBuyers(){
  const today = _wbTodayStr();
  const allBC = window.allBuyerCriteria;
  if(!Array.isArray(allBC)) return [];
  return allBC.filter(r => String((r.fields&&r.fields['Date Added Buyer'])||'').slice(0,10) === today);
}

export async function _wbEnsureMeetingData(){
  const allBC = window.allBuyerCriteria;
  if(!Array.isArray(allBC)) return;
  if(typeof window.isSupabase !== 'function' || !window.isSupabase()) return;
  const today = _wbTodayStr();
  const haveAny = allBC.some(r => String((r.fields&&r.fields['Date Added Buyer'])||'').slice(0,10) === today);
  if(haveAny) return;
  try{
    const rows = await _sbGet(SB_TABLES.buyerCriteria, `date_added=eq.${today}&select=*&order=created_at.desc&limit=200`);
    if(!rows || !rows.length) return;
    const newRecs = rows.map(row => {
      const fields = {};
      for(const [snake, atLabel] of Object.entries(SB_BC_MAP)){
        if(snake === 'id') continue;
        const v = row[snake];
        fields[atLabel] = (v === null || v === undefined) ? '' : v;
      }
      fields['Import Source'] = row.import_source || '';
      fields['Buyer'] = row.contact_id ? [row.contact_id] : [];
      fields['_contactId'] = row.contact_id;
      return { id: row.id, fields };
    });
    const existingIds = new Set(allBC.map(r => r.id));
    for(const rec of newRecs){
      if(!existingIds.has(rec.id)) allBC.push(rec);
    }
    const allBuyerContacts = window.allBuyerContacts;
    const contactIds = [...new Set(newRecs.map(r => r.fields._contactId).filter(Boolean))];
    const missing = contactIds.filter(id => !(allBuyerContacts && allBuyerContacts[id]));
    if(missing.length && allBuyerContacts){
      const BATCH = 40;
      for(let i=0; i<missing.length; i+=BATCH){
        const chunk = missing.slice(i, i+BATCH);
        const rows2 = await _sbGet(SB_TABLES.contacts, `id=in.(${chunk.join(',')})&select=id,name,phone_number,email,company,fub_contact_id`);
        (rows2||[]).forEach(r => {
          allBuyerContacts[r.id] = {
            Name: r.name, 'Phone Number': r.phone_number, Email: r.email,
            Company: r.company, '_fubContactId': r.fub_contact_id || null
          };
        });
      }
    }
  }catch(e){
    console.warn('[meeting] buyer data load failed:', e && e.message);
  }
}

export function _wbRenderMeeting(){
  const root = document.getElementById('wbMeetingBody');
  if(!root) return;
  const leads = _wbGetTodaysLeads();
  const buyers = _wbGetTodaysBuyers();

  const fmtPrice = v => {
    const n = Number(String(v||'').replace(/[^\d.\-]/g,''))||0;
    return n ? '$' + n.toLocaleString() : '—';
  };
  const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

  const leadsBody = leads.length === 0
    ? '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:12px;font-style:italic;">No new seller leads added today.</div>'
    : leads.map(d => {
        const addr = esc(d['Address'] || '(no address)');
        const owner = esc(d['Owner Name'] || d['Contact Name'] || '—');
        const type = esc(d['CRM Asset Classification'] || d['Simple Text Property Type'] || '—');
        const stage = esc(d['Pipeline Stage'] || '—');
        const ask = fmtPrice(d['Asking Price']);
        const agent = esc(d['Assigned Agent'] || d['Agent'] || '');
        const county = esc(d['Simple County'] || '');
        const subline = [type, owner, county, agent ? '@'+agent : ''].filter(Boolean).join(' · ');
        return `
          <div onclick="openDealSnapshot('${d.id}')"
               style="display:flex;align-items:center;gap:14px;padding:12px 14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;cursor:pointer;transition:all 0.15s;"
               onmouseenter="this.style.borderColor='#1e3a8a';this.style.background='#eef2fb'"
               onmouseleave="this.style.borderColor='#e2e8f0';this.style.background='#fff'">
            <div style="flex:1;min-width:0;">
              <div style="font-size:14px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${addr}</div>
              <div style="font-size:11px;color:#64748b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${subline}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:14px;font-weight:600;color:#0f172a;">${ask}</div>
              <div style="font-size:10px;color:#475569;margin-top:2px;">${stage}</div>
            </div>
            <div style="color:#94a3b8;font-size:14px;flex-shrink:0;">→</div>
          </div>`;
      }).join('');

  const allBuyerContacts = window.allBuyerContacts;
  const buyersBody = buyers.length === 0
    ? '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:12px;font-style:italic;">No new buyer criteria added today.</div>'
    : buyers.map(r => {
        const f = r.fields || {};
        const contactId = (f['Buyer']||[])[0];
        const contact = (allBuyerContacts && contactId) ? allBuyerContacts[contactId] : null;
        const name = esc(contact?.Name || f['Name']?.split(' - ')[0] || f['Buyer Name'] || '(unnamed buyer)');
        const company = esc(contact?.Company || '');
        const phone = esc(contact?.['Phone Number'] || '');
        const email = esc(contact?.Email || '');
        const isVip = !!f['Is VIP Buyer'];
        const assetTypes = esc((f['Simple Text Desired Property Type']||'').replace(/[🔴🟠🟡🟢🔵🟣]/g,'').trim() || '—');
        const areas = esc(f['Simple Area Preference'] || f['Location Preferences'] || f['Preferred Counties'] || f['Preferred Cities'] || '—');
        const cap = f['Minumum Cap Rate'] ? f['Minumum Cap Rate']+'%' : '—';
        const minPr = f['Min Purchase Price'], maxPr = f['Max Purchase Price'];
        const priceRange = (minPr||maxPr)
          ? `$${minPr?(Number(minPr)/1e6).toFixed(1)+'M':'?'} – $${maxPr?(Number(maxPr)/1e6).toFixed(1)+'M':'∞'}`
          : '—';
        const minU = f['Minimum # of Units MF'], maxU = f['Max # of Units MF'];
        const units = (minU||maxU) ? `${minU||'?'}–${maxU||'∞'} units` : '';
        const minSF = f['Warehouse Min Square Footage'], maxSF = f['Warehouse Max Square Footage'];
        const warehouseSF = (minSF||maxSF) ? `${minSF?Number(minSF).toLocaleString():'?'}–${maxSF?Number(maxSF).toLocaleString():'∞'} SF (warehouse)` : '';
        const officeMin = f['Office Min SF'], officeMax = f['Office Max SF'];
        const officeSF = (officeMin||officeMax) ? `${officeMin?Number(officeMin).toLocaleString():'?'}–${officeMax?Number(officeMax).toLocaleString():'∞'} SF (office)` : '';
        const retailMin = f['Retail Min SF'], retailMax = f['Retail Max SF'];
        const retailSF = (retailMin||retailMax) ? `${retailMin?Number(retailMin).toLocaleString():'?'}–${retailMax?Number(retailMax).toLocaleString():'∞'} SF (retail)` : '';
        const landAcres = (f['Land Min Acreage']||f['Land Max Acreage']) ? `${f['Land Min Acreage']||'?'}–${f['Land Max Acreage']||'∞'} acres` : '';
        const financing = esc(f['Financing Type'] || '');
        const otherReq = esc(f['Other Requirements '] || '');
        const specifics = [units, warehouseSF, officeSF, retailSF, landAcres].filter(Boolean).join(' · ');
        const contactLine = [phone, email].filter(Boolean).join(' · ');

        return `
          <div onclick="bcOpenExpanded('${r.id}')"
               style="background:#fff;border:1px solid ${isVip?'#fbbf24':'#e2e8f0'};border-radius:8px;padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:all 0.15s;"
               onmouseenter="this.style.borderColor='#1e3a8a';this.style.boxShadow='0 2px 6px rgba(30,58,138,0.08)'"
               onmouseleave="this.style.borderColor='${isVip?'#fbbf24':'#e2e8f0'}';this.style.boxShadow='none'">
            <div style="display:flex;align-items:flex-start;gap:12px;">
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
                  <span style="font-size:15px;font-weight:700;color:#0f172a;">${name}</span>
                  ${isVip?'<span style="background:#fbbf24;color:#0f172a;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;">⭐ VIP</span>':''}
                  ${company?`<span style="font-size:11px;color:#64748b;">· ${company}</span>`:''}
                </div>
                ${contactLine?`<div style="font-size:11px;color:#475569;margin-bottom:8px;">${contactLine}</div>`:''}
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 14px;font-size:11px;color:#334155;">
                  <div><span style="color:#64748b;font-weight:600;">Asset:</span> ${assetTypes}</div>
                  <div><span style="color:#64748b;font-weight:600;">Areas:</span> ${areas}</div>
                  <div><span style="color:#64748b;font-weight:600;">Price:</span> ${priceRange}</div>
                  <div><span style="color:#64748b;font-weight:600;">Min Cap:</span> ${cap}</div>
                  ${financing?`<div><span style="color:#64748b;font-weight:600;">Financing:</span> ${financing}</div>`:''}
                </div>
                ${specifics?`<div style="font-size:11px;color:#334155;margin-top:6px;"><span style="color:#64748b;font-weight:600;">Specifics:</span> ${esc(specifics)}</div>`:''}
                ${otherReq?`<div style="font-size:11px;color:#475569;margin-top:6px;font-style:italic;">"${otherReq.length>200?otherReq.slice(0,200)+'…':otherReq}"</div>`:''}
              </div>
              <div style="color:#94a3b8;font-size:14px;flex-shrink:0;align-self:center;">→</div>
            </div>
          </div>`;
      }).join('');

  root.innerHTML = `
    <div style="margin-bottom:24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="font-size:14px;font-weight:700;color:#0f172a;">🏠 New Seller Leads</div>
        <span style="background:#dbeafe;color:#1e40af;font-size:11px;font-weight:700;padding:2px 10px;border-radius:99px;">${leads.length} today</span>
      </div>
      ${leadsBody}
    </div>
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="font-size:14px;font-weight:700;color:#0f172a;">🎯 New Buyer Criteria</div>
        <span style="background:#dbeafe;color:#1e40af;font-size:11px;font-weight:700;padding:2px 10px;border-radius:99px;">${buyers.length} today</span>
      </div>
      ${buyersBody}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST RENDERERS
// ═══════════════════════════════════════════════════════════════════════

export function _wbRenderList(){
  if(_workbenchActiveTab === 'contacts') return _wbRenderContactList();
  return _wbRenderPropertyList();
}

export function _wbRenderPropertyList(){
  const el = document.getElementById('wbList');
  if(!el) return;
  if(!_workbenchItems.length){
    el.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:#64748b;font-size:13px;">
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:8px;">No deals on your Workbench yet.</div>
        <div>Open any deal and click <strong>+ Add to Workbench</strong> in the header to start triaging.</div>
      </div>`;
    return;
  }
  el.innerHTML = _workbenchItems.map((it, idx) => _wbRenderRow(it, idx)).join('');
  _wbWireRows('property');
}

export function _wbRenderContactList(){
  const el = document.getElementById('wbList');
  if(!el) return;
  if(!_workbenchContacts.length){
    el.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:#64748b;font-size:13px;">
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:8px;">No buyers on your Workbench yet.</div>
        <div>Open any contact card or buyer criteria card and click <strong>+ Add to Workbench</strong> to start triaging.</div>
      </div>`;
    return;
  }
  el.innerHTML = _workbenchContacts.map((it, idx) => _wbRenderContactRow(it, idx)).join('');
  _wbWireRows('contact');
}

export function _wbWireRows(kind){
  const el = document.getElementById('wbList');
  if(!el) return;
  el.querySelectorAll('[data-wb-row]').forEach(row => {
    row.addEventListener('dragstart', _wbDragStart);
    row.addEventListener('dragover',  _wbDragOver);
    row.addEventListener('drop',      _wbDrop);
    row.addEventListener('dragend',   _wbDragEnd);
    row.addEventListener('click', e => {
      if(e.target.closest('button, input, [data-wb-grip]')) return;
      _wbSelect(row.dataset.wbRow, kind);
    });
  });
  el.querySelectorAll('[data-wb-rank]').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); _wbRankCommit(inp); }
      else if(e.key === 'Escape'){ inp.value = inp.dataset.wbRank; inp.blur(); }
    });
    inp.addEventListener('blur', () => _wbRankCommit(inp));
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('click', e => e.stopPropagation());
  });
}

export function _wbRenderRow(item, idx){
  const d = item.deal || {};
  const dealId = item.deal_id;
  const isSelected = (dealId === _workbenchSelectedDealId);
  const addr = d['Address'] || '(no address)';
  const safeAddr = String(addr).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const assetType = d['CRM Asset Classification'] || d['Simple Text Property Type'] || '—';
  const owner = d['Owner Name'] || d['Contact Name'] || '—';
  const price = _wbFmtPrice(d['Asking Price']);
  const stage = d['Pipeline Stage'] || '—';
  const last  = _wbRelDate(_wbLastActivity(d));
  const photoUrl = _wbMainPhotoUrl(d);
  const noteSnippet = (item.notes || '').trim().split('\n')[0].slice(0, 90);

  const thumbHTML = photoUrl
    ? `<img src="${photoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.innerHTML='<div style=\\'width:100%;height:100%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:10px;\\'>No photo</div>';"/>`
    : `<div style="width:100%;height:100%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:10px;">No photo</div>`;

  const bg = isSelected ? '#eef2fb' : '#fff';
  const border = isSelected ? '1px solid #1e3a8a' : '1px solid #e2e8f0';

  return `
    <div data-wb-row="${dealId}" draggable="true"
         style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${bg};border:${border};border-radius:6px;margin-bottom:6px;cursor:pointer;">
      <div data-wb-grip style="display:flex;align-items:center;justify-content:center;width:14px;color:#94a3b8;cursor:grab;font-size:14px;line-height:1;user-select:none;" title="Drag to reorder">⋮⋮</div>
      <input type="text" inputmode="numeric" maxlength="3" value="${idx+1}" data-wb-rank="${idx+1}" data-wb-deal="${dealId}"
             title="Click and type a position to jump"
             style="width:32px;height:30px;padding:0;text-align:center;font-size:13px;font-weight:600;font-family:monospace;border:1px solid #cbd5e1;border-radius:4px;background:#fff;"/>
      <div style="width:64px;height:48px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#f1f5f9;">${thumbHTML}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeAddr}</div>
        <div style="font-size:11px;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${assetType} · ${owner}</div>
        ${noteSnippet ? `<div style="font-size:11px;color:#475569;margin-top:2px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${String(noteSnippet).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>` : ''}
      </div>
      <div style="text-align:right;flex-shrink:0;min-width:80px;">
        <div style="font-size:13px;font-weight:600;color:#0f172a;">${price}</div>
        <div style="font-size:10px;color:#475569;margin-top:2px;">${stage}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${last}</div>
      </div>
    </div>`;
}

export function _wbRenderContactRow(item, idx){
  const c = item.contact || {};
  const contactId = item.contact_id;
  const isSelected = (contactId === _workbenchSelectedContactId);
  const hydrationFailed = !item.contact;
  const name = hydrationFailed
    ? 'Contact data unavailable'
    : (c.name || '(unnamed contact)');
  const safeName = String(name).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const company = c.company || '';
  const types = Array.isArray(c.type) ? c.type.join(', ') : (c.type || '');
  const subline = company || types || '—';
  const phone = c.phone_number || '';
  const email = c.email || '';
  const contactLine = phone || email || '';
  const last = _wbRelDate(c.last_contact_date);
  const bcCount = item.bcCount || 0;
  const noteSnippet = (item.notes || '').trim().split('\n')[0].slice(0, 90);
  const initials = _wbContactInitials(name);

  const bg = isSelected ? '#eef2fb' : '#fff';
  const border = isSelected ? '1px solid #1e3a8a' : '1px solid #e2e8f0';

  return `
    <div data-wb-row="${contactId}" draggable="true"
         style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${bg};border:${border};border-radius:6px;margin-bottom:6px;cursor:pointer;">
      <div data-wb-grip style="display:flex;align-items:center;justify-content:center;width:14px;color:#94a3b8;cursor:grab;font-size:14px;line-height:1;user-select:none;" title="Drag to reorder">⋮⋮</div>
      <input type="text" inputmode="numeric" maxlength="3" value="${idx+1}" data-wb-rank="${idx+1}" data-wb-deal="${contactId}"
             title="Click and type a position to jump"
             style="width:32px;height:30px;padding:0;text-align:center;font-size:13px;font-weight:600;font-family:monospace;border:1px solid #cbd5e1;border-radius:4px;background:#fff;"/>
      <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;">${initials}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeName}</div>
        <div style="font-size:11px;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${subline}${contactLine ? ' · ' + contactLine : ''}</div>
        ${noteSnippet ? `<div style="font-size:11px;color:#475569;margin-top:2px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${String(noteSnippet).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>` : ''}
      </div>
      <div style="text-align:right;flex-shrink:0;min-width:90px;">
        <div style="font-size:11px;color:#475569;">${bcCount} buyer ${bcCount===1?'criterion':'criteria'}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:2px;">Last contact ${last}</div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════
// SELECTION + DETAIL PANE
// ═══════════════════════════════════════════════════════════════════════

export function _wbSelect(id, kind){
  kind = kind || (_workbenchActiveTab === 'contacts' ? 'contact' : 'property');
  if(kind === 'contact'){
    if(_workbenchSelectedContactId === id) return;
    if(_workbenchNotesSaveTimer){ clearTimeout(_workbenchNotesSaveTimer); _workbenchNotesSaveTimer = null; _wbSaveNotes(true); }
    _workbenchSelectedContactId = id;
  }else{
    if(_workbenchSelectedDealId === id) return;
    if(_workbenchNotesSaveTimer){ clearTimeout(_workbenchNotesSaveTimer); _workbenchNotesSaveTimer = null; _wbSaveNotes(true); }
    _workbenchSelectedDealId = id;
  }
  _wbRenderList();
  _wbRenderDetail();
}

export function _wbRenderDetail(){
  if(_workbenchActiveTab === 'contacts') return _wbRenderContactDetail();
  return _wbRenderPropertyDetail();
}

export function _wbRenderPropertyDetail(){
  const el = document.getElementById('wbDetail');
  if(!el) return;
  if(!_workbenchSelectedDealId){
    el.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#94a3b8;font-size:13px;">Add a deal to your Workbench to begin.</div>';
    return;
  }
  const item = _workbenchItems.find(it => it.deal_id === _workbenchSelectedDealId);
  if(!item){ el.innerHTML = ''; return; }
  const d = item.deal || {};
  const addr = d['Address'] || '(no address)';
  const safeAddr = String(addr).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const assetType = d['CRM Asset Classification'] || d['Simple Text Property Type'] || '—';
  const owner = d['Owner Name'] || d['Contact Name'] || '—';
  const price = _wbFmtPrice(d['Asking Price']);
  const stage = d['Pipeline Stage'] || '—';
  const last  = _wbRelDate(_wbLastActivity(d));
  const photoUrl = _wbMainPhotoUrl(d);
  const safeNotes = String(item.notes || '').replace(/&/g,'&amp;').replace(/</g,'&lt;');

  const thumbHTML = photoUrl
    ? `<img src="${photoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"/>`
    : `<div style="width:100%;height:100%;background:#e2e8f0;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:11px;">No photo</div>`;

  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:18px;">
      <div style="width:96px;height:80px;flex-shrink:0;">${thumbHTML}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
          <span style="font-size:11px;padding:2px 8px;border-radius:6px;background:#dbeafe;color:#1e40af;font-weight:600;">Position ${item.position}</span>
          <span style="font-size:11px;padding:2px 8px;border-radius:6px;background:#f1f5f9;color:#475569;">${stage}</span>
        </div>
        <div style="font-size:16px;font-weight:600;color:#0f172a;">${safeAddr}</div>
        <div style="font-size:12px;color:#64748b;margin-top:3px;">${assetType} · Owner: ${owner} · Last activity ${last}</div>
        <div style="font-size:13px;margin-top:6px;color:#0f172a;">Asking: <span style="font-weight:600;">${price}</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
        <button onclick="_wbOpenDeal('${item.deal_id}')" style="font-size:11px;padding:6px 12px;background:#0f172a;color:#fff;border:none;border-radius:5px;font-weight:600;cursor:pointer;white-space:nowrap;">Open deal</button>
        <button onclick="_wbMarkComplete('${item.deal_id}')" style="font-size:11px;padding:6px 12px;background:#fff;color:#16a34a;border:1px solid #86efac;border-radius:5px;font-weight:600;cursor:pointer;white-space:nowrap;">Mark complete</button>
        <button onclick="_wbRemove('${item.deal_id}')" style="font-size:11px;padding:6px 12px;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:5px;font-weight:600;cursor:pointer;white-space:nowrap;">Remove</button>
      </div>
    </div>

    <div>
      <label style="font-size:12px;color:#64748b;font-weight:600;">What needs to be done</label>
      <textarea id="wbNotes" placeholder="Type what needs to be done on this deal — auto-saves as you type."
        style="width:100%;min-height:240px;margin-top:6px;resize:vertical;font-family:inherit;font-size:13px;line-height:1.6;padding:10px 12px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;">${safeNotes}</textarea>
      <div id="wbNotesStatus" style="font-size:11px;color:#94a3b8;margin-top:4px;">Auto-saves as you type.</div>
    </div>`;

  _wbWireNotes();
}

export function _wbRenderContactDetail(){
  const el = document.getElementById('wbDetail');
  if(!el) return;
  if(!_workbenchSelectedContactId){
    el.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#94a3b8;font-size:13px;">Add a contact to your Workbench to begin.</div>';
    return;
  }
  const item = _workbenchContacts.find(it => it.contact_id === _workbenchSelectedContactId);
  if(!item){ el.innerHTML = ''; return; }
  const c = item.contact || {};
  const hydrationFailed = !item.contact;
  const name = hydrationFailed
    ? 'Contact data unavailable'
    : (c.name || '(unnamed contact)');
  const safeName = String(name).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const company = c.company || '';
  const phone = c.phone_number || '';
  const email = c.email || '';
  const types = Array.isArray(c.type) ? c.type.join(', ') : (c.type || '');
  const last = _wbRelDate(c.last_contact_date);
  const initials = _wbContactInitials(name);
  const safeNotes = String(item.notes || '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const phoneDigits = phone.replace(/[^0-9+]/g, '');
  const bcCount = item.bcCount || 0;

  const bcLink = bcCount === 0
    ? '<span style="font-size:11px;color:#94a3b8;">No buyer criteria yet</span>'
    : bcCount === 1
      ? `<a href="javascript:void(0)" onclick="_wbOpenContactBC('${item.contact_id}')" style="font-size:12px;color:#1e40af;text-decoration:underline;">Open buyer criteria →</a>`
      : `<a href="javascript:void(0)" onclick="_wbOpenContactBC('${item.contact_id}')" style="font-size:12px;color:#1e40af;text-decoration:underline;">${bcCount} buyer criteria →</a>`;

  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:18px;">
      <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0;">${initials}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
          <span style="font-size:11px;padding:2px 8px;border-radius:6px;background:#dbeafe;color:#1e40af;font-weight:600;">Position ${item.position}</span>
          ${types ? `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:#f1f5f9;color:#475569;">${types}</span>` : ''}
        </div>
        <div style="font-size:18px;font-weight:600;color:#0f172a;">${safeName}</div>
        <div style="font-size:12px;color:#64748b;margin-top:3px;">${company || '<em style=\"color:#94a3b8;\">No company</em>'}${last !== '—' ? ' · Last contact ' + last : ''}</div>
        <div style="font-size:13px;margin-top:8px;display:flex;flex-direction:column;gap:4px;color:#0f172a;">
          ${phone ? `<div>📞 <a href="tel:${phoneDigits}" style="color:#1e40af;text-decoration:none;font-weight:600;">${phone}</a></div>` : '<div style="color:#94a3b8;font-size:12px;">No phone</div>'}
          ${email ? `<div>✉ <a href="mailto:${email}" style="color:#1e40af;text-decoration:none;">${email}</a></div>` : ''}
        </div>
        <div style="margin-top:8px;">${bcLink}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
        <button onclick="_wbOpenContact('${item.contact_id}')" style="font-size:11px;padding:6px 12px;background:#0f172a;color:#fff;border:none;border-radius:5px;font-weight:600;cursor:pointer;white-space:nowrap;">Open contact</button>
        <button onclick="_wbMarkContactComplete('${item.contact_id}')" style="font-size:11px;padding:6px 12px;background:#fff;color:#16a34a;border:1px solid #86efac;border-radius:5px;font-weight:600;cursor:pointer;white-space:nowrap;">Mark complete</button>
        <button onclick="_wbRemoveContact('${item.contact_id}')" style="font-size:11px;padding:6px 12px;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:5px;font-weight:600;cursor:pointer;white-space:nowrap;">Remove</button>
      </div>
    </div>

    <div>
      <label style="font-size:12px;color:#64748b;font-weight:600;">What needs to be done</label>
      <textarea id="wbNotes" placeholder="Type what needs to be done with this buyer — auto-saves as you type."
        style="width:100%;min-height:240px;margin-top:6px;resize:vertical;font-family:inherit;font-size:13px;line-height:1.6;padding:10px 12px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;">${safeNotes}</textarea>
      <div id="wbNotesStatus" style="font-size:11px;color:#94a3b8;margin-top:4px;">Auto-saves as you type.</div>
    </div>`;

  _wbWireNotes();
}

// ═══════════════════════════════════════════════════════════════════════
// NOTES SAVE
// ═══════════════════════════════════════════════════════════════════════

export function _wbWireNotes(){
  const ta = document.getElementById('wbNotes');
  if(!ta) return;
  ta.addEventListener('input', () => {
    const status = document.getElementById('wbNotesStatus');
    if(status){ status.textContent = 'Saving…'; status.style.color = '#94a3b8'; }
    if(_workbenchNotesSaveTimer) clearTimeout(_workbenchNotesSaveTimer);
    _workbenchNotesSaveTimer = setTimeout(() => _wbSaveNotes(false), 600);
  });
}

export async function _wbSaveNotes(silent){
  const ta = document.getElementById('wbNotes');
  if(!ta) return;
  const isContact = (_workbenchActiveTab === 'contacts');
  const item = isContact
    ? _workbenchContacts.find(it => it.contact_id === _workbenchSelectedContactId)
    : _workbenchItems.find(it => it.deal_id === _workbenchSelectedDealId);
  if(!item) return;
  const newNotes = ta.value;
  if(newNotes === item.notes) return;
  try{
    await _sbPatch(SB_TABLES.workbench, item.id, { notes: newNotes });
    item.notes = newNotes;
    if(!silent){
      const status = document.getElementById('wbNotesStatus');
      if(status){ status.textContent = 'Saved.'; status.style.color = '#16a34a'; }
      setTimeout(() => {
        const s = document.getElementById('wbNotesStatus');
        if(s){ s.textContent = 'Auto-saves as you type.'; s.style.color = '#94a3b8'; }
      }, 1500);
    }
    _wbRenderList();
  }catch(e){
    console.error('wb save notes failed:', e);
    const status = document.getElementById('wbNotesStatus');
    if(status){ status.textContent = 'Save failed: ' + (e.message||'unknown'); status.style.color = '#dc2626'; }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// OPEN / REMOVE / MARK-COMPLETE
// ═══════════════════════════════════════════════════════════════════════

export function _wbOpenDeal(dealId){
  const allDeals = window.allDeals || [];
  const deal = allDeals.find(d => d && d.id === dealId);
  if(deal && typeof window.openDeal === 'function'){ window.openDeal(deal); return; }
  if(typeof window.setNav === 'function'){
    window.setNav(document.querySelector('[data-page="home"]'), 'home');
    setTimeout(() => {
      const d = (window.allDeals || []).find(x => x && x.id === dealId);
      if(d && typeof window.openDeal === 'function') window.openDeal(d);
    }, 100);
  }
}

export async function _wbMarkComplete(dealId){
  if(!confirm('Mark this deal complete and remove it from your Workbench?\n\nThe deal itself is unaffected — it stays in your normal pipeline.')) return;
  await _wbRemoveById(dealId);
  showSaveConfirm('Marked complete and removed from Workbench');
}

export async function _wbRemove(dealId){
  if(!confirm('Remove this deal from your Workbench?\n\nYou can re-add it any time from the deal card.')) return;
  await _wbRemoveById(dealId);
  showSaveConfirm('Removed from Workbench');
}

export async function _wbRemoveById(dealId){
  try{
    const cu = window._currentUser;
    const result = await _sbRpc('workbench_remove', {
      p_user_id: cu.id, p_deal_id: dealId
    });
    if(result && result.error){ showSaveConfirm('Workbench: ' + result.error); return; }
    if(_workbenchSelectedDealId === dealId) _workbenchSelectedDealId = null;
    await _wbLoadItems();
    if(!_workbenchSelectedDealId && _workbenchItems.length){
      _workbenchSelectedDealId = _workbenchItems[0].deal_id;
    }
    _wbRenderShell();
  }catch(e){
    console.error('wb remove failed:', e);
    showSaveConfirm('Workbench remove failed: ' + (e.message || 'unknown'));
  }
}

export async function _wbMarkContactComplete(contactId){
  if(!confirm('Mark this buyer complete and remove from your Workbench?\n\nThe contact record itself is unaffected.')) return;
  await _wbRemoveContactById(contactId);
  showSaveConfirm('Marked complete and removed from Workbench');
}

export async function _wbRemoveContact(contactId){
  if(!confirm('Remove this buyer from your Workbench?\n\nYou can re-add them any time from the contact card or buyer criteria card.')) return;
  await _wbRemoveContactById(contactId);
  showSaveConfirm('Removed from Workbench');
}

export async function _wbRemoveContactById(contactId){
  try{
    const cu = window._currentUser;
    const result = await _sbRpc('workbench_remove_contact', {
      p_user_id: cu.id, p_contact_id: contactId
    });
    if(result && result.error){ showSaveConfirm('Workbench: ' + result.error); return; }
    if(_workbenchSelectedContactId === contactId) _workbenchSelectedContactId = null;
    _wbContactPositions.delete(contactId);
    _wbSyncContactAddButtons(contactId);
    await _wbLoadContacts();
    if(!_workbenchSelectedContactId && _workbenchContacts.length){
      _workbenchSelectedContactId = _workbenchContacts[0].contact_id;
    }
    _wbRenderShell();
  }catch(e){
    console.error('wb contact remove failed:', e);
    showSaveConfirm('Workbench remove failed: ' + (e.message || 'unknown'));
  }
}

export function _wbOpenContact(contactId){
  if(typeof window.openContactModal === 'function'){
    try { window.openContactModal(contactId); } catch(e){ console.warn('openContactModal failed:', e); }
  }
}

export function _wbOpenContactBC(contactId){
  if(typeof window.openContactModal === 'function'){
    try{
      window.openContactModal(contactId);
      setTimeout(() => {
        if(typeof window._contactTabSwitch === 'function'){
          try { window._contactTabSwitch('buyer'); } catch(e){}
        }
      }, 250);
    }catch(e){ console.warn('openContactModal failed:', e); }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// REORDER — RANK INPUT + DRAG-AND-DROP
// ═══════════════════════════════════════════════════════════════════════

export async function _wbRankCommit(inp){
  const id = inp.dataset.wbDeal; // (legacy attr name; holds either deal_id or contact_id)
  const oldPos = parseInt(inp.dataset.wbRank, 10);
  const newPos = parseInt(inp.value, 10);
  if(isNaN(newPos) || newPos === oldPos){ inp.value = oldPos; return; }
  await _wbMoveTo(id, newPos);
}

export async function _wbMoveTo(id, newPosition){
  const isContact = (_workbenchActiveTab === 'contacts');
  try{
    const cu = window._currentUser;
    const result = isContact
      ? await _sbRpc('workbench_move_contact', {
          p_user_id: cu.id, p_contact_id: id, p_new_position: newPosition
        })
      : await _sbRpc('workbench_move', {
          p_user_id: cu.id, p_deal_id: id, p_new_position: newPosition
        });
    if(result && result.error){ showSaveConfirm('Workbench: ' + result.error); return; }
    if(isContact) await _wbLoadContacts();
    else          await _wbLoadItems();
    _wbRenderList();
    _wbRenderDetail();
  }catch(e){
    console.error('wb move failed:', e);
    showSaveConfirm('Reorder failed: ' + (e.message || 'unknown'));
  }
}

let _wbDragSourceId = null;

export function _wbDragStart(e){
  _wbDragSourceId = e.currentTarget.dataset.wbRow;
  e.currentTarget.style.opacity = '0.4';
  try{ e.dataTransfer.setData('text/plain', _wbDragSourceId); }catch(_){}
  e.dataTransfer.effectAllowed = 'move';
}

export function _wbDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  row.style.borderTop = '2px solid #1e3a8a';
}

export function _wbDragEnd(e){
  e.currentTarget.style.opacity = '1';
  document.querySelectorAll('[data-wb-row]').forEach(r => {
    r.style.borderTop = '';
  });
  _wbDragSourceId = null;
}

export async function _wbDrop(e){
  e.preventDefault();
  e.currentTarget.style.borderTop = '';
  const targetId = e.currentTarget.dataset.wbRow;
  if(!_wbDragSourceId || _wbDragSourceId === targetId) return;
  const isContact = (_workbenchActiveTab === 'contacts');
  const targetItem = isContact
    ? _workbenchContacts.find(it => it.contact_id === targetId)
    : _workbenchItems.find(it => it.deal_id === targetId);
  if(!targetItem) return;
  await _wbMoveTo(_wbDragSourceId, targetItem.position);
}
