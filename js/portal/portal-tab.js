// portal-tab.js — "Website" tab on the deal detail card.
//
// Owns: Publish / NDA / expiry / authorization controls, commission settings,
// per-field portal overrides, photo selection, Copy Buyer Link, and view
// count display. Persists overrides into `ace_properties.portal_overrides`
// and share settings into a `ace_deal_shares` row (one per deal).
//
// Exposed globals (so legacy index.html can call them without imports):
//   window.renderPortalTab(deal)                 — tab HTML
//   window.initPortalTab()                       — post-render wiring
//   window.portalCopyLink()                      — Copy Buyer Link handler
//   window.portalTogglePublish()                 — Publish toggle
//   window.portalSaveField(key, value)           — per-field persistence
//   window.portalOpenPublic()                    — opens the live buyer page

(function () {
  'use strict';

  const PORTAL_SHARES_TBL = 'ace_deal_shares';
  const PROPS_TBL = 'ace_properties';

  // We lazily cache the share row for currentDeal so render + handlers share it.
  window._portalShareCache = window._portalShareCache || {};

  function sh(k) { return window._portalShareCache?.[k]; }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function currentDealId() {
    return window.currentDeal?.id || null;
  }

  function overridesOf(deal) {
    const raw = deal?.portal_overrides || deal?.['portal_overrides'];
    if (!raw || typeof raw !== 'object') return {};
    return raw;
  }

  function effectiveField(deal, key, raw) {
    const ov = overridesOf(deal);
    if (key in ov && ov[key] !== null && ov[key] !== '') return ov[key];
    return raw;
  }

  function newToken() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function fmtMoney(n) {
    const v = Number(n);
    if (!isFinite(v) || v === 0) return '—';
    return '$' + Math.round(v).toLocaleString();
  }

  function publicUrl(token) {
    // Prefer the live production host; fall back to current origin otherwise.
    const origin = window.location.hostname.endsWith('clarkecommercialusa.com')
      ? 'https://clarkecommercialusa.com'
      : window.location.origin;
    return `${origin}/deal/${token}`;
  }

  // -------- Data layer --------

  async function loadShare(dealId) {
    try {
      const rows = await _sbGet(PORTAL_SHARES_TBL,
        `deal_id=eq.${dealId}&select=*&order=created_at.desc&limit=1`);
      return rows?.[0] || null;
    } catch (e) {
      console.warn('[portal] loadShare failed', e);
      return null;
    }
  }

  async function createShare(dealId) {
    const row = {
      deal_id: dealId,
      token: newToken(),
      is_published: false,
      nda_required: true,
      hide_address: true,
      expires_at: new Date(Date.now() + 90 * 86400 * 1000).toISOString(),
    };
    const created = await _sbPost(PORTAL_SHARES_TBL, row);
    return created;
  }

  async function patchShare(id, patch) {
    return await _sbPatch(PORTAL_SHARES_TBL, id, patch);
  }

  async function patchOverrides(dealId, newOv) {
    await _sbPatch(PROPS_TBL, dealId, { portal_overrides: newOv });
    if (window.currentDeal && window.currentDeal.id === dealId) {
      window.currentDeal.portal_overrides = newOv;
    }
  }

  async function loadViewCounts(shareId) {
    try {
      const rows = await _sbGet(PORTAL_SHARES_TBL,
        `id=eq.${shareId}&select=view_count,unique_viewer_count,updated_at`);
      return rows?.[0] || null;
    } catch (_) { return null; }
  }

  // -------- Render --------

  function renderPortalTab(deal) {
    if (!deal) return '<div style="padding:24px;color:#64748b;">No deal loaded.</div>';
    const ov = overridesOf(deal);
    const share = sh('share');
    const isLoaded = sh('loaded') === deal.id;
    if (!isLoaded) {
      // Kick off a load; the tab will re-render when done.
      setTimeout(() => {
        loadShare(deal.id).then(s => {
          window._portalShareCache = { share: s, loaded: deal.id };
          if (window.currentTab === 'portal') {
            document.getElementById('tabContent').innerHTML = renderPortalTab(deal);
            initPortalTab();
          }
        });
      }, 0);
      return `<div style="padding:40px;text-align:center;color:#64748b;">Loading portal settings…</div>`;
    }

    const authSrc = deal.authorization_source || deal['authorization_source'] || 'none';
    const commissionStruct = deal.commission_structure || deal['commission_structure'] || '';
    const commissionRate = deal.commission_rate_pct ?? deal['commission_rate_pct'] ?? '';
    const authNotes = deal.authorization_notes || deal['authorization_notes'] || '';
    const commissionNotes = deal.commission_notes || deal['commission_notes'] || '';

    const atts = Array.isArray(deal.photo_attachments) ? deal.photo_attachments
                 : (Array.isArray(deal['PHOTO']) ? deal['PHOTO'] : []);
    const selected = Array.isArray(ov.__selected_photos) ? ov.__selected_photos : atts.map(p => p.id);
    const selSet = new Set(selected);
    const hidden = Array.isArray(ov.__hidden) ? ov.__hidden : [];
    const hiddenSet = new Set(hidden);

    const published = share?.is_published === true;
    const token = share?.token || '';
    const link = token ? publicUrl(token) : '';

    // Expiry — current selection in days from now (or "never").
    let expiryChoice = '90';
    if (!share?.expires_at) expiryChoice = 'never';
    else {
      const daysLeft = Math.round((new Date(share.expires_at) - Date.now()) / 86400000);
      if (daysLeft <= 0) expiryChoice = '30';
      else if (daysLeft <= 30) expiryChoice = '30';
      else if (daysLeft <= 90) expiryChoice = '90';
      else expiryChoice = 'never';
    }

    const askingEff = effectiveField(deal, 'asking_price', deal['Asking Price'] || deal.asking_price);
    const noiEff    = effectiveField(deal, 'noi', deal['NOI'] || deal.noi);
    const capEff    = effectiveField(deal, 'cap_rate_crm', deal['Cap Rate (CRM)'] || deal.cap_rate_crm);
    const descEff   = effectiveField(deal, 'property_description', deal['Property Description'] || deal.property_description);
    const highlightsEff = effectiveField(deal, 'property_highlights', deal['Property Highlights'] || deal.property_highlights);
    const highlightsStr = Array.isArray(highlightsEff) ? highlightsEff.join('\n') : (highlightsEff || '');

    const vc = share?.view_count || 0;
    const uvc = share?.unique_viewer_count || 0;

    return `
    <div class="pt-root" style="padding:16px 20px;font-family:inherit;color:#0f172a;">
      <style>
        .pt-grid { display:grid; grid-template-columns: 1.35fr 1fr; gap:16px; }
        .pt-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px; margin-bottom:14px; }
        .pt-card h3 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#1a3a6e; padding-bottom:6px; border-bottom:1px solid #e2e8f0; font-weight:700; }
        .pt-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:13px; }
        .pt-row:last-child { border-bottom:none; }
        .pt-row .k { color:#64748b; font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:600; }
        .pt-row input[type=text], .pt-row input[type=number], .pt-row textarea, .pt-row select {
          border:1px solid #cbd5e1; border-radius:5px; padding:5px 8px; font-size:13px; font-family:inherit; min-width:0;
        }
        .pt-input-wrap { display:flex; gap:6px; align-items:center; flex:1; min-width:0; justify-content:flex-end; }
        .pt-input-wrap input[type=text], .pt-input-wrap input[type=number] { flex:1; max-width:220px; }
        .pt-hide { background:#f1f5f9; border:1px solid #cbd5e1; color:#475569; font-size:10px; padding:2px 7px; border-radius:4px; cursor:pointer; text-transform:uppercase; letter-spacing:.06em; font-weight:600; }
        .pt-hide.on { background:#fef3c7; border-color:#f59e0b; color:#78350f; }
        .pt-toggle { position:relative; width:42px; height:22px; background:#cbd5e1; border-radius:99px; cursor:pointer; transition:background .15s; display:inline-block; vertical-align:middle; }
        .pt-toggle.on { background:#16a34a; }
        .pt-toggle::after { content:''; position:absolute; top:2px; left:2px; width:18px; height:18px; background:#fff; border-radius:50%; transition:left .15s; box-shadow:0 1px 3px rgba(0,0,0,.2); }
        .pt-toggle.on::after { left:22px; }
        .pt-pub-card { background: ${published ? 'linear-gradient(135deg,#dcfce7,#bbf7d0)' : 'linear-gradient(135deg,#f1f5f9,#e2e8f0)'}; border: 2px solid ${published ? '#16a34a' : '#cbd5e1'}; border-radius:10px; padding:16px 20px; margin-bottom:14px; }
        .pt-pub-status { font-size:12px; text-transform:uppercase; letter-spacing:.1em; font-weight:700; color:${published ? '#14532d' : '#475569'}; }
        .pt-pub-title { font-size:20px; font-weight:700; color:#0f172a; margin:4px 0 2px; }
        .pt-pub-sub { font-size:12px; color:#64748b; }
        .pt-link-box { background:#fff; border:1px solid #cbd5e1; border-radius:6px; padding:8px 10px; margin-top:12px; display:flex; gap:8px; align-items:center; font-family:ui-monospace,Menlo,monospace; font-size:12px; color:#1a3a6e; }
        .pt-link-box input { border:none; outline:none; flex:1; background:transparent; color:#1a3a6e; font-family:inherit; font-size:12px; }
        .pt-btn { background:#1a3a6e; color:#fff; border:none; padding:6px 12px; border-radius:5px; font-size:12px; font-weight:600; cursor:pointer; letter-spacing:.04em; }
        .pt-btn.secondary { background:#fff; color:#1a3a6e; border:1px solid #cbd5e1; }
        .pt-btn.danger { background:#dc2626; }
        .pt-btn[disabled] { opacity:.5; cursor:not-allowed; }
        .pt-photo-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:8px; }
        .pt-photo { position:relative; aspect-ratio:4/3; border-radius:6px; overflow:hidden; border:2px solid transparent; cursor:pointer; background:#e2e8f0; }
        .pt-photo.sel { border-color:#2563eb; }
        .pt-photo img { width:100%; height:100%; object-fit:cover; display:block; }
        .pt-photo .pick { position:absolute; top:4px; left:4px; width:18px; height:18px; border-radius:50%; background:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; color:#2563eb; border:1px solid #cbd5e1; font-weight:700; }
        .pt-photo.sel .pick { background:#2563eb; color:#fff; border-color:#2563eb; }
        .pt-views { background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:8px 12px; font-size:12px; color:#475569; margin-top:8px; display:flex; justify-content:space-between; }
        .pt-views b { color:#0f172a; font-variant-numeric: tabular-nums; }
        .pt-help { font-size:11px; color:#64748b; line-height:1.5; margin-top:8px; }
        .pt-warn { background:#fef3c7; border-left:3px solid #f59e0b; color:#78350f; padding:8px 10px; font-size:12px; border-radius:0 6px 6px 0; margin-top:10px; }
      </style>

      <!-- Publish header -->
      <div class="pt-pub-card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div class="pt-pub-status">${published ? '● Published' : '○ Not published'}</div>
            <div class="pt-pub-title">Buyer Portal</div>
            <div class="pt-pub-sub">Share a private, NDA-gated page for this deal with specific buyers.</div>
          </div>
          <div style="text-align:right;">
            <button class="pt-btn ${published ? 'danger' : ''}" onclick="portalTogglePublish()">
              ${published ? 'Unpublish' : 'Publish'}
            </button>
            <button class="pt-btn secondary" style="margin-left:6px;" onclick="portalOpenPublic()" ${published ? '' : 'disabled'}>Preview</button>
          </div>
        </div>
        ${token ? `
          <div class="pt-link-box">
            <input type="text" value="${esc(link)}" readonly id="ptLinkField" onclick="this.select()"/>
            <button class="pt-btn ${published ? '' : 'secondary'}" onclick="portalCopyLink()" ${published ? '' : 'disabled'} id="ptCopyBtn">Copy Link</button>
          </div>` : ''}
        <div class="pt-views">
          <span>Portal views</span>
          <span><b>${vc}</b> view${vc === 1 ? '' : 's'} by <b>${uvc}</b> buyer${uvc === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div class="pt-grid">
        <!-- LEFT column: content editor -->
        <div>
          <div class="pt-card">
            <h3>Hero</h3>
            ${fieldRowText(deal, 'portal_asset_label', 'Asset type', ov, 'Multifamily', ov.portal_asset_label || deal.property_type_text || deal.legacy_property_type)}
            ${fieldRowText(deal, 'portal_market_label', 'Market', ov, 'Monmouth County, NJ', ov.portal_market_label || [deal.simple_county, deal.state].filter(Boolean).join(', '))}
          </div>

          <div class="pt-card">
            <h3>Financials</h3>
            ${fieldRowMoney(deal, 'asking_price', 'Asking price', ov, hiddenSet, askingEff)}
            ${fieldRowMoney(deal, 'noi', 'NOI (actual)', ov, hiddenSet, noiEff)}
            ${fieldRowPct(deal, 'cap_rate_crm', 'Cap rate', ov, hiddenSet, capEff)}
          </div>

          <div class="pt-card">
            <h3>Investment Highlights</h3>
            <textarea id="ptHighlights" rows="5" style="width:100%;border:1px solid #cbd5e1;border-radius:5px;padding:8px 10px;font-family:inherit;font-size:13px;"
              placeholder="One highlight per line (e.g. “Fully stabilized 24-unit asset in path of growth”)">${esc(highlightsStr)}</textarea>
            <div class="pt-help">One bullet per line. These appear in the Investment Highlights section.</div>
            <button class="pt-btn secondary" style="margin-top:8px;" onclick="portalSaveHighlights()">Save highlights</button>
          </div>

          <div class="pt-card">
            <h3>Description</h3>
            <textarea id="ptDesc" rows="6" style="width:100%;border:1px solid #cbd5e1;border-radius:5px;padding:8px 10px;font-family:inherit;font-size:13px;">${esc(descEff || '')}</textarea>
            <div class="pt-help">Shown on the portal instead of raw CRM notes.</div>
            <button class="pt-btn secondary" style="margin-top:8px;" onclick="portalSaveDescription()">Save description</button>
          </div>

          <div class="pt-card">
            <h3>Photos on the portal</h3>
            ${atts.length ? `
              <div class="pt-photo-grid">
                ${atts.map(p => `
                  <div class="pt-photo ${selSet.has(p.id) ? 'sel' : ''}" onclick="portalTogglePhoto('${esc(p.id)}')">
                    <img src="${esc(p.url)}" alt=""/>
                    <div class="pick">${selSet.has(p.id) ? '✓' : ''}</div>
                  </div>`).join('')}
              </div>
              <div class="pt-help">Click a photo to show / hide it on the portal. Un-selected photos stay in the CRM.</div>
            ` : `<div class="pt-help">No photos uploaded yet. Add photos in the Documents tab.</div>`}
          </div>

          <div class="pt-card">
            <h3>Downloads &amp; Actions</h3>
            <div style="font-size:13px;color:#334155;">
              The portal includes a Download OM button that regenerates the current OM PDF on demand. Edit the OM in the <b>OM &amp; Flyer</b> tab.
            </div>
          </div>
        </div>

        <!-- RIGHT column: settings -->
        <div>
          <div class="pt-card">
            <h3>Visibility &amp; Gate</h3>
            <div class="pt-row">
              <span class="k">Requires NDA before viewing</span>
              <span class="pt-toggle ${share?.nda_required ? 'on' : ''}" onclick="portalToggleShare('nda_required')"></span>
            </div>
            <div class="pt-row">
              <span class="k">Hide address until NDA accepted</span>
              <span class="pt-toggle ${share?.hide_address ? 'on' : ''}" onclick="portalToggleShare('hide_address')"></span>
            </div>
            <div class="pt-row">
              <span class="k">Link expires</span>
              <select onchange="portalSetExpiry(this.value)" style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 8px;font-size:12px;">
                <option value="30"    ${expiryChoice === '30'    ? 'selected' : ''}>30 days</option>
                <option value="90"    ${expiryChoice === '90'    ? 'selected' : ''}>90 days</option>
                <option value="never" ${expiryChoice === 'never' ? 'selected' : ''}>Never</option>
              </select>
            </div>
          </div>

          <div class="pt-card">
            <h3>Seller Authorization</h3>
            <div class="pt-row">
              <span class="k">Authorization source</span>
              <select id="ptAuthSrc" onchange="portalSaveAuthSource(this.value)" style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 8px;font-size:12px;">
                <option value="none"           ${authSrc === 'none'           ? 'selected' : ''}>None recorded</option>
                <option value="verbal"         ${authSrc === 'verbal'         ? 'selected' : ''}>Verbal</option>
                <option value="email_confirm"  ${authSrc === 'email_confirm'  ? 'selected' : ''}>Email confirmation</option>
                <option value="signed_oneoff"  ${authSrc === 'signed_oneoff'  ? 'selected' : ''}>Signed one-off</option>
                <option value="signed_listing" ${authSrc === 'signed_listing' ? 'selected' : ''}>Signed listing agreement</option>
              </select>
            </div>
            <textarea id="ptAuthNotes" rows="2" style="width:100%;border:1px solid #cbd5e1;border-radius:5px;padding:6px 8px;font-size:12px;margin-top:6px;" placeholder="How / when the seller authorized marketing…">${esc(authNotes)}</textarea>
            <button class="pt-btn secondary" style="margin-top:6px;" onclick="portalSaveAuthNotes()">Save authorization notes</button>
            ${authSrc === 'none' ? `<div class="pt-warn">⚠ No authorization recorded. You'll be asked to confirm before publishing.</div>` : ''}
          </div>

          <div class="pt-card">
            <h3>Commission</h3>
            <div class="pt-row">
              <span class="k">Structure</span>
              <select onchange="portalSaveCommission('commission_structure', this.value)" style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 8px;font-size:12px;">
                <option value=""                  ${commissionStruct === ''                  ? 'selected' : ''}>— pick one —</option>
                <option value="seller_pays"       ${commissionStruct === 'seller_pays'       ? 'selected' : ''}>Seller pays</option>
                <option value="buyer_pays_finder" ${commissionStruct === 'buyer_pays_finder' ? 'selected' : ''}>Buyer pays finder</option>
                <option value="split"             ${commissionStruct === 'split'             ? 'selected' : ''}>Split</option>
                <option value="all_in"            ${commissionStruct === 'all_in'            ? 'selected' : ''}>All-in</option>
              </select>
            </div>
            <div class="pt-row">
              <span class="k">Rate (%)</span>
              <input type="number" step="0.01" min="0" max="20" value="${esc(commissionRate)}" onchange="portalSaveCommission('commission_rate_pct', this.value)" style="width:90px;"/>
            </div>
            <textarea id="ptCommNotes" rows="2" placeholder="e.g. 3% seller-paid at close, split 50/50 if co-broke" style="width:100%;border:1px solid #cbd5e1;border-radius:5px;padding:6px 8px;font-size:12px;margin-top:6px;">${esc(commissionNotes)}</textarea>
            <button class="pt-btn secondary" style="margin-top:6px;" onclick="portalSaveCommissionNotes()">Save commission notes</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function fieldRowText(deal, key, label, ov, placeholder, effectiveVal) {
    return `
      <div class="pt-row">
        <span class="k">${esc(label)}</span>
        <div class="pt-input-wrap">
          <input type="text" value="${esc(effectiveVal || '')}" placeholder="${esc(placeholder)}" onchange="portalSaveField('${key}', this.value)"/>
        </div>
      </div>`;
  }

  function fieldRowMoney(deal, key, label, ov, hiddenSet, effectiveVal) {
    const hidden = hiddenSet.has(key);
    return `
      <div class="pt-row">
        <span class="k">${esc(label)}</span>
        <div class="pt-input-wrap">
          <input type="number" step="1" min="0" value="${effectiveVal ? Math.round(Number(effectiveVal)) : ''}" placeholder="auto" onchange="portalSaveField('${key}', this.value)"/>
          <button class="pt-hide ${hidden ? 'on' : ''}" onclick="portalToggleHidden('${key}')">${hidden ? 'Hidden' : 'Show'}</button>
        </div>
      </div>`;
  }

  function fieldRowPct(deal, key, label, ov, hiddenSet, effectiveVal) {
    const hidden = hiddenSet.has(key);
    return `
      <div class="pt-row">
        <span class="k">${esc(label)}</span>
        <div class="pt-input-wrap">
          <input type="number" step="0.01" min="0" max="25" value="${effectiveVal ?? ''}" placeholder="auto" onchange="portalSaveField('${key}', this.value)"/>
          <button class="pt-hide ${hidden ? 'on' : ''}" onclick="portalToggleHidden('${key}')">${hidden ? 'Hidden' : 'Show'}</button>
        </div>
      </div>`;
  }

  // -------- Mutations --------

  async function portalSaveField(key, value) {
    const dealId = currentDealId(); if (!dealId) return;
    const deal = window.currentDeal;
    const ov = { ...overridesOf(deal) };
    if (value === '' || value === null) delete ov[key];
    else ov[key] = value;
    await patchOverrides(dealId, ov);
    toastOK();
  }

  async function portalSaveHighlights() {
    const dealId = currentDealId(); if (!dealId) return;
    const deal = window.currentDeal;
    const raw = document.getElementById('ptHighlights').value;
    const arr = raw.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    const ov = { ...overridesOf(deal), property_highlights: arr };
    await patchOverrides(dealId, ov);
    toastOK('Highlights saved');
  }

  async function portalSaveDescription() {
    const dealId = currentDealId(); if (!dealId) return;
    const deal = window.currentDeal;
    const txt = document.getElementById('ptDesc').value;
    const ov = { ...overridesOf(deal) };
    if (txt && txt.trim()) ov.property_description = txt;
    else delete ov.property_description;
    await patchOverrides(dealId, ov);
    toastOK('Description saved');
  }

  async function portalToggleHidden(key) {
    const dealId = currentDealId(); if (!dealId) return;
    const deal = window.currentDeal;
    const ov = { ...overridesOf(deal) };
    const hidden = new Set(ov.__hidden || []);
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    ov.__hidden = [...hidden];
    await patchOverrides(dealId, ov);
    rerender();
  }

  async function portalTogglePhoto(id) {
    const dealId = currentDealId(); if (!dealId) return;
    const deal = window.currentDeal;
    const ov = { ...overridesOf(deal) };
    const atts = Array.isArray(deal.photo_attachments) ? deal.photo_attachments
                 : (Array.isArray(deal['PHOTO']) ? deal['PHOTO'] : []);
    const current = Array.isArray(ov.__selected_photos) ? new Set(ov.__selected_photos) : new Set(atts.map(p => p.id));
    if (current.has(id)) current.delete(id);
    else current.add(id);
    ov.__selected_photos = [...current];
    await patchOverrides(dealId, ov);
    rerender();
  }

  async function portalToggleShare(key) {
    const dealId = currentDealId(); if (!dealId) return;
    let share = sh('share');
    if (!share) share = await ensureShare(dealId);
    const next = !share[key];
    const updated = await patchShare(share.id, { [key]: next });
    window._portalShareCache = { share: updated || { ...share, [key]: next }, loaded: dealId };
    rerender();
  }

  async function portalSetExpiry(choice) {
    const dealId = currentDealId(); if (!dealId) return;
    let share = sh('share');
    if (!share) share = await ensureShare(dealId);
    let expires_at = null;
    if (choice === '30') expires_at = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    else if (choice === '90') expires_at = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
    const updated = await patchShare(share.id, { expires_at });
    window._portalShareCache = { share: updated || { ...share, expires_at }, loaded: dealId };
    toastOK('Expiry updated');
  }

  async function ensureShare(dealId) {
    let share = sh('share');
    if (!share) share = await loadShare(dealId);
    if (!share) share = await createShare(dealId);
    window._portalShareCache = { share, loaded: dealId };
    return share;
  }

  async function portalTogglePublish() {
    const dealId = currentDealId(); if (!dealId) return;
    const deal = window.currentDeal;
    let share = sh('share');
    if (!share) share = await ensureShare(dealId);
    if (share.is_published) {
      const updated = await patchShare(share.id, { is_published: false });
      window._portalShareCache = { share: updated || { ...share, is_published: false }, loaded: dealId };
      toastOK('Unpublished');
      rerender();
      return;
    }
    // Publishing — guard on authorization.
    const authSrc = deal.authorization_source || 'none';
    if (!authSrc || authSrc === 'none') {
      const reason = prompt(
        "You haven't recorded authorization from the seller. Type a note explaining why you're publishing anyway (or Cancel to abort):",
        ''
      );
      if (reason === null) return;
      try {
        await _sbPatch(PROPS_TBL, dealId, { authorization_notes: reason, authorization_source: 'none' });
        if (deal) { deal.authorization_notes = reason; }
      } catch (e) { /* non-fatal */ }
    }
    const updated = await patchShare(share.id, { is_published: true });
    window._portalShareCache = { share: updated || { ...share, is_published: true }, loaded: dealId };
    toastOK('Published');
    rerender();
  }

  function portalCopyLink() {
    const share = sh('share'); if (!share?.token) return;
    const url = publicUrl(share.token);
    const input = document.getElementById('ptLinkField');
    if (input) { input.select(); }
    (navigator.clipboard?.writeText(url) || Promise.reject())
      .then(() => toastOK('Link copied'))
      .catch(() => {
        try { document.execCommand('copy'); toastOK('Link copied'); }
        catch (_) { toastOK('Copy manually: ' + url); }
      });
  }

  function portalOpenPublic() {
    const share = sh('share'); if (!share?.token) return;
    window.open(publicUrl(share.token), '_blank');
  }

  async function portalSaveAuthSource(val) {
    const dealId = currentDealId(); if (!dealId) return;
    await _sbPatch(PROPS_TBL, dealId, { authorization_source: val });
    if (window.currentDeal) window.currentDeal.authorization_source = val;
    rerender();
  }

  async function portalSaveAuthNotes() {
    const dealId = currentDealId(); if (!dealId) return;
    const txt = document.getElementById('ptAuthNotes').value;
    await _sbPatch(PROPS_TBL, dealId, { authorization_notes: txt });
    if (window.currentDeal) window.currentDeal.authorization_notes = txt;
    toastOK('Authorization saved');
  }

  async function portalSaveCommission(key, value) {
    const dealId = currentDealId(); if (!dealId) return;
    const patch = {};
    patch[key] = value === '' ? null : (key === 'commission_rate_pct' ? Number(value) : value);
    await _sbPatch(PROPS_TBL, dealId, patch);
    if (window.currentDeal) window.currentDeal[key] = patch[key];
    toastOK();
  }

  async function portalSaveCommissionNotes() {
    const dealId = currentDealId(); if (!dealId) return;
    const txt = document.getElementById('ptCommNotes').value;
    await _sbPatch(PROPS_TBL, dealId, { commission_notes: txt });
    if (window.currentDeal) window.currentDeal.commission_notes = txt;
    toastOK('Commission notes saved');
  }

  function rerender() {
    if (window.currentTab === 'portal' && window.currentDeal) {
      document.getElementById('tabContent').innerHTML = renderPortalTab(window.currentDeal);
      initPortalTab();
    }
  }

  function initPortalTab() {
    const dealId = currentDealId();
    if (!dealId) return;
    // Refresh view counts quietly.
    const share = sh('share');
    if (share?.id) {
      loadViewCounts(share.id).then(latest => {
        if (!latest) return;
        const cur = sh('share') || {};
        window._portalShareCache = {
          share: { ...cur, view_count: latest.view_count, unique_viewer_count: latest.unique_viewer_count },
          loaded: dealId,
        };
      });
    }
  }

  function toastOK(msg) {
    if (typeof window.toast === 'function') window.toast(msg || 'Saved');
    else if (typeof window.showToast === 'function') window.showToast(msg || 'Saved');
  }

  // Expose globals.
  window.renderPortalTab        = renderPortalTab;
  window.initPortalTab          = initPortalTab;
  window.portalTogglePublish    = portalTogglePublish;
  window.portalCopyLink         = portalCopyLink;
  window.portalOpenPublic       = portalOpenPublic;
  window.portalSaveField        = portalSaveField;
  window.portalToggleHidden     = portalToggleHidden;
  window.portalTogglePhoto      = portalTogglePhoto;
  window.portalToggleShare      = portalToggleShare;
  window.portalSetExpiry        = portalSetExpiry;
  window.portalSaveAuthSource   = portalSaveAuthSource;
  window.portalSaveAuthNotes    = portalSaveAuthNotes;
  window.portalSaveCommission   = portalSaveCommission;
  window.portalSaveCommissionNotes = portalSaveCommissionNotes;
  window.portalSaveHighlights   = portalSaveHighlights;
  window.portalSaveDescription  = portalSaveDescription;

  // Reset cache when the deal changes.
  const _origSetDeal = window.setCurrentDeal;
  window.setCurrentDeal = function (d) {
    window._portalShareCache = {};
    if (typeof _origSetDeal === 'function') return _origSetDeal(d);
    window.currentDeal = d;
  };
})();
