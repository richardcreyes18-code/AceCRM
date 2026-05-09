// asset-cleanup/asset-cleanup.js — AI-powered asset-type reclassification.
//
// Workbench UI for manually reclassifying ace_properties rows still tagged
// as vague types ("Commercial", "—"). Filter, select in bulk, apply a new
// type. AI suggestion column powered by Haiku via direct browser call.
//
// External dependencies on window.* (legacy script owns these; bare
// references would fail in strict mode):
//   state:    window.allDeals, window._currentUser, window.ASSET_SUBTYPES,
//             window._appLists
//   functions: getConfig (function decl on window), isSupabase
//
// Module-internal state (5 declarations + 1 const):
//   _acFilters, _acCurrentRows, _acSelectedIds, _acSuggestions, _acPage,
//   _AC_PAGE_SIZE

import { _sbGet, _sbPatch } from '../core/supabase.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

// ═══════════════════════════════════════════════════════════════════════
// LEGACY BLOCK BELOW — copied from index.html with `export` added to top-
// level functions and external script-scope refs prefixed with `window.`.
// Internal logic is byte-identical.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// v111 Ship 3: Asset Cleanup Workbench
// A page for manually reclassifying properties still tagged as vague
// types like "Commercial". Filter, select in bulk, apply a new type.
// AI suggestion column reserved for next-session Haiku integration.
// ═══════════════════════════════════════════════════════════════════

// Workbench state — lives at module scope so it survives table re-renders
let _acFilters = {
  asset_type: 'Commercial',
  agent: '',
  import_source: '',
  search: ''
};
let _acCurrentRows = [];
let _acSelectedIds = new Set();
let _acSuggestions = new Map();  // v111.2: property_id → suggestion record
let _acPage        = 0;
const _AC_PAGE_SIZE = 100;

// The canonical asset types list — pulled from window.ASSET_SUBTYPES keys + flat
// "Type: Subtype" forms that exist in ace_properties. Keeping this explicit
// so the dropdown matches what the rest of the CRM already uses.
export function _acGetAssetTypeOptions(){
  const options = [];
  // Top-level categories
  Object.keys(window.ASSET_SUBTYPES).forEach(cat => {
    options.push(cat);
    (window.ASSET_SUBTYPES[cat] || []).forEach(sub => {
      options.push(`${cat}: ${sub}`);
    });
  });
  // Common standalone types used in the CRM that aren't in window.ASSET_SUBTYPES
  options.push('Commercial', 'Residential', 'Vacant Building');
  return options.sort();
}

// Entry point — render the workbench page
export async function _assetCleanupOpen(){
  // Reset state
  _acSelectedIds = new Set();
  _acPage = 0;
  const main = document.getElementById('mainArea');
  if(!main) return;

  const assetOptions = _acGetAssetTypeOptions();
  const assetOptsHtml = assetOptions.map(o => `<option value="${o.replace(/"/g,'&quot;')}">${o}</option>`).join('');

  main.innerHTML = `
    <div style="padding:0;font-family:'Inter',system-ui,sans-serif;background:#f1f5f9;min-height:100vh;">
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%);color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:14px;">
          <button onclick="showSettingsPage()" style="background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);padding:7px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Settings</button>
          <div>
            <div style="font-size:19px;font-weight:700;">🏷 Asset Type Cleanup</div>
            <div style="font-size:11px;color:#93c5fd;margin-top:2px;" id="acHeaderCount">Loading...</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button onclick="_acAcceptAllHighConfidence()" id="acAcceptHighBtn" style="background:#059669;color:#fff;border:none;padding:7px 14px;font-size:12px;font-weight:700;border-radius:6px;cursor:pointer;display:none;" title="Accept all high-confidence AI suggestions on the current page">✓ Accept high-conf</button>
          <button onclick="_acAnalyzeWithAI()" id="acAnalyzeBtn" style="background:linear-gradient(180deg,#a78bfa,#7c3aed);color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:700;border-radius:6px;cursor:pointer;box-shadow:0 2px 6px rgba(124,58,237,0.3);" title="Classify all visible rows with Claude Haiku 4.5">✦ Analyze with AI</button>
        </div>
      </div>

      <div style="max-width:1400px;margin:0 auto;padding:16px 22px 60px;">

        <!-- Filter bar -->
        <section style="background:#fff;border-radius:10px;padding:14px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 2fr;gap:12px;align-items:end;">
            <div>
              <label style="display:block;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Current Asset Type</label>
              <select id="acFilterType" onchange="_acOnFilterChange()" style="width:100%;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
                <option value="Commercial" selected>Commercial (default)</option>
                <option value="Industrial">Industrial</option>
                <option value="">— All types —</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Agent</label>
              <select id="acFilterAgent" onchange="_acOnFilterChange()" style="width:100%;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
                <option value="">— Any agent —</option>
                <option value="__null__">(No agent assigned)</option>
                <option value="Daniel Keenan">Daniel Keenan</option>
                <option value="Aidan Alverson">Aidan Alverson</option>
                <option value="Joseph Domenech">Joseph Domenech</option>
                <option value="Timothy Emrich">Timothy Emrich</option>
                <option value="Richard Reyes">Richard Reyes</option>
                <option value="Will Hartgers">Will Hartgers</option>
                <option value="Skyler Nussbeck">Skyler Nussbeck</option>
                <option value="Joseph Spinella">Joseph Spinella</option>
                <option value="Henry Eisenstein">Henry Eisenstein</option>
                <option value="Farrah Nisivoccia">Farrah Nisivoccia</option>
                <option value="Greg Sly">Greg Sly</option>
                <option value="Everett James">Everett James</option>
                <option value="Everett McNulty">Everett McNulty</option>
                <option value="Thomas Ventrone">Thomas Ventrone</option>
                <option value="Louis Ferrara">Louis Ferrara</option>
                <option value="Cole Manowski">Cole Manowski (former)</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Import Source</label>
              <select id="acFilterImport" onchange="_acOnFilterChange()" style="width:100%;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
                <option value="">— Any source —</option>
                <option value="FUB_DEALS">FUB_DEALS (Ship 3)</option>
                <option value="FUB">FUB (Ship 2 contacts)</option>
                <option value="__null__">(No source — legacy)</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Search address or notes</label>
              <input id="acFilterSearch" type="text" oninput="_acDebouncedSearch()" placeholder="—" style="width:100%;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;box-sizing:border-box;"/>
            </div>
          </div>
        </section>

        <!-- Bulk action bar (sticky) -->
        <div id="acBulkBar" style="position:sticky;top:0;z-index:20;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 16px;margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          <div id="acSelectedCount" style="font-size:13px;font-weight:700;color:#1e40af;min-width:120px;">0 selected</div>
          <div style="flex:1;min-width:200px;display:flex;gap:8px;align-items:center;">
            <label style="font-size:11px;color:#64748b;font-weight:600;white-space:nowrap;">Change to:</label>
            <select id="acBulkTypeSelect" style="flex:1;min-width:220px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
              <option value="">— Pick new asset type —</option>
              ${assetOptsHtml}
            </select>
            <button onclick="_acApplyBulk()" id="acApplyBtn" style="background:#7c3aed;color:#fff;border:none;padding:7px 18px;font-size:12px;font-weight:700;border-radius:6px;cursor:pointer;" disabled>Apply</button>
          </div>
          <button onclick="_acClearSelection()" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#475569;padding:6px 12px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">Clear</button>
        </div>

        <!-- Status / save message -->
        <div id="acStatusMsg" style="min-height:20px;font-size:12px;color:#16a34a;font-weight:600;margin-bottom:8px;"></div>

        <!-- Table -->
        <section style="background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.04);border:1px solid #e2e8f0;overflow:hidden;">
          <div id="acTableWrap" style="max-height:calc(100vh - 330px);overflow-y:auto;">
            <div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">⏳ Loading properties...</div>
          </div>
        </section>

        <!-- Pagination -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;font-size:12px;color:#64748b;">
          <div id="acPageInfo">—</div>
          <div style="display:flex;gap:6px;">
            <button onclick="_acPrevPage()" id="acPrevBtn" style="background:#fff;border:1px solid #cbd5e1;color:#475569;padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Previous</button>
            <button onclick="_acNextPage()" id="acNextBtn" style="background:#fff;border:1px solid #cbd5e1;color:#475569;padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Next →</button>
          </div>
        </div>

        <!-- Hidden asset type dropdown options for row-level quick-picker -->
        <datalist id="acAssetTypeDatalist">
          ${assetOptions.map(o => `<option value="${o.replace(/"/g,'&quot;')}">`).join('')}
        </datalist>
      </div>
    </div>
  `;

  // Load first page
  _assetCleanupLoad();
}

// Debounce search input so we don't hit DB on every keystroke
let _acSearchTimer = null;
export function _acDebouncedSearch(){
  clearTimeout(_acSearchTimer);
  _acSearchTimer = setTimeout(() => {
    _acPage = 0;
    _assetCleanupLoad();
  }, 350);
}

export function _acOnFilterChange(){
  _acPage = 0;
  _assetCleanupLoad();
}

// Fetch current page of rows from Supabase given active filters
export async function _assetCleanupLoad(){
  const wrap = document.getElementById('acTableWrap');
  if(!wrap) return;
  wrap.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">⏳ Loading...</div>';

  const assetType    = document.getElementById('acFilterType')?.value ?? 'Commercial';
  const agentFilter  = document.getElementById('acFilterAgent')?.value ?? '';
  const sourceFilter = document.getElementById('acFilterImport')?.value ?? '';
  const searchStr    = (document.getElementById('acFilterSearch')?.value ?? '').trim();

  _acFilters = { asset_type: assetType, agent: agentFilter, import_source: sourceFilter, search: searchStr };

  // Build the PostgREST query
  // Note: we want deleted_at=is.null + property_type_text filter + optional agent/source/search
  const q = [];
  q.push('select=id,address,address_raw,property_type_text,fub_assigned_to,import_source,pipeline_stage,general_property_notes,asking_price,square_footage,number_of_units,simple_county');
  q.push('deleted_at=is.null');
  if(assetType){
    q.push(`property_type_text=eq.${encodeURIComponent(assetType)}`);
  }
  if(agentFilter === '__null__'){
    q.push('fub_assigned_to=is.null');
  } else if(agentFilter){
    // Multi-agent: match solo OR pipe-delimited membership
    q.push(_agentPgFilter(agentFilter, 'fub_assigned_to'));
  }
  if(sourceFilter === '__null__'){
    q.push('import_source=is.null');
  } else if(sourceFilter){
    q.push(`import_source=eq.${encodeURIComponent(sourceFilter)}`);
  }
  if(searchStr){
    // Search across address + address_raw + notes (OR)
    const s = encodeURIComponent(`%${searchStr}%`);
    q.push(`or=(address.ilike.${s},address_raw.ilike.${s},general_property_notes.ilike.${s})`);
  }
  q.push(`order=address.asc`);
  q.push(`limit=${_AC_PAGE_SIZE}`);
  q.push(`offset=${_acPage * _AC_PAGE_SIZE}`);

  // Also pull a count for pagination + header
  const countQ = q.filter(x => !x.startsWith('select=') && !x.startsWith('order=') && !x.startsWith('limit=') && !x.startsWith('offset='));
  countQ.push('select=id');

  try{
    const [rows, countRes] = await Promise.all([
      _sbGet(SB_TABLES.properties, q.join('&')),
      _sbGetCount(SB_TABLES.properties, countQ.join('&'))
    ]);
    _acCurrentRows = rows || [];
    const total = countRes || 0;

    // v111.2: fetch AI suggestions for the loaded rows (if any exist)
    _acSuggestions = new Map();
    if(_acCurrentRows.length){
      try{
        const ids = _acCurrentRows.map(r => r.id);
        // PostgREST: property_id=in.(id1,id2,...)
        const sugQs = `property_id=in.(${ids.join(',')})&select=property_id,suggested_type,suggested_subtype,suggested_full,confidence,reasoning,review_status,analyzed_at&review_status=in.(pending,rejected)`;
        const sugs = await _sbGet(SB_TABLES.aiAssetSuggestions, sugQs);
        (sugs || []).forEach(s => _acSuggestions.set(s.property_id, s));
      } catch(e){
        // Non-fatal — just render without suggestions
        console.warn('AI suggestions fetch failed (non-fatal):', e.message);
      }
    }

    // Update header count
    const hdr = document.getElementById('acHeaderCount');
    if(hdr){
      const filterSummary = [
        assetType ? `type: ${assetType}` : 'all types',
        agentFilter === '__null__' ? 'no agent' : (agentFilter || 'any agent'),
        searchStr ? `search: "${searchStr}"` : null
      ].filter(Boolean).join(' · ');
      hdr.textContent = `${total.toLocaleString()} properties · ${filterSummary}`;
    }

    // Update pagination info
    const pageInfo = document.getElementById('acPageInfo');
    const totalPages = Math.max(1, Math.ceil(total / _AC_PAGE_SIZE));
    if(pageInfo){
      const start = _acPage * _AC_PAGE_SIZE + 1;
      const end   = Math.min((_acPage + 1) * _AC_PAGE_SIZE, total);
      pageInfo.textContent = total === 0 ? 'No results' : `Showing ${start}–${end} of ${total.toLocaleString()} · page ${_acPage + 1} of ${totalPages}`;
    }
    const prev = document.getElementById('acPrevBtn');
    const next = document.getElementById('acNextBtn');
    if(prev) prev.disabled = _acPage <= 0;
    if(next) next.disabled = (_acPage + 1) >= totalPages;
    if(prev) prev.style.opacity = _acPage <= 0 ? '0.5' : '1';
    if(next) next.style.opacity = (_acPage + 1) >= totalPages ? '0.5' : '1';

    // v111.2: show/hide "Accept high-conf" button based on whether any high-conf suggestions exist on this page
    const acceptHighBtn = document.getElementById('acAcceptHighBtn');
    if(acceptHighBtn){
      const highCount = [..._acSuggestions.values()].filter(s => s.confidence === 'high' && s.review_status === 'pending').length;
      acceptHighBtn.style.display = highCount > 0 ? '' : 'none';
      acceptHighBtn.textContent = `✓ Accept ${highCount} high-conf`;
    }

    _assetCleanupRender();
  } catch(e){
    console.error('Asset cleanup load failed:', e);
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:#c00;font-size:13px;">❌ Failed to load: ${e.message}</div>`;
  }
}

// Count helper (PostgREST HEAD with Prefer: count=exact)
export async function _sbGetCount(table, qs){
  const cfg = getConfig();
  if(!cfg.key) throw new Error('No Supabase key');
  const url = `${cfg.url}/rest/v1/${table}?${qs}`;
  const res = await fetch(url, {
    method: 'HEAD',
    headers: {
      'apikey': cfg.key,
      'Authorization': `Bearer ${cfg.key}`,
      'Prefer': 'count=exact',
      'Range-Unit': 'items',
      'Range': '0-0'
    }
  });
  const cr = res.headers.get('content-range') || '';
  // Format: "0-0/1234"
  const m = cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Render the table rows
export function _assetCleanupRender(){
  const wrap = document.getElementById('acTableWrap');
  if(!wrap) return;

  if(!_acCurrentRows.length){
    wrap.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">No properties match these filters.</div>';
    _assetCleanupUpdateBulkBar();
    return;
  }

  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const truncate = (s, n) => {
    if(!s) return '';
    s = String(s);
    return s.length <= n ? s : s.substring(0, n) + '…';
  };

  // Build the asset type options once
  const opts = _acGetAssetTypeOptions();
  const optsHtml = opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');

  const rows = _acCurrentRows.map(r => {
    const isSelected = _acSelectedIds.has(r.id);
    const addr  = esc(r.address || '—');
    const raw   = esc(r.address_raw || '');
    const ctype = esc(r.property_type_text || '—');
    const agent = esc(r.fub_assigned_to || '');
    const src   = esc(r.import_source || '');
    const notes = esc(truncate((r.general_property_notes || '').replace(/\s+/g, ' '), 180));
    const extraBits = [];
    if(r.simple_county) extraBits.push(esc(r.simple_county));
    if(r.number_of_units) extraBits.push(`${r.number_of_units} units`);
    if(r.square_footage) extraBits.push(`${Number(r.square_footage).toLocaleString()} sf`);
    if(r.asking_price)   extraBits.push(`$${Math.round(r.asking_price/1000).toLocaleString()}k ask`);
    const extras = extraBits.length ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">${extraBits.join(' · ')}</div>` : '';
    return `
      <tr style="border-bottom:1px solid #f1f5f9;${isSelected ? 'background:#eff6ff;' : ''}">
        <td style="padding:9px 10px;vertical-align:top;">
          <input type="checkbox" ${isSelected?'checked':''} onchange="_acToggleRow('${r.id}')" style="width:14px;height:14px;cursor:pointer;"/>
        </td>
        <td style="padding:9px 10px;vertical-align:top;min-width:200px;">
          <div style="font-size:12px;font-weight:600;color:#0f172a;">${addr}</div>
          ${raw && raw !== addr ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;font-style:italic;" title="${raw}">raw: ${truncate(raw, 60)}</div>` : ''}
          ${extras}
        </td>
        <td style="padding:9px 10px;vertical-align:top;font-size:11px;color:#475569;">
          ${agent || '<span style="color:#94a3b8;font-style:italic;">(none)</span>'}
        </td>
        <td style="padding:9px 10px;vertical-align:top;">
          <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;">${ctype}</span>
          ${src ? `<div style="font-size:9px;color:#94a3b8;margin-top:3px;">${src}</div>` : ''}
        </td>
        <td style="padding:9px 10px;vertical-align:top;min-width:180px;">
          ${_acRenderSuggestionCell(r.id)}
        </td>
        <td style="padding:9px 10px;vertical-align:top;font-size:11px;color:#64748b;line-height:1.4;max-width:340px;">
          ${notes || '<span style="color:#cbd5e1;">— no notes —</span>'}
        </td>
        <td style="padding:9px 10px;vertical-align:top;min-width:220px;">
          <select onchange="_acApplyOneRow('${r.id}', this.value)" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:5px;font-size:11px;">
            <option value="">— Pick new type —</option>
            ${optsHtml}
          </select>
        </td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead style="position:sticky;top:0;background:#f8fafc;z-index:5;">
        <tr style="border-bottom:2px solid #e2e8f0;">
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;width:36px;">
            <input type="checkbox" id="acSelectAll" onchange="_acSelectAllOnPage(this.checked)" style="width:14px;height:14px;cursor:pointer;" title="Select all on page"/>
          </th>
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Address</th>
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Agent</th>
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Current</th>
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">AI Suggestion</th>
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Notes</th>
          <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Quick Set</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  _assetCleanupUpdateBulkBar();
}

// v111.2: Render the AI Suggestion column cell for a given property id
export function _acRenderSuggestionCell(propId){
  const s = _acSuggestions.get(propId);
  if(!s){
    return '<span style="font-size:10px;color:#cbd5e1;font-style:italic;">— not analyzed —</span>';
  }
  const esc = x => String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const conf = s.confidence;
  const label = esc(s.suggested_full || s.suggested_type || '—');
  const reasoning = esc((s.reasoning || '').replace(/\n/g, ' '));

  // Confidence → color
  const confColors = {
    high:   { bg:'#dcfce7', fg:'#15803d', text:'HIGH' },
    medium: { bg:'#fef9c3', fg:'#854d0e', text:'MED' },
    low:    { bg:'#e2e8f0', fg:'#475569', text:'LOW' },
    cannot_determine: { bg:'#fee2e2', fg:'#991b1b', text:'?' }
  };
  const c = confColors[conf] || confColors.low;

  // Show reviewed status (already accepted/rejected)
  if(s.review_status === 'accepted'){
    return `<div style="font-size:10px;color:#15803d;font-weight:600;">✓ Accepted: ${label}</div>`;
  }
  if(s.review_status === 'rejected'){
    return `<div style="font-size:10px;color:#94a3b8;text-decoration:line-through;">${label}</div>`;
  }

  // Pending suggestion — show pill + accept/reject buttons
  const canAccept = conf !== 'cannot_determine' && !!s.suggested_full;
  return `
    <div style="display:flex;flex-direction:column;gap:4px;">
      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
        <span style="background:${c.bg};color:${c.fg};padding:2px 7px;border-radius:99px;font-size:9px;font-weight:800;letter-spacing:0.03em;">${c.text}</span>
        <span style="font-size:11px;font-weight:600;color:#1e293b;" title="${reasoning}">${label}</span>
      </div>
      ${reasoning ? `<div style="font-size:10px;color:#64748b;line-height:1.3;" title="${reasoning}">${truncateReason(reasoning, 70)}</div>` : ''}
      ${canAccept ? `
        <div style="display:flex;gap:4px;margin-top:2px;">
          <button onclick="_acAcceptSuggestion('${propId}')" style="background:#059669;color:#fff;border:none;padding:3px 9px;font-size:10px;font-weight:700;border-radius:4px;cursor:pointer;">✓ Accept</button>
          <button onclick="_acRejectSuggestion('${propId}')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:3px 9px;font-size:10px;font-weight:600;border-radius:4px;cursor:pointer;">Dismiss</button>
        </div>
      ` : ''}
    </div>
  `;
}

// Local helper — unescaped truncate for already-escaped reasoning text
export function truncateReason(s, n){
  if(!s) return '';
  s = String(s);
  return s.length <= n ? s : s.substring(0, n) + '…';
}

// Toggle a single row's selection state
export function _acToggleRow(id){
  if(_acSelectedIds.has(id)) _acSelectedIds.delete(id);
  else _acSelectedIds.add(id);
  _assetCleanupRender();
}

// Select/deselect all rows currently on the page
export function _acSelectAllOnPage(checked){
  _acCurrentRows.forEach(r => {
    if(checked) _acSelectedIds.add(r.id);
    else _acSelectedIds.delete(r.id);
  });
  _assetCleanupRender();
}

export function _acClearSelection(){
  _acSelectedIds.clear();
  _assetCleanupRender();
}

// Update the bulk-action bar to show count + enable/disable apply
export function _assetCleanupUpdateBulkBar(){
  const n = _acSelectedIds.size;
  const countEl = document.getElementById('acSelectedCount');
  if(countEl) countEl.textContent = n === 0 ? '0 selected' : `${n} selected`;
  const applyBtn = document.getElementById('acApplyBtn');
  if(applyBtn){
    const hasType = !!document.getElementById('acBulkTypeSelect')?.value;
    applyBtn.disabled = (n === 0);
    applyBtn.style.opacity = (n === 0) ? '0.5' : '1';
    applyBtn.style.cursor = (n === 0) ? 'not-allowed' : 'pointer';
  }
  // Reflect the "select all" checkbox state
  const selAll = document.getElementById('acSelectAll');
  if(selAll && _acCurrentRows.length){
    const allSelected = _acCurrentRows.every(r => _acSelectedIds.has(r.id));
    const noneSelected = _acCurrentRows.every(r => !_acSelectedIds.has(r.id));
    selAll.checked = allSelected;
    selAll.indeterminate = !allSelected && !noneSelected;
  }
}

// Apply one row inline (from the per-row dropdown)
export async function _acApplyOneRow(id, newType){
  if(!newType) return;
  await _acApplyChange([id], newType, 'row');
}

// Apply the bulk-bar selected type to all selected rows
export async function _acApplyBulk(){
  const newType = document.getElementById('acBulkTypeSelect')?.value;
  if(!newType){ alert('Pick a new asset type first.'); return; }
  const ids = [..._acSelectedIds];
  if(!ids.length) return;
  if(!confirm(`Change ${ids.length} propert${ids.length===1?'y':'ies'} to "${newType}"?`)) return;
  await _acApplyChange(ids, newType, 'bulk');
}

// The actual update call — shared by bulk + one-row paths.
// Uses a single batch_id per session so all edits in this visit are
// grouped together in ace_import_log (reversible as one unit).
let _acSessionBatchId = null;
export async function _acApplyChange(ids, newType, source){
  if(!_acSessionBatchId) _acSessionBatchId = crypto.randomUUID();
  const statusEl = document.getElementById('acStatusMsg');
  if(statusEl){ statusEl.textContent = `⏳ Updating ${ids.length}...`; statusEl.style.color = '#0ea5e9'; }

  try{
    // PATCH in chunks — PostgREST handles `id=in.(a,b,c)` for batch updates
    const chunkSize = 50;
    let updated = 0;
    for(let i = 0; i < ids.length; i += chunkSize){
      const chunk = ids.slice(i, i + chunkSize);
      const inList = chunk.map(id => id).join(',');
      const url = `${getConfig().url}/rest/v1/${SB_TABLES.properties}?id=in.(${inList})`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'apikey': getConfig().key,
          'Authorization': `Bearer ${getConfig().key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ property_type_text: newType, updated_at: new Date().toISOString() })
      });
      if(!res.ok){
        const text = await res.text();
        throw new Error(`PATCH failed (${res.status}): ${text}`);
      }
      updated += chunk.length;
    }

    // Log the changes for reversibility (best-effort — ignore failures)
    try {
      const logEntries = ids.map(id => ({
        batch_id: _acSessionBatchId,
        entity_type: 'property',
        ace_id: id,
        details: {
          source: `asset_cleanup_workbench_${source}`,
          new_type: newType,
          applied_by: window._currentUser?.email || 'unknown',
          applied_at: new Date().toISOString()
        }
      }));
      await _sbPost('ace_import_log', logEntries);
    } catch(e){
      console.warn('Failed to log asset cleanup (non-fatal):', e.message);
    }

    // Remove updated rows from current page if they no longer match the filter,
    // and clear them from selection. Simplest: just refetch the current page.
    _acSelectedIds.clear();
    if(statusEl){
      statusEl.textContent = `✓ Updated ${updated} propert${updated===1?'y':'ies'} to "${newType}"`;
      statusEl.style.color = '#16a34a';
      setTimeout(() => { if(statusEl) statusEl.textContent = ''; }, 4500);
    }
    await _assetCleanupLoad();

    // Reset bulk type picker
    const sel = document.getElementById('acBulkTypeSelect');
    if(sel) sel.value = '';

  } catch(e){
    console.error('Asset cleanup apply failed:', e);
    if(statusEl){
      statusEl.textContent = `❌ Update failed: ${e.message}`;
      statusEl.style.color = '#dc2626';
    }
  }
}

// Pagination
export function _acPrevPage(){
  if(_acPage <= 0) return;
  _acPage--;
  _acSelectedIds.clear();
  _assetCleanupLoad();
}
export function _acNextPage(){
  _acPage++;
  _acSelectedIds.clear();
  _assetCleanupLoad();
}

// Hook bulk-bar select onchange to update Apply button state when type changes
document.addEventListener('change', (e) => {
  if(e.target && e.target.id === 'acBulkTypeSelect') _assetCleanupUpdateBulkBar();
});

// ═══════════════════════════════════════════════════════════════════
// v111.2: Haiku AI classification for asset types
// Classifies the current filter scope using Claude Haiku 4.5, writes
// structured suggestions to ace_ai_asset_suggestions, and refreshes the
// workbench so suggestions render as pills + Accept buttons.
// ═══════════════════════════════════════════════════════════════════

// Build the asset-type list we send to Haiku. We only include the canonical
// taxonomy — no free-text allowed. The AI is asked to pick from this list
// or return "cannot_determine" if nothing fits.
export function _acBuildAllowedTypesForAI(){
  const types = _acGetAssetTypeOptions();
  // Dedupe + keep most useful first (top-level first, then subtypes)
  return types;
}

// System prompt given to Haiku. Tight and instructional.
export function _acGetAISystemPrompt(allowedTypes){
  return `You classify commercial real estate properties into asset types based on address and freeform notes from a CRM.

You MUST pick exactly ONE of these asset types for each property (verbatim, case-sensitive match):

${allowedTypes.map(t => `- ${t}`).join('\n')}

Rules:
1. Pick the MOST SPECIFIC type available. Prefer "Industrial: Warehouse" over "Industrial" when the data says warehouse.
2. For "Type: Subtype" format, always include the subtype when you have evidence for it.
3. Return confidence based on how certain you are:
   - "high" = Clear signal in the notes or address (e.g. "52 Room Motel", "Auto Body Shop", "MHP - 1230 Stoney Ln", "Hot Flex WH")
   - "medium" = Reasonable inference from partial signal (e.g. "Runs Mechanic Shop" → Automotive; "10k SqFt O -" → Office; agent notes mention "multifamily")
   - "low" = Weak signal only (e.g. just a street name + minimal notes, but something suggests a category)
   - "cannot_determine" = Genuinely no signal at all (e.g. just "123 Main St" with no hint — don't guess)
4. NEVER invent types not in the allowed list.
5. Reasoning must be 1 short sentence (<20 words) citing the specific signal you used.
6. If notes mention multiple uses (e.g. "mixed use restaurant + apartments"), prefer "Mixed Use" with a relevant subtype.
7. Common abbreviations: MF=Multifamily, WH=Warehouse, RT=Retail, MU=Mixed Use, O=Office, Med=Medical, Dev=Development, IOS=Industrial Outdoor Storage, QSR=Quick Service Restaurant, MHP=Mobile Home Park, Gas=Gas Station, CW=Car Wash, Bizz=Business, NNN=Single Tenant NNN.

Return ONLY a JSON array (no markdown, no commentary) with one object per property in the same order as the input:
[
  {"id": "<property id>", "type": "<exact allowed type>", "confidence": "high|medium|low|cannot_determine", "reasoning": "<one sentence>"},
  ...
]`;
}

// Build the user message for a batch of properties
export function _acBuildAIBatch(rows){
  const items = rows.map(r => {
    const parts = [];
    parts.push(`ID: ${r.id}`);
    parts.push(`Address: ${r.address || '(none)'}`);
    if(r.address_raw && r.address_raw !== r.address) parts.push(`Raw: ${r.address_raw}`);
    if(r.property_type_text) parts.push(`Current type: ${r.property_type_text}`);
    if(r.simple_county) parts.push(`County: ${r.simple_county}`);
    if(r.number_of_units) parts.push(`Units: ${r.number_of_units}`);
    if(r.square_footage) parts.push(`SF: ${r.square_footage}`);
    if(r.asking_price) parts.push(`Ask: $${Math.round(r.asking_price/1000)}k`);
    // Keep notes to 500 chars to control token use
    if(r.general_property_notes){
      const notes = r.general_property_notes.replace(/\s+/g,' ').substring(0, 500);
      parts.push(`Notes: ${notes}`);
    }
    return parts.join(' | ');
  }).join('\n\n---\n\n');
  return `Classify each of these ${rows.length} properties:\n\n${items}\n\nReturn ONLY the JSON array.`;
}

// Main entry point from the "✦ Analyze with AI" button
export async function _acAnalyzeWithAI(){
  const apiKey = _store.get('anthropic_key');
  if(!apiKey){
    alert('No Anthropic API key set. Go to Settings → AI Assistant and add your key first.');
    return;
  }

  // Scope decision: by default analyze everything currently filtered, not just the current page
  // Re-query to get the full set of IDs that match the current filters
  const statusEl = document.getElementById('acStatusMsg');
  const btn = document.getElementById('acAnalyzeBtn');
  if(btn) btn.disabled = true;
  if(statusEl){ statusEl.textContent = '⏳ Fetching scope...'; statusEl.style.color = '#0ea5e9'; }

  try {
    // Build the same filter query that _assetCleanupLoad uses, but fetch ALL matching IDs (not paginated)
    const q = _acBuildFilterQueryForScope();
    q.push('select=id');
    q.push('limit=10000');  // safety cap
    const allRows = await _sbGet(SB_TABLES.properties, q.join('&'));
    const allIds = (allRows || []).map(r => r.id);

    if(allIds.length === 0){
      if(statusEl){ statusEl.textContent = 'No rows match the current filter — nothing to analyze.'; statusEl.style.color = '#64748b'; }
      if(btn) btn.disabled = false;
      return;
    }

    // Filter out IDs that already have a pending suggestion (resume mode)
    let existingMap = new Map();
    try {
      // Batch in chunks of 500 to avoid URL length limits
      for(let i = 0; i < allIds.length; i += 500){
        const chunk = allIds.slice(i, i + 500);
        const sugs = await _sbGet(SB_TABLES.aiAssetSuggestions, `property_id=in.(${chunk.join(',')})&select=property_id,review_status`);
        (sugs || []).forEach(s => existingMap.set(s.property_id, s.review_status));
      }
    } catch(e){
      console.warn('Existing suggestion check failed (non-fatal):', e.message);
    }

    // Only analyze rows that don't have a pending/accepted suggestion yet
    const toAnalyze = allIds.filter(id => {
      const st = existingMap.get(id);
      return !st || st === 'superseded';
    });

    const skipCount = allIds.length - toAnalyze.length;

    // Cost estimate: ~250 input tokens per property + 60 output, Haiku pricing
    const estInput  = toAnalyze.length * 250;
    const estOutput = toAnalyze.length * 60;
    const estCost   = (estInput * 1 + estOutput * 5) / 1e6;

    const msg = [
      `Analyze ${toAnalyze.length.toLocaleString()} properties with Claude Haiku 4.5?`,
      '',
      `Filter scope: ${allIds.length.toLocaleString()} total matching rows`,
      skipCount > 0 ? `Skipping ${skipCount.toLocaleString()} already analyzed (or accepted)` : null,
      '',
      `Estimated cost: ~$${estCost.toFixed(3)} (${estInput.toLocaleString()} input + ${estOutput.toLocaleString()} output tokens)`,
      `Estimated time: ~${Math.ceil(toAnalyze.length / 20 * 3)} seconds`,
      '',
      'Claude will look at each property\'s address, notes, and metadata, then suggest an asset type with a confidence rating.'
    ].filter(Boolean).join('\n');

    if(!confirm(msg)){
      if(statusEl){ statusEl.textContent = 'Cancelled.'; statusEl.style.color = '#64748b'; }
      if(btn) btn.disabled = false;
      return;
    }

    if(toAnalyze.length === 0){
      if(statusEl){ statusEl.textContent = 'All rows already analyzed. Re-analyze not yet implemented.'; statusEl.style.color = '#64748b'; }
      if(btn) btn.disabled = false;
      return;
    }

    // Process in batches
    const BATCH_SIZE = 20;
    const totalBatches = Math.ceil(toAnalyze.length / BATCH_SIZE);
    let totalSuccess = 0;
    let totalFail = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for(let b = 0; b < totalBatches; b++){
      const batchIds = toAnalyze.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

      if(statusEl){
        statusEl.textContent = `⏳ Analyzing ${Math.min((b+1)*BATCH_SIZE, toAnalyze.length)}/${toAnalyze.length} ... (batch ${b+1}/${totalBatches})`;
        statusEl.style.color = '#0ea5e9';
      }

      try {
        // Fetch full row data for the batch
        const rows = await _sbGet(SB_TABLES.properties, 
          `id=in.(${batchIds.join(',')})&select=id,address,address_raw,property_type_text,simple_county,number_of_units,square_footage,asking_price,general_property_notes`);
        if(!rows || rows.length === 0){
          console.warn('Batch returned no rows', batchIds);
          continue;
        }

        // Call Haiku
        const result = await _acCallHaikuForBatch(rows, apiKey);
        totalInputTokens  += result.usage?.input_tokens || 0;
        totalOutputTokens += result.usage?.output_tokens || 0;

        // Persist each suggestion via upsert
        const suggestionRecords = result.suggestions.map(s => ({
          property_id: s.id,
          suggested_type: s.type_top || s.type,
          suggested_subtype: s.type_sub || null,
          suggested_full: s.type,
          confidence: s.confidence,
          reasoning: s.reasoning,
          review_status: 'pending',
          input_tokens: Math.round((result.usage?.input_tokens || 0) / rows.length),
          output_tokens: Math.round((result.usage?.output_tokens || 0) / rows.length),
          model: 'claude-haiku-4-5',
          analyzed_at: new Date().toISOString()
        }));

        // Upsert to Supabase — use PostgREST's ON CONFLICT behavior via Prefer: resolution=merge-duplicates
        await _acUpsertSuggestions(suggestionRecords);
        totalSuccess += suggestionRecords.length;
      } catch(e){
        console.error(`Batch ${b+1} failed:`, e);
        totalFail += batchIds.length;
      }
    }

    // Update global AI cost tracker (reuse existing key)
    try {
      const s = JSON.parse(localStorage.getItem('ai_cost_tracker') || '{}');
      s.total_input  = (s.total_input  || 0) + totalInputTokens;
      s.total_output = (s.total_output || 0) + totalOutputTokens;
      s.call_count   = (s.call_count   || 0) + totalBatches;
      localStorage.setItem('ai_cost_tracker', JSON.stringify(s));
    } catch(e){ console.warn('cost tracker update failed:', e); }

    const actualCost = (totalInputTokens * 1 + totalOutputTokens * 5) / 1e6;
    if(statusEl){
      statusEl.textContent = `✓ Analyzed ${totalSuccess}/${toAnalyze.length} properties. Cost: $${actualCost.toFixed(4)}. ${totalFail > 0 ? `${totalFail} failed.` : ''}`;
      statusEl.style.color = totalFail === 0 ? '#16a34a' : '#d97706';
    }
    if(btn) btn.disabled = false;

    // Refresh the workbench to show the new suggestions
    await _assetCleanupLoad();

  } catch(e){
    console.error('AI analyze failed:', e);
    if(statusEl){ statusEl.textContent = '❌ ' + e.message; statusEl.style.color = '#dc2626'; }
    if(btn) btn.disabled = false;
  }
}

// Build the Supabase query params for the CURRENT filter (matches _assetCleanupLoad)
export function _acBuildFilterQueryForScope(){
  const assetType    = document.getElementById('acFilterType')?.value ?? 'Commercial';
  const agentFilter  = document.getElementById('acFilterAgent')?.value ?? '';
  const sourceFilter = document.getElementById('acFilterImport')?.value ?? '';
  const searchStr    = (document.getElementById('acFilterSearch')?.value ?? '').trim();

  const q = [];
  q.push('deleted_at=is.null');
  if(assetType) q.push(`property_type_text=eq.${encodeURIComponent(assetType)}`);
  if(agentFilter === '__null__') q.push('fub_assigned_to=is.null');
  else if(agentFilter) q.push(_agentPgFilter(agentFilter, 'fub_assigned_to'));
  if(sourceFilter === '__null__') q.push('import_source=is.null');
  else if(sourceFilter) q.push(`import_source=eq.${encodeURIComponent(sourceFilter)}`);
  if(searchStr){
    const s = encodeURIComponent(`%${searchStr}%`);
    q.push(`or=(address.ilike.${s},address_raw.ilike.${s},general_property_notes.ilike.${s})`);
  }
  q.push('order=address.asc');
  return q;
}

// Call Haiku with a single batch of property rows. Returns { suggestions, usage }.
export async function _acCallHaikuForBatch(rows, apiKey){
  const allowedTypes = _acBuildAllowedTypesForAI();
  const sys = _acGetAISystemPrompt(allowedTypes);
  const usr = _acBuildAIBatch(rows);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: sys,
      messages: [{ role: 'user', content: usr }]
    })
  });
  if(!res.ok){
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed;
  try { parsed = JSON.parse(clean); }
  catch(e){
    throw new Error(`AI returned invalid JSON. Raw: ${text.substring(0, 200)}`);
  }
  if(!Array.isArray(parsed)) throw new Error('Expected JSON array from AI');

  // Normalize + validate each suggestion
  const allowedSet = new Set(allowedTypes);
  const suggestions = parsed.map(s => {
    const id   = s.id;
    const type = (s.type || '').trim();
    const conf = (s.confidence || 'low').toLowerCase();
    const reasoning = (s.reasoning || '').substring(0, 500);
    // Split "Type: Subtype" into components
    let type_top = type;
    let type_sub = null;
    if(type.includes(':')){
      const parts = type.split(':').map(x => x.trim());
      type_top = parts[0];
      type_sub = parts.slice(1).join(': ');
    }
    // If type isn't in allowed list, bump confidence to cannot_determine
    const validConf = ['high','medium','low','cannot_determine'].includes(conf) ? conf : 'low';
    const finalConf = allowedSet.has(type) ? validConf : 'cannot_determine';
    return { id, type, type_top, type_sub, confidence: finalConf, reasoning };
  }).filter(s => s.id);

  return { suggestions, usage: data.usage || {} };
}

// Upsert suggestions using PostgREST's ON CONFLICT behavior via Prefer header
export async function _acUpsertSuggestions(records){
  if(!records.length) return;
  const cfg = getConfig();
  if(!cfg.key) throw new Error('No Supabase key');

  const res = await fetch(`${cfg.url}/rest/v1/${SB_TABLES.aiAssetSuggestions}`, {
    method: 'POST',
    headers: {
      'apikey': cfg.key,
      'Authorization': `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      // Upsert on property_id PK
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(records)
  });
  if(!res.ok){
    const text = await res.text();
    throw new Error(`Upsert failed (${res.status}): ${text}`);
  }
}

// Accept a single AI suggestion → update ace_properties + mark suggestion as accepted
export async function _acAcceptSuggestion(propId){
  const s = _acSuggestions.get(propId);
  if(!s || !s.suggested_full){ return; }
  // Reuse the existing apply path
  await _acApplyChange([propId], s.suggested_full, 'ai_accept');
  // Mark the suggestion as accepted in the suggestions table
  try {
    await _sbPatch(SB_TABLES.aiAssetSuggestions, propId, {
      review_status: 'accepted',
      reviewed_at: new Date().toISOString(),
      reviewed_by: window._currentUser?.email || null
    });
  } catch(e){
    // _sbPatch expects id to be the PK; aiAssetSuggestions uses property_id as PK.
    // Try the direct route:
    try {
      const cfg = getConfig();
      await fetch(`${cfg.url}/rest/v1/${SB_TABLES.aiAssetSuggestions}?property_id=eq.${propId}`, {
        method: 'PATCH',
        headers: {
          'apikey': cfg.key,
          'Authorization': `Bearer ${cfg.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          review_status: 'accepted',
          reviewed_at: new Date().toISOString(),
          reviewed_by: window._currentUser?.email || null
        })
      });
    } catch(e2){
      console.warn('Failed to mark suggestion accepted:', e2);
    }
  }
}

// Dismiss a suggestion (mark rejected, don't update property_type_text)
export async function _acRejectSuggestion(propId){
  try {
    const cfg = getConfig();
    await fetch(`${cfg.url}/rest/v1/${SB_TABLES.aiAssetSuggestions}?property_id=eq.${propId}`, {
      method: 'PATCH',
      headers: {
        'apikey': cfg.key,
        'Authorization': `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        review_status: 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: window._currentUser?.email || null
      })
    });
    // Remove from local map so it doesn't render
    _acSuggestions.delete(propId);
    _assetCleanupRender();
  } catch(e){
    console.warn('Failed to mark suggestion rejected:', e);
  }
}

// Accept ALL high-confidence pending suggestions on the current page at once
export async function _acAcceptAllHighConfidence(){
  const highIds = [..._acSuggestions.values()]
    .filter(s => s.confidence === 'high' && s.review_status === 'pending')
    .map(s => s.property_id);

  if(!highIds.length){
    alert('No high-confidence suggestions to accept on this page.');
    return;
  }

  if(!confirm(`Accept ${highIds.length} high-confidence AI suggestions? Each property will be updated to its suggested type.`)) return;

  // Group by suggested_full so we can bulk-update properties of each type together
  const byType = new Map();
  highIds.forEach(id => {
    const s = _acSuggestions.get(id);
    if(!s) return;
    if(!byType.has(s.suggested_full)) byType.set(s.suggested_full, []);
    byType.get(s.suggested_full).push(id);
  });

  const statusEl = document.getElementById('acStatusMsg');
  if(statusEl){ statusEl.textContent = `⏳ Accepting ${highIds.length} suggestions...`; statusEl.style.color = '#0ea5e9'; }

  try {
    for(const [newType, ids] of byType){
      await _acApplyChange(ids, newType, 'ai_bulk_accept');
    }
    // Mark all as accepted in the suggestions table
    const cfg = getConfig();
    await fetch(`${cfg.url}/rest/v1/${SB_TABLES.aiAssetSuggestions}?property_id=in.(${highIds.join(',')})`, {
      method: 'PATCH',
      headers: {
        'apikey': cfg.key,
        'Authorization': `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        review_status: 'accepted',
        reviewed_at: new Date().toISOString(),
        reviewed_by: window._currentUser?.email || null
      })
    });
    if(statusEl){ statusEl.textContent = `✓ Accepted ${highIds.length} high-confidence suggestions`; statusEl.style.color = '#16a34a'; }
    await _assetCleanupLoad();
  } catch(e){
    console.error('Bulk accept failed:', e);
    if(statusEl){ statusEl.textContent = '❌ ' + e.message; statusEl.style.color = '#dc2626'; }
  }
}
