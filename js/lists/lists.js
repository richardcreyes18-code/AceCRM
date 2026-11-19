// lists/lists.js — Lead-lists index page + state shared across the
// Lists feature. Entry point: showListsPage(). Clicking a list card
// delegates to list-detail.js (openLeadList).
//
// v378: cold-calling pipeline. Generic tables (lead_lists / leads /
// call_logs / scripts) — NOT ace_* prefixed.

import { _sbGet, _sbPost, _sbPatch, _sbDelete } from '../core/supabase.js';
import { _showToast } from '../core/toast.js';

// ─── Module state ──────────────────────────────────────────────────────
let _lists = [];
let _listsLoading = false;
let _listsStatusFilter = 'active'; // 'active' | 'archived' | 'all'

export function _listsState(){ return { lists: _lists, loading: _listsLoading }; }

// Shared format helpers, kept local so the module stands alone.
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(iso){
  if(!iso) return '—';
  try { return new Date(iso).toLocaleDateString(); } catch(e){ return '—'; }
}

// ─── Index page ────────────────────────────────────────────────────────
export async function showListsPage(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  main.innerHTML = _renderListsShell();
  await _reloadLists();
}

function _renderListsShell(){
  return `
    <div style="max-width:1200px;margin:0 auto;padding:24px 28px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <div>
          <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#0f172a;">Lead Lists</h1>
          <div style="font-size:12px;color:#64748b;">Cold-calling pipeline — import lead lists and track every call.</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button onclick="showScriptsPage()"
            style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;padding:9px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">📝 Scripts</button>
          <button onclick="_listsNew()"
            style="background:#0f172a;color:#fff;border:none;padding:9px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">＋ New List</button>
          <button onclick="_listsImportCsv()"
            style="background:#1a3a6e;color:#fff;border:none;padding:9px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">⇪ Import CSV</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;">
        ${['active','archived','all'].map(s => `
          <button onclick="_listsSetFilter('${s}')" data-lf="${s}"
            style="background:${_listsStatusFilter===s?'#0f172a':'#f1f5f9'};color:${_listsStatusFilter===s?'#fff':'#475569'};
                   border:1px solid ${_listsStatusFilter===s?'#0f172a':'#cbd5e1'};padding:6px 12px;font-size:11px;
                   font-weight:600;border-radius:999px;cursor:pointer;text-transform:capitalize;">
            ${s}
          </button>`).join('')}
      </div>
      <div id="listsGrid"></div>
    </div>
  `;
}

async function _reloadLists(){
  const grid = document.getElementById('listsGrid');
  if(!grid) return;
  grid.innerHTML = `<div style="padding:40px;text-align:center;color:#94a3b8;font-size:12px;">Loading…</div>`;
  _listsLoading = true;
  try{
    let params = 'select=*&deleted_at=is.null&order=created_at.desc';
    if(_listsStatusFilter !== 'all') params += `&status=eq.${_listsStatusFilter}`;
    const rows = await _sbGet('lead_lists', params);
    _lists = Array.isArray(rows) ? rows : [];
  } catch(e){
    console.error('[lists] reload failed', e);
    _lists = [];
    grid.innerHTML = `<div style="padding:40px;text-align:center;color:#dc2626;font-size:12px;">Failed to load lists: ${esc(e.message||e)}</div>`;
    return;
  } finally {
    _listsLoading = false;
  }
  _renderListsGrid();
}

function _renderListsGrid(){
  const grid = document.getElementById('listsGrid');
  if(!grid) return;
  if(!_lists.length){
    grid.innerHTML = `
      <div style="padding:60px 20px;text-align:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;">
        <div style="font-size:30px;margin-bottom:6px;">📞</div>
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:4px;">No lead lists yet</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:14px;">Import a CSV from PropStream or create an empty list.</div>
        <button onclick="_listsImportCsv()"
          style="background:#0f172a;color:#fff;border:none;padding:10px 18px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">
          ⇪ Import your first CSV
        </button>
      </div>`;
    return;
  }
  grid.innerHTML = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
          <tr>
            <th style="text-align:left;padding:12px 14px;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Name</th>
            <th style="text-align:left;padding:12px 10px;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Source</th>
            <th style="text-align:right;padding:12px 10px;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Total</th>
            <th style="text-align:right;padding:12px 10px;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Active</th>
            <th style="text-align:left;padding:12px 10px;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Created</th>
            <th style="text-align:left;padding:12px 10px;font-weight:600;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">Status</th>
            <th style="width:120px;padding:12px 10px;"></th>
          </tr>
        </thead>
        <tbody>
          ${_lists.map(l => _renderListsRow(l)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function _renderListsRow(l){
  const badgeColor = l.status === 'archived' ? '#94a3b8' : '#16a34a';
  return `
    <tr style="border-top:1px solid #f1f5f9;cursor:pointer;" onclick="openLeadList('${l.id}')"
        onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
      <td style="padding:12px 14px;font-weight:600;color:#0f172a;">${esc(l.name)}</td>
      <td style="padding:12px 10px;color:#64748b;text-transform:capitalize;">${esc(l.source || '—')}</td>
      <td style="padding:12px 10px;text-align:right;color:#334155;font-variant-numeric:tabular-nums;">${l.total_count || 0}</td>
      <td style="padding:12px 10px;text-align:right;color:#16a34a;font-weight:600;font-variant-numeric:tabular-nums;">${l.active_count || 0}</td>
      <td style="padding:12px 10px;color:#64748b;">${fmtDate(l.created_at)}</td>
      <td style="padding:12px 10px;">
        <span style="display:inline-block;padding:2px 8px;font-size:10px;font-weight:600;border-radius:999px;
                     background:${badgeColor}22;color:${badgeColor};text-transform:uppercase;letter-spacing:0.04em;">
          ${esc(l.status)}
        </span>
      </td>
      <td style="padding:12px 10px;text-align:right;" onclick="event.stopPropagation()">
        ${l.status === 'active'
          ? `<button onclick="_listsArchive('${l.id}')" style="background:transparent;border:1px solid #cbd5e1;color:#475569;padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;margin-right:4px;">Archive</button>`
          : `<button onclick="_listsUnarchive('${l.id}')" style="background:transparent;border:1px solid #cbd5e1;color:#475569;padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;margin-right:4px;">Unarchive</button>`
        }
        <button onclick="_listsDelete('${l.id}','${esc(l.name)}')" style="background:transparent;border:1px solid #fecaca;color:#dc2626;padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">Delete</button>
      </td>
    </tr>
  `;
}

export function _listsSetFilter(s){
  _listsStatusFilter = s;
  showListsPage();
}

// ─── Create empty list ─────────────────────────────────────────────────
export async function _listsNew(){
  const name = prompt('Name this list:');
  if(!name || !name.trim()) return;
  try{
    const user = window._currentUser || {};
    await _sbPost('lead_lists', {
      name: name.trim(),
      source: 'manual',
      status: 'active',
      created_by_user_id: user.id || null,
    });
    _showToast('List created');
    await _reloadLists();
  } catch(e){
    _showToast('Error: ' + (e.message || e), 'error');
  }
}

export async function _listsArchive(id){
  try{
    await _sbPatch('lead_lists', id, { status: 'archived' });
    _showToast('Archived');
    await _reloadLists();
  } catch(e){ _showToast('Error: ' + (e.message || e), 'error'); }
}
export async function _listsUnarchive(id){
  try{
    await _sbPatch('lead_lists', id, { status: 'active' });
    _showToast('Restored');
    await _reloadLists();
  } catch(e){ _showToast('Error: ' + (e.message || e), 'error'); }
}
export async function _listsDelete(id, name){
  if(!confirm(`Permanently delete "${name}" and all its leads + call logs?\n\nThis cannot be undone.`)) return;
  try{
    await _sbPatch('lead_lists', id, { deleted_at: new Date().toISOString() });
    _showToast('Deleted');
    await _reloadLists();
  } catch(e){ _showToast('Error: ' + (e.message || e), 'error'); }
}

// ─── Entry hook for CSV import (implemented in import.js) ──────────────
export function _listsImportCsv(){
  if(typeof window._listsImportOpen === 'function') return window._listsImportOpen();
  _showToast('Import module not loaded', 'error');
}
