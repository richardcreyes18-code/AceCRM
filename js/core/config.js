// core/config.js — credentials accessor.
// Currently duplicated in the legacy <script> in index.html (line ~2314).
//
// Only the *pure* getConfig() lives here. saveConfig / dismissConfig /
// openConfig touch the DOM and call domain functions (showSaveConfirm,
// hideOverlay, syncData, openDeal); they migrate when settings UI moves.

const BAKED_SB_URL = 'https://eoatyremdqilsetmtyfk.supabase.co';
const BAKED_SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvYXR5cmVtZHFpbHNldG10eWZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMzc2NjIsImV4cCI6MjExMDYxMzY2Mn0.S3FrojHoHnoFpV8xci2jDXy_2SXhCg6N_xrsWiSoUR8';

// Credentials baked in — no setup needed.
export function getConfig(){
  return {
    backend: 'supabase',
    url:  BAKED_SB_URL,
    key:  BAKED_SB_KEY,
    isConnected: true
  };
}
