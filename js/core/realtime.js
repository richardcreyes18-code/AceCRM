// js/core/realtime.js — Cross-user live sync via Supabase Realtime postgres_changes.
// Subscribes to 8 tables; routes incoming events into the existing BroadcastChannel
// handler pattern (_aceSyncHandleDealPatch etc.) so same-browser + cross-user
// updates share the same rendering path.
import { SB_ANON_KEY } from './proxy.js';
import { getConfig } from './config.js';

let _rtClient = null;
const _recentlySaved = new Map(); // `${table}:${id}` → expiry timestamp (ms)

export function rtInit() {
  const cfg = getConfig();
  const token = window._authToken;
  if (!cfg.url || !token) {
    console.warn('[realtime] cannot init — missing config or auth token');
    return;
  }
  if (!window.supabase) {
    console.warn('[realtime] Supabase JS client not loaded — real-time sync disabled');
    return;
  }

  if (_rtClient) { _rtClient.removeAllChannels(); _rtClient = null; }

  _rtClient = window.supabase.createClient(cfg.url, SB_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  _rtClient.realtime.setAuth(token);

  const subs = [
    ['ace_properties',     _onPropertyChange],
    ['ace_buyer_criteria', _onBuyerCriteriaChange],
    ['ace_contacts',       _onContactChange],
    ['ace_deal_offers',    _onOfferChange],
    ['ace_tasks',          _onTaskChange],
    ['ace_documents',      _onDocumentChange],
    ['ace_portfolios',     _onPortfolioChange],
    ['ace_ai_settings',    _onAiSettingsChange],
  ];

  for (const [table, handler] of subs) {
    _rtClient
      .channel(`rt_${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, handler)
      .subscribe(status => {
        if (status === 'SUBSCRIBED') console.log(`[realtime] ✓ ${table}`);
        else if (status === 'CHANNEL_ERROR') console.warn(`[realtime] ✗ ${table}`, status);
      });
  }
}

// Call after any successful _sbPatch/_sbPost/_sbDelete to suppress the echo
// of the saving user's own change when it arrives back via Realtime (~1s later).
export function rtMarkSaved(table, id) {
  if (id) _recentlySaved.set(`${table}:${id}`, Date.now() + 4000);
}

// Call when the auth token is refreshed so the Realtime connection stays authenticated.
export function rtUpdateToken(newToken) {
  if (_rtClient && newToken) _rtClient.realtime.setAuth(newToken);
}

export function rtDestroy() {
  if (_rtClient) { _rtClient.removeAllChannels(); _rtClient = null; }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _isSelf(table, id) {
  const key = `${table}:${id}`;
  const exp = _recentlySaved.get(key);
  if (!exp) return false;
  if (Date.now() > exp) { _recentlySaved.delete(key); return false; }
  return true;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function _onPropertyChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_properties', id)) return;

  if (eventType === 'DELETE') {
    if (Array.isArray(window.allDeals)) {
      window.allDeals = window.allDeals.filter(d => d.id !== id);
      if (typeof window.buildSidebar === 'function') window.buildSidebar();
    }
    return;
  }

  // Translate snake_case DB columns → AT/camelCase field names, then
  // feed into the existing handler which patches allDeals + re-renders
  // sidebar/board without touching the detail form inputs.
  const fields = _invertMap(row, window.SB_PROP_MAP);
  if (typeof window._aceSyncHandleDealPatch === 'function') {
    window._aceSyncHandleDealPatch({ dealId: id, fields });
  }
}

function _onBuyerCriteriaChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_buyer_criteria', id)) return;

  const list = window.allBuyerCriteria;
  if (!Array.isArray(list)) return;

  if (eventType === 'DELETE') {
    const idx = list.findIndex(x => x.id === id);
    if (idx !== -1) list.splice(idx, 1);
  } else {
    const existing = list.find(x => x.id === id);
    if (existing) Object.assign(existing, row);
    else list.unshift(row);
  }

  if (document.getElementById('bcTableWrap') && typeof window.renderBuyerCriteriaTable === 'function') {
    window.renderBuyerCriteriaTable(list);
  }
}

function _onContactChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_contacts', id)) return;

  const list = window.allContacts;
  if (!Array.isArray(list)) return;

  if (eventType === 'DELETE') {
    const idx = list.findIndex(x => x.id === id);
    if (idx !== -1) list.splice(idx, 1);
  } else {
    const existing = list.find(x => x.id === id);
    if (existing) {
      Object.assign(existing, row);
      // Keep the legacy {id, fields:{Name,...}} shape in sync so
      // showContactDetailPage reads the right name on next open.
      if (!existing.fields) existing.fields = {};
      if (row.name        !== undefined) existing.fields['Name']                    = row.name;
      if (row.phone_number!== undefined) existing.fields['Phone Number']            = row.phone_number;
      if (row.secondary_phone!==undefined) existing.fields['Secondary Phone Number']= row.secondary_phone;
      if (row.email       !== undefined) existing.fields['Email']                   = row.email;
      if (row.company     !== undefined) existing.fields['Company']                 = row.company;
      if (row.contact_notes!==undefined) existing.fields['Contact Notes']           = row.contact_notes;
      if (row.type        !== undefined) existing.fields['Type']                    = row.type;
    } else {
      list.unshift(row);
    }
  }

  if (document.getElementById('contactsTableWrap') && typeof window.renderContactsTable === 'function') {
    window.renderContactsTable(list);
  }
}

function _onOfferChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_deal_offers', id)) return;

  const dealId = row?.deal_id || old?.deal_id;
  if (!dealId) return;
  if (window.currentDeal?.id === dealId && typeof window.loadOffersTab === 'function') {
    window.loadOffersTab(dealId);
  }
}

function _onTaskChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_tasks', id)) return;

  const dealId = row?.property_id || old?.property_id;
  if (!dealId) return;
  if (window.currentDeal?.id === dealId && typeof window._loadAndRenderDealTasks === 'function') {
    window._loadAndRenderDealTasks(dealId, window.currentDeal?.['Address']);
  }
}

function _onDocumentChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_documents', id)) return;

  const dealId = row?.property_id || old?.property_id;
  if (!dealId) return;
  if (window.currentDeal?.id === dealId && typeof window.loadPropertyDocs === 'function') {
    window.loadPropertyDocs(dealId);
  }
}

function _onPortfolioChange({ eventType, new: row, old }) {
  const id = row?.id || old?.id;
  if (!id || _isSelf('ace_portfolios', id)) return;

  const list = window.allPortfolios;
  if (!Array.isArray(list)) return;

  if (eventType === 'DELETE') {
    const idx = list.findIndex(x => x.id === id);
    if (idx !== -1) list.splice(idx, 1);
  } else {
    const existing = list.find(x => x.id === id);
    if (existing) Object.assign(existing, row);
    else list.unshift(row);
  }

  if (typeof window._aceSyncPost === 'function') {
    window._aceSyncPost('portfolio.changed', { portfolioId: id });
  }
}

function _onAiSettingsChange() {
  if (typeof window._aceSyncPost === 'function') {
    window._aceSyncPost('bc.taxonomy.changed', {});
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _invertMap(row, propMap) {
  if (!propMap || !row) return { ...row };
  const inv = {};
  for (const [atKey, sbKey] of Object.entries(propMap)) inv[sbKey] = atKey;
  const out = {};
  for (const [col, val] of Object.entries(row)) out[inv[col] || col] = val;
  return out;
}
