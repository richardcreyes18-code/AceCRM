// core/config.js — credentials accessor.
// Currently duplicated in the legacy <script> in index.html (line ~2314).
//
// Only the *pure* getConfig() lives here. saveConfig / dismissConfig /
// openConfig touch the DOM and call domain functions (showSaveConfirm,
// hideOverlay, syncData, openDeal); they migrate when settings UI moves.

const BAKED_SB_URL = 'https://kxtuegjptvzqycgyzehj.supabase.co';
const BAKED_SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4dHVlZ2pwdHZ6cXljZ3l6ZWhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODg5NzQsImV4cCI6MjA5MTI2NDk3NH0.FctjQCWJfjxqD_07gbmKn9r5rCbNUNtEWNhYIhDo5Dc';

// Credentials baked in — no setup needed.
export function getConfig(){
  return {
    backend: 'supabase',
    url:  BAKED_SB_URL,
    key:  BAKED_SB_KEY,
    isConnected: true
  };
}
