// scripts/scripts.js — Cold-call script library.
// CRUD on the generic `scripts` table. Entry: showScriptsPage().

import { _sbGet, _sbPost, _sbPatch } from '../core/supabase.js';
import { _showToast } from '../core/toast.js';

let _scripts = [];
let _editing = null; // full row or {} for new

const CATEGORIES = [
  { id: 'opening',   label: 'Opening' },
  { id: 'rebuttal',  label: 'Rebuttal' },
  { id: 'voicemail', label: 'Voicemail' },
  { id: 'follow_up', label: 'Follow-up' },
  { id: 'closing',   label: 'Closing' },
  { id: 'other',     label: 'Other' },
];

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export async function showScriptsPage(){
  const main = document.getElementById('mainArea');
  if(!main) return;
  main.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;padding:24px 28px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
            <button onclick="showListsPage()" style="background:transparent;border:none;color:#64748b;font-size:12px;cursor:pointer;padding:0;">← Lists</button>
          </div>
          <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#0f172a;">Scripts</h1>
          <div style="font-size:12px;color:#64748b;">Reusable cold-call scripts, pickable from any call log.</div>
        </div>
        <button onclick="_scriptEdit(null)" style="background:#0f172a;color:#fff;border:none;padding:9px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">＋ New script</button>
      </div>
      <div id="scriptsList"></div>
    </div>`;
  await _reloadScripts();
}

async function _reloadScripts(){
  const el = document.getElementById('scriptsList');
  if(!el) return;
  el.innerHTML = `<div style="padding:30px;text-align:center;color:#94a3b8;font-size:12px;">Loading…</div>`;
  try{
    const rows = await _sbGet('scripts', 'is_active=eq.true&order=category.asc,name.asc&select=*');
    _scripts = Array.isArray(rows) ? rows : [];
  } catch(e){
    el.innerHTML = `<div style="padding:30px;text-align:center;color:#dc2626;font-size:12px;">Failed: ${esc(e.message||e)}</div>`;
    return;
  }
  _renderList();
}

function _renderList(){
  const el = document.getElementById('scriptsList');
  if(!el) return;
  if(!_scripts.length){
    el.innerHTML = `
      <div style="padding:60px 20px;text-align:center;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;">
        <div style="font-size:30px;margin-bottom:6px;">📝</div>
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:4px;">No scripts yet</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:14px;">Start with an opening and a voicemail — add rebuttals as objections come up.</div>
        <button onclick="_scriptEdit(null)" style="background:#0f172a;color:#fff;border:none;padding:10px 18px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">＋ New script</button>
      </div>`;
    return;
  }
  // Group by category
  const groups = {};
  for(const s of _scripts){
    const k = s.category || 'other';
    (groups[k] = groups[k] || []).push(s);
  }
  const ordered = [...CATEGORIES.map(c => c.id).filter(c => groups[c]), ...Object.keys(groups).filter(k => !CATEGORIES.find(c => c.id === k))];
  el.innerHTML = ordered.map(cat => `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">
        ${esc((CATEGORIES.find(c => c.id === cat) || { label: cat }).label)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;">
        ${groups[cat].map(_renderScriptCard).join('')}
      </div>
    </div>`).join('');
}

function _renderScriptCard(s){
  const preview = (s.body || '').slice(0, 180);
  return `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="font-weight:600;color:#0f172a;font-size:13px;">${esc(s.name)}</div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button onclick="_scriptEdit('${s.id}')" title="Edit" style="background:transparent;border:1px solid #cbd5e1;color:#475569;padding:3px 8px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">Edit</button>
          <button onclick="_scriptDuplicate('${s.id}')" title="Duplicate" style="background:transparent;border:1px solid #cbd5e1;color:#475569;padding:3px 8px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">⧉</button>
          <button onclick="_scriptDelete('${s.id}')" title="Delete" style="background:transparent;border:1px solid #fecaca;color:#dc2626;padding:3px 8px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;">×</button>
        </div>
      </div>
      <div style="font-size:12px;color:#64748b;white-space:pre-wrap;line-height:1.45;">${esc(preview)}${(s.body||'').length > 180 ? '…' : ''}</div>
    </div>`;
}

export function _scriptEdit(id){
  _editing = id ? (_scripts.find(s => s.id === id) || null) : { name: '', category: 'opening', body: '' };
  if(!_editing) return;
  _renderEditor();
}

function _renderEditor(){
  const existing = document.getElementById('scriptModal');
  if(existing) existing.remove();
  const s = _editing;
  const modal = document.createElement('div');
  modal.id = 'scriptModal';
  modal.style.cssText = `position:fixed;inset:0;background:rgba(15,23,42,0.6);z-index:1700;display:flex;align-items:center;justify-content:center;padding:20px;`;
  modal.onclick = e => { if(e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:640px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.3);">
      <div style="padding:18px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${s.id ? 'Edit script' : 'New script'}</h2>
        <button onclick="document.getElementById('scriptModal').remove()" style="background:transparent;border:none;font-size:22px;color:#64748b;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="padding:18px 22px;overflow-y:auto;">
        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Name</label>
        <input id="scriptName" value="${esc(s.name || '')}" placeholder="e.g. Equity opener — absentee owner"
          style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;"/>

        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Category</label>
        <select id="scriptCategory" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;">
          ${CATEGORIES.map(c => `<option value="${c.id}" ${s.category===c.id?'selected':''}>${c.label}</option>`).join('')}
        </select>

        <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">Body</label>
        <textarea id="scriptBody" rows="12" placeholder="Hi, is this {name}? This is Ricky with Clarke Commercial…"
          style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;resize:vertical;">${esc(s.body || '')}</textarea>
        <div style="font-size:11px;color:#64748b;margin-top:4px;">Use <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">{name}</code>, <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">{property_address}</code>, <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;">{estimated_value}</code> etc. as placeholders.</div>
      </div>
      <div style="padding:12px 22px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
        <button onclick="document.getElementById('scriptModal').remove()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Cancel</button>
        <button onclick="_scriptSave()" style="background:#0f172a;color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

export async function _scriptSave(){
  if(!_editing) return;
  const name = document.getElementById('scriptName').value.trim();
  const category = document.getElementById('scriptCategory').value;
  const body = document.getElementById('scriptBody').value;
  if(!name){ _showToast('Name required', 'error'); return; }
  const user = window._currentUser || {};
  try{
    if(_editing.id){
      await _sbPatch('scripts', _editing.id, { name, category, body });
    } else {
      await _sbPost('scripts', {
        name, category, body,
        is_active: true,
        created_by_user_id: user.id || null,
      });
    }
    _showToast('Saved');
    document.getElementById('scriptModal').remove();
    _editing = null;
    await _reloadScripts();
  } catch(e){ _showToast('Save failed: ' + (e.message||e), 'error'); }
}

export async function _scriptDuplicate(id){
  const s = _scripts.find(x => x.id === id);
  if(!s) return;
  const user = window._currentUser || {};
  try{
    await _sbPost('scripts', {
      name: s.name + ' (copy)',
      category: s.category,
      body: s.body,
      is_active: true,
      created_by_user_id: user.id || null,
    });
    _showToast('Duplicated');
    await _reloadScripts();
  } catch(e){ _showToast('Failed: ' + (e.message||e), 'error'); }
}

export async function _scriptDelete(id){
  const s = _scripts.find(x => x.id === id);
  if(!s) return;
  if(!confirm(`Delete "${s.name}"? Previous call logs that reference this script will show "no script".`)) return;
  try{
    // Soft-delete: flip is_active=false so the unique-active-name index frees up.
    await _sbPatch('scripts', id, { is_active: false });
    _showToast('Deleted');
    await _reloadScripts();
  } catch(e){ _showToast('Failed: ' + (e.message||e), 'error'); }
}
