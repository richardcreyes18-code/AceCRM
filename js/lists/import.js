// lists/import.js — CSV import flow for lead lists.
//
// Flow:
//   1. User picks a CSV file.
//   2. Parse first chunk → detect headers, show preview of first 5 rows.
//   3. Column-mapper: each CSV column -> one of our lead fields (or Skip).
//   4. Save mapping as a reusable preset (localStorage).
//   5. Create lead_lists row, dedupe-by (phone, property_address) within
//      the CSV, batch-insert leads 200 at a time with a progress bar.
//
// v378: generic tables (lead_lists / leads).

import { _sbPost } from '../core/supabase.js';
import { _showToast } from '../core/toast.js';

// ─── Field dictionary ──────────────────────────────────────────────────
// id must match a column on `leads`.
const FIELDS = [
  { id: 'name',             label: 'Owner name' },
  { id: 'phone',            label: 'Phone (primary)' },
  { id: 'phone_secondary',  label: 'Phone (secondary)' },
  { id: 'email',            label: 'Email' },
  { id: 'mailing_address',  label: 'Mailing — street' },
  { id: 'mailing_city',     label: 'Mailing — city' },
  { id: 'mailing_state',    label: 'Mailing — state' },
  { id: 'mailing_zip',      label: 'Mailing — zip' },
  { id: 'property_address', label: 'Property — street' },
  { id: 'property_city',    label: 'Property — city' },
  { id: 'property_state',   label: 'Property — state' },
  { id: 'property_zip',     label: 'Property — zip' },
  { id: 'property_type',    label: 'Property type' },
  { id: 'bedrooms',         label: 'Bedrooms',       numeric: true, kind: 'int' },
  { id: 'bathrooms',        label: 'Bathrooms',      numeric: true },
  { id: 'sqft',             label: 'Sqft',           numeric: true, kind: 'int' },
  { id: 'lot_size',         label: 'Lot size',       numeric: true },
  { id: 'year_built',       label: 'Year built',     numeric: true, kind: 'int' },
  { id: 'owner_occupied',   label: 'Owner-occupied', kind: 'bool' },
  { id: 'last_sale_date',   label: 'Last sale date', kind: 'date' },
  { id: 'last_sale_price',  label: 'Last sale price',numeric: true },
  { id: 'estimated_value',  label: 'Estimated value',numeric: true },
  { id: 'equity_pct',       label: 'Equity %',       numeric: true },
  { id: 'loan_balance',     label: 'Loan balance',   numeric: true },
];
const FIELD_IDS = new Set(FIELDS.map(f => f.id));

const PRESETS_KEY = 'csvImportPresetsV1';
function _loadPresets(){
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch(e){ return []; }
}
function _savePresets(arr){
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(arr)); } catch(e){}
}

// ─── Tiny CSV parser (RFC-4180 with quoted fields + newlines) ──────────
export function _parseCsv(text){
  const rows = [];
  let row = [], cell = '', inQuote = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(inQuote){
      if(c === '"'){
        if(text[i+1] === '"'){ cell += '"'; i++; }
        else { inQuote = false; }
      } else { cell += c; }
    } else {
      if(c === '"'){ inQuote = true; }
      else if(c === ','){ row.push(cell); cell = ''; }
      else if(c === '\r'){ /* skip */ }
      else if(c === '\n'){ row.push(cell); rows.push(row); row = []; cell = ''; }
      else { cell += c; }
    }
  }
  if(cell.length || row.length){ row.push(cell); rows.push(row); }
  // Trim a trailing empty row
  if(rows.length && rows[rows.length-1].length === 1 && rows[rows.length-1][0] === '') rows.pop();
  return rows;
}

// ─── Heuristic auto-mapping based on header name ───────────────────────
function _autoMap(headers){
  const map = {};
  headers.forEach((h, i) => {
    const key = (h || '').toLowerCase().trim();
    const guess = _guessField(key);
    if(guess) map[i] = guess;
  });
  return map;
}
function _guessField(k){
  if(!k) return null;
  if(/(^|_|\s)(first.?name|owner.?name|name|owner)($|_|\s)/.test(k) && !k.includes('company')) return 'name';
  if(/(mobile|phone1|phone_1|primary.?phone|^phone$|phone.?number)/.test(k) && !k.includes('2')) return 'phone';
  if(/(phone2|phone_2|secondary.?phone|phone.?3|alt.?phone)/.test(k)) return 'phone_secondary';
  if(/email/.test(k)) return 'email';
  if(/mail.*(address|street)|mailing.?addr/.test(k)) return 'mailing_address';
  if(/mail.*city/.test(k)) return 'mailing_city';
  if(/mail.*state/.test(k)) return 'mailing_state';
  if(/mail.*(zip|postal)/.test(k)) return 'mailing_zip';
  if(/prop.*(address|street)|^(site|property).?addr/.test(k) || /^address$/.test(k)) return 'property_address';
  if(/prop.*city|^city$/.test(k)) return 'property_city';
  if(/prop.*state|^state$/.test(k)) return 'property_state';
  if(/prop.*(zip|postal)|^(zip|postal)$/.test(k)) return 'property_zip';
  if(/prop.*type|property.?type|asset.?type/.test(k)) return 'property_type';
  if(/bed(room)?s?$/.test(k)) return 'bedrooms';
  if(/bath(room)?s?$/.test(k)) return 'bathrooms';
  if(/sq.?ft|square.?f(ee|oo)t|living.?area/.test(k)) return 'sqft';
  if(/lot.?(size|sqft|acre)/.test(k)) return 'lot_size';
  if(/year.?built|yr.?built|built/.test(k)) return 'year_built';
  if(/owner.?occupied|^oo$|occupancy/.test(k)) return 'owner_occupied';
  if(/last.?sale.?date|sale.?date|sold.?date/.test(k)) return 'last_sale_date';
  if(/last.?sale.?price|sale.?price|sold.?price/.test(k)) return 'last_sale_price';
  if(/estimated.?value|est.?value|avm|market.?value|property.?value/.test(k)) return 'estimated_value';
  if(/equity.?(pct|percent|%)|equity$/.test(k)) return 'equity_pct';
  if(/loan.?balance|mortgage.?balance|total.?loan/.test(k)) return 'loan_balance';
  return null;
}

// ─── Coercion ──────────────────────────────────────────────────────────
function _coerce(raw, fieldId){
  const f = FIELDS.find(x => x.id === fieldId);
  if(!f) return raw;
  let v = (raw == null ? '' : String(raw)).trim();
  if(v === '' || v === '-' || v.toLowerCase() === 'n/a') return null;
  if(f.numeric){
    const num = parseFloat(v.replace(/[$,\s%]/g, ''));
    if(!isFinite(num)) return null;
    return f.kind === 'int' ? Math.round(num) : num;
  }
  if(f.kind === 'bool'){
    const low = v.toLowerCase();
    if(['y','yes','true','1','t'].includes(low)) return true;
    if(['n','no','false','0','f'].includes(low)) return false;
    return null;
  }
  if(f.kind === 'date'){
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return v;
}

function _normPhone(s){
  if(!s) return '';
  return String(s).replace(/\D/g, '');
}

// ─── Modal state ───────────────────────────────────────────────────────
let _state = null;

export function _listsImportOpen(){
  _state = { step: 'file', file: null, rows: null, headers: null, mapping: {}, listName: '' };
  _renderModal();
}

function _renderModal(){
  _closeModal();
  const modal = document.createElement('div');
  modal.id = 'importModal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(15,23,42,0.6);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px;`;
  modal.onclick = e => { if(e.target === modal) _closeModal(); };

  const body = document.createElement('div');
  body.style.cssText = `
    background:#fff;border-radius:12px;max-width:900px;width:100%;max-height:90vh;
    display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.3);`;
  body.innerHTML = _renderStep();
  modal.appendChild(body);
  document.body.appendChild(modal);

  if(_state.step === 'file'){
    const inp = document.getElementById('csvFileInput');
    if(inp) inp.addEventListener('change', e => _onFilePicked(e.target.files[0]));
  }
}

function _closeModal(){
  const m = document.getElementById('importModal');
  if(m) m.remove();
}

function _renderStep(){
  if(_state.step === 'file')    return _renderStepFile();
  if(_state.step === 'map')     return _renderStepMap();
  if(_state.step === 'progress')return _renderStepProgress();
  return '';
}

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _renderStepFile(){
  const presets = _loadPresets();
  return `
    <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
      <h2 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">Import leads from CSV</h2>
      <button onclick="_listsImportClose()" style="background:transparent;border:none;font-size:22px;color:#64748b;cursor:pointer;line-height:1;">×</button>
    </div>
    <div style="padding:24px;overflow-y:auto;">
      <label for="csvFileInput"
        style="display:block;padding:40px 20px;background:#f8fafc;border:2px dashed #cbd5e1;border-radius:10px;
               text-align:center;cursor:pointer;">
        <div style="font-size:32px;margin-bottom:8px;">📂</div>
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:4px;">Choose a CSV file</div>
        <div style="font-size:12px;color:#64748b;">PropStream, manual export, anything with a header row.</div>
        <input id="csvFileInput" type="file" accept=".csv,text/csv" style="display:none;"/>
      </label>
      ${presets.length ? `
        <div style="margin-top:20px;">
          <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">Saved mapping presets</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${presets.map((p,i) => `
              <div style="display:flex;align-items:center;gap:4px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:999px;padding:3px 10px 3px 12px;font-size:11px;color:#475569;">
                <span>${esc(p.name)}</span>
                <button onclick="_listsDeletePreset(${i})" title="Delete preset" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;">×</button>
              </div>
            `).join('')}
          </div>
        </div>` : ''}
    </div>`;
}

function _onFilePicked(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    const rows = _parseCsv(text);
    if(rows.length < 2){
      _showToast('CSV has no data rows', 'error');
      return;
    }
    _state.file = file;
    _state.headers = rows[0];
    _state.rows = rows.slice(1);
    _state.listName = file.name.replace(/\.csv$/i, '');
    _state.mapping = _autoMap(_state.headers);
    _state.step = 'map';
    _renderModal();
  };
  reader.onerror = () => _showToast('Could not read file', 'error');
  reader.readAsText(file);
}

function _renderStepMap(){
  const preview = _state.rows.slice(0, 5);
  const presets = _loadPresets();
  return `
    <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <h2 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">Map CSV columns to lead fields</h2>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${_state.rows.length.toLocaleString()} data row${_state.rows.length===1?'':'s'} detected.</div>
      </div>
      <button onclick="_listsImportClose()" style="background:transparent;border:none;font-size:22px;color:#64748b;cursor:pointer;line-height:1;">×</button>
    </div>
    <div style="padding:20px 24px;overflow-y:auto;flex:1;">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;">
        <label style="font-size:12px;font-weight:600;color:#475569;min-width:80px;">List name</label>
        <input id="listNameInput" value="${esc(_state.listName)}" oninput="_listsImportNameChange(this.value)"
          style="flex:1;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;"/>
        ${presets.length ? `
          <label style="font-size:11px;color:#64748b;">Preset:</label>
          <select onchange="_listsApplyPreset(this.value)" style="padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
            <option value="">—</option>
            ${presets.map((p,i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}
          </select>` : ''}
      </div>
      <div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead style="background:#f8fafc;">
            <tr>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:#475569;width:30%;">CSV column</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:#475569;width:30%;">Maps to</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:#475569;">Sample values</th>
            </tr>
          </thead>
          <tbody>
            ${_state.headers.map((h, i) => _renderMapRow(h, i, preview)).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:12px;font-size:12px;color:#64748b;">
        ⓘ <strong>Phone</strong> and either <strong>Property — street</strong> or <strong>Mailing — street</strong> are strongly recommended. Rows with no phone AND no address will be skipped.
      </div>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
      <button onclick="_listsImportBack()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">← Back</button>
      <div style="display:flex;gap:8px;">
        <button onclick="_listsImportSavePreset()" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">💾 Save mapping as preset</button>
        <button onclick="_listsImportGo()" style="background:#0f172a;color:#fff;border:none;padding:8px 18px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;">Import →</button>
      </div>
    </div>
  `;
}

function _renderMapRow(h, i, preview){
  const selected = _state.mapping[i] || '';
  const samples = preview.map(r => r[i]).filter(v => v != null && v !== '').slice(0, 3)
                        .map(v => esc(String(v).slice(0, 40))).join(' · ');
  return `
    <tr style="border-top:1px solid #f1f5f9;">
      <td style="padding:8px 12px;color:#0f172a;font-weight:500;">${esc(h || `col_${i+1}`)}</td>
      <td style="padding:8px 12px;">
        <select onchange="_listsMapChange(${i}, this.value)" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:5px;font-size:12px;">
          <option value="">— Skip this column —</option>
          ${FIELDS.map(f => `<option value="${f.id}" ${selected===f.id?'selected':''}>${esc(f.label)}</option>`).join('')}
        </select>
      </td>
      <td style="padding:8px 12px;color:#94a3b8;font-size:11px;">${samples || '—'}</td>
    </tr>
  `;
}

export function _listsMapChange(idx, fieldId){
  // Allow dup target columns? No — pick the first one, clear others.
  if(fieldId){
    Object.keys(_state.mapping).forEach(k => {
      if(_state.mapping[k] === fieldId) delete _state.mapping[k];
    });
    _state.mapping[idx] = fieldId;
  } else {
    delete _state.mapping[idx];
  }
}
export function _listsImportNameChange(v){ _state.listName = v; }
export function _listsImportBack(){ _state.step = 'file'; _renderModal(); }
export function _listsImportClose(){ _state = null; _closeModal(); }

export function _listsApplyPreset(idx){
  if(!idx && idx !== 0) return;
  const p = _loadPresets()[Number(idx)];
  if(!p) return;
  // Preset maps HEADER NAME -> field id; re-resolve to indices.
  const m = {};
  _state.headers.forEach((h, i) => {
    const key = (h || '').toLowerCase().trim();
    const f = p.mapping[key];
    if(f && FIELD_IDS.has(f)) m[i] = f;
  });
  _state.mapping = m;
  _renderModal();
}

export function _listsImportSavePreset(){
  const name = prompt('Name this preset (so you can reuse it next time):');
  if(!name || !name.trim()) return;
  const mapping = {};
  Object.entries(_state.mapping).forEach(([i, f]) => {
    const h = (_state.headers[Number(i)] || '').toLowerCase().trim();
    if(h) mapping[h] = f;
  });
  const presets = _loadPresets();
  presets.push({ name: name.trim(), mapping });
  _savePresets(presets);
  _showToast('Preset saved');
}

export function _listsDeletePreset(idx){
  const presets = _loadPresets();
  presets.splice(idx, 1);
  _savePresets(presets);
  _renderModal();
}

// ─── Actually import ───────────────────────────────────────────────────
export async function _listsImportGo(){
  const mapping = _state.mapping;
  if(!Object.keys(mapping).length){
    _showToast('Map at least one column first', 'error');
    return;
  }
  if(!_state.listName.trim()){
    _showToast('Give the list a name', 'error');
    return;
  }

  // Build lead records from rows, dedupe on (phone, property_address)
  // within the CSV. Blank phone AND blank addresses → skip.
  const seen = new Set();
  const records = [];
  let skipped = 0;
  for(const row of _state.rows){
    const rec = {};
    for(const [i, fieldId] of Object.entries(mapping)){
      const raw = row[Number(i)];
      const v = _coerce(raw, fieldId);
      if(v != null) rec[fieldId] = v;
    }
    const phone = _normPhone(rec.phone);
    const addr  = (rec.property_address || rec.mailing_address || '').toLowerCase().trim();
    if(!phone && !addr){ skipped++; continue; }
    const key = phone + '|' + addr;
    if(seen.has(key)){ skipped++; continue; }
    seen.add(key);
    rec.raw_import_data = Object.fromEntries(
      _state.headers.map((h, i) => [h || `col_${i+1}`, row[i]])
                    .filter(([, v]) => v != null && v !== '')
    );
    records.push(rec);
  }

  if(!records.length){
    _showToast('No importable rows (every row was blank or duplicate)', 'error');
    return;
  }

  _state.step = 'progress';
  _state.total = records.length;
  _state.done = 0;
  _state.skipped = skipped;
  _renderModal();

  // Create the list first
  let listId;
  try{
    const user = window._currentUser || {};
    const list = await _sbPost('lead_lists', {
      name: _state.listName.trim(),
      source: 'csv',
      source_notes: _state.file ? _state.file.name : null,
      status: 'active',
      created_by_user_id: user.id || null,
    });
    listId = list && list.id;
    if(!listId) throw new Error('List creation returned no id');
  } catch(e){
    _showToast('Could not create list: ' + (e.message || e), 'error');
    _listsImportClose();
    return;
  }

  // Batched insert — 200 at a time
  const BATCH = 200;
  for(let i = 0; i < records.length; i += BATCH){
    const chunk = records.slice(i, i + BATCH).map(r => ({ ...r, list_id: listId }));
    try{
      await _sbPost('leads', chunk);
      _state.done = Math.min(i + chunk.length, records.length);
      _updateProgress();
    } catch(e){
      console.error('[lists.import] batch failed', e);
      _showToast('Batch failed: ' + (e.message || e), 'error');
      // Keep going — some rows still land.
    }
  }

  _showToast(`Imported ${_state.done.toLocaleString()} leads${skipped ? ` (${skipped} skipped)` : ''}`);
  _listsImportClose();
  // Jump into the new list
  if(typeof window.openLeadList === 'function') window.openLeadList(listId);
  else if(typeof window.showListsPage === 'function') window.showListsPage();
}

function _renderStepProgress(){
  return `
    <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0;">
      <h2 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">Importing…</h2>
    </div>
    <div style="padding:40px 24px;text-align:center;">
      <div id="importPct" style="font-size:32px;font-weight:700;color:#0f172a;margin-bottom:12px;">0%</div>
      <div style="background:#f1f5f9;height:8px;border-radius:4px;overflow:hidden;margin-bottom:12px;">
        <div id="importBar" style="width:0;height:100%;background:#0f172a;transition:width 0.2s;"></div>
      </div>
      <div id="importCount" style="font-size:13px;color:#64748b;">0 / ${_state.total.toLocaleString()}</div>
    </div>`;
}

function _updateProgress(){
  const pct = Math.round((_state.done / _state.total) * 100);
  const el1 = document.getElementById('importPct');
  const el2 = document.getElementById('importBar');
  const el3 = document.getElementById('importCount');
  if(el1) el1.textContent = pct + '%';
  if(el2) el2.style.width = pct + '%';
  if(el3) el3.textContent = `${_state.done.toLocaleString()} / ${_state.total.toLocaleString()}`;
}
