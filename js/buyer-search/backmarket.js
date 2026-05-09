// buyer-search/backmarket.js — buyer-match feature: filter deals by tier,
// score buyers against deal criteria, render results, blast emails to
// selected matches, log outreach activity.
//
// Phase 5 commit 2 of 4. ~1,545 lines, 47 exports. Two legacy regions
// merged into one module:
//   - Region A (line ~39319–39800 in legacy, pre-deletion): NJ_COUNTIES_ALL,
//     BM_RETAIL_PROFILES / SUBTYPES / MF_STYLES / MF_PROFILES / WH_CLASSES,
//     `_bm` state, _bmDealType / _bmCapRate / _bmSF / _bmUnits / _bmPPU /
//     _bmPPSF / _bmCounty / _bmParseCounties / _bmFmt / _bmPct / _bmFS /
//     _bmUpd / _bmUpdAndRender / _bmTogCounty / _bmTogArr / _bmTogSel /
//     _bmGoBack / _bmSearch / _bmBuildEmail / _bmOpenGmail / _renderBM
//   - Region B (line ~43603–44666 in legacy, pre-deletion): _bmMatches /
//     _bmOutreach / _bmCallNotes / _bmCollapsedTiers / _bmSelected state,
//     _BM_ASSET_CANON, _bmCanonicalAssets / _bmExtractCounties /
//     _bmParseNotes / loadBuyerMatchTab / scoreBuyerMatch / bmApplyFilter /
//     renderBuyerMatchResults / bmToggleDetail / bmToggleTier /
//     bmToggleSelect / bmSelectAllInTier / bmClearSelection /
//     _bmUpdateBulkBar / _bmGmailComposeUrl / bmSendEmail /
//     bmSendEmailToSelected / bmLogActivity / _bmLogOutreach
//
// External deps on window.* (legacy still owns):
//   state:    currentDeal, allDeals, allBuyerCriteria, allBuyerContacts,
//             _currentUser, _appLists, _gmailConnected, NJ_COUNTIES
//             (last is `const` → `var` in this commit)
//   functions: getStage, cleanAddress, fmtMoney (function decls);
//             _gmailSend, _canonicalCounty (window-attached via earlier
//             phase modules)

import { _sbGet, _sbPost, _sbPatch } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

export const NJ_COUNTIES_ALL = [
  'Atlantic','Bergen','Burlington','Camden','Cape May','Cumberland',
  'Essex','Gloucester','Hudson','Hunterdon','Mercer','Middlesex',
  'Monmouth','Morris','Ocean','Passaic','Salem','Somerset',
  'Sussex','Union','Warren'
];
export const BM_RETAIL_PROFILES = ['Value Add','Stabilized','Core Plus','NNN','Gross Lease','Opportunistic'];
export const BM_RETAIL_SUBTYPES = ['Strip Center','Neighborhood Center','Grocery Anchored','Community Center','Pad Site','Inline Retail','Mixed Use'];
export const BM_MF_STYLES       = ['Garden','Elevator','Mid-Rise','High-Rise','Townhouse'];
export const BM_MF_PROFILES     = ['Value Add','Stabilized','Core Plus','Turn-Key','Opportunistic'];
export const BM_WH_CLASSES      = ['A','B','C'];

let _bm = null;

// ── Field helpers ───────────────────────────────────────────────────
export function _bmDealType(d){
  const t=(d['CRM Asset Classification']||d['Simple Text Property Type']||'').toLowerCase();
  if(t.includes('warehouse')||t.includes('industrial')||t.includes('flex')) return 'warehouse';
  if(t.includes('retail')||t.includes('shopping')||t.includes('strip')) return 'retail';
  if(t.includes('multi')||t.includes('apartment')||t.includes(' mf')) return 'multifamily';
  return null;
}
export function _bmCapRate(d){
  if(d['Cap Rate (CRM)']){ const v=Number(d['Cap Rate (CRM)']); return v<1?v*100:v; }
  const noi=Number(d['NOI']||0), price=Number(d['Asking Price']||0);
  return (noi&&price)?(noi/price)*100:null;
}
export function _bmSF(d){ return Number(d['Total Building SF']||d['Net Rentable SF']||0); }
export function _bmUnits(d){ return Number(d['No. of Units']||0); }
export function _bmPPU(d){ const u=_bmUnits(d),p=Number(d['Asking Price']||0); return (u&&p)?p/u:null; }
export function _bmPPSF(d){ const s=_bmSF(d),p=Number(d['Asking Price']||0); return (s&&p)?p/s:null; }
export function _bmCounty(d){ return (d['Simple County']||'').replace(/\s*county\s*/i,'').trim(); }
export function _bmParseCounties(text){ return NJ_COUNTIES_ALL.filter(c=>text.toLowerCase().includes(c.toLowerCase())); }
export function _bmFmt(n){ if(!n) return '—'; const v=Number(n); if(v>=1e6) return '$'+(v/1e6).toFixed(2)+'M'; if(v>=1e3) return '$'+Math.round(v/1e3)+'K'; return '$'+v; }
export function _bmPct(n){ return n?Number(n).toFixed(1)+'%':'—'; }
export function _bmFS(n){ return n?Number(n).toLocaleString()+' SF':'—'; }

// ── Init ────────────────────────────────────────────────────────────
export function showBuyerMatchFinder(recordId){
  const record=window.allBuyerCriteria.find(r=>r.id===recordId);
  if(!record){ alert('Buyer not found. Try refreshing the page.'); return; }
  const f=record.fields;
  const contactId=(f['Buyer']||[])[0];
  const contact=contactId?window.allBuyerContacts[contactId]:null;
  const buyerName=contact?.Name||f['Name']?.split(' - ')[0]||'—';
  const assetStr=(f['Simple Text Desired Property Type']||'').replace(/[🔴🟠🟡🟢🔵🟣]/g,'').trim();
  const assets=assetStr.split(',').map(t=>t.trim()).filter(Boolean);
  const wW=assets.some(a=>a.includes('Warehouse')||a.includes('Industrial'));
  const wR=assets.some(a=>a.includes('Retail')||a.includes('Shopping'));
  const wM=assets.some(a=>a.toLowerCase().includes('multi')||a.toLowerCase().includes('family'));
  const areaText=f['Simple Area Preference']||f['Location Preferences']||'';
  const buyerCounties=_bmParseCounties(areaText);
  const minCap=f['Minumum Cap Rate']?String(f['Minumum Cap Rate']):'';
  const availTypes=[...(wW?['warehouse']:[]),...(wR?['retail']:[]),...(wM?['multifamily']:[])];
  if(!availTypes.length) availTypes.push('warehouse','retail','multifamily');

  _bm={
    recordId, buyerName, buyerEmail:contact?.Email||'',
    buyerPhone:contact?.['Phone Number']||'', buyerCompany:contact?.Company||'',
    availTypes, activeType:availTypes[0],
    filters:{
      warehouse:{ classType:'', minSF:f['Warehouse Min Square Footage']?String(f['Warehouse Min Square Footage']):'', maxSF:f['Warehouse Max Square Footage']?String(f['Warehouse Max Square Footage']):'', minPrice:'', maxPrice:'', counties:[...buyerCounties], minCap, maxPriceSF:'', minCeiling:'' },
      retail:{ minPrice:'', maxPrice:'', counties:[...buyerCounties], minCap, profiles:[], subtypes:[], minTenants:'', minSF:'', maxSF:'' },
      multifamily:{ minUnits:f['Minimum # of Units MF']?String(f['Minimum # of Units MF']):'', maxUnits:f['Max # of Units MF']?String(f['Max # of Units MF']):'', counties:[...buyerCounties], minCap, maxPriceUnit:'', styles:[], profiles:[] },
    },
    results:null, selected:new Set(), detailId:null, fromView:'search',
    notes:{}, buyerReply:{}, emailText:'', showEmail:false, showReview:false,
  };
  _renderBM();
}

export function _bmUpd(type,k,v){ _bm.filters[type][k]=v; }
export function _bmUpdAndRender(type,k,v){ _bm.filters[type][k]=v; _renderBM(); }
export function _bmTogCounty(type,c){ const cur=_bm.filters[type].counties; _bm.filters[type].counties=cur.includes(c)?cur.filter(x=>x!==c):[...cur,c]; _renderBM(); }
export function _bmTogArr(type,key,val){ const cur=_bm.filters[type][key]; _bm.filters[type][key]=cur.includes(val)?cur.filter(x=>x!==val):[...cur,val]; _renderBM(); }
export function _bmTogSel(id){ _bm.selected.has(id)?_bm.selected.delete(id):_bm.selected.add(id); _renderBM(); }
export function _bmGoBack(){ _bm.detailId=null; _renderBM(); }

export function _bmSearch(){
  const type=_bm.activeType, f=_bm.filters[type];
  let r=window.allDeals.filter(d=>_bmDealType(d)===type);
  const inCounty=d=>!f.counties.length||f.counties.some(c=>_bmCounty(d).toLowerCase().includes(c.toLowerCase()));
  const capOk=d=>{ const cr=_bmCapRate(d); return !f.minCap||(cr&&cr>=+f.minCap); };
  if(type==='warehouse'){
    if(f.classType) r=r.filter(d=>(d['CRM Asset Classification']||d['Simple Text Property Type']||'').toUpperCase().includes(f.classType));
    if(f.minSF) r=r.filter(d=>_bmSF(d)>=+f.minSF);
    if(f.maxSF) r=r.filter(d=>_bmSF(d)<=+f.maxSF);
    if(f.minPrice) r=r.filter(d=>+d['Asking Price']>=+f.minPrice);
    if(f.maxPrice) r=r.filter(d=>+d['Asking Price']<=+f.maxPrice);
    r=r.filter(inCounty).filter(capOk);
    if(f.maxPriceSF){ r=r.filter(d=>{ const p=_bmPPSF(d); return p&&p<=+f.maxPriceSF; }); }
    if(f.minCeiling) r=r.filter(d=>+d['Ceiling Height']>=+f.minCeiling);
  } else if(type==='retail'){
    if(f.minPrice) r=r.filter(d=>+d['Asking Price']>=+f.minPrice);
    if(f.maxPrice) r=r.filter(d=>+d['Asking Price']<=+f.maxPrice);
    if(f.minSF) r=r.filter(d=>_bmSF(d)>=+f.minSF);
    if(f.maxSF) r=r.filter(d=>_bmSF(d)<=+f.maxSF);
    r=r.filter(inCounty).filter(capOk);
  } else {
    if(f.minUnits) r=r.filter(d=>_bmUnits(d)>=+f.minUnits);
    if(f.maxUnits) r=r.filter(d=>_bmUnits(d)<=+f.maxUnits);
    if(f.maxPriceUnit){ r=r.filter(d=>{ const p=_bmPPU(d); return p&&p<=+f.maxPriceUnit; }); }
    r=r.filter(inCounty).filter(capOk);
  }
  _bm.results=r; _renderBM();
}

export function _bmBuildEmail(){
  // v102.23: Rewritten for a modern, clean plain-text look. No ASCII box-drawing,
  // no pipe separators, no noisy "NOI: —" lines. Label/value pairs are tab-aligned
  // so email clients render them in two visual columns, and stats with missing
  // data are simply omitted instead of showing an em-dash placeholder.
  const selDeals=window.allDeals.filter(d=>_bm.selected.has(d.id));
  const SECTION_LABELS={multifamily:'MULTIFAMILY',warehouse:'INDUSTRIAL / WAREHOUSE',retail:'RETAIL'};
  const SECTION_ORDER=['multifamily','warehouse','retail'];

  // Local helper: format a single stat line as "label<TAB>value", indented 6 spaces
  // under its property entry. Returns an empty string if the value is missing
  // or an em-dash placeholder, so the caller can concatenate without guarding.
  const statLine = (label, value) => {
    if(value===null || value===undefined || value==='' || value==='—') return '';
    return '      '+label+'\t'+value+'\n';
  };

  const firstName = _bm.buyerName.split(' ')[0] || _bm.buyerName;

  let b = 'Hi '+firstName+',\n\n';
  b += 'Hope you\'re doing well. I put together a curated list of properties '
     + 'that align with your acquisition criteria. Details below — happy to '
     + 'send full packages or jump on a call for anything that looks interesting.\n';

  SECTION_ORDER.forEach(t => {
    const ds = selDeals.filter(d => _bmDealType(d) === t);
    if(!ds.length) return;

    // Section header: blank lines above, all-caps label, blank line below.
    // The whitespace + caps is the header — no ASCII rule needed.
    b += '\n\n'+SECTION_LABELS[t]+'\n\n';

    ds.forEach((d,i) => {
      const cr    = _bmCapRate(d);
      const sf    = _bmSF(d);
      const units = _bmUnits(d);
      const ppsf  = _bmPPSF(d);
      const ppu   = _bmPPU(d);
      const noi   = Number(d['NOI']||0);
      const askingFmt = _bmFmt(d['Asking Price']);
      const noiFmt    = _bmFmt(noi);
      const capFmt    = _bmPct(cr);

      // Address line: "1.  123 Main St, City, NJ 01234"
      b += '  '+(i+1)+'.  '+(d['Address']||'—')+'\n\n';

      // Stat block — each line only appears if the value is real.
      b += statLine('Asking Price', askingFmt);
      b += statLine('NOI',          noiFmt);
      b += statLine('Cap Rate',     capFmt);

      // Asset-specific secondary stats
      if(t==='warehouse' || t==='retail'){
        if(sf)  b += statLine('Building SF',  Number(sf).toLocaleString());
        if(ppsf) b += statLine('Price / SF',   '$'+Math.round(ppsf));
      }
      if(t==='multifamily'){
        if(units) b += statLine('Units',      String(units));
        if(ppu)   b += statLine('Price / Unit', _bmFmt(ppu));
      }

      // County — always included since almost every deal has one
      const county = _bmCounty(d);
      if(county) b += statLine('County', county);

      // Optional per-deal note the agent typed in the Review & Compose modal
      if(_bm.notes[d.id]) b += statLine('Notes', _bm.notes[d.id]);

      // Double newline between properties inside the same section
      b += '\n';
    });
  });

  b += '\nLet me know what stands out — happy to send full packages on any of these.\n\n'
     + 'Best,\n'
     + 'Ricky\n'
     + 'Ace Acquisitions · KW Commercial NJ\n'
     + '848.420.9972';

  _bm.emailText = b;
  _bm.showEmail = true;
  _renderBM();
}

export async function _bmOpenGmail(){
  const toEmail = _bm.buyerEmail||'';
  const subjectEl = document.getElementById('bmSubjectLine');
  const bodyEl = document.getElementById('bmEmailBody');
  const subject = subjectEl?.value || 'Properties Matching Your Criteria — Ace Acquisitions';
  const body = bodyEl?.value || _bm.emailText;
  _bm.emailText = body;

  // v113.12: use Gmail API when connected; fall back to compose URL if not.
  if(window._gmailConnected && window._gmailConnected.email){
    const btn = document.getElementById('bmSendGmailBtn');
    if(btn){ btn.disabled=true; btn.textContent='⏳ Sending…'; }
    const result = await _gmailSend({
      to: toEmail, subject, body,
      onSuccess: () => {
        showSaveConfirm('✓ Email sent from ' + window._gmailConnected.email);
        if(typeof _bmLogOutreach === 'function' && _bm.contact){
          _bmLogOutreach(_bm.contact, 'email', 'Sent via Gmail API from CRM').catch(()=>{});
        }
      },
      onError: (e) => alert('Send failed: ' + e.message)
    });
    if(btn){ btn.disabled=false; btn.textContent='📧 Send Email'; }
    return;
  }
  // Fallback: open Gmail compose tab
  const url = 'https://mail.google.com/mail/?view=cm&fs=1'
    + (toEmail ? '&to='+encodeURIComponent(toEmail) : '')
    + '&su='+encodeURIComponent(subject)
    + '&body='+encodeURIComponent(body);
  window.open(url, '_blank');
}

// ── Main render ─────────────────────────────────────────────────────
export function _renderBM(){
  const main=document.getElementById('mainArea');
  if(!main||!_bm) return;
  const selDeals=window.allDeals.filter(d=>_bm.selected.has(d.id));
  const selCount=_bm.selected.size;
  const tColor={warehouse:'var(--primary)',retail:'#d97706',multifamily:'#16a34a'};
  const tBg={warehouse:'var(--primary-light)',retail:'#fef3c7',multifamily:'#f0fdf4'};
  const tLabel={warehouse:'Warehouse',retail:'Retail',multifamily:'Multifamily'};
  const revBtnHtml=selCount>0&&!_bm.showReview?`<button onclick="_bm.showReview=true;_bm.detailId=null;_renderBM();" style="margin-left:auto;background:var(--green);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">${selCount} deal${selCount!==1?'s':''} selected &nbsp;&middot;&nbsp; Review &amp; Compose &rarr;</button>`:'';

  // ── DEAL DETAIL ─────────────────────────────────────────────────
  if(_bm.detailId){
    const d=window.allDeals.find(x=>x.id===_bm.detailId);
    if(!d){ _bm.detailId=null; _renderBM(); return; }
    const isSel=_bm.selected.has(d.id);
    const cr=_bmCapRate(d), sf=_bmSF(d), units=_bmUnits(d), ppu=_bmPPU(d), ppsf=_bmPPSF(d);
    const stats=[['Asking Price',_bmFmt(d['Asking Price'])],['Offer Price',_bmFmt(d['Offer Price'])],['NOI',_bmFmt(d['NOI'])],['Cap Rate',_bmPct(cr)]];
    if(sf) stats.push(['Building SF',_bmFS(sf)]);
    if(ppsf) stats.push(['Price / SF','$'+Math.round(ppsf)]);
    if(units) stats.push(['Units',''+units]);
    if(ppu) stats.push(['Price / Unit',_bmFmt(ppu)]);
    if(d['No. of Parking Spaces']) stats.push(['Parking',''+d['No. of Parking Spaces']]);
    if(d['Ceiling Height']) stats.push(['Ceiling',d['Ceiling Height']+"'"]);
    main.innerHTML=`
    <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:11px 18px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;">
      <button class="action-btn" onclick="_bmGoBack()" style="font-size:12px;padding:5px 12px;">&larr; Back</button>
      <div><div style="font-size:14px;font-weight:600;">${d['Address']||'Deal Detail'}</div>
      <div style="font-size:11px;color:var(--text2);">${_bmCounty(d)} County</div></div>
      ${revBtnHtml}
    </div>
    <div style="max-width:700px;margin:0 auto;padding:20px 18px;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:14px;">
        <div style="height:3px;background:var(--primary);"></div>
        <div style="padding:18px 20px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px;">
            <div>
              <div style="font-size:17px;font-weight:700;margin-bottom:6px;">${d['Address']||'—'}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${stageBadge(getStage(d))}
                <span style="background:var(--primary-light);color:var(--primary-dark);border-radius:99px;padding:2px 10px;font-size:11px;font-weight:600;">${d['Simple Text Property Type']||'—'}</span>
                <span style="background:var(--bg);color:var(--text2);border-radius:99px;padding:2px 10px;font-size:11px;">${_bmCounty(d)||'—'} County</span>
              </div>
            </div>
            <button onclick="_bmTogSel('${d.id}');" style="padding:8px 16px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0;background:${isSel?'#fee2e2':'#f0fdf4'};color:${isSel?'#dc2626':'#16a34a'};border:1px solid ${isSel?'#fca5a5':'#86efac'};">
              ${isSel?'&times; Remove from Pitch':'+ Add to Pitch'}
            </button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;margin-bottom:16px;">
            ${stats.map(([lbl,val])=>`<div style="background:var(--surface);padding:10px 12px;"><div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">${lbl}</div><div style="font-size:14px;font-weight:600;">${val}</div></div>`).join('')}
          </div>
          ${d['Deal Notes']?`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;margin-bottom:10px;font-size:12px;color:var(--text2);"><strong>Deal Notes:</strong> ${d['Deal Notes']}</div>`:''}
          ${d['Next Steps']?`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;margin-bottom:10px;font-size:12px;color:var(--text2);"><strong>Next Steps:</strong> ${d['Next Steps']}</div>`:''}
          <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:5px;">Pitch Notes for ${_bm.buyerName}</div>
          <textarea class="form-input" style="min-height:70px;resize:vertical;" placeholder="Notes on fit for ${_bm.buyerName}..." oninput="_bm.notes['${d.id}']=this.value">${_bm.notes[d.id]||''}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="action-btn" style="flex:1;padding:9px;font-size:13px;" onclick="_bmGoBack()">&larr; Back to Results</button>
        <button onclick="_bmTogSel('${d.id}');_bmGoBack();" style="flex:2;padding:9px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;background:${isSel?'#fee2e2':'#f0fdf4'};color:${isSel?'#dc2626':'#16a34a'};border:1px solid ${isSel?'#fca5a5':'#86efac'};">
          ${isSel?'&times; Remove &amp; Back':'+ Add to Pitch &amp; Back'}
        </button>
      </div>
    </div>`;
    return;
  }

  // ── REVIEW & COMPOSE ────────────────────────────────────────────
  if(_bm.showReview){
    const grouped=['warehouse','retail','multifamily'].map(t=>({t,ds:selDeals.filter(d=>_bmDealType(d)===t)})).filter(x=>x.ds.length);
    main.innerHTML=`
    <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:11px 18px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;">
      <button class="action-btn" onclick="_bm.showReview=false;_bm.showEmail=false;_renderBM();" style="font-size:12px;padding:5px 12px;">&larr; Back to Search</button>
      <div style="font-size:14px;font-weight:600;">Review &amp; Compose</div>
      <div style="font-size:12px;color:var(--text2);">${selCount} deal${selCount!==1?'s':''} selected for ${_bm.buyerName}</div>
    </div>
    <div style="max-width:780px;margin:0 auto;padding:20px 18px;">
      ${!selCount?`<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:32px;text-align:center;color:var(--text3);">No deals selected yet. Go back and add deals to the pitch.</div>`:''}
      ${grouped.map(({t,ds})=>`
      <div style="margin-bottom:22px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:${tColor[t]};margin-bottom:10px;">${tLabel[t]} &mdash; ${ds.length} deal${ds.length!==1?'s':''}</div>
        ${ds.map(d=>`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:7px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:5px;">${d['Address']||'—'}</div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text2);margin-bottom:8px;">
                <span>Ask: <strong style="color:var(--text);">${_bmFmt(d['Asking Price'])}</strong></span>
                <span>NOI: <strong style="color:var(--text);">${_bmFmt(d['NOI'])}</strong></span>
                <span>Cap: <strong style="color:var(--text);">${_bmPct(_bmCapRate(d))}</strong></span>
                ${_bmSF(d)?`<span>SF: ${_bmFS(_bmSF(d))}</span>`:''}
                ${_bmUnits(d)?`<span>Units: ${_bmUnits(d)}</span>`:''}
                <span style="color:var(--text3);">${_bmCounty(d)} Co.</span>
              </div>
              <input class="form-input" style="font-size:12px;background:var(--surface2);" placeholder="Buyer reply / notes on this deal..." oninput="_bm.notes['${d.id}']=this.value;_bm.buyerReply['${d.id}']=this.value;" value="${(_bm.buyerReply[d.id]||'').replace(/"/g,'&quot;')}" />
            </div>
            <div style="display:flex;gap:5px;flex-shrink:0;margin-top:2px;">
              <button class="action-btn" style="font-size:11px;padding:4px 9px;" onclick="_bm.fromView='review';_bm.detailId='${d.id}';_renderBM();">View</button>
              <button onclick="_bmTogSel('${d.id}')" style="font-size:11px;padding:4px 9px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:5px;cursor:pointer;">Remove</button>
            </div>
          </div>
        </div>`).join('')}
      </div>`).join('')}
      ${selCount>0?`<button onclick="_bmBuildEmail()" style="width:100%;padding:11px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:14px;font-weight:600;cursor:pointer;margin-bottom:18px;">Compose Pitch Email for ${_bm.buyerName} &rarr;</button>`:''}
      ${_bm.showEmail?`
      <!-- Gmail-style compose window -->
      <div style="background:#fff;border-radius:8px;box-shadow:0 2px 18px rgba(0,0,0,0.18);overflow:hidden;border:1px solid #e0e0e0;">
        <!-- Title bar -->
        <div style="background:#404040;padding:9px 16px;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:#fff;font-size:13px;font-weight:500;">New Message</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <button onclick="_bm.showEmail=false;_renderBM();" title="Close" style="background:none;border:none;color:#ccc;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:3px;" onmouseover="this.style.background='#666'" onmouseout="this.style.background='none'">✕</button>
          </div>
        </div>
        <!-- To field -->
        <div style="padding:8px 16px;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:#444;width:40px;flex-shrink:0;">To</span>
          <input type="text" value="${_bm.buyerEmail||''}" placeholder="recipient@email.com"
            oninput="_bm.buyerEmail=this.value"
            style="flex:1;border:none;outline:none;font-size:13px;color:#202124;background:transparent;"/>
        </div>
        <!-- Subject field -->
        <div style="padding:8px 16px;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:#444;width:40px;flex-shrink:0;">Subject</span>
          <input type="text" id="bmSubjectLine" value="Properties Matching Your Criteria — Ace Acquisitions"
            style="flex:1;border:none;outline:none;font-size:13px;color:#202124;background:transparent;font-weight:500;"/>
        </div>
        <!-- Body -->
        <textarea id="bmEmailBody" style="width:100%;min-height:380px;padding:14px 16px;border:none;font-size:13px;font-family:'Google Sans',Arial,sans-serif;line-height:1.7;resize:vertical;color:#202124;background:#fff;box-sizing:border-box;outline:none;" oninput="_bm.emailText=this.value">${_bm.emailText}</textarea>
        <!-- Toolbar -->
        <div style="padding:10px 16px;border-top:1px solid #e0e0e0;display:flex;align-items:center;gap:8px;background:#f8f8f8;flex-wrap:wrap;">
          <button onclick="_bmOpenGmail()"
            style="background:#1a73e8;color:#fff;border:none;padding:7px 18px;border-radius:4px;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
            Open in Gmail
          </button>
          <button id="bmCopyBtn2" onclick="try{navigator.clipboard.writeText(document.getElementById('bmEmailBody')?.value||_bm.emailText);}catch(e){} const b=document.getElementById('bmCopyBtn2'); b.textContent='✓ Copied!'; setTimeout(()=>{if(b)b.textContent='Copy text';},2500);"
            style="background:#fff;color:#444;border:1px solid #dadce0;padding:7px 14px;border-radius:4px;font-size:13px;cursor:pointer;">Copy text</button>
          <span style="font-size:11px;color:#888;margin-left:4px;">To: ${_bm.buyerEmail||'(enter email above)'}</span>
        </div>
      </div>`:''}
    </div>`;
    return;
  }

  // ── SEARCH ───────────────────────────────────────────────────────
  const f=_bm.filters[_bm.activeType];

  function _bmMultiPills(type,key,options){
    const cur=_bm.filters[type][key]||[];
    return options.map(o=>{
      const on=cur.includes(o);
      return `<button onclick="_bmTogArr('${type}','${key}','${o}')" style="padding:3px 9px;border-radius:99px;font-size:11px;cursor:pointer;border:1px solid ${on?tColor[type]:'var(--border2)'};background:${on?tBg[type]:'var(--surface2)'};color:${on?tColor[type]:'var(--text2)'};font-weight:${on?600:400};">${o}</button>`;
    }).join('');
  }

  function _bmCountyPills(type){
    const cols=_bm.filters[type].counties;
    return NJ_COUNTIES_ALL.map(c=>{
      const on=cols.includes(c);
      return `<button onclick="_bmTogCounty('${type}','${c}')" style="padding:3px 9px;border-radius:99px;font-size:11px;cursor:pointer;border:1px solid ${on?tColor[type]:'var(--border2)'};background:${on?tBg[type]:'var(--surface2)'};color:${on?tColor[type]:'var(--text2)'};font-weight:${on?600:400};">${c}</button>`;
    }).join('');
  }

  function _bmFilterPanel(){
    if(_bm.activeType==='warehouse') return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:13px;">
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Class</label>
        <select class="form-select" style="width:100%;" onchange="_bmUpd('warehouse','classType',this.value)">
          <option value=""${!f.classType?' selected':''}>Any</option>
          ${BM_WH_CLASSES.map(c=>`<option value="${c}"${f.classType===c?' selected':''}>Class ${c}</option>`).join('')}
        </select></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min SF</label><input class="form-input" type="number" value="${f.minSF}" placeholder="—" oninput="_bm.filters['warehouse']['minSF']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max SF</label><input class="form-input" type="number" value="${f.maxSF}" placeholder="—" oninput="_bm.filters['warehouse']['maxSF']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Price ($)</label><input class="form-input" type="number" value="${f.minPrice}" placeholder="—" oninput="_bm.filters['warehouse']['minPrice']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max Price ($)</label><input class="form-input" type="number" value="${f.maxPrice}" placeholder="—" oninput="_bm.filters['warehouse']['maxPrice']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Cap Rate %</label><input class="form-input" type="number" value="${f.minCap}" placeholder="—" step="0.1" oninput="_bm.filters['warehouse']['minCap']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max $/SF</label><input class="form-input" type="number" value="${f.maxPriceSF}" placeholder="—" oninput="_bm.filters['warehouse']['maxPriceSF']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Ceiling (ft)</label><input class="form-input" type="number" value="${f.minCeiling}" placeholder="—" oninput="_bm.filters['warehouse']['minCeiling']=this.value" onchange="_renderBM()"></div>
    </div>`;
    if(_bm.activeType==='retail') return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Price ($)</label><input class="form-input" type="number" value="${f.minPrice}" placeholder="—" oninput="_bm.filters['retail']['minPrice']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max Price ($)</label><input class="form-input" type="number" value="${f.maxPrice}" placeholder="—" oninput="_bm.filters['retail']['maxPrice']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min SF</label><input class="form-input" type="number" value="${f.minSF}" placeholder="—" oninput="_bm.filters['retail']['minSF']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max SF</label><input class="form-input" type="number" value="${f.maxSF}" placeholder="—" oninput="_bm.filters['retail']['maxSF']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Cap Rate %</label><input class="form-input" type="number" value="${f.minCap}" placeholder="—" step="0.1" oninput="_bm.filters['retail']['minCap']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Tenants</label><input class="form-input" type="number" value="${f.minTenants}" placeholder="—" oninput="_bm.filters['retail']['minTenants']=this.value" onchange="_renderBM()"></div>
    </div>
    <div style="margin-bottom:10px;"><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:5px;">Investment Profile</label><div style="display:flex;flex-wrap:wrap;gap:5px;">${_bmMultiPills('retail','profiles',BM_RETAIL_PROFILES)}</div></div>
    <div style="margin-bottom:10px;"><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:5px;">Property Subtype</label><div style="display:flex;flex-wrap:wrap;gap:5px;">${_bmMultiPills('retail','subtypes',BM_RETAIL_SUBTYPES)}</div></div>`;
    return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Units</label><input class="form-input" type="number" value="${f.minUnits}" placeholder="—" oninput="_bm.filters['multifamily']['minUnits']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max Units</label><input class="form-input" type="number" value="${f.maxUnits}" placeholder="—" oninput="_bm.filters['multifamily']['maxUnits']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Min Cap Rate %</label><input class="form-input" type="number" value="${f.minCap}" placeholder="—" step="0.1" oninput="_bm.filters['multifamily']['minCap']=this.value" onchange="_renderBM()"></div>
      <div><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:4px;">Max $/Unit</label><input class="form-input" type="number" value="${f.maxPriceUnit}" placeholder="—" oninput="_bm.filters['multifamily']['maxPriceUnit']=this.value" onchange="_renderBM()"></div>
    </div>
    <div style="margin-bottom:10px;"><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:5px;">Building Style</label><div style="display:flex;flex-wrap:wrap;gap:5px;">${_bmMultiPills('multifamily','styles',BM_MF_STYLES)}</div></div>
    <div style="margin-bottom:10px;"><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:5px;">Investment Profile</label><div style="display:flex;flex-wrap:wrap;gap:5px;">${_bmMultiPills('multifamily','profiles',BM_MF_PROFILES)}</div></div>`;
  }

  const resultRows=_bm.results?_bm.results.map(d=>{
    const isSel=_bm.selected.has(d.id);
    const cr=_bmCapRate(d), sf=_bmSF(d), units=_bmUnits(d), ppsf=_bmPPSF(d), ppu=_bmPPU(d);
    return `<div style="background:var(--surface);border:1px solid ${isSel?tColor[_bm.activeType]:'var(--border)'};border-radius:var(--radius-sm);padding:11px 15px;margin-bottom:7px;display:flex;align-items:center;gap:11px;">
      <input type="checkbox" ${isSel?'checked':''} onchange="_bmTogSel('${d.id}')" style="width:16px;height:16px;cursor:pointer;flex-shrink:0;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px;">${d['Address']||'—'}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text2);">
          <span>Ask: <strong style="color:var(--text);">${_bmFmt(d['Asking Price'])}</strong></span>
          <span>NOI: <strong style="color:var(--text);">${_bmFmt(d['NOI'])}</strong></span>
          <span>Cap: <strong style="color:var(--text);">${_bmPct(cr)}</strong></span>
          ${sf?`<span>SF: ${_bmFS(sf)}</span>`:''}
          ${units?`<span>Units: ${units}</span>`:''}
          ${ppsf?`<span>$/SF: $${Math.round(ppsf)}</span>`:''}
          ${ppu?`<span>$/Unit: ${_bmFmt(ppu)}</span>`:''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <span style="font-size:11px;color:var(--text3);">${_bmCounty(d)}</span>
        ${stageBadge(getStage(d))}
        <button class="action-btn" style="font-size:11px;padding:4px 9px;" onclick="_bm.fromView='search';_bm.detailId='${d.id}';_renderBM();">Details</button>
      </div>
    </div>`;
  }).join(''):'';

  main.innerHTML=`
  <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:11px 18px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;">
    <button class="action-btn" onclick="showBuyerCriteriaPage()" style="font-size:12px;padding:5px 12px;">&larr; Buyer Criteria</button>
    <div><div style="font-size:14px;font-weight:600;">Find Deals &mdash; ${_bm.buyerName}</div>
    <div style="font-size:11px;color:var(--text2);">${_bm.buyerCompany}</div></div>
    ${revBtnHtml}
  </div>
  <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:0 18px;display:flex;">
    ${_bm.availTypes.map(t=>{
      const active=_bm.activeType===t;
      const cnt=selDeals.filter(d=>_bmDealType(d)===t).length;
      return `<button onclick="_bm.activeType='${t}';_bm.results=null;_renderBM();" style="padding:10px 16px;border:none;border-bottom:${active?'2px solid '+tColor[t]:'2px solid transparent'};background:none;font-size:13px;font-weight:${active?600:400};color:${active?tColor[t]:'var(--text2)'};cursor:pointer;white-space:nowrap;">
        ${tLabel[t]}${cnt>0?` <span style="margin-left:5px;background:${tBg[t]};color:${tColor[t]};border-radius:99px;padding:1px 7px;font-size:10px;font-weight:600;">${cnt}</span>`:''}
      </button>`;
    }).join('')}
  </div>
  <div style="max-width:940px;margin:0 auto;padding:16px 18px;">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:14px;">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--text2);margin-bottom:13px;">
        Filters &mdash; ${tLabel[_bm.activeType]}
        <span style="font-size:10px;font-weight:400;margin-left:8px;color:var(--text3);">Pre-filled from buyer criteria where available</span>
      </div>
      ${_bmFilterPanel()}
      <div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--text2);display:block;margin-bottom:5px;">Counties (all NJ)</label><div style="display:flex;flex-wrap:wrap;gap:5px;">${_bmCountyPills(_bm.activeType)}</div></div>
      <button onclick="_bmSearch()" style="background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);padding:8px 24px;font-size:13px;font-weight:600;cursor:pointer;">Search Deals &rarr;</button>
    </div>
    ${_bm.results!==null?`
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">${_bm.results.length} deal${_bm.results.length!==1?'s':''} found in your pipeline${_bm.results.length>0?' &mdash; check to add to pitch':''}</div>
    ${_bm.results.length===0?`<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px;text-align:center;color:var(--text3);font-size:13px;">No deals match these filters. Try broadening your criteria.</div>`:resultRows}`:''}
  </div>`;
}
let _bmMatches = [];         // cached match results for current deal
let _bmOutreach = {};        // contactId → [{activity_type, date_sent, response_status, ...}]
let _bmCallNotes = {};       // fub_contact_id → [note strings] aggregated from fub_calls
let _bmCollapsedTiers = new Set();  // tier numbers that are collapsed
let _bmSelected = new Set();        // match.id values currently checkbox-selected

// ─── ASSET TYPE FUZZY MATCHING ────────────────────────────────
// Maps a property/buyer asset string to a canonical category for matching.
// Returns an array because buyers can want multiple types ("Multifamily, Retail").
export const _BM_ASSET_CANON = [
  {canon:'multifamily',  aliases:['multifamily','multi family','multi-family','mf','apartment','apartments']},
  {canon:'mixed_use',    aliases:['mixed use','mixed-use','mixeduse']},
  {canon:'retail',       aliases:['retail','retail strip','strip mall','retail: strip','retail strips','shopping center']},
  {canon:'restaurant',   aliases:['restaurant','retail: restaurant','bar','deli','diner','food service']},
  {canon:'warehouse',    aliases:['warehouse','industrial','flex','distribution','manufacturing','flex warehouse']},
  {canon:'office',       aliases:['office','professional','medical office']},
  {canon:'hotel',        aliases:['hotel','motel','hospitality','inn','bed and breakfast','bnb']},
  {canon:'land',         aliases:['land','vacant land','raw land','development','land: development','developable']},
  {canon:'auto',         aliases:['auto','car wash','auto body','gas station','service station','auto service']},
  {canon:'daycare',      aliases:['daycare','day care','child care','childcare']},
  {canon:'storage',      aliases:['self storage','self-storage','storage facility']},
  {canon:'medical',      aliases:['medical','medical office','healthcare','clinic']},
];

export function _bmCanonicalAssets(str){
  if(!str) return [];
  const clean = String(str).replace(/[🔴🟠🟡🟢🔵🟣]/g,'').toLowerCase();
  const found = new Set();
  for(const {canon, aliases} of _BM_ASSET_CANON){
    if(aliases.some(a => clean.includes(a))) found.add(canon);
  }
  if([...found].some(f => f==='restaurant')) found.add('retail');
  return [...found];
}

export function _bmExtractCounties(str){
  if(!str) return [];
  const clean = String(str).toLowerCase();
  if(/\b(all of|anywhere|all|statewide)\b/.test(clean)) return ['__any__'];
  return clean.split(/[,;\/]/).map(s=>s.trim().replace(/\s*county$/,'')).filter(Boolean);
}

// ─── NOTES PARSING FOR SECONDARY SIGNALS ──────────────────────
// Extracts structured hints from free-text "other_requirements" notes.
// Critical: be CONSERVATIVE. False positives (phone numbers parsed as prices,
// FUB source tags parsed as locations) are worse than missing data.
// Every extracted value is flagged as "parsed — agent review required".
export function _bmParseNotes(notes){
  const out = { notesParsed: false, reviewNeeded: false };
  if(!notes || typeof notes !== 'string') return out;
  const text = notes.toLowerCase();

  // ── UNIT COUNTS ──────────────────────────────────────────
  // "2-6 units", "10+ units", "100 units and above", "MF 2+"
  // Require the word "unit" or "mf N+" context. Single digits like "6 unit"
  // are NOT enough to infer a range.
  const unitRangeMatch = text.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*units?/i);
  if(unitRangeMatch){
    const lo = Number(unitRangeMatch[1]), hi = Number(unitRangeMatch[2]);
    // Sanity: 1-500 units is the plausible residential/commercial range
    if(lo >= 1 && hi >= lo && hi <= 500){
      out.unitsMin = lo;
      out.unitsMax = hi;
      out.notesParsed = true;
    }
  } else {
    const unitPlusMatch = text.match(/(\d{1,4})\s*\+\s*units?|mf\s*(\d{1,4})\s*\+/i);
    if(unitPlusMatch){
      const n = Number(unitPlusMatch[1] || unitPlusMatch[2]);
      if(n >= 1 && n <= 500){
        out.unitsMin = n;
        out.notesParsed = true;
      }
    } else {
      const unitAboveMatch = text.match(/(\d{1,4})\s*units?\s*(and\s*above|or\s*more|plus)/i);
      if(unitAboveMatch){
        const n = Number(unitAboveMatch[1]);
        if(n >= 1 && n <= 500){
          out.unitsMin = n;
          out.notesParsed = true;
        }
      }
    }
  }

  // ── PRICE RANGES ─────────────────────────────────────────
  // STRICT RULES to avoid phone number false positives:
  //   1. A unit keyword (m/mil/million/k) MUST appear, OR
  //   2. A $ symbol MUST precede the number
  //   3. Sanity: commercial RE prices are $50K to $500M
  //   4. Skip if the match looks adjacent to a phone number pattern
  const PRICE_MIN = 50_000;
  const PRICE_MAX = 500_000_000;
  const isSaneRePrice = n => n != null && n >= PRICE_MIN && n <= PRICE_MAX;

  const toNum = (raw, unit) => {
    const n = parseFloat(raw);
    if(isNaN(n)) return null;
    if(unit && /^m|mil|million/i.test(unit)) return Math.round(n * 1_000_000);
    if(unit && /^k/i.test(unit)) return Math.round(n * 1_000);
    // No unit — return as-is (raw dollars). Only valid if a $ was present.
    return Math.round(n);
  };

  // Regex requires EITHER $ OR a unit keyword after each number.
  // Pattern: [$]?NUM[m/mil/million/k] [dash] [$]?NUM[m/mil/million/k]
  const priceRangeRe = /(\$)?\s*(\d+(?:\.\d+)?)\s*(m|mil|million|k)?\s*[-–—]\s*(\$)?\s*(\d+(?:\.\d+)?)\s*(m|mil|million|k)?/gi;
  let prMatch;
  while((prMatch = priceRangeRe.exec(text)) !== null){
    const [full, dol1, n1, u1, dol2, n2, u2] = prMatch;
    // Must have at least one $ or one unit
    if(!dol1 && !dol2 && !u1 && !u2) continue;
    // Phone number guard: check if the match is inside a phone-number context
    // (e.g. "201-233-9720" — if another dash+digits follows our match, skip)
    const tailStart = prMatch.index + full.length;
    const tail = text.substring(tailStart, tailStart + 8);
    if(/^\s*[-–—]\s*\d/.test(tail)) continue; // looks like NNN-NNN-NNNN
    // Also check if preceded by a dash+digits (middle of phone number)
    const headStart = Math.max(0, prMatch.index - 8);
    const head = text.substring(headStart, prMatch.index);
    if(/\d\s*[-–—]\s*$/.test(head)) continue;

    // Inherit unit from whichever side has it
    const unit = u2 || u1 || '';
    const lo = toNum(n1, unit);
    const hi = toNum(n2, unit);
    if(isSaneRePrice(lo) && isSaneRePrice(hi) && lo < hi){
      out.priceMin = lo;
      out.priceMax = hi;
      out.notesParsed = true;
      break;
    }
  }

  // Single-value price: "up to $5m", "under 2 million", "max $1.5M"
  if(out.priceMax == null){
    const upToMatch = text.match(/(?:up to|max|maximum|under|below|anything under)\s*\$?\s*(\d+(?:\.\d+)?)\s*(m|mil|million|k)/i);
    if(upToMatch){
      const v = toNum(upToMatch[1], upToMatch[2]);
      if(isSaneRePrice(v)){
        out.priceMax = v;
        out.notesParsed = true;
      }
    }
  }
  if(out.priceMin == null){
    const minMatch = text.match(/(?:at least|min|minimum|above|over|starting at)\s*\$?\s*(\d+(?:\.\d+)?)\s*(m|mil|million|k)/i);
    if(minMatch){
      const v = toNum(minMatch[1], minMatch[2]);
      if(isSaneRePrice(v)){
        out.priceMin = v;
        out.notesParsed = true;
      }
    }
  }

  // ── CAP RATE ─────────────────────────────────────────────
  // Must say "cap" explicitly and be in sensible range (1-25%)
  const capMatch = text.match(/(\d{1,2}(?:\.\d+)?)\s*%?\s*cap\b/i);
  if(capMatch){
    const cap = parseFloat(capMatch[1]);
    if(cap >= 1 && cap <= 25){
      out.minCap = cap;
      out.notesParsed = true;
    }
  }

  // ── NJ COUNTIES ──────────────────────────────────────────
  // v267: this is a LOCAL lowercase variant for case-insensitive matching;
  // the perl regex during migration mangled `const NJ_COUNTIES = [...]` into
  // `const window.NJ_COUNTIES = [...]`. Renamed to `_njLower` to avoid the
  // collision and preserve the original local-variable intent.
  const _njLower = ['atlantic','bergen','burlington','camden','cape may','cumberland','essex',
    'gloucester','hudson','hunterdon','mercer','middlesex','monmouth','morris','ocean',
    'passaic','salem','somerset','sussex','union','warren'];
  // For "union" we need word boundaries — "union" is also a common noun
  const notesCounties = [];
  for(const c of _njLower){
    const re = new RegExp('\\b'+c+'\\b(?:\\s+county)?','i');
    if(re.test(text)){
      // Extra check for "union" — only count if followed by "county" or in a "counties:" list
      if(c === 'union' && !/union\s+county|in\s+union|counties?:|properties?\s+in/.test(text)) continue;
      notesCounties.push(c);
    }
  }
  if(notesCounties.length){
    out.notesCounties = notesCounties;
    out.notesParsed = true;
  }

  // ── NJ CITIES / MUNICIPALITIES ───────────────────────────
  // Curated list of commonly-mentioned NJ commercial-active cities.
  // Multi-word cities first so "west new york" matches before "new york".
  const NJ_CITIES = [
    'west new york','west orange','east orange','south orange','north bergen',
    'north arlington','south amboy','south plainfield','north plainfield',
    'east brunswick','north brunswick','south brunswick','new brunswick',
    'perth amboy','asbury park','long branch','toms river','cherry hill',
    'atlantic city','jersey city','union city','fair lawn','fort lee',
    'atlantic highlands','highland park','highlands','bound brook',
    'red bank','point pleasant','cedar grove','glen rock','river edge',
    // Single-word cities
    'newark','elizabeth','paterson','trenton','camden','edison','woodbridge',
    'lakewood','toms','hamilton','clifton','bayonne','passaic','vineland',
    'union','piscataway','kearny','linden','montclair','hoboken','plainfield',
    'hackensack','bloomfield','westfield','summit','princeton','morristown',
    'freehold','middletown','howell','brick','marlboro','manalapan','wayne',
    'parsippany','livingston','maplewood','irvington','orange','cranford',
    'rahway','roselle','nutley','lodi','belleville','millburn','madison',
    'chatham','verona','caldwell','rutherford','lyndhurst','teaneck','paramus',
    'englewood','dumont','ridgewood','glen ridge','wallington','garfield',
    'totowa','prospect park','haledon','pompton','lincoln park','kinnelon',
    'butler','boonton','denville','dover','wharton','rockaway','pequannock',
    'lincroft','keyport','keansburg','matawan','hazlet','aberdeen','holmdel',
    'eatontown','tinton falls','oceanport','shrewsbury','colts neck','rumson',
    'sea bright','spring lake','manasquan','wall','neptune','ocean',
    'jackson','millstone','cranbury','monroe','plainsboro','west windsor',
    'ewing','lawrenceville','pennington','hopewell','flemington','clinton',
    'frenchtown','lambertville','somerville','hillsborough','manville',
    'bridgewater','warren','watchung','green brook','bernardsville','basking ridge',
    'bedminster','peapack','far hills','gladstone','chester','mendham'
  ];

  const notesCities = new Set();
  for(const city of NJ_CITIES){
    // Word-boundary match. "west new york" uses spaces so \b works at ends.
    const re = new RegExp('\\b'+city.replace(/\s+/g,'\\s+')+'\\b','i');
    if(re.test(text)) notesCities.add(city);
  }
  // Dedupe: if "west new york" matched, remove bare "new york" etc.
  // (Our list doesn't include "new york" as a bare city so this is mostly defensive.)
  if(notesCities.size){
    out.notesCities = [...notesCities];
    out.notesParsed = true;
  }

  // ── STYLE / LOCATION KEYWORDS ────────────────────────────
  // Not exhaustive — just common tags that appear in buyer notes.
  const STYLE_KEYWORDS = [
    'blue collar','white collar','gentrifying','transit oriented','transit-oriented',
    'rentals','flips','value add','value-add','turnkey','distressed','stabilized',
    'class a','class b','class c','garden style','high rise','mid rise','low rise',
    'mixed use','new construction','historic','walkable','downtown','waterfront'
  ];
  const foundStyles = STYLE_KEYWORDS.filter(k => text.includes(k));
  if(foundStyles.length){
    out.styles = foundStyles;
    out.notesParsed = true;
  }

  // If ANYTHING was parsed, flag for agent review
  if(out.notesParsed) out.reviewNeeded = true;

  return out;
}

export async function loadBuyerMatchTab(dealId){
  if(!dealId) return;
  const cfg = getConfig();
  if(!cfg.key && !isSupabase()){
    const r = document.getElementById('bmResults');
    if(r) r.innerHTML = '<div style="color:#c00;padding:10px;">Connect your database first.</div>';
    return;
  }

  const status = document.getElementById('bmStatus');
  const results = document.getElementById('bmResults');
  if(status) status.textContent = 'Fetching buyer criteria...';
  if(results) results.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">⏳ Running match analysis...</div>';

  // Reset selection + collapse state on every load
  _bmSelected = new Set();
  _bmCollapsedTiers = new Set();
  _bmUpdateBulkBar();

  try {
    let buyers = [], contacts = {};

    if(isSupabase()){
      // Single query with embedded contact data to avoid URL-length issues.
      // We include fub_contact_id so we can bulk-fetch call notes for all buyers
      // in one follow-up query, enriching the AI parser with call history.
      const cols = [
        'id','contact_id','desired_property_types','location_preferences',
        'simple_area_preference','preferred_cities','preferred_states','minimum_cap_rate',
        'min_purchase_price','max_purchase_price','mf_min_units','mf_max_units',
        'warehouse_min_sf','warehouse_max_sf','is_vip_buyer','vip_asset_types',
        'other_requirements',
        'ace_contacts(id,name,phone_number,email,company,fub_contact_id)'
      ].join(',');
      const rows = await _sbGet(SB_TABLES.buyerCriteria, 'select='+cols);
      if(!Array.isArray(rows)) throw new Error('Buyer criteria fetch returned non-array: '+JSON.stringify(rows).slice(0,200));
      buyers = rows.map(row => {
        const c = row.ace_contacts;
        if(c && c.id){
          contacts[c.id] = {
            Name: c.name,
            'Phone Number': c.phone_number,
            Email: c.email,
            Company: c.company,
            '_fubContactId': c.fub_contact_id || null
          };
        }
        return { id:row.id, fields:{
          'Simple Text Desired Property Type': row.desired_property_types||'',
          'Simple Area Preference':            row.simple_area_preference||'',
          'Location Preferences':              row.location_preferences||'',
          'Preferred Cities':                  row.preferred_cities||'',
            'Preferred States':                  row.preferred_states||'',
          'Minumum Cap Rate':                  row.minimum_cap_rate,
          'Min Purchase Price':                row.min_purchase_price,
          'Max Purchase Price':                row.max_purchase_price,
          'Minimum # of Units MF':             row.mf_min_units,
          'Max # of Units MF':                 row.mf_max_units,
          'Warehouse Min Square Footage':      row.warehouse_min_sf,
          'Warehouse Max Square Footage':      row.warehouse_max_sf,
          'Is VIP Buyer':                      row.is_vip_buyer,
          'VIP Asset Types':                   row.vip_asset_types,
          'Other Requirements ':               row.other_requirements||'',
          'Buyer':                             row.contact_id?[row.contact_id]:[],
          '_contactId':                        row.contact_id,
          '_fubContactId':                     c?.fub_contact_id || null
        }};
      });

      // Bulk-fetch call notes for every buyer's fub_contact_id in one go.
      // Store in a global _bmCallNotes map { fubContactId -> combined notes string }
      // so scoreBuyerMatch can use it without more queries per buyer.
      _bmCallNotes = {};
      const fubIds = [...new Set(buyers.map(b => b.fields._fubContactId).filter(Boolean))];
      if(fubIds.length){
        try {
          // Chunk the IN clause — with ~428 bigints this URL will be ~2.5KB, well under limits,
          // but we chunk anyway to be safe and because `note is not null` filter reduces volume.
          const BATCH = 200;
          for(let i=0; i<fubIds.length; i+=BATCH){
            const chunk = fubIds.slice(i, i+BATCH);
            const callRows = await _sbGet('fub_calls',
              `person_id=in.(${chunk.join(',')})&note=not.is.null&select=person_id,note,created_at&order=created_at.desc&limit=2000`);
            (callRows||[]).forEach(r => {
              if(!r.note || !r.person_id) return;
              if(!_bmCallNotes[r.person_id]) _bmCallNotes[r.person_id] = [];
              // Cap individual call notes to 500 chars and total per buyer to ~2000 chars
              if(_bmCallNotes[r.person_id].join(' ').length < 2000){
                _bmCallNotes[r.person_id].push(r.note.substring(0, 500));
              }
            });
          }
        } catch(e){
          console.warn('Call notes bulk fetch failed (non-fatal):', e.message);
        }
      }

      // Load outreach history for this deal in parallel. Any prior email/call/text
      // to a buyer about THIS property shows as a badge on their row.
      try {
        const outreachRows = await _sbGet(SB_TABLES.buyerInterests,
          `property_id=eq.${dealId}&select=id,contact_id,activity_type,date_sent,response_status,response_notes,interest_notes,template_used,agent_name&order=date_sent.desc`);
        _bmOutreach = {};
        (outreachRows||[]).forEach(r => {
          if(!r.contact_id) return;
          if(!_bmOutreach[r.contact_id]) _bmOutreach[r.contact_id] = [];
          _bmOutreach[r.contact_id].push(r);
        });
      } catch(e){
        console.warn('Outreach history fetch failed (non-fatal):', e.message);
        _bmOutreach = {};
      }
    } else {
      // Airtable fallback — outreach tracking not supported in Airtable mode
      let url = `https://api.airtable.com/v0/${cfg.base}/tbltwNvbX5T3t9wRE?pageSize=100`;
      while(url){
        const res = await fetch(url, {headers:{Authorization:`Bearer ${cfg.key}`}});
        const data = await res.json();
        buyers = buyers.concat(data.records||[]);
        url = data.offset ? `https://api.airtable.com/v0/${cfg.base}/tbltwNvbX5T3t9wRE?pageSize=100&offset=${data.offset}` : null;
      }
      const contactIds = [...new Set(buyers.flatMap(b=>b.fields['Buyer']||[]))];
      if(contactIds.length){
        const formula = encodeURIComponent(`OR(${contactIds.map(id=>`RECORD_ID()="${id}"`).join(',')})`);
        const cRes = await fetch(`https://api.airtable.com/v0/${cfg.base}/tblpTluzDlrvMCaca?filterByFormula=${formula}&fields[]=Name&fields[]=Phone+Number&fields[]=Email`,{headers:{Authorization:`Bearer ${cfg.key}`}});
        const cData = await cRes.json();
        (cData.records||[]).forEach(r=>{ contacts[r.id]=r.fields; });
      }
      _bmOutreach = {};
    }

    const deal = window.currentDeal;
    _bmMatches = buyers.map(b => scoreBuyerMatch(deal, b, contacts)).filter(m => m && m.tier <= 6);
    _bmMatches.sort((a,b) => {
      if(a.tier !== b.tier) return a.tier - b.tier;
      if(a.isVip !== b.isVip) return a.isVip ? -1 : 1;
      return b.score - a.score;
    });

    if(status){
      const t1 = _bmMatches.filter(m=>m.tier===1).length;
      const t2 = _bmMatches.filter(m=>m.tier===2).length;
      const t3 = _bmMatches.filter(m=>m.tier===3).length;
      const tLow = _bmMatches.filter(m=>m.tier>=4).length;
      status.textContent = `${buyers.length} buyers analyzed · ${t1} perfect · ${t2} strong · ${t3} good · ${tLow} broader`;
    }
    const filters = document.getElementById('bmFilters');
    if(filters) filters.style.display='flex';
    document.querySelectorAll('.bmTierFilter').forEach(cb=>{ cb.onchange = bmApplyFilter; });
    bmApplyFilter();

  } catch(e){
    if(results) results.innerHTML = `<div style="color:#c00;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
      <strong>Error loading buyer matches:</strong><br>
      <span style="font-size:11px;">${(e && e.message) || e}</span><br><br>
      <button class="save-btn" onclick="loadBuyerMatchTab('${dealId}')">Retry</button>
    </div>`;
    if(status) status.textContent = '';
  }
}

export function scoreBuyerMatch(deal, buyerRecord, contacts){
  const f = buyerRecord.fields;
  const contactId = (f['Buyer']||[])[0];
  const contact   = contacts[contactId] || {};
  const buyerName = contact.Name || f['Name']?.split(' - ')[0] || 'Unknown';

  const propTypeStr  = deal['Simple Text Property Type'] || deal['CRM Asset Classification'] || '';
  const propAssets   = _bmCanonicalAssets(propTypeStr);
  const propCounty   = (deal['Simple County']||'').toLowerCase().replace(/\s*county$/,'').trim();
  const propCity     = (deal['Municipality']||deal['City']||'').toLowerCase().trim();
  // Extract state from the address. Match ", XX " or ", XX," or " XX " where XX is
  // an uppercase 2-letter code. Default to 'NJ' for this NJ-focused CRM when no
  // match is found, since most deals are in-state.
  const propAddrRaw  = String(deal['Address']||'').trim();
  let propState      = 'NJ';
  const stMatch = propAddrRaw.match(/,\s*([A-Za-z]{2})\s+\d{5}/);
  if(stMatch){
    propState = stMatch[1].toUpperCase();
  }
  const propUnits    = Number(deal['No. of Units']) || 0;
  const propSF       = Number(deal['Net Rentable SF']||deal['Square Footage']) || 0;
  const propCapRaw   = Number(deal['Cap Rate (CRM)']||deal['Cap Rate (Asking Price)']||0);
  const propCap      = propCapRaw > 0 && propCapRaw < 1 ? propCapRaw * 100 : propCapRaw;
  const propAsk      = Number(deal['Asking Price']) || 0;

  const buyerAssetStr = f['Simple Text Desired Property Type'] || '';
  const buyerAssets   = _bmCanonicalAssets(buyerAssetStr);
  const buyerAreaStr  = f['Simple Area Preference'] || f['Location Preferences'] || '';
  const buyerCounties = _bmExtractCounties(buyerAreaStr);
  const buyerCities   = _bmExtractCounties(f['Preferred Cities']||'');
  // Parse preferred states. Pills are stored as "FL — Florida, NY — New York" etc.
  // Extract just the 2-letter codes.
  const buyerStatesStr = f['Preferred States']||'';
  const buyerStates    = buyerStatesStr
    ? buyerStatesStr.split(',').map(s => s.trim().split(/\s+/)[0].toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s))
    : [];
  const buyerMinU_s   = f['Minimum # of Units MF'] != null ? Number(f['Minimum # of Units MF']) : null;
  const buyerMaxU_s   = f['Max # of Units MF'] != null ? Number(f['Max # of Units MF']) : null;
  const buyerMinP_s   = f['Min Purchase Price'] != null ? Number(f['Min Purchase Price']) : null;
  const buyerMaxP_s   = f['Max Purchase Price'] != null ? Number(f['Max Purchase Price']) : null;
  const buyerMinCap_s = f['Minumum Cap Rate'] != null ? Number(f['Minumum Cap Rate']) : null;
  const buyerMinSF_s  = f['Warehouse Min Square Footage'] != null ? Number(f['Warehouse Min Square Footage']) : null;
  const buyerMaxSF_s  = f['Warehouse Max Square Footage'] != null ? Number(f['Warehouse Max Square Footage']) : null;
  const isVip         = !!f['Is VIP Buyer'];
  const buyerNotes    = f['Other Requirements '] || f['Other Requirements'] || '';

  // Concatenate call notes from fub_calls for richer AI suggestions.
  // We keep other_requirements as the primary source, and call notes as supplementary.
  // The separator ' | ' prevents regex matches from spanning across different notes.
  const fubId = f._fubContactId;
  const callNotesArr = (fubId && _bmCallNotes[fubId]) ? _bmCallNotes[fubId] : [];
  const combinedNotes = callNotesArr.length
    ? (buyerNotes + ' | ' + callNotesArr.join(' | '))
    : buyerNotes;

  const parsed = _bmParseNotes(combinedNotes);
  const buyerMinU   = buyerMinU_s   != null ? buyerMinU_s   : (parsed.unitsMin ?? null);
  const buyerMaxU   = buyerMaxU_s   != null ? buyerMaxU_s   : (parsed.unitsMax ?? null);
  const buyerMinP   = buyerMinP_s   != null ? buyerMinP_s   : (parsed.priceMin ?? null);
  const buyerMaxP   = buyerMaxP_s   != null ? buyerMaxP_s   : (parsed.priceMax ?? null);
  const buyerMinCap = buyerMinCap_s != null ? buyerMinCap_s : (parsed.minCap   ?? null);
  const parsedFields = [];
  if(buyerMinU_s == null && parsed.unitsMin != null) parsedFields.push('unit range');
  if(buyerMinP_s == null && (parsed.priceMin != null || parsed.priceMax != null)) parsedFields.push('price range');
  if(buyerMinCap_s == null && parsed.minCap != null) parsedFields.push('cap rate');

  let effectiveCounties = buyerCounties;
  if(effectiveCounties.length === 0 && parsed.notesCounties?.length){
    effectiveCounties = parsed.notesCounties;
    parsedFields.push('county');
  }

  // Use notesCities as a fallback when structured preferred_cities is empty
  let effectiveCities = buyerCities;
  if(effectiveCities.length === 0 && parsed.notesCities?.length){
    effectiveCities = parsed.notesCities;
    parsedFields.push('cities');
  }

  if(parsed.styles?.length) parsedFields.push('style prefs');

  const checks = [];
  const check = (label, status, detail, wants, weight=10) =>
    checks.push({label, status, detail, wants, weight});

  // 1. ASSET TYPE
  const assetOverlap = propAssets.some(p => buyerAssets.includes(p));
  check('Asset Type',
    assetOverlap ? 'pass' : 'fail',
    assetOverlap
      ? `✓ ${propAssets.join('/') || '—'} matches`
      : `no match`,
    buyerAssetStr || '—',
    40
  );

  // 2. STATE (new in v60 — critical filter before county)
  // If buyer has explicit state preferences and deal isn't in one of them, this
  // match fails completely. Treated as a hard filter since it's no use showing
  // an NJ deal to a FL-only buyer.
  let stateStatus;
  if(buyerStates.length === 0){
    stateStatus = 'skip';
  } else if(buyerStates.includes(propState)){
    stateStatus = 'pass';
  } else {
    stateStatus = 'fail';
  }
  check('State',
    stateStatus,
    stateStatus === 'pass' ? `✓ ${propState} matches`
    : stateStatus === 'skip' ? 'No state preference'
    : `deal is in ${propState}`,
    buyerStatesStr || '—',
    30
  );

  // 3. COUNTY (renumbered from 2)
  let countyStatus;
  if(effectiveCounties.length === 0){
    countyStatus = 'skip';
  } else if(effectiveCounties.includes('__any__')){
    countyStatus = 'pass';
  } else if(propCounty && effectiveCounties.some(c => c.includes(propCounty) || propCounty.includes(c))){
    countyStatus = 'pass';
  } else {
    countyStatus = 'fail';
  }
  check('County',
    countyStatus,
    countyStatus === 'pass' ? `✓ ${propCounty||'?'} matches`
    : countyStatus === 'skip' ? 'No county preference'
    : `deal is in ${propCounty||'?'}`,
    buyerAreaStr || '—',
    25
  );

  // 3. CITY
  let cityStatus;
  if(effectiveCities.length === 0){
    cityStatus = 'skip';
  } else if(propCity && effectiveCities.some(c => c.includes(propCity) || propCity.includes(c))){
    cityStatus = 'pass';
  } else {
    cityStatus = 'fail';
  }
  check('City',
    cityStatus,
    cityStatus === 'pass' ? `✓ ${propCity} matches`
    : cityStatus === 'skip' ? 'No city preference'
    : `deal is in ${propCity||'?'}`,
    f['Preferred Cities'] || (parsed.notesCities?.length ? parsed.notesCities.join(', ')+' (from notes)' : '—'),
    10
  );

  // 4. PRICE RANGE
  const fmtM = n => {
    if(n == null || n === '') return '—';
    const num = Number(n);
    if(isNaN(num) || num === 0) return '—';
    if(num >= 1_000_000) return '$'+(num/1e6).toFixed(2).replace(/\.?0+$/,'')+'M';
    if(num >= 1_000) return '$'+(num/1000).toFixed(0)+'K';
    return '$'+num;
  };
  let priceStatus, priceWants = '—';
  if(buyerMinP == null && buyerMaxP == null){
    priceStatus = 'skip';
  } else if(propAsk <= 0){
    priceStatus = 'skip';
  } else {
    const aboveMin = buyerMinP == null || propAsk >= buyerMinP;
    const belowMax = buyerMaxP == null || propAsk <= buyerMaxP;
    priceStatus = (aboveMin && belowMax) ? 'pass' : 'fail';
    priceWants = `${fmtM(buyerMinP)}–${fmtM(buyerMaxP)}`;
  }
  check('Price Range',
    priceStatus,
    priceStatus === 'pass' ? `✓ ${fmtM(propAsk)} fits`
    : priceStatus === 'skip' ? 'No price range'
    : `deal is ${fmtM(propAsk)}`,
    priceWants,
    15
  );

  // 5. UNIT COUNT
  let unitsStatus = 'skip', unitsWants = '—';
  if(propAssets.includes('multifamily') || propAssets.includes('mixed_use')){
    if(buyerMinU == null && buyerMaxU == null){
      unitsStatus = 'skip';
    } else if(propUnits <= 0){
      unitsStatus = 'skip';
    } else {
      const aboveMin = buyerMinU == null || propUnits >= buyerMinU;
      const belowMax = buyerMaxU == null || propUnits <= buyerMaxU;
      unitsStatus = (aboveMin && belowMax) ? 'pass' : 'fail';
      unitsWants = `${buyerMinU||'any'}–${buyerMaxU||'any'} units`;
    }
  }
  check('Unit Count',
    unitsStatus,
    unitsStatus === 'pass' ? `✓ ${propUnits} units fits`
    : unitsStatus === 'skip' ? (propAssets.includes('multifamily') ? 'No unit range' : 'N/A (not MF)')
    : `deal has ${propUnits} units`,
    unitsWants,
    15
  );

  // 6. MIN CAP RATE
  let capStatus = 'skip', capWants = '—';
  if(buyerMinCap != null){
    if(propCap > 0){
      capStatus = propCap >= buyerMinCap ? 'pass' : 'fail';
      capWants = `≥${buyerMinCap}%`;
    } else {
      capStatus = 'skip';
    }
  }
  check('Min Cap Rate',
    capStatus,
    capStatus === 'pass' ? `✓ ${propCap.toFixed(2)}% ≥ ${buyerMinCap}%`
    : capStatus === 'skip' ? 'No cap requirement'
    : `deal cap is ${propCap.toFixed(2)}%`,
    capWants,
    10
  );

  // 7. WAREHOUSE SF
  if(propAssets.includes('warehouse')){
    let sfStatus = 'skip', sfWants = '—';
    if(buyerMinSF_s != null || buyerMaxSF_s != null){
      if(propSF > 0){
        const aboveMin = buyerMinSF_s == null || propSF >= buyerMinSF_s;
        const belowMax = buyerMaxSF_s == null || propSF <= buyerMaxSF_s;
        sfStatus = (aboveMin && belowMax) ? 'pass' : 'fail';
        sfWants = `${buyerMinSF_s?.toLocaleString()||'any'}–${buyerMaxSF_s?.toLocaleString()||'any'} SF`;
      }
    }
    check('Square Footage',
      sfStatus,
      sfStatus === 'pass' ? `✓ ${propSF.toLocaleString()} SF fits`
      : sfStatus === 'skip' ? 'No SF requirement'
      : `deal is ${propSF.toLocaleString()} SF`,
      sfWants,
      10
    );
  }

  const getStatus = label => checks.find(c => c.label === label)?.status;
  if(getStatus('Asset Type') !== 'pass') return null;
  // State is a hard filter: if the buyer explicitly wants FL and deal is NJ,
  // don't show it in the match list at all.
  if(getStatus('State') === 'fail') return null;

  const anyFail = checks.some(c => c.status === 'fail');
  if(anyFail){
    const priceFailed  = getStatus('Price Range') === 'fail';
    const unitsFailed  = getStatus('Unit Count') === 'fail';
    const countyFailed = getStatus('County') === 'fail';
    if(countyFailed){
      return { ...buildResult(), tier: 6, tierLabel: '〰 Asset Only',
        tierReason: 'County mismatch — buyer wants a different area' };
    }
    if(priceFailed || unitsFailed){
      return { ...buildResult(), tier: 5, tierLabel: '➡ Asset + County',
        tierReason: (priceFailed?'Price out of range':'')+(priceFailed&&unitsFailed?' & ':'')+(unitsFailed?'Unit count out of range':'') };
    }
    return { ...buildResult(), tier: 4, tierLabel: '✓ Decent',
      tierReason: 'Minor criteria mismatch' };
  }

  const structuredChecks = ['State','County','City','Price Range','Unit Count','Min Cap Rate']
    .filter(l => {
      const c = checks.find(x => x.label === l);
      return c && c.status !== 'skip';
    }).length;

  let tier, tierLabel;
  if(isVip && structuredChecks >= 3){ tier = 1; tierLabel = '🏆 Perfect (VIP)'; }
  else if(structuredChecks >= 4){ tier = 1; tierLabel = '🏆 Perfect'; }
  else if(structuredChecks >= 3){ tier = 2; tierLabel = '🎯 Strong'; }
  else if(structuredChecks >= 2){ tier = 3; tierLabel = '⭐ Good'; }
  else if(structuredChecks >= 1){ tier = 5; tierLabel = '➡ Asset + County'; }
  else { tier = 6; tierLabel = '〰 Asset Only'; }

  return { ...buildResult(), tier, tierLabel, tierReason: null };

  function buildResult(){
    const totalWeight = checks.reduce((s,c) => s + (c.status !== 'skip' ? c.weight : 0), 0);
    const earnedWeight = checks.filter(c => c.status === 'pass').reduce((s,c) => s + c.weight, 0);
    const score = totalWeight > 0 ? Math.round(earnedWeight/totalWeight*100) : 0;
    return {
      id: buyerRecord.id, buyerName, contactId, contact,
      score, checks, isVip, parsedFields,
      notes: buyerNotes,
      assetStr: buyerAssetStr,
      areas: buyerAreaStr || buyerCities.join(', ') || '',
      phone: contact['Phone Number'] || '',
      email: contact.Email || '',
      company: contact.Company || ''
    };
  }
}

export function bmApplyFilter(){
  const active = new Set();
  document.querySelectorAll('.bmTierFilter:checked').forEach(cb => active.add(Number(cb.value)));
  const shown = _bmMatches.filter(m => active.has(m.tier));
  renderBuyerMatchResults(shown);
}

export function renderBuyerMatchResults(matches){
  const results = document.getElementById('bmResults');
  if(!results) return;

  if(!matches.length){
    results.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">No matching buyers in selected tiers. Try enabling broader tiers.</div>';
    return;
  }

  // Group by tier
  const tiers = {};
  for(const m of matches){
    if(!tiers[m.tier]) tiers[m.tier] = [];
    tiers[m.tier].push(m);
  }

  const TIER_META = {
    1: { label: '🏆 Perfect Matches',   color: '#1a6a1a', bg: '#e8f5e9',
         desc: 'Asset + county + 4+ structured criteria match. VIPs prioritized.' },
    2: { label: '🎯 Strong Matches',    color: '#2060b0', bg: '#e3f2fd',
         desc: 'Asset + county + 3 structured criteria match.' },
    3: { label: '⭐ Good Matches',       color: '#1565c0', bg: '#e8f0fe',
         desc: 'Asset + county + 2 structured criteria match.' },
    4: { label: '✓ Decent Matches',     color: '#f57c00', bg: '#fff3e0',
         desc: 'Asset matches, minor mismatches on city/cap/SF.' },
    5: { label: '➡ Asset + County',     color: '#6a1b9a', bg: '#f3e5f5',
         desc: 'Asset and county match — no additional criteria specified or checked.' },
    6: { label: '〰 Asset Type Only',    color: '#616161', bg: '#f5f5f5',
         desc: 'Asset matches but county does not, or no county specified.' }
  };

  // Render a single criteria badge. Failing badges also show a compact "wants: ..." line underneath.
  const CHECK_BADGE = (c) => {
    const color = c.status==='pass' ? {bg:'#e6f4ea',fg:'#1b5e20',br:'#a5d6a7',i:'✓'}
                : c.status==='fail' ? {bg:'#fce4ec',fg:'#b71c1c',br:'#ef9a9a',i:'✗'}
                : {bg:'#f5f5f5',fg:'#888',br:'#ddd',i:'–'};
    return `<span style="font-size:10px;padding:1px 7px;border-radius:3px;margin:1px 2px;display:inline-block;
      background:${color.bg};color:${color.fg};border:1px solid ${color.br};">
      ${color.i} ${c.label}
    </span>`;
  };

  // Render compact "wants" lines for FAILING checks only. Keeps the row from exploding.
  const FAIL_HINTS = (checks) => {
    const fails = checks.filter(c => c.status === 'fail' && c.wants && c.wants !== '—');
    if(!fails.length) return '';
    return `<div style="margin-top:3px;font-size:10px;color:#666;line-height:1.4;">
      ${fails.map(c => `<span style="color:#b71c1c;">✗</span> <strong>${c.label}:</strong> wants ${c.wants}`).join(' · ')}
    </div>`;
  };

  // Render outreach badges showing past email/call/text for THIS deal to this buyer
  const OUTREACH_BADGES = (contactId) => {
    const events = _bmOutreach[contactId] || [];
    if(!events.length) return '';
    const ICONS = { email:'✉', call:'📞', text:'💬', voicemail:'🎙', meeting:'🤝', other:'•' };
    const STATUS_COLORS = {
      no_response:'#888', interested:'#2e7d32', passed:'#b71c1c',
      needs_info:'#f57c00', follow_up:'#1565c0', meeting_set:'#6a1b9a'
    };
    return events.slice(0,3).map(ev => {
      const dt = ev.date_sent ? new Date(ev.date_sent).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
      const col = STATUS_COLORS[ev.response_status] || '#888';
      const icon = ICONS[ev.activity_type] || '•';
      const statusLabel = (ev.response_status||'no_response').replace(/_/g,' ');
      return `<span title="${ev.activity_type} on ${dt} — ${statusLabel}${ev.response_notes?': '+ev.response_notes.replace(/"/g,'&quot;'):''}"
        style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:3px;background:#fff;border:1px solid ${col};color:${col};margin-right:3px;">
        ${icon} ${dt} · ${statusLabel}
      </span>`;
    }).join('');
  };

  let html = '';
  for(const tierNum of Object.keys(tiers).map(Number).sort((a,b)=>a-b)){
    const meta = TIER_META[tierNum];
    const rows = tiers[tierNum];
    const collapsed = _bmCollapsedTiers.has(tierNum);

    html += `
      <div style="margin-bottom:18px;">
        <div onclick="bmToggleTier(${tierNum})" style="display:flex;align-items:center;gap:10px;background:${meta.bg};border-left:4px solid ${meta.color};padding:8px 12px;border-radius:4px;margin-bottom:6px;cursor:pointer;user-select:none;">
          <div style="font-size:14px;color:${meta.color};font-weight:bold;width:18px;">${collapsed?'▶':'▼'}</div>
          <div style="font-size:13px;font-weight:bold;color:${meta.color};">${meta.label}</div>
          <div style="font-size:11px;color:#555;">${rows.length} buyer${rows.length!==1?'s':''}</div>
          <div style="font-size:10px;color:#777;font-style:italic;margin-left:auto;">${meta.desc}</div>
          <button onclick="event.stopPropagation();bmSelectAllInTier(${tierNum})" style="font-size:10px;padding:3px 8px;background:#fff;border:1px solid #ccc;border-radius:3px;cursor:pointer;">Select all in tier</button>
        </div>
        <div id="bmTier_${tierNum}" style="${collapsed?'display:none;':''}">
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:#f1f5f9;color:#475569;">
              <th style="padding:6px 4px;text-align:center;border:1px solid #e2e8f0;width:32px;"><input type="checkbox" onclick="bmSelectAllInTier(${tierNum})" title="Select all in this tier"/></th>
              <th style="padding:6px 10px;text-align:center;border:1px solid #e2e8f0;width:50px;">Score</th>
              <th style="padding:6px 10px;text-align:left;border:1px solid #e2e8f0;width:180px;">Buyer</th>
              <th style="padding:6px 10px;text-align:left;border:1px solid #e2e8f0;">Criteria &amp; Outreach</th>
              <th style="padding:6px 10px;text-align:left;border:1px solid #e2e8f0;width:140px;">Area</th>
              <th style="padding:6px 10px;text-align:center;border:1px solid #e2e8f0;width:100px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((m,i) => {
              const bg = i%2===0?'#fff':'#fafbfc';
              const areaShort = (m.areas||'').length>30 ? (m.areas||'').substring(0,30)+'…' : (m.areas||'—');
              const hasParsed = m.parsedFields && m.parsedFields.length > 0;
              const outreachBadges = OUTREACH_BADGES(m.contactId);
              const isChecked = _bmSelected.has(m.id);
              const hasEmail = !!m.email;
              return `
                <tr style="background:${bg};" id="bmRow_${m.id}">
                  <td style="padding:6px 4px;border:1px solid #e2e8f0;text-align:center;vertical-align:top;">
                    <input type="checkbox" class="bmRowChk" data-match-id="${m.id}" ${isChecked?'checked':''} ${hasEmail?'':'disabled title="No email on file"'} onchange="bmToggleSelect('${m.id}')"/>
                  </td>
                  <td style="padding:8px 6px;border:1px solid #e2e8f0;text-align:center;vertical-align:top;">
                    <div style="font-size:14px;font-weight:bold;color:${meta.color};">${m.score}%</div>
                    ${m.isVip?'<div style="font-size:9px;color:#c09000;font-weight:600;margin-top:2px;">⭐ VIP</div>':''}
                  </td>
                  <td style="padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top;">
                    <div style="font-weight:bold;color:#1a3a6e;">
                      <a onclick="bcOpenContact('${m.contactId||''}')" style="cursor:pointer;text-decoration:underline;">${m.buyerName}</a>
                    </div>
                    ${m.company?`<div style="font-size:10px;color:#555;">${m.company}</div>`:''}
                    ${m.phone?`<div style="font-size:10px;color:#555;margin-top:2px;">${m.phone}</div>`:''}
                    ${m.email?`<div style="font-size:10px;color:#555;">${m.email}</div>`:'<div style="font-size:10px;color:#c00;font-style:italic;">no email</div>'}
                    <div style="margin-top:4px;font-size:10px;color:#777;">${m.assetStr.replace(/[🔴🟠🟡🟢🔵🟣]/g,'').trim()}</div>
                  </td>
                  <td style="padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top;">
                    <div style="display:flex;flex-wrap:wrap;gap:2px;align-items:flex-start;">
                      ${m.checks.map(CHECK_BADGE).join('')}
                    </div>
                    ${FAIL_HINTS(m.checks)}
                    ${outreachBadges ? `<div style="margin-top:6px;padding-top:4px;border-top:1px dashed #e5e7eb;">
                      <div style="font-size:9px;color:#475569;font-weight:600;margin-bottom:3px;">OUTREACH HISTORY</div>
                      ${outreachBadges}
                    </div>`:''}
                    ${hasParsed ? `<div style="margin-top:6px;padding:4px 8px;background:#fef3c7;border:1px solid #fde68a;border-radius:4px;font-size:9px;color:#78350f;">
                      🤖 <strong>AI-parsed from notes:</strong> ${m.parsedFields.join(', ')} — <em>agent review recommended</em>
                    </div>`:''}
                    <div id="bmDetail_${m.id}" style="display:none;margin-top:8px;border-top:1px solid #e5e7eb;padding-top:6px;">
                      ${m.checks.map(c=>`
                        <div style="margin-bottom:3px;font-size:10px;">
                          <span style="color:${c.status==='pass'?'#1b5e20':c.status==='fail'?'#b71c1c':'#888'};font-weight:bold;">
                            ${c.status==='pass'?'✓':c.status==='fail'?'✗':'–'} ${c.label}:
                          </span>
                          <span style="color:#444;"> ${c.detail}</span>
                          ${c.wants && c.wants !== '—' ? ` <span style="color:#666;font-style:italic;">· wants ${c.wants}</span>` : ''}
                        </div>`).join('')}
                      ${m.notes ? `<div style="margin-top:6px;padding:6px 8px;background:#f8fafc;border-radius:4px;font-size:10px;color:#475569;max-height:100px;overflow-y:auto;white-space:pre-wrap;">
                        <strong style="color:#1e293b;">Buyer Notes:</strong>
                        ${m.notes.length>400 ? m.notes.substring(0,400)+'…' : m.notes}
                      </div>`:''}
                    </div>
                  </td>
                  <td style="padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top;font-size:10px;color:#444;" title="${(m.areas||'').replace(/"/g,'&quot;')}">${areaShort}</td>
                  <td style="padding:6px 4px;border:1px solid #e2e8f0;text-align:center;vertical-align:top;">
                    ${hasEmail ? `<button class="save-btn" style="padding:3px 8px;margin-bottom:3px;display:block;width:100%;font-size:10px;background:#2e7d32;color:#fff;border-color:#1a5c1a;"
                      onclick="bmSendEmail('${m.id}')">✉ Email</button>` : ''}
                    <button class="save-btn" style="padding:3px 8px;margin-bottom:3px;display:block;width:100%;font-size:10px;"
                      onclick="bmLogActivity('${m.id}','call')">📞 Log Call</button>
                    <button class="save-btn" style="padding:3px 8px;margin-bottom:3px;display:block;width:100%;font-size:10px;"
                      onclick="bmLogActivity('${m.id}','text')">💬 Log Text</button>
                    <button class="save-btn" style="padding:3px 8px;margin-bottom:3px;display:block;width:100%;font-size:10px;"
                      onclick="bmToggleDetail('${m.id}')">▶ Details</button>
                    <button class="save-btn" style="padding:3px 8px;display:block;width:100%;font-size:10px;background:#1a3a6e;color:#fff;border-color:#0a2a5e;"
                      onclick="bcOpenExpanded('${m.id}')">View Criteria ↗</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
      </div>`;
  }

  results.innerHTML = html;
  _bmUpdateBulkBar();
}

export function bmToggleDetail(matchId){
  const detailEl = document.getElementById('bmDetail_'+matchId);
  if(!detailEl) return;
  detailEl.style.display = detailEl.style.display === 'none' ? 'block' : 'none';
}

export function bmToggleTier(tierNum){
  if(_bmCollapsedTiers.has(tierNum)) _bmCollapsedTiers.delete(tierNum);
  else _bmCollapsedTiers.add(tierNum);
  bmApplyFilter();
}

export function bmToggleSelect(matchId){
  if(_bmSelected.has(matchId)) _bmSelected.delete(matchId);
  else _bmSelected.add(matchId);
  _bmUpdateBulkBar();
}

export function bmSelectAllInTier(tierNum){
  const inTier = _bmMatches.filter(m => m.tier === tierNum && m.email);
  const allSelected = inTier.every(m => _bmSelected.has(m.id));
  if(allSelected){
    inTier.forEach(m => _bmSelected.delete(m.id));
  } else {
    inTier.forEach(m => _bmSelected.add(m.id));
  }
  // Refresh checkboxes in DOM without full re-render
  document.querySelectorAll('.bmRowChk').forEach(cb => {
    cb.checked = _bmSelected.has(cb.dataset.matchId);
  });
  _bmUpdateBulkBar();
}

export function bmClearSelection(){
  _bmSelected.clear();
  document.querySelectorAll('.bmRowChk').forEach(cb => { cb.checked = false; });
  _bmUpdateBulkBar();
}

export function _bmUpdateBulkBar(){
  const bar = document.getElementById('bmBulkBar');
  const count = document.getElementById('bmSelCount');
  if(!bar || !count) return;
  if(_bmSelected.size === 0){
    bar.style.display = 'none';
  } else {
    bar.style.display = 'block';
    count.textContent = `${_bmSelected.size} buyer${_bmSelected.size!==1?'s':''} selected`;
  }
}

// Build a Gmail compose URL with subject + body pre-filled.
// If `bccList` is an array of emails, they all go in BCC (one tab, one send).
export function _bmGmailComposeUrl(subject, body, toEmail, bccList){
  const params = new URLSearchParams();
  params.set('view','cm');
  params.set('fs','1');
  if(toEmail) params.set('to', toEmail);
  if(bccList && bccList.length) params.set('bcc', bccList.join(','));
  params.set('su', subject);
  params.set('body', body);
  return 'https://mail.google.com/mail/?'+params.toString();
}

// Send the current deal's Email Template to ONE buyer via Gmail compose.
export async function bmSendEmail(matchId){
  const m = _bmMatches.find(x => x.id === matchId);
  if(!m){ alert('Match not found'); return; }
  if(!m.email){ alert('No email on file for this buyer.'); return; }
  if(!window.currentDeal){ alert('No deal open'); return; }

  const template = window.currentDeal['Email Template'] || '';
  const templateText = (typeof template === 'object' && template.value) ? template.value : template;
  if(!templateText || !String(templateText).trim()){
    alert('No email template saved for this deal yet. Generate one on the AI Communication tab first.');
    return;
  }

  const addr = window.currentDeal['Address'] || 'this property';
  const subject = `New Deal: ${addr}`;
  const url = _bmGmailComposeUrl(subject, String(templateText), m.email, null);
  window.open(url, '_blank');

  // Log the outreach event
  await _bmLogOutreach(m, 'email', 'Sent Email Template via Gmail compose');
}

// Send to ALL currently selected buyers as a single BCC email.
export async function bmSendEmailToSelected(){
  if(_bmSelected.size === 0){ alert('No buyers selected.'); return; }
  if(!window.currentDeal){ alert('No deal open'); return; }

  const template = window.currentDeal['Email Template'] || '';
  const templateText = (typeof template === 'object' && template.value) ? template.value : template;
  if(!templateText || !String(templateText).trim()){
    alert('No email template saved for this deal yet. Generate one on the AI Communication tab first.');
    return;
  }

  const selectedMatches = _bmMatches.filter(m => _bmSelected.has(m.id) && m.email);
  if(selectedMatches.length === 0){
    alert('None of the selected buyers have an email on file.');
    return;
  }

  const addr = window.currentDeal['Address'] || 'this property';
  const subject = `New Deal: ${addr}`;
  const bccList = selectedMatches.map(m => m.email);

  if(!confirm(`Open Gmail compose with ${bccList.length} buyer${bccList.length!==1?'s':''} BCC'd?\n\nYou'll be able to edit the draft before sending.`)) return;

  const url = _bmGmailComposeUrl(subject, String(templateText), '', bccList);
  window.open(url, '_blank');

  // Log each outreach event in parallel
  await Promise.all(selectedMatches.map(m =>
    _bmLogOutreach(m, 'email', `Sent Email Template via Gmail BCC (batch of ${bccList.length})`)
  ));

  alert(`✓ Logged ${bccList.length} outreach event${bccList.length!==1?'s':''}.\n\nRemember to click Send in the Gmail tab.`);
  _bmSelected.clear();
  _bmUpdateBulkBar();
}

// Log a phone call or text message about this deal to this buyer.
export async function bmLogActivity(matchId, activityType){
  const m = _bmMatches.find(x => x.id === matchId);
  if(!m){ alert('Match not found'); return; }
  if(!window.currentDeal){ alert('No deal open'); return; }

  const label = activityType === 'call' ? 'call' : activityType === 'text' ? 'text message' : activityType;
  const notes = prompt(`Log a ${label} to ${m.buyerName} about ${window.currentDeal['Address']||'this deal'}?\n\nOptional notes (response, next steps):`);
  if(notes === null) return; // user cancelled

  await _bmLogOutreach(m, activityType, notes || '');
}

// Internal helper: insert outreach event into ace_buyer_interests
export async function _bmLogOutreach(match, activityType, notes){
  if(!isSupabase()){
    alert('Outreach logging is only available in Supabase mode.');
    return;
  }
  try {
    const row = {
      property_id: window.currentDeal.id,
      contact_id:  match.contactId,
      buyer_criteria_id: match.id,
      activity_type: activityType,
      date_sent: new Date().toISOString().slice(0,10),
      response_status: 'no_response',
      interest_notes: notes || null,
      agent_name: (typeof window._currentUser !== 'undefined' && window._currentUser?.fub_name) || null
    };
    await _sbPost(SB_TABLES.buyerInterests, row);
    // Update local cache so badge appears immediately without full reload
    if(!_bmOutreach[match.contactId]) _bmOutreach[match.contactId] = [];
    _bmOutreach[match.contactId].unshift(row);
    bmApplyFilter(); // re-render
    if(typeof showSaveConfirm === 'function') showSaveConfirm(`✓ Logged ${activityType} to ${match.buyerName}`);
  } catch(e){
    alert('Failed to log outreach: '+(e.message||e));
  }
}
