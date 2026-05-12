// design/design-system.js — JS bindings for the redesign tokens.
// Pairs with css/design-system.css.
//
// What this module owns:
//   - Token constants (colors, type, spacing) so inline-styled
//     callsites don't have to remember hex values.
//   - HTML render helpers (`dsButton`, `dsKpi`, `dsStagePill`, etc.)
//     that emit class-based markup matching css/design-system.css.
//   - The single source of truth for stage→class mapping so every
//     status pill across the app renders consistently.
//
// Per the saved "extract to new components" preference, this lives
// in its own module instead of getting piled into index.html.
// Wired through js/main.js.
//
// Implementation note: the design-system CSS does most of the visual
// work via classnames; this module is a convenience layer for code
// paths that build HTML strings inline (the legacy index.html style
// of programmatic rendering). Pure-CSS callsites can ignore it.

// ─── Token constants ──────────────────────────────────────────

export const DS_COLORS = Object.freeze({
  // Surfaces
  bg:        '#f1f5f9',
  surface:   '#ffffff',
  surface2:  '#f8fafc',
  border:    '#e2e8f0',
  border2:   '#cbd5e1',
  // Text
  fg1:       '#0f172a',
  fg2:       '#475569',
  fg3:       '#94a3b8',
  fg4:       '#cbd5e1',
  // Primary blue
  primary:        '#2563eb',
  primaryDark:    '#1d4ed8',
  primaryDarker:  '#1e3a8a',
  primaryLight:   '#eff6ff',
  primaryLighter: '#dbeafe',
  // Chrome
  chromeBg:      '#0f172a',
  chromeLine:    '#1e293b',
  chromeFg:      '#94a3b8',
  chromeFgHi:    '#e2e8f0',
  // Semantic
  green:      '#16a34a', greenDark: '#15803d', greenBg: '#f0fdf4', greenBorder: '#86efac',
  red:        '#dc2626', redDark:   '#b91c1c', redBg:   '#fef2f2', redBorder:   '#fca5a5',
  yellow:     '#d97706', yellowDark:'#b45309', yellowBg:'#fffbeb', yellowBorder:'#fcd34d',
  // Accent
  gold:       '#fbbf24',  // logo accent ONLY — never a button.
});

export const DS_TYPE = Object.freeze({
  fontSans:  "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontMono:  "'Source Code Pro', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  fontStamp: "Georgia, 'Times New Roman', serif",
  size9:  9,  size10: 10, size11: 11, size12: 12, size13: 13,
  size14: 14, size16: 16, size22: 22, size26: 26, size34: 34,
  weightRegular: 400, weightMedium: 500, weightSemi: 600,
  weightBold: 700,    weightBlack:  800,
});

export const DS_SPACE = Object.freeze({
  s1: 2, s2: 4, s3: 6, s4: 8, s5: 10, s6: 12, s7: 14, s8: 16,
  s9: 18, s10: 20, s12: 24, s14: 28,
});

export const DS_RADIUS = Object.freeze({
  xs: 4, sm: 6, md: 8, pill: 99,
});

// Stage key → CSS class suffix used by css/design-system.css. Add
// a new mapping here when introducing a new pipeline stage.
export const DS_STAGE_CLASS = Object.freeze({
  prospect: 'stage-prospect',
  pitch:    'stage-pitch',
  offer:    'stage-offer',
  uc:       'stage-uc',          // under contract
  closed:   'stage-closed',
  dead:     'stage-dead',
  lead:     'stage-lead',
  hot:      'stage-hot',
});

// ─── Render helpers ───────────────────────────────────────────

function _esc(s){
  return String(s == null ? '' : s).replace(/[<&>"]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;'}[c]));
}

// dsButton({ label, kind?: 'primary'|'ghost'|'danger'|'success'|'default',
//            size?: 'sm'|'lg'|'md', icon?: string-html, onclick?: string,
//            id?, attrs? }) → HTML string.
//
// Emits a `<button class="btn-ds btn-...">` matching css/design-system.css.
export function dsButton(opts){
  opts = opts || {};
  const cls = ['btn-ds'];
  if(opts.kind && opts.kind !== 'default') cls.push('btn-' + opts.kind);
  if(opts.size === 'sm' || opts.size === 'lg') cls.push('btn-' + opts.size);
  if(opts.className) cls.push(opts.className);
  const idAttr = opts.id ? ` id="${_esc(opts.id)}"` : '';
  const onclick = opts.onclick ? ` onclick="${_esc(opts.onclick)}"` : '';
  const attrs   = opts.attrs   ? ' ' + opts.attrs : '';
  const icon    = opts.icon    ? `<span class="btn-ds-icon">${opts.icon}</span>` : '';
  return `<button class="${cls.join(' ')}"${idAttr}${onclick}${attrs}>${icon}${_esc(opts.label || '')}</button>`;
}

// dsStagePill(stageKey, label?) → small uppercase pill chip.
// `stageKey` is one of DS_STAGE_CLASS keys; label defaults to uppercased key.
export function dsStagePill(stageKey, label){
  const cls = DS_STAGE_CLASS[String(stageKey || '').toLowerCase()] || 'stage-prospect';
  const text = label != null ? String(label) : String(stageKey || '').toUpperCase();
  return `<span class="stage-pill ${cls}">${_esc(text)}</span>`;
}

// dsKpi({ label, value, delta?, deltaDir?: 'up'|'down' }) → KPI tile.
// Value renders in mono tabular-nums automatically (per .ds-kpi-value).
export function dsKpi(opts){
  opts = opts || {};
  const delta = (opts.delta != null && opts.delta !== '')
    ? `<div class="ds-kpi-delta ${opts.deltaDir === 'down' ? 'down' : 'up'}">${_esc(opts.delta)}</div>`
    : '';
  return `<div class="ds-kpi">
    <div class="ds-kpi-label">${_esc(opts.label || '')}</div>
    <div class="ds-kpi-value">${_esc(opts.value != null ? opts.value : '')}</div>
    ${delta}
  </div>`;
}

// dsStatStrip(cells: [{label, value}, ...]) — Bloomberg-style stat row.
// Each cell shows an eyebrow label + a mono tabular-nums value, in a
// horizontal grid sharing one outer card.
export function dsStatStrip(cells){
  const arr = Array.isArray(cells) ? cells : [];
  return `<div class="ds-stat-strip">
    ${arr.map(c => `<div class="ds-stat-cell">
      <div class="ds-stat-label">${_esc(c?.label || '')}</div>
      <div class="ds-stat-value">${_esc(c?.value != null ? c.value : '')}</div>
    </div>`).join('')}
  </div>`;
}

// dsCard({ title?, body?, actions? }) → bordered card with optional header.
// `body` and `actions` accept raw HTML.
export function dsCard(opts){
  opts = opts || {};
  const hdr = (opts.title || opts.actions)
    ? `<div class="ds-card-hdr">
         <div class="ds-h3">${_esc(opts.title || '')}</div>
         <div>${opts.actions || ''}</div>
       </div>`
    : '';
  return `<div class="ds-card">${hdr}<div class="ds-card-body">${opts.body || ''}</div></div>`;
}

// dsBrand() → wordmark HTML for the slate top-nav corner.
// Defaults to "ACE CRM" with a gold accent on "CRM".
export function dsBrand(opts){
  opts = opts || {};
  const main   = _esc(opts.main || 'Ace');
  const accent = _esc(opts.accent || 'CRM');
  const mark   = _esc(opts.mark   || 'A');
  return `<span class="ds-brand">
    <span class="ds-brand-mark">${mark}</span>
    <span>${main} <span class="ds-brand-accent">${accent}</span></span>
  </span>`;
}

// dsEmpty(message) → drop-in empty-state placeholder.
export function dsEmpty(message){
  return `<div class="ds-empty">${_esc(message || 'Nothing here yet.')}</div>`;
}

// dsModalShell({ title, body, actions, onClose? }) → modal chrome.
// Matches the .ds-modal-shell tokens. Wrap in your own backdrop.
export function dsModalShell(opts){
  opts = opts || {};
  const closeBtn = opts.onClose
    ? `<button class="btn-ds btn-ghost btn-sm" onclick="${_esc(opts.onClose)}" title="Close">✕</button>`
    : '';
  const footer = opts.actions
    ? `<div class="ds-modal-footer">${opts.actions}</div>`
    : '';
  return `<div class="ds-modal-shell">
    <div class="ds-modal-hdr">
      <div class="ds-modal-title">${_esc(opts.title || '')}</div>
      ${closeBtn}
    </div>
    <div class="ds-modal-body">${opts.body || ''}</div>
    ${footer}
  </div>`;
}
