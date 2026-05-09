// schemas/index.js — barrel re-export of every schema module.
// Import from here when you need everything; otherwise prefer importing
// the specific file (smaller dependency graph, clearer intent).

export { SB_TABLES }         from './sb-tables.js';
export { SB_PROP_MAP }       from './deals.js';
export { SB_PORTFOLIO_MAP }  from './portfolios.js';
export { SB_CONTACT_MAP }    from './contacts.js';
export { SB_BC_MAP }         from './buyer-criteria.js';
export { SB_TASK_MAP, SB_NOTIF_MAP } from './tasks.js';
export { SB_MANUAL_COMP_MAP } from './manual-comps.js';
