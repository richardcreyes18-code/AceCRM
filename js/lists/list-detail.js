// lists/list-detail.js — detail page for one lead list, plus the
// lead-detail side panel (property + call history + log-a-call).
//
// v378: generic tables (lead_lists / leads / call_logs / scripts).

import { _sbGet, _sbPost, _sbPatch } from '../core/supabase.js';
import { _showToast } from '../core/toast.js';

// ─── Module state ──────────────────────────────────────────────────────
let _list = null;
let _leads = [];
let _page = 0;
const PAGE_SIZE = 100;
let _filters = { status: 'all', q: '' };

// Lead-detail panel state
let _activeLead = null;
let _activeCalls = [];
let _scripts = null; // lazy-loaded

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtMoney(n){
  if(n == null || n === '') return '—';
  const num = Number(n);
  if(!isFinite(num)) return '—';
  return '$' + Math.round(num).toLocaleString();
}
function fmtDateTime(iso){
  if(!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch(e){ return '—'; }
}
function fmtPhone(s){
  if(!s) return '—';
  const d = String(s).replace(/\D/g,'');
  if(d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if(d.length === 11 && d[0] === '1') return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return s;
}

const STATUSES = [
  { id: 'new',            label: 'New',           color: '#6366f1' },
  { id: 'attempted',      label: 'Attempted',     color: '#f59e0b' },
  { id: 'no_answer',      label: 'No answer',     color: '#f59e0b' },
  { id: 'voicemail',      label: 'Voicemail',     color: '#f59e0b' },
  { id: 'callback',       label: 'Callback',      color: '#3b82f6' },
  { id: 'interested',     label: 'Interested',    color: '#16a34a' },
  { id: 'not_interested', label: 'Not interested',color: '#64748b' },
  { id: 'dnc',            label: 'DNC',           color: '#dc2626' },
  { id: 'converted',      label: 'Converted',     color: '#8b5cf6' },
];
function _statusMeta(id){ return STATUSES.find(s => s.id === id) || { label: id || '—', color: '#94a3b8' }; }

// ─── Open a list ───────────────────────────────────────────────────────
export async function openLeadList(id){
  const main = document.getElementById('mainArea');
  if(!main) return;
  _page = 0;
  _filters = { status: 'all', q: '' };
  main.innerHTML = `<div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">Loading list…</div>`;
  try{
    const [listRow] = await _sbGet('lead_lists', `id=eq.${id}&select=*`);
    if(!listRow){ main.innerHTML = `<div style="padding:40px;text-align:center;color:#dc2626;">List not found.</div>`; return; }
    _list = listRow;
    main.innerHTML = _renderShell();
    await _reloadLeads();
  } catch(e){
    main.innerHTML = `<div style="padding:40px;text-align:center;color:#dc2626;">Failed to load: ${esc(e.message||e)}</div>`;
  }
}

function _renderShell(){
  return `
    <div style="max-width:1400px;margin:0 auto;padding:20px 28px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <button onclick="showListsPage()" style="background:transparent;border:none;color:#64748b;font-size:12px;cursor:pointer;padding:4px 0;">← All lists</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
        <div>
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;">${esc(_list.name)}</h1>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            ${esc(_list.source || 'manual')} · ${(_list.total_count || 0).toLocaleString()} leads · ${(_list.active_count || 0).toLocaleString()} active
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center;">
        <input id="leadSearch" type="search" placeholder="Search name, phone, address…" oninput="_leadSearch(this.value)"
          style="flex:1;min-width:220px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;"/>
        <select onchange="_leadFilterStatus(this.value)"
          style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:#fff;">
          <option value="all">All statuses</option>
          ${STATUSES.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
        </select>
      </div>
      <div id="leadsTable"></div>
      <div id="leadsPager" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12px;color:#64748b;"></div>
    </div>
    <div id="leadDetailPanel"></div>
  `;
}

async function _reloadLeads(){
  const el = document.getElementById('leadsTable');
  if(!el) return;
  el.innerHTML = `<div style="padding:30px;text-align:center;color:#94a3b8;font-size:12px;">Loading…</div>`;
  try{
    let params = `list_id=eq.${_list.id}&deleted_at=is.null&order=created_at.asc&select=*`;
    params += `&limit=${PAGE_SIZE}&offset=${_page * PAGE_SIZE}`;
    if(_filters.status !== 'all') params += `&status=eq.${_filters.status}`;
    if(_filters.q.trim()){
      const q = encodeURIComponent('%' + _filters.q.trim() + '%');
      params += `&or=(name.ilike.${q},phone.ilike.${q},property_address.ilike.${q},mailing_address.ilike.${q})`;
    }
    const rows = await _sbGet('leads', params);
    _leads = Array.isArray(rows) ? rows : [];
    _renderLeadsTable();
  } catch(e){
    el.innerHTML = `<div style="padding:30px;text-align:center;color:#dc2626;">Failed: ${esc(e.message||e)}</div>`;
  }
}

function _renderLeadsTable(){
  const el = document.getElementById('leadsTable');
  if(!el) return;
  if(!_leads.length){
    el.innerHTML = `<div style="padding:40px;text-align:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;color:#64748b;font-size:13px;">No leads match these filters.</div>`;
    document.getElementById('leadsPager').innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
          <tr>
            <th style="text-align:left;padding:10px 12px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Owner</th>
            <th style="text-align:left;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Phone</th>
            <th style="text-align:left;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Property</th>
            <th style="text-align:right;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Est. value</th>
            <th style="text-align:right;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Equity</th>
            <th style="text-align:center;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Attempts</th>
            <th style="text-align:left;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Last call</th>
            <th style="text-align:left;padding:10px 10px;font-weight:600;color:#475569;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${_leads.map(l => _renderLeadRow(l)).join('')}
        </tbody>
      </table>
    </div>
  `;
  const pager = document.getElementById('leadsPager');
  if(pager){
    const start = _page * PAGE_SIZE + 1;
    const end   = start + _leads.length - 1;
    pager.innerHTML = `
      <span>Showing ${start.toLocaleString()}–${end.toLocaleString()} of ~${(_list.total_count||0).toLocaleString()}</span>
      <span>
        <button onclick="_leadPagePrev()" ${_page===0?'disabled':''} style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:5px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:${_page===0?'not-allowed':'pointer'};opacity:${_page===0?0.5:1};">← Prev</button>
        <button onclick="_leadPageNext()" ${_leads.length < PAGE_SIZE?'disabled':''} style="margin-left:6px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:5px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:${_leads.length<PAGE_SIZE?'not-allowed':'pointer'};opacity:${_leads.length<PAGE_SIZE?0.5:1};">Next →</button>
      </span>`;
  }
}

function _renderLeadRow(l){
  const sm = _statusMeta(l.status);
  const addr = l.property_address
    ? `${esc(l.property_address)}${l.property_city ? ', ' + esc(l.property_city) : ''}${l.property_state ? ', ' + esc(l.property_state) : ''}`
    : '—';
  return `
    <tr style="border-top:1px solid #f1f5f9;cursor:pointer;" onclick="openLead('${l.id}')"
        onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
      <td style="padding:9px 12px;color:#0f172a;font-weight:500;">${esc(l.name || '—')}</td>
      <td style="padding:9px 10px;color:#334155;font-variant-numeric:tabular-nums;">${fmtPhone(l.phone)}</td>
      <td style="padding:9px 10px;color:#64748b;">${addr}</td>
      <td style="padding:9px 10px;text-align:right;color:#0f172a;font-variant-numeric:tabular-nums;">${fmtMoney(l.estimated_value)}</td>
      <td style="padding:9px 10px;text-align:right;color:#16a34a;font-variant-numeric:tabular-nums;">${l.equity_pct != null ? Math.round(l.equity_pct) + '%' : '—'}</td>
      <td style="padding:9px 10px;text-align:center;color:#334155;">${l.total_attempts || 0}</td>
      <td style="padding:9px 10px;color:#64748b;">${l.last_call_at ? fmtDateTime(l.last_call_at) : '—'}</td>
      <td style="padding:9px 10px;">
        <span style="display:inline-block;padding:2px 8px;font-size:10px;font-weight:600;border-radius:999px;
                     background:${sm.color}22;color:${sm.color};text-transform:uppercase;letter-spacing:0.04em;">
          ${sm.label}
        </span>
      </td>
    </tr>`;
}

export function _leadPagePrev(){ if(_page > 0){ _page--; _reloadLeads(); } }
export function _leadPageNext(){ _page++; _reloadLeads(); }
export function _leadFilterStatus(v){ _filters.status = v; _page = 0; _reloadLeads(); }
let _searchTimer = null;
export function _leadSearch(v){
  _filters.q = v;
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { _page = 0; _reloadLeads(); }, 220);
}

// ─── Lead-detail side panel ────────────────────────────────────────────
export async function openLead(id){
  const panel = document.getElementById('leadDetailPanel');
  if(!panel) return;
  _activeLead = null;
  _activeCalls = [];
  panel.innerHTML = _renderPanelShell('<div style="padding:40px;text-align:center;color:#94a3b8;">Loading…</div>');
  try{
    const [lead] = await _sbGet('leads', `id=eq.${id}&select=*`);
    if(!lead){ _closeLead(); _showToast('Lead not found', 'error'); return; }
    _activeLead = lead;
    const calls = await _sbGet('call_logs', `lead_id=eq.${id}&order=call_at.desc&select=*`);
    _activeCalls = Array.isArray(calls) ? calls : [];
    if(_scripts === null){
      try{
        const rows = await _sbGet('scripts', 'is_active=eq.true&order=category.asc,name.asc&select=id,name,category,body');
        _scripts = Array.isArray(rows) ? rows : [];
      } catch(e){ _scripts = []; }
    }
    _renderPanel();
  } catch(e){
    panel.innerHTML = _renderPanelShell(`<div style="padding:40px;text-align:center;color:#dc2626;">${esc(e.message||e)}</div>`);
  }
}

export function _closeLead(){
  const panel = document.getElementById('leadDetailPanel');
  if(panel) panel.innerHTML = '';
  _activeLead = null;
  _activeCalls = [];
}

function _renderPanelShell(inner){
  return `
    <div onclick="_closeLead()"
         style="position:fixed;inset:0;background:rgba(15,23,42,0.5);z-index:1500;">
    </div>
    <div onclick="event.stopPropagation()"
         style="position:fixed;top:0;right:0;bottom:0;width:560px;max-width:100vw;background:#fff;
                box-shadow:-8px 0 32px rgba(0,0,0,0.15);z-index:1501;overflow-y:auto;">
      ${inner}
    </div>`;
}

function _renderPanel(){
  const l = _activeLead;
  const sm = _statusMeta(l.status);
  const panel = document.getElementById('leadDetailPanel');
  const addr = l.property_address
    ? `${esc(l.property_address)}${l.property_city?', ' + esc(l.property_city):''}${l.property_state?', ' + esc(l.property_state):''}${l.property_zip?' ' + esc(l.property_zip):''}`
    : '—';
  const mail = l.mailing_address
    ? `${esc(l.mailing_address)}${l.mailing_city?', ' + esc(l.mailing_city):''}${l.mailing_state?', ' + esc(l.mailing_state):''}${l.mailing_zip?' ' + esc(l.mailing_zip):''}`
    : '—';

  const inner = `
    <div style="padding:18px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;">Lead</div>
        <div style="font-size:18px;font-weight:700;color:#0f172a;">${esc(l.name || 'Unnamed')}</div>
        <div style="margin-top:6px;">
          <span style="display:inline-block;padding:2px 8px;font-size:10.5px;font-weight:600;border-radius:999px;
                       background:${sm.color}22;color:${sm.color};text-transform:uppercase;letter-spacing:0.04em;">
            ${sm.label}
          </span>
        </div>
      </div>
      <button onclick="_closeLead()" style="background:transparent;border:none;font-size:22px;color:#64748b;cursor:pointer;line-height:1;">×</button>
    </div>

    <div style="padding:14px 22px;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Quick actions</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <button onclick="_logCall()" style="background:#0f172a;color:#fff;border:none;padding:7px 12px;font-size:12px;font-weight:600;border-radius:5px;cursor:pointer;">📞 Log a call</button>
        <button onclick="_convertLead()" style="background:#16a34a;color:#fff;border:none;padding:7px 12px;font-size:12px;font-weight:600;border-radius:5px;cursor:pointer;" ${l.converted_to_contact_id?'disabled':''}>
          ${l.converted_to_contact_id ? '✓ Converted' : '→ Convert to Contact'}
        </button>
      </div>
      <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px;">
        ${STATUSES.map(s => `
          <button onclick="_setLeadStatus('${s.id}')"
            style="background:${l.status===s.id?s.color:'#f1f5f9'};color:${l.status===s.id?'#fff':s.color};
                   border:1px solid ${s.color};padding:3px 9px;font-size:10.5px;font-weight:600;border-radius:999px;cursor:pointer;">
            ${s.label}
          </button>`).join('')}
      </div>
    </div>

    <div style="padding:14px 22px;">
      <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Contact</div>
      ${_kv('Phone', fmtPhone(l.phone))}
      ${l.phone_secondary ? _kv('Phone 2', fmtPhone(l.phone_secondary)) : ''}
      ${l.email ? _kv('Email', esc(l.email)) : ''}
      ${_kv('Mailing', mail)}
    </div>

    <div style="padding:14px 22px;border-top:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Property</div>
      ${_kv('Address', addr)}
      ${l.property_type ? _kv('Type', esc(l.property_type)) : ''}
      ${(l.bedrooms || l.bathrooms || l.sqft) ? _kv('Specs', `${l.bedrooms||'—'} bd · ${l.bathrooms||'—'} ba · ${l.sqft?l.sqft.toLocaleString()+' sf':'—'}`) : ''}
      ${l.year_built ? _kv('Year built', l.year_built) : ''}
      ${l.lot_size ? _kv('Lot', l.lot_size.toLocaleString()) : ''}
      ${l.owner_occupied != null ? _kv('Owner-occ', l.owner_occupied ? 'Yes' : 'No') : ''}
      ${l.estimated_value ? _kv('Est. value', fmtMoney(l.estimated_value)) : ''}
      ${l.loan_balance ? _kv('Loan balance', fmtMoney(l.loan_balance)) : ''}
      ${l.equity_pct != null ? _kv('Equity', Math.round(l.equity_pct) + '%') : ''}
      ${l.last_sale_date ? _kv('Last sold', `${l.last_sale_date}${l.last_sale_price?' · '+fmtMoney(l.last_sale_price):''}`) : ''}
    </div>

    <div style="padding:14px 22px;border-top:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Notes</div>
      <textarea id="leadNotes" placeholder="Private notes on this lead…" rows="3"
        oninput="_leadNotesDirty=true" onblur="_saveLeadNotes()"
        style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;resize:vertical;font-family:inherit;">${esc(l.notes || '')}</textarea>
    </div>

    <div style="padding:14px 22px;border-top:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">
        Call history · ${_activeCalls.length}
      </div>
      ${_activeCalls.length ? _activeCalls.map(_renderCallEntry).join('') : `<div style="color:#94a3b8;font-size:12px;padding:12px 0;">No calls logged yet.</div>`}
    </div>
  `;
  panel.innerHTML = _renderPanelShell(inner);
}

function _kv(k, v){
  return `
    <div style="display:flex;gap:10px;padding:3px 0;font-size:12px;">
      <div style="min-width:90px;color:#94a3b8;">${esc(k)}</div>
      <div style="flex:1;color:#0f172a;">${v}</div>
    </div>`;
}

function _renderCallEntry(c){
  return `
    <div style="padding:10px 0;border-top:1px solid #f1f5f9;">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">
        <div style="font-weight:600;color:#0f172a;">${esc(_outcomeLabel(c.outcome))}</div>
        <div style="color:#64748b;font-size:11px;">${fmtDateTime(c.call_at)}</div>
      </div>
      ${c.duration_seconds ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${Math.round(c.duration_seconds/60)} min ${c.duration_seconds%60}s</div>` : ''}
      ${c.notes ? `<div style="margin-top:6px;font-size:12px;color:#334155;white-space:pre-wrap;">${esc(c.notes)}</div>` : ''}
    </div>`;
}

const OUTCOMES = [
  'answered','no_answer','voicemail','busy','wrong_number',
  'dnc','callback_scheduled','interested','not_interested'
];
function _outcomeLabel(o){
  if(!o) return '—';
  return o.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Mutations ─────────────────────────────────────────────────────────
export async function _setLeadStatus(id){
  if(!_activeLead) return;
  const leadId = _activeLead.id;
  try{
    await _sbPatch('leads', leadId, { status: id });
    _activeLead.status = id;
    _renderPanel();
    // Reload the row in the table
    await _reloadLeads();
    _showToast('Status updated');
  } catch(e){ _showToast('Error: ' + (e.message||e), 'error'); }
}

let _leadNotesDirty = false;
window._leadNotesDirty = false;
export async function _saveLeadNotes(){
  if(!window._leadNotesDirty || !_activeLead) return;
  const ta = document.getElementById('leadNotes');
  if(!ta) return;
  const v = ta.value;
  try{
    await _sbPatch('leads', _activeLead.id, { notes: v });
    _activeLead.notes = v;
    window._leadNotesDirty = false;
  } catch(e){ _showToast('Notes save failed', 'error'); }
}

// ─── Log a call ────────────────────────────────────────────────────────
export function _logCall(){
  if(!_activeLead) return;
  const existing = document.getElementById('logCallModal');
  if(existing) existing.remove();
  const scripts = _scripts || [];
  const modal = document.createElement('div');
  modal.id = 'logCallModal';
  modal.style.cssText = `position:fixed;inset:0;background:rgba(15,23,42,0.6);z-index:1700;display:flex;align-items:center;justify-content:center;padding:20px;`;
  modal.onclick = e => { if(e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:520px;width:100%;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.3);">
      <div style="padding:18px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">Log a call — ${esc(_activeLead.name || 'Lead')}</h2>
        <button onclick="document.getElementById('logCallModal').remove()" style="background:transparent;border:none;font-size:22px;color:#64748b;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="padding:18px 22px;">
        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Outcome</label>
        <select id="callOutcome" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;">
          ${OUTCOMES.map(o => `<option value="${o}">${_outcomeLabel(o)}</option>`).join('')}
        </select>

        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Duration (minutes)</label>
        <input id="callMinutes" type="number" min="0" step="0.5" placeholder="e.g. 2.5"
          style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;"/>

        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Script used (optional)</label>
        <select id="callScript" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;">
          <option value="">— None —</option>
          ${scripts.map(s => `<option value="${s.id}">${esc(s.name)}${s.category ? ' (' + esc(s.category) + ')' : ''}</option>`).join('')}
        </select>

        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Notes</label>
        <textarea id="callNotes" rows="4" placeholder="What happened on the call…"
          style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical;"></textarea>
      </div>
      <div style="padding:12px 22px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
        <button onclick="document.getElementById('logCallModal').remove()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Cancel</button>
        <button onclick="_submitCallLog()" style="background:#0f172a;color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Save call</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

export async function _submitCallLog(){
  if(!_activeLead) return;
  const outcome = document.getElementById('callOutcome').value;
  const minutes = parseFloat(document.getElementById('callMinutes').value);
  const scriptId = document.getElementById('callScript').value || null;
  const notes = document.getElementById('callNotes').value;
  const user = window._currentUser || {};
  const row = {
    lead_id: _activeLead.id,
    user_id: user.id || null,
    call_at: new Date().toISOString(),
    outcome,
    duration_seconds: isFinite(minutes) ? Math.round(minutes * 60) : null,
    notes: notes || null,
    script_id: scriptId,
  };
  try{
    await _sbPost('call_logs', row);

    // Also nudge lead status based on outcome
    const nextStatus = _statusFromOutcome(outcome);
    if(nextStatus && nextStatus !== _activeLead.status){
      await _sbPatch('leads', _activeLead.id, { status: nextStatus });
    }
    document.getElementById('logCallModal').remove();
    _showToast('Call logged');
    openLead(_activeLead.id);
    await _reloadLeads();
  } catch(e){ _showToast('Save failed: ' + (e.message||e), 'error'); }
}

function _statusFromOutcome(o){
  switch(o){
    case 'interested':         return 'interested';
    case 'not_interested':     return 'not_interested';
    case 'dnc':                return 'dnc';
    case 'callback_scheduled': return 'callback';
    case 'voicemail':          return 'voicemail';
    case 'no_answer': case 'busy': return 'no_answer';
    case 'wrong_number':       return 'not_interested';
    case 'answered':           return 'attempted';
    default: return null;
  }
}

// ─── Convert to contact ────────────────────────────────────────────────
export async function _convertLead(){
  if(!_activeLead || _activeLead.converted_to_contact_id) return;
  if(!confirm(`Create a Contact for "${_activeLead.name || 'this lead'}"?`)) return;
  const l = _activeLead;
  // ace_contacts columns: id, name, phone_number, secondary_phone, email,
  // addresses (jsonb), import_source, contact_notes, type, …
  const mailingLine = [l.mailing_address, l.mailing_city, l.mailing_state, l.mailing_zip]
    .filter(Boolean).join(', ');
  const addresses = (l.mailing_address || l.property_address) ? [
    ...(l.mailing_address ? [{ label: 'mailing', address: mailingLine }] : []),
    ...(l.property_address ? [{
      label: 'property',
      address: [l.property_address, l.property_city, l.property_state, l.property_zip].filter(Boolean).join(', '),
    }] : []),
  ] : null;
  try{
    const contact = await _sbPost('ace_contacts', {
      name:            l.name || '(no name)',
      phone_number:    l.phone || null,
      secondary_phone: l.phone_secondary || null,
      email:           l.email || null,
      addresses:       addresses,
      contact_notes:   l.notes || null,
      import_source:   'lead_list',
    });
    const contactId = contact && contact.id;
    if(!contactId) throw new Error('No contact id returned');
    await _sbPatch('leads', l.id, {
      converted_to_contact_id: contactId,
      status: 'converted',
    });
    _showToast('Converted to Contact');
    openLead(l.id);
    await _reloadLeads();
  } catch(e){ _showToast('Conversion failed: ' + (e.message||e), 'error'); }
}
