// public-page.js — standalone bundle for /deal/<token> (via deal.html).
//
// Handles:
//   • reading the token from the URL
//   • showing the NDA gate (if required)
//   • fetching the deal via the get-shared-deal edge function
//   • rendering the buyer-facing page
//   • handling the "Make an Offer" form
//   • lightweight scroll-depth + duration tracking
//
// No build step. Runs as a classic script via a plain <script defer>.

(function () {
  'use strict';

  const SB_PROJECT = 'https://eoatyremdqilsetmtyfk.supabase.co';
  const ENDPOINT = `${SB_PROJECT}/functions/v1/get-shared-deal`;

  // The anon key is public (anon role).
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvYXR5cmVtZHFpbHNldG10eWZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMzc2NjIsImV4cCI6MjExMDYxMzY2Mn0.S3FrojHoHnoFpV8xci2jDXy_2SXhCg6N_xrsWiSoUR8';

  const $ = (sel) => document.querySelector(sel);

  function getToken() {
    const u = new URL(window.location.href);
    return u.searchParams.get('t') || u.searchParams.get('token')
      || (window.location.pathname.match(/\/deal\/([A-Za-z0-9_-]+)/)?.[1]);
  }

  function fmtMoney(n) {
    const v = Number(n);
    if (!isFinite(v) || v === 0) return '—';
    return '$' + Math.round(v).toLocaleString();
  }
  function fmtPct(n, digits = 2) {
    const v = Number(n);
    if (!isFinite(v) || v === 0) return '—';
    return v.toFixed(digits) + '%';
  }
  function fmtNum(n) {
    const v = Number(n);
    if (!isFinite(v) || v === 0) return '—';
    return Math.round(v).toLocaleString();
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function api(method, body) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANON}`,
        'apikey': ANON,
      },
    };
    let url = ENDPOINT;
    if (method === 'GET') {
      const params = new URLSearchParams(body || {});
      url += '?' + params.toString();
    } else {
      opts.body = JSON.stringify(body || {});
    }
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  // -------- Rendering --------

  function heroPhoto(deal) {
    const atts = Array.isArray(deal.photo_attachments) ? deal.photo_attachments : [];
    if (!atts.length) return null;
    const mainId = deal.main_photo_attachment_id;
    const main = mainId ? atts.find(p => p && p.id === mainId) : null;
    return (main && main.url) || (atts[0] && atts[0].url) || null;
  }

  function assetLabel(deal) {
    return deal.property_type_text
      || deal.legacy_property_type
      || deal.crm_asset_classification
      || 'Commercial Real Estate';
  }
  function marketLabel(deal) {
    const parts = [deal.simple_county, deal.state].filter(Boolean);
    return parts.join(', ') || 'Confidential market';
  }

  function render(deal, share, meta) {
    const root = $('#portalRoot');
    const hero = heroPhoto(deal);
    const addr = deal.address;
    const hidden = !addr;

    const specs = [
      ['Property class', deal.property_class],
      ['Property condition', deal.property_condition],
      ['Building size', deal.total_building_sf ? fmtNum(deal.total_building_sf) + ' SF' : (deal.square_footage ? fmtNum(deal.square_footage) + ' SF' : null)],
      ['Lot size', deal.total_lot_size ? `${fmtNum(deal.total_lot_size)} ${esc(deal.lot_size_unit || 'SF')}` : null],
      ['Year built', deal.year_built],
      ['Year renovated', deal.year_renovated],
      ['Units', deal.number_of_units || deal.no_of_units],
      ['Stories', deal.no_of_stories],
      ['Parking spaces', deal.no_of_parking_spaces],
      ['Construction', deal.construction_type],
      ['Occupancy', deal.occupancy_pct ? fmtPct(deal.occupancy_pct, 1) : null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '0');

    const financials = [];
    const askPrice = deal.asking_price;
    const askStatus = deal.asking_price_status;
    if (askPrice && Number(askPrice) > 0) {
      financials.push(['Asking price', fmtMoney(askPrice)]);
    } else if (askStatus === 'no_asking') {
      financials.push(['Asking price', 'Unpriced']);
    } else if (askStatus === 'make_offer') {
      financials.push(['Asking price', 'Make an offer']);
    }
    if (deal.noi)                        financials.push(['NOI (actual)', fmtMoney(deal.noi)]);
    if (deal.cap_rate_crm)               financials.push(['Cap rate', fmtPct(deal.cap_rate_crm)]);
    if (deal.cap_rate_proforma_crm)      financials.push(['Cap rate (proforma)', fmtPct(deal.cap_rate_proforma_crm)]);
    if (deal.gross_revenue_yearly)       financials.push(['Gross revenue (annual)', fmtMoney(deal.gross_revenue_yearly)]);
    else if (deal.gross_revenue_monthly) financials.push(['Gross revenue (monthly)', fmtMoney(deal.gross_revenue_monthly)]);
    if (deal.pro_forma_gross_revenue_yearly) financials.push(['Proforma revenue (annual)', fmtMoney(deal.pro_forma_gross_revenue_yearly)]);

    const highlights = Array.isArray(deal.property_highlights)
      ? deal.property_highlights.filter(Boolean)
      : (typeof deal.property_highlights === 'string'
          ? deal.property_highlights.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
          : []);

    const photos = (Array.isArray(deal.photo_attachments) ? deal.photo_attachments : [])
      .filter(p => p && p.url);

    const titlePieces = [assetLabel(deal), marketLabel(deal)].filter(Boolean);
    document.title = `${titlePieces.join(' · ')} — CLARKE commercial`;

    root.innerHTML = `
      <div class="portal-top">
        <div class="portal-brand">CLARKE <span>commercial</span></div>
        <div class="portal-conf">Confidential investment opportunity</div>
      </div>
      <div class="portal-page">
        <div class="portal-hero">
          <div class="portal-hero-photo ${hero ? 'has-img' : ''}" style="${hero ? `--hero-url: url('${esc(hero)}'); background-image: url('${esc(hero)}');` : ''}">
            <div class="portal-hero-badge">${esc(assetLabel(deal))}</div>
          </div>
          <div class="portal-hero-body">
            <div class="portal-hero-eyebrow">${esc(marketLabel(deal))}</div>
            <h1 class="portal-hero-title">
              ${hidden ? 'Address disclosed upon NDA acceptance' : esc(addr)}
            </h1>
            <div class="portal-hero-sub">
              ${esc(assetLabel(deal))}${deal.property_class ? ` · Class ${esc(deal.property_class)}` : ''}${deal.year_built ? ` · Built ${esc(deal.year_built)}` : ''}
            </div>
            ${financials.length ? `
              <div class="portal-hero-stats">
                ${financials.slice(0, 4).map(([k, v]) => `
                  <div class="portal-stat">
                    <div class="lbl">${esc(k)}</div>
                    <div class="val ${String(v).length > 10 ? 'sm' : ''}">${esc(v)}</div>
                  </div>
                `).join('')}
              </div>` : ''}
          </div>
        </div>

        ${highlights.length ? `
          <div class="portal-section">
            <h2>Investment Highlights</h2>
            <ul class="portal-highlights">
              ${highlights.map(h => `<li>${esc(h)}</li>`).join('')}
            </ul>
          </div>` : ''}

        ${deal.property_description ? `
          <div class="portal-section">
            <h2>About the Property</h2>
            <div class="portal-description">${esc(deal.property_description)}</div>
          </div>` : ''}

        ${specs.length ? `
          <div class="portal-section">
            <h2>Property Specifications</h2>
            <div class="portal-specs">
              ${specs.map(([k, v]) => `
                <div class="row">
                  <div class="k">${esc(k)}</div>
                  <div class="v">${esc(v)}</div>
                </div>`).join('')}
            </div>
          </div>` : ''}

        ${financials.length > 4 ? `
          <div class="portal-section">
            <h2>Financial Summary</h2>
            <div class="portal-specs">
              ${financials.map(([k, v]) => `
                <div class="row">
                  <div class="k">${esc(k)}</div>
                  <div class="v">${esc(v)}</div>
                </div>`).join('')}
            </div>
          </div>` : ''}

        ${photos.length > 1 ? `
          <div class="portal-section">
            <h2>Gallery</h2>
            <div class="portal-gallery">
              ${photos.slice(0, 12).map(p => `<img src="${esc(p.url)}" alt="${esc(p.filename || '')}" onclick="window.open('${esc(p.url)}','_blank')">`).join('')}
            </div>
          </div>` : ''}

        <div class="portal-cta">
          <h3>Interested in this opportunity?</h3>
          <p>Submit an offer or reach out to the broker directly.</p>
          <button class="portal-btn" id="btnMakeOffer">Make an Offer</button>
          <button class="portal-btn secondary" id="btnContactBroker">Contact Broker</button>
        </div>

        <div class="portal-footer">
          <div class="conf">
            This information is confidential and provided solely for the purpose of evaluating this
            potential investment. By accessing this page, you agree not to reproduce or distribute
            the contents without the express written consent of CLARKE commercial.
          </div>
          <div>© CLARKE commercial · richardcreyes18@gmail.com</div>
        </div>
      </div>
    `;

    $('#btnMakeOffer').addEventListener('click', () => openOfferModal(deal, share, meta));
    $('#btnContactBroker').addEventListener('click', () => {
      window.location.href = 'mailto:richardcreyes18@gmail.com?subject=' +
        encodeURIComponent(`Inquiry re ${hidden ? 'listing ' + share.token : addr}`);
    });

    installTracking(share, meta);
  }

  function renderError(msg) {
    $('#portalRoot').innerHTML = `
      <div class="portal-top">
        <div class="portal-brand">CLARKE <span>commercial</span></div>
      </div>
      <div class="portal-error">
        <h1>This link is no longer available</h1>
        <p>${esc(msg || 'The link may have expired or been revoked. Please contact the broker for an updated link.')}</p>
      </div>`;
  }

  // -------- NDA gate --------

  function openGate(share, token, cb) {
    const el = document.createElement('div');
    el.className = 'portal-gate-backdrop';
    el.innerHTML = `
      <div class="portal-gate">
        <h2>Confidentiality Agreement</h2>
        <p>Before you review this off-market investment, please acknowledge
        the terms below. This information is provided in confidence to
        qualified investors.</p>
        <div class="acknowledgment">
          I agree that the information provided is confidential, will be
          used solely to evaluate this investment, and will not be shared,
          distributed, or publicized. I confirm I am a qualified investor
          or acting on behalf of one.
        </div>
        <div id="gateErr"></div>
        <label>Your email</label>
        <input type="email" id="gateEmail" placeholder="you@firm.com" autocomplete="email" />
        <label>Your name</label>
        <input type="text" id="gateName" placeholder="Jane Investor" autocomplete="name" />
        <button class="portal-btn" id="gateSubmit" style="width:100%;margin-top:8px;">I Agree — Reveal Deal</button>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('gateSubmit').addEventListener('click', async () => {
      const email = document.getElementById('gateEmail').value.trim();
      const errBox = document.getElementById('gateErr');
      if (!email || !email.includes('@')) {
        errBox.innerHTML = '<div class="err">Please enter a valid email.</div>';
        return;
      }
      document.getElementById('gateSubmit').textContent = 'Loading…';
      document.getElementById('gateSubmit').disabled = true;
      const r = await api('POST', { token, action: 'nda_accept', viewer_email: email });
      if (!r.ok) {
        errBox.innerHTML = `<div class="err">${esc(r.data?.error || 'Something went wrong.')}</div>`;
        document.getElementById('gateSubmit').textContent = 'I Agree — Reveal Deal';
        document.getElementById('gateSubmit').disabled = false;
        return;
      }
      sessionStorage.setItem(`nda:${token}`, '1');
      sessionStorage.setItem(`ndaEmail:${token}`, email);
      sessionStorage.setItem(`ndaName:${token}`, document.getElementById('gateName').value.trim());
      if (r.data?.view_id) sessionStorage.setItem(`viewId:${token}`, r.data.view_id);
      el.remove();
      cb(email, r.data?.view_id);
    });
  }

  // -------- Offer modal --------

  function openOfferModal(deal, share, meta) {
    const el = document.createElement('div');
    el.className = 'portal-gate-backdrop';
    const defEmail = sessionStorage.getItem(`ndaEmail:${share.token}`) || '';
    const defName  = sessionStorage.getItem(`ndaName:${share.token}`)  || '';
    el.innerHTML = `
      <div class="portal-gate">
        <h2>Submit an Offer</h2>
        <p>Give the broker the key numbers and they'll follow up. This is not a binding offer.</p>
        <div id="offErr"></div>
        <label>Your name</label>
        <input type="text" id="offName" value="${esc(defName)}" />
        <label>Your email</label>
        <input type="email" id="offEmail" value="${esc(defEmail)}" />
        <label>Offer amount (USD)</label>
        <input type="number" id="offAmount" min="0" step="1000" placeholder="e.g. 4250000" />
        <label>Financing</label>
        <select id="offFinancing">
          <option value="">— pick one —</option>
          <option>All cash</option>
          <option>Conventional</option>
          <option>SBA</option>
          <option>Seller financing</option>
          <option>Bridge</option>
          <option>Other</option>
        </select>
        <label>Target close date (optional)</label>
        <input type="date" id="offClose" />
        <label>Terms / notes</label>
        <textarea id="offTerms" placeholder="Contingencies, DD timeline, inspection period…"></textarea>
        <div style="display:flex;gap:10px;margin-top:4px;">
          <button class="portal-btn secondary" id="offCancel" style="flex:1;">Cancel</button>
          <button class="portal-btn" id="offSubmit" style="flex:1;">Submit Offer</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('offCancel').addEventListener('click', () => el.remove());
    document.getElementById('offSubmit').addEventListener('click', async () => {
      const name = document.getElementById('offName').value.trim();
      const email = document.getElementById('offEmail').value.trim();
      const amount = Number(document.getElementById('offAmount').value);
      const err = document.getElementById('offErr');
      if (!name || !email.includes('@') || !(amount > 0)) {
        err.innerHTML = '<div class="err">Name, valid email and offer amount are required.</div>';
        return;
      }
      document.getElementById('offSubmit').textContent = 'Submitting…';
      document.getElementById('offSubmit').disabled = true;
      const r = await api('POST', {
        token: share.token,
        action: 'submit_offer',
        buyer_name: name,
        buyer_email: email,
        amount,
        financing: document.getElementById('offFinancing').value,
        terms: document.getElementById('offTerms').value,
        closing_date: document.getElementById('offClose').value || null,
        view_id: meta.viewId || sessionStorage.getItem(`viewId:${share.token}`) || null,
      });
      if (!r.ok) {
        err.innerHTML = `<div class="err">${esc(r.data?.error || 'Failed to submit.')}</div>`;
        document.getElementById('offSubmit').textContent = 'Submit Offer';
        document.getElementById('offSubmit').disabled = false;
        return;
      }
      el.innerHTML = `
        <div class="portal-gate" style="text-align:center;">
          <h2 style="color:#16a34a;">Thank you — offer received</h2>
          <p>The broker will be in touch at <strong>${esc(email)}</strong>.</p>
          <button class="portal-btn" id="offDone">Close</button>
        </div>`;
      document.getElementById('offDone').addEventListener('click', () => el.remove());
    });
  }

  // -------- Tracking --------

  function installTracking(share, meta) {
    const started = Date.now();
    let maxScroll = 0;
    const onScroll = () => {
      const h = document.documentElement;
      const pct = Math.round(((h.scrollTop + window.innerHeight) / h.scrollHeight) * 100);
      if (pct > maxScroll) maxScroll = Math.min(100, pct);
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    const send = () => {
      const payload = JSON.stringify({
        token: share.token,
        action: 'view_ping',
        view_id: meta.viewId,
        duration_seconds: Math.round((Date.now() - started) / 1000),
        scroll_depth_pct: maxScroll,
      });
      try {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(ENDPOINT, blob);
      } catch (_) { /* best-effort */ }
    };
    window.addEventListener('beforeunload', send);
    window.addEventListener('pagehide', send);
  }

  // -------- Boot --------

  async function boot() {
    const token = getToken();
    if (!token) { renderError('Missing link token.'); return; }

    // First, look up the share with no logging so we can decide whether
    // the NDA gate is needed before writing a view row.
    const probe = await api('GET', { token });
    if (!probe.ok) {
      renderError(probe.data?.error || 'This link is not available.');
      return;
    }
    const { share } = probe.data;

    const ndaAlready = sessionStorage.getItem(`nda:${token}`) === '1';
    const viewerEmail = sessionStorage.getItem(`ndaEmail:${token}`) || null;

    const afterGate = async (email, viewId) => {
      const r = await api('GET', {
        token,
        log_view: '1',
        nda_accepted: '1',
        viewer_email: email || '',
      });
      if (!r.ok) { renderError(r.data?.error); return; }
      render(r.data.deal, r.data.share, { viewId: viewId || r.data.view_id });
    };

    if (share.nda_required && !ndaAlready) {
      openGate(share, token, afterGate);
    } else {
      await afterGate(viewerEmail, sessionStorage.getItem(`viewId:${token}`));
    }
  }

  boot();
})();
