// fub/fub.js — FUB (Follow Up Boss) integration: import preview, sync
// history, unmatched-deal reconciliation, audit log.
//
// Phase 5 commit 3 of 4. ~1,568 lines, 49 exports. One contiguous region
// (lines ~48928–50495 in legacy, pre-deletion). Module-internal state:
// _fubSyncState, _fubUmState, _fubUmSearchTimer, _fubUmLinkSearchTimer,
// _fubAuditState. The smaller FUB CSV-import helpers (lines ~16737, 18773
// in legacy) stay in legacy for now — they're tiny utilities scattered
// across other features and can come along later.
//
// External deps on window.*: only window._currentUser (already `var`).
// Function declarations like cleanAddress, getConfig, isSupabase resolve
// via the global env lookup chain.

import { _sbGet, _sbPost, _sbPatch, _sbDelete } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

export function _fubImportOpen(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  main.innerHTML = `
    <div style="padding:16px 22px;max-width:1100px;margin:0 auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div style="font-size:20px;font-weight:700;color:#0f172a;">📥 FUB Data Import</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px;">Read-only preview of overlap between FUB records and your CRM. No data is written yet.</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button onclick="setNav(null,'settings')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Back to Settings</button>
          <button id="fubRunAnalysisBtn" onclick="_fubRunAnalysis()" style="background:#0f172a;color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">🔄 Run analysis</button>
        </div>
      </div>
      <div id="fubImportBody">
        <div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">Click <strong>Run analysis</strong> to scan 26,695 FUB contacts against your current ${(allContacts||[]).length} CRM contacts. Takes ~2 seconds.</div>
      </div>
    </div>`;
  // Auto-run on first open if we haven't analyzed recently
  _fubLoadLastAnalysis();
}

export async function _fubLoadLastAnalysis(){
  // Check if we have a previous analysis — read summary from the table
  try{
    const rows = await _sbGet('ace_fub_import_analysis',
      'select=match_status&limit=1');
    if(Array.isArray(rows) && rows.length){
      // Table has data — re-compute counts on the client
      await _fubRefreshCounts();
    }
  }catch(e){}
}

export async function _fubRunAnalysis(){
  const btn = document.getElementById('fubRunAnalysisBtn');
  const body = document.getElementById('fubImportBody');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Analyzing...'; }
  if(body) body.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">⏳ Analyzing 26,695 FUB records against your CRM... takes a few seconds.</div>';
  try{
    const result = await _sbRpc('analyze_fub_import');
    if(Array.isArray(result) && result.length){
      _fubAnalysisSummary = result[0];
      _fubRowsCache = {};
      _fubRenderSummary();
    } else {
      if(body) body.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;font-size:13px;">Analysis returned no results. Check console for errors.</div>';
    }
  }catch(e){
    if(body) body.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;font-size:13px;">Error: ' + (e.message||'unknown') + '</div>';
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '🔄 Re-run analysis'; }
  }
}

export async function _fubRefreshCounts(){
  // Used when reopening the page — re-compute counts from the analysis table
  try{
    const [newRows, matchedRows, ambigRows] = await Promise.all([
      _sbGet('ace_fub_import_analysis', 'select=fub_contact_id&match_status=eq.new&limit=1'),
      _sbGet('ace_fub_import_analysis', 'select=fub_contact_id&match_status=in.(matched_phone,matched_email)&limit=1'),
      _sbGet('ace_fub_import_analysis', 'select=fub_contact_id&match_status=eq.matched_name_only&limit=1')
    ]);
    // If anything returned, we have data — but we don't have exact counts without a RPC.
    // Just prompt user to re-run analysis for fresh counts
    const body = document.getElementById('fubImportBody');
    if(body) body.innerHTML = '<div style="padding:30px;text-align:center;color:#64748b;font-size:13px;">Previous analysis is available. Click <strong>Run analysis</strong> to refresh with current data.</div>';
  }catch(e){}
}

export function _fubRenderSummary(){
  const s = _fubAnalysisSummary;
  if(!s){ return; }
  const body = document.getElementById('fubImportBody');
  if(!body) return;

  const card = (icon, label, count, color, desc, tab) => `
    <div onclick="${tab?`_fubShowDetail('${tab}')`:''}" style="flex:1;min-width:200px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;${tab?'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s;':''}" ${tab?`onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.08)';" onmouseleave="this.style.transform='';this.style.boxShadow='';"`:''}>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="font-size:22px;">${icon}</div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
      </div>
      <div style="font-size:28px;font-weight:800;color:${color};line-height:1;">${count.toLocaleString()}</div>
      <div style="font-size:11px;color:#64748b;margin-top:6px;line-height:1.5;">${desc}</div>
      ${tab?`<div style="font-size:10px;color:#2563eb;font-weight:600;margin-top:8px;">View rows →</div>`:''}
    </div>`;

  body.innerHTML = `
    <div style="background:#eef2fb;border:1px solid #c7d2fe;border-radius:10px;padding:14px 18px;margin-bottom:16px;font-size:12px;color:#1e3a8a;">
      <strong>Analyzed ${s.total_fub.toLocaleString()} FUB contacts</strong> in ${s.analysis_duration_ms}ms. Results below show what would happen if you ran the full import.
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:18px;">
      ${card('✅', 'Already in CRM', s.already_matched, '#16a34a', 'Matched by phone or email. Would be <strong>skipped</strong> on import.', 'matched')}
      ${card('🆕', 'New to import', s.new_to_import, '#2563eb', 'No overlap with your CRM. Would be <strong>imported</strong>.', 'new')}
      ${card('⚠️', 'Name-only match', s.name_only_ambiguous, '#b45309', 'Name matches but phone/email don\'t. <strong>Needs review</strong>.', 'ambiguous')}
      ${card('🚫', 'No contact info', s.no_contact_info, '#6b7280', 'No phone, email, or name. Would be <strong>skipped</strong>.', null)}
    </div>

    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;font-size:12px;color:#713f12;">
      <div style="font-weight:700;margin-bottom:6px;">📋 Next steps</div>
      <ol style="margin:0;padding-left:20px;line-height:1.7;">
        <li><strong>Review the name-only matches</strong> (${s.name_only_ambiguous.toLocaleString()}) — these are likely duplicates but need your eyes before merging</li>
        <li><strong>Run Ship 2 (coming next)</strong> — will insert the ${s.new_to_import.toLocaleString()} new contacts + their deals</li>
        <li><strong>Run existing dedupe</strong> — will catch any remaining duplicates in your CRM</li>
        <li><strong>Ship 3 AI enrichment</strong> — will parse FUB notes to fill buyer criteria / seller details</li>
      </ol>
    </div>
  `;
}

// v108.1: detail view now has search + pagination. Loads 500 rows at a
// time — clicking "Load more" appends the next 500. Search filters
// server-side by name/phone/email so you can find specific contacts in
// the 18K+ "new" category without scrolling.
let _fubDetailRows = [];
let _fubDetailOffset = 0;
let _fubDetailTab = null;
let _fubDetailSearch = '';
const _FUB_PAGE_SIZE = 500;

export async function _fubShowDetail(tab){
  _fubDetailTab = tab;
  _fubDetailRows = [];
  _fubDetailOffset = 0;
  _fubDetailSearch = '';
  const body = document.getElementById('fubImportBody');
  if(!body) return;

  const labels = {
    'new': { title: '🆕 New contacts to import', color: '#2563eb' },
    'matched': { title: '✅ Already in CRM (would skip)', color: '#16a34a' },
    'ambiguous': { title: '⚠️ Name-only matches (review)', color: '#b45309' }
  };
  const lbl = labels[tab];

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button onclick="_fubRenderSummary()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:6px 14px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">← Back to summary</button>
        <div style="font-size:16px;font-weight:700;color:${lbl.color};">${lbl.title}</div>
      </div>
      <input id="fubDetailSearch" type="text" placeholder="Search name, phone, or email..." oninput="_fubDetailSearchInput()" style="width:280px;padding:7px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;"/>
    </div>
    <div id="fubDetailTable" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <div style="padding:30px;text-align:center;color:#64748b;font-size:12px;">⏳ Loading...</div>
    </div>
    <div id="fubDetailFooter" style="margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;"></div>
  `;

  await _fubDetailLoadPage(true);
}

let _fubSearchDebounce = null;
export function _fubDetailSearchInput(){
  clearTimeout(_fubSearchDebounce);
  _fubSearchDebounce = setTimeout(async () => {
    _fubDetailSearch = (document.getElementById('fubDetailSearch')?.value || '').trim();
    _fubDetailRows = [];
    _fubDetailOffset = 0;
    await _fubDetailLoadPage(true);
  }, 300);
}

export async function _fubDetailLoadPage(isInitial){
  const statusFilter = {
    'new': 'eq.new',
    'matched': 'in.(matched_phone,matched_email)',
    'ambiguous': 'eq.matched_name_only'
  }[_fubDetailTab];

  // v108.3: fetch the full set of preview columns for the big spreadsheet
  let query = `select=fub_contact_id,fub_name,fub_type,fub_stage,fub_source,fub_tags,fub_primary_phone,fub_primary_email,fub_all_phones,fub_all_emails,fub_address,fub_has_deal,fub_deal_name,fub_deal_stage,fub_deal_price,note_count,latest_note_date,latest_note_preview,call_count,latest_call_date,latest_call_summary,matched_ace_id,matched_ace_name,matched_on&match_status=${statusFilter}&order=fub_name.asc&limit=${_FUB_PAGE_SIZE}&offset=${_fubDetailOffset}`;
  if(_fubDetailSearch){
    const s = encodeURIComponent('*' + _fubDetailSearch + '*');
    query += `&or=(fub_name.ilike.${s},fub_primary_phone.ilike.${s},fub_primary_email.ilike.${s},fub_deal_name.ilike.${s})`;
  }

  try{
    const rows = await _sbGet('ace_fub_import_analysis', query);
    if(Array.isArray(rows)){
      if(isInitial) _fubDetailRows = rows;
      else _fubDetailRows = _fubDetailRows.concat(rows);
      _fubDetailRender();
    }
  }catch(e){
    const tbl = document.getElementById('fubDetailTable');
    if(tbl) tbl.innerHTML = '<div style="padding:30px;text-align:center;color:#dc2626;font-size:12px;">Error: '+(e.message||'unknown')+'</div>';
  }
}

export function _fubDetailRender(){
  const tbl = document.getElementById('fubDetailTable');
  const footer = document.getElementById('fubDetailFooter');
  if(!tbl) return;

  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const escAttr = s => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  const rows = _fubDetailRows;
  const showMatch = _fubDetailTab !== 'new';
  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) : '';
  const truncate = (s, n) => { const v = String(s||''); return v.length > n ? v.slice(0, n) + '…' : v; };

  if(!rows.length){
    tbl.innerHTML = '<div style="padding:30px;text-align:center;color:#64748b;font-size:12px;">'+(_fubDetailSearch?'No rows match your search.':'No rows in this category.')+'</div>';
    if(footer) footer.innerHTML = '';
    return;
  }

  const lastPageFull = (rows.length % _FUB_PAGE_SIZE === 0) && (rows.length >= _FUB_PAGE_SIZE);

  // v108.3: WIDE SPREADSHEET VIEW — every column visible at a glance,
  // horizontal scrolling enabled, sticky header, sticky first column (name)
  const th = (label, width) => `<th style="padding:6px 8px;text-align:left;border-right:1px solid #334;font-weight:600;min-width:${width}px;white-space:nowrap;">${label}</th>`;
  const thSticky = (label, width) => `<th style="padding:6px 8px;text-align:left;border-right:1px solid #334;font-weight:600;min-width:${width}px;white-space:nowrap;position:sticky;left:0;background:linear-gradient(180deg,#1a3a6e,#0e2244);z-index:3;">${label}</th>`;

  tbl.innerHTML = `
    <div style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Showing <strong>${rows.length.toLocaleString()}</strong> rows${_fubDetailSearch?' matching "'+esc(_fubDetailSearch)+'"':''}${lastPageFull?' (more available)':''}</span>
      <span style="color:#94a3b8;">↔ Scroll horizontally to see all fields · 👆 Click row for full detail · Hover cells for full content</span>
    </div>
    <div style="max-height:70vh;overflow:auto;">
      <table style="width:max-content;min-width:100%;border-collapse:collapse;font-size:11px;">
        <thead style="position:sticky;top:0;background:linear-gradient(180deg,#1a3a6e,#0e2244);color:#fff;z-index:2;">
          <tr>
            ${thSticky('FUB Name', 160)}
            ${th('Type', 70)}
            ${th('FUB Stage', 120)}
            ${th('Phone(s)', 140)}
            ${th('Email(s)', 180)}
            ${th('Address', 180)}
            ${th('Tags', 140)}
            ${th('Source', 100)}
            ${th('Deal Name', 240)}
            ${th('Deal Stage', 120)}
            ${th('Deal $', 90)}
            ${th('# Notes', 60)}
            ${th('Latest Note', 280)}
            ${th('# Calls', 60)}
            ${th('Latest Call Summary', 240)}
            ${th('Last Activity', 90)}
            ${showMatch ? th('→ Matched Ace Contact', 160) : ''}
            ${showMatch ? th('→ Matched On', 140) : ''}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r,i)=>{
            const bg = i%2 ? '#f8fafc' : '#fff';
            const typeColor = r.fub_type==='Buyer' ? {bg:'#dbeafe',fg:'#1e40af'} : r.fub_type==='Seller' ? {bg:'#fef3c7',fg:'#b45309'} : {bg:'#f1f5f9',fg:'#475569'};
            // Compute last activity = max(latest_note_date, latest_call_date)
            const lastActivity = [r.latest_note_date, r.latest_call_date].filter(Boolean).sort().reverse()[0];
            return `
            <tr onclick="_fubShowContactReview(${r.fub_contact_id})" style="background:${bg};border-bottom:1px solid #f1f5f9;cursor:pointer;" onmouseenter="this.style.background='#eef2fb';Array.from(this.querySelectorAll('td')).forEach(td=>{if(td.dataset.sticky==='1')td.style.background='#eef2fb'});" onmouseleave="this.style.background='${bg}';Array.from(this.querySelectorAll('td')).forEach(td=>{if(td.dataset.sticky==='1')td.style.background='${bg}'});">
              <td data-sticky="1" style="padding:6px 8px;font-weight:600;color:#0f172a;position:sticky;left:0;background:${bg};border-right:1px solid #e2e8f0;z-index:1;">${esc(r.fub_name)}</td>
              <td style="padding:6px 8px;"><span style="background:${typeColor.bg};color:${typeColor.fg};padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;white-space:nowrap;">${esc(r.fub_type||'—')}</span></td>
              <td style="padding:6px 8px;color:#475569;font-size:10px;white-space:nowrap;">${esc(r.fub_stage||'—')}</td>
              <td style="padding:6px 8px;color:#334155;font-family:monospace;font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(r.fub_all_phones)}">${esc(r.fub_primary_phone)||'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#334155;font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(r.fub_all_emails)}">${esc(r.fub_primary_email)||'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#64748b;font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(r.fub_address)}">${esc(r.fub_address)||'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#64748b;font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(r.fub_tags)}">${esc(r.fub_tags)||'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#64748b;font-size:10px;white-space:nowrap;">${esc(r.fub_source)||'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#78350f;font-size:10px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escAttr(r.fub_deal_name)}">${r.fub_has_deal?esc(r.fub_deal_name):'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#475569;font-size:10px;white-space:nowrap;">${esc(r.fub_deal_stage)||'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#059669;font-weight:600;font-size:10px;white-space:nowrap;">${r.fub_deal_price?'$'+Number(r.fub_deal_price).toLocaleString():'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;text-align:center;font-weight:600;color:${r.note_count>0?'#059669':'#cbd5e1'};">${r.note_count||0}</td>
              <td style="padding:6px 8px;color:#334155;font-size:10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;" title="${escAttr(r.latest_note_preview)}">${r.latest_note_preview ? esc(truncate(r.latest_note_preview, 90)) : '<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;text-align:center;font-weight:600;color:${r.call_count>0?'#059669':'#cbd5e1'};">${r.call_count||0}</td>
              <td style="padding:6px 8px;color:#334155;font-size:10px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;" title="${escAttr(r.latest_call_summary)}">${r.latest_call_summary ? esc(truncate(r.latest_call_summary, 80)) : '<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:6px 8px;color:#64748b;font-size:10px;white-space:nowrap;">${fmtDate(lastActivity)||'<span style="color:#cbd5e1;">—</span>'}</td>
              ${showMatch ? `<td style="padding:6px 8px;font-weight:600;color:#0f172a;font-size:10px;white-space:nowrap;">${esc(r.matched_ace_name)||'—'}</td>` : ''}
              ${showMatch ? `<td style="padding:6px 8px;color:#64748b;font-family:monospace;font-size:10px;white-space:nowrap;">${esc(r.matched_on)||'—'}</td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  if(footer){
    if(lastPageFull){
      footer.innerHTML = `
        <div style="font-size:11px;color:#64748b;">Click <strong>Load more</strong> to fetch the next ${_FUB_PAGE_SIZE.toLocaleString()} rows.</div>
        <button onclick="_fubDetailLoadMore()" style="background:#2563eb;color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Load more (+${_FUB_PAGE_SIZE})</button>
      `;
    } else {
      footer.innerHTML = `<div style="font-size:11px;color:#64748b;">End of list — ${rows.length.toLocaleString()} total.</div>`;
    }
  }
}

export async function _fubDetailLoadMore(){
  _fubDetailOffset += _FUB_PAGE_SIZE;
  await _fubDetailLoadPage(false);
}

// v108.2: per-contact import preview modal. Shows EVERYTHING linked to
// one FUB contact — all phones, emails, addresses, notes, calls, deal
// info — plus a clear "what will be imported to your CRM" breakdown.
export async function _fubShowContactReview(fubId){
  // Build + show the modal shell immediately
  const existing = document.getElementById('fubReviewOverlay');
  if(existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'fubReviewOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:9200;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;width:1100px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;font-family:'Inter',system-ui,sans-serif;box-shadow:0 20px 70px rgba(0,0,0,0.3);">
      <div style="background:linear-gradient(135deg,#0f172a,#1e3a8a);color:#fff;padding:16px 22px;display:flex;align-items:center;gap:14px;border-radius:14px 14px 0 0;flex-shrink:0;">
        <div style="font-size:20px;">📥</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;">FUB Contact Review</div>
          <div style="font-size:11px;color:#93c5fd;margin-top:1px;">Everything linked to this FUB record + what would be imported</div>
        </div>
        <button onclick="document.getElementById('fubReviewOverlay').remove()" style="background:rgba(255,255,255,0.1);border:none;color:#fff;cursor:pointer;font-size:18px;width:30px;height:30px;border-radius:6px;">×</button>
      </div>
      <div id="fubReviewBody" style="flex:1;overflow-y:auto;padding:20px 22px;background:#f8fafc;">
        <div style="text-align:center;padding:40px;color:#64748b;font-size:12px;">⏳ Loading full record…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  try{
    // Fetch everything in parallel
    const [contactArr, notes, calls, analysis] = await Promise.all([
      _sbGet('fub_contacts', `select=*&id=eq.${fubId}&limit=1`),
      _sbGet('fub_notes', `select=id,subject,body,created_by,created_at&person_id=eq.${fubId}&order=created_at.desc&limit=50`),
      _sbGet('fub_calls', `select=id,direction,duration,outcome,note,summary,transcription,created_at,phone&person_id=eq.${fubId}&order=created_at.desc&limit=50`),
      _sbGet('ace_fub_import_analysis', `select=*&fub_contact_id=eq.${fubId}&limit=1`)
    ]);
    const fub = (Array.isArray(contactArr) && contactArr[0]) || null;
    const meta = (Array.isArray(analysis) && analysis[0]) || null;
    if(!fub){
      document.getElementById('fubReviewBody').innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;">Contact not found.</div>';
      return;
    }
    _fubRenderContactReview(fub, notes||[], calls||[], meta);
  }catch(e){
    const b = document.getElementById('fubReviewBody');
    if(b) b.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;">Error loading: '+(e.message||'unknown')+'</div>';
  }
}

export function _fubRenderContactReview(fub, notes, calls, meta){
  const body = document.getElementById('fubReviewBody');
  if(!body) return;
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',year:'2-digit',hour:'numeric',minute:'2-digit'}) : '—';
  const fmtDuration = s => { if(!s) return '—'; const m = Math.floor(s/60); const sec = s%60; return m+':'+String(sec).padStart(2,'0'); };

  // Parse phones/emails/addresses JSONB
  const phones = Array.isArray(fub.phones) ? fub.phones : [];
  const emails = Array.isArray(fub.emails) ? fub.emails : [];
  const addresses = Array.isArray(fub.addresses) ? fub.addresses : [];
  const tags = Array.isArray(fub.tags) ? fub.tags : [];

  // Determine import action based on match status
  const status = meta?.match_status || 'unknown';
  const actionCard = (() => {
    if(status === 'new'){
      return {
        bg: '#dbeafe', border: '#93c5fd', icon: '🆕', color: '#1e40af',
        title: 'NEW — will be imported',
        desc: 'No matching contact found by phone or email. This contact + their deal (if any) would be created fresh in your CRM.'
      };
    }
    if(status === 'matched_phone' || status === 'matched_email'){
      return {
        bg: '#dcfce7', border: '#86efac', icon: '✅', color: '#15803d',
        title: 'ALREADY IN CRM — will be skipped',
        desc: `Matched to existing CRM contact "<strong>${esc(meta.matched_ace_name)}</strong>" via ${status === 'matched_phone' ? 'phone' : 'email'} ("<code>${esc(meta.matched_on)}</code>"). Import would skip this row. You can manually review if you think it's a different person.`
      };
    }
    if(status === 'matched_name_only'){
      return {
        bg: '#fef3c7', border: '#fde68a', icon: '⚠️', color: '#b45309',
        title: 'NAME-ONLY MATCH — needs review',
        desc: `Name matches existing CRM contact "<strong>${esc(meta.matched_ace_name)}</strong>" but phone and email don't overlap. This could be a duplicate (same person, different contact info over time) or a false positive (different people with same name). Ship 2 will give you a per-row Import / Skip / Merge choice.`
      };
    }
    return { bg:'#f1f5f9', border:'#cbd5e1', icon:'❓', color:'#64748b', title:'UNKNOWN', desc:'No analysis data for this contact.' };
  })();

  body.innerHTML = `
    <!-- IMPORT ACTION BANNER -->
    <div style="background:${actionCard.bg};border:1px solid ${actionCard.border};border-radius:10px;padding:14px 18px;margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div style="font-size:20px;">${actionCard.icon}</div>
        <div style="font-size:13px;font-weight:700;color:${actionCard.color};">${actionCard.title}</div>
      </div>
      <div style="font-size:12px;color:#1f2937;line-height:1.6;">${actionCard.desc}</div>
    </div>

    <!-- LAYOUT: left = FUB source, right = what would be imported -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">

      <!-- LEFT COLUMN: FUB SOURCE DATA -->
      <div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">📂 FUB Source Data</div>

        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
          <div style="font-size:15px;font-weight:700;color:#0f172a;">${esc(fub.name || (fub.first_name + ' ' + (fub.last_name||'')).trim() || '(unnamed)')}</div>
          <div style="font-size:11px;color:#64748b;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;">
            ${fub.type ? `<span>Type: <strong>${esc(fub.type)}</strong></span>` : ''}
            ${fub.stage ? `<span>Stage: <strong>${esc(fub.stage)}</strong></span>` : ''}
            ${fub.source ? `<span>Source: <strong>${esc(fub.source)}</strong></span>` : ''}
            ${fub.assigned_to ? `<span>Agent: <strong>${esc(fub.assigned_to)}</strong></span>` : ''}
          </div>
          ${tags.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">${tags.map(t=>`<span style="background:#e0e7ff;color:#3730a3;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;">${esc(t)}</span>`).join('')}</div>` : ''}
          <div style="font-size:10px;color:#94a3b8;margin-top:10px;">FUB ID: ${fub.id} · Created ${fmtDate(fub.created_at)} · Last activity ${fmtDate(fub.last_activity)}</div>
        </div>

        ${phones.length ? `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px;">📞 Phones (${phones.length})</div>
          ${phones.map(p => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;">
              <span style="font-family:monospace;color:#0f172a;">${esc(p.value)}</span>
              <span style="font-size:10px;color:#94a3b8;">${esc(p.type||'')}${p.isPrimary ? ' · <strong style="color:#16a34a;">primary</strong>' : ''}</span>
            </div>`).join('')}
        </div>` : ''}

        ${emails.length ? `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px;">✉️ Emails (${emails.length})</div>
          ${emails.map(e => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;">
              <span style="color:#0f172a;word-break:break-all;">${esc(e.value)}</span>
              <span style="font-size:10px;color:#94a3b8;flex-shrink:0;margin-left:8px;">${esc(e.type||'')}${e.isPrimary ? ' · <strong style="color:#16a34a;">primary</strong>' : ''}</span>
            </div>`).join('')}
        </div>` : ''}

        ${addresses.length ? `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px;">📍 Addresses (${addresses.length})</div>
          ${addresses.map(a => `
            <div style="padding:3px 0;font-size:12px;color:#0f172a;">
              ${[a.street, a.city, a.state, a.code].filter(Boolean).map(esc).join(', ') || '<span style="color:#94a3b8;">(empty)</span>'}
              ${a.type ? `<span style="font-size:10px;color:#94a3b8;margin-left:6px;">(${esc(a.type)})</span>` : ''}
            </div>`).join('')}
        </div>` : ''}

        ${fub.deal_name ? `
        <div style="background:#fef9c3;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:11px;font-weight:700;color:#78350f;margin-bottom:6px;">🏢 Deal</div>
          <div style="font-size:12px;color:#0f172a;font-weight:600;">${esc(fub.deal_name)}</div>
          <div style="font-size:11px;color:#64748b;margin-top:4px;">
            ${fub.deal_stage ? `Stage: <strong>${esc(fub.deal_stage)}</strong>` : ''}
            ${fub.deal_price ? ` · Price: <strong>$${Number(fub.deal_price).toLocaleString()}</strong>` : ''}
          </div>
        </div>` : ''}

        <!-- NOTES -->
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:8px;">📝 Notes (${notes.length}${notes.length >= 50 ? '+ showing latest 50' : ''})</div>
          ${notes.length === 0 ? '<div style="font-size:11px;color:#94a3b8;font-style:italic;">No notes.</div>' :
            notes.map(n => {
              const isJunk = (n.subject === 'HLApps Note' || (n.body||'').startsWith('Follow Up Boss Contact created'));
              return `
              <div style="padding:8px 10px;background:${isJunk?'#f8fafc':'#fffbeb'};border:1px solid ${isJunk?'#e2e8f0':'#fde68a'};border-radius:6px;margin-bottom:6px;font-size:11px;">
                <div style="display:flex;justify-content:space-between;color:#64748b;font-size:10px;margin-bottom:3px;">
                  <span>${esc(n.created_by || 'Unknown')}</span>
                  <span>${fmtDateTime(n.created_at)}</span>
                </div>
                ${n.subject ? `<div style="font-weight:600;color:#0f172a;margin-bottom:3px;">${esc(n.subject)}</div>` : ''}
                <div style="color:#334155;white-space:pre-wrap;line-height:1.5;max-height:150px;overflow-y:auto;">${esc(n.body || '')}</div>
                ${isJunk ? '<div style="font-size:9px;color:#94a3b8;margin-top:4px;font-style:italic;">⚠ Automated/junk note — will be filtered during import</div>' : ''}
              </div>`;
            }).join('')
          }
        </div>

        <!-- CALLS -->
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:8px;">📞 Calls (${calls.length}${calls.length >= 50 ? '+ showing latest 50' : ''})</div>
          ${calls.length === 0 ? '<div style="font-size:11px;color:#94a3b8;font-style:italic;">No calls.</div>' :
            calls.map(c => `
              <div style="padding:8px 10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;margin-bottom:6px;font-size:11px;">
                <div style="display:flex;justify-content:space-between;color:#64748b;font-size:10px;margin-bottom:3px;">
                  <span>${c.direction === 'inbound' ? '📥' : c.direction === 'outbound' ? '📤' : '📞'} ${esc(c.phone||'')} · ${fmtDuration(c.duration)} · ${esc(c.outcome||'—')}</span>
                  <span>${fmtDateTime(c.created_at)}</span>
                </div>
                ${c.summary ? `<div style="color:#0f172a;margin-top:4px;line-height:1.5;"><strong>Summary:</strong> ${esc(c.summary)}</div>` : ''}
                ${c.note ? `<div style="color:#334155;margin-top:3px;line-height:1.5;"><strong>Note:</strong> ${esc(c.note)}</div>` : ''}
                ${c.transcription ? `<details style="margin-top:4px;"><summary style="cursor:pointer;color:#2563eb;font-size:10px;">View transcription</summary><div style="color:#64748b;margin-top:4px;white-space:pre-wrap;font-size:10px;line-height:1.5;max-height:200px;overflow-y:auto;">${esc(c.transcription)}</div></details>` : ''}
              </div>`).join('')
          }
        </div>
      </div>

      <!-- RIGHT COLUMN: WHAT GETS IMPORTED -->
      <div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">✨ Would Import to CRM</div>

        ${status === 'new' ? `
          <!-- CONTACT -->
          <div style="background:#fff;border:2px solid #2563eb;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
            <div style="font-size:11px;font-weight:700;color:#1e40af;margin-bottom:8px;">👤 ace_contacts (new row)</div>
            ${_fubImportContactPreview(fub)}
          </div>

          ${fub.deal_name ? `
          <!-- PROPERTY -->
          <div style="background:#fff;border:2px solid #2563eb;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
            <div style="font-size:11px;font-weight:700;color:#1e40af;margin-bottom:8px;">🏢 ace_properties (new row)</div>
            ${_fubImportPropertyPreview(fub)}
          </div>` : `
          <div style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:14px 16px;margin-bottom:12px;font-size:11px;color:#64748b;font-style:italic;">
            No deal attached to this FUB contact — no property will be created.
          </div>`}

          ${fub.type === 'Buyer' ? `
          <!-- BUYER CRITERIA (Ship 3) -->
          <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
            <div style="font-size:11px;font-weight:700;color:#15803d;margin-bottom:6px;">🎯 ace_buyer_criteria (Ship 3 — AI enrichment)</div>
            <div style="font-size:11px;color:#166534;line-height:1.6;">
              Since this is a Buyer with ${notes.length + calls.length} notes/calls attached, Ship 3 will run Claude Haiku over the notes + call transcripts to extract:
              <ul style="margin:6px 0 0 0;padding-left:20px;">
                <li>Desired asset types (e.g. multifamily, warehouse)</li>
                <li>Price range (min/max)</li>
                <li>Preferred counties/areas</li>
                <li>Financing type</li>
                <li>Minimum cap rate, unit counts, SF ranges</li>
              </ul>
              <div style="margin-top:6px;font-size:10px;color:#15803d;">Cost estimate: ~\$${(0.0005 * Math.min(notes.length+calls.length, 30)).toFixed(4)} per contact at Haiku pricing.</div>
            </div>
          </div>` : ''}
        ` : status === 'matched_phone' || status === 'matched_email' ? `
          <div style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:20px;font-size:12px;color:#64748b;text-align:center;">
            <div style="font-size:24px;margin-bottom:8px;">⏭️</div>
            <div style="font-weight:600;color:#0f172a;margin-bottom:4px;">Skipped — already in CRM</div>
            <div style="font-size:11px;">Matched to <strong>${esc(meta.matched_ace_name)}</strong>.<br>No new contact will be created.</div>
            <div style="font-size:10px;color:#94a3b8;margin-top:12px;font-style:italic;">Ship 3 could still enrich the existing contact with info from these ${notes.length + calls.length} notes/calls if you want — we'll make that optional.</div>
          </div>
        ` : `
          <div style="background:#fffbeb;border:2px solid #fde68a;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
            <div style="font-size:11px;font-weight:700;color:#b45309;margin-bottom:6px;">⚠️ Needs your decision (Ship 2)</div>
            <div style="font-size:11px;color:#78350f;line-height:1.6;">
              Ship 2 will give you 3 buttons for this row:
              <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">
                <div>🆕 <strong>Import as new</strong> — create a separate CRM contact</div>
                <div>🔗 <strong>Merge into existing</strong> — add this FUB data to "${esc(meta.matched_ace_name)}"</div>
                <div>⏭️ <strong>Skip</strong> — don't import at all</div>
              </div>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

export function _fubImportContactPreview(fub){
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const phones = Array.isArray(fub.phones) ? fub.phones : [];
  const emails = Array.isArray(fub.emails) ? fub.emails : [];
  const primaryPhone = phones.find(p => p.isPrimary) || phones[0];
  const secondaryPhone = phones.find(p => p !== primaryPhone);
  const primaryEmail = emails.find(e => e.isPrimary) || emails[0];
  const secondaryEmail = emails.find(e => e !== primaryEmail);
  const fieldRow = (lbl, val) => val ? `<div style="display:flex;gap:8px;padding:3px 0;font-size:11px;"><span style="color:#64748b;min-width:110px;">${lbl}</span><span style="color:#0f172a;font-weight:500;">${esc(val)}</span></div>` : '';
  return `
    ${fieldRow('name', fub.name || (fub.first_name + ' ' + (fub.last_name||'')).trim())}
    ${fieldRow('phone_number', primaryPhone?.normalized || primaryPhone?.value)}
    ${fieldRow('secondary_phone', secondaryPhone?.normalized || secondaryPhone?.value)}
    ${fieldRow('email', primaryEmail?.value)}
    ${fieldRow('secondary_email', secondaryEmail?.value)}
    ${fieldRow('type', '[' + (fub.type || 'Other') + ']')}
    ${fieldRow('import_source', 'FUB')}
    ${fieldRow('fub_contact_id', fub.id)}
    ${fieldRow('date_added', (fub.created_at||'').split('T')[0])}
  `;
}

export function _fubImportPropertyPreview(fub){
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const addresses = Array.isArray(fub.addresses) ? fub.addresses : [];
  const addr = addresses[0] || {};
  const fieldRow = (lbl, val) => val ? `<div style="display:flex;gap:8px;padding:3px 0;font-size:11px;"><span style="color:#64748b;min-width:110px;">${lbl}</span><span style="color:#0f172a;font-weight:500;">${esc(val)}</span></div>` : '';
  return `
    ${fieldRow('address', fub.deal_name || '(from deal_name)')}
    ${fieldRow('municipality', addr.city)}
    ${fieldRow('state', addr.state || 'NJ')}
    ${fieldRow('pipeline_stage', fub.deal_stage || 'New Lead')}
    ${fieldRow('asking_price', fub.deal_price ? '$' + Number(fub.deal_price).toLocaleString() : '')}
    ${fieldRow('owner_contact_id', '→ linked to new ace_contacts row')}
    ${fieldRow('import_source', 'FUB')}
    ${fieldRow('fub_deal_reference', fub.deal_name || '(none)')}
  `;
}

// ─── v111.9: FUB Pipeline Stage Sync ─────────────────────────────
// Reads FUB deal stages via Edge Function `fub-stages-sync` and updates
// matching ace_properties rows. Runs in ~300-deal chunks to stay under
// the 150s Edge timeout. One-time sync, not scheduled.

const _FUB_SYNC_URL = 'https://kxtuegjptvzqycgyzehj.functions.supabase.co/fub-stages-sync';

// Module-level state for an in-flight sync driven by the UI.
let _fubSyncState = { running:false, aborted:false, syncLogId:null, nextCursor:null, chunks:0, dryRun:true };

export function _fubSyncOpen(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  main.innerHTML = `
    <div style="padding:16px 22px;max-width:1100px;margin:0 auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div style="font-size:20px;font-weight:700;color:#0f172a;">🔄 FUB Pipeline Stage Sync</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px;">Read-only pull from Follow Up Boss. Updates pipeline_stage on matching ace_properties. Does not create new properties or contacts.</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button onclick="setNav(null,'settings')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Back to Settings</button>
        </div>
      </div>

      <!-- Action card -->
      <section style="background:#fff;border-radius:10px;padding:22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:6px;">Run a sync</div>
        <div style="font-size:12px;color:#64748b;line-height:1.55;margin-bottom:14px;">
          A full sync takes about 15–20 minutes because it walks ~10,000 deals in chunks of 300. You can close this tab — but do not start another sync while one is in progress. Progress is persisted in <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;">ace_fub_sync_log</code>.
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <button id="fubSyncDryBtn" onclick="_fubSyncStart(true)" style="background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1;padding:10px 18px;font-size:13px;font-weight:600;border-radius:8px;cursor:pointer;">🔍 Preview (dry run)</button>
          <button id="fubSyncRealBtn" onclick="_fubSyncConfirmReal()" style="background:#0284c7;color:#fff;border:none;padding:10px 18px;font-size:13px;font-weight:600;border-radius:8px;cursor:pointer;">▶ Run sync (writes to DB)</button>
          <button id="fubSyncStopBtn" onclick="_fubSyncAbort()" style="display:none;background:#fee2e2;color:#991b1b;border:1px solid #fecaca;padding:10px 18px;font-size:13px;font-weight:600;border-radius:8px;cursor:pointer;">■ Stop after current chunk</button>
          <div id="fubSyncStatus" style="margin-left:auto;font-size:12px;color:#64748b;"></div>
        </div>
      </section>

      <!-- Progress card (hidden until a run starts) -->
      <section id="fubSyncProgressCard" style="display:none;background:#fff;border-radius:10px;padding:22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:12px;">Current run</div>
        <div id="fubSyncProgressBody"></div>
      </section>

      <!-- History card -->
      <section style="background:#fff;border-radius:10px;padding:22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:15px;font-weight:700;color:#0f172a;">Sync history</div>
          <button onclick="_fubSyncLoadHistory()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:6px 12px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">↻ Refresh</button>
        </div>
        <div id="fubSyncHistoryBody"><div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px;">Loading...</div></div>
      </section>
    </div>`;
  _fubSyncLoadHistory();
}

export async function _fubSyncLoadHistory(){
  const body = document.getElementById('fubSyncHistoryBody');
  if(!body) return;
  try{
    const rows = await _sbGet('ace_fub_sync_log',
      'select=id,started_at,ended_at,status,dry_run,total_processed,total_matched,total_stage_updated,total_unmatched,total_archived,triggered_by_name&order=started_at.desc&limit=10');
    if(!Array.isArray(rows) || rows.length === 0){
      body.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px;">No sync runs yet.</div>';
      return;
    }
    const fmt = (s) => {
      if(!s) return '—';
      const d = new Date(s);
      return d.toLocaleString('en-US',{ month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    };
    const statusBadge = (st) => {
      const colors = { completed:['#dcfce7','#166534'], running:['#fef3c7','#92400e'], failed:['#fee2e2','#991b1b'], cancelled:['#f1f5f9','#64748b'], partial:['#e0f2fe','#075985'] };
      const [bg, fg] = colors[st] || ['#f1f5f9','#64748b'];
      return `<span style="display:inline-block;background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${st || '?'}</span>`;
    };
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="border-bottom:2px solid #e2e8f0;text-align:left;color:#64748b;">
            <th style="padding:8px 6px;font-weight:700;">Started</th>
            <th style="padding:8px 6px;font-weight:700;">Mode</th>
            <th style="padding:8px 6px;font-weight:700;">Status</th>
            <th style="padding:8px 6px;font-weight:700;text-align:right;">Processed</th>
            <th style="padding:8px 6px;font-weight:700;text-align:right;">Matched</th>
            <th style="padding:8px 6px;font-weight:700;text-align:right;">Stage updates</th>
            <th style="padding:8px 6px;font-weight:700;text-align:right;">Unmatched</th>
            <th style="padding:8px 6px;font-weight:700;">By</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:8px 6px;color:#0f172a;">${fmt(r.started_at)}</td>
              <td style="padding:8px 6px;"><span style="display:inline-block;background:${r.dry_run?'#f1f5f9':'#fef3c7'};color:${r.dry_run?'#475569':'#92400e'};padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;">${r.dry_run?'DRY':'LIVE'}</span></td>
              <td style="padding:8px 6px;">${statusBadge(r.status)}</td>
              <td style="padding:8px 6px;text-align:right;color:#0f172a;font-variant-numeric:tabular-nums;">${(r.total_processed||0).toLocaleString()}</td>
              <td style="padding:8px 6px;text-align:right;color:#0f172a;font-variant-numeric:tabular-nums;">${(r.total_matched||0).toLocaleString()}</td>
              <td style="padding:8px 6px;text-align:right;color:#16a34a;font-variant-numeric:tabular-nums;font-weight:600;">${(r.total_stage_updated||0).toLocaleString()}</td>
              <td style="padding:8px 6px;text-align:right;color:#64748b;font-variant-numeric:tabular-nums;">${(r.total_unmatched||0).toLocaleString()}</td>
              <td style="padding:8px 6px;color:#64748b;">${esc(r.triggered_by_name) || '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch(e){
    body.innerHTML = `<div style="padding:14px;color:#991b1b;font-size:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;">Failed to load history: ${e.message}</div>`;
  }
}

export function _fubSyncConfirmReal(){
  if(!confirm('Run a LIVE sync? This will update pipeline_stage on matching ace_properties based on the current FUB deal stages. Takes ~15–20 minutes. Continue?')) return;
  _fubSyncStart(false);
}

export async function _fubSyncStart(dryRun){
  if(_fubSyncState.running){ alert('A sync is already in progress in this session.'); return; }
  // Check server-side for a concurrent run too
  try{
    const inProg = await _sbGet('ace_fub_sync_log', 'select=id,started_at,triggered_by_name&ended_at=is.null&limit=1');
    if(Array.isArray(inProg) && inProg.length > 0){
      if(!confirm(`Another sync looks like it's already running (started ${new Date(inProg[0].started_at).toLocaleTimeString()} by ${inProg[0].triggered_by_name || 'unknown'}). Proceed anyway? The Edge Function will reject concurrent starts, so this should be safe.`)) return;
    }
  } catch(_){}

  _fubSyncState = { running:true, aborted:false, syncLogId:null, nextCursor:null, chunks:0, dryRun };
  const card = document.getElementById('fubSyncProgressCard');
  const body = document.getElementById('fubSyncProgressBody');
  const stopBtn = document.getElementById('fubSyncStopBtn');
  const dryBtn = document.getElementById('fubSyncDryBtn');
  const realBtn = document.getElementById('fubSyncRealBtn');
  if(card) card.style.display = '';
  if(stopBtn) stopBtn.style.display = '';
  if(dryBtn) dryBtn.disabled = true;
  if(realBtn) realBtn.disabled = true;
  _fubSyncRenderProgress({ chunk:0, status:'starting...', dryRun });

  const triggeredBy = (window._currentUser && window._currentUser.fub_name) ? window._currentUser.fub_name : 'CRM User';
  let done = false;
  let lastData = null;
  try{
    while(!done && !_fubSyncState.aborted){
      const payload = {
        dry_run: dryRun,
        auto_create_contacts: false,
        chunk_size: 300,
        triggered_by: { name: triggeredBy + (dryRun ? ' (preview)' : '') }
      };
      if(_fubSyncState.syncLogId) payload.sync_log_id = _fubSyncState.syncLogId;
      if(_fubSyncState.nextCursor) payload.starting_cursor = _fubSyncState.nextCursor;

      const res = await fetch(_FUB_SYNC_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if(data.error){
        _fubSyncRenderProgress({ chunk: _fubSyncState.chunks, status:'error', error: data.error, dryRun });
        break;
      }
      lastData = data;
      _fubSyncState.syncLogId = data.sync_log_id || _fubSyncState.syncLogId;
      _fubSyncState.nextCursor = data.next_cursor || null;
      _fubSyncState.chunks += 1;
      done = !!data.done;
      _fubSyncRenderProgress({ chunk: _fubSyncState.chunks, status: done ? 'complete' : 'running', data, dryRun });
      // Small delay between chunks to be polite to Edge Function + FUB API
      if(!done && !_fubSyncState.aborted) await new Promise(r => setTimeout(r, 800));
    }
    if(_fubSyncState.aborted){
      _fubSyncRenderProgress({ chunk: _fubSyncState.chunks, status:'stopped', data: lastData, dryRun });
    }
  } catch(e){
    _fubSyncRenderProgress({ chunk: _fubSyncState.chunks, status:'error', error: e.message, dryRun });
  } finally{
    _fubSyncState.running = false;
    if(stopBtn) stopBtn.style.display = 'none';
    if(dryBtn) dryBtn.disabled = false;
    if(realBtn) realBtn.disabled = false;
    _fubSyncLoadHistory();
  }
}

export function _fubSyncAbort(){
  if(!_fubSyncState.running) return;
  if(!confirm('Stop the sync after the current chunk finishes? Data already written is not rolled back. The sync log row will stay open — you can close it manually via SQL if needed.')) return;
  _fubSyncState.aborted = true;
  const stopBtn = document.getElementById('fubSyncStopBtn');
  if(stopBtn){ stopBtn.textContent = '⏳ Stopping...'; stopBtn.disabled = true; }
}

export function _fubSyncRenderProgress(st){
  const body = document.getElementById('fubSyncProgressBody');
  const statusEl = document.getElementById('fubSyncStatus');
  if(!body) return;
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const d = st.data || {};
  const counterRow = (label, val, color) => `
    <div style="flex:1;min-width:120px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
      <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color || '#0f172a'};font-variant-numeric:tabular-nums;margin-top:2px;">${(val||0).toLocaleString()}</div>
    </div>`;

  let statusBlock = '';
  if(st.status === 'starting...'){
    statusBlock = `<div style="padding:12px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;color:#92400e;font-size:12px;font-weight:600;">⏳ Starting sync${st.dryRun ? ' (dry run)' : ''}...</div>`;
  } else if(st.status === 'running'){
    statusBlock = `<div style="padding:12px;background:#e0f2fe;border:1px solid #7dd3fc;border-radius:6px;color:#075985;font-size:12px;font-weight:600;">🔄 Running — chunk ${st.chunk} done. Next chunk starting...</div>`;
  } else if(st.status === 'complete'){
    statusBlock = `<div style="padding:12px;background:#dcfce7;border:1px solid #bbf7d0;border-radius:6px;color:#166534;font-size:12px;font-weight:600;">✓ Sync complete. ${st.chunk} chunks processed.${st.dryRun ? ' (This was a dry run — no changes were written.)' : ''}</div>`;
  } else if(st.status === 'stopped'){
    statusBlock = `<div style="padding:12px;background:#fee2e2;border:1px solid #fecaca;border-radius:6px;color:#991b1b;font-size:12px;font-weight:600;">■ Stopped after ${st.chunk} chunks. Run log remains open in ace_fub_sync_log.</div>`;
  } else if(st.status === 'error'){
    statusBlock = `<div style="padding:12px;background:#fee2e2;border:1px solid #fecaca;border-radius:6px;color:#991b1b;font-size:12px;font-weight:600;">✗ Error: ${esc(st.error || 'unknown')}</div>`;
  }

  let changesBlock = '';
  const changes = d.stage_change_summary || {};
  const changeEntries = Object.entries(changes).sort((a,b) => b[1] - a[1]).slice(0, 15);
  if(changeEntries.length > 0){
    changesBlock = `
      <div style="margin-top:14px;">
        <div style="font-size:12px;font-weight:700;color:#334155;margin-bottom:8px;">Top stage changes so far</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-size:11px;">
          ${changeEntries.map(([k,v]) => `
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dotted #e2e8f0;">
              <span style="color:#475569;">${esc(k)}</span>
              <span style="color:#0f172a;font-weight:700;font-variant-numeric:tabular-nums;">${v}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  let unknownBlock = '';
  const unknowns = d.unknown_fub_stages || {};
  const unkEntries = Object.entries(unknowns);
  if(unkEntries.length > 0){
    unknownBlock = `
      <div style="margin-top:14px;padding:10px 12px;background:#fefce8;border:1px solid #fde68a;border-radius:6px;font-size:11px;color:#713f12;">
        <div style="font-weight:700;margin-bottom:4px;">⚠ Unknown FUB stages encountered (logged, not applied):</div>
        <div>${unkEntries.map(([k,v]) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;background:#fef3c7;border-radius:10px;">${esc(k)} (${v})</span>`).join('')}</div>
      </div>`;
  }

  body.innerHTML = `
    ${statusBlock}
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;">
      ${counterRow('Chunks',  st.chunk || 0)}
      ${counterRow('Processed', d.total_processed)}
      ${counterRow('Matched', d.total_matched, '#0284c7')}
      ${counterRow('Stage updates', d.total_stage_updated, '#16a34a')}
      ${counterRow('Unmatched', d.total_unmatched, '#64748b')}
      ${counterRow('Archived', d.total_archived, '#a16207')}
    </div>
    ${changesBlock}
    ${unknownBlock}
  `;

  if(statusEl){
    if(st.status === 'running') statusEl.textContent = `Chunk ${st.chunk} · ${(d.total_processed||0).toLocaleString()} processed`;
    else if(st.status === 'complete') statusEl.textContent = `Done · ${(d.total_stage_updated||0).toLocaleString()} updates`;
    else if(st.status === 'stopped') statusEl.textContent = `Stopped at chunk ${st.chunk}`;
    else if(st.status === 'error') statusEl.textContent = 'Error';
  }
}

// ─── v111.9: Unmatched FUB Deals Review ──────────────────────────
// Triage the ~1,600 FUB deals that the sync couldn't auto-link. Per-row
// actions: link to existing property, mark ignored, or view resolution notes.

const _FUB_UNMATCHED_PAGE_SIZE = 50;
let _fubUmState = {
  filters: { search:'', resolution:'pending', pipeline:'all', stage:'all', lowConfOnly:false },
  page: 0,
  rows: [],
  total: 0,
  selected: new Set()
};

export function _fubUnmatchedOpen(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  _fubUmState.filters = { search:'', resolution:'pending', pipeline:'all', stage:'all', lowConfOnly:false };
  _fubUmState.page = 0;
  _fubUmState.selected = new Set();
  main.innerHTML = `
    <div style="padding:16px 22px;max-width:1400px;margin:0 auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div style="font-size:20px;font-weight:700;color:#0f172a;">🔍 Unmatched FUB Deals</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px;">Deals from Follow Up Boss that couldn't be auto-linked to an ace_property. Link or ignore to clean the queue.</div>
        </div>
        <button onclick="setNav(null,'settings')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Back to Settings</button>
      </div>

      <!-- Stats strip -->
      <div id="fubUmStats" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;"></div>

      <!-- Filters -->
      <section style="background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <input id="fubUmSearch" type="text" placeholder="Search deal name or contact..." oninput="_fubUmDebouncedRefresh()" style="flex:1;min-width:220px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
          <select id="fubUmResolution" onchange="_fubUmSetFilter('resolution',this.value)" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:#fff;">
            <option value="pending">Pending only</option>
            <option value="ignored">Ignored only</option>
            <option value="linked">Linked only</option>
            <option value="all">All statuses</option>
          </select>
          <select id="fubUmPipeline" onchange="_fubUmSetFilter('pipeline',this.value)" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:#fff;">
            <option value="all">All pipelines</option>
            <option value="Sellers">Sellers</option>
            <option value="Sellers KW - NOT ACE">Sellers KW - NOT ACE</option>
            <option value="Biz Deals">Biz Deals</option>
          </select>
          <select id="fubUmStage" onchange="_fubUmSetFilter('stage',this.value)" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:#fff;">
            <option value="all">All stages</option>
            <option value="Hot Active Listing">Hot Active Listing</option>
            <option value="Active Listing">Active Listing</option>
            <option value="Market Price Active">Market Price Active</option>
            <option value="Needs Offer">Needs Offer</option>
            <option value="Nurture">Nurture</option>
            <option value="Lead">Lead</option>
            <option value="Attempted Contact">Attempted Contact</option>
            <option value="Top G Review">Top G Review</option>
            <option value="GHL">GHL</option>
            <option value="In Negotiations">In Negotiations</option>
            <option value="Under Contract">Under Contract</option>
            <option value="Closed">Closed</option>
            <option value="Lease Listing">Lease Listing</option>
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#475569;cursor:pointer;">
            <input id="fubUmLowConf" type="checkbox" onchange="_fubUmSetFilter('lowConfOnly',this.checked)">
            Low confidence only
          </label>
        </div>
        <div id="fubUmBulkBar" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;">
          <span id="fubUmSelCount" style="font-size:12px;color:#0f172a;font-weight:600;margin-right:12px;"></span>
          <button onclick="_fubUmBulkResolve('ignored')" style="background:#f59e0b;color:#fff;border:none;padding:6px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;margin-right:6px;">Mark ignored</button>
          <button onclick="_fubUmBulkResolve('pending')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:6px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;margin-right:6px;">Unmark</button>
          <button onclick="_fubUmClearSelection()" style="background:transparent;color:#64748b;border:none;font-size:11px;font-weight:600;cursor:pointer;">Clear selection</button>
        </div>
      </section>

      <!-- Table -->
      <section style="background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;overflow:hidden;">
        <div id="fubUmTableBody" style="max-height:calc(100vh - 340px);overflow-y:auto;"><div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">Loading...</div></div>
        <div id="fubUmPager" style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:12px;color:#475569;"></div>
      </section>
    </div>

    <!-- Link-to-property modal (hidden by default) -->
    <div id="fubUmLinkModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.6);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:10px;width:90%;max-width:640px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:15px;font-weight:700;color:#0f172a;">Link FUB deal to existing property</div>
          <button onclick="_fubUmCloseLinkModal()" style="background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;">×</button>
        </div>
        <div id="fubUmLinkModalBody" style="padding:16px 20px;overflow-y:auto;flex:1;"></div>
      </div>
    </div>`;
  _fubUmLoadData();
}

let _fubUmSearchTimer = null;
export function _fubUmDebouncedRefresh(){
  if(_fubUmSearchTimer) clearTimeout(_fubUmSearchTimer);
  _fubUmSearchTimer = setTimeout(() => {
    const el = document.getElementById('fubUmSearch');
    _fubUmState.filters.search = el ? el.value.trim() : '';
    _fubUmState.page = 0;
    _fubUmLoadData();
  }, 300);
}

export function _fubUmSetFilter(key, val){
  _fubUmState.filters[key] = val;
  _fubUmState.page = 0;
  _fubUmLoadData();
}

export async function _fubUmLoadData(){
  const body = document.getElementById('fubUmTableBody');
  if(!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">Loading...</div>';

  // Build query params for ace_fub_unmatched_deals
  const f = _fubUmState.filters;
  const parts = ['select=*', `order=last_seen_at.desc`, `limit=${_FUB_UNMATCHED_PAGE_SIZE}`, `offset=${_fubUmState.page * _FUB_UNMATCHED_PAGE_SIZE}`];
  if(f.resolution !== 'all') parts.push(`resolution=eq.${encodeURIComponent(f.resolution)}`);
  if(f.pipeline !== 'all') parts.push(`fub_pipeline_name=eq.${encodeURIComponent(f.pipeline)}`);
  if(f.stage !== 'all') parts.push(`fub_stage_name=eq.${encodeURIComponent(f.stage)}`);
  if(f.lowConfOnly) parts.push(`resolution_notes=ilike.low_confidence*`);
  if(f.search){
    const s = encodeURIComponent('%' + f.search + '%');
    parts.push(`or=(fub_deal_name.ilike.${s},fub_contact_name.ilike.${s})`);
  }

  try{
    const rows = await _sbGet('ace_fub_unmatched_deals', parts.join('&'));
    _fubUmState.rows = Array.isArray(rows) ? rows : [];
    // Only refresh aggregate counts on the first page load of a filter change,
    // not on every Next/Prev page click (expensive ~1600-row scan).
    if(_fubUmState.page === 0 || !_fubUmState.counts){
      await _fubUmLoadCounts();
    }
    _fubUmRender();
  }catch(e){
    body.innerHTML = `<div style="padding:24px;color:#991b1b;background:#fef2f2;margin:12px;border:1px solid #fecaca;border-radius:6px;font-size:12px;">Failed to load: ${e.message}</div>`;
  }
}

export async function _fubUmLoadCounts(){
  // Fetch aggregate counts for the stats strip via an aggregate RPC.
  // Server-side aggregation avoids the 1,000-row PostgREST limit.
  _fubUmState.counts = { pending:0, ignored:0, linked:0, hotActive:0, lowConf:0, total:0 };
  try{
    const result = await _sbRpc('_fub_unmatched_counts');
    if(result && typeof result === 'object'){
      _fubUmState.counts = {
        pending:   result.pending   || 0,
        ignored:   result.ignored   || 0,
        linked:    result.linked    || 0,
        hotActive: result.hotActive || 0,
        lowConf:   result.lowConf   || 0,
        total:     result.total     || 0,
      };
    }
  }catch(_){ /* keep zeros */ }
}

export function _fubUmRender(){
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

  // Stats strip
  const stats = document.getElementById('fubUmStats');
  if(stats){
    const c = _fubUmState.counts || {};
    const stat = (label, val, color) => `
      <div style="flex:1;min-width:140px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;">
        <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
        <div style="font-size:20px;font-weight:700;color:${color||'#0f172a'};font-variant-numeric:tabular-nums;margin-top:2px;">${(val||0).toLocaleString()}</div>
      </div>`;
    stats.innerHTML = [
      stat('Pending', c.pending, '#d97706'),
      stat('Ignored', c.ignored, '#64748b'),
      stat('Linked', c.linked, '#16a34a'),
      stat('Hot Active (pending)', c.hotActive, '#dc2626'),
    ].join('');
  }

  const body = document.getElementById('fubUmTableBody');
  if(!body) return;
  if(_fubUmState.rows.length === 0){
    body.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">No unmatched deals match these filters.</div>';
    _fubUmUpdatePager();
    _fubUmUpdateBulkBar();
    return;
  }

  const notesBadge = (notes) => {
    if(!notes) return '';
    let bg='#f1f5f9', fg='#475569', label=notes;
    if(notes.startsWith('low_confidence')) { bg='#fef3c7'; fg='#92400e'; label='low conf'; }
    else if(notes === 'no_candidates') { bg='#f1f5f9'; fg='#64748b'; label='no cands'; }
    else if(notes.startsWith('property_already_claimed')) { bg='#e0e7ff'; fg='#3730a3'; label='dup claim'; }
    else if(notes.startsWith('fub_deal_id_conflict')) { bg='#fce7f3'; fg='#9d174d'; label='id conflict'; }
    return `<span style="display:inline-block;background:${bg};color:${fg};padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:0.3px;" title="${esc(notes)}">${esc(label)}</span>`;
  };

  const resBadge = (r) => {
    const c = r === 'pending' ? ['#fef3c7','#92400e'] : r === 'ignored' ? ['#f1f5f9','#64748b'] : r === 'linked' ? ['#dcfce7','#166534'] : ['#f1f5f9','#64748b'];
    return `<span style="display:inline-block;background:${c[0]};color:${c[1]};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;">${esc(r||'—')}</span>`;
  };

  const fmt = (s) => {
    if(!s) return '—';
    const d = new Date(s);
    return d.toLocaleDateString('en-US',{ month:'short', day:'numeric' });
  };

  const allSelected = _fubUmState.rows.every(r => _fubUmState.selected.has(r.id));
  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead style="position:sticky;top:0;background:#f8fafc;z-index:2;">
        <tr style="border-bottom:2px solid #e2e8f0;text-align:left;color:#64748b;">
          <th style="padding:10px 8px;font-weight:700;width:32px;"><input type="checkbox" ${allSelected?'checked':''} onchange="_fubUmToggleAll(this.checked)"></th>
          <th style="padding:10px 8px;font-weight:700;">Deal</th>
          <th style="padding:10px 8px;font-weight:700;">Contact</th>
          <th style="padding:10px 8px;font-weight:700;">Pipeline · Stage</th>
          <th style="padding:10px 8px;font-weight:700;">Flags</th>
          <th style="padding:10px 8px;font-weight:700;">Status</th>
          <th style="padding:10px 8px;font-weight:700;">Seen</th>
          <th style="padding:10px 8px;font-weight:700;text-align:right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${_fubUmState.rows.map(r => {
          const isSel = _fubUmState.selected.has(r.id);
          const isIgnored = r.resolution === 'ignored';
          return `
            <tr style="border-bottom:1px solid #f1f5f9;${isSel?'background:#eff6ff;':''}">
              <td style="padding:10px 8px;"><input type="checkbox" ${isSel?'checked':''} onchange="_fubUmToggleRow('${esc(r.id)}', this.checked)"></td>
              <td style="padding:10px 8px;max-width:280px;">
                <div style="font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(r.fub_deal_name)}">${esc(r.fub_deal_name)}</div>
                <div style="font-size:10px;color:#94a3b8;margin-top:2px;">FUB #${r.fub_deal_id||'?'}</div>
              </td>
              <td style="padding:10px 8px;max-width:180px;">
                <div style="color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(r.fub_contact_name)}">${esc(r.fub_contact_name||'—')}</div>
                ${r.fub_contact_id ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">FUB #${r.fub_contact_id}</div>` : ''}
              </td>
              <td style="padding:10px 8px;">
                <div style="font-size:11px;color:#64748b;">${esc(r.fub_pipeline_name||'—')}</div>
                <div style="color:#0f172a;font-weight:500;margin-top:2px;">${esc(r.fub_stage_name||'—')}</div>
              </td>
              <td style="padding:10px 8px;">${notesBadge(r.resolution_notes)}</td>
              <td style="padding:10px 8px;">${resBadge(r.resolution)}</td>
              <td style="padding:10px 8px;color:#64748b;white-space:nowrap;">${fmt(r.last_seen_at)}</td>
              <td style="padding:10px 8px;text-align:right;white-space:nowrap;">
                <button onclick="_fubUmOpenLink('${esc(r.id)}')" style="background:#0284c7;color:#fff;border:none;padding:5px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;margin-right:4px;">Link</button>
                ${isIgnored
                  ? `<button onclick="_fubUmResolveOne('${esc(r.id)}','pending')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:5px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">Unignore</button>`
                  : `<button onclick="_fubUmResolveOne('${esc(r.id)}','ignored')" style="background:#f59e0b;color:#fff;border:none;padding:5px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">Ignore</button>`}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>`;
  _fubUmUpdatePager();
  _fubUmUpdateBulkBar();
}

export function _fubUmUpdatePager(){
  const pager = document.getElementById('fubUmPager');
  if(!pager) return;
  const start = _fubUmState.page * _FUB_UNMATCHED_PAGE_SIZE + 1;
  const end = _fubUmState.page * _FUB_UNMATCHED_PAGE_SIZE + _fubUmState.rows.length;
  const hasMore = _fubUmState.rows.length >= _FUB_UNMATCHED_PAGE_SIZE;
  pager.innerHTML = `
    <div>Showing ${start.toLocaleString()}–${end.toLocaleString()}${hasMore?'+':''}</div>
    <div style="display:flex;gap:6px;">
      <button onclick="_fubUmPage(-1)" ${_fubUmState.page===0?'disabled':''} style="padding:6px 12px;border:1px solid #cbd5e1;background:${_fubUmState.page===0?'#f8fafc':'#fff'};color:${_fubUmState.page===0?'#cbd5e1':'#475569'};font-size:11px;font-weight:600;border-radius:5px;cursor:${_fubUmState.page===0?'not-allowed':'pointer'};">← Prev</button>
      <button onclick="_fubUmPage(1)" ${hasMore?'':'disabled'} style="padding:6px 12px;border:1px solid #cbd5e1;background:${hasMore?'#fff':'#f8fafc'};color:${hasMore?'#475569':'#cbd5e1'};font-size:11px;font-weight:600;border-radius:5px;cursor:${hasMore?'pointer':'not-allowed'};">Next →</button>
    </div>`;
}

export function _fubUmPage(delta){
  const np = _fubUmState.page + delta;
  if(np < 0) return;
  _fubUmState.page = np;
  _fubUmLoadData();
}

export function _fubUmToggleRow(id, checked){
  if(checked) _fubUmState.selected.add(id);
  else _fubUmState.selected.delete(id);
  _fubUmRender();
}

export function _fubUmToggleAll(checked){
  if(checked){
    _fubUmState.rows.forEach(r => _fubUmState.selected.add(r.id));
  } else {
    _fubUmState.rows.forEach(r => _fubUmState.selected.delete(r.id));
  }
  _fubUmRender();
}

export function _fubUmClearSelection(){
  _fubUmState.selected.clear();
  _fubUmRender();
}

export function _fubUmUpdateBulkBar(){
  const bar = document.getElementById('fubUmBulkBar');
  const count = document.getElementById('fubUmSelCount');
  if(!bar || !count) return;
  if(_fubUmState.selected.size === 0){ bar.style.display = 'none'; return; }
  bar.style.display = '';
  count.textContent = `${_fubUmState.selected.size} selected`;
}

export async function _fubUmResolveOne(id, newResolution){
  try{
    const patch = { resolution: newResolution, resolved_at: new Date().toISOString() };
    if(window._currentUser && window._currentUser.id) patch.resolved_by_user_id = window._currentUser.id;
    if(newResolution === 'pending'){ patch.resolved_at = null; patch.resolved_by_user_id = null; patch.resolved_property_id = null; }
    await _sbPatch('ace_fub_unmatched_deals', id, patch);
    // Update row locally
    const row = _fubUmState.rows.find(r => r.id === id);
    if(row) row.resolution = newResolution;
    if(_fubUmState.counts){
      if(newResolution === 'ignored'){ _fubUmState.counts.pending--; _fubUmState.counts.ignored++; }
      else if(newResolution === 'pending'){ _fubUmState.counts.ignored--; _fubUmState.counts.pending++; }
    }
    _fubUmRender();
  } catch(e){
    alert('Failed to update: ' + e.message);
  }
}

export async function _fubUmBulkResolve(newResolution){
  const ids = Array.from(_fubUmState.selected);
  if(ids.length === 0) return;
  if(!confirm(`${newResolution === 'ignored' ? 'Ignore' : 'Unmark'} ${ids.length} selected deals?`)) return;
  let okCount = 0, failCount = 0;
  for(const id of ids){
    try{
      const patch = { resolution: newResolution, resolved_at: new Date().toISOString() };
      if(window._currentUser && window._currentUser.id) patch.resolved_by_user_id = window._currentUser.id;
      if(newResolution === 'pending'){ patch.resolved_at = null; patch.resolved_by_user_id = null; patch.resolved_property_id = null; }
      await _sbPatch('ace_fub_unmatched_deals', id, patch);
      okCount++;
    } catch(e){ failCount++; }
  }
  _fubUmState.selected.clear();
  await _fubUmLoadData();
  if(failCount > 0) alert(`${okCount} updated, ${failCount} failed.`);
}

// Link-to-property modal
let _fubUmLinkSearchTimer = null;

export function _fubUmOpenLink(unmatchedId){
  const row = _fubUmState.rows.find(r => r.id === unmatchedId);
  if(!row) return;
  _fubUmState.linkingId = unmatchedId;
  const modal = document.getElementById('fubUmLinkModal');
  const body = document.getElementById('fubUmLinkModalBody');
  if(!modal || !body) return;
  modal.style.display = 'flex';
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  body.innerHTML = `
    <div style="background:#f8fafc;padding:12px 14px;border-radius:8px;margin-bottom:14px;border:1px solid #e2e8f0;">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">FUB deal</div>
      <div style="font-size:13px;font-weight:600;color:#0f172a;">${esc(row.fub_deal_name)}</div>
      <div style="font-size:11px;color:#64748b;margin-top:4px;">${esc(row.fub_pipeline_name||'—')} · ${esc(row.fub_stage_name||'—')} · Owner: ${esc(row.fub_contact_name||'—')}</div>
    </div>
    <div style="font-size:12px;font-weight:600;color:#0f172a;margin-bottom:6px;">Search for matching property</div>
    <input id="fubUmLinkSearch" type="text" placeholder="Address or partial match..." oninput="_fubUmLinkSearch(this.value)" style="width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;box-sizing:border-box;margin-bottom:10px;">
    <div id="fubUmLinkResults" style="max-height:300px;overflow-y:auto;"></div>`;
  // Auto-search with contact's other properties
  if(row.fub_contact_id){
    _fubUmLinkSearchByContact(row.fub_contact_id);
  } else {
    // Search by deal name keywords
    const m = row.fub_deal_name && row.fub_deal_name.match(/\b\d{1,5}\s+\w+/);
    const seed = m ? m[0] : '';
    const el = document.getElementById('fubUmLinkSearch');
    if(el && seed){ el.value = seed; _fubUmLinkSearch(seed); }
  }
}

export async function _fubUmLinkSearchByContact(fubContactId){
  const results = document.getElementById('fubUmLinkResults');
  if(!results) return;
  results.innerHTML = '<div style="padding:14px;color:#94a3b8;font-size:12px;text-align:center;">Searching...</div>';
  try{
    // Find ace_contact with this FUB id
    const contacts = await _sbGet('ace_contacts', `select=id&fub_contact_id=eq.${fubContactId}&limit=1`);
    if(!Array.isArray(contacts) || contacts.length === 0){
      results.innerHTML = '<div style="padding:14px;color:#94a3b8;font-size:12px;">Contact not in CRM. Try searching by address instead.</div>';
      return;
    }
    const props = await _sbGet('ace_properties', `select=id,address,pipeline_stage,fub_deal_id,is_archived&owner_contact_id=eq.${contacts[0].id}&limit=50`);
    _fubUmRenderLinkResults(props || []);
  } catch(e){
    results.innerHTML = `<div style="padding:14px;color:#991b1b;font-size:12px;">Error: ${e.message}</div>`;
  }
}

export function _fubUmLinkSearch(q){
  if(_fubUmLinkSearchTimer) clearTimeout(_fubUmLinkSearchTimer);
  _fubUmLinkSearchTimer = setTimeout(async () => {
    const results = document.getElementById('fubUmLinkResults');
    if(!results) return;
    q = (q||'').trim();
    if(q.length < 2){ results.innerHTML = '<div style="padding:14px;color:#94a3b8;font-size:12px;">Type at least 2 characters.</div>'; return; }
    results.innerHTML = '<div style="padding:14px;color:#94a3b8;font-size:12px;text-align:center;">Searching...</div>';
    try{
      const qEnc = encodeURIComponent('%' + q + '%');
      const props = await _sbGet('ace_properties', `select=id,address,pipeline_stage,fub_deal_id,is_archived&address=ilike.${qEnc}&limit=30`);
      _fubUmRenderLinkResults(props || []);
    } catch(e){
      results.innerHTML = `<div style="padding:14px;color:#991b1b;font-size:12px;">Error: ${e.message}</div>`;
    }
  }, 300);
}

export function _fubUmRenderLinkResults(props){
  const results = document.getElementById('fubUmLinkResults');
  if(!results) return;
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  if(props.length === 0){
    results.innerHTML = '<div style="padding:14px;color:#94a3b8;font-size:12px;">No properties found.</div>';
    return;
  }
  results.innerHTML = props.map(p => {
    const claimed = p.fub_deal_id ? `<span style="display:inline-block;background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;margin-left:6px;">claimed by #${p.fub_deal_id}</span>` : '';
    const arch = p.is_archived ? `<span style="display:inline-block;background:#f1f5f9;color:#64748b;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;margin-left:6px;">archived</span>` : '';
    return `
      <div style="padding:10px 12px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:#0f172a;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(p.address)}">${esc(p.address)}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">Stage: ${esc(p.pipeline_stage||'—')}${claimed}${arch}</div>
        </div>
        <button onclick="_fubUmConfirmLink('${esc(p.id)}', ${p.fub_deal_id ? 'true' : 'false'})" style="background:#0284c7;color:#fff;border:none;padding:6px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;white-space:nowrap;">Link →</button>
      </div>`;
  }).join('');
}

export async function _fubUmConfirmLink(propertyId, alreadyClaimed){
  const unmatchedId = _fubUmState.linkingId;
  const row = _fubUmState.rows.find(r => r.id === unmatchedId);
  if(!row) return;
  if(alreadyClaimed && !confirm(`This property is already linked to another FUB deal. Overwrite that link with deal #${row.fub_deal_id}?`)) return;

  try{
    // 1. Patch the property with fub_deal_id + new stage
    const stage = row.fub_stage_name && row.fub_stage_name !== 'Trash' ? row.fub_stage_name : null;
    const propPatch = { fub_deal_id: row.fub_deal_id };
    if(stage) propPatch.pipeline_stage = stage;
    await _sbPatch('ace_properties', propertyId, propPatch);

    // 2. Mark the unmatched row as linked
    const umPatch = {
      resolution: 'linked',
      resolved_property_id: propertyId,
      resolved_at: new Date().toISOString()
    };
    if(window._currentUser && window._currentUser.id) umPatch.resolved_by_user_id = window._currentUser.id;
    await _sbPatch('ace_fub_unmatched_deals', unmatchedId, umPatch);

    _fubUmCloseLinkModal();
    await _fubUmLoadData();
  } catch(e){
    alert('Link failed: ' + e.message);
  }
}

export function _fubUmCloseLinkModal(){
  const modal = document.getElementById('fubUmLinkModal');
  if(modal) modal.style.display = 'none';
  _fubUmState.linkingId = null;
}

// ─── FUB auto-link audit page (v111.11) ────────────────────────────
// Renders ace_fub_autolink_audit paginated. For active secondary links
// we show an Unlink button that calls the unlink_fub_id RPC (primary
// links are refused server-side — they'd orphan ace_contacts.fub_contact_id).
const _FUB_AUDIT_PAGE_SIZE = 50;
let _fubAuditState = { page: 0, eventType: 'all', search: '', rows: [], liveLinks: new Set(), contactNames: new Map() };

export function _fubAuditOpen(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  _fubAuditState = { page: 0, eventType: 'all', search: '', rows: [], liveLinks: new Set(), contactNames: new Map() };
  main.innerHTML = `
    <div style="padding:16px 22px;max-width:1400px;margin:0 auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div style="font-size:20px;font-weight:700;color:#0f172a;">🔗 FUB auto-link audit</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px;">Every ace_contact_fub_links mutation is logged here. Unlink active secondary links one-click.</div>
        </div>
        <button onclick="setNav(null,'settings')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Back to Settings</button>
      </div>

      <div id="fubAuditStats" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;"></div>

      <section style="background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <input id="fubAuditSearch" type="text" placeholder="Search by ace name or FUB id..." oninput="_fubAuditDebounced()" style="flex:1;min-width:220px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
          <select id="fubAuditType" onchange="_fubAuditSet('eventType',this.value)" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:#fff;">
            <option value="all">All events</option>
            <option value="autolinked">Auto-linked (secondary)</option>
            <option value="manual_link">Manual link</option>
            <option value="unlinked">Unlinked</option>
            <option value="backfill">Backfill (initial import)</option>
          </select>
        </div>
      </section>

      <section style="background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;overflow:hidden;">
        <div id="fubAuditTable" style="max-height:calc(100vh - 320px);overflow-y:auto;"><div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">Loading...</div></div>
        <div id="fubAuditPager" style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:12px;color:#475569;"></div>
      </section>
    </div>`;
  _fubAuditLoadStats();
  _fubAuditLoad();
}

let _fubAuditTimer = null;
export function _fubAuditDebounced(){
  if(_fubAuditTimer) clearTimeout(_fubAuditTimer);
  _fubAuditTimer = setTimeout(() => {
    _fubAuditState.search = (document.getElementById('fubAuditSearch')?.value||'').trim();
    _fubAuditState.page = 0;
    _fubAuditLoad();
  }, 300);
}
export function _fubAuditSet(k, v){ _fubAuditState[k] = v; _fubAuditState.page = 0; _fubAuditLoad(); }
export function _fubAuditPage(delta){
  const n = _fubAuditState.page + delta;
  if(n < 0) return;
  _fubAuditState.page = n;
  _fubAuditLoad();
}

export async function _fubAuditLoadStats(){
  const host = document.getElementById('fubAuditStats');
  if(!host) return;
  try {
    // RPC avoids the 1000-row PostgREST cap on paginated selects.
    const stats = await _sbRpc('_fub_autolink_audit_counts', {});
    const by = (stats && stats.by_type) || {};
    const card = (label, val, color) => `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;min-width:130px;">
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.6px;">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${color||'#0f172a'};margin-top:2px;">${val}</div>
    </div>`;
    host.innerHTML = [
      card('Total events', stats?.total||0),
      card('Last 7 days', stats?.last_7_days||0, '#0f766e'),
      card('Auto-linked', by.autolinked||0, '#0284c7'),
      card('Unlinked', by.unlinked||0, '#dc2626'),
      card('Manual link', by.manual_link||0, '#7c3aed'),
      card('Backfill', by.backfill||0, '#94a3b8'),
    ].join('');
  } catch(e){
    host.innerHTML = `<div style="font-size:11px;color:#dc2626;">Stats failed: ${e.message}</div>`;
  }
}

export async function _fubAuditLoad(){
  const body = document.getElementById('fubAuditTable');
  if(!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">Loading...</div>';
  const s = _fubAuditState;
  const parts = [
    'select=id,ace_id,fub_contact_id,event_type,is_primary,linked_by,link_reason,confidence,actor,notes,created_at',
    'order=created_at.desc',
    `limit=${_FUB_AUDIT_PAGE_SIZE+1}`,
    `offset=${s.page * _FUB_AUDIT_PAGE_SIZE}`
  ];
  if(s.eventType !== 'all') parts.push(`event_type=eq.${encodeURIComponent(s.eventType)}`);
  if(s.search){
    const n = Number(s.search);
    if(!isNaN(n) && n > 0) parts.push(`fub_contact_id=eq.${n}`);
    // name search requires a join; skip unless numeric. (v111.11 keeps scope small.)
  }
  try {
    const rows = await _sbGet('ace_fub_autolink_audit', parts.join('&'));
    const hasMore = (rows||[]).length > _FUB_AUDIT_PAGE_SIZE;
    s.rows = (rows||[]).slice(0, _FUB_AUDIT_PAGE_SIZE);
    // Resolve ace contact names + which links are still live, in parallel
    const aceIds = Array.from(new Set(s.rows.map(r => r.ace_id)));
    s.liveLinks = new Set();
    s.contactNames = new Map();
    if(aceIds.length){
      const inClause = `(${aceIds.map(id => `"${id}"`).join(',')})`;
      const [nameRows, linkRows] = await Promise.all([
        _sbGet(SB_TABLES.contacts, `id=in.${inClause}&select=id,name`).catch(()=>[]),
        _sbGet('ace_contact_fub_links', `ace_id=in.${inClause}&select=ace_id,fub_contact_id`).catch(()=>[])
      ]);
      (nameRows||[]).forEach(n => s.contactNames.set(n.id, n.name || '—'));
      (linkRows||[]).forEach(l => s.liveLinks.add(`${l.ace_id}|${l.fub_contact_id}`));
    }
    _fubAuditRender();
    _fubAuditUpdatePager(hasMore);
  } catch(e){
    body.innerHTML = `<div style="padding:40px;text-align:center;color:#dc2626;font-size:12px;">Load failed: ${e.message}</div>`;
  }
}

export function _fubAuditRender(){
  const body = document.getElementById('fubAuditTable');
  if(!body) return;
  const s = _fubAuditState;
  if(!s.rows.length){
    body.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">No events match.</div>';
    return;
  }
  const esc = v => String(v==null?'':v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const evtPill = ev => {
    const colors = {
      autolinked:  ['#dbeafe','#1e40af'],
      manual_link: ['#ede9fe','#6d28d9'],
      unlinked:    ['#fee2e2','#b91c1c'],
      backfill:    ['#f1f5f9','#475569']
    };
    const [bg,fg] = colors[ev] || ['#f1f5f9','#334155'];
    return `<span style="background:${bg};color:${fg};font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.4px;">${esc(ev)}</span>`;
  };
  const rowsHtml = s.rows.map(r => {
    const name = s.contactNames.get(r.ace_id) || '(unknown contact)';
    const when = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
    const isLive = s.liveLinks.has(`${r.ace_id}|${r.fub_contact_id}`);
    const canUnlink = isLive && !r.is_primary && r.event_type !== 'unlinked';
    const action = canUnlink
      ? `<button onclick="_fubAuditUnlink('${r.ace_id}', ${r.fub_contact_id})" style="background:#dc2626;color:#fff;border:none;padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">Unlink</button>`
      : (r.is_primary ? '<span style="font-size:10px;color:#94a3b8;">primary (merge-only)</span>'
         : (isLive ? '<span style="font-size:10px;color:#94a3b8;">—</span>'
            : '<span style="font-size:10px;color:#94a3b8;">not linked</span>'));
    const rule = (r.link_reason || '').replace(/^auto-linked FUB duplicate via /, '');
    return `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:8px 10px;font-size:11px;color:#64748b;white-space:nowrap;">${esc(when)}</td>
        <td style="padding:8px 10px;">${evtPill(r.event_type)}${r.is_primary ? ' <span style="background:#fef3c7;color:#92400e;font-size:9px;padding:1px 6px;border-radius:8px;margin-left:4px;">primary</span>':''}</td>
        <td style="padding:8px 10px;font-size:12px;">
          <a href="#" onclick="event.preventDefault();showContactDetailPage('${r.ace_id}','settings')" style="color:#1e40af;font-weight:600;text-decoration:none;">${esc(name)}</a>
        </td>
        <td style="padding:8px 10px;font-size:12px;font-family:monospace;color:#0f172a;">#${esc(r.fub_contact_id)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#475569;max-width:320px;">${esc(rule||'—')}</td>
        <td style="padding:8px 10px;font-size:11px;color:#64748b;">${esc(r.actor||r.linked_by||'system')}</td>
        <td style="padding:8px 10px;text-align:right;">${action}</td>
      </tr>`;
  }).join('');
  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead style="background:#f8fafc;position:sticky;top:0;z-index:1;">
        <tr>
          <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">When</th>
          <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Event</th>
          <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Ace contact</th>
          <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">FUB #</th>
          <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Rule / reason</th>
          <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Actor</th>
          <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Action</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

export function _fubAuditUpdatePager(hasMore){
  const pager = document.getElementById('fubAuditPager');
  if(!pager) return;
  const s = _fubAuditState;
  const from = s.page * _FUB_AUDIT_PAGE_SIZE + 1;
  const to = s.page * _FUB_AUDIT_PAGE_SIZE + s.rows.length;
  pager.innerHTML = `
    <div>Showing ${from}–${to}</div>
    <div style="display:flex;gap:6px;">
      <button onclick="_fubAuditPage(-1)" ${s.page===0?'disabled':''} style="background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:${s.page===0?'not-allowed':'pointer'};opacity:${s.page===0?0.5:1};">← Prev</button>
      <button onclick="_fubAuditPage(1)" ${hasMore?'':'disabled'} style="background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:${hasMore?'pointer':'not-allowed'};opacity:${hasMore?1:0.5};">Next →</button>
    </div>`;
}

export async function _fubAuditUnlink(aceId, fubId){
  const contactName = _fubAuditState.contactNames.get(aceId) || 'this contact';
  if(!confirm(`Unlink FUB #${fubId} from ${contactName}?\n\nNotes & calls from that FUB record will no longer show on this contact page. The primary FUB link is NOT touched.`)) return;
  try {
    const res = await _sbRpc('unlink_fub_id', {
      p_ace_id: aceId,
      p_fub_contact_id: fubId,
      p_actor: window._currentUser?.email || 'unknown@ace'
    });
    if(res && res.ok === false){
      alert(`Unlink failed: ${res.reason || 'unknown'}${res.hint ? '\n\n' + res.hint : ''}`);
      return;
    }
    // Refresh both the audit feed and the stats strip so the new 'unlinked'
    // row shows at the top.
    _fubAuditLoadStats();
    _fubAuditLoad();
  } catch(e){
    alert(`Unlink failed: ${e.message || e}`);
  }
}

// v192: NO FINANCIALS stamp retired in favor of a Deal Tag. Stub kept so
// existing call sites (recalcFinancials, saveFinInputs, etc.) don't crash.
