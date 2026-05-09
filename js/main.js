// main.js — module entry point.
//
// Phase 2 + 3: smoke-test imports. The schemas, utils, and core helpers are
// loaded here so the browser confirms every path resolves and every file
// parses cleanly. The legacy <script> in index.html still owns runtime;
// nothing here is consumed by it yet. As features migrate in Phase 4+, they
// import directly from these modules and the duplicate const declarations
// in the legacy script get deleted.

import {
  SB_TABLES,
  SB_PROP_MAP,
  SB_PORTFOLIO_MAP,
  SB_CONTACT_MAP,
  SB_BC_MAP,
  SB_TASK_MAP,
  SB_NOTIF_MAP,
  SB_MANUAL_COMP_MAP,
} from './schemas/index.js';

import {
  _stripCommas, _parseNum, _fmtNum, _phoneDigits, fmtMoney, fmtPct,
} from './utils/format.js';

import {
  _normalizeAddr, _addrMatches, cleanAddress, parseAddress,
} from './utils/address.js';

// Phase 3: core layer
import { _proxyCall, PROXY_URL, SB_AUTH_URL, SB_ANON_KEY } from './core/proxy.js';
import { getConfig } from './core/config.js';
import {
  _sbHeaders, _sbGet, _sbPatch, _sbPost, _sbDelete, _sbRpc,
  _sbUpload, _sbStorageDelete, _sbPublicUrl, _sanitizeFilename,
} from './core/supabase.js';
import {
  SESSION_VERSION,
  _saveSession, _clearSession, _loadSession,
  _parseJwtPayload, _isTokenExpiring, _refreshAccessToken, _signIn,
} from './core/auth.js';
import { _showToast, showSaveConfirm } from './core/toast.js';

// Phase 4: feature modules. Each phase-4 module gets every export attached
// to window so inline onclick handlers in rendered HTML resolve. Modules are
// imported in topological order so any cross-module references (none today)
// resolve at execution time.
import * as workbench from './workbench/workbench.js';
import * as portfolios from './portfolios/portfolios.js';
import * as dashboard from './dashboard/dashboard.js';
for (const [name, value] of Object.entries(workbench))  { window[name] = value; }
for (const [name, value] of Object.entries(portfolios)) { window[name] = value; }
// Phase 4a-dashboard: parallel only — legacy block still owns runtime.
// Cutover commit attaches dashboard exports to window.

// Sanity log so we can confirm in DevTools that the module graph loaded.
// Counts confirm the schema data extraction is byte-complete.
console.log('[ace-modules] schemas + utils + core loaded', {
  // schemas
  tables: Object.keys(SB_TABLES).length,
  prop:   Object.keys(SB_PROP_MAP).length,
  port:   Object.keys(SB_PORTFOLIO_MAP).length,
  cont:   Object.keys(SB_CONTACT_MAP).length,
  bc:     Object.keys(SB_BC_MAP).length,
  task:   Object.keys(SB_TASK_MAP).length,
  notif:  Object.keys(SB_NOTIF_MAP).length,
  comp:   Object.keys(SB_MANUAL_COMP_MAP).length,
  // utils
  utils:  [_stripCommas, _parseNum, _fmtNum, _phoneDigits, fmtMoney, fmtPct,
           _normalizeAddr, _addrMatches, cleanAddress, parseAddress].length,
  // core
  core:   [_proxyCall, getConfig, _sbHeaders, _sbGet, _sbPatch, _sbPost,
           _sbDelete, _sbRpc, _sbUpload, _sbStorageDelete, _sbPublicUrl,
           _sanitizeFilename, _saveSession, _clearSession, _loadSession,
           _parseJwtPayload, _isTokenExpiring, _refreshAccessToken, _signIn,
           _showToast, showSaveConfirm].length,
  sessionVersion: SESSION_VERSION,
  proxyUrl: PROXY_URL.endsWith('/crm-proxy'),
  config:  getConfig().isConnected,
  // feature modules — exported symbol counts
  workbench: Object.keys(workbench).length,
  portfolios: Object.keys(portfolios).length,
  dashboard: Object.keys(dashboard).length,
});
