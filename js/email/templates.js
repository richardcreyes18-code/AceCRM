// email/templates.js — email templates + send modal + asset templates +
// AI email agent + marketing defaults.
//
// Phase 4 commit 3 of 11. The largest single migration so far (~1,700 lines,
// 39 exports). Bigger than the workbench/portfolios but fundamentally the
// same pattern.
//
// External dependencies on window.* (legacy script owns these):
//   state:    window.currentDeal (`let` in legacy → converted to `var` in
//             this commit), window._currentUser (already var), window.allDeals,
//             window.allBuyerContacts (already var), window._propertyTemplateMap
//             (`const` → `var` in this commit; lives in Email Region 2 still
//             in legacy at ~line 29732 post-deletion)
//   functions: window._emailTplsTabRender (Email Region 2, function decl),
//              window._rtMount (already attached via richText module),
//              window.airtableUpdate (function decl), window.showSaveConfirm
//              (now imported), window._sbGet/Patch (imported), window.getConfig
//
// Module-internal state (declared `let` at module scope):
//   _marketingSettings, _atplDraft

import { _sbGet, _sbPatch, _sbPost, _sbDelete } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';
import { SB_PROP_MAP } from '../schemas/deals.js';
import { _sbToAt } from '../schemas/field-map.js';

// ═══════════════════════════════════════════════════════════════════════
// LEGACY BLOCK BELOW — copied from index.html with `export` added to top-
// level declarations and external script-scope refs prefixed with `window.`.
// Internal logic is byte-identical.
// ═══════════════════════════════════════════════════════════════════════

// v113.11: Airtable-style field picker for the AI Email Template.
// The list below is the MASTER — a labeled slot has (a) a human label shown
// in the checkbox, (b) a getter that pulls the value off `window.currentDeal`,
// and (c) a stable key used for the localStorage pref. Toggling a box
// changes the pref and optionally the generated prompt on the next Run.
// v113.13: Expanded field list with groups. Every field from Property Details +
// Financial Analysis is available; defaults mirror what agents typically include
// in outbound emails. Each entry has:
//   k     — stable localStorage key
//   group — section header in the picker
//   label — displayed label and sent to AI
//   get   — getter against window.currentDeal (AT-style field names)
const EMAIL_TPL_FIELDS = [
  // ── Basic Info ────────────────────────────────────────────────────────────
  { k:'address',       group:'Basic Info',   label:'Address',               token:'{property address}', get:d=>d['Address'] },
  { k:'propType',      group:'Basic Info',   label:'Property Type',         token:'{property type}',    get:d=>d['Simple Text Property Type']||d['CRM Asset Classification'] },
  { k:'county',        group:'Basic Info',   label:'County',                token:'{county}',           get:d=>d['Simple County']||d['County'] },
  { k:'askingPrice',   group:'Basic Info',   label:'Asking Price',          token:'{asking price}',     get:d=>{ const v=d['Pitch Out Price']||d['Asking Price']; return v?'$'+Number(v).toLocaleString():''; } },
  { k:'pipeline',      group:'Basic Info',   label:'Pipeline Stage',        token:'{pipeline stage}',   get:d=>d['Pipeline Stage'] },

  // ── Property Description (own section per user request) ───────────────────
  { k:'propDesc',      group:'Property Description', label:'Property Description', token:'{property description}', get:d=>d['Property Description'] },
  { k:'propHighlights', group:'Property Description', label:'Property Highlights', token:'{property highlights}', get:d=>{
      // v188: returns the highlights as a bullet list joined by newlines so
      // the email reads naturally. Stored as JSONB array of strings.
      const raw = d['Property Highlights'];
      let arr = [];
      if(Array.isArray(raw)) arr = raw;
      else if(typeof raw === 'string'){
        try { const p = JSON.parse(raw); if(Array.isArray(p)) arr = p; } catch(_){ arr = raw.split('\n'); }
      }
      arr = arr.map(s => String(s||'').trim()).filter(Boolean);
      return arr.length ? arr.map(s => '• ' + s).join('\n') : '';
  } },

  // ── Physical Details ──────────────────────────────────────────────────────
  { k:'sqft',          group:'Physical',     label:'Building SF',           token:'{building sf}',      get:d=>{ const v=d['Square Footage']||d['Total Building SF']; return v?Number(v).toLocaleString()+' SF':''; } },
  { k:'netRentableSF', group:'Physical',     label:'Net Rentable SF',       token:'{net rentable sf}',  get:d=>{ const v=d['Net Rentable SF']; return v?Number(v).toLocaleString()+' SF':''; } },
  { k:'lotSize',       group:'Physical',     label:'Lot Size',              token:'{lot size}',         get:d=>{ const v=d['Total Lot Size']; return v?Number(v).toLocaleString()+' acres':''; } },
  { k:'units',         group:'Physical',     label:'# of Units',            token:'{units}',            get:d=>d['No. of Units']||d['Number of Units'] },  // v113.18: Unit Mix UI writes to 'No. of Units'; prefer it over the legacy 'Number of Units' column
  { k:'noOfBuildings', group:'Physical',     label:'# of Buildings',        token:'{buildings}',        get:d=>d['No. of Buildings'] },
  { k:'unitMix',       group:'Physical',     label:'Unit Mix',              token:'{unit mix}',         get:d=>d['Unit Mix'] },
  { k:'yearBuilt',     group:'Physical',     label:'Year Built',            token:'{year built}',       get:d=>d['Year Built'] },
  { k:'yearRenovated', group:'Physical',     label:'Year Renovated',        token:'{year renovated}',   get:d=>d['Year Renovated'] },
  { k:'occupancy',     group:'Physical',     label:'Occupancy %',           token:'{occupancy}',        get:d=>{ const v=d['Occupancy (%)']; return (v!=null&&v!=='')? v+'%':''; } },
  { k:'ownerOcc',      group:'Physical',     label:'Owner Occupied?',       token:'{owner occupied}',   get:d=>{ const v=d['Owner Occupied']; if(v===true)return'Yes'; if(v===false)return'No'; return v||''; } },
  { k:'propClass',     group:'Physical',     label:'Property Class',        token:'{property class}',   get:d=>d['Property Class'] },
  { k:'propCondition', group:'Physical',     label:'Property Condition',    token:'{property condition}', get:d=>d['Property Condition'] },
  { k:'noOfStories',   group:'Physical',     label:'# of Stories',          token:'{stories}',          get:d=>d['No. of Stories'] },
  { k:'parking',       group:'Physical',     label:'Parking Spaces',        token:'{parking}',          get:d=>d['No. of Parking Spaces'] },
  { k:'numTenants',    group:'Physical',     label:'# of Tenants',          token:'{num tenants}',      get:d=>d['Num Tenants'] },
  { k:'ceilingHeight', group:'Physical',     label:'Ceiling Height',        token:'{ceiling height}',   get:d=>{ const v=d['Ceiling Height Ft']; return (v!=null&&v!=='') ? v+' ft' : ''; } },

  // ── Financials (Actual) ───────────────────────────────────────────────────
  { k:'griMonthly',    group:'Financials',   label:'GRI (Monthly)',         token:'{gri monthly}',      get:d=>{ const v=d['Gross Rental Income (Monthly)']; return v?'$'+Number(v).toLocaleString()+'/mo':''; } },
  { k:'grossRevYearly',group:'Financials',   label:'Gross Revenue (yr)',    token:'{gross revenue}',    get:d=>{ const gri=d['Gross Revenue Yearly']; const mo=d['Gross Rental Income (Monthly)']; const v=gri||(mo?Number(mo)*12:null); return v?'$'+Number(v).toLocaleString():''; } },
  { k:'expensesYearly',group:'Financials',   label:'Expenses (yr)',         token:'{expenses}',         get:d=>{ const v=d['Expenses Yearly']||(d['Expenses Monthly']?Number(d['Expenses Monthly'])*12:null); return v?'$'+Number(v).toLocaleString():''; } },
  { k:'noi',           group:'Financials',   label:'NOI (yearly)',          token:'{noi}', get:d=>{
      // v113.18: compute NOI when the column is empty. NOI = Gross Revenue - Expenses.
      const stored = Number(d['NOI']);
      if(stored) return '$'+stored.toLocaleString();
      const gri = Number(d['Gross Revenue Yearly']) || (Number(d['Gross Rental Income (Monthly)'])*12) || 0;
      const exp = Number(d['Expenses Yearly'])       || (Number(d['Expenses Monthly'])*12)             || 0;
      const noi = gri - exp;
      if(gri && exp && noi > 0) return '$'+Math.round(noi).toLocaleString();
      // v185.1: derive from Cap Rate (CRM) × Asking Price as a final fallback.
      // The Financial Analysis tab shows a live-computed NOI built this way when
      // gross/expenses aren't separately stored — so the email check should
      // recognize it as "filled" too.
      const cap = Number(d['Cap Rate (CRM)']);
      const ask = Number(d['Asking Price']);
      if(cap > 0 && ask > 0) return '$'+Math.round(ask * cap).toLocaleString();
      return '';
  } },
  { k:'capRate',       group:'Financials',   label:'Cap Rate',              token:'{cap rate}',         get:d=>{ const v=d['Cap Rate (CRM)']; return (v!=null&&v!=='')? (Number(v)*100).toFixed(2)+'%':''; } },
  { k:'expenseRatio',  group:'Financials',   label:'Expense Ratio',         token:'{expense ratio}',    get:d=>{ const v=d['Actual Expense Ratio %']; return (v!=null&&v!=='')? Number(v).toFixed(1)+'%':''; } },
  { k:'pricePerSF',    group:'Financials',   label:'Price / SF',            token:'{price per sf}',     get:d=>{ const ask=Number(d['Asking Price']||d['Pitch Out Price']||0); const sf=Number(d['Square Footage']||d['Total Building SF']||0); return (ask&&sf)?'$'+(ask/sf).toFixed(2)+'/SF':''; } },
  { k:'pricePerUnit',  group:'Financials',   label:'Price / Unit',          token:'{price per unit}',   get:d=>{ const ask=Number(d['Asking Price']||d['Pitch Out Price']||0); const u=Number(d['Number of Units']||d['No. of Units']||0); return (ask&&u)?'$'+Math.round(ask/u).toLocaleString()+'/unit':''; } },
  { k:'vacancyRate',   group:'Financials',   label:'Vacancy Rate',          token:'{vacancy rate}',     get:d=>{ const v=d['Vacancy Rate (%)']; return (v!=null&&v!=='')? v+'%':''; } },
  { k:'annualDebtSvc', group:'Financials',   label:'Annual Debt Service',   token:'{annual debt service}', get:d=>{ const v=d['Annual Debt Service']; return v?'$'+Number(v).toLocaleString():''; } },
  { k:'dscr',          group:'Financials',   label:'DSCR',                  token:'{dscr}',             get:d=>d['DSCR (Manual)'] },

  // ── Pro Forma ─────────────────────────────────────────────────────────────
  { k:'pfGRIYearly',   group:'Pro Forma',    label:'Pro Forma GRI (yr)',    token:'{pro forma gri}',    get:d=>{ const v=d['Pro Forma Gross Revenue Yearly']||(d['Pro Forma Gross Revenue Monthly']?Number(d['Pro Forma Gross Revenue Monthly'])*12:null); return v?'$'+Number(v).toLocaleString():''; } },
  { k:'pfExpYearly',   group:'Pro Forma',    label:'Pro Forma Expenses (yr)', token:'{pro forma expenses}', get:d=>{ const v=d['Pro Forma Expenses Yearly']||(d['Pro Forma Expenses Monthly']?Number(d['Pro Forma Expenses Monthly'])*12:null); return v?'$'+Number(v).toLocaleString():''; } },
  { k:'pfNOI',         group:'Pro Forma',    label:'Pro Forma NOI',         token:'{pro forma noi}',    get:d=>{ const gri=Number(d['Pro Forma Gross Revenue Yearly']||(d['Pro Forma Gross Revenue Monthly']?Number(d['Pro Forma Gross Revenue Monthly'])*12:0)||0); const exp=Number(d['Pro Forma Expenses Yearly']||(d['Pro Forma Expenses Monthly']?Number(d['Pro Forma Expenses Monthly'])*12:0)||0); return (gri&&exp)?'$'+(gri-exp).toLocaleString():''; } },
  { k:'pfCapRate',     group:'Pro Forma',    label:'Pro Forma Cap Rate',    token:'{pro forma cap rate}', get:d=>{ const v=d['Cap Rate Proforma (CRM)']; return (v!=null&&v!=='')? (Number(v)*100).toFixed(2)+'%':''; } },
  { k:'pfExpRatio',    group:'Pro Forma',    label:'Pro Forma Expense Ratio', token:'{pro forma expense ratio}', get:d=>{ const v=d['Pro Forma Expense Ratio %']; return (v!=null&&v!=='')? Number(v).toFixed(1)+'%':''; } },

  // ── Notes & Deal Details ──────────────────────────────────────────────────
  { k:'genNotes',      group:'Notes',        label:'General Property Notes', token:'{general notes}',   get:d=>d['General Property Notes'] },
  { k:'finNotes',      group:'Notes',        label:'Financial Notes',        token:'{financial notes}', get:d=>d['Financial Property Notes'] },
  { k:'whySelling',    group:'Notes',        label:'Why Selling',            token:'{why selling}',     get:d=>d['Why Selling'] },
  { k:'sellerMotiv',   group:'Notes',        label:'Seller Motivation',      token:'{seller motivation}', get:d=>d['Seller Motivation Level'] },
];

// Defaults — pre-checked fields for a typical outbound marketing email.
// Keys must match the `k` values above.
const EMAIL_TPL_DEFAULTS = {
  enabled: {
    address:true, propType:true, askingPrice:true, pipeline:false, propDesc:false,
    sqft:true, netRentableSF:false, lotSize:true, units:true, noOfBuildings:false,
    unitMix:true, yearBuilt:true, yearRenovated:false, occupancy:false,
    ownerOcc:true, propClass:false, propCondition:false, noOfStories:false, parking:false,
    griMonthly:true, grossRevYearly:true, expensesYearly:true, noi:true,
    capRate:true, expenseRatio:false, pricePerSF:true, pricePerUnit:false,
    vacancyRate:false, annualDebtSvc:false, dscr:false,
    pfGRIYearly:false, pfExpYearly:false, pfNOI:false, pfCapRate:false, pfExpRatio:false,
    genNotes:true, finNotes:true, whySelling:false, sellerMotiv:false
  },
  signature: 'Richard Reyes, KW Commercial',
  tone: 'Professional, concise, and compelling',
  extra: ''
};

const EMAIL_TPL_LS_KEY = 'aceEmailTemplatePrefs_v1';

export function _emailTplLoadPrefs(){
  try{
    const raw = localStorage.getItem(EMAIL_TPL_LS_KEY);
    if(!raw) return { ...EMAIL_TPL_DEFAULTS };
    const p = JSON.parse(raw);
    return {
      enabled: { ...EMAIL_TPL_DEFAULTS.enabled, ...(p.enabled||{}) },
      signature: p.signature || EMAIL_TPL_DEFAULTS.signature,
      tone: p.tone || EMAIL_TPL_DEFAULTS.tone,
      extra: p.extra || ''
    };
  }catch(_e){ return { ...EMAIL_TPL_DEFAULTS }; }
}

export function _emailTplSavePrefs(){
  const enabled = {};
  EMAIL_TPL_FIELDS.forEach(f => {
    const el = document.getElementById('emailTplF_'+f.k);
    enabled[f.k] = !!el?.checked;
  });
  // v113.18: signature is now sourced from Settings → Marketing (per-agent),
  // not from a per-deal input. We keep the field in prefs for backwards compat
  // but don't read it from a DOM input anymore — runEmailAgent falls through
  // to the marketing default when prefs.signature is blank.
  const prefs = {
    enabled,
    signature: '',
    tone:      (document.getElementById('emailTplTone')?.value  || '').trim(),  // blank = use marketing default
    extra:     (document.getElementById('emailTplExtra')?.value || '').trim()
  };
  try{ localStorage.setItem(EMAIL_TPL_LS_KEY, JSON.stringify(prefs)); }catch(_e){}
  return prefs;
}

export function _emailTplRenderFields(){
  const grid = document.getElementById('emailTplFieldsGrid');
  if(!grid) return;
  const prefs = _emailTplLoadPrefs();
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');

  // Build grouped structure preserving insertion order
  const groupNames = [];
  const groupMap   = {};
  EMAIL_TPL_FIELDS.forEach(f => {
    const g = f.group || 'Other';
    if(!groupMap[g]){ groupMap[g] = []; groupNames.push(g); }
    groupMap[g].push(f);
  });

  // v113.14: each group = its own bordered card. Vertical stack of cards.
  // Fields within a card wrap left-to-right.
  let html = '';
  groupNames.forEach(g => {
    let fieldsHtml = '';
    groupMap[g].forEach(f => {
      const savedOn = prefs.enabled[f.k];
      const on = savedOn !== undefined ? savedOn : (EMAIL_TPL_DEFAULTS.enabled[f.k] !== false);
      let val = '';
      try { val = window.currentDeal ? (f.get(window.currentDeal) || '') : ''; } catch(_e){}
      const hasVal = String(val).trim() !== '';
      const dim = hasVal ? '' : 'color:#94a3b8;';
      const valHint = hasVal
        ? ' — <span style="color:#64748b;">'+esc(String(val).slice(0,35))+(String(val).length>35?'…':'')+'</span>'
        : ' <span style="font-size:10px;color:#cbd5e1;">(empty)</span>';
      fieldsHtml += `<label style="display:inline-flex;align-items:center;gap:5px;padding:2px 0;cursor:pointer;flex:0 0 auto;min-width:200px;${dim}" title="${esc(String(val))}">
        <input type="checkbox" id="emailTplF_${f.k}" ${on?'checked':''} onchange="_emailTplSavePrefs()" style="cursor:pointer;">
        <span>${esc(f.label)}${valHint}</span>
      </label>`;
    });
    html += `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;background:#fff;">
      <div style="font-size:10px;font-weight:700;color:#1e40af;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${esc(g)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px 18px;">${fieldsHtml}</div>
    </div>`;
  });
  grid.innerHTML = html;

  // v113.18: only tone + extra are per-deal. Signature lives in Marketing settings.
  const toneEl = document.getElementById('emailTplTone');   if(toneEl)  toneEl.value  = prefs.tone;
  const extraEl = document.getElementById('emailTplExtra'); if(extraEl) extraEl.value = prefs.extra;

  ['emailTplTone','emailTplExtra'].forEach(id => {
    const el = document.getElementById(id);
    if(el && !el._emailTplBound){
      el.addEventListener('change', _emailTplSavePrefs);
      el.addEventListener('blur',   _emailTplSavePrefs);
      el._emailTplBound = true;
    }
  });
}

export function _emailTplToggleAll(on){
  EMAIL_TPL_FIELDS.forEach(f => {
    const el = document.getElementById('emailTplF_'+f.k);
    if(el) el.checked = !!on;
  });
  _emailTplSavePrefs();
}

// ─── v113.14: Placeholders ───────────────────────────────────────────────────
// Placeholders are resolved at SEND TIME (or on demand, via "Preview" / insertion)
// by pulling from: current contact (_sellerName/etc.), current agent (window._currentUser,
// _companyDirectory), and current deal.
//
// Each entry:
//   token  — the text users type, including the braces. Case-insensitive match.
//   label  — human-readable pill label.
//   resolve — returns the string value for the current deal/contact/agent.
// Each resolver takes an optional `ctx` object: { contact, agent, deal }.
// When the contact is provided (from the send-modal recipient picker) we use it;
// otherwise the pills-preview resolver falls back to a blank contact — we
// DELIBERATELY don't default to the seller contact, because Send via Gmail
// must never silently target the owner of the property.
const EMAIL_TPL_PLACEHOLDERS = [
  // Contact (supplied explicitly at send time)
  { token:'{contact first name}', label:'Contact First Name', resolve:(ctx)=>{ const n=ctx?.contact?.name||''; return String(n).trim().split(/\s+/)[0]||''; } },
  { token:'{contact last name}',  label:'Contact Last Name',  resolve:(ctx)=>{ const n=ctx?.contact?.name||''; const p=String(n).trim().split(/\s+/); return p.length>1?p.slice(1).join(' '):''; } },
  { token:'{contact full name}',  label:'Contact Full Name',  resolve:(ctx)=>String(ctx?.contact?.name||'').trim() },
  { token:'{contact phone}',      label:'Contact Phone',      resolve:(ctx)=>String(ctx?.contact?.phone_number||ctx?.contact?.phone||'').trim() },
  { token:'{contact email}',      label:'Contact Email',      resolve:(ctx)=>String(ctx?.contact?.email||'').trim() },
  { token:'{contact company}',    label:'Contact Company',    resolve:(ctx)=>String(ctx?.contact?.company||'').trim() },
  // Agent (the logged-in user)
  { token:'{agent name}',         label:'Agent Name',         resolve:()=>{ return (window._currentUser?.fub_name || window._currentUser?.name || '').trim(); } },
  { token:'{agent first name}',   label:'Agent First Name',   resolve:()=>{ const n=window._currentUser?.fub_name||window._currentUser?.name||''; return String(n).trim().split(/\s+/)[0]||''; } },
  { token:'{agent email}',        label:'Agent Email',        resolve:()=>String(window._currentUser?.email||'').trim() },
  { token:'{agent phone}',        label:'Agent Phone',        resolve:()=>{ const me=(window._currentUser?.fub_name||window._currentUser?.name||'').trim().toLowerCase(); const dir=(typeof _companyDirectory!=='undefined'&&Array.isArray(_companyDirectory))?_companyDirectory:[]; const hit=dir.find(a=>String(a.name||'').trim().toLowerCase()===me); return String(hit?.phone||'').trim(); } },
  // Property tokens are auto-extended below from EMAIL_TPL_FIELDS so any
  // field added there with a `token` is automatically resolvable at send
  // time. The three legacy property entries below stay as canonical
  // resolvers (the auto-extender skips tokens already present).
  { token:'{property address}',   label:'Property Address',   resolve:()=>String(window.currentDeal?.['Address']||'').trim() },
  { token:'{property type}',      label:'Property Type',      resolve:()=>String(window.currentDeal?.['Simple Text Property Type']||window.currentDeal?.['CRM Asset Classification']||'').trim() },
  { token:'{asking price}',       label:'Asking Price',       resolve:()=>{ const v=window.currentDeal?.['Pitch Out Price']||window.currentDeal?.['Asking Price']; return v?'$'+Number(v).toLocaleString():''; } },
];

// v177: auto-derive deal-field placeholders from EMAIL_TPL_FIELDS so the AI
// can emit tokens for any field, and the resolver auto-handles substitution.
// EMAIL_TPL_FIELDS is the source of truth — adding a `token` to a field
// makes it instantly tokenizable in emails.
// v255: Rich-text widget migrated to js/widgets/rich-text.js.
// _rtMount is attached to window.* by js/main.js; the 4 internal
// helpers (_rtTextToHTML, _rtLooksLikeHTML, _rtSanitizePaste,
// _rtBuildToolbar) are now module-private.

(function _emailExtendPlaceholdersFromFields(){
  if(typeof EMAIL_TPL_FIELDS === 'undefined' || !Array.isArray(EMAIL_TPL_FIELDS)) return;
  const have = new Set(EMAIL_TPL_PLACEHOLDERS.map(p => p.token.toLowerCase()));
  EMAIL_TPL_FIELDS.forEach(f => {
    if(!f.token) return;
    if(have.has(f.token.toLowerCase())) return;
    EMAIL_TPL_PLACEHOLDERS.push({
      token: f.token,
      label: f.label,
      resolve: () => {
        try {
          const d = window.currentDeal || {};
          // v185.1: explicit N/A → resolve to literal "N/A" so the rendered
          // email reflects the agent's choice ("Ceiling Height: N/A") instead
          // of leaving an empty placeholder.
          const naCol = (typeof _ATPL_NA_COL_BY_KEY === 'object') ? _ATPL_NA_COL_BY_KEY[f.k] : null;
          if(naCol){
            const raw = d['NA Fields'];
            const naList = Array.isArray(raw) ? raw
                         : (typeof raw === 'string' ? (function(){ try{ const a = JSON.parse(raw); return Array.isArray(a)?a:[]; }catch(_){ return []; } })() : []);
            if(naList.includes(naCol)) return 'N/A';
          }
          const v = f.get(d);
          return (v == null || v === '') ? '' : String(v).trim();
        } catch(_e){ return ''; }
      }
    });
    have.add(f.token.toLowerCase());
  });
})();

// Replace every known placeholder in `text` with its resolved value.
// Case-insensitive, whitespace inside braces is tolerated ({ agent name } also matches).
// ctx = { contact: {name, email, phone_number, company, ...}, ... }
export function _emailResolvePlaceholders(text, ctx){
  if(!text) return '';
  let out = String(text);
  EMAIL_TPL_PLACEHOLDERS.forEach(p => {
    const inner = p.token.replace(/^\{|\}$/g, '').trim();
    const re = new RegExp('\\{\\s*' + inner.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*\\}', 'gi');
    try { out = out.replace(re, p.resolve(ctx) || ''); } catch(_e){}
  });
  return out;
}

// Render the placeholder pills. Clicking one inserts the token at the cursor
// of whichever field was focused last (subject or body), falling back to body.
export function _emailTplRenderPlaceholders(){
  const wrap = document.getElementById('emailTplPlaceholders');
  if(!wrap) return;
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  wrap.innerHTML = EMAIL_TPL_PLACEHOLDERS.map(p => {
    // Render with no contact context — contact tokens will show "(pick recipient)"
    // as their preview, making it obvious they resolve at send time.
    let preview = '';
    try { preview = p.resolve({ contact: null }) || ''; } catch(_e){}
    const isContactToken = p.token.startsWith('{contact');
    const hasVal = preview && String(preview).trim() !== '';
    let tip, hint, swatch;
    if(isContactToken){
      tip = 'Resolved at send time from the recipient you pick';
      hint = '(pick recipient)';
      swatch = { bg:'#fef3c7', bd:'#fde68a', fg:'#92400e' };
    } else if(hasVal){
      tip = esc(String(preview).slice(0,60));
      hint = null;
      swatch = { bg:'#fff', bd:'#c7d2fe', fg:'#3730a3' };
    } else {
      tip = 'no value on current deal';
      hint = null;
      swatch = { bg:'#f8fafc', bd:'#e2e8f0', fg:'#94a3b8' };
    }
    return `<button type="button" onclick="_emailInsertPlaceholder('${p.token.replace(/'/g,"\\'")}')"
      title="${tip}"
      style="padding:3px 8px;font-size:11px;border:1px solid ${swatch.bd};background:${swatch.bg};color:${swatch.fg};border-radius:12px;cursor:pointer;font-family:ui-monospace,Menlo,monospace;">
      ${esc(p.token)}${hint?` <span style="font-family:inherit;opacity:0.7;">${hint}</span>`:''}
    </button>`;
  }).join('');
}

// Track which text field was last focused so placeholder pills insert into
// the right place (subject vs body).
let _emailLastFocus = 'emailTemplateText';
export function _emailBindFocus(){
  ['emailTemplateSubject','emailTemplateText'].forEach(id => {
    const el = document.getElementById(id);
    if(el && !el._emailFocusBound){
      el.addEventListener('focus', () => { _emailLastFocus = id; });
      el._emailFocusBound = true;
    }
  });
}
export function _emailInsertPlaceholder(token){
  const el = document.getElementById(_emailLastFocus) || document.getElementById('emailTemplateText');
  if(!el) return;
  // v187: contenteditable path — use Selection / execCommand to insert at cursor.
  if(el.isContentEditable){
    el.focus();
    try { document.execCommand('insertText', false, token); }
    catch(_e){ el.appendChild(document.createTextNode(token)); }
    el.dispatchEvent(new Event('input', { bubbles:true }));
    return;
  }
  // <input> / <textarea> path — slice .value at the cursor.
  const start = el.selectionStart ?? el.value.length;
  const end   = el.selectionEnd   ?? el.value.length;
  el.value = el.value.slice(0, start) + token + el.value.slice(end);
  const pos = start + token.length;
  el.focus();
  try { el.setSelectionRange(pos, pos); } catch(_e){}
}

// ─── v113.14: Saved Email Templates (per-user + per-deal library) ────────────
// Templates live in ace_user_email_templates, scoped by (user_email, property_id,
// name). One per user-deal may be marked is_official — that's the default picked
// when composing / sending on that specific deal.
// v113.17: scoped per-deal — a template saved on 1722 Stout no longer shows up
// when you open 105 10th Ave.
let _emailTemplates = [];          // cache for current user + current deal
let _currentTemplateId = null;     // id of currently-loaded template, or null

export async function _loadUserTemplatesList(){
  if(!isSupabase()) return;
  const email = window._currentUser?.email;
  if(!email) return;
  const propId = window.currentDeal?.id || null;
  try{
    // v113.17: filter by property_id — only templates for this specific deal
    const propFilter = propId ? `&property_id=eq.${encodeURIComponent(propId)}` : '&property_id=is.null';
    const rows = await _sbGet('ace_user_email_templates',
      `user_email=eq.${encodeURIComponent(email)}${propFilter}&order=is_official.desc`);
    const list = Array.isArray(rows) ? rows : [];
    // Secondary sort by name, client-side (proxy only supports one order col)
    list.sort((a,b) => (b.is_official?1:0) - (a.is_official?1:0) || String(a.name||'').localeCompare(String(b.name||'')));
    _emailTemplates = list;
  }catch(_e){ _emailTemplates = []; }
  _renderTemplatePicker();
}

export function _renderTemplatePicker(){
  const sel = document.getElementById('emailTplPicker');
  if(!sel) return;
  const esc = s => String(s||'').replace(/</g,'&lt;');
  const current = _currentTemplateId || '';
  let html = '<option value="">— New / Unsaved —</option>';
  _emailTemplates.forEach(t => {
    const star = t.is_official ? '★ ' : '';
    html += `<option value="${t.id}" ${current===t.id?'selected':''}>${esc(star+t.name)}</option>`;
  });
  sel.innerHTML = html;
  const stat = document.getElementById('emailTplStatus');
  if(stat){
    const officialName = _emailTemplates.find(t => t.is_official)?.name || '(none set)';
    stat.textContent = 'Official: ' + officialName;
  }
}

export async function loadSavedTemplate(id){
  if(!id){
    // v200: picking "— New / Unsaved —" now clears the form so the user
    // gets a blank canvas to write a new template from scratch. Save / Save As
    // will create a new loadable template afterwards.
    // _rtMount swaps the textarea for a contenteditable div sharing the same
    // id; its `.value` setter mirrors innerHTML, so this clears both modes.
    _currentTemplateId = null;
    const subEl = document.getElementById('emailTemplateSubject');
    const bodyEl= document.getElementById('emailTemplateText');
    if(subEl)  subEl.value = '';
    if(bodyEl) bodyEl.value = '';
    const toneEl = document.getElementById('emailTplTone');  if(toneEl)  toneEl.value = '';
    const extraEl= document.getElementById('emailTplExtra'); if(extraEl) extraEl.value= '';
    if(typeof _atplRefreshStatusBar === 'function') _atplRefreshStatusBar();
    _renderTemplatePicker?.();
    return;
  }
  const t = _emailTemplates.find(x => x.id === id);
  if(!t) return;
  _currentTemplateId = id;
  const subEl = document.getElementById('emailTemplateSubject');
  const bodyEl= document.getElementById('emailTemplateText');
  if(subEl)  subEl.value  = t.subject || '';
  if(bodyEl) bodyEl.value = t.body || '';
  // Restore per-deal settings (tone, extra). v113.18: signature comes from Marketing settings.
  const toneEl= document.getElementById('emailTplTone');  if(toneEl)  toneEl.value  = t.tone || '';
  const extraEl=document.getElementById('emailTplExtra'); if(extraEl) extraEl.value = t.extra_instructions || '';
  if(t.fields_enabled && typeof t.fields_enabled === 'object'){
    EMAIL_TPL_FIELDS.forEach(f => {
      const el = document.getElementById('emailTplF_'+f.k);
      if(el) el.checked = t.fields_enabled[f.k] !== false;
    });
    _emailTplSavePrefs();
  }
  // v113.16: DO NOT auto-save to the current deal. Picking a template fills
  // the UI only — the user must explicitly click Save to persist the body to
  // this deal. This prevents cross-deal template leakage where opening a deal
  // would overwrite it with the official template content.
  _renderTemplatePicker();
}

export function _collectCurrentTemplatePayload(){
  const subject = document.getElementById('emailTemplateSubject')?.value || '';
  const body    = document.getElementById('emailTemplateText')?.value    || '';
  const prefs   = _emailTplSavePrefs();
  return {
    user_email:  window._currentUser?.email || '',
    property_id: window.currentDeal?.id || null,  // v113.17: scope to current deal
    subject, body,
    signature: prefs.signature || null,
    tone: prefs.tone || null,
    extra_instructions: prefs.extra || null,
    fields_enabled: prefs.enabled || {}
  };
}

export async function saveAsTemplate(){
  if(!isSupabase()){ alert('Saved templates require Supabase mode.'); return; }
  if(!window._currentUser?.email){ alert('Sign in first.'); return; }
  const name = (prompt('Name this template (e.g. "Cold Outreach — Industrial"):','') || '').trim();
  if(!name) return;
  if(_emailTemplates.some(t => t.name.toLowerCase() === name.toLowerCase())){
    if(!confirm('A template named "'+name+'" already exists. Overwrite?')) return;
    // Use update path
    const existing = _emailTemplates.find(t => t.name.toLowerCase() === name.toLowerCase());
    _currentTemplateId = existing.id;
    await saveCurrentTemplate();
    return;
  }
  const payload = { name, ..._collectCurrentTemplatePayload() };
  // If this is the user's first template, make it official automatically
  if(_emailTemplates.length === 0) payload.is_official = true;
  try{
    const rows = await _sbPost('ace_user_email_templates', payload);
    const saved = Array.isArray(rows) ? rows[0] : rows;
    if(saved?.id){
      _currentTemplateId = saved.id;
      await _loadUserTemplatesList();
      showSaveConfirm('✓ Template "'+name+'" saved'+(payload.is_official?' (set as official)':''));
    }
  }catch(e){ alert('Save failed: '+e.message); }
}

export async function saveCurrentTemplate(){
  if(!_currentTemplateId){ return saveAsTemplate(); }
  const payload = _collectCurrentTemplatePayload();
  delete payload.user_email;  // don't reassign owner
  delete payload.property_id; // don't reparent a template to a different deal
  try{
    await _sbPatch('ace_user_email_templates', _currentTemplateId, payload);
    await _loadUserTemplatesList();
    showSaveConfirm('✓ Template updated');
  }catch(e){ alert('Save failed: '+e.message); }
}

export async function makeTemplateOfficial(){
  if(!_currentTemplateId){ alert('Load a saved template first, then click Make Official.'); return; }
  if(!window._currentUser?.email) return;
  try{
    // v113.17: _emailTemplates is now already scoped to this deal, so clearing
    // "others" only clears other templates for this same deal (the partial
    // unique index on (user_email, property_id) WHERE is_official blocks
    // multiple official rows per deal, so we clear first).
    const others = _emailTemplates.filter(t => t.is_official && t.id !== _currentTemplateId);
    for(const t of others){
      await _sbPatch('ace_user_email_templates', t.id, { is_official: false });
    }
    // Now set the current one as official
    await _sbPatch('ace_user_email_templates', _currentTemplateId, { is_official: true });
    await _loadUserTemplatesList();
    showSaveConfirm('★ Template set as official');
  }catch(e){ alert('Update failed: '+e.message); }
}

export async function deleteCurrentTemplate(){
  if(!_currentTemplateId){ alert('No template selected.'); return; }
  const t = _emailTemplates.find(x => x.id === _currentTemplateId);
  if(!t) return;
  if(!confirm('Delete template "'+t.name+'"? This cannot be undone.')) return;
  try{
    await _sbDelete('ace_user_email_templates', _currentTemplateId);
    _currentTemplateId = null;
    await _loadUserTemplatesList();
    showSaveConfirm('✓ Template deleted');
  }catch(e){ alert('Delete failed: '+e.message); }
}

// ─── v113.17: Marketing defaults (user-global, applied on every Run Agent) ───
// Stored in ace_user_marketing_settings. Loaded once on Settings open, applied
// by runEmailAgent by appending to the per-deal extra instructions field.
let _marketingSettings = null;

export async function _marketingLoad(){
  if(!isSupabase() || !window._currentUser?.email) return;
  try{
    const rows = await _sbGet('ace_user_marketing_settings',
      `user_email=eq.${encodeURIComponent(window._currentUser.email)}&limit=1`);
    _marketingSettings = (Array.isArray(rows) && rows[0]) || null;
  }catch(_e){ _marketingSettings = null; }
  _marketingPopulateForm();
}

export function _marketingPopulateForm(){
  const s = _marketingSettings || {};
  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.value = v||''; };
  set('mkgDefaultTone',      s.default_tone);
  set('mkgDefaultSubject',   s.default_subject_template);
  set('mkgDefaultPrompt',    s.default_prompt);
  set('mkgStyleGuide',       s.style_guide);
  set('mkgDefaultSignature', s.default_signature);
  // v183: re-render the asset-template editor when settings load
  if(typeof _atplRenderEditor === 'function') _atplRenderEditor();
}

// ─── v183: Asset-type email templates ────────────────────────────────────────
// Per-asset-type templates stored in ace_user_marketing_settings.asset_templates.
// Each template: { subject, body, required_fields:[field_key,...] }.
// AI Comm tab "Apply Template" button auto-picks the right one based on the
// deal's asset type + owner-occupied status.

const ASSET_TPL_KEYS = [
  { slug:'industrial_investment',     label:'🏭 Industrial — Investment Property' },
  { slug:'industrial_owner_occupied', label:'🏭 Industrial — Owner Occupied' },
  { slug:'multifamily',               label:'🏘️ Multifamily' },
  { slug:'mixed_use',                 label:'🏢 Mixed Use' },
  { slug:'retail',                    label:'🛍️ Retail' },
  { slug:'office',                    label:'🏢 Office' },
  { slug:'land',                      label:'🌱 Land' },
  { slug:'automotive',                label:'⛽ Automotive / Gas' },
  { slug:'special_purpose',           label:'🎯 Special Purpose' },
  { slug:'generic',                   label:'📄 Generic (fallback)' },
];

// Default required fields per the user's spec.
// v188: propHighlights is now its own field, satisfying the "at least one
// property highlight" requirement directly instead of leaning on propDesc.
const ASSET_TPL_DEFAULT_REQUIRED = [
  'propType','county','address','propHighlights','numTenants','sqft','ceilingHeight','askingPrice','grossRevYearly','noi'
];

// Sensible starter templates. The user can edit any of these from Settings →
// Marketing. Industrial Investment seeds with the user's screenshot template.
const ASSET_TPL_DEFAULTS = {
  industrial_investment: {
    subject: '{property type} | {property address} | {agent name}',
    body:
`Hey {contact first name},

I'm reaching out with an off-market industrial / warehouse opportunity located at {property address} in {county}.

PROPERTY OVERVIEW
{building sf} square foot facility on a {lot size} lot, built in {year built}. {ceiling height} clear ceiling height. {property class} class building, {property condition} condition.

PROPERTY HIGHLIGHTS
{property highlights}

TENANCY
{num tenants} tenant(s). {occupancy} occupancy.

FINANCIAL HIGHLIGHTS
- Gross Revenue: {gross revenue}/yr
- Expenses: {expenses}/yr
- Net Operating Income: {noi}
- Cap Rate: {cap rate}
- Price / SF: {price per sf}

ASKING PRICE: {asking price}

{property description}

Please reply with your initial thoughts or availability for a quick call — happy to walk through the numbers.

Thank you,
{agent name}`,
    required_fields: ASSET_TPL_DEFAULT_REQUIRED.slice(),
  },
  industrial_owner_occupied: {
    subject: 'Owner-Occupied Industrial | {property address} | {agent name}',
    body:
`Hey {contact first name},

I have an off-market owner-occupied industrial property at {property address} in {county} — owner is open to a sale-leaseback or vacating at close.

PROPERTY OVERVIEW
{building sf} SF on {lot size}, built in {year built}. {ceiling height} clear ceiling, {property class} class.

ASKING PRICE: {asking price}
Price / SF: {price per sf}

{property description}

Open to a quick call to walk through the deal?

{agent name}`,
    required_fields: ['propType','county','address','propDesc','sqft','ceilingHeight','askingPrice'],
  },
  multifamily: {
    subject: 'Multifamily | {property address} | {units} units',
    body:
`Hey {contact first name},

Off-market multifamily opportunity at {property address} ({county}). {units} units, {occupancy} occupied.

FINANCIALS
- Gross Rental Income: {gri monthly}
- NOI: {noi}
- Cap Rate: {cap rate}
- Price / Unit: {price per unit}

ASKING PRICE: {asking price}

{property description}

Worth a look?

{agent name}`,
    required_fields: ['propType','county','address','units','occupancy','griMonthly','noi','capRate','askingPrice'],
  },
  mixed_use: {
    subject: 'Mixed Use | {property address} | {agent name}',
    body:
`Hey {contact first name},

Off-market mixed-use deal at {property address} in {county}. {building sf} SF total combining residential and commercial uses.

FINANCIALS
- Gross Revenue: {gross revenue}
- NOI: {noi}
- Cap Rate: {cap rate}

ASKING PRICE: {asking price}

{property description}

Quick call to discuss?

{agent name}`,
    required_fields: ['propType','county','address','sqft','grossRevYearly','noi','askingPrice'],
  },
  retail: {
    subject: 'Retail | {property address} | {cap rate} cap',
    body:
`Hey {contact first name},

Off-market retail opportunity at {property address} in {county}.

PROPERTY
- {building sf} SF, {num tenants} tenant(s), {occupancy} occupied

FINANCIALS
- NOI: {noi}
- Cap Rate: {cap rate}
- Price / SF: {price per sf}

ASKING PRICE: {asking price}

{property description}

Reply with thoughts or availability for a call.

{agent name}`,
    required_fields: ['propType','county','address','sqft','numTenants','noi','capRate','askingPrice'],
  },
  office: {
    subject: 'Office | {property address} | {agent name}',
    body:
`Hey {contact first name},

Off-market office building at {property address} in {county}.

PROPERTY
- {building sf} SF, {property class} class
- {num tenants} tenant(s), {occupancy} occupied

FINANCIALS
- NOI: {noi}
- Cap Rate: {cap rate}

ASKING PRICE: {asking price}

{property description}

Worth a look?

{agent name}`,
    required_fields: ['propType','county','address','sqft','propClass','noi','capRate','askingPrice'],
  },
  land: {
    subject: 'Land | {property address} | {lot size}',
    body:
`Hey {contact first name},

Off-market land opportunity at {property address} in {county}. {lot size}.

ASKING PRICE: {asking price}
Price / SF: {price per sf}

{property description}

Open to a quick call?

{agent name}`,
    required_fields: ['propType','county','address','lotSize','askingPrice'],
  },
  automotive: {
    subject: 'Automotive | {property address} | {agent name}',
    body:
`Hey {contact first name},

Off-market automotive / gas station at {property address} in {county}.

PROPERTY
- {building sf} SF on {lot size}, built {year built}

FINANCIALS
- NOI: {noi}
- Cap Rate: {cap rate}

ASKING PRICE: {asking price}

{property description}

{agent name}`,
    required_fields: ['propType','county','address','sqft','noi','capRate','askingPrice'],
  },
  special_purpose: {
    subject: 'Special Purpose | {property address}',
    body:
`Hey {contact first name},

Off-market special-purpose property at {property address} in {county}.

{building sf} SF on {lot size}, {property class} class.

ASKING PRICE: {asking price}

{property description}

{agent name}`,
    required_fields: ['propType','county','address','sqft','askingPrice'],
  },
  generic: {
    subject: '{property type} | {property address}',
    body:
`Hey {contact first name},

Off-market {property type} at {property address} in {county}.

{property description}

ASKING PRICE: {asking price}

{agent name}`,
    required_fields: ['propType','county','address','askingPrice'],
  },
};

// Resolve which template applies to a given deal.
// Industrial logic: owner-occupied AND no tenants → owner_occupied.
// Anything else industrial (including partial owner-occupied) → investment.
export function _resolveAssetTemplateKey(d){
  if(!d) return 'generic';
  const type = String(d['Simple Text Property Type'] || d['CRM Asset Classification'] || '').toLowerCase();
  if(type.includes('industrial') || type.includes('warehouse') || type.includes('flex')){
    const ownerOcc = d['Owner Occupied'] === true || d['Owner Occupied'] === 'Yes';
    const numTenants = Number(d['Num Tenants']) || 0;
    let tenantMixHasRows = false;
    try {
      const raw = d['Tenant Mix Data'];
      if(raw){
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        tenantMixHasRows = Array.isArray(arr) && arr.length > 0;
      }
    } catch(_e){}
    if(ownerOcc && numTenants === 0 && !tenantMixHasRows) return 'industrial_owner_occupied';
    return 'industrial_investment';
  }
  if(type.includes('multifamily') || type.includes('apartment') || type.includes('residential')) return 'multifamily';
  if(type.includes('mixed')) return 'mixed_use';
  if(type.includes('retail') || type.includes('shopping') || type.includes('strip')) return 'retail';
  if(type.includes('office')) return 'office';
  if(type.includes('land') || type.includes('vacant')) return 'land';
  if(type.includes('automotive') || type.includes('gas') || type.includes('car wash')) return 'automotive';
  if(type.includes('special') || type.includes('hotel') || type.includes('medical')) return 'special_purpose';
  return 'generic';
}

// Read a template by slug, falling back to defaults if the user hasn't
// customized this slug yet. _marketingSettings.asset_templates is the source
// of truth for user edits.
export function _getAssetTemplate(slug){
  const userMap = (_marketingSettings && _marketingSettings.asset_templates) || {};
  const userTpl = userMap[slug];
  const defTpl  = ASSET_TPL_DEFAULTS[slug] || ASSET_TPL_DEFAULTS.generic;
  return {
    subject:         (userTpl && userTpl.subject) || defTpl.subject || '',
    body:            (userTpl && userTpl.body)    || defTpl.body    || '',
    required_fields: (userTpl && Array.isArray(userTpl.required_fields))
                       ? userTpl.required_fields
                       : (defTpl.required_fields || []),
    isCustom:        !!(userTpl && (userTpl.subject || userTpl.body)),
  };
}

// Compute which required fields are empty for this deal. Returns an array of
// EMAIL_TPL_FIELDS objects (label / token) so the caller can render a list.
// v185.1: skip fields the user has explicitly marked N/A (stored in
// d['NA Fields'] as snake_case column names). N/A is a valid answer ("we
// don't have it / not applicable") and shouldn't appear as missing.
const _ATPL_NA_COL_BY_KEY = {
  ceilingHeight: 'ceiling_height_ft',
  propHighlights:'property_highlights',
  numTenants:    'num_tenants',
  units:         'no_of_units',
  yearBuilt:     'year_built',
  yearRenovated: 'year_renovated',
  occupancy:     'occupancy_pct',
  lotSize:       'total_lot_size',
  noOfBuildings: 'no_of_buildings',
  noOfStories:   'no_of_stories',
  parking:       'no_of_parking_spaces',
  netRentableSF: 'net_rentable_sf',
  sqft:          'square_footage',
  capRate:       'cap_rate_crm',
  pfCapRate:     'cap_rate_proforma_crm',
  vacancyRate:   'vacancy_rate_pct',
  annualDebtSvc: 'annual_debt_service',
  dscr:          'dscr_manual',
  expenseRatio:  'actual_expense_ratio_pct',
  pfExpRatio:    'proforma_expense_ratio_pct',
  county:        'county',
  propClass:     'property_class',
  propCondition: 'property_condition',
  ownerOcc:      'owner_occupied',
};
export function _missingRequiredFields(d, requiredKeys){
  if(!Array.isArray(requiredKeys) || !d) return [];
  const naList = Array.isArray(d['NA Fields']) ? d['NA Fields']
               : (typeof d['NA Fields'] === 'string'
                    ? (function(){ try { const a = JSON.parse(d['NA Fields']); return Array.isArray(a)?a:[]; } catch(_){ return []; } })()
                    : []);
  const out = [];
  for(const key of requiredKeys){
    const f = EMAIL_TPL_FIELDS.find(x => x.k === key);
    if(!f) continue;
    const naCol = _ATPL_NA_COL_BY_KEY[key];
    if(naCol && naList.includes(naCol)) continue; // explicitly N/A — counts as filled
    let v = '';
    try { v = f.get(d); } catch(_e){}
    if(v == null || String(v).trim() === '') out.push(f);
  }
  return out;
}

// v183: Asset-Template editor module — paints the picker + subject/body
// textareas + required-field checkboxes inside the Marketing settings tab.
let _atplDraft = null;
let _atplActiveSlug = 'industrial_investment';

export function _atplLoadDraft(){
  const userMap = (_marketingSettings && _marketingSettings.asset_templates) || {};
  _atplDraft = {};
  ASSET_TPL_KEYS.forEach(({slug}) => {
    const def = ASSET_TPL_DEFAULTS[slug] || ASSET_TPL_DEFAULTS.generic;
    const u = userMap[slug] || {};
    _atplDraft[slug] = {
      subject: (u.subject != null && u.subject !== '') ? u.subject : (def.subject || ''),
      body:    (u.body    != null && u.body    !== '') ? u.body    : (def.body    || ''),
      required_fields: Array.isArray(u.required_fields) ? u.required_fields.slice() : (def.required_fields || []).slice(),
    };
  });
}
window._atplCaptureCurrent = function(){
  if(!_atplDraft || !_atplActiveSlug) return;
  const sub = document.getElementById('atplSubject');
  const bod = document.getElementById('atplBody');
  if(sub) _atplDraft[_atplActiveSlug].subject = sub.value;
  if(bod) _atplDraft[_atplActiveSlug].body    = bod.value;
  const reqs = [];
  document.querySelectorAll('input[data-atpl-req]:checked').forEach(el => reqs.push(el.dataset.atplReq));
  _atplDraft[_atplActiveSlug].required_fields = reqs;
};
window._atplSelect = function(slug){
  if(typeof _atplCaptureCurrent === 'function') _atplCaptureCurrent();
  _atplActiveSlug = slug;
  if(typeof _atplRenderEditor === 'function') _atplRenderEditor();
};
window._atplResetCurrent = function(){
  if(!_atplActiveSlug) return;
  const def = ASSET_TPL_DEFAULTS[_atplActiveSlug] || ASSET_TPL_DEFAULTS.generic;
  if(!_atplDraft) _atplDraft = {};
  _atplDraft[_atplActiveSlug] = {
    subject: def.subject || '',
    body: def.body || '',
    required_fields: (def.required_fields || []).slice(),
  };
  if(typeof _atplRenderEditor === 'function') _atplRenderEditor();
};
export function _atplRenderEditor(){
  if(!_atplDraft) _atplLoadDraft();
  const root = document.getElementById('atplEditorRoot');
  if(!root) return;
  const cur = _atplDraft[_atplActiveSlug] || { subject:'', body:'', required_fields:[] };
  const safeSubj = String(cur.subject||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const safeBody = String(cur.body||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const requiredSet = new Set(cur.required_fields || []);
  // Asset selector chips
  const chips = ASSET_TPL_KEYS.map(({slug, label}) => {
    const isActive = slug === _atplActiveSlug;
    return `<button type="button" onclick="_atplSelect('${slug}')" style="background:${isActive?'#1e3a8a':'#fff'};color:${isActive?'#fff':'#475569'};border:1px solid ${isActive?'#1e3a8a':'#cbd5e1'};padding:5px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">${label}</button>`;
  }).join('');
  // Required-field checkboxes grouped by EMAIL_TPL_FIELDS group
  const groups = {};
  EMAIL_TPL_FIELDS.forEach(f => {
    const g = f.group || 'Other';
    if(!groups[g]) groups[g] = [];
    groups[g].push(f);
  });
  const fieldsHTML = Object.entries(groups).map(([group, fields]) => `
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">${group}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${fields.map(f => {
          const on = requiredSet.has(f.k);
          return `<label style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:${on?'#dbeafe':'#fff'};border:1px solid ${on?'#1e3a8a':'#cbd5e1'};border-radius:99px;cursor:pointer;font-size:11px;color:${on?'#1e40af':'#475569'};">
            <input type="checkbox" data-atpl-req="${f.k}" ${on?'checked':''} onchange="_atplCaptureCurrent();_atplRenderEditor()" style="margin:0;" />
            ${f.label}
          </label>`;
        }).join('')}
      </div>
    </div>
  `).join('');
  root.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">${chips}</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin:0 0 4px;">
      <label style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;">Subject template</label>
      <button type="button" onclick="_atplResetCurrent()" title="Reset this asset's template to the default" style="background:none;border:1px solid #cbd5e1;color:#475569;border-radius:4px;padding:3px 10px;font-size:10px;font-weight:600;cursor:pointer;">↺ Reset to default</button>
    </div>
    <input id="atplSubject" type="text" value="${safeSubj}" oninput="_atplCaptureCurrent()" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:ui-monospace,Menlo,monospace;box-sizing:border-box;" placeholder="{property type} | {property address}" />
    <label style="display:block;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 4px;">Body template <span style="color:#94a3b8;font-weight:500;text-transform:none;letter-spacing:0;">(use {tokens} — they resolve to live deal values at send time)</span></label>
    <textarea id="atplBody" rows="16" oninput="_atplCaptureCurrent()" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-family:ui-monospace,Menlo,monospace;line-height:1.5;resize:vertical;box-sizing:border-box;" placeholder="Hey {contact first name},&#10;...">${safeBody}</textarea>
    <label style="display:block;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 4px;">Required fields <span style="color:#94a3b8;font-weight:500;text-transform:none;letter-spacing:0;">(missing values surface as a warning on the deal's AI Communication tab)</span></label>
    <div>${fieldsHTML}</div>
  `;
  // v187: mount rich-text editor on the asset-template body textarea.
  if(typeof _rtMount === 'function') _rtMount('atplBody', { minHeight:'320px' });
}
window._atplRenderEditor = _atplRenderEditor;

export async function _marketingSave(){
  if(!isSupabase()){ alert('Marketing defaults require Supabase mode.'); return; }
  if(!window._currentUser?.email){ alert('Sign in first.'); return; }
  // v183: capture any pending asset-template edits from the inputs before saving.
  if(typeof _atplCaptureCurrent === 'function') _atplCaptureCurrent();
  const get = id => document.getElementById(id)?.value?.trim() || null;
  const payload = {
    user_email:               window._currentUser.email,
    default_tone:             get('mkgDefaultTone'),
    default_subject_template: get('mkgDefaultSubject'),
    default_prompt:           get('mkgDefaultPrompt'),
    style_guide:              get('mkgStyleGuide'),
    default_signature:        get('mkgDefaultSignature'),
    asset_templates:          _atplDraft || {},
  };
  const status = document.getElementById('mkgSaveStatus');
  try{
    if(_marketingSettings?.id){
      await _sbPatch('ace_user_marketing_settings', _marketingSettings.id, payload);
      _marketingSettings = Object.assign({}, _marketingSettings, payload);
    } else {
      const saved = await _sbPost('ace_user_marketing_settings', payload);
      _marketingSettings = Array.isArray(saved) ? saved[0] : saved;
    }
    if(status){
      status.textContent = '✓ Saved ' + new Date().toLocaleTimeString();
      status.style.color = '#059669';
    }
    showSaveConfirm('✓ Marketing defaults saved');
  }catch(e){
    if(status){
      status.textContent = '✗ Save failed: ' + e.message;
      status.style.color = '#dc2626';
    }
  }
}

// ─── Send via Gmail (modal flow) ─────────────────────────────────────────────
// IMPORTANT: never auto-send to the property owner/seller. The agent must
// explicitly pick a recipient from a modal that searches ace_contacts, with
// the seller contact filtered out of the results.

// Cached recipient for the currently-open send modal
let _sendModalRecipient = null;       // { id, name, email, phone_number, company, type }
let _sendModalSearchTimer = null;
let _sendModalLastQuery = '';

export function sendEmailViaGmail(){
  if(!window.currentDeal?.id){ alert('No deal selected.'); return; }
  const subject = (document.getElementById('emailTemplateSubject')?.value || '').trim();
  const body    = (document.getElementById('emailTemplateText')?.value    || '').trim();
  if(!subject){ alert('Enter a subject line first.'); return; }
  if(!body){    alert('The email body is empty.'); return; }
  _openSendModal({ subject, body });
}

export function _openSendModal({ subject, body }){
  _sendModalRecipient = null;
  _sendModalLastQuery = '';

  // Remove any existing modal first
  document.getElementById('sendEmailModalOverlay')?.remove();

  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const overlay = document.createElement('div');
  overlay.id = 'sendEmailModalOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:30px 20px;overflow-y:auto;';
  const sellerWarn = window.currentDeal._sellerContactId
    ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px;">🚫 The property owner <em>${esc(window.currentDeal._sellerName||'(unknown)')}</em> is excluded from this search.</div>`
    : '';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:780px;max-width:95vw;display:flex;flex-direction:column;font-family:'Inter',system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;">
      <div style="background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);color:#fff;padding:18px 22px;display:flex;align-items:center;gap:14px;">
        <div style="width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:22px;">✉</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:17px;font-weight:700;line-height:1.2;">Send Email via Gmail</div>
          <div style="font-size:11px;color:#bfdbfe;margin-top:2px;">${esc((window.currentDeal['Address']||'').slice(0,80))}</div>
        </div>
        <button onclick="_closeSendModal()" style="background:rgba(255,255,255,0.1);border:none;color:#fff;cursor:pointer;font-size:18px;width:32px;height:32px;border-radius:6px;">✕</button>
      </div>

      <div style="padding:20px 22px;background:#fff;max-height:72vh;overflow-y:auto;">
        <!-- RECIPIENT PICKER -->
        <div style="margin-bottom:14px;">
          <label style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.05em;display:block;margin-bottom:5px;">Recipient *</label>
          <div style="position:relative;">
            <input id="sendModalSearch" type="text" placeholder="Start typing a contact name or email…" autocomplete="off"
              oninput="_sendModalSearchContacts(this.value)" onfocus="_sendModalSearchContacts(this.value)"
              style="width:100%;box-sizing:border-box;padding:9px 12px;font-size:13px;border:1px solid #cbd5e1;border-radius:6px;"/>
            <div id="sendModalResults" style="position:absolute;top:100%;left:0;right:0;max-height:260px;overflow-y:auto;background:#fff;border:1px solid #e2e8f0;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,0.12);z-index:10;display:none;margin-top:2px;"></div>
          </div>
          <div id="sendModalSelected" style="display:none;margin-top:8px;padding:10px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
              <div style="min-width:0;flex:1;">
                <div style="font-weight:700;color:#0f172a;" id="sendModalSelectedName">—</div>
                <div style="font-size:10px;color:#64748b;margin-top:2px;" id="sendModalSelectedMeta">—</div>
              </div>
              <button onclick="_sendModalClearRecipient()" style="background:transparent;border:1px solid #bfdbfe;color:#1d4ed8;font-size:10px;padding:4px 10px;border-radius:4px;cursor:pointer;">Change</button>
            </div>
          </div>
          ${sellerWarn}
        </div>

        <!-- SUBJECT (editable) -->
        <div style="margin-bottom:12px;">
          <label style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.05em;display:block;margin-bottom:5px;">Subject</label>
          <input id="sendModalSubject" type="text" value="${esc(subject)}"
            style="width:100%;box-sizing:border-box;padding:9px 12px;font-size:13px;border:1px solid #cbd5e1;border-radius:6px;"/>
        </div>

        <!-- BODY PREVIEW -->
        <div style="margin-bottom:6px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.05em;">Body</label>
            <span id="sendModalResolveHint" style="font-size:10px;color:#94a3b8;">Placeholders will resolve once you pick a recipient</span>
          </div>
          <textarea id="sendModalBody" style="width:100%;box-sizing:border-box;min-height:300px;padding:10px 12px;font-size:12px;font-family:Tahoma,Arial,sans-serif;border:1px solid #cbd5e1;border-radius:6px;resize:vertical;line-height:1.5;">${esc(body)}</textarea>
        </div>
        <div id="sendModalUnresolved" style="display:none;font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fcd34d;padding:7px 10px;border-radius:6px;margin-top:6px;"></div>
      </div>

      <div style="padding:14px 22px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;align-items:center;gap:10px;">
        <button onclick="_closeSendModal()" style="background:#fff;border:1px solid #cbd5e1;color:#475569;padding:9px 18px;font-size:13px;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>
        <button id="sendModalSendBtn" onclick="_sendModalConfirm()" disabled
          style="background:#cbd5e1;color:#fff;border:none;padding:9px 22px;font-size:13px;border-radius:6px;cursor:not-allowed;font-weight:700;">
          ✉ Send
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('sendModalSearch')?.focus(), 100);
}

export function _closeSendModal(){
  document.getElementById('sendEmailModalOverlay')?.remove();
  _sendModalRecipient = null;
}

export async function _sendModalSearchContacts(q){
  clearTimeout(_sendModalSearchTimer);
  const box = document.getElementById('sendModalResults');
  if(!box) return;
  const query = (q || '').trim();
  if(query.length < 2){
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  _sendModalSearchTimer = setTimeout(async () => {
    if(query === _sendModalLastQuery) return;
    _sendModalLastQuery = query;
    try{
      // Search name OR email. Exclude the seller contact explicitly.
      const sellerId = window.currentDeal?._sellerContactId || '';
      const orFilter = `or=(name.ilike.*${encodeURIComponent(query)}*,email.ilike.*${encodeURIComponent(query)}*)`;
      let filter = `${orFilter}&select=id,name,phone_number,email,company,type&limit=25&order=name.asc`;
      const rows = await _sbGet('ace_contacts', filter);
      const filtered = (rows || []).filter(r => r.id !== sellerId);
      _sendModalRenderResults(filtered);
    }catch(e){
      console.warn('recipient search failed:', e.message);
      box.innerHTML = `<div style="padding:12px;font-size:11px;color:#dc2626;">Search failed: ${e.message}</div>`;
      box.style.display = 'block';
    }
  }, 220);
}

export function _sendModalRenderResults(rows){
  const box = document.getElementById('sendModalResults');
  if(!box) return;
  const esc = s => String(s||'').replace(/</g,'&lt;');
  if(!rows.length){
    box.innerHTML = '<div style="padding:12px;font-size:11px;color:#94a3b8;">No matching contacts. The property owner is excluded.</div>';
    box.style.display = 'block';
    return;
  }
  box.innerHTML = rows.map(r => {
    if(!r.email){
      // No email = can't send via Gmail. Grey out + explain.
      return `<div style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;opacity:0.55;cursor:not-allowed;">
        <div style="font-weight:600;color:#0f172a;">${esc(r.name||'(no name)')}</div>
        <div style="font-size:10px;color:#dc2626;margin-top:2px;">No email on file — cannot send.</div>
      </div>`;
    }
    const types = Array.isArray(r.type) ? r.type : (r.type ? [r.type] : []);
    const typeBadge = types.length
      ? `<span style="display:inline-block;padding:1px 7px;border-radius:99px;font-size:9px;font-weight:700;color:#3730a3;background:#e0e7ff;margin-left:6px;">${esc(types.join(', '))}</span>`
      : '';
    const subtitle = [r.email, r.company, r.phone_number].filter(Boolean).join(' · ');
    const payload = JSON.stringify(r).replace(/'/g,"&#39;");
    return `
      <div onclick='_sendModalPickRecipient(${payload})' style="padding:10px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:12px;" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background='#fff'">
        <div style="font-weight:600;color:#0f172a;">${esc(r.name||'(no name)')}${typeBadge}</div>
        ${subtitle ? `<div style="font-size:10px;color:#64748b;margin-top:2px;">${esc(subtitle)}</div>` : ''}
      </div>`;
  }).join('');
  box.style.display = 'block';
}

export function _sendModalPickRecipient(r){
  if(!r || !r.email) return;
  _sendModalRecipient = r;
  const sel   = document.getElementById('sendModalSelected');
  const name  = document.getElementById('sendModalSelectedName');
  const meta  = document.getElementById('sendModalSelectedMeta');
  const box   = document.getElementById('sendModalResults');
  const input = document.getElementById('sendModalSearch');
  const btn   = document.getElementById('sendModalSendBtn');
  if(name) name.textContent = r.name || '(no name)';
  if(meta) meta.textContent = [r.email, r.company, r.phone_number].filter(Boolean).join(' · ');
  if(sel)  sel.style.display = 'block';
  if(box){ box.style.display = 'none'; box.innerHTML = ''; }
  if(input) input.value = '';
  if(btn){
    btn.disabled = false;
    btn.style.background = 'linear-gradient(180deg,#4285f4,#1a73e8)';
    btn.style.cursor = 'pointer';
  }
  // Re-render body preview with placeholders resolved against this contact
  _sendModalRefreshPreview();
}

export function _sendModalClearRecipient(){
  _sendModalRecipient = null;
  const sel = document.getElementById('sendModalSelected');
  const btn = document.getElementById('sendModalSendBtn');
  if(sel) sel.style.display = 'none';
  if(btn){
    btn.disabled = true;
    btn.style.background = '#cbd5e1';
    btn.style.cursor = 'not-allowed';
  }
  _sendModalRefreshPreview();
}

// When a recipient is picked, show the user what the email will actually look
// like with placeholders swapped in. We mutate the preview textarea non-
// destructively — the user can still edit it before sending.
export function _sendModalRefreshPreview(){
  const hint = document.getElementById('sendModalResolveHint');
  const warn = document.getElementById('sendModalUnresolved');
  if(!_sendModalRecipient){
    if(hint) hint.textContent = 'Placeholders will resolve once you pick a recipient';
    if(warn) warn.style.display = 'none';
    return;
  }
  if(hint) hint.textContent = 'Preview: placeholders resolved against the selected recipient (edit freely)';
  const subjEl = document.getElementById('sendModalSubject');
  const bodyEl = document.getElementById('sendModalBody');
  if(subjEl) subjEl.value = _emailResolvePlaceholders(subjEl.value, { contact: _sendModalRecipient });
  if(bodyEl) bodyEl.value = _emailResolvePlaceholders(bodyEl.value, { contact: _sendModalRecipient });
  // Warn if any placeholder leftover
  const leftover = ((subjEl?.value||'') + '\n' + (bodyEl?.value||'')).match(/\{[^{}]{1,60}\}/g);
  if(warn){
    if(leftover && leftover.length){
      const uniq = Array.from(new Set(leftover));
      warn.textContent = '⚠ Unresolved placeholders: ' + uniq.join(', ');
      warn.style.display = 'block';
    } else {
      warn.style.display = 'none';
    }
  }
}

// v113.29: Auto-log a pitch row when an email is sent from the deal/property
// card. The row lands in ace_buyer_pitches and surfaces in two places:
//   1) Contact card → Pitches tab (filter contact_id=eq.<recipient>)
//   2) Deal page → Contacts/Buyers → Buyer Activity (filter deal_id=eq.<deal>)
// Best-effort: failures are logged but never block the UI — the email already
// sent successfully by the time we get here. We also refresh both panels
// after creation so an open Pitches/Buyer Activity view updates without a
// manual reload. Each panel-refresh is a no-op if its DOM isn't mounted.
export async function _autoLogEmailPitch({ dealId, contact, subject }){
  if(!dealId || !contact || !contact.id) return; // guard — need both sides
  if(typeof _pitchCreate !== 'function') return;
  try {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm   = String(today.getMonth() + 1).padStart(2, '0');
    const dd   = String(today.getDate()).padStart(2, '0');
    const subj = String(subject || '').trim();
    const note = subj ? ('Email sent: ' + subj) : 'Email sent via Gmail';
    await _pitchCreate({
      contact_id:    contact.id,
      deal_id:       dealId,
      pitch_date:    yyyy + '-' + mm + '-' + dd,
      pitch_channel: 'email',
      reaction:      null,   // user can update once buyer responds
      notes:         note,
    });
    // Refresh whichever panel the user might be looking at. Both functions
    // bail early if their target list element isn't in the DOM.
    if(typeof loadDealPitches === 'function')      loadDealPitches(dealId);
    if(typeof _contactLoadPitches === 'function')  _contactLoadPitches(contact.id);
  } catch(e){
    console.warn('[v113.29] auto-pitch on email-send failed (non-blocking):', e && e.message);
  }
}

export async function _sendModalConfirm(){
  if(!_sendModalRecipient?.email){ alert('Pick a recipient first.'); return; }
  const subject = (document.getElementById('sendModalSubject')?.value || '').trim();
  const body    = (document.getElementById('sendModalBody')?.value    || '').trim();
  if(!subject){ alert('Subject is empty.'); return; }
  if(!body){    alert('Body is empty.'); return; }

  // Safety net: never send to the seller contact
  if(window.currentDeal?._sellerContactId && _sendModalRecipient.id === window.currentDeal._sellerContactId){
    alert('Blocked: that contact is the property owner. Pick a different recipient.');
    return;
  }
  // Extra safety: if the recipient email matches the seller email, block.
  if(window.currentDeal?._sellerEmail && _sendModalRecipient.email
     && _sendModalRecipient.email.trim().toLowerCase() === String(window.currentDeal._sellerEmail).trim().toLowerCase()){
    alert('Blocked: that email matches the property owner on file.');
    return;
  }

  const btn = document.getElementById('sendModalSendBtn');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Sending…'; }

  // Final pass — resolve any placeholder the user didn't manually resolve yet
  const resolvedSubject = _emailResolvePlaceholders(subject, { contact: _sendModalRecipient });
  const resolvedBody    = _emailResolvePlaceholders(body,    { contact: _sendModalRecipient });

  try{
    const result = await _gmailSend({
      to: _sendModalRecipient.email,
      subject: resolvedSubject,
      body: resolvedBody,
      dealId: window.currentDeal.id
    });
    if(result.sent){
      showSaveConfirm('✓ Email sent to ' + _sendModalRecipient.name);
      // v113.29: log this email as a pitch on the deal + contact. Snapshot
      // the deal id and recipient before _closeSendModal clears state, then
      // fire-and-forget so the modal close stays snappy.
      const _autoDealId    = window.currentDeal && window.currentDeal.id;
      const _autoRecipient = _sendModalRecipient;
      const _autoSubject   = resolvedSubject;
      _closeSendModal();
      if(typeof _autoLogEmailPitch === 'function'){
        _autoLogEmailPitch({ dealId: _autoDealId, contact: _autoRecipient, subject: _autoSubject });
      }
      // v190: bump last_communicated_at on the agent-contact junction
      if(_autoRecipient?.id) _relTouchActivity(_autoRecipient.id, 'communicated');
    } else if(result.fallback){
      showSaveConfirm('✎ Opened Gmail compose (connect Gmail in sidebar for 1-click send)');
      _closeSendModal();
    } else if(result.error){
      alert('Send failed: '+result.error);
      if(btn){ btn.disabled = false; btn.textContent = '✉ Send'; }
    }
  }catch(e){
    alert('Send failed: '+(e.message||'unknown'));
    if(btn){ btn.disabled = false; btn.textContent = '✉ Send'; }
  }
}

export async function loadAICommTab(recordId){
  const cfg = getConfig();
  if(!cfg.key && !isSupabase()) return;
  try{
    let templateVal = '', subjectVal = '';
    if(isSupabase()){
      // v113.14: pull saved Email Template + Subject
      const rows = await _sbGet(SB_TABLES.properties, `id=eq.${recordId}&select=email_template_in_fub,email_subject_in_fub`);
      templateVal = rows?.[0]?.email_template_in_fub || '';
      subjectVal  = rows?.[0]?.email_subject_in_fub  || '';
      if(window.currentDeal){
        window.currentDeal['Email Template'] = templateVal;
        window.currentDeal['Email Subject']  = subjectVal;
      }
    } else {
      const res = await fetch(`https://api.airtable.com/v0/${cfg.base}/${cfg.table}/${recordId}`,
        {headers:{Authorization:`Bearer ${cfg.key}`}});
      if(!res.ok) return;
      const rec = await res.json();
      const template = rec.fields['Email Template'];
      templateVal = template?.value || template || '';
      subjectVal  = rec.fields['Email Subject'] || '';
    }
    const templateEl = document.getElementById('emailTemplateText');
    const subjectEl  = document.getElementById('emailTemplateSubject');
    if(templateEl) templateEl.value = templateVal;
    if(subjectEl)  subjectEl.value  = subjectVal;

    // v102.26: Also load the seller contact so the Text Message Maker can
    // include Name / Phone / Email. loadSellerContact caches these on
    // window.currentDeal as _sellerName / _sellerPhone / _sellerEmail. After it
    // resolves, refresh the Text Message Maker textarea in place.
    try {
      await loadSellerContact(recordId);
    } catch(e){ /* non-fatal — TMM just won't have contact info */ }
    if(typeof _tmmUpdate === 'function') _tmmUpdate();

    // v113.11: populate the AI Email Template field-picker + prefs
    if(typeof _emailTplRenderFields === 'function') _emailTplRenderFields();
    // v113.14: populate placeholder pills + saved templates picker
    if(typeof _emailTplRenderPlaceholders === 'function') _emailTplRenderPlaceholders();
    // v183: load marketing settings (for asset_templates) and paint the
    // missing-fields warning bar above the body.
    if(_marketingSettings === null && typeof _marketingLoad === 'function'){
      try { await _marketingLoad(); } catch(_e){}
    }
    if(typeof _atplRefreshStatusBar === 'function') _atplRefreshStatusBar();
    // v187: mount rich-text editor on the email body textarea.
    if(typeof _rtMount === 'function') _rtMount('emailTemplateText', { minHeight:'520px' });
    if(typeof _emailBindFocus === 'function') _emailBindFocus();
    if(typeof _loadUserTemplatesList === 'function'){
      await _loadUserTemplatesList();
      // v139: auto-select the OFFICIAL template if one exists for this deal,
      // otherwise default to "(new / unsaved)". Picking a template here only
      // fills the form via loadSavedTemplate — it does NOT auto-save to the
      // deal, so the v113.16 leakage concern doesn't apply: nothing persists
      // to the DB until the user explicitly clicks Save / Send. The body
      // appearing pre-filled with the official just makes the common path
      // (open deal → send official email) one click instead of two.
      const _official = (_emailTemplates || []).find(t => t.is_official);
      if(_official && typeof loadSavedTemplate === 'function'){
        await loadSavedTemplate(_official.id);
      } else {
        _currentTemplateId = null;
        if(typeof _renderTemplatePicker === 'function') _renderTemplatePicker();
      }
    }
  }catch(e){}
}

// v113.11: runEmailAgent rewritten.
// Old version called https://api.anthropic.com directly with no API key — it
// was broken in practice. New version:
//   1. Reads the user's saved prefs (which fields to include, tone, sig,
//      optional extra instructions)
//   2. Resolves each enabled field against the current deal using the
//      EMAIL_TPL_FIELDS getter list
//   3. Sends { fields, signature, tone, extraInstructions, recipient }
//      to the crm-email-gen edge function (Sonnet 4.5)
//   4. Drops the returned email into the textarea and auto-saves.
export async function runEmailAgent(){
  const btn    = document.getElementById('runAgentBtn');
  const status = document.getElementById('agentStatus');
  const output = document.getElementById('emailTemplateText');
  const subjectEl = document.getElementById('emailTemplateSubject');
  if(!window.currentDeal){ alert('No deal selected.'); return; }
  if(!btn || !status || !output) return;

  btn.disabled = true;
  btn.textContent = '⏳ Generating...';
  status.style.display = 'block';
  status.innerHTML = '✦ Generating email...';
  status.style.background = '#f0f0ff';
  status.style.color = '#3a3a99';

  // Persist the current form state + get a clean prefs snapshot
  const prefs = _emailTplSavePrefs();

  // v113.17: load the user's Marketing defaults (Settings → Marketing tab) so
  // every Run Agent starts from the same base prompt/tone/signature/style guide.
  // Per-deal prefs (tone select, extra instructions) override the defaults when set.
  if(_marketingSettings === null && typeof _marketingLoad === 'function'){
    try { await _marketingLoad(); } catch(_e){}
  }
  const mkg = _marketingSettings || {};

  // v113.18: refetch the deal row before generating so recent Unit Mix /
  // Financial Analysis edits are reflected. Without this, an agent who
  // changes "No. of Units" from 2 to 4 and immediately clicks Run Agent
  // sends the stale in-memory value of 2 to the AI.
  if(isSupabase() && window.currentDeal?.id){
    try {
      const fresh = await _sbGet(SB_TABLES.properties, `id=eq.${window.currentDeal.id}`);
      if(Array.isArray(fresh) && fresh[0]){
        const refreshed = _sbToAt(fresh[0], SB_PROP_MAP);
        Object.assign(window.currentDeal, refreshed);
      }
    } catch(_e) { /* non-fatal; use in-memory copy */ }
  }

  // Resolve each enabled field against the current deal. v177: send the
  // PLACEHOLDER TOKEN as the field's value (e.g. "Asking Price: {asking price}")
  // and pass the actual values in a separate context block. The AI will
  // emit the tokens verbatim into the email body, so when the deal data
  // changes later the email auto-updates without re-running the agent.
  const fields = {};
  const tokenContext = []; // for the AI prompt — tells it what each token currently resolves to
  EMAIL_TPL_FIELDS.forEach(f => {
    if(prefs.enabled[f.k] === false) return;
    try {
      const v = f.get(window.currentDeal);
      if(v == null || String(v).trim() === '') return;
      if(f.token){
        fields[f.label] = f.token;
        tokenContext.push(`  ${f.token} = ${String(v).trim()}`);
      } else {
        fields[f.label] = v;
      }
    } catch(_e) { /* skip field */ }
  });

  if(!Object.keys(fields).length){
    status.innerHTML = '✕ No populated fields selected. Tick at least one field that has a value on this deal.';
    status.style.background = '#fff0f0';
    status.style.color = '#c00';
    btn.disabled = false;
    btn.textContent = '✦ Run Agent';
    return;
  }

  // Optional: if we loaded a seller/owner contact earlier, personalize greeting
  const recipient = window.currentDeal._sellerName
    ? { name: String(window.currentDeal._sellerName).split(/\s+/)[0], company: window.currentDeal._sellerCompany || '' }
    : {};

  // v113.14: instruct the AI to emit a "Subject: ..." line first, then a blank
  // line, then the body. We parse it back out. If not present, fall back.
  const subjectInstr = 'Begin your response with one line in the exact format: "Subject: <subject line>" (no other prefix, no quotes). Leave a blank line after the subject, then write the email body.';

  // v113.17: layer Marketing defaults → per-deal extra instructions
  //   (1) standing default_prompt from Settings → Marketing (user's usual ask)
  //   (2) style_guide from Settings → Marketing (brand voice, do/don'ts)
  //   (3) default_subject_template hint (e.g. "use a benefit-led subject")
  //   (4) per-deal "Additional Instructions" (AI Comm → Template Settings)
  //   (5) subjectInstr (structural — must come last to survive)
  const subjectStyleHints = {
    property_headline: 'Subject should be a short property headline (Type + neighborhood + one killer feature).',
    benefit_led:       'Subject should lead with the single strongest quantitative benefit (cap rate, cash-on-cash, occupancy, %).',
    question:          'Subject should be a short conversational question that prompts a reply.',
    short_direct:      'Subject should be short and direct — 5 words or less, no fluff.',
  };
  const subjectStyle = subjectStyleHints[mkg.default_subject_template] || '';

  // v177: tell the AI the field values are placeholder tokens — emit them
  // verbatim (don't replace with literal values). The CRM resolves them at
  // send time, so the email auto-updates when deal data changes.
  const placeholderInstr = tokenContext.length ? [
    'PLACEHOLDER MODE — IMPORTANT:',
    'The field values you see above are PLACEHOLDER TOKENS in curly braces (e.g. {asking price}, {cap rate}, {address}).',
    '- When you mention any of these fields in the email body OR subject line, you MUST emit the TOKEN VERBATIM, character-for-character — do NOT replace the token with its literal value, do NOT add quotes, do NOT modify casing or spacing.',
    '- The CRM will substitute live deal values for these tokens at send time, so the email always reflects the most recent data without needing to re-run the agent.',
    '',
    'For NARRATIVE CONTEXT ONLY — to help you write phrasing that matches deal size and significance — the tokens currently resolve to:',
    ...tokenContext,
    '',
    'Use the values above ONLY to inform your tone (e.g. "this is an 8-figure deal, lead with prestige" vs "this is a small bread-and-butter rental, lead with cash flow"). Never copy the literal values into the email — always emit the tokens.'
  ].join('\n') : '';

  const mergedExtra = [
    mkg.default_prompt || '',
    mkg.style_guide ? ('STYLE GUIDE:\n' + mkg.style_guide) : '',
    subjectStyle,
    prefs.extra || '',
    placeholderInstr,
    subjectInstr,
  ].filter(Boolean).join('\n\n');

  // v113.17: fall through to marketing defaults when the per-deal field is blank
  const effectiveTone      = prefs.tone      || mkg.default_tone      || '';
  const effectiveSignature = prefs.signature || mkg.default_signature || '';

  try{
    const cfg = getConfig();
    // v113.18: pass the anon key because the redeployed crm-email-gen enforces
    // JWT verification (v4+). The anon key is public-safe to include in the
    // bundle — same as every other Supabase REST call in this file.
    const res = await fetch(cfg.url + '/functions/v1/crm-email-gen', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'apikey': SB_ANON_KEY,
        'Authorization': 'Bearer ' + SB_ANON_KEY,
      },
      body: JSON.stringify({
        fields,
        signature: effectiveSignature,
        tone: effectiveTone,
        extraInstructions: mergedExtra,
        recipient
      })
    });
    const data = await res.json();
    if(data.error){
      status.innerHTML = '✕ ' + String(data.error).slice(0, 200);
      status.style.background = '#fff0f0';
      status.style.color = '#c00';
      return;
    }
    let raw = (data.email || '').trim();
    let parsedSubject = '';
    const m = raw.match(/^\s*subject\s*:\s*(.+?)\s*(?:\n|$)/i);
    if(m){
      parsedSubject = m[1].trim();
      // Strip the "Subject: ..." line + any leading blank line
      raw = raw.slice(m[0].length).replace(/^\s*\n/, '');
    }
    if(raw){
      output.value = raw;
      if(subjectEl){
        if(parsedSubject){
          subjectEl.value = parsedSubject;
        } else if(!subjectEl.value){
          // Fallback: derive a reasonable subject from the deal
          const addr = window.currentDeal['Address'] || '';
          const pt   = window.currentDeal['Simple Text Property Type'] || window.currentDeal['CRM Asset Classification'] || '';
          subjectEl.value = [pt, addr].filter(Boolean).join(' — ') || 'New listing opportunity';
        }
      }
      await saveEmailTemplate(true);
      status.innerHTML = '✓ Email generated & saved. Edit freely or regenerate.';
      status.style.background = '#f0fdf4';
      status.style.color = '#166534';
      if(data.usage){
        console.log('email-gen cost: ~$'+((data.usage.input_tokens*3+data.usage.output_tokens*15)/1e6).toFixed(4));
      }
    } else {
      status.innerHTML = '✕ No response received. Try again.';
      status.style.background = '#fff0f0';
      status.style.color = '#c00';
    }
  }catch(e){
    status.innerHTML = '✕ Error: '+(e.message||'unknown');
    status.style.background = '#fff0f0';
    status.style.color = '#c00';
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Run Agent';
    setTimeout(()=>{ status.style.display='none'; }, 5000);
  }
}

// v183: Apply the asset-type template from Settings → Marketing into the
// current deal's email body + subject. Saves to the deal so the choice
// persists. Refreshes the missing-fields warning bar.
export async function applyAssetTemplate(){
  if(!window.currentDeal){ alert('No deal selected.'); return; }
  // Make sure we have the latest marketing settings (template store)
  if(_marketingSettings === null && typeof _marketingLoad === 'function'){
    try { await _marketingLoad(); } catch(_e){}
  }
  const slug = _resolveAssetTemplateKey(window.currentDeal);
  const tpl = _getAssetTemplate(slug);
  const subjEl = document.getElementById('emailTemplateSubject');
  const bodyEl = document.getElementById('emailTemplateText');
  if(subjEl) subjEl.value = tpl.subject || '';
  if(bodyEl) bodyEl.value = tpl.body || '';
  try { await saveEmailTemplate(true); } catch(_e){}
  showSaveConfirm('✓ Applied ' + (ASSET_TPL_KEYS.find(x => x.slug === slug)?.label || 'template'));
  _atplRefreshStatusBar();
}
window.applyAssetTemplate = applyAssetTemplate;

// v183: paint the missing-fields warning + active-template chip above the
// email body. Called whenever the AI Comm tab renders or the user applies
// a template. Hidden when there's no deal or no required fields are missing.
export function _atplRefreshStatusBar(){
  const bar = document.getElementById('atplStatusBar');
  if(!bar) return;
  if(!window.currentDeal){ bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const slug = _resolveAssetTemplateKey(window.currentDeal);
  const tpl  = _getAssetTemplate(slug);
  const tplLabel = (ASSET_TPL_KEYS.find(x => x.slug === slug)?.label) || 'Generic';
  const missing = _missingRequiredFields(window.currentDeal, tpl.required_fields || []);
  let html = '';
  // Active-template chip — always show
  html += `<div style="display:inline-flex;align-items:center;gap:6px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;margin-right:6px;">
    📨 ${tplLabel}
  </div>`;
  if(missing.length){
    const items = missing.map(f => `<code style="background:rgba(255,255,255,0.6);padding:1px 6px;border-radius:3px;font-size:11px;">${f.label}</code>`).join(' · ');
    html += `<div style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:6px 12px;border-radius:8px;font-size:11px;line-height:1.5;">
      <strong>⚠ Missing data:</strong> ${items}
      <div style="font-size:10px;color:#a16207;margin-top:4px;">Fill these on the Property Details / Financial Analysis tabs for a complete email.</div>
    </div>`;
  } else if(tpl.required_fields && tpl.required_fields.length){
    html += `<div style="display:inline-block;background:#dcfce7;color:#166534;border:1px solid #86efac;padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;">
      ✓ All required fields filled
    </div>`;
  }
  bar.innerHTML = html;
  bar.style.display = '';
}

export async function saveEmailTemplate(silent=false){
  // v113.14: saves body + subject to the deal. (The separate "saved template
  // library" — ace_user_email_templates — uses saveCurrentTemplate / saveAsTemplate.)
  if(!window.currentDeal?.id) return;
  const text    = document.getElementById('emailTemplateText')?.value||'';
  const subject = document.getElementById('emailTemplateSubject')?.value||'';
  const msg     = document.getElementById('emailSaveMsg');

  try{
    await airtableUpdate(window.currentDeal.id, { 'Email Template': text, 'Email Subject': subject });
    if(window.currentDeal){
      window.currentDeal['Email Template'] = text;
      window.currentDeal['Email Subject']  = subject;
    }
    if(!silent && msg){
      msg.textContent = '✓ Saved!';
      msg.style.display = 'inline';
      setTimeout(()=>{ msg.style.display='none'; }, 2500);
    }
    if(!silent) showSaveConfirm('✓ Email draft saved to deal');
  }catch(e){
    if(!silent) alert('Save failed: '+e.message);
  }
}

