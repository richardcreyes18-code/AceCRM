// core/supabase.js — REST helpers built on top of crm-proxy + storage helpers.
// Currently duplicated in the legacy <script> (lines ~1388, 1418, 1434, 1437,
// 1440, 1449, 2023, 2055, 2070, 2076); duplicates removed as consumers migrate.

import { _proxyCall, PROXY_URL, SB_ANON_KEY, SB_STORAGE_URL, SB_BUCKET } from './proxy.js';
import { getConfig } from './config.js';
import { SB_TABLES } from '../schemas/sb-tables.js';

export function _sbHeaders() {
  const cfg = getConfig();
  return {
    'apikey': cfg.key,
    'Authorization': `Bearer ${cfg.key}`,
    'Content-Type': 'application/json'
  };
}

export async function _sbGet(table, params = '') {
  const qp = {};
  if(params){
    const p = new URLSearchParams(params);
    for(const [k,v] of p.entries()) qp[k] = v;
  }
  // v113: apply agent filter for My Deals mode on the properties table.
  // _viewMode + _currentUser live on window because Phase 3 converted their
  // legacy `let` declarations to `var` (auto-attaches to window). When state
  // extraction completes in a later phase, this reads from core/state.js.
  const viewMode    = (typeof window !== 'undefined') ? window._viewMode : undefined;
  const currentUser = (typeof window !== 'undefined') ? window._currentUser : undefined;
  if(table === SB_TABLES.properties
     && viewMode === 'my'
     && currentUser
     && currentUser.fub_name){
    qp['fub_assigned_to'] = 'eq.' + currentUser.fub_name;
  }
  return _proxyCall({ table, method: 'GET', ...qp });
}

export async function _sbPatch(table, id, data, opts = {}) {
  return _proxyCall({ table, method: 'PATCH', id }, data, opts);
}

export async function _sbPost(table, data) {
  return _proxyCall({ table, method: 'POST' }, data);
}

export async function _sbDelete(table, id) {
  return _proxyCall({ table, method: 'DELETE', id });
}

// v102.37: invoke a Postgres function via the crm-proxy. The proxy reads
// ?rpc=<function_name> from the query string and the body as the params
// object. Returns the function's return value (typically jsonb -> object).
// Used for atomic multi-statement operations like cascading rename where
// browser-side sequencing of individual sb* calls would risk partial writes.
export async function _sbRpc(fn, params = {}) {
  const url = new URL(PROXY_URL);
  url.searchParams.set('rpc', fn);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  const data = await res.json();
  if(data?.error) throw new Error(data.error);
  return data;
}

// ─── SUPABASE STORAGE HELPERS ────────────────────────────────────
// Uses the anon key directly (not the proxy) because storage has its own API.
// The 'ace-property-files' bucket is public and has permissive policies
// allowing anon read/write/delete.

// Upload a File/Blob to the bucket at the given path.
// Returns { path, publicUrl } on success.
export async function _sbUpload(path, file, onProgress) {
  // Use XHR so we can stream progress, unlike fetch() which can't
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SB_STORAGE_URL}/object/${SB_BUCKET}/${encodeURI(path)}`);
    xhr.setRequestHeader('apikey', SB_ANON_KEY);
    xhr.setRequestHeader('Authorization', `Bearer ${SB_ANON_KEY}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true'); // overwrite if same path
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({
          path,
          publicUrl: `${SB_STORAGE_URL}/object/public/${SB_BUCKET}/${encodeURI(path)}`
        });
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch (e) {}
        reject(new Error(`${msg} (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

// Delete a file from the bucket by its storage path
export async function _sbStorageDelete(path) {
  const res = await fetch(`${SB_STORAGE_URL}/object/${SB_BUCKET}/${encodeURI(path)}`, {
    method: 'DELETE',
    headers: {
      'apikey': SB_ANON_KEY,
      'Authorization': `Bearer ${SB_ANON_KEY}`
    }
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed: ${res.status}`);
  }
  return true;
}

// Build a public URL for a file by its storage path
export function _sbPublicUrl(path) {
  if (!path) return '';
  return `${SB_STORAGE_URL}/object/public/${SB_BUCKET}/${encodeURI(path)}`;
}

// Sanitize a filename for safe storage paths
export function _sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 120);
}
