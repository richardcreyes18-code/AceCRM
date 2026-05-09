// widgets/rich-text.js — small contenteditable-based rich-text editor.
//
// Replaces a textarea with a contenteditable div + toolbar (Bold / Italic /
// Underline / Font sizes / Lists / Links / Clear formatting). The div carries
// the original textarea's id so existing `.value` reads/writes still work
// (via Object.defineProperty on the div).
//
// Self-contained — no external dependencies. Used by:
//   - asset template editor (_atplRenderEditor in legacy)
//   - email template editor (loadAICommTab in legacy)
//   - any future textarea that wants formatting
//
// Only _rtMount is exported (consumed externally). The other helpers are
// module-private since legacy never called them directly.

function _rtTextToHTML(text){
  if(!text) return '';
  return String(text)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>');
}
// Heuristic: does this string already look like HTML?
function _rtLooksLikeHTML(s){
  return /<(b|i|u|p|div|br|ul|ol|li|a|span|font|strong|em|h[1-6])\b/i.test(String(s||''));
}
// Sanitize pasted HTML — keep basic formatting, strip styles/classes/scripts.
function _rtSanitizePaste(html){
  const wrap = document.createElement('div');
  wrap.innerHTML = String(html||'');
  const allowed = new Set(['B','I','U','STRONG','EM','UL','OL','LI','BR','P','DIV','A','SPAN','FONT','H1','H2','H3']);
  const walk = (node) => {
    [...node.childNodes].forEach(walk);
    if(node.nodeType === 1){
      if(node.tagName === 'SCRIPT' || node.tagName === 'STYLE'){ node.remove(); return; }
      if(!allowed.has(node.tagName)){
        // Replace with its text content
        const parent = node.parentNode;
        while(node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        return;
      }
      // Strip everything except a few safe attrs
      [...node.attributes].forEach(a => {
        const ok = (node.tagName === 'A' && a.name === 'href')
                || (node.tagName === 'FONT' && a.name === 'size');
        if(!ok) node.removeAttribute(a.name);
      });
    }
  };
  walk(wrap);
  return wrap.innerHTML;
}

function _rtBuildToolbar(){
  const btn = 'background:#fff;border:1px solid #cbd5e1;color:#475569;padding:4px 8px;font-size:12px;font-weight:600;border-radius:4px;cursor:pointer;line-height:1;height:28px;display:inline-flex;align-items:center;justify-content:center;min-width:28px;';
  const sep = '<span style="width:1px;background:#cbd5e1;margin:0 2px;align-self:stretch;"></span>';
  // v189: replaced font-size <select> with 4 size buttons. The select-change
  // approach skipped clicks on the already-selected option (no change event)
  // so "Normal" did nothing if Normal was the active value.
  return `
    <div class="rt-toolbar" style="display:flex;flex-wrap:wrap;gap:4px;align-items:stretch;padding:6px 8px;background:#f1f5f9;border:1px solid #cbd5e1;border-bottom:none;border-top-left-radius:6px;border-top-right-radius:6px;">
      <button type="button" data-rt-cmd="bold"      title="Bold (⌘B)"      style="${btn}"><b>B</b></button>
      <button type="button" data-rt-cmd="italic"    title="Italic (⌘I)"    style="${btn}"><i>I</i></button>
      <button type="button" data-rt-cmd="underline" title="Underline (⌘U)" style="${btn}"><u>U</u></button>
      ${sep}
      <button type="button" data-rt-cmd="fontSize" data-rt-arg="2" title="Small"  style="${btn}font-size:10px;">A</button>
      <button type="button" data-rt-cmd="fontSize" data-rt-arg="3" title="Normal" style="${btn}">A</button>
      <button type="button" data-rt-cmd="fontSize" data-rt-arg="5" title="Large"  style="${btn}font-size:14px;">A</button>
      <button type="button" data-rt-cmd="fontSize" data-rt-arg="6" title="XL"     style="${btn}font-size:16px;">A</button>
      ${sep}
      <button type="button" data-rt-cmd="insertUnorderedList" title="Bullet list"   style="${btn}">• List</button>
      <button type="button" data-rt-cmd="insertOrderedList"   title="Numbered list" style="${btn}">1. List</button>
      ${sep}
      <button type="button" data-rt-cmd="createLink" title="Insert link" style="${btn}">🔗 Link</button>
      <button type="button" data-rt-cmd="unlink"     title="Remove link" style="${btn}">🔗✕</button>
      ${sep}
      <button type="button" data-rt-cmd="removeFormat" title="Clear formatting" style="${btn}">🧹</button>
    </div>
  `;
}

// Replace the textarea with id=`textareaId` with a rich-text editor.
// Idempotent: if already mounted, this re-syncs the value and returns.
export function _rtMount(textareaId, opts){
  opts = opts || {};
  const ta = document.getElementById(textareaId);
  if(!ta) return null;
  if(ta.dataset.rtMounted === '1') return ta;
  const initialVal = ta.value || ta.textContent || '';
  const minH = opts.minHeight || ta.style.minHeight || '180px';
  // Build the container and toolbar
  const wrap = document.createElement('div');
  wrap.className = 'rt-wrap';
  wrap.style.cssText = 'display:flex;flex-direction:column;';
  wrap.innerHTML = _rtBuildToolbar();
  const toolbar = wrap.querySelector('.rt-toolbar');
  // Build the contenteditable div, inheriting the textarea's id
  const div = document.createElement('div');
  div.id = ta.id;
  div.contentEditable = 'true';
  div.dataset.rtMounted = '1';
  div.style.cssText = `padding:10px;border:1px solid #94a3b8;border-top:none;background:#fff;min-height:${minH};font-size:12px;font-family:Tahoma,Arial,sans-serif;line-height:1.5;border-bottom-left-radius:6px;border-bottom-right-radius:6px;outline:none;overflow-y:auto;box-sizing:border-box;`;
  div.innerHTML = _rtLooksLikeHTML(initialVal) ? initialVal : _rtTextToHTML(initialVal);
  // .value accessor mirrors innerHTML, so existing .value reads/writes still work
  Object.defineProperty(div, 'value', {
    configurable: true,
    get: () => div.innerHTML,
    set: (v) => {
      if(v == null){ div.innerHTML = ''; return; }
      const s = String(v);
      div.innerHTML = _rtLooksLikeHTML(s) ? s : _rtTextToHTML(s);
    }
  });
  // Wire toolbar buttons
  toolbar.querySelectorAll('[data-rt-cmd]').forEach(el => {
    el.addEventListener('mousedown', e => e.preventDefault()); // keep editor focus
    el.addEventListener('click', () => {
      const cmd = el.dataset.rtCmd;
      const arg = el.dataset.rtArg || null;
      try {
        if(cmd === 'createLink'){
          const url = prompt('Enter URL (https://...):', 'https://');
          if(url) document.execCommand('createLink', false, url);
        } else if(cmd === 'fontSize'){
          // v189: ensure focus is in the editor before applying. Without this,
          // execCommand silently no-ops if focus is on the toolbar button.
          if(document.activeElement !== div) div.focus();
          document.execCommand('fontSize', false, arg || '3');
        } else {
          document.execCommand(cmd, false, null);
        }
      } catch(_e){}
      div.dispatchEvent(new Event('input', { bubbles:true }));
    });
  });
  // Paste cleanup
  div.addEventListener('paste', (e) => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    const html = cd?.getData('text/html');
    const text = cd?.getData('text/plain') || '';
    if(html){
      try { document.execCommand('insertHTML', false, _rtSanitizePaste(html)); }
      catch(_e){ document.execCommand('insertText', false, text); }
    } else {
      document.execCommand('insertText', false, text);
    }
  });
  // Forward an inline oninput attribute that the original textarea had
  if(ta.hasAttribute('oninput')){
    div.setAttribute('oninput', ta.getAttribute('oninput'));
  }
  // Mount
  ta.parentNode.insertBefore(wrap, ta);
  wrap.appendChild(div);
  ta.remove();
  return div;
}
