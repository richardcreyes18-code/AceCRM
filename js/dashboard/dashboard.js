// dashboard/dashboard.js — landing page (stats / goals / top tasks) + welcome
// empty-state. Replaces the legacy welcome screen.
//
// Phase 4a (parallel module): the legacy block in index.html (~2678–3191)
// still owns runtime; this module is dead code. Phase 4b deletes the
// legacy block and attaches these exports as window.* aliases. Snooze
// functions (~3207–3290) intentionally NOT migrated — they're deal-level
// concerns and will move with the deals feature later.
//
// External dependencies on window.* / bare-name access (legacy script
// owns these):
//   state:    window._currentUser, window.allDeals, window.allBuyerCriteria,
//             window.allBuyerContacts, window._store
//   functions: window.openDeal, window.setNav, window.openConfig,
//              window.isSupabase, window._agentHas, window._agentPgFilter,
//              window._dealAssetType, window.getStage, window.fmtMoney
//   (function declarations in classic <script> auto-attach to window;
//    bare-name lookups from this module resolve through the global env.)

import { _sbGet, _sbPatch } from '../core/supabase.js';
import { showSaveConfirm } from '../core/toast.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

// ═══════════════════════════════════════════════════════════════════════
// LEGACY BLOCK BELOW — copied from index.html with `export` added to every
// top-level function/const and external `let`/`const` script-scope refs
// prefixed with `window.` for clarity. Internal logic is byte-identical.
// ═══════════════════════════════════════════════════════════════════════

// ─── DASHBOARD ────────────────────────────────────────────────
// Home page: stats, goals, top tasks. Replaces the old welcome screen as
// the default landing page. Pulls data from window.allDeals (for pipeline stats)
// and ace_tasks (for the task widget).

// Stage buckets — which pipeline_stage values count as each category
export const DASHBOARD_STAGE_BUCKETS = {
  // v111.5: "New Lead" is the default stage for seller leads created via the
  // Lead Intake form (line ~27490). It was missing from this bucket, causing
  // the dashboard's "New Seller Leads" cards to always show 0 even when agents
  // had active intake activity.
  leads:         ['New Lead','Lead','Top G Review','Attempted Contact','GHL'],
  active:        ['Market Price Active','Active Listing','Lease Listing'],
  hot:           ['Hot Active Listing'],
  underContract: ['Under Contract','In Negotiations','Attorney Review'],
  closed:        ['Closed','Closed 2025','Closed 2026'],
};

// Default goals. These are stored in localStorage as a JSON blob under
// 'dashboard_goals'. Per-browser not per-user — when multi-user auth lands
// we'll migrate these to a Supabase user_settings table.
export const DEFAULT_LEAD_GOALS = { today: 3, week: 15, month: 60 };

export function _dashGetLeadGoals(){
  try {
    const raw = window._store.get('dashboard_lead_goals');
    if(raw) return { ...DEFAULT_LEAD_GOALS, ...JSON.parse(raw) };
  } catch(e) {}
  return { ...DEFAULT_LEAD_GOALS };
}

export function _dashSetLeadGoal(period, value){
  const goals = _dashGetLeadGoals();
  goals[period] = Math.max(0, Number(value)||0);
  window._store.set('dashboard_lead_goals', JSON.stringify(goals));
}

export function _dashGetAgentGoals(){
  try {
    const raw = window._store.get('dashboard_agent_goals');
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed)) return parsed;
    }
  } catch(e) {}
  return ['','','','',''];
}

export function _dashSetAgentGoals(goals){
  window._store.set('dashboard_agent_goals', JSON.stringify(goals));
}

// Count deals created within a time window, using the Date Added field
// (mapped from created_at in _sbToAt).
//
// v111.8 bug fix: the Date Added field is a 'YYYY-MM-DD' date-only string
// when it came from the `date_added` column (which is a Postgres DATE, no
// time component). `new Date('2026-04-17')` parses as *UTC* midnight —
// which in NJ (UTC-4/5) lands 4-5 hours before local midnight, so a lead
// created "today" in local time appears to fall into "yesterday" here and
// the TODAY counter reports 0. Parse date-only strings as local midnight
// explicitly so the window comparison works in the user's timezone.
export function _dashParseDealDate(val){
  if(!val) return null;
  const s = String(val);
  // Match a pure YYYY-MM-DD date (no T, no time component) → parse as local
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if(m){
    return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  }
  // Full ISO timestamp — default parse is correct (UTC → local conversion built in)
  const t = new Date(s);
  return isNaN(t) ? null : t;
}

export function _dashCountLeadsInWindow(deals, sinceDate){
  let n = 0;
  for(const d of deals){
    const created = d['Date Added'];
    if(!created) continue;
    const t = _dashParseDealDate(created);
    if(t && t >= sinceDate) n++;
  }
  return n;
}

// Get the start of today, this week (Monday), and this month
export function _dashWindowStarts(){
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekDay = today.getDay(); // 0 = Sunday
  // ISO week: Monday start
  const mondayOffset = weekDay === 0 ? -6 : 1 - weekDay;
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() + mondayOffset);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return { today, weekStart, monthStart };
}

// Sum up "value" of a deal list (Asking Price) and format
export function _dashSumValue(deals){
  return deals.reduce((sum,d) => sum + (Number(d['Asking Price'])||0), 0);
}

export function _dashFmtMoney(n){
  if(!n || isNaN(n)) return '$0';
  if(n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if(n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
  if(n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
  return '$' + Math.round(n).toLocaleString();
}

export function showDashboard(){
  const goals = _dashGetLeadGoals();
  const { today, weekStart, monthStart } = _dashWindowStarts();

  // Scope all stats to the logged-in agent. If no _currentUser (e.g. pre-login
  // or admin without fub_name), fall back to all deals.
  const agentName = (typeof _currentUser !== 'undefined' && _currentUser && _currentUser.fub_name) || null;
  const myDeals = agentName
    ? window.allDeals.filter(d => _agentHas(d['Assigned Agent'], agentName) && !d['Is Archived'])
    : window.allDeals.filter(d => !d['Is Archived']);

  // Lead counts (scoped to my deals)
  const leadDeals = myDeals.filter(d => DASHBOARD_STAGE_BUCKETS.leads.includes(getStage(d)));
  const todayLeads = _dashCountLeadsInWindow(leadDeals, today);
  const weekLeads  = _dashCountLeadsInWindow(leadDeals, weekStart);
  const monthLeads = _dashCountLeadsInWindow(leadDeals, monthStart);

  // Pipeline buckets (scoped)
  const active        = myDeals.filter(d => DASHBOARD_STAGE_BUCKETS.active.includes(getStage(d)));
  const hot           = myDeals.filter(d => DASHBOARD_STAGE_BUCKETS.hot.includes(getStage(d)));
  const underContract = myDeals.filter(d => DASHBOARD_STAGE_BUCKETS.underContract.includes(getStage(d)));
  const closed        = myDeals.filter(d => DASHBOARD_STAGE_BUCKETS.closed.includes(getStage(d)));
  const newLeadBucket = myDeals.filter(d => DASHBOARD_STAGE_BUCKETS.leads.includes(getStage(d)));

  // My starred deals (Top Priority) — for the "My Top Deals" section
  const myStarred = myDeals.filter(d => d['Top Priority']);

  // First name for the welcome message
  const firstName = agentName
    ? (_currentUser.name || agentName).split(' ')[0]
    : 'there';

  const activeVal = _dashSumValue(active);
  const hotVal    = _dashSumValue(hot);
  const newLeadVal= _dashSumValue(newLeadBucket);

  // Build a goal-aware lead stat card. Red bg if count < goal, green if >= goal.
  const leadCard = (label, count, goalKey) => {
    const goal = goals[goalKey];
    const hit = count >= goal;
    const bg = hit ? '#f0fdf4' : '#fef2f2';
    const border = hit ? '#86efac' : '#fca5a5';
    const countColor = hit ? '#166534' : '#b91c1c';
    const goalText = hit ? `✓ Goal: ${goal}` : `Goal: ${goal} — ${goal-count} to go`;
    return `
      <div onclick="_dashEditLeadGoal('${goalKey}')" style="
        flex:1;min-width:180px;background:${bg};border:2px solid ${border};
        border-radius:12px;padding:18px 20px;cursor:pointer;transition:transform .15s;"
        onmouseenter="this.style.transform='translateY(-2px)'"
        onmouseleave="this.style.transform=''">
        <div style="font-size:11px;font-weight:700;color:${countColor};text-transform:uppercase;letter-spacing:.06em;">${label}</div>
        <div style="font-size:34px;font-weight:800;color:${countColor};line-height:1.1;margin:6px 0 4px;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;">${count}</div>
        <div style="font-size:11px;color:${countColor};font-weight:600;">${goalText}</div>
        <div style="font-size:9px;color:#94a3b8;margin-top:4px;">Click to edit goal</div>
      </div>`;
  };

  // v102.17: Buyer Leads count card — count-only, no goal coloring.
  // Renders with "—" placeholder; the async _dashLoadBuyerLeadCounts() call
  // below populates the actual numbers shortly after the dashboard appears.
  const buyerCountCard = (label, elId) => `
    <div style="
      flex:1;min-width:180px;background:#f0f9ff;border:2px solid #bae6fd;
      border-radius:12px;padding:18px 20px;">
      <div style="font-size:11px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;">${label}</div>
      <div id="${elId}" style="font-size:34px;font-weight:800;color:#0369a1;line-height:1.1;margin:6px 0 4px;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;">—</div>
      <div style="font-size:11px;color:#0369a1;font-weight:600;">Buyer leads entered</div>
    </div>`;

  // Build a simple value/count tile for pipeline stats
  const statTile = (label, value, sublabel, color) => `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
      <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">${label}</div>
      <div style="font-size:28px;font-weight:800;color:${color};line-height:1.1;margin-top:4px;font-family:'Source Code Pro',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;">${value}</div>
      ${sublabel ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${sublabel}</div>` : ''}
    </div>`;

  // Agent goals section
  const agentGoals = _dashGetAgentGoals();
  const goalInputs = agentGoals.map((g,i) => `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="width:24px;height:24px;border-radius:50%;background:#1e3a8a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${i+1}</div>
      <input type="text" placeholder="Top goal #${i+1}..." value="${(g||'').replace(/"/g,'&quot;')}"
        oninput="_dashSaveAgentGoal(${i}, this.value)"
        style="flex:1;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;"/>
    </div>`).join('');

  document.getElementById('mainArea').innerHTML = `
    <div style="padding:24px 28px;">

      <!-- HEADER -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;">
        <div>
          <div style="font-size:22px;font-weight:800;color:#0f172a;">📊 Dashboard</div>
          <div style="font-size:13px;color:#64748b;margin-top:2px;">Welcome back, ${firstName} — here's your pipeline at a glance.</div>
        </div>
        <div style="font-size:11px;color:#94a3b8;text-align:right;">
          ${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
          ${agentName ? `<div style="font-size:10px;color:#64748b;margin-top:2px;">Showing stats for <strong>${agentName}</strong></div>` : `<div style="font-size:10px;color:#dc2626;margin-top:2px;">Not signed in — showing all deals</div>`}
        </div>
      </div>

      <!-- LEAD STATS -->
      <div style="margin-bottom:28px;">
        <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">New Seller Leads</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${leadCard('Today', todayLeads, 'today')}
          ${leadCard('This Week', weekLeads, 'week')}
          ${leadCard('This Month', monthLeads, 'month')}
        </div>
      </div>

      <!-- v102.17: BUYER LEADS — count-only, no goals -->
      <div style="margin-bottom:28px;">
        <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">New Buyer Leads</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${buyerCountCard('Today',     'dashBuyerToday')}
          ${buyerCountCard('This Week', 'dashBuyerWeek')}
          ${buyerCountCard('This Month','dashBuyerMonth')}
        </div>
      </div>

      <!-- PIPELINE STATS -->
      <div style="margin-bottom:28px;">
        <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">Pipeline Value</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:12px;">
          ${statTile('Active Deal Value', _dashFmtMoney(activeVal), `${active.length} deal${active.length===1?'':'s'}`, '#15803d')}
          ${statTile('Hot Deal Value',    _dashFmtMoney(hotVal),    `${hot.length} deal${hot.length===1?'':'s'}`, '#dc2626')}
          ${statTile('New Lead Value',    _dashFmtMoney(newLeadVal),`${newLeadBucket.length} deal${newLeadBucket.length===1?'':'s'}`, '#1e40af')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
          ${statTile('# Hot Deals',          hot.length,           'Hot Active Listing', '#dc2626')}
          ${statTile('# Active Deals',       active.length,        'Market / Active / Lease', '#15803d')}
          ${statTile('# Under Contract',     underContract.length, 'Contract / Negotiations / Attorney', '#7c3aed')}
          ${statTile('# Closed Deals',       closed.length,        '2025 + 2026 + Closed', '#166534')}
        </div>
      </div>

      <!-- MY TOP DEALS (starred) -->
      <div style="margin-bottom:28px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">⭐ My Top Deals</div>
          <div style="font-size:11px;color:#94a3b8;">${myStarred.length} starred</div>
        </div>
        ${myStarred.length === 0 ? `
          <div style="background:#fff;border:1px dashed #e2e8f0;border-radius:12px;padding:30px;text-align:center;">
            <div style="font-size:13px;color:#94a3b8;font-style:italic;">
              No starred deals yet. Click the ⭐ on any deal to add it here.
            </div>
          </div>
        ` : `
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
            ${myStarred.map(d => {
              const stage = getStage(d);
              const stageColor = NEW_PIPELINE_COLORS[stage] || '#64748b';
              const type = _dealAssetType(d) || '—';
              const addr = d['Address'] || 'Unnamed Deal';
              const price = d['Asking Price'] ? _dashFmtMoney(Number(d['Asking Price'])) : '—';
              const county = d['Simple County'] || '';
              return `
                <div onclick="_dashOpenDeal('${d.id}')" style="
                  background:#fff;border:1px solid #e2e8f0;border-left:4px solid ${stageColor};
                  border-radius:10px;padding:14px 16px;cursor:pointer;
                  box-shadow:0 1px 2px rgba(0,0,0,0.03);transition:transform .15s,box-shadow .15s;"
                  onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.08)'"
                  onmouseleave="this.style.transform='';this.style.boxShadow='0 1px 2px rgba(0,0,0,0.03)'">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
                    <div style="font-size:13px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${addr.replace(/</g,'&lt;')}</div>
                    <span style="font-size:14px;flex-shrink:0;">⭐</span>
                  </div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
                    <span style="background:${stageColor};color:#fff;font-size:9px;font-weight:700;padding:2px 8px;border-radius:99px;">${stage}</span>
                    <span style="background:#f1f5f9;color:#475569;font-size:9px;font-weight:600;padding:2px 8px;border-radius:99px;">${type}</span>
                  </div>
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <div style="font-size:16px;font-weight:800;color:#15803d;">${price}</div>
                    <div style="font-size:10px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${county}</div>
                  </div>
                </div>`;
            }).join('')}
          </div>
        `}
      </div>

      <!-- BOTTOM ROW: Goals + Tasks -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">

        <!-- AGENT GOALS -->
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div>
              <div style="font-size:14px;font-weight:700;color:#0f172a;">🎯 Your Top Goals</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:2px;">Your 5 most important goals. Auto-saves as you type.</div>
            </div>
          </div>
          ${goalInputs}
        </div>

        <!-- TOP TASKS -->
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div>
              <div style="font-size:14px;font-weight:700;color:#0f172a;">✅ Top Priority Tasks</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:2px;">Your most urgent open tasks.</div>
            </div>
            <button onclick="setNav(document.querySelector('[onclick*=tasks-nav]'),'tasks-nav')"
              style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">
              View All →
            </button>
          </div>
          <div id="dashTasksList" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px;font-style:italic;">
            Loading tasks...
          </div>
        </div>

      </div>

      <div style="text-align:center;font-size:10px;color:#cbd5e1;margin-top:24px;padding-top:16px;border-top:1px solid #f1f5f9;">
        Stats refresh automatically from your pipeline. Goals and top tasks save to your browser.
      </div>
    </div>`;

  // Lazy-load tasks async so the main dashboard renders immediately
  _dashLoadTasks();
  // v102.17: lazy-load buyer lead counts scoped to current agent
  _dashLoadBuyerLeadCounts();

  // v102.19: install one-time listener for crm:lead-created so the dashboard
  // auto-refreshes when a new seller or buyer lead is submitted from anywhere
  // in the app. The flag prevents double-binding across multiple showDashboard
  // calls. The listener checks _dashIsVisible() before re-rendering so it's a
  // no-op when the user is on a different tab — the next visit will pick up
  // fresh data via the normal showDashboard flow anyway.
  if(!window._dashLeadListenerInstalled){
    window.addEventListener('crm:lead-created', () => {
      if(_dashIsVisible()){
        showDashboard();
      }
    });
    window._dashLeadListenerInstalled = true;
  }
}

// v102.19: Returns true if the dashboard is currently the visible tab.
// Used by the crm:lead-created listener to decide whether to re-render.
export function _dashIsVisible(){
  // The dashboard renders into #mainArea. We detect it by looking for the
  // characteristic "📊 Dashboard" header that showDashboard always emits.
  const main = document.getElementById('mainArea');
  if(!main) return false;
  return main.innerHTML.includes('📊 Dashboard') && main.innerHTML.includes('New Seller Leads');
}

// v102.17: Fetch buyer lead counts for the current agent in three date windows.
// Uses lightweight Postgrest count queries (HEAD + Prefer: count=exact) instead
// of pulling the full rows. Called after the dashboard renders. If the user
// isn't signed in or has no fub_name, all three counts are left as "—".
export async function _dashLoadBuyerLeadCounts(){
  const todayEl = document.getElementById('dashBuyerToday');
  const weekEl  = document.getElementById('dashBuyerWeek');
  const monthEl = document.getElementById('dashBuyerMonth');
  if(!todayEl || !weekEl || !monthEl) return; // dashboard left the screen
  const agentName = (typeof _currentUser !== 'undefined' && _currentUser && _currentUser.fub_name) || null;
  if(!agentName){
    todayEl.textContent = '0';
    weekEl.textContent  = '0';
    monthEl.textContent = '0';
    return;
  }
  try {
    const { today, weekStart, monthStart } = _dashWindowStarts();
    const iso = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString();
    const cfg = getConfig();
    if(!isSupabase() || !cfg.url || !cfg.key) return;
    const agentPg = _agentPgFilter(agentName, 'fub_assigned_to');
    const fetchCount = async (sinceIso) => {
      const url = `${cfg.url}/rest/v1/${SB_TABLES.buyerCriteria}?${agentPg}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`;
      const res = await fetch(url, {
        method: 'HEAD',
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
          'Prefer': 'count=exact',
          'Range-Unit': 'items',
          'Range': '0-0'
        }
      });
      if(!res.ok) return 0;
      const range = res.headers.get('content-range') || '';
      // content-range is "0-0/N" or "*/N"
      const m = range.match(/\/(\d+)$/);
      return m ? Number(m[1]) : 0;
    };
    const [tCnt, wCnt, mCnt] = await Promise.all([
      fetchCount(iso(today)),
      fetchCount(iso(weekStart)),
      fetchCount(iso(monthStart))
    ]);
    if(todayEl) todayEl.textContent = String(tCnt);
    if(weekEl)  weekEl.textContent  = String(wCnt);
    if(monthEl) monthEl.textContent = String(mCnt);
  } catch(e){
    console.warn('[dashboard] buyer lead count fetch failed:', e.message);
    if(todayEl) todayEl.textContent = '?';
    if(weekEl)  weekEl.textContent  = '?';
    if(monthEl) monthEl.textContent = '?';
  }
}

export async function _dashLoadTasks(){
  const container = document.getElementById('dashTasksList');
  if(!container) return;
  try {
    // Fetch top 5 open tasks for the CURRENT USER only
    // (everyone sees only their own tasks, regardless of My Deals / All Deals view)
    const userId = _currentUser && _currentUser.id;
    if(!userId){
      container.innerHTML = `<div style="text-align:center;color:#94a3b8;font-size:12px;">Sign in to see your tasks.</div>`;
      return;
    }
    const rows = await _sbGet(SB_TABLES.tasks,
      `status=neq.Done&created_by_user_id=eq.${userId}&order=priority.desc,due_date.asc.nullslast&limit=5`);
    if(!rows || !rows.length){
      container.innerHTML = `
        <div style="text-align:center;color:#94a3b8;font-size:12px;">
          No open tasks yet.<br>
          <button onclick="setNav(document.querySelector('[onclick*=tasks-nav]'),'tasks-nav')"
            style="margin-top:10px;background:#1e3a8a;color:#fff;border:none;padding:6px 14px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">
            + Add Task
          </button>
        </div>`;
      return;
    }
    container.style.display = 'block';
    container.style.minHeight = '';
    container.innerHTML = rows.map(t => {
      const due = t.due_date ? new Date(t.due_date) : null;
      const overdue = due && due < new Date() && due.toDateString() !== new Date().toDateString();
      const dueText = due ? due.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—';
      const priority = t.priority || 'Normal';
      const priColor = priority === 'High' ? '#dc2626' : priority === 'Low' ? '#94a3b8' : '#f59e0b';
      return `
        <div style="padding:10px 0;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:10px;">
          <div style="width:6px;height:6px;border-radius:50%;background:${priColor};flex-shrink:0;"></div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(t.task||'(untitled)').replace(/</g,'&lt;')}</div>
            <div style="font-size:10px;color:#64748b;margin-top:2px;">${priority} priority${due?' · Due '+dueText:''}${overdue?' <span style="color:#dc2626;font-weight:700;">OVERDUE</span>':''}</div>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:#dc2626;font-size:11px;">Couldn't load tasks: ${e.message}</div>`;
  }
}

// Edit the goal for a given lead period (today/week/month)
export function _dashEditLeadGoal(period){
  const goals = _dashGetLeadGoals();
  const current = goals[period];
  const label = period === 'today' ? 'today' : period === 'week' ? 'this week' : 'this month';
  const val = prompt(`Set your lead goal for ${label}:`, current);
  if(val === null) return; // cancelled
  const num = Number(val);
  if(isNaN(num) || num < 0){ alert('Please enter a non-negative number.'); return; }
  _dashSetLeadGoal(period, num);
  showDashboard(); // re-render with new goal
}

// Auto-save agent goal text as they type (debounced via next call)
export function _dashSaveAgentGoal(index, value){
  const goals = _dashGetAgentGoals();
  while(goals.length <= index) goals.push('');
  goals[index] = value;
  _dashSetAgentGoals(goals);
}

// Open a deal from the "My Top Deals" section — switches to the Deals tab
// and opens the specified deal, same behavior as clicking in the sidebar.
export function _dashOpenDeal(dealId){
  const deal = window.allDeals.find(d => d.id === dealId);
  if(!deal) return;
  // Activate the "Deals" nav button (second in the bar) and open the deal
  const navButtons = document.querySelectorAll('.nav-btn');
  navButtons.forEach(b => b.classList.remove('active'));
  const dealsBtn = [...navButtons].find(b => b.textContent.trim() === 'Deals');
  if(dealsBtn) dealsBtn.classList.add('active');
  openDeal(deal);
}

export function showHomeEmpty(){
  document.getElementById('mainArea').innerHTML=`
    <div class="center-msg">
      <div style="font-size:22px;font-weight:bold;color:#1a3a6e;">Welcome to Ace Acquisitions CRM</div>
      <div style="font-size:12px;color:#555;max-width:360px;text-align:center;">
        Connect your Supabase database to load your deal pipeline, or click "Add New Deal" to get started.
      </div>
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="action-btn green-btn" onclick="openConfig()">⚙ Connect Supabase</button>
        <button class="action-btn" onclick="setNav(null,'leadintake')">+ Add New Deal</button>
      </div>
    </div>`;
}
