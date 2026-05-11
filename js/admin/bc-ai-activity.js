// admin/bc-ai-activity.js — Settings → Tools → "AI Auto-Fill activity log".
//
// Renders a reverse-chronological table of every buyer that's been AI
// auto-filled. Reads from ace_buyer_criteria.last_ai_autofill_at +
// ace_buyer_criteria.ai_autofill_log (both written by _bcAiAutoFillApply
// in the manual path and _bcAutoApplyProposalsAndAdvance in the
// v314 auto-apply path).
//
// Columns:
//   Contact          — joined from ace_contacts.name on contact_id
//   When             — last_ai_autofill_at, formatted as locale time + "X ago"
//   Values Applied   — applied_count from the latest log entry
//   N/A Marked       — na_count from the latest log entry
//   Mode             — 'auto_apply' (yellow chip) vs. reviewed (gray chip)
//   Total Runs       — full length of ai_autofill_log array
//
// External deps via window.*:
//   _sbGet (core/supabase.js)
//   SB_TABLES (schemas)
//   showSaveConfirm — not used here; the modal is read-only.

import { _sbGet } from '../core/supabase.js';

const PAGE_SIZE = 100;

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _fmtWhen(iso){
  if(!iso) return '—';
  const t = new Date(iso);
  if(isNaN(t)) return esc(iso);
  return t.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function _fmtAgo(iso){
  if(!iso) return '';
  const t = new Date(iso);
  if(isNaN(t)) return '';
  const diffMs = Date.now() - t.getTime();
  const min = Math.round(diffMs / 60000);
  if(min < 1)  return 'just now';
  if(min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if(hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if(d < 30)  return `${d}d ago`;
  const mo = Math.round(d / 30);
  if(mo < 12) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export async function _bcAiActivityOpen(){
  // Remove any prior instance so re-opening always shows fresh state.
  document.getElementById('bcAiActivityModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'bcAiActivityModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';
  modal.onclick = (e) => { if(e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:96%;max-width:1100px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
      <div style="padding:16px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:16px;font-weight:700;color:#0f172a;">🗒 AI Auto-Fill activity log</div>
          <div id="bcAiActivityStatus" style="font-size:11px;color:#64748b;margin-top:2px;">Loading…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="bcAiActivitySearch" placeholder="Filter by name…" oninput="window._bcAiActivityFilter()" style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;font-family:inherit;min-width:200px;"/>
          <button onclick="window._bcAiActivityRefresh()" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#0f172a;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">↻ Refresh</button>
          <button onclick="document.getElementById('bcAiActivityModal')?.remove()" style="background:transparent;border:1px solid #cbd5e1;color:#64748b;padding:7px 14px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;">Close</button>
        </div>
      </div>
      <div id="bcAiActivityBody" style="flex:1;overflow:auto;padding:0;">
        <div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">Loading recent AI auto-fills…</div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Stash filter function on window so the inline oninput can find it.
  window._bcAiActivityFilter = _filter;
  window._bcAiActivityRefresh = _load;

  await _load();
}

let _rows = [];

async function _load(){
  const status = document.getElementById('bcAiActivityStatus');
  const body = document.getElementById('bcAiActivityBody');
  if(!body) return;
  if(status) status.textContent = 'Loading…';

  try {
    // Pull the latest N BCs that have been AI auto-filled. Order by
    // last_ai_autofill_at desc so the most recent runs are at the top.
    // 100 is plenty for spot-checking; the agent can iterate the
    // bulk launcher to make more rows show up.
    const tbl = (window.SB_TABLES && window.SB_TABLES.buyerCriteria) || 'ace_buyer_criteria';
    const bcs = await _sbGet(tbl,
      `last_ai_autofill_at=not.is.null&select=id,contact_id,last_ai_autofill_at,ai_autofill_log&order=last_ai_autofill_at.desc&limit=${PAGE_SIZE}`);
    const rows = Array.isArray(bcs) ? bcs : [];

    // Batch-fetch contact names for these BCs.
    const contactIds = [...new Set(rows.map(r => r.contact_id).filter(Boolean))];
    const contactsById = {};
    if(contactIds.length){
      const CHUNK = 100;
      for(let i = 0; i < contactIds.length; i += CHUNK){
        const chunk = contactIds.slice(i, i + CHUNK);
        try {
          const cs = await _sbGet('ace_contacts',
            `id=in.(${chunk.join(',')})&select=id,name,email,phone_number`);
          for(const c of (cs || [])){ contactsById[c.id] = c; }
        } catch(e){ console.warn('[bc-ai-activity] contact batch failed:', e.message); }
      }
    }

    _rows = rows.map(r => {
      const log = Array.isArray(r.ai_autofill_log) ? r.ai_autofill_log : [];
      const latest = log[log.length - 1] || {};
      const c = contactsById[r.contact_id] || {};
      return {
        bcId: r.id,
        contactId: r.contact_id,
        name: c.name || '(no name)',
        email: c.email || '',
        phone: c.phone_number || '',
        whenIso: r.last_ai_autofill_at,
        applied: latest.applied_count || 0,
        na: latest.na_count || 0,
        mode: latest.mode || 'reviewed',
        totalRuns: log.length,
      };
    });

    if(status){
      status.textContent = `${_rows.length} buyer${_rows.length===1?'':'s'} AI-autofilled · sorted newest first · max ${PAGE_SIZE} rows`;
    }
    _render(_rows);
  } catch(e){
    if(status) status.textContent = `Load failed: ${e.message || e}`;
    if(body){
      body.innerHTML = `<div style="padding:40px;text-align:center;color:#dc2626;font-size:13px;">Failed to load activity log: ${esc(e.message || e)}</div>`;
    }
  }
}

function _filter(){
  const q = (document.getElementById('bcAiActivitySearch')?.value || '').trim().toLowerCase();
  if(!q){ _render(_rows); return; }
  const filtered = _rows.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.email && r.email.toLowerCase().includes(q)) ||
    (r.phone && r.phone.toLowerCase().includes(q))
  );
  _render(filtered);
}

function _render(rows){
  const body = document.getElementById('bcAiActivityBody');
  if(!body) return;
  if(!rows.length){
    body.innerHTML = `<div style="padding:40px;text-align:center;color:#94a3b8;font-size:13px;">No AI auto-fills yet. Run the bulk launcher to populate this log.</div>`;
    return;
  }

  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Contact</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">When</th>
          <th style="padding:9px 14px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Values Applied</th>
          <th style="padding:9px 14px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">N/A Marked</th>
          <th style="padding:9px 14px;text-align:center;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Mode</th>
          <th style="padding:9px 14px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Total Runs</th>
          <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const modeChip = r.mode === 'auto_apply'
            ? `<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:#fef9c3;color:#854d0e;border:1px solid #fde68a;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">auto</span>`
            : `<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">reviewed</span>`;
          const openBtn = r.bcId
            ? `<button onclick="document.getElementById('bcAiActivityModal')?.remove();if(typeof bcOpenExpanded==='function')bcOpenExpanded('${esc(r.bcId)}');" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#0f172a;padding:3px 10px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;font-family:inherit;">Open BC →</button>`
            : '';
          return `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:9px 14px;color:#0f172a;font-weight:600;">${esc(r.name)}${r.email ? `<div style="font-size:10px;font-weight:400;color:#94a3b8;margin-top:1px;">${esc(r.email)}</div>` : ''}</td>
              <td style="padding:9px 14px;color:#475569;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">${_fmtWhen(r.whenIso)}<div style="font-size:10px;font-weight:400;color:#94a3b8;font-family:inherit;margin-top:1px;">${_fmtAgo(r.whenIso)}</div></td>
              <td style="padding:9px 14px;text-align:right;color:#0f172a;font-weight:700;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">${r.applied}</td>
              <td style="padding:9px 14px;text-align:right;color:#475569;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">${r.na}</td>
              <td style="padding:9px 14px;text-align:center;">${modeChip}</td>
              <td style="padding:9px 14px;text-align:right;color:#475569;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">${r.totalRuns}</td>
              <td style="padding:9px 14px;text-align:right;">${openBtn}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}
