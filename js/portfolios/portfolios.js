// portfolios/portfolios.js — portfolio CRUD, list, detail, financial aggregates,
// tenant/unit-mix aggregation, and offers feature.
//
// Phase 4a (parallel module): the legacy block in index.html (~17947–19974)
// still owns runtime; this module is dead code. Phase 4b deletes the legacy
// block and attaches these exports as window.* aliases.
//
// External dependencies on window.* (legacy script owns these):
//   state:    window._currentUser, window.allDeals, window.allPortfolios,
//             window.allBuyerCriteria, window.allBuyerContacts
//   functions: window.isSupabase, window.openDeal, window.setNav,
//              window.openContactModal, window.bcOpenExpanded,
//              window._aceSyncPost, window.getStage, window.fmtMoney,
//              window.fmtPct, window._loadPropertyTemplateMap, ...
//   (function declarations in classic <script> auto-attach to window —
//    bare-name lookups from this module resolve through the global env.)

import { _sbGet, _sbPost, _sbPatch, _sbDelete, _sbRpc } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';
import { SB_PORTFOLIO_MAP } from '../schemas/portfolios.js';
import { SB_PROP_MAP } from '../schemas/deals.js';
import { _OFFER_TYPE_META } from '../schemas/offers.js';

// Inline copies of field-map helpers (originally in legacy ~line 1363).
// Kept private here until js/schemas/field-map.js is created in a later phase.
function _atToSb(fields, map) {
  const rev = Object.fromEntries(Object.entries(map).map(([k,v])=>[v,k]));
  const out = {};
  for (const [atField, val] of Object.entries(fields)) {
    const sbCol = rev[atField];
    if (!sbCol || sbCol === 'id') continue;
    if (val === undefined) continue;
    if (val === '') out[sbCol] = null;
    else out[sbCol] = val;
  }
  return out;
}
function _sbToAt(row, map) {
  const out = {};
  for (const [sbCol, atField] of Object.entries(map)) {
    if (row[sbCol] !== undefined && row[sbCol] !== null) out[atField] = row[sbCol];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// LEGACY BLOCK BELOW — copied from index.html with `export` added to every
// top-level function and external `let`/`const` script-scope refs prefixed
// with `window.` for clarity. Internal logic is byte-identical.
// ═══════════════════════════════════════════════════════════════════════

// v102.28 — PORTFOLIOS MODULE (Turn B: create + list + detail view)
// ═══════════════════════════════════════════════════════════════════════
// Turn B adds: create modal, portfolio list page with search, portfolio
// detail page with Level 1/2 aggregates, history-router integration.
// Turn B-second-half will add: Group Existing Deals modal, edit/delete
// actions. Turn C adds the 📁 icon tag on Deal Board rows.

// ── CACHE OF WHICH PORTFOLIO WE'RE VIEWING ─────────────────────────────
let _currentPortfolioId = null;

// ── CRUD HELPERS ───────────────────────────────────────────────────────
// Creates a new portfolio row. fields uses Airtable-style display keys
// (matches SB_PORTFOLIO_MAP). Returns the created row with its new id.
export async function _portfolioCreate(fields){
  if(!isSupabase()) throw new Error('Supabase required');
  const sbData = _atToSb(fields, SB_PORTFOLIO_MAP);
  // Always set created_by_user_id if we have a current user
  if(typeof _currentUser !== 'undefined' && _currentUser && _currentUser.id){
    sbData.created_by_user_id = _currentUser.id;
  }
  const row = await _sbPost(SB_TABLES.portfolios, sbData);
  // _sbPost returns either {} or an array depending on Prefer header.
  // Refresh the cache so the new portfolio shows up in the list.
  await _loadAllPortfolios();
  return row;
}

// ── LEVEL 1/2 AGGREGATION ──────────────────────────────────────────────
// Returns all deals that belong to a given portfolio, ordered by
// portfolio_sort_order then created_at.
export function _portfolioChildren(portfolioId){
  if(!portfolioId || !window.allDeals) return [];
  return window.allDeals
    .filter(d => d['Portfolio ID'] === portfolioId)
    .sort((a,b) => {
      const sa = Number(a['Portfolio Sort Order']||0);
      const sb = Number(b['Portfolio Sort Order']||0);
      if(sa !== sb) return sa - sb;
      return (a['Date Added']||'').localeCompare(b['Date Added']||'');
    });
}

// Computes Level 1 + Level 2 aggregates for a set of child deals.
// Returns: {totalAsking, totalNOI, totalSF, totalUnits, blendedCap,
//           pricePerSF, pricePerUnit, avgCap}
export function _portfolioAggregates(children){
  const agg = {
    totalAsking: 0, totalNOI: 0, totalSF: 0, totalUnits: 0,
    blendedCap: null, pricePerSF: null, pricePerUnit: null, avgCap: null,
    count: children.length
  };
  let capSum = 0, capCount = 0;
  children.forEach(d => {
    const ask = Number(d['Asking Price']||0);
    const noi = Number(d['NOI']||0);
    const sf  = Number(d['Total Building SF']||d['Square Footage']||d['Net Rentable SF']||0);
    const u   = Number(d['No. of Units']||d['Number of Units']||0);
    if(ask) agg.totalAsking += ask;
    if(noi) agg.totalNOI    += noi;
    if(sf)  agg.totalSF     += sf;
    if(u)   agg.totalUnits  += u;
    // Individual cap rate for avgCap — uses Cap Rate (CRM) with the
    // <1-means-decimal convention, same as _bmCapRate in the buyer-match
    // module. Only averages non-null rates.
    const rate = d['Cap Rate (CRM)'];
    if(rate != null && rate !== ''){
      const v = Number(rate);
      if(!isNaN(v) && v > 0){ capSum += (v < 1 ? v*100 : v); capCount++; }
    }
  });
  if(agg.totalNOI > 0 && agg.totalAsking > 0){
    agg.blendedCap = (agg.totalNOI / agg.totalAsking) * 100;
  }
  if(agg.totalSF > 0 && agg.totalAsking > 0){
    agg.pricePerSF = agg.totalAsking / agg.totalSF;
  }
  if(agg.totalUnits > 0 && agg.totalAsking > 0){
    agg.pricePerUnit = agg.totalAsking / agg.totalUnits;
  }
  if(capCount > 0) agg.avgCap = capSum / capCount;
  return agg;
}

// ═══════════════════════════════════════════════════════════════════════
// v102.28 Turn D: COMBINED FINANCIAL ANALYSIS
// ═══════════════════════════════════════════════════════════════════════
// Computes aggregated financials across all children in a portfolio.
// Returns a structured object the renderer can read without any math.
// Handles partial data gracefully — tracks how many children contributed
// to each aggregate so the UI can surface data-quality warnings.
//
// Convention: all monthly values are normalized to monthly, all yearly
// to yearly. When a child has only one side filled in, we derive the
// other from a 12x multiplier. This matches how the deal-level tab
// behaves (see syncData → _sbToAt → SB_PROP_MAP).

export function _portfolioFinancials(children, portfolio){
  const count = children.length;
  const agg = {
    count, portfolio: portfolio || null,
    totalAsking: 0, totalSF: 0, totalUnits: 0, totalNOI: 0,
    packagePrice: portfolio && portfolio['Package Price'] != null ? Number(portfolio['Package Price']) : null,
    actual: _emptyFinSide(),
    proforma: _emptyFinSide(),
    unitMix: { eff:0, br1:0, br2:0, br3:0, br4:0, other:0,
               effVac:0, br1Vac:0, br2Vac:0, br3Vac:0, br4Vac:0, otherVac:0 },
    childrenWithAsking: 0,
    childrenWithGRI: 0,
    childrenWithExpenses: 0,
    childrenWithNOI: 0
  };
  const getMo = (d, monthlyKey, yearlyKey) => {
    const m = Number(d[monthlyKey] || 0);
    if(m) return m;
    const y = Number(d[yearlyKey] || 0);
    return y ? y / 12 : 0;
  };
  const getYr = (d, monthlyKey, yearlyKey) => {
    const y = Number(d[yearlyKey] || 0);
    if(y) return y;
    const m = Number(d[monthlyKey] || 0);
    return m ? m * 12 : 0;
  };
  children.forEach(d => {
    const ask = Number(d['Asking Price']||0);
    if(ask){ agg.totalAsking += ask; agg.childrenWithAsking++; }
    const sf  = Number(d['Total Building SF']||d['Square Footage']||d['Net Rentable SF']||0);
    if(sf)  agg.totalSF += sf;
    const u   = Number(d['No. of Units']||d['Number of Units']||0);
    if(u)   agg.totalUnits += u;

    // Actual side
    const griMo = getMo(d, 'Gross Revenue Monthly', 'Gross Revenue Yearly');
    if(griMo){ agg.actual.griMonthly += griMo; agg.childrenWithGRI++; }
    const expMo = getMo(d, 'Expenses Monthly', 'Expenses Yearly');
    if(expMo){ agg.actual.expensesMonthly += expMo; agg.childrenWithExpenses++; }
    // Individual expense categories — sum monthly, best-effort
    agg.actual.exp_electric      += Number(d['Electric (Monthly)']||0);
    agg.actual.exp_gas           += Number(d['Gas (Monthly)']||0);
    agg.actual.exp_water         += Number(d['Water & Sewer (Monthly)']||0);
    agg.actual.exp_trash         += Number(d['Trash (Monthly)']||0);
    agg.actual.exp_propertyTax   += Number(d['Property Tax (Monthly)']||0);
    agg.actual.exp_insurance     += Number(d['Insurance (Monthly)']||0);
    agg.actual.exp_mgmtFee       += Number(d['Property Management Fee (Monthly)']||0);
    agg.actual.exp_maintenance   += Number(d['Maintenance & Repair Costs (Monthly)']||0);
    agg.actual.exp_landscaping   += Number(d['Landscaping (Monthly)']||0);
    agg.actual.exp_janitorial    += Number(d['Janitorial (Monthly)']||0);
    agg.actual.exp_supplies      += Number(d['Supplies (Monthly)']||0);
    agg.actual.exp_capitalReserve+= Number(d['Capital Reserve (Monthly)']||0);
    agg.actual.exp_admin         += Number(d['Admin Expenses (Monthly)']||0);
    agg.actual.exp_misc          += Number(d['Miscellaneous Expenses (Monthly)']||0);

    // NOI — prefer stored, fallback to derived
    let noi = Number(d['NOI']||0);
    if(!noi && griMo && expMo){ noi = (griMo - expMo) * 12; }
    if(noi){ agg.totalNOI += noi; agg.childrenWithNOI++; }

    // Debt service
    agg.actual.annualDebtService += Number(d['Annual Debt Service']||0);

    // Proforma side
    const pfGriMo = getMo(d, 'Pro Forma Gross Revenue Monthly', 'Pro Forma Gross Revenue Yearly')
                 || Number(d['Proforma Gross Rent (Monthly)']||0);
    if(pfGriMo) agg.proforma.griMonthly += pfGriMo;
    const pfExpMo = getMo(d, 'Pro Forma Expenses Monthly', 'Pro Forma Expenses Yearly');
    if(pfExpMo) agg.proforma.expensesMonthly += pfExpMo;

    // Unit mix
    agg.unitMix.eff      += Number(d['Units Efficiency']||0);
    agg.unitMix.br1      += Number(d['Units 1 Bedroom']||0);
    agg.unitMix.br2      += Number(d['Units 2 Bedroom']||0);
    agg.unitMix.br3      += Number(d['Units 3 Bedroom']||0);
    agg.unitMix.br4      += Number(d['Units 4 Bedroom']||0);
    agg.unitMix.other    += Number(d['Units Other']||0);
    agg.unitMix.effVac   += Number(d['Units Efficiency Vacant']||0);
    agg.unitMix.br1Vac   += Number(d['Units 1 Bedroom Vacant']||0);
    agg.unitMix.br2Vac   += Number(d['Units 2 Bedroom Vacant']||0);
    agg.unitMix.br3Vac   += Number(d['Units 3 Bedroom Vacant']||0);
    agg.unitMix.br4Vac   += Number(d['Units 4 Bedroom Vacant']||0);
    agg.unitMix.otherVac += Number(d['Units Other Vacant']||0);
  });

  // Derive yearly from monthly (actual)
  agg.actual.griYearly        = agg.actual.griMonthly * 12;
  agg.actual.expensesYearly   = agg.actual.expensesMonthly * 12;
  agg.actual.noiYearly        = agg.totalNOI;
  agg.actual.cashFlowYearly   = agg.totalNOI - agg.actual.annualDebtService;
  agg.proforma.griYearly      = agg.proforma.griMonthly * 12;
  agg.proforma.expensesYearly = agg.proforma.expensesMonthly * 12;
  agg.proforma.noiYearly      = (agg.proforma.griMonthly - agg.proforma.expensesMonthly) * 12;

  // Cap rates — sum-based and package-based (if package set)
  if(agg.totalAsking > 0 && agg.totalNOI > 0){
    agg.actual.capRateSum = (agg.totalNOI / agg.totalAsking) * 100;
  }
  if(agg.packagePrice && agg.packagePrice > 0 && agg.totalNOI > 0){
    agg.actual.capRatePackage = (agg.totalNOI / agg.packagePrice) * 100;
  }
  if(agg.totalAsking > 0 && agg.proforma.noiYearly > 0){
    agg.proforma.capRateSum = (agg.proforma.noiYearly / agg.totalAsking) * 100;
  }
  if(agg.packagePrice && agg.packagePrice > 0 && agg.proforma.noiYearly > 0){
    agg.proforma.capRatePackage = (agg.proforma.noiYearly / agg.packagePrice) * 100;
  }

  // DSCR = NOI / Debt Service
  if(agg.actual.annualDebtService > 0 && agg.totalNOI > 0){
    agg.actual.dscr = agg.totalNOI / agg.actual.annualDebtService;
  }

  // GRM — total asking / effective gross revenue (annual)
  if(agg.actual.griYearly > 0 && agg.totalAsking > 0){
    agg.actual.grm = agg.totalAsking / agg.actual.griYearly;
  }

  // Break-even occupancy — (OpEx + Debt) / GRI
  if(agg.actual.griYearly > 0){
    agg.actual.breakEvenPct = ((agg.actual.expensesYearly + agg.actual.annualDebtService) / agg.actual.griYearly) * 100;
  }

  // Price per SF / per unit — use package price if set, else total asking
  const priceBase = agg.packagePrice || agg.totalAsking;
  if(priceBase > 0 && agg.totalSF > 0)    agg.pricePerSF   = priceBase / agg.totalSF;
  if(priceBase > 0 && agg.totalUnits > 0) agg.pricePerUnit = priceBase / agg.totalUnits;

  return agg;
}

export function _emptyFinSide(){
  return {
    griMonthly:0, griYearly:0,
    expensesMonthly:0, expensesYearly:0,
    noiYearly:0, annualDebtService:0, cashFlowYearly:0,
    capRateSum:null, capRatePackage:null, dscr:null, grm:null, breakEvenPct:null,
    exp_electric:0, exp_gas:0, exp_water:0, exp_trash:0,
    exp_propertyTax:0, exp_insurance:0, exp_mgmtFee:0,
    exp_maintenance:0, exp_landscaping:0, exp_janitorial:0,
    exp_supplies:0, exp_capitalReserve:0, exp_admin:0, exp_misc:0
  };
}

// ═══════════════════════════════════════════════════════════════════════
// v102.28 Turn E: TENANT MIX + UNIT MIX AGGREGATION
// ═══════════════════════════════════════════════════════════════════════
// mf_unit_rent_data is a dual-purpose column:
//   - Array shape:  [{Tenant Name, ...}, ...] — commercial tenant records
//   - Object shape: {mode:'byType', byType:{eff, 1br, ...}, units:[]} — MF unit mix
// Deals use whichever shape their asset type requires. Parser sniffs the
// shape and routes to the right structure. See v102.26 commentary for the
// full collision context.

export function _pfParseUnitRentData(raw){
  if(!raw) return { tenants: [], unitMix: null };
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch(e) {
    return { tenants: [], unitMix: null };
  }
  if(Array.isArray(parsed)){
    return { tenants: parsed, unitMix: null };
  }
  if(parsed && typeof parsed === 'object' && parsed.mode === 'byType'){
    return { tenants: [], unitMix: parsed };
  }
  return { tenants: [], unitMix: null };
}

// Walks all children, collects commercial tenants. Each tenant is tagged
// with _sourceDealId + _sourceAddress so the renderer can show the source
// column and link back to the child deal's Tenant Mix tab.
export function _portfolioTenants(children){
  const out = [];
  children.forEach(d => {
    const raw = d['MF Unit Rent Data'] || d.mf_unit_rent_data;
    const { tenants } = _pfParseUnitRentData(raw);
    tenants.forEach(t => {
      // Shallow-copy so we don't mutate the cached deal object
      out.push({
        ...t,
        _sourceDealId: d.id,
        _sourceAddress: d['Address'] || 'Unnamed',
        _sourceType: d['CRM Asset Classification'] || d['Simple Text Property Type'] || ''
      });
    });
  });
  return out;
}

// Walks MF children, collects aggregate unit counts and blended rents per
// bedroom type. Counts come from ace_properties columns (which are the
// source of truth for unit counts on the deal card). Rents come from the
// `byType` object in mf_unit_rent_data, weighted by unit count for blend.
// Also walks commercial children (no byType) and just sums their total SF.
//
// Returns:
//   {
//     hasUnitData: bool,
//     byType: {
//       eff:    {label, count, vacant, totalRent, avgRent, sources:[{deal, count, avgRent, totalRent}]},
//       '1br':  {...}, '2br':{...}, '3br':{...}, '4br':{...}, oth:{...}
//     },
//     totalUnits, totalVacant, totalMonthlyRent, totalAnnualRent
//   }
export function _portfolioUnitMix(children){
  const bedroomTypes = [
    { key:'eff',  label:'Efficiency',  countField:'Units Efficiency',  vacField:'Units Efficiency Vacant' },
    { key:'1br',  label:'1 Bedroom',   countField:'Units 1 Bedroom',   vacField:'Units 1 Bedroom Vacant' },
    { key:'2br',  label:'2 Bedroom',   countField:'Units 2 Bedroom',   vacField:'Units 2 Bedroom Vacant' },
    { key:'3br',  label:'3 Bedroom',   countField:'Units 3 Bedroom',   vacField:'Units 3 Bedroom Vacant' },
    { key:'4br',  label:'4 Bedroom',   countField:'Units 4 Bedroom',   vacField:'Units 4 Bedroom Vacant' },
    { key:'oth',  label:'Other',       countField:'Units Other',       vacField:'Units Other Vacant'     }
  ];
  const byType = {};
  bedroomTypes.forEach(t => {
    byType[t.key] = { label:t.label, count:0, countWithRent:0, vacant:0, totalRent:0, avgRent:null, sources:[] };
  });
  let hasUnitData = false;

  children.forEach(d => {
    const raw = d['MF Unit Rent Data'] || d.mf_unit_rent_data;
    const { unitMix } = _pfParseUnitRentData(raw);
    const addr = d['Address'] || 'Unnamed';

    bedroomTypes.forEach(t => {
      const cnt = Number(d[t.countField] || 0);
      const vac = Number(d[t.vacField]   || 0);
      const avgRent = unitMix && unitMix.byType ? Number(unitMix.byType[t.key] || 0) : 0;
      if(cnt > 0){
        hasUnitData = true;
        byType[t.key].count  += cnt;
        byType[t.key].vacant += vac;
        if(avgRent > 0){
          byType[t.key].countWithRent += cnt;
          byType[t.key].totalRent += cnt * avgRent;
          byType[t.key].sources.push({
            deal: addr, dealId: d.id, count: cnt, avgRent, totalRent: cnt * avgRent
          });
        } else {
          byType[t.key].sources.push({
            deal: addr, dealId: d.id, count: cnt, avgRent: null, totalRent: 0
          });
        }
      }
    });
  });

  // Compute weighted avg rent per bedroom type — divide by units that
  // HAVE rent data, not all units. Prevents under-reporting when some
  // children have unit counts but no rents.
  bedroomTypes.forEach(t => {
    const b = byType[t.key];
    if(b.countWithRent > 0 && b.totalRent > 0){
      b.avgRent = b.totalRent / b.countWithRent;
    }
  });

  const totalUnits        = bedroomTypes.reduce((s, t) => s + byType[t.key].count,     0);
  const totalVacant       = bedroomTypes.reduce((s, t) => s + byType[t.key].vacant,    0);
  const totalMonthlyRent  = bedroomTypes.reduce((s, t) => s + byType[t.key].totalRent, 0);
  const totalAnnualRent   = totalMonthlyRent * 12;

  return { hasUnitData, byType, totalUnits, totalVacant, totalMonthlyRent, totalAnnualRent };
}

// Renders the "Tenant & Unit Mix" tab content. Auto-detects whether to
// show the Tenant section, the Unit Mix section, both, or an empty state.
export function _renderPortfolioTenantUnitMixTab(p, children, fmt$, fmtPct){
  if(children.length === 0){
    return `
      <div style="background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:40px 20px;text-align:center;">
        <div style="font-size:36px;opacity:0.4;margin-bottom:8px;">🏪</div>
        <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:4px;">No tenant or unit data to show</div>
        <div style="font-size:11px;color:#94a3b8;">Add properties to this portfolio first — their tenants and unit mixes will roll up here automatically.</div>
      </div>`;
  }

  const tenants = _portfolioTenants(children);
  const um = _portfolioUnitMix(children);
  const hasTenants = tenants.length > 0;
  const hasUnits   = um.hasUnitData;

  if(!hasTenants && !hasUnits){
    return `
      <div style="background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:40px 20px;text-align:center;">
        <div style="font-size:36px;opacity:0.4;margin-bottom:8px;">🏪</div>
        <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:4px;">No tenant or unit mix data filled in</div>
        <div style="font-size:11px;color:#94a3b8;line-height:1.6;">
          Open individual child deals and fill in their Tenant Mix tab (for commercial) or Property Details → Unit Mix (for multifamily).<br>
          Values will aggregate here automatically once saved.
        </div>
      </div>`;
  }

  // ── TENANT MIX SECTION ─────────────────────────────────────────
  let tenantHtml = '';
  if(hasTenants){
    // Aggregate totals
    const totalSF = tenants.reduce((s,t) => s + (Number(t['Square Footage'])||0), 0);
    const totalMoRent = tenants.reduce((s,t) => s + (Number(t['Monthly Rent'])||0), 0);
    const avgPSF = totalSF > 0 ? (totalMoRent * 12) / totalSF : 0;

    // Lease type breakdown
    const leaseBuckets = {};
    tenants.forEach(t => {
      const lt = t['Lease Type'] || 'Not specified';
      leaseBuckets[lt] = (leaseBuckets[lt] || 0) + 1;
    });
    const leaseBreakdown = Object.entries(leaseBuckets)
      .sort((a,b) => b[1] - a[1])
      .map(([k, v]) => `${v} ${k}`)
      .join(' · ');

    // Color helper for lease type pills
    const ltColor = (lt) => {
      const l = (lt || '').toLowerCase();
      if(l.includes('nnn') || l.includes('triple'))    return '#16a34a';
      if(l.includes('modified') || l.includes('mg'))   return '#d97706';
      if(l.includes('gross'))                          return '#2060b0';
      if(l.includes('month'))                          return '#dc2626';
      return '#64748b';
    };

    // Compute years-left for each tenant from lease end date
    const yrsLeft = (t) => {
      const end = t['Lease End Date'];
      if(!end) return null;
      try {
        const endDt = new Date(end);
        if(isNaN(endDt.getTime())) return null;
        const now = new Date();
        const ms = endDt - now;
        if(ms < 0) return 0;
        return Math.round((ms / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
      } catch(e) { return null; }
    };

    const tenantRows = tenants.map((t, i) => {
      const sf = Number(t['Square Footage']) || 0;
      const rent = Number(t['Monthly Rent']) || 0;
      const psf = sf > 0 && rent > 0 ? ((rent * 12) / sf) : null;
      const lt = t['Lease Type'] || '—';
      const lc = ltColor(lt);
      const yl = yrsLeft(t);
      const ylColor = yl === null ? '#94a3b8' : (yl <= 1 ? '#dc2626' : yl <= 3 ? '#d97706' : '#16a34a');
      const bg = i % 2 === 0 ? '#fff' : '#fafbfd';
      return `
        <tr style="background:${bg};cursor:pointer;" onclick="_pfOpenTenantSource('${t._sourceDealId}')">
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;">
            <div style="font-weight:700;color:#0f172a;">${(t['Tenant Name']||'—').replace(/</g,'&lt;')}</div>
            ${t['Industry'] ? `<div style="font-size:10px;color:#94a3b8;font-weight:400;">${t['Industry'].replace(/</g,'&lt;')}</div>` : ''}
          </td>
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#475569;">
            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;">📁 ${(t._sourceAddress||'—').replace(/</g,'&lt;')}</div>
            ${t['Unit / Suite'] ? `<div style="font-size:10px;color:#94a3b8;">Unit ${t['Unit / Suite'].replace(/</g,'&lt;')}</div>` : ''}
          </td>
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#0f172a;text-align:right;">${sf > 0 ? sf.toLocaleString() + ' SF' : '—'}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#166534;text-align:right;font-weight:700;">${rent > 0 ? fmt$(rent) : '—'}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#1a5a9a;text-align:right;">${psf != null ? '$' + psf.toFixed(2) : '—'}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">
            <span style="background:${lc}22;color:${lc};border:1px solid ${lc}55;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;">${lt}</span>
          </td>
          <td style="padding:7px 12px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:11px;font-weight:700;color:${ylColor};">${yl === null ? '—' : yl + 'yr'}</td>
        </tr>`;
    }).join('');

    tenantHtml = `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px;">
        <div style="background:linear-gradient(180deg,#2a7a2a,#1a5a1a);color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div style="font-weight:700;font-size:13px;">🏪 Tenant Mix — ${tenants.length} Tenant${tenants.length === 1 ? '' : 's'}</div>
          <div style="display:flex;gap:14px;font-size:11px;opacity:0.95;flex-wrap:wrap;">
            ${totalSF > 0 ? `<span><strong>${totalSF.toLocaleString()} SF</strong> occupied</span>` : ''}
            ${totalMoRent > 0 ? `<span><strong>${fmt$(totalMoRent)}/mo</strong> total</span>` : ''}
            ${avgPSF > 0 ? `<span><strong>$${avgPSF.toFixed(2)}/SF/yr</strong> avg</span>` : ''}
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;min-width:760px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Tenant</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Source Property</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">SF</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Monthly Rent</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Rent/SF (yr)</th>
                <th style="padding:8px 12px;text-align:center;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Lease Type</th>
                <th style="padding:8px 12px;text-align:center;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Years Left</th>
              </tr>
            </thead>
            <tbody>${tenantRows}</tbody>
            <tfoot>
              <tr style="background:#e8f4e8;font-weight:700;">
                <td colspan="2" style="padding:8px 12px;font-size:11px;color:#166534;">Totals (${tenants.length} tenants)</td>
                <td style="padding:8px 12px;font-size:11px;color:#166534;text-align:right;">${totalSF.toLocaleString()} SF</td>
                <td style="padding:8px 12px;font-size:11px;color:#166534;text-align:right;">${fmt$(totalMoRent)}/mo</td>
                <td style="padding:8px 12px;font-size:11px;color:#166534;text-align:right;">${avgPSF > 0 ? '$' + avgPSF.toFixed(2) : '—'}</td>
                <td colspan="2" style="padding:8px 12px;font-size:10px;color:#166534;">${fmt$(totalMoRent * 12)}/yr · ${leaseBreakdown}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style="padding:10px 16px;background:#f8fafc;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;">
          Click any row to open the source deal and edit the tenant there.
        </div>
      </div>`;
  }

  // ── UNIT MIX SECTION ───────────────────────────────────────────
  let unitMixHtml = '';
  if(hasUnits){
    // Headline stats
    const occUnits = um.totalUnits - um.totalVacant;
    const occPct   = um.totalUnits > 0 ? (occUnits / um.totalUnits) * 100 : 0;

    // Bedroom rows — only show types that have at least one unit
    const activeTypes = Object.entries(um.byType).filter(([k, b]) => b.count > 0);
    const bedroomRows = activeTypes.map(([key, b]) => {
      const vac = b.vacant;
      const occ = b.count - vac;
      const vacPct = b.count > 0 ? (vac / b.count) * 100 : 0;
      const avgStr = b.avgRent != null ? fmt$(b.avgRent) : '—';
      const totStr = b.totalRent > 0 ? fmt$(b.totalRent) : '—';
      const sourceCount = b.sources.length;
      const sourceLabel = sourceCount === 1 ? b.sources[0].deal : `${sourceCount} properties`;
      return `
        <tr>
          <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:700;color:#0f172a;">${b.label}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b;text-align:right;">${b.count}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:${vac > 0 ? '#dc2626' : '#16a34a'};text-align:right;font-weight:600;">${occ}/${b.count}${vac > 0 ? ` · ${vac} vacant` : ''}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#1a5a9a;text-align:right;font-weight:600;">${avgStr}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#166534;text-align:right;font-weight:700;">${totStr}</td>
          <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:10px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;" title="${sourceLabel.replace(/"/g,'&quot;')}">${sourceLabel}</td>
        </tr>`;
    }).join('');

    unitMixHtml = `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px;">
        <div style="background:linear-gradient(180deg,#1a3a6e,#142b50);color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div style="font-weight:700;font-size:13px;">🏠 Multifamily Unit Mix — ${um.totalUnits} Total Unit${um.totalUnits === 1 ? '' : 's'}</div>
          <div style="display:flex;gap:14px;font-size:11px;opacity:0.95;flex-wrap:wrap;">
            <span><strong>${occUnits}</strong> occupied / <strong>${um.totalVacant}</strong> vacant</span>
            <span><strong>${occPct.toFixed(1)}%</strong> occupancy</span>
            ${um.totalMonthlyRent > 0 ? `<span><strong>${fmt$(um.totalMonthlyRent)}/mo</strong> blended GRI</span>` : ''}
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;min-width:640px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Bedroom Type</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;"># Units</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Occupancy</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Avg Rent (Blend)</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Monthly Total</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;">Source</th>
              </tr>
            </thead>
            <tbody>${bedroomRows}</tbody>
            <tfoot>
              <tr style="background:#eef2fb;font-weight:700;">
                <td style="padding:9px 12px;font-size:11px;color:#1a3a6e;">Portfolio Totals</td>
                <td style="padding:9px 12px;font-size:11px;color:#1a3a6e;text-align:right;">${um.totalUnits}</td>
                <td style="padding:9px 12px;font-size:11px;color:#1a3a6e;text-align:right;">${occPct.toFixed(1)}%</td>
                <td style="padding:9px 12px;font-size:11px;color:#1a3a6e;text-align:right;">—</td>
                <td style="padding:9px 12px;font-size:11px;color:#1a3a6e;text-align:right;">${um.totalMonthlyRent > 0 ? fmt$(um.totalMonthlyRent) : '—'}</td>
                <td style="padding:9px 12px;font-size:10px;color:#1a3a6e;">${um.totalAnnualRent > 0 ? fmt$(um.totalAnnualRent) + '/yr' : ''}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style="padding:10px 16px;background:#f8fafc;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;">
          Blended avg rent = (sum of unit counts × avg rents) ÷ total units for that type.
          Unit counts come from each child's Property Details; rents come from the MF Unit Rent Data.
        </div>
      </div>`;
  }

  return tenantHtml + unitMixHtml;
}

// Open a deal from a tenant row click. Opens the child deal — the user
// can then navigate to its Tenant Mix tab to edit.
export function _pfOpenTenantSource(dealId){
  const d = (window.allDeals || []).find(x => x.id === dealId);
  if(!d){ alert('Source deal not found.'); return; }
  if(typeof openDeal === 'function') openDeal(d);
}

// Tab state — which tab of the portfolio detail view is showing.
let _currentPortfolioTab = 'summary';

// ── MODAL HANDLERS ─────────────────────────────────────────────────────
export function openCreatePortfolioModal(){
  const modal = document.getElementById('createPortfolioModal');
  if(!modal) return;
  // Reset form
  const name = document.getElementById('cpName');
  const price = document.getElementById('cpPackagePrice');
  const stage = document.getElementById('cpStage');
  const desc = document.getElementById('cpDescription');
  const notes = document.getElementById('cpNotes');
  const err = document.getElementById('cpError');
  if(name)  name.value = '';
  if(price) price.value = '';
  if(desc)  desc.value = '';
  if(notes) notes.value = '';
  if(err){ err.style.display = 'none'; err.textContent = ''; }
  // Populate pipeline stage dropdown dynamically so it always matches
  // the authoritative stages list.
  if(stage){
    stage.innerHTML = '<option value="">— Select —</option>' +
      NEW_PIPELINE_STAGES.map(s => `<option value="${s}">${s}</option>`).join('');
  }
  modal.style.display = 'flex';
  setTimeout(() => name?.focus(), 50);
}

export function closeCreatePortfolioModal(){
  const modal = document.getElementById('createPortfolioModal');
  if(modal) modal.style.display = 'none';
}

export async function submitCreatePortfolio(){
  const name = document.getElementById('cpName')?.value?.trim() || '';
  const rawPrice = document.getElementById('cpPackagePrice')?.value?.trim() || '';
  const stage = document.getElementById('cpStage')?.value || '';
  const desc = document.getElementById('cpDescription')?.value?.trim() || '';
  const notes = document.getElementById('cpNotes')?.value?.trim() || '';
  const err = document.getElementById('cpError');
  const btn = document.getElementById('cpSubmitBtn');

  const showErr = (msg) => { if(err){ err.textContent = msg; err.style.display='block'; } };
  const hideErr = () => { if(err){ err.style.display = 'none'; } };

  // Validate
  if(!name){ showErr('Portfolio name is required.'); return; }
  hideErr();

  // Parse package price (allow commas)
  let packagePrice = null;
  if(rawPrice){
    const n = parseFloat(rawPrice.replace(/,/g,''));
    if(isNaN(n) || n < 0){ showErr('Package price must be a valid number.'); return; }
    packagePrice = n;
  }

  const fields = { 'Name': name };
  if(packagePrice != null) fields['Package Price']  = packagePrice;
  if(stage)                fields['Pipeline Stage'] = stage;
  if(desc)                 fields['Description']    = desc;
  if(notes)                fields['Portfolio Notes']= notes;

  if(btn){ btn.disabled = true; btn.textContent = 'Creating...'; }
  try {
    await _portfolioCreate(fields);
    closeCreatePortfolioModal();
    // Refresh the list view and navigate there if we're not already
    showPortfoliosPage();
  } catch(e) {
    showErr('Failed to create: ' + (e.message || 'unknown error'));
    if(btn){ btn.disabled = false; btn.textContent = 'Create Portfolio'; }
    return;
  }
  if(btn){ btn.disabled = false; btn.textContent = 'Create Portfolio'; }
}

// ── PORTFOLIO LIST PAGE ───────────────────────────────────────────────
export function showPortfoliosPage(){
  _currentPortfolioId = null;
  const main = document.getElementById('mainArea');
  if(!main) return;
  const portfolios = window.allPortfolios || [];
  const count = portfolios.length;

  // Helper to format currency concisely
  const fmt$ = n => {
    if(!n || isNaN(n)) return '—';
    const v = Number(n);
    if(v >= 1e6) return '$' + (v/1e6).toFixed(2) + 'M';
    if(v >= 1e3) return '$' + Math.round(v/1e3) + 'K';
    return '$' + v.toLocaleString();
  };

  // Build row HTML for each portfolio with basic Level 1 aggregate preview
  const rowsHtml = portfolios.map(p => {
    const children = _portfolioChildren(p.id);
    const agg = _portfolioAggregates(children);
    const stage = p['Pipeline Stage'] || '';
    const stageColor = NEW_PIPELINE_COLORS[stage] || '#64748b';
    const pkgPrice = p['Package Price'];
    return `
      <div class="pf-row" data-pf-id="${p.id}" onclick="openPortfolioDetail('${p.id}')"
        style="display:grid;grid-template-columns:minmax(0,1fr) 90px 100px 100px 120px;gap:12px;align-items:center;padding:14px 18px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;cursor:pointer;transition:all 0.15s;"
        onmouseover="this.style.borderColor='#f59e0b';this.style.transform='translateX(2px)';"
        onmouseout="this.style.borderColor='#e2e8f0';this.style.transform='translateX(0)';">
        <div style="min-width:0;">
          <div style="font-size:14px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📁 ${(p['Name']||'Untitled').replace(/</g,'&lt;')}</div>
          <div style="font-size:11px;color:#64748b;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(p['Description']||'No description').replace(/</g,'&lt;')}</div>
        </div>
        <div style="font-size:12px;color:#475569;text-align:center;">${agg.count} ${agg.count===1?'deal':'deals'}</div>
        <div style="font-size:12px;font-weight:700;color:#b45309;text-align:right;">${pkgPrice ? fmt$(pkgPrice) : '—'}</div>
        <div style="font-size:11px;color:#64748b;text-align:right;">${agg.totalAsking ? 'sum ' + fmt$(agg.totalAsking) : '—'}</div>
        <div style="text-align:right;">
          ${stage ? `<span style="font-size:10px;font-weight:600;padding:3px 10px;border-radius:99px;background:${stageColor}22;color:${stageColor};border:1px solid ${stageColor}55;">${stage}</span>` : '<span style="font-size:10px;color:#94a3b8;">No stage</span>'}
        </div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div style="padding:24px 28px;max-width:1200px;margin:0 auto;font-family:Tahoma,Arial,sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">📁 Portfolios</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">Group multiple properties under one shared listing or owner.</div>
        </div>
        <button onclick="openCreatePortfolioModal()"
          style="background:#b45309;color:#fff;border:none;padding:9px 18px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer;box-shadow:0 1px 3px rgba(180,83,9,0.3);">
          + New Portfolio
        </button>
      </div>
      <div style="margin-bottom:14px;">
        <input id="pfSearch" type="text" placeholder="Search portfolios by name or description..."
          oninput="_pfFilterList()"
          style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #cbd5e1;font-size:13px;box-sizing:border-box;" />
      </div>
      ${count === 0 ? `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:56px 28px;text-align:center;">
          <div style="font-size:48px;margin-bottom:10px;opacity:0.5;">📁</div>
          <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">No portfolios yet</div>
          <div style="font-size:12px;color:#64748b;line-height:1.6;max-width:440px;margin:0 auto 16px;">
            Portfolios let you group multiple properties that share an owner or are sold as a package. Click <strong>+ New Portfolio</strong> to create your first one.
          </div>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:minmax(0,1fr) 90px 100px 100px 120px;gap:12px;padding:8px 18px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">
          <div>Portfolio</div>
          <div style="text-align:center;"># Deals</div>
          <div style="text-align:right;">Package</div>
          <div style="text-align:right;">Sum Asking</div>
          <div style="text-align:right;">Stage</div>
        </div>
        <div id="pfRowsHost">${rowsHtml}</div>
      `}
    </div>`;
}

// Search filter for the portfolio list — client-side filter on the DOM
// rows we already rendered. No re-fetch needed.
export function _pfFilterList(){
  const q = (document.getElementById('pfSearch')?.value || '').trim().toLowerCase();
  const host = document.getElementById('pfRowsHost');
  if(!host) return;
  const rows = host.querySelectorAll('.pf-row');
  rows.forEach(row => {
    if(!q){ row.style.display = ''; return; }
    const text = row.textContent.toLowerCase();
    row.style.display = text.indexOf(q) !== -1 ? '' : 'none';
  });
}

// ── PORTFOLIO DETAIL PAGE ─────────────────────────────────────────────
export function openPortfolioDetail(portfolioId){
  const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
  if(!p){
    alert('Portfolio not found. It may have been deleted.');
    return;
  }
  // Push history so back button works
  if(!_nav._suppress){
    try {
      window.history.pushState({ kind:'portfolio', id: portfolioId }, '', '#/portfolio/' + portfolioId);
    } catch(e){}
  }
  _currentPortfolioId = portfolioId;
  // Always land on Summary tab when opening a portfolio for the first time.
  // Turn D: tab state persists across re-renders within the same portfolio
  // (for example after Edit or Add Deals) but resets on navigation.
  _currentPortfolioTab = 'summary';
  // Turn F: clear the offers cache and trigger a background load so the
  // Offers tab is populated when the user switches to it. Non-blocking —
  // the Summary tab renders immediately. On completion we re-render if
  // the user happens to be on the Offers tab already.
  _currentPortfolioOffers = [];
  _portfolioOffersLoad(portfolioId).then(() => {
    if(_currentPortfolioId === portfolioId && _currentPortfolioTab === 'offers'){
      _renderPortfolioDetail(p);
    }
  });
  _renderPortfolioDetail(p);
}

export function _renderPortfolioDetail(p){
  const main = document.getElementById('mainArea');
  if(!main) return;
  const children = _portfolioChildren(p.id);
  const agg = _portfolioAggregates(children);
  const stage = p['Pipeline Stage'] || '';
  const stageColor = NEW_PIPELINE_COLORS[stage] || '#64748b';
  const pkgPrice = p['Package Price'];
  const sumVsPkg = (pkgPrice && agg.totalAsking) ? (agg.totalAsking - Number(pkgPrice)) : null;

  const fmt$ = n => {
    if(!n || isNaN(n)) return '—';
    const v = Number(n);
    if(v >= 1e6) return '$' + (v/1e6).toFixed(2) + 'M';
    if(v >= 1e3) return '$' + Math.round(v/1e3) + 'K';
    return '$' + v.toLocaleString();
  };
  const fmtPct = n => (n != null && !isNaN(n)) ? n.toFixed(2) + '%' : '—';

  // ── PIPELINE SECTION ──────────────────────────────────────────────
  // Mirrors the deal detail's "Deal Status / Pipeline" UX: a company-wide
  // 17-stage tracker + Set-Stage grid, plus (if membership exists) a personal
  // pipeline block for the logged-in user only. Built as HTML strings here
  // and injected between the header card and the tab bar below.
  const PF_STAGES = (typeof NEW_PIPELINE_STAGES !== 'undefined' ? NEW_PIPELINE_STAGES : []).map(key => ({
    key, label: key, color: (typeof NEW_PIPELINE_COLORS !== 'undefined' && NEW_PIPELINE_COLORS[key]) || '#6b7280'
  }));
  const pfCurIdx = PF_STAGES.findIndex(s => s.key === stage);
  const pfTracker = PF_STAGES.map((s,i) => {
    const active = s.key === stage;
    const past   = pfCurIdx > i;
    return `
    <div style="text-align:center;flex:1;min-width:0;">
      <div style="width:30px;height:30px;border-radius:50%;margin:0 auto 4px;
        background:${active?s.color:past?'#9ca3af':'#e5e7eb'};
        border:2px solid ${active?s.color:past?'#6b7280':'#d1d5db'};
        display:flex;align-items:center;justify-content:center;
        font-size:11px;color:${past||active?'#fff':'#9ca3af'};font-weight:600;
        ${active?'box-shadow:0 0 0 4px '+s.color+'33;':''}"
      >${past?'✓':i+1}</div>
      <div style="font-size:9px;font-weight:${active?700:400};color:${active?s.color:'#6b7280'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.label}</div>
    </div>`;
  }).join('<div style="flex:0 0 12px;height:2px;background:#e5e7eb;margin-top:15px;"></div>');
  const pfStageButtons = PF_STAGES.map(s => `
    <button onclick="changePortfolioStage('${p.id}','${s.key.replace(/'/g,"\\'")}')" style="
      padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;
      background:${s.key===stage?s.color:'#fff'};
      color:${s.key===stage?'#fff':'#334155'};
      border:1px solid ${s.key===stage?s.color:'#e2e8f0'};
      transition:all 0.1s;">${s.label}</button>`).join('');

  // Personal pipeline section — only if logged-in user has this portfolio in
  // their pipeline AND stages are loaded.
  let pfMyPipelineBlock = '';
  const pfPpIsMember = typeof _myPipelinePortfolioIds !== 'undefined'
    && _myPipelinePortfolioIds && _myPipelinePortfolioIds.has(p.id);
  const pfPpHasStages = typeof _myPipelineStages !== 'undefined'
    && Array.isArray(_myPipelineStages) && _myPipelineStages.length > 0;
  if(pfPpIsMember && pfPpHasStages && _currentUser && _currentUser.id){
    const curStageId = _myPipelinePortfolioStage.get(p.id) || null;
    const curStage   = curStageId ? _myPipelineStages.find(s => s.id === curStageId) : null;
    const curStageKey= curStage ? curStage.key : '';
    const curStageIdx= curStage ? _myPipelineStages.findIndex(s => s.id === curStage.id) : -1;
    const ppTracker = _myPipelineStages.map((s,i) => {
      const active = s.id === curStageId;
      const past   = curStageIdx > i;
      const color  = s.color || '#6b7280';
      return `
      <div style="text-align:center;flex:1;min-width:0;">
        <div style="width:30px;height:30px;border-radius:50%;margin:0 auto 4px;
          background:${active?color:past?'#9ca3af':'#e5e7eb'};
          border:2px solid ${active?color:past?'#6b7280':'#d1d5db'};
          display:flex;align-items:center;justify-content:center;
          font-size:11px;color:${past||active?'#fff':'#9ca3af'};font-weight:600;
          ${active?'box-shadow:0 0 0 4px '+color+'33;':''}"
        >${past?'✓':i+1}</div>
        <div style="font-size:9px;font-weight:${active?700:400};color:${active?color:'#6b7280'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(s.label)}</div>
      </div>`;
    }).join('<div style="flex:0 0 12px;height:2px;background:#e5e7eb;margin-top:15px;"></div>');
    const ppStageButtons = _myPipelineStages.map(s => {
      const color = s.color || '#6b7280';
      const active = s.key === curStageKey;
      return `
      <button onclick="changeMyPipelinePortfolioStage('${p.id}','${s.key.replace(/'/g,"\\'")}')" style="
        padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;
        background:${active?color:'#fff'};
        color:${active?'#fff':'#334155'};
        border:1px solid ${active?color:'#e2e8f0'};
        transition:all 0.1s;">${_esc(s.label)}</button>`;
    }).join('');
    const ownerName = (_currentUser.name || _currentUser.fub_name || 'You').split(' ')[0];
    pfMyPipelineBlock = `
      <div style="background:#fff;border:1px solid #7c3aed;border-radius:10px;padding:16px 20px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;color:#6d28d9;margin-bottom:6px;">
          ⭐ ${_esc(ownerName)}'s Personal Pipeline
          <span style="font-size:11px;font-weight:400;color:#94a3b8;margin-left:6px;">Only visible to you · independent of the company stage</span>
        </div>
        <div style="display:flex;align-items:center;padding:8px 0;overflow-x:auto;">${ppTracker}</div>
        <div style="margin-top:8px;">
          <div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em;">Set Personal Stage</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${ppStageButtons}</div>
        </div>
      </div>`;
  }

  // Tab content rendered lazily based on _currentPortfolioTab.
  let tabContent;
  if(_currentPortfolioTab === 'financials'){
    tabContent = _renderPortfolioFinancialsTab(p, children, fmt$, fmtPct);
  } else if(_currentPortfolioTab === 'tenantmix'){
    tabContent = _renderPortfolioTenantUnitMixTab(p, children, fmt$, fmtPct);
  } else if(_currentPortfolioTab === 'offers'){
    tabContent = _renderPortfolioOffersTab(p, children, fmt$, fmtPct);
  } else {
    tabContent = _renderPortfolioSummaryTab(p, children, fmt$, fmtPct);
  }

  // Tab button styling helper
  const tabBtn = (key, label, icon) => {
    const active = _currentPortfolioTab === key;
    return `<button onclick="_pfSwitchTab('${key}')" style="
      background:${active?'#fff':'transparent'};
      color:${active?'#b45309':'#64748b'};
      border:none;
      border-bottom:3px solid ${active?'#b45309':'transparent'};
      padding:10px 20px;
      font-size:13px;
      font-weight:${active?'700':'500'};
      cursor:pointer;
      transition:all 0.15s;
    ">${icon} ${label}</button>`;
  };

  main.innerHTML = `
    <div style="padding:24px 28px;max-width:1200px;margin:0 auto;font-family:Tahoma,Arial,sans-serif;">
      <div style="margin-bottom:18px;">
        <button onclick="showPortfoliosPage()" style="background:none;border:none;color:#64748b;font-size:12px;cursor:pointer;padding:0;">← Back to Portfolios</button>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px 28px;margin-bottom:16px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding-bottom:16px;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">📁 Portfolio · ${agg.count} ${agg.count===1?'property':'properties'}</div>
            <div style="font-size:24px;font-weight:800;color:#0f172a;line-height:1.2;">${(p['Name']||'Untitled').replace(/</g,'&lt;')}</div>
            ${p['Description'] ? `<div style="font-size:13px;color:#64748b;margin-top:6px;">${p['Description'].replace(/</g,'&lt;')}</div>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${stage ? `<span style="font-size:11px;font-weight:700;padding:5px 12px;border-radius:99px;background:${stageColor}22;color:${stageColor};border:1px solid ${stageColor}55;">${stage}</span>` : ''}
            ${_currentUser && _currentUser.id ? (
              _isPortfolioInMyPipeline(p.id)
                ? `<button onclick="removePortfolioFromMyPipeline('${p.id}')"
                     title="Remove this portfolio from your Personal Pipeline"
                     style="background:#fff;color:#6d28d9;border:1px solid #c4b5fd;padding:6px 14px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">
                     ⭐ In My Pipeline
                   </button>`
                : `<button onclick="addPortfolioToMyPipeline('${p.id}', this)"
                     style="background:#7c3aed;color:#fff;border:1px solid #7c3aed;padding:6px 14px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">
                     + Add to My Pipeline
                   </button>`
            ) : ''}
            <button onclick="openEditPortfolioModal('${p.id}')"
              style="background:#fff;color:#b45309;border:1px solid #fde68a;padding:6px 14px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;">
              ✏️ Edit
            </button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:12px;margin-top:16px;">
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;color:#92400e;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Package Price</div>
            <div style="font-size:22px;font-weight:800;color:#b45309;margin-top:4px;">${pkgPrice ? fmt$(pkgPrice) : '—'}</div>
            ${pkgPrice ? '<div style="font-size:10px;color:#92400e;margin-top:2px;">buy all together</div>' : '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">not set</div>'}
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Sum of Individual</div>
            <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:4px;">${fmt$(agg.totalAsking)}</div>
            ${sumVsPkg != null ? `<div style="font-size:10px;color:${sumVsPkg>0?'#16a34a':'#dc2626'};margin-top:2px;">${sumVsPkg>0?'+':''}${fmt$(Math.abs(sumVsPkg))} ${sumVsPkg>0?'discount':'premium'}</div>` : '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">sum of children</div>'}
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Blended Cap</div>
            <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:4px;">${fmtPct(agg.blendedCap)}</div>
            <div style="font-size:10px;color:#94a3b8;margin-top:2px;">NOI ÷ total asking</div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Total Units / SF</div>
            <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:4px;">${agg.totalUnits || '—'}</div>
            <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${agg.totalSF ? agg.totalSF.toLocaleString() + ' SF total' : '—'}</div>
          </div>
        </div>
      </div>

      <!-- PIPELINE: COMPANY 17-stage tracker + Set Stage buttons -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:6px;">📋 Portfolio Pipeline Stage</div>
        <div style="display:flex;align-items:center;padding:8px 0;overflow-x:auto;">${pfTracker}</div>
        <div style="margin-top:8px;">
          <div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em;">Set Stage</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${pfStageButtons}</div>
        </div>
      </div>

      ${pfMyPipelineBlock}

      <!-- TAB BAR -->
      <div style="background:#f1f5f9;border-radius:10px 10px 0 0;border:1px solid #e2e8f0;border-bottom:none;display:flex;gap:2px;padding:4px 4px 0;">
        ${tabBtn('summary',    'Summary',             '🏠')}
        ${tabBtn('financials', 'Financial Analysis',  '📊')}
        ${tabBtn('tenantmix',  'Tenant & Unit Mix',   '🏪')}
        ${tabBtn('offers',     'Offers',              '💰')}
      </div>
      <div id="pfTabContent" style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px 22px;">
        ${tabContent}
      </div>
    </div>`;
}

// Tab switcher — re-renders only the tab content area, not the whole detail page.
export function _pfSwitchTab(tabKey){
  _currentPortfolioTab = tabKey;
  if(!_currentPortfolioId) return;
  const p = (window.allPortfolios || []).find(x => x.id === _currentPortfolioId);
  if(p) _renderPortfolioDetail(p);
}

// ── SUMMARY TAB CONTENT ────────────────────────────────────────────
// The Summary tab contains the child properties list. Matches the
// layout of the pre-tab-refactor detail page.
export function _renderPortfolioSummaryTab(p, children, fmt$, fmtPct){
  const childRowsHtml = children.length === 0 ? `
    <div style="background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:40px 20px;text-align:center;">
      <div style="font-size:36px;opacity:0.4;margin-bottom:8px;">🏠</div>
      <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:4px;">No properties in this portfolio yet</div>
      <div style="font-size:11px;color:#94a3b8;">Click "+ Add property" above to add existing deals.</div>
    </div>
  ` : children.map((d, i) => {
    const ask = d['Asking Price'] ? fmt$(d['Asking Price']) : '—';
    const cap = d['Cap Rate (CRM)'];
    let capStr = '—';
    if(cap != null && cap !== ''){
      const v = Number(cap);
      if(!isNaN(v) && v > 0) capStr = ((v < 1 ? v*100 : v)).toFixed(2) + '%';
    }
    const units = d['No. of Units'] || d['Number of Units'] || '';
    const sf = d['Total Building SF'] || d['Square Footage'] || '';
    const type = d['CRM Asset Classification'] || d['Simple Text Property Type'] || '—';
    return `
      <div style="display:grid;grid-template-columns:28px minmax(0,1fr) 90px 80px 90px 90px;gap:12px;align-items:center;padding:12px 16px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;transition:all 0.15s;"
        onmouseover="this.style.borderColor='#b45309';"
        onmouseout="this.style.borderColor='#e2e8f0';">
        <div style="width:24px;height:24px;border-radius:50%;background:#fef3c7;color:#92400e;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${i+1}</div>
        <div style="min-width:0;cursor:pointer;" onclick="_pfOpenChildDeal('${d.id}')">
          <div style="font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(d['Address']||'Unnamed').replace(/</g,'&lt;')}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;">${type}${units?' · '+units+' units':''}${sf?' · '+Number(sf).toLocaleString()+' SF':''}</div>
        </div>
        <div style="font-size:12px;font-weight:700;color:#0f172a;text-align:right;cursor:pointer;" onclick="_pfOpenChildDeal('${d.id}')">${ask}</div>
        <div style="font-size:11px;color:#64748b;text-align:right;cursor:pointer;" onclick="_pfOpenChildDeal('${d.id}')">${capStr}</div>
        <div style="font-size:11px;color:#64748b;text-align:right;cursor:pointer;" onclick="_pfOpenChildDeal('${d.id}')">${d['Pipeline Stage']||'—'}</div>
        <div style="display:flex;gap:4px;justify-content:flex-end;align-items:center;">
          <button onclick="event.stopPropagation(); _pfOpenChildDeal('${d.id}')"
            title="Open this deal"
            style="background:none;border:none;color:#b45309;font-size:11px;font-weight:600;cursor:pointer;padding:4px 6px;">Open →</button>
          <button onclick="event.stopPropagation(); _portfolioRemoveChild('${d.id}')"
            title="Remove from portfolio"
            style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;font-size:10px;font-weight:700;cursor:pointer;padding:3px 7px;border-radius:4px;">×</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <div style="font-size:14px;font-weight:700;color:#0f172a;">Properties in this portfolio</div>
      <button onclick="openAddDealsModal('${p.id}')"
        style="background:#b45309;color:#fff;border:none;padding:6px 14px;font-size:11px;font-weight:700;border-radius:6px;cursor:pointer;">
        + Add property
      </button>
    </div>
    ${childRowsHtml}`;
}

// ── FINANCIAL ANALYSIS TAB CONTENT ────────────────────────────────
// Read-only aggregated financials across all children. No editing —
// edits happen on child deals. Values are derived from _portfolioFinancials.
export function _renderPortfolioFinancialsTab(p, children, fmt$, fmtPct){
  if(children.length === 0){
    return `
      <div style="background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:40px 20px;text-align:center;">
        <div style="font-size:36px;opacity:0.4;margin-bottom:8px;">📊</div>
        <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:4px;">No financials to aggregate</div>
        <div style="font-size:11px;color:#94a3b8;">Add properties to this portfolio first — their financials will roll up here automatically.</div>
      </div>`;
  }
  const fin = _portfolioFinancials(children, p);
  const dq = (n, total) => {
    if(!total) return '';
    const pct = (n / total) * 100;
    const color = pct >= 80 ? '#16a34a' : (pct >= 50 ? '#d97706' : '#dc2626');
    return `<span style="color:${color};font-weight:600;">${n}/${total}</span>`;
  };
  const cell = (label, value, sub, highlight) => `
    <div style="background:${highlight?'#fffbeb':'#f8fafc'};border:1px solid ${highlight?'#fde68a':'#e2e8f0'};border-radius:8px;padding:12px 14px;">
      <div style="font-size:10px;color:${highlight?'#92400e':'#64748b'};text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">${label}</div>
      <div style="font-size:18px;font-weight:800;color:${highlight?'#b45309':'#0f172a'};margin-top:4px;">${value}</div>
      ${sub ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">${sub}</div>` : ''}
    </div>`;
  const row = (label, actualVal, pfVal, note) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#475569;">${label}${note?`<div style="font-size:9px;color:#94a3b8;">${note}</div>`:''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#0f172a;text-align:right;font-weight:600;">${actualVal}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#0f172a;text-align:right;font-weight:600;">${pfVal}</td>
    </tr>`;

  // Data quality banner
  const anyMissing = fin.childrenWithNOI < fin.count || fin.childrenWithExpenses < fin.count || fin.childrenWithGRI < fin.count;
  const dqBanner = anyMissing ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:11px;color:#92400e;line-height:1.5;">
      <strong style="font-weight:700;">Data quality note:</strong> Not all children have complete financials filled in.
      ${dq(fin.childrenWithAsking, fin.count)} have asking price ·
      ${dq(fin.childrenWithGRI, fin.count)} have GRI ·
      ${dq(fin.childrenWithExpenses, fin.count)} have expenses ·
      ${dq(fin.childrenWithNOI, fin.count)} have NOI.
      Missing values are treated as $0 in the sums below.
    </div>` : `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:11px;color:#166534;line-height:1.5;">
      <strong style="font-weight:700;">✓ All ${fin.count} children have complete financials.</strong> Aggregates below reflect the full portfolio.
    </div>`;

  // Expense breakdown table rows
  const expCats = [
    ['Property Tax',      'exp_propertyTax'],
    ['Insurance',         'exp_insurance'],
    ['Management Fee',    'exp_mgmtFee'],
    ['Maintenance & Repair','exp_maintenance'],
    ['Electric',          'exp_electric'],
    ['Gas',               'exp_gas'],
    ['Water & Sewer',     'exp_water'],
    ['Trash',             'exp_trash'],
    ['Landscaping',       'exp_landscaping'],
    ['Janitorial',        'exp_janitorial'],
    ['Supplies',          'exp_supplies'],
    ['Capital Reserve',   'exp_capitalReserve'],
    ['Admin',             'exp_admin'],
    ['Miscellaneous',     'exp_misc']
  ];
  const expRows = expCats
    .filter(([, k]) => fin.actual[k] > 0)
    .map(([label, k]) => {
      const mo = fin.actual[k];
      const yr = mo * 12;
      return `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#475569;">${label}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#0f172a;text-align:right;">${fmt$(mo)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#0f172a;text-align:right;">${fmt$(yr)}</td>
        </tr>`;
    }).join('');

  // Unit mix summary — Turn E moved the detailed view to its own tab.
  // The Financial Analysis tab now just shows total unit count in the
  // headline cards and cross-references the new tab.
  const um = fin.unitMix;
  const hasUnits = (um.eff + um.br1 + um.br2 + um.br3 + um.br4 + um.other) > 0;
  const unitMixHtml = hasUnits ? `
    <div style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 16px;margin-top:14px;text-align:center;font-size:11px;color:#64748b;">
      <strong style="color:#475569;">${fin.totalUnits} total units across ${fin.count} ${fin.count === 1 ? 'property' : 'properties'}.</strong>
      See <a onclick="_pfSwitchTab('tenantmix')" style="color:#b45309;font-weight:700;cursor:pointer;text-decoration:underline;">🏪 Tenant &amp; Unit Mix</a> for the per-bedroom breakdown with blended rents.
    </div>` : '';

  // Package vs Sum pricing note
  const priceBasisLabel = fin.packagePrice ? 'package price' : 'sum of individual asking';
  const priceBasis = fin.packagePrice || fin.totalAsking;

  return `
    ${dqBanner}

    <!-- KEY METRICS CARDS -->
    <div style="display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:10px;margin-bottom:18px;">
      ${cell('NOI (Annual)', fmt$(fin.totalNOI), 'across all children', true)}
      ${cell('Cash Flow (Annual)', fmt$(fin.actual.cashFlowYearly), fin.actual.annualDebtService > 0 ? 'after debt service' : 'no debt tracked')}
      ${cell('DSCR', fin.actual.dscr != null ? fin.actual.dscr.toFixed(2) : '—', fin.actual.dscr != null ? 'debt coverage' : 'no debt tracked')}
      ${cell('GRM', fin.actual.grm != null ? fin.actual.grm.toFixed(2) : '—', 'price ÷ gross rent')}
    </div>

    <div style="display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:10px;margin-bottom:18px;">
      ${cell('Cap Rate (on sum)', fmtPct(fin.actual.capRateSum), 'NOI ÷ total asking')}
      ${cell('Cap Rate (package)', fin.actual.capRatePackage != null ? fmtPct(fin.actual.capRatePackage) : '—', fin.packagePrice ? 'NOI ÷ package price' : 'set package price to compute', fin.packagePrice != null)}
      ${cell('Break-Even Occupancy', fin.actual.breakEvenPct != null ? fmtPct(fin.actual.breakEvenPct) : '—', '(expenses + debt) ÷ GRI')}
      ${cell('Price / SF', fin.pricePerSF != null ? '$' + fin.pricePerSF.toFixed(2) : '—', `based on ${priceBasisLabel}`)}
    </div>

    <!-- INCOME & EXPENSE SIDE-BY-SIDE (ACTUAL vs PROFORMA) -->
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:10px;">💰 Income & Expenses</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;border-bottom:2px solid #e2e8f0;">Line Item</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;border-bottom:2px solid #e2e8f0;">Actual</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;border-bottom:2px solid #e2e8f0;">Proforma</th>
          </tr>
        </thead>
        <tbody>
          ${row('Gross Rental Income (Monthly)', fmt$(fin.actual.griMonthly), fmt$(fin.proforma.griMonthly))}
          ${row('Gross Rental Income (Yearly)',  fmt$(fin.actual.griYearly),  fmt$(fin.proforma.griYearly))}
          ${row('Total Expenses (Monthly)',      fmt$(fin.actual.expensesMonthly), fmt$(fin.proforma.expensesMonthly))}
          ${row('Total Expenses (Yearly)',       fmt$(fin.actual.expensesYearly),  fmt$(fin.proforma.expensesYearly))}
          <tr style="background:#fffbeb;">
            <td style="padding:10px 12px;font-size:12px;color:#92400e;font-weight:700;border-top:2px solid #fde68a;">Net Operating Income (NOI)</td>
            <td style="padding:10px 12px;font-size:13px;color:#b45309;font-weight:800;text-align:right;border-top:2px solid #fde68a;">${fmt$(fin.actual.noiYearly)}</td>
            <td style="padding:10px 12px;font-size:13px;color:#b45309;font-weight:800;text-align:right;border-top:2px solid #fde68a;">${fmt$(fin.proforma.noiYearly)}</td>
          </tr>
          ${fin.actual.annualDebtService > 0 ? `
          ${row('Annual Debt Service', fmt$(fin.actual.annualDebtService), '—')}
          <tr style="background:#f0fdf4;">
            <td style="padding:10px 12px;font-size:12px;color:#166534;font-weight:700;">Annual Cash Flow</td>
            <td style="padding:10px 12px;font-size:13px;color:#166534;font-weight:800;text-align:right;">${fmt$(fin.actual.cashFlowYearly)}</td>
            <td style="padding:10px 12px;font-size:13px;color:#94a3b8;text-align:right;">—</td>
          </tr>
          ` : ''}
        </tbody>
      </table>
    </div>

    <!-- EXPENSE BREAKDOWN BY CATEGORY -->
    ${expRows ? `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:10px;">📋 Expense Breakdown (Actual)</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;border-bottom:2px solid #e2e8f0;">Category</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;border-bottom:2px solid #e2e8f0;">Monthly</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;border-bottom:2px solid #e2e8f0;">Yearly</th>
          </tr>
        </thead>
        <tbody>${expRows}</tbody>
      </table>
      <div style="font-size:10px;color:#94a3b8;margin-top:8px;line-height:1.5;">
        Summed across all children that have values set. Categories with $0 total are hidden.
      </div>
    </div>` : ''}

    ${unitMixHtml}

    <div style="font-size:11px;color:#94a3b8;margin-top:16px;line-height:1.6;text-align:center;">
      All values are read-only aggregates. To change a number, <strong style="color:#475569;">open the child deal and edit there.</strong>
    </div>`;
}

// Open a child deal from the portfolio detail view. Uses the normal
// openDeal flow — portfolios are just a view, children are still
// regular deals.
export function _pfOpenChildDeal(dealId){
  const d = (window.allDeals || []).find(x => x.id === dealId);
  if(!d){ alert('Deal not found.'); return; }
  if(typeof openDeal === 'function') openDeal(d);
}

// ── UPDATE + ASSIGN HELPERS (Turn B-second-half) ──────────────────
// Updates a portfolio row. fields uses Airtable-style display keys.
export async function _portfolioUpdate(portfolioId, fields){
  if(!isSupabase()) throw new Error('Supabase required');
  if(!portfolioId) throw new Error('portfolioId required');
  const sbData = _atToSb(fields, SB_PORTFOLIO_MAP);
  if(Object.keys(sbData).length === 0) return;
  sbData.updated_at = new Date().toISOString();
  await _sbPatch(SB_TABLES.portfolios, portfolioId, sbData);
  // Update the local cache entry so UI reflects immediately without a full refetch
  const idx = (window.allPortfolios || []).findIndex(p => p.id === portfolioId);
  if(idx > -1){
    Object.assign(window.allPortfolios[idx], fields);
  }
}

// Portfolio pipeline-stage setter (company pipeline). Mirror of changeStage
// for deals — patches Pipeline Stage and re-renders the detail page so the
// tracker + buttons reflect the new state.
export async function changePortfolioStage(portfolioId, stageKey){
  if(!portfolioId || !stageKey) return;
  const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
  if(!p) return;
  if(p['Pipeline Stage'] === stageKey) return;
  const prev = p['Pipeline Stage'];
  // Optimistic
  p['Pipeline Stage'] = stageKey;
  try {
    await _portfolioUpdate(portfolioId, { 'Pipeline Stage': stageKey });
    if(typeof showSaveConfirm === 'function') showSaveConfirm('Stage → ' + stageKey);
    if(typeof _currentPortfolioId !== 'undefined' && _currentPortfolioId === portfolioId){
      _renderPortfolioDetail(p);
    }
  } catch(e){
    p['Pipeline Stage'] = prev;
    console.error('changePortfolioStage failed:', e);
    if(typeof showSaveConfirm === 'function') showSaveConfirm('Stage update failed');
  }
}

// Personal-pipeline sibling. Delegates to _myPipelineMovePortfolio (optimistic
// cache update + RPC) then re-renders the detail page so the tracker shifts.
export async function changeMyPipelinePortfolioStage(portfolioId, stageKey){
  if(!portfolioId || !stageKey) return;
  if(typeof _myPipelineMovePortfolio !== 'function') return;
  try {
    await _myPipelineMovePortfolio(portfolioId, stageKey);
    if(typeof _currentPortfolioId !== 'undefined' && _currentPortfolioId === portfolioId){
      const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
      if(p) _renderPortfolioDetail(p);
    }
  } catch(e){
    console.warn('changeMyPipelinePortfolioStage failed:', e);
  }
}

// Assigns a single deal to a portfolio (or null to unassign).
// Updates both the DB and the in-memory window.allDeals cache.
export async function _portfolioAssignDeal(dealId, portfolioId){
  if(!isSupabase()) throw new Error('Supabase required');
  if(!dealId) throw new Error('dealId required');
  // portfolioId may be null to unassign
  await _sbPatch(SB_TABLES.properties, dealId, { portfolio_id: portfolioId });
  // Update the in-memory deal so subsequent renders see the change
  const d = (window.allDeals || []).find(x => x.id === dealId);
  if(d) d['Portfolio ID'] = portfolioId;
}

// Bulk assign — loops _portfolioAssignDeal sequentially. For the handful
// of deals a single portfolio holds this is fine; if we ever need to
// assign 100+ at once we'd switch to a single PATCH with IN-filter.
export async function _portfolioAssignDeals(dealIds, portfolioId){
  for(const id of dealIds){
    await _portfolioAssignDeal(id, portfolioId);
  }
}

// ── ADD DEALS TO PORTFOLIO MODAL ──────────────────────────────────
// State: which portfolio we're adding to (set at open time).
let _addDealsTargetPortfolioId = null;
// State: which deal IDs are currently checked in the modal.
let _addDealsSelected = new Set();

export function openAddDealsModal(portfolioId){
  const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
  if(!p){ alert('Portfolio not found.'); return; }
  _addDealsTargetPortfolioId = portfolioId;
  _addDealsSelected = new Set();
  const modal = document.getElementById('addDealsPortfolioModal');
  const subtitle = document.getElementById('addDealsSubtitle');
  const search = document.getElementById('addDealsSearch');
  const err = document.getElementById('addDealsError');
  if(subtitle) subtitle.textContent = 'Adding to: ' + (p['Name'] || 'Untitled');
  if(search) search.value = '';
  if(err){ err.style.display = 'none'; err.textContent = ''; }
  _renderAddDealsList();
  _updateAddDealsCount();
  if(modal) modal.style.display = 'flex';
  setTimeout(() => search?.focus(), 50);
}

export function closeAddDealsModal(){
  const modal = document.getElementById('addDealsPortfolioModal');
  if(modal) modal.style.display = 'none';
  _addDealsTargetPortfolioId = null;
  _addDealsSelected = new Set();
}

// Renders the checkbox list of eligible deals. Eligible = deals not
// already in ANY portfolio (to prevent accidental re-homing), OR deals
// already in THIS portfolio (shown checked as context).
export function _renderAddDealsList(){
  const host = document.getElementById('addDealsList');
  if(!host) return;
  const targetId = _addDealsTargetPortfolioId;
  const eligible = (window.allDeals || []).filter(d => {
    const pid = d['Portfolio ID'];
    return !pid || pid === targetId;
  });
  // Sort: not-yet-assigned first, then by address
  eligible.sort((a, b) => {
    const aInThis = a['Portfolio ID'] === targetId ? 0 : 1;
    const bInThis = b['Portfolio ID'] === targetId ? 0 : 1;
    if(aInThis !== bInThis) return bInThis - aInThis; // unassigned first
    return (a['Address']||'').localeCompare(b['Address']||'');
  });

  if(eligible.length === 0){
    host.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:#94a3b8;font-size:12px;">
        No eligible deals found. All deals are already in another portfolio.
      </div>`;
    return;
  }

  const fmt$ = n => {
    if(!n || isNaN(n)) return '—';
    const v = Number(n);
    if(v >= 1e6) return '$' + (v/1e6).toFixed(2) + 'M';
    if(v >= 1e3) return '$' + Math.round(v/1e3) + 'K';
    return '$' + v.toLocaleString();
  };

  host.innerHTML = eligible.map(d => {
    const alreadyInThis = d['Portfolio ID'] === targetId;
    const checked = alreadyInThis || _addDealsSelected.has(d.id);
    if(alreadyInThis) _addDealsSelected.add(d.id); // ensure it's tracked
    const type = d['CRM Asset Classification'] || d['Simple Text Property Type'] || '';
    const stage = d['Pipeline Stage'] || '';
    const ask = d['Asking Price'] ? fmt$(d['Asking Price']) : '—';
    const county = d['Simple County'] || '';
    return `
      <label class="add-deals-row" data-search-text="${((d['Address']||'') + ' ' + county + ' ' + stage + ' ' + type).toLowerCase().replace(/"/g,'&quot;')}"
        style="display:grid;grid-template-columns:24px minmax(0,1fr) 80px 100px;gap:10px;align-items:center;padding:10px 12px;background:${checked ? '#fffbeb' : '#fff'};border:1px solid ${checked ? '#fde68a' : '#e2e8f0'};border-radius:8px;margin-bottom:6px;cursor:pointer;">
        <input type="checkbox" ${checked ? 'checked' : ''} ${alreadyInThis ? 'data-already-in="1"' : ''}
          data-deal-id="${d.id}"
          onchange="_toggleAddDealsSelection('${d.id}', this.checked, this.closest('label'))" />
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${(d['Address']||'Unnamed').replace(/</g,'&lt;')}
            ${alreadyInThis ? '<span style="color:#b45309;font-size:10px;margin-left:6px;">(already in)</span>' : ''}
          </div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">${type}${county ? ' · '+county : ''}${stage ? ' · '+stage : ''}</div>
        </div>
        <div style="font-size:12px;font-weight:600;color:#0f172a;text-align:right;">${ask}</div>
        <div style="font-size:10px;color:#94a3b8;text-align:right;">${d['Date Added'] ? d['Date Added'].slice(0,10) : ''}</div>
      </label>`;
  }).join('');
}

export function _toggleAddDealsSelection(dealId, checked, rowEl){
  if(checked){ _addDealsSelected.add(dealId); }
  else { _addDealsSelected.delete(dealId); }
  if(rowEl){
    rowEl.style.background = checked ? '#fffbeb' : '#fff';
    rowEl.style.borderColor = checked ? '#fde68a' : '#e2e8f0';
  }
  _updateAddDealsCount();
}

export function _updateAddDealsCount(){
  const el = document.getElementById('addDealsCount');
  if(!el) return;
  const n = _addDealsSelected.size;
  el.textContent = n + (n === 1 ? ' selected' : ' selected');
}

export function _addDealsFilter(){
  const q = (document.getElementById('addDealsSearch')?.value || '').trim().toLowerCase();
  const rows = document.querySelectorAll('#addDealsList .add-deals-row');
  rows.forEach(row => {
    if(!q){ row.style.display = ''; return; }
    const text = row.getAttribute('data-search-text') || '';
    row.style.display = text.indexOf(q) !== -1 ? '' : 'none';
  });
}

export async function submitAddDeals(){
  const portfolioId = _addDealsTargetPortfolioId;
  if(!portfolioId) return;
  const err = document.getElementById('addDealsError');
  const btn = document.getElementById('addDealsSubmitBtn');
  const showErr = (msg) => { if(err){ err.textContent = msg; err.style.display='block'; } };
  // Compute the DIFF: deals that should be assigned now but aren't yet
  const toAssign = [...(_addDealsSelected || [])].filter(id => {
    const d = (window.allDeals || []).find(x => x.id === id);
    return d && d['Portfolio ID'] !== portfolioId;
  });
  if(toAssign.length === 0){
    closeAddDealsModal();
    return;
  }
  if(btn){ btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    await _portfolioAssignDeals(toAssign, portfolioId);
    closeAddDealsModal();
    // Re-render the detail view if we're on it
    if(_currentPortfolioId === portfolioId){
      const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
      if(p) _renderPortfolioDetail(p);
    } else {
      showPortfoliosPage();
    }
  } catch(e) {
    showErr('Failed to save: ' + (e.message || 'unknown error'));
    if(btn){ btn.disabled = false; btn.textContent = 'Add to Portfolio'; }
  }
}

// ── EDIT PORTFOLIO MODAL ──────────────────────────────────────────
let _editPortfolioTargetId = null;

export function openEditPortfolioModal(portfolioId){
  const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
  if(!p){ alert('Portfolio not found.'); return; }
  _editPortfolioTargetId = portfolioId;
  const modal = document.getElementById('editPortfolioModal');
  const name = document.getElementById('epName');
  const price = document.getElementById('epPackagePrice');
  const stage = document.getElementById('epStage');
  const desc = document.getElementById('epDescription');
  const notes = document.getElementById('epNotes');
  const err = document.getElementById('epError');
  if(name) name.value = p['Name'] || '';
  if(price) price.value = p['Package Price'] != null ? String(p['Package Price']) : '';
  if(desc) desc.value = p['Description'] || '';
  if(notes) notes.value = p['Portfolio Notes'] || '';
  if(err){ err.style.display = 'none'; err.textContent = ''; }
  if(stage){
    stage.innerHTML = '<option value="">— Select —</option>' +
      NEW_PIPELINE_STAGES.map(s => `<option value="${s}" ${p['Pipeline Stage']===s?'selected':''}>${s}</option>`).join('');
  }
  if(modal) modal.style.display = 'flex';
  setTimeout(() => name?.focus(), 50);
}

export function closeEditPortfolioModal(){
  const modal = document.getElementById('editPortfolioModal');
  if(modal) modal.style.display = 'none';
  _editPortfolioTargetId = null;
}

export async function submitEditPortfolio(){
  const id = _editPortfolioTargetId;
  if(!id) return;
  const name = document.getElementById('epName')?.value?.trim() || '';
  const rawPrice = document.getElementById('epPackagePrice')?.value?.trim() || '';
  const stage = document.getElementById('epStage')?.value || '';
  const desc = document.getElementById('epDescription')?.value?.trim() || '';
  const notes = document.getElementById('epNotes')?.value?.trim() || '';
  const err = document.getElementById('epError');
  const btn = document.getElementById('epSubmitBtn');
  const showErr = (msg) => { if(err){ err.textContent = msg; err.style.display='block'; } };

  if(!name){ showErr('Portfolio name is required.'); return; }
  let packagePrice = null;
  if(rawPrice){
    const n = parseFloat(rawPrice.replace(/,/g,''));
    if(isNaN(n) || n < 0){ showErr('Package price must be a valid number.'); return; }
    packagePrice = n;
  }

  // Send all fields, including clearing ones that were emptied
  const fields = {
    'Name': name,
    'Package Price':   packagePrice,           // null clears the field
    'Pipeline Stage':  stage || null,
    'Description':     desc || null,
    'Portfolio Notes': notes || null
  };

  if(btn){ btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    await _portfolioUpdate(id, fields);
    closeEditPortfolioModal();
    // Re-render current view
    if(_currentPortfolioId === id){
      const p = (window.allPortfolios || []).find(x => x.id === id);
      if(p) _renderPortfolioDetail(p);
    } else {
      showPortfoliosPage();
    }
  } catch(e) {
    showErr('Failed to save: ' + (e.message || 'unknown error'));
    if(btn){ btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

// ── REMOVE CHILD FROM PORTFOLIO ───────────────────────────────────
export async function _portfolioRemoveChild(dealId){
  if(!confirm('Remove this property from the portfolio?\n\nThe deal itself will not be deleted — it just won\'t be part of this portfolio anymore.')) return;
  try {
    await _portfolioAssignDeal(dealId, null);
    // Re-render the detail view if we're on it
    const p = (window.allPortfolios || []).find(x => x.id === _currentPortfolioId);
    if(p) _renderPortfolioDetail(p);
  } catch(e) {
    alert('Failed to remove: ' + (e.message || 'unknown error'));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// v102.28 Turn C: 📁 ICON + HOVER CARD
// ═══════════════════════════════════════════════════════════════════════
// Small folder icon that appears next to deal addresses whenever a deal
// belongs to a portfolio. Hover (desktop) shows a tooltip with portfolio
// name, asset composition, and count. Click opens the portfolio detail.
// A single shared hover card element (#pfHoverCard) is reused for every
// icon on the page — cheap even on a Deal Board rendering 5,700 rows.

// Returns the inline HTML for the 📁 icon, or empty string if the deal
// isn't in a portfolio. Safe to drop into any template literal.
export function _pfIconHtml(deal){
  if(!deal) return '';
  const pid = deal['Portfolio ID'];
  if(!pid) return '';
  // Also verify the portfolio still exists in the cache (it could have
  // been archived since the last sync). If not, hide the icon silently.
  const p = (window.allPortfolios || []).find(x => x.id === pid);
  if(!p) return '';
  return `<span class="pf-icon" data-pf-id="${pid}"
    onclick="event.stopPropagation(); openPortfolioDetail('${pid}')"
    onmouseenter="_pfShowHover('${pid}', this)"
    onmouseleave="_pfHideHover()"
    title="Part of a portfolio — click to open"
    style="display:inline-block;cursor:pointer;font-size:13px;padding:0 4px;opacity:0.85;vertical-align:middle;transition:opacity 0.15s,transform 0.15s;"
    onmouseover="this.style.opacity='1';this.style.transform='scale(1.15)'"
    onmouseout="this.style.opacity='0.85';this.style.transform='scale(1)'"
  >📁</span>`;
}

// Timeout handle for delayed hide — lets user move mouse from icon onto
// the card without it flickering away.
let _pfHoverHideTimer = null;

export function _pfShowHover(portfolioId, anchorEl){
  const card = document.getElementById('pfHoverCard');
  if(!card || !anchorEl) return;
  _pfCancelHide();
  const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
  if(!p) return;
  const children = _portfolioChildren(portfolioId);
  // Compose the asset-type breakdown. Group by CRM Asset Classification
  // (falls back to Simple Text Property Type). Shows e.g. "3 Retail,
  // 2 Multifamily" for mixed portfolios, or "5 Multifamily" for uniform.
  const buckets = {};
  children.forEach(d => {
    const t = (d['CRM Asset Classification'] || d['Simple Text Property Type'] || 'Other').split('|')[0].split(':')[0].trim() || 'Other';
    buckets[t] = (buckets[t] || 0) + 1;
  });
  const composition = Object.entries(buckets)
    .sort((a,b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(' · ');

  const nameEl = document.getElementById('pfHoverName');
  const compEl = document.getElementById('pfHoverComposition');
  const countEl = document.getElementById('pfHoverCount');
  if(nameEl) nameEl.textContent = p['Name'] || 'Untitled Portfolio';
  if(compEl) compEl.textContent = composition || 'No properties yet';
  if(countEl) countEl.textContent = children.length === 1
    ? '1 property'
    : children.length + ' properties';

  // Position the card near the anchor. Prefer below the icon; flip to
  // above if there's not enough room. Clamp horizontally to viewport.
  card.style.display = 'block';
  // Temporarily hide from layout to measure it
  card.style.visibility = 'hidden';
  const rect = anchorEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const GAP = 8;
  let top = rect.bottom + GAP;
  if(top + cardRect.height > vh - 12){
    // Flip above
    top = rect.top - cardRect.height - GAP;
    if(top < 12) top = 12;
  }
  let left = rect.left + (rect.width / 2) - (cardRect.width / 2);
  if(left < 12) left = 12;
  if(left + cardRect.width > vw - 12) left = vw - cardRect.width - 12;
  card.style.top  = Math.round(top)  + 'px';
  card.style.left = Math.round(left) + 'px';
  card.style.visibility = 'visible';
}

export function _pfHideHover(){
  _pfCancelHide();
  // Small delay so the user can move onto the card
  _pfHoverHideTimer = setTimeout(() => {
    const card = document.getElementById('pfHoverCard');
    if(card) card.style.display = 'none';
    _pfHoverHideTimer = null;
  }, 180);
}

export function _pfCancelHide(){
  if(_pfHoverHideTimer){
    clearTimeout(_pfHoverHideTimer);
    _pfHoverHideTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// v102.28 Turn F: PORTFOLIO OFFERS
// ═══════════════════════════════════════════════════════════════════════
// Read/write offers against the ace_portfolio_offers table. Mirrors the
// deal-level offers pattern (raw column names, no field map). Differs in
// one important way: the affected_child_ids array lets an offer scope
// to a subset of the portfolio's children (partial-package offers).

// Cache of offers for the current portfolio. Keyed to _currentPortfolioId.
let _currentPortfolioOffers = [];

// Fetches offers for a portfolio. Orders by offer_date desc (newest first).
// Soft-deleted rows are filtered out. Safe to call repeatedly — replaces
// the cache on each call.
export async function _portfolioOffersLoad(portfolioId){
  if(!portfolioId){ _currentPortfolioOffers = []; return []; }
  try {
    const rows = await _sbGet(SB_TABLES.portfolioOffers,
      `portfolio_id=eq.${portfolioId}&deleted_at=is.null&select=*&order=offer_date.desc.nullslast,created_at.desc`);
    _currentPortfolioOffers = rows || [];
    return _currentPortfolioOffers;
  } catch(e) {
    console.warn('[_portfolioOffersLoad] failed:', e.message);
    _currentPortfolioOffers = [];
    return [];
  }
}

export async function _portfolioOfferCreate(portfolioId, fields){
  if(!portfolioId) throw new Error('portfolioId required');
  const payload = { ...fields, portfolio_id: portfolioId };
  if(typeof _currentUser !== 'undefined' && _currentUser && _currentUser.id){
    payload.created_by_user_id = _currentUser.id;
  }
  return await _sbPost(SB_TABLES.portfolioOffers, payload);
}

export async function _portfolioOfferUpdate(offerId, fields){
  if(!offerId) throw new Error('offerId required');
  return await _sbPatch(SB_TABLES.portfolioOffers, offerId, fields);
}

export async function _portfolioOfferDelete(offerId){
  if(!offerId) throw new Error('offerId required');
  // Soft delete via deleted_at timestamp
  return await _sbPatch(SB_TABLES.portfolioOffers, offerId, {
    deleted_at: new Date().toISOString()
  });
}

// ── OFFER MODAL HANDLERS ──────────────────────────────────────────
let _poEditingOfferId = null;

export function openPortfolioOfferModal(portfolioId, offerId){
  const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
  if(!p){ alert('Portfolio not found.'); return; }
  _poEditingOfferId = offerId || null;
  const modal = document.getElementById('portfolioOfferModal');
  const title = document.getElementById('poModalTitle');
  const err = document.getElementById('poError');
  const deleteBtn = document.getElementById('poDeleteBtn');
  if(err){ err.style.display = 'none'; err.textContent = ''; }

  // Populate the affected children checkbox list
  const children = _portfolioChildren(portfolioId);
  const list = document.getElementById('poAffectedList');
  if(list){
    if(children.length === 0){
      list.innerHTML = '<div style="font-size:11px;color:#94a3b8;padding:8px;">No properties in this portfolio yet.</div>';
    } else {
      list.innerHTML = children.map(d => `
        <label class="po-affected-row" data-deal-id="${d.id}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fff;border:1px solid #fde68a;border-radius:6px;cursor:pointer;">
          <input type="checkbox" class="po-affected-cb" value="${d.id}" checked onchange="_poUpdateAffectedStatus()" />
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(d['Address']||'Unnamed').replace(/</g,'&lt;')}</div>
            <div style="font-size:10px;color:#94a3b8;">${d['Asking Price'] ? '$'+Number(d['Asking Price']).toLocaleString() : '—'}</div>
          </div>
        </label>`).join('');
    }
  }

  // Prefill if editing
  if(offerId){
    const o = (_currentPortfolioOffers || []).find(x => x.id === offerId);
    if(!o){ alert('Offer not found.'); return; }
    if(title) title.textContent = '✏️ Edit Portfolio Offer';
    document.getElementById('poType').value           = o.offer_type          || 'buyer_offer';
    document.getElementById('poDate').value           = o.offer_date          || '';
    document.getElementById('poPartyName').value      = o.party_name          || '';
    document.getElementById('poAmount').value         = o.amount != null ? String(o.amount) : '';
    document.getElementById('poFinancing').value      = o.financing_type      || '';
    document.getElementById('poPresentation').value   = o.presentation_status || 'not_presented';
    document.getElementById('poTerms').value          = o.terms               || '';
    document.getElementById('poContingencies').value  = o.contingencies       || '';
    document.getElementById('poNotes').value          = o.notes               || '';
    // Affected children: if array is empty/null, treat as "all" (all checked)
    if(Array.isArray(o.affected_child_ids) && o.affected_child_ids.length > 0){
      const affected = new Set(o.affected_child_ids);
      document.querySelectorAll('.po-affected-cb').forEach(cb => {
        cb.checked = affected.has(cb.value);
      });
    }
    if(deleteBtn) deleteBtn.style.display = 'inline-block';
  } else {
    if(title) title.textContent = '💰 New Portfolio Offer';
    document.getElementById('poType').value           = 'buyer_offer';
    document.getElementById('poDate').value           = new Date().toISOString().slice(0,10);
    document.getElementById('poPartyName').value      = '';
    document.getElementById('poAmount').value         = '';
    document.getElementById('poFinancing').value      = '';
    document.getElementById('poPresentation').value   = 'not_presented';
    document.getElementById('poTerms').value          = '';
    document.getElementById('poContingencies').value  = '';
    document.getElementById('poNotes').value          = '';
    // All checked by default (applies to whole portfolio)
    document.querySelectorAll('.po-affected-cb').forEach(cb => { cb.checked = true; });
    if(deleteBtn) deleteBtn.style.display = 'none';
  }

  _poUpdateAffectedStatus();
  if(modal) modal.style.display = 'flex';
  setTimeout(() => document.getElementById('poPartyName')?.focus(), 50);
}

export function closePortfolioOfferModal(){
  const modal = document.getElementById('portfolioOfferModal');
  if(modal) modal.style.display = 'none';
  _poEditingOfferId = null;
}

export function _poUpdateAffectedStatus(){
  const status = document.getElementById('poAffectedStatus');
  if(!status) return;
  const cbs = document.querySelectorAll('.po-affected-cb');
  const total = cbs.length;
  const checked = [...cbs].filter(cb => cb.checked).length;
  if(total === 0){
    status.textContent = '';
  } else if(checked === total){
    status.textContent = `Applies to all ${total} properties (package offer)`;
    status.style.color = '#166534';
  } else {
    status.textContent = `Applies to ${checked} of ${total} properties (partial offer)`;
    status.style.color = '#b45309';
  }
}

export async function submitPortfolioOffer(){
  const portfolioId = _currentPortfolioId;
  if(!portfolioId) return;

  const err = document.getElementById('poError');
  const btn = document.getElementById('poSubmitBtn');
  const showErr = (msg) => { if(err){ err.textContent = msg; err.style.display='block'; } };
  const hideErr = () => { if(err){ err.style.display = 'none'; } };

  const partyName = document.getElementById('poPartyName')?.value?.trim() || '';
  const rawAmount = document.getElementById('poAmount')?.value?.trim() || '';
  const offerType = document.getElementById('poType')?.value || 'buyer_offer';
  const offerDate = document.getElementById('poDate')?.value || null;
  const financing = document.getElementById('poFinancing')?.value || null;
  const presentation = document.getElementById('poPresentation')?.value || 'not_presented';
  const terms = document.getElementById('poTerms')?.value?.trim() || null;
  const contingencies = document.getElementById('poContingencies')?.value?.trim() || null;
  const notes = document.getElementById('poNotes')?.value?.trim() || null;

  if(!partyName){ showErr('Party / buyer name is required.'); return; }
  if(!rawAmount){ showErr('Amount is required.'); return; }
  const amount = parseFloat(rawAmount.replace(/,/g,''));
  if(isNaN(amount) || amount < 0){ showErr('Amount must be a valid number.'); return; }
  hideErr();

  // Capture affected children
  const cbs = document.querySelectorAll('.po-affected-cb');
  const total = cbs.length;
  const checkedIds = [...cbs].filter(cb => cb.checked).map(cb => cb.value);
  // Convention: if all are checked OR none are checked, store NULL (meaning "applies to all").
  // Only store an explicit array when a strict subset is selected.
  const affectedChildIds = (checkedIds.length === total || checkedIds.length === 0) ? null : checkedIds;

  const payload = {
    offer_type:          offerType,
    offer_date:          offerDate || null,
    party_name:          partyName,
    amount:              amount,
    financing_type:      financing || null,
    presentation_status: presentation || 'not_presented',
    terms:               terms,
    contingencies:       contingencies,
    notes:               notes,
    affected_child_ids:  affectedChildIds
  };

  if(btn){ btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    if(_poEditingOfferId){
      await _portfolioOfferUpdate(_poEditingOfferId, payload);
    } else {
      await _portfolioOfferCreate(portfolioId, payload);
    }
    await _portfolioOffersLoad(portfolioId);
    closePortfolioOfferModal();
    const p = (window.allPortfolios || []).find(x => x.id === portfolioId);
    if(p) _renderPortfolioDetail(p);
  } catch(e) {
    showErr('Failed to save: ' + (e.message || 'unknown error'));
    if(btn){ btn.disabled = false; btn.textContent = 'Save Offer'; }
  }
}

export async function _poDeleteFromModal(){
  if(!_poEditingOfferId) return;
  if(!confirm('Delete this offer?\n\nThis will soft-delete the offer — it won\'t appear in the offers list, but the row is kept in the database for audit purposes.')) return;
  try {
    await _portfolioOfferDelete(_poEditingOfferId);
    await _portfolioOffersLoad(_currentPortfolioId);
    closePortfolioOfferModal();
    const p = (window.allPortfolios || []).find(x => x.id === _currentPortfolioId);
    if(p) _renderPortfolioDetail(p);
  } catch(e) {
    alert('Failed to delete: ' + (e.message || 'unknown error'));
  }
}

// ── OFFERS TAB RENDERER ───────────────────────────────────────────
export function _renderPortfolioOffersTab(p, children, fmt$, fmtPct){
  const offers = _currentPortfolioOffers || [];
  const pkgPrice = p['Package Price'] != null ? Number(p['Package Price']) : null;

  // Offer cards
  let offersHtml;
  if(offers.length === 0){
    offersHtml = `
      <div style="background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:40px 20px;text-align:center;">
        <div style="font-size:36px;opacity:0.4;margin-bottom:8px;">💰</div>
        <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:4px;">No portfolio offers yet</div>
        <div style="font-size:11px;color:#94a3b8;line-height:1.6;">
          Offers recorded here apply to the portfolio as a whole, or to a subset of its properties.<br>
          Individual per-property offers still live on each child deal's own Offers tab.
        </div>
      </div>`;
  } else {
    // Child ID → address lookup for the affected list
    const childLookup = {};
    children.forEach(d => { childLookup[d.id] = d['Address'] || 'Unnamed'; });

    offersHtml = offers.map(o => {
      const meta = (_OFFER_TYPE_META[o.offer_type])
                 || { label: o.offer_type, color:'#64748b', bg:'#f1f5f9' };
      const amount = o.amount != null ? fmt$(o.amount) : '—';
      const date = o.offer_date || '—';

      // Affected children display
      let affectedHtml = '';
      if(Array.isArray(o.affected_child_ids) && o.affected_child_ids.length > 0){
        const addrs = o.affected_child_ids.map(id => childLookup[id] || '(unknown)');
        const previewCount = 3;
        const preview = addrs.slice(0, previewCount).join(' · ');
        const more = addrs.length > previewCount ? ` +${addrs.length - previewCount} more` : '';
        affectedHtml = `
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-top:8px;font-size:11px;color:#92400e;">
            <strong style="font-weight:700;">Partial offer</strong> — applies to ${addrs.length} of ${children.length} properties: ${preview}${more}
          </div>`;
      } else {
        affectedHtml = `
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:6px 10px;margin-top:8px;font-size:11px;color:#166534;">
            <strong style="font-weight:700;">Package offer</strong> — applies to all ${children.length} ${children.length === 1 ? 'property' : 'properties'}
          </div>`;
      }

      // vs Package Price / vs Sum comparison
      let comparison = '';
      if(o.amount != null && pkgPrice){
        const delta = Number(o.amount) - pkgPrice;
        const pct = (delta / pkgPrice) * 100;
        const dColor = delta >= 0 ? '#166534' : '#dc2626';
        comparison = ` <span style="font-size:11px;color:${dColor};font-weight:600;">${delta >= 0 ? '+' : ''}${fmt$(Math.abs(delta))} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) vs package</span>`;
      }

      const presentationLabels = {
        not_presented:   { label: 'Not Presented',   color: '#94a3b8' },
        presented_verbal:{ label: 'Presented (Verbal)', color: '#d97706' },
        presented_loi:   { label: 'Presented (LOI)',  color: '#16a34a' }
      };
      const ps = presentationLabels[o.presentation_status] || { label:'—', color:'#94a3b8' };

      return `
        <div onclick="openPortfolioOfferModal('${p.id}', '${o.id}')"
          style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:all 0.15s;"
          onmouseover="this.style.borderColor='#b45309';"
          onmouseout="this.style.borderColor='#e2e8f0';">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;">
              <span style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}55;padding:3px 10px;border-radius:99px;font-size:10px;font-weight:700;white-space:nowrap;">${meta.label}</span>
              <div style="font-size:15px;font-weight:800;color:#0f172a;">${amount}</div>
              ${comparison}
            </div>
            <div style="font-size:11px;color:#64748b;">${date}</div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:#475569;">
            <div><strong style="color:#0f172a;">${(o.party_name || '—').replace(/</g,'&lt;')}</strong></div>
            ${o.financing_type ? `<div style="color:#64748b;">💳 ${o.financing_type}</div>` : ''}
            <div style="color:${ps.color};font-weight:600;">• ${ps.label}</div>
          </div>
          ${o.terms ? `<div style="font-size:11px;color:#64748b;margin-top:6px;line-height:1.5;"><strong style="color:#475569;">Terms:</strong> ${o.terms.replace(/</g,'&lt;')}</div>` : ''}
          ${o.contingencies ? `<div style="font-size:11px;color:#64748b;margin-top:4px;line-height:1.5;"><strong style="color:#475569;">Contingencies:</strong> ${o.contingencies.replace(/</g,'&lt;')}</div>` : ''}
          ${o.notes ? `<div style="font-size:11px;color:#64748b;margin-top:4px;font-style:italic;line-height:1.5;">"${o.notes.replace(/</g,'&lt;')}"</div>` : ''}
          ${affectedHtml}
        </div>`;
    }).join('');
  }

  // Summary stats at the top
  const bestOffer = offers.length > 0 ? offers.reduce((max, o) => {
    const amt = Number(o.amount || 0);
    return amt > (max ? Number(max.amount || 0) : 0) ? o : max;
  }, null) : null;
  const totalOffers = offers.length;
  const packageOffers = offers.filter(o => !Array.isArray(o.affected_child_ids) || o.affected_child_ids.length === 0).length;
  const partialOffers = totalOffers - packageOffers;

  const statsHtml = totalOffers > 0 ? `
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;">
        <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Total Offers</div>
        <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:4px;">${totalOffers}</div>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;">
        <div style="font-size:10px;color:#166534;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Package Offers</div>
        <div style="font-size:22px;font-weight:800;color:#166534;margin-top:4px;">${packageOffers}</div>
      </div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;">
        <div style="font-size:10px;color:#92400e;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Partial Offers</div>
        <div style="font-size:22px;font-weight:800;color:#b45309;margin-top:4px;">${partialOffers}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;">
        <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">Best Offer</div>
        <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:4px;">${bestOffer ? fmt$(bestOffer.amount) : '—'}</div>
      </div>
    </div>` : '';

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <div style="font-size:14px;font-weight:700;color:#0f172a;">💰 Portfolio Offers</div>
      <button onclick="openPortfolioOfferModal('${p.id}')"
        style="background:#b45309;color:#fff;border:none;padding:8px 16px;font-size:12px;font-weight:700;border-radius:6px;cursor:pointer;">
        + New Offer
      </button>
    </div>
    ${statsHtml}
    ${offersHtml}
    <div style="font-size:11px;color:#94a3b8;margin-top:14px;line-height:1.6;text-align:center;">
      Portfolio offers are separate from per-property offers.
      <strong style="color:#475569;">Per-property offers</strong> still live on each child deal's own Offers tab.
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────
// _loadAllPortfolios (originally at index.html:25857, called from boot)
// ─────────────────────────────────────────────────────────────────────
export async function _loadAllPortfolios(){
  if(!isSupabase()) return;
  try {
    const rows = await _sbGet(SB_TABLES.portfolios,
      'select=*&is_archived=eq.false&order=created_at.desc&limit=500');
    window.allPortfolios = (rows || []).map(r => {
      const p = _sbToAt(r, SB_PORTFOLIO_MAP);
      p.id = r.id;
      // Same fallback pattern as allDeals — use date_listed or created_at
      if(!p['Created Time'] && r.created_at) p['Created Time'] = r.created_at;
      return p;
    });
  } catch(e) {
    console.warn('[_loadAllPortfolios] failed:', e.message);
    window.allPortfolios = [];
  }
}
