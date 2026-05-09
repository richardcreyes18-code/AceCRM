// main.js — module entry point.
//
// Phase 2: smoke-test imports. The schemas + utils are loaded here so the
// browser confirms every path resolves and every file parses cleanly.
// The legacy <script> in index.html still owns runtime behavior; nothing
// here is consumed by it yet. As features migrate in Phase 4+, they will
// import directly from js/schemas/* and js/utils/* and the duplicate
// const declarations in the legacy script will be deleted.

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
  _stripCommas,
  _parseNum,
  _fmtNum,
  _phoneDigits,
  fmtMoney,
  fmtPct,
} from './utils/format.js';

import {
  _normalizeAddr,
  _addrMatches,
  cleanAddress,
  parseAddress,
} from './utils/address.js';

// Sanity log so we can confirm in DevTools that the module graph loaded.
// Counts the field maps to make sure the data extraction is byte-complete.
console.log('[ace-modules] schemas + utils loaded', {
  tables: Object.keys(SB_TABLES).length,
  prop:   Object.keys(SB_PROP_MAP).length,
  port:   Object.keys(SB_PORTFOLIO_MAP).length,
  cont:   Object.keys(SB_CONTACT_MAP).length,
  bc:     Object.keys(SB_BC_MAP).length,
  task:   Object.keys(SB_TASK_MAP).length,
  notif:  Object.keys(SB_NOTIF_MAP).length,
  comp:   Object.keys(SB_MANUAL_COMP_MAP).length,
  utils:  [_stripCommas, _parseNum, _fmtNum, _phoneDigits, fmtMoney, fmtPct,
           _normalizeAddr, _addrMatches, cleanAddress, parseAddress].length,
});
