// utils/format.js — pure formatting helpers (no DOM, no I/O).
// Currently duplicated in the legacy <script> in index.html
// (lines ~6920–6996 + 4427/4445); duplicates removed once consumers migrate.

// Strip commas from a string so Number() can parse it
export const _stripCommas = s => String(s == null ? '' : s).replace(/,/g, '');

// Parse a user-entered string that may contain commas into a number
export const _parseNum = s => {
  const n = Number(_stripCommas(s));
  return isNaN(n) ? 0 : n;
};

// Format a number with US thousands separators. Returns '' for empty/NaN.
export const _fmtNum = n => {
  if(n === '' || n == null) return '';
  const num = Number(_stripCommas(n));
  if(isNaN(num)) return '';
  return num.toLocaleString('en-US');
};

// Strip a formatted phone back to digits only (for DB storage)
export const _phoneDigits = s => String(s||'').replace(/\D/g,'');

// Format dollar amount: <$1k = full, <$1M = "$XK", >=$1M = "$X.XXM".
export function fmtMoney(v){
  if(!v) return '—';
  const n=Number(v);if(isNaN(n)) return '—';
  if(n>=1000000) return '$'+(n/1000000).toFixed(2)+'M';
  if(n>=1000) return '$'+(n/1000).toFixed(0)+'K';
  return '$'+n.toLocaleString();
}

// Format a 0–1 ratio as "X.XX%". Returns '—' for empty/NaN/object input.
export function fmtPct(v){
  if(v===null||v===undefined||v==='') return '—';
  if(typeof v==='object') return '—';
  const n=Number(v);if(isNaN(n)) return '—';
  return (n*100).toFixed(2)+'%';
}
