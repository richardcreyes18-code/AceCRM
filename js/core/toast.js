// core/toast.js — transient on-screen feedback.
// Currently duplicated in the legacy <script> (lines ~1999, ~61618).

// Small transient toast for quick action feedback ('ok' / 'err' / default).
export function _showToast(msg, kind){
  let el = document.getElementById('_ace_toast');
  if(!el){
    el = document.createElement('div');
    el.id = '_ace_toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 18px;border-radius:8px;font-size:12px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,0.3);z-index:99999;opacity:0;transition:opacity 180ms ease;font-family:Inter,system-ui,sans-serif;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = kind==='err' ? '#991b1b' : (kind==='ok' ? '#166534' : '#0f172a');
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity='0'; }, 1800);
}

// Bottom-right "✓ Saved" green slab. Heavier visual weight than _showToast,
// used for save confirmations specifically.
export function showSaveConfirm(msg){
  let toast = document.getElementById('saveToast');
  if(!toast){
    toast = document.createElement('div');
    toast.id = 'saveToast';
    toast.style.cssText = `
      position:fixed;bottom:20px;right:20px;
      background:linear-gradient(180deg,#60c060,#409040);
      color:#fff;font-weight:bold;font-size:12px;
      padding:8px 18px;border-radius:4px;
      border:1px solid #206020;
      box-shadow:2px 2px 8px rgba(0,0,0,0.3);
      z-index:9999;font-family:Tahoma,Arial,sans-serif;
      transition:opacity 0.4s;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity='1';
  toast.style.display='block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=>{ toast.style.opacity='0'; setTimeout(()=>toast.style.display='none',400); },2500);
}
