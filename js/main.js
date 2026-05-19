// main.js — module entry point.
//
// All `import` statements come first, all `window.X = ...` attachments
// come after. Mixing them was causing a runtime ReferenceError on the
// boot path (see v267 fix).

// ─── Schemas ──────────────────────────────────────────────────────────
import {
  SB_TABLES,
  SB_PROP_MAP,
  SB_PORTFOLIO_MAP,
  SB_CONTACT_MAP,
  SB_BC_MAP,
  SB_TASK_MAP,
  SB_NOTIF_MAP,
  SB_MANUAL_COMP_MAP,
  _sbToAt,
  _atToSb,
} from './schemas/index.js';
import * as countyMap from './schemas/county-map.js';

// ─── Utils ────────────────────────────────────────────────────────────
import {
  _stripCommas, _parseNum, _fmtNum, _phoneDigits, fmtMoney, fmtPct,
} from './utils/format.js';
import {
  _normalizeAddr, _addrMatches, cleanAddress, parseAddress,
} from './utils/address.js';

// ─── Core ─────────────────────────────────────────────────────────────
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
import { rtInit, rtMarkSaved, rtUpdateToken, rtDestroy } from './core/realtime.js';

// ─── Design system ────────────────────────────────────────────────────
import * as designSystem    from './design/design-system.js';

// ─── Feature modules ──────────────────────────────────────────────────
import * as workbench       from './workbench/workbench.js';
import * as portfolios      from './portfolios/portfolios.js';
import * as dashboard       from './dashboard/dashboard.js';
import * as geocoding       from './geocoding/google.js';
import * as richText        from './widgets/rich-text.js';
import * as agentPicker     from './widgets/agent-picker.js';
import * as assetCleanup    from './asset-cleanup/asset-cleanup.js';
import * as gmail           from './email/gmail.js';
import * as emailTemplates  from './email/templates.js';
import * as emailLibrary    from './email/library.js';
import * as appLists        from './admin/app-lists.js';
import * as bcTaxonomy      from './admin/bc-taxonomy.js';
import * as bcFields        from './admin/bc-fields.js';
import * as bcNativeFields  from './admin/bc-native-fields.js';
import * as bcAiActivity    from './admin/bc-ai-activity.js';
import * as bcAiSuggestions from './admin/bc-ai-suggestions.js';
import * as backmarket      from './buyer-search/backmarket.js';
import * as fub             from './fub/fub.js';
import * as relationships   from './contacts/relationships.js';
import * as bcMap           from './buyer-criteria/bc-map.js';

// ═══════════════════════════════════════════════════════════════════════
// Window aliases — every export from every feature/widget/schema-helper
// module gets attached to window so legacy bare-name callers (in still-
// in-legacy features and inline onclick handlers) resolve via the global
// env lookup chain.
// ═══════════════════════════════════════════════════════════════════════

// Schema helpers
window._sbToAt = _sbToAt;
window._atToSb = _atToSb;

// Schemas with multiple constants/functions
for (const [name, value] of Object.entries(countyMap))      { window[name] = value; }

// Design system
for (const [name, value] of Object.entries(designSystem))   { window[name] = value; }

// Feature modules
for (const [name, value] of Object.entries(workbench))      { window[name] = value; }
for (const [name, value] of Object.entries(portfolios))     { window[name] = value; }
for (const [name, value] of Object.entries(dashboard))      { window[name] = value; }
for (const [name, value] of Object.entries(geocoding))      { window[name] = value; }
for (const [name, value] of Object.entries(richText))       { window[name] = value; }
for (const [name, value] of Object.entries(agentPicker))    { window[name] = value; }
for (const [name, value] of Object.entries(assetCleanup))   { window[name] = value; }
for (const [name, value] of Object.entries(gmail))          { window[name] = value; }
for (const [name, value] of Object.entries(emailTemplates)) { window[name] = value; }
for (const [name, value] of Object.entries(emailLibrary))   { window[name] = value; }
for (const [name, value] of Object.entries(appLists))       { window[name] = value; }
for (const [name, value] of Object.entries(bcTaxonomy))     { window[name] = value; }
for (const [name, value] of Object.entries(bcFields))       { window[name] = value; }
for (const [name, value] of Object.entries(bcNativeFields)) { window[name] = value; }
for (const [name, value] of Object.entries(bcAiActivity))   { window[name] = value; }
for (const [name, value] of Object.entries(bcAiSuggestions)){ window[name] = value; }
for (const [name, value] of Object.entries(backmarket))     { window[name] = value; }
for (const [name, value] of Object.entries(fub))            { window[name] = value; }
for (const [name, value] of Object.entries(relationships))  { window[name] = value; }
for (const [name, value] of Object.entries(bcMap))          { window[name] = value; }

// Realtime sync — attach to window so legacy _applyUserToUI can call rtInit()
window.rtInit        = rtInit;
window.rtMarkSaved   = rtMarkSaved;
window.rtUpdateToken = rtUpdateToken;
window.rtDestroy     = rtDestroy;

// ─── Smoke-test log ───────────────────────────────────────────────────
console.log('[ace-modules] all modules loaded', {
  // schemas
  tables: Object.keys(SB_TABLES).length,
  prop:   Object.keys(SB_PROP_MAP).length,
  port:   Object.keys(SB_PORTFOLIO_MAP).length,
  cont:   Object.keys(SB_CONTACT_MAP).length,
  bc:     Object.keys(SB_BC_MAP).length,
  task:   Object.keys(SB_TASK_MAP).length,
  notif:  Object.keys(SB_NOTIF_MAP).length,
  comp:   Object.keys(SB_MANUAL_COMP_MAP).length,
  countyMap: Object.keys(countyMap).length,
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
  // design system
  designSystem:   Object.keys(designSystem).length,
  // feature modules — exported symbol counts
  workbench:      Object.keys(workbench).length,
  portfolios:     Object.keys(portfolios).length,
  dashboard:      Object.keys(dashboard).length,
  geocoding:      Object.keys(geocoding).length,
  richText:       Object.keys(richText).length,
  agentPicker:    Object.keys(agentPicker).length,
  assetCleanup:   Object.keys(assetCleanup).length,
  gmail:          Object.keys(gmail).length,
  emailTemplates: Object.keys(emailTemplates).length,
  emailLibrary:   Object.keys(emailLibrary).length,
  appLists:       Object.keys(appLists).length,
  bcTaxonomy:     Object.keys(bcTaxonomy).length,
  bcFields:       Object.keys(bcFields).length,
  bcNativeFields: Object.keys(bcNativeFields).length,
  bcAiActivity:   Object.keys(bcAiActivity).length,
  backmarket:     Object.keys(backmarket).length,
  fub:            Object.keys(fub).length,
  relationships:  Object.keys(relationships).length,
  bcMap:          Object.keys(bcMap).length,
});
