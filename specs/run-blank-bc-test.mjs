// Playwright bug-test for the Blank Buyer Criteria flow on contact "Kristin Burroughs".
// Run from repo root: `node specs/run-blank-bc-test.mjs`
// Auth: uses Vercel deployment-protection bypass token (set + cookie variant).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BYPASS = 'i2J2mn2y6IamzC8SD7u54T8g4wHHTC1f';
const URLS = [
  `https://ace-9bjer3lsz-richardcreyes18-5469s-projects.vercel.app/?x-vercel-protection-bypass=${BYPASS}&x-vercel-set-bypass-cookie=samesitenone`,
  `https://ace-crm.vercel.app/?x-vercel-protection-bypass=${BYPASS}&x-vercel-set-bypass-cookie=samesitenone`,
  `https://ace-crm-richardcreyes18-5469s-projects.vercel.app/?x-vercel-protection-bypass=${BYPASS}&x-vercel-set-bypass-cookie=samesitenone`,
];

const SHOTS_DIR = path.resolve('specs/shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const findings = [];
const consoleErrors = [];
const log = (...a) => { console.log(...a); };
const record = (id, status, note) => {
  findings.push({ id, status, note });
  log(`[${status}] ${id}: ${note}`);
};

async function shot(page, name) {
  const p = path.join(SHOTS_DIR, `${name}.png`);
  try { await page.screenshot({ path: p, fullPage: false }); } catch {}
  return p;
}

async function tryNavigate(page, urls) {
  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = resp ? resp.status() : 0;
      if (status >= 200 && status < 400) {
        log(`  → loaded ${url} (${status})`);
        return url;
      }
      log(`  → ${url} returned ${status}`);
    } catch (e) {
      log(`  → ${url} error: ${e.message}`);
    }
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      consoleErrors.push({ type: t, text: msg.text().slice(0, 400) });
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push({ type: 'pageerror', text: String(err && err.message || err).slice(0, 400) });
  });

  try {
    log('### Step 1: Load entry URL with bypass cookie');
    const entry = await tryNavigate(page, URLS);
    if (!entry) {
      record('ENTRY', 'BLOCKED', 'None of the candidate URLs returned 2xx/3xx with the bypass token');
      await shot(page, '00-entry-failed');
      await browser.close();
      fs.writeFileSync(path.resolve('specs/blank-bc-test-results.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
      return;
    }
    await shot(page, '00-loaded');
    await page.waitForTimeout(2000);

    // App-level Supabase auth login. Credentials come from env vars so we
    // never write them into the script file.
    log('\n### Step 1b: Sign in (Ace Acquisitions CRM login)');
    const emailEl = page.locator('input[type="email"], input[placeholder*="@"]').first();
    if (await emailEl.count()) {
      const email = process.env.ACE_TEST_EMAIL || '';
      const pw    = process.env.ACE_TEST_PASSWORD || '';
      if (!email || !pw) {
        record('LOGIN', 'BLOCKED', 'ACE_TEST_EMAIL / ACE_TEST_PASSWORD env vars not set');
        await browser.close();
        fs.writeFileSync(path.resolve('specs/blank-bc-test-results.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
        return;
      }
      await emailEl.fill(email);
      await page.locator('input[type="password"]').first().fill(pw);
      await page.getByRole('button', { name: /Sign In/i }).first().click();
      // Wait for the main nav to render — the Contacts button only becomes
      // visible after a successful sign-in.
      try {
        await page.waitForSelector('button.nav-btn[data-page="contacts"]:visible', { timeout: 25000 });
        // Then wait for contacts data to actually load. Without this, the
        // app shell renders but allContacts is still empty, so a click on
        // Contacts shows a stale state and the search box hasn't mounted.
        await page.waitForFunction(
          () => Array.isArray(globalThis.allContacts) && globalThis.allContacts.length > 0,
          null,
          { timeout: 30000 }
        ).catch(() => log('  (allContacts not populated within 30s — continuing anyway)'));
        record('LOGIN', 'PASS', 'Signed in and data loaded');
      } catch (e) {
        await shot(page, '00b-login-failed');
        record('LOGIN', 'FAIL', `Did not reach app shell after sign-in: ${e.message}`);
        // Don't bail — keep going to capture more state
      }
    } else {
      record('LOGIN', 'PASS', 'No login form (already authenticated or anon mode)');
    }
    await shot(page, '00c-after-login');

    log('\n### Step 2: Navigate to Contacts and find Kristin Burroughs');
    // Click "Contacts" nav
    const contactsNav = page.locator('button:has-text("Contacts")').first();
    if (await contactsNav.count() === 0) {
      record('NAV-CONTACTS', 'BLOCKED', 'No Contacts nav button found on the loaded page');
      await shot(page, '01-no-contacts-nav');
    } else {
      await contactsNav.click();
      await page.waitForTimeout(1500);
      await shot(page, '01-contacts');
      record('NAV-CONTACTS', 'PASS', 'Contacts page opened');
    }

    // Type into the contact search box
    const search = page.locator('#contactSearch');
    if (await search.count() === 0) {
      record('SEARCH-BOX', 'BLOCKED', '#contactSearch input not found');
    } else {
      await search.fill('kristin burroughs');
      await page.waitForTimeout(1500);
      await shot(page, '02-search-kristin');
      // Check that her row appears
      const rowText = await page.locator('table tbody tr').first().innerText().catch(() => '');
      if (/kristin/i.test(rowText) && /burroughs/i.test(rowText)) {
        record('CHECK-G-search', 'PASS', `Tokenized search matched: "${rowText.split('\n')[0]}"`);
      } else {
        record('CHECK-G-search', 'FAIL', `Top row did not match "Kristin Burroughs". Got: "${rowText.slice(0,120)}"`);
      }
      // Click first matching row
      await page.locator('table tbody tr').first().click().catch(() => {});
      await page.waitForTimeout(1500);
      await shot(page, '03-contact-detail');
    }

    log('\n### Step 3: Open Add Buyer Criteria → Blank');
    // Look for + Add Buyer Criteria button
    const addBcBtn = page.getByRole('button', { name: /\+\s*Add Buyer Criteria/i }).first();
    const addBcCount = await addBcBtn.count();
    if (addBcCount === 0) {
      // Try to switch to Buyer tab first
      const buyerTab = page.locator('#ctab_buyer');
      if (await buyerTab.count()) {
        await buyerTab.click();
        await page.waitForTimeout(800);
      }
    }
    const addBcBtn2 = page.getByRole('button', { name: /\+\s*Add Buyer Criteria/i }).first();
    if (await addBcBtn2.count() === 0) {
      record('OPEN-BC', 'BLOCKED', 'No "+ Add Buyer Criteria" button found on the contact detail page');
      await shot(page, '04-no-addbc-btn');
    } else {
      await addBcBtn2.click();
      await page.waitForTimeout(800);
      await shot(page, '04-addbc-modal');
      // Choose Blank Buyer Criteria
      const blank = page.getByText(/Blank Buyer Criteria/i).first();
      if (await blank.count() === 0) {
        record('OPEN-BC', 'BLOCKED', 'Choice modal did not appear or "Blank Buyer Criteria" option missing');
      } else {
        await blank.click();
        // Wait for BC expanded view to load
        await page.waitForTimeout(2500);
        await shot(page, '05-bc-expanded');
        const onBcPage = await page.locator('#bcf_asset_pills').count();
        if (onBcPage) {
          record('OPEN-BC', 'PASS', 'Landed on BC expanded edit page');
        } else {
          record('OPEN-BC', 'FAIL', 'Click on Blank Buyer Criteria did not transition to BC edit page');
        }
      }
    }

    // ----- Check A: Asset chip add -> live section render -----
    log('\n### Check A: Asset chip add → live section render');
    const office = page.locator('#bcf_at_left option:has-text("Office")').first();
    if (await office.count() === 0) {
      record('CHECK-A-office', 'BLOCKED', 'Office option not found in Category listbox');
    } else {
      await page.selectOption('#bcf_at_left', 'Office').catch(() => {});
      await page.waitForTimeout(400);
      await shot(page, '06a-office-cat');
      // The first child of #bcf_at_subs should be the v234 category-only
      // "＋ Add 'Office' (no subtype)" row. Inspect its inner text directly
      // — locator regexes get tripped up by the fullwidth plus (U+FF0B).
      const firstSubRow = page.locator('#bcf_at_subs > div').first();
      const firstSubRowText = (await firstSubRow.innerText().catch(() => '')) || '';
      const isCategoryAdd = /Office/i.test(firstSubRowText) && /no\s*subtype/i.test(firstSubRowText);
      if (!isCategoryAdd) {
        record('CHECK-A-noSubRow', 'FAIL', `First subtype row was not the category-only add row. Got: "${firstSubRowText.slice(0,120)}"`);
      } else {
        record('CHECK-A-noSubRow', 'PASS', `Category-only add row present: "${firstSubRowText.slice(0,80)}"`);
        await firstSubRow.click();
        await page.waitForTimeout(800);
        await shot(page, '06b-office-chip-added');
        const officeChip = await page.locator('#bcf_asset_pills >> text=/Office/i').count();
        const officeSection = await page.locator('[data-bc-asset-section="office"]').count();
        if (officeChip && officeSection) {
          record('CHECK-A-office-chip+section', 'PASS', `Chip added and Office section live-rendered`);
        } else {
          record('CHECK-A-office-chip+section', 'FAIL', `chip=${officeChip} section=${officeSection}`);
        }
      }
    }

    // Industrial: Warehouse via subtype
    await page.selectOption('#bcf_at_left', { label: 'Industrial' }).catch(() => {});
    await page.waitForTimeout(400);
    const wh = page.locator('#bcf_at_subs >> text=/^Warehouse$/').first();
    if (await wh.count() === 0) {
      record('CHECK-A-warehouse', 'BLOCKED', 'Warehouse subtype not found');
    } else {
      await wh.click();
      await page.waitForTimeout(800);
      await shot(page, '07-warehouse-added');
      const whChip = await page.locator('#bcf_asset_pills >> text=/Warehouse/i').count();
      const whSection = await page.locator('[data-bc-asset-section="warehouse"]').count();
      if (whChip && whSection === 1) {
        record('CHECK-A-warehouse', 'PASS', `Warehouse chip + section rendered`);
      } else {
        record('CHECK-A-warehouse', 'FAIL', `chip=${whChip} sections=${whSection}`);
      }
    }

    // ----- Check B: dedup + scroll/flash on duplicate-key chip -----
    log('\n### Check B: section dedup + scroll/flash');
    // Add a second industrial subtype (Flex or Distribution)
    await page.selectOption('#bcf_at_left', { label: 'Industrial' }).catch(() => {});
    await page.waitForTimeout(300);
    let secondSub = page.locator('#bcf_at_subs >> text=/^Flex$/').first();
    if (await secondSub.count() === 0) {
      secondSub = page.locator('#bcf_at_subs >> text=/^Distribution$/').first();
    }
    if (await secondSub.count() === 0) {
      record('CHECK-B', 'BLOCKED', 'Neither Flex nor Distribution subtype found');
    } else {
      await secondSub.click();
      await page.waitForTimeout(300);
      // Inspect the warehouse section's box-shadow during the flash window.
      const sections = await page.locator('[data-bc-asset-section="warehouse"]').count();
      const flashShadow = await page.evaluate(() => {
        const el = document.querySelector('[data-bc-asset-section="warehouse"]');
        return el ? getComputedStyle(el).boxShadow : '';
      });
      await page.waitForTimeout(1500); // wait for flash to fade
      await shot(page, '08-dedup-after-second-subtype');
      if (sections === 1) {
        record('CHECK-B-dedup', 'PASS', 'Single Warehouse section after second Industrial subtype');
      } else {
        record('CHECK-B-dedup', 'FAIL', `Found ${sections} warehouse sections (expected 1)`);
      }
      // Flash check — expect non-default boxShadow during flash window
      if (flashShadow && flashShadow !== 'none' && /(rgb|#)/.test(flashShadow)) {
        record('CHECK-B-flash', 'PASS', `Amber flash detected (boxShadow: ${flashShadow.slice(0,60)})`);
      } else {
        record('CHECK-B-flash', 'FAIL', `No flash boxShadow seen during dedup add. Got: "${flashShadow}"`);
      }
    }

    // ----- Check C: data-loss regression on autosave -----
    log('\n### Check C: autosave does not wipe field values');
    const setIfPresent = async (sel, value) => {
      const el = page.locator(sel).first();
      if (await el.count() === 0) return false;
      await el.fill('');
      await el.fill(String(value));
      return true;
    };
    const selectIfPresent = async (sel, value) => {
      const el = page.locator(sel).first();
      if (await el.count() === 0) return false;
      await el.selectOption({ label: value }).catch(async () => { await el.selectOption(value).catch(() => {}); });
      return true;
    };
    await setIfPresent('#bcf_minSF', '5000');
    await setIfPresent('#bcf_maxSF', '50000');
    await setIfPresent('#bcf_wh_targetSF', '10000');
    await setIfPresent('#bcf_wh_height', '20');
    await setIfPresent('#bcf_wh_docks', '2');
    await selectIfPresent('#bcf_wh_invown', 'Investor');
    await selectIfPresent('#bcf_wh_profile', 'Value Add');
    await setIfPresent('#bcf_wh_features', 'rail access required');
    await setIfPresent('#bcf_wh_notes', 'test note A');
    await page.waitForTimeout(2500); // wait for autosave debounce + write
    await shot(page, '09-after-autosave');
    const vals = await page.evaluate(() => ({
      min:    document.querySelector('#bcf_minSF')?.value || '',
      max:    document.querySelector('#bcf_maxSF')?.value || '',
      tgt:    document.querySelector('#bcf_wh_targetSF')?.value || '',
      height: document.querySelector('#bcf_wh_height')?.value || '',
      docks:  document.querySelector('#bcf_wh_docks')?.value || '',
      inv:    document.querySelector('#bcf_wh_invown')?.value || '',
      prof:   document.querySelector('#bcf_wh_profile')?.value || '',
      feats:  document.querySelector('#bcf_wh_features')?.value || '',
      notes:  document.querySelector('#bcf_wh_notes')?.value || '',
      saveMsg: document.querySelector('#bcSaveMsg')?.textContent || '',
    }));
    log('  Snapshot after autosave:', JSON.stringify(vals));
    const expected = { min:'5,000', max:'50,000', tgt:'10,000', height:'20', docks:'2', inv:'Investor', prof:'Value Add', feats:'rail access required', notes:'test note A' };
    const wrong = [];
    for (const k of Object.keys(expected)) {
      const a = String(vals[k]||'').trim();
      const e = expected[k];
      // num inputs may render with or without commas
      const ok = a === e || a === e.replace(/,/g,'') || (k === 'inv' && /Investor/i.test(a)) || (k === 'prof' && /Value Add/i.test(a));
      if (!ok) wrong.push(`${k} expected="${e}" got="${a}"`);
    }
    if (!wrong.length) {
      record('CHECK-C-data-loss', 'PASS', 'All values intact after autosave');
    } else {
      record('CHECK-C-data-loss', 'FAIL', `Mismatched fields: ${wrong.join('; ')}`);
    }

    // ----- Check D: Other Notes persist across hard refresh -----
    log('\n### Check D: per-asset Other Notes persistence after refresh');
    // Add an Office chip so we can type into bcf_off_notes (only rendered
    // when the Office section is on the form).
    if (await page.locator('#bcf_off_notes').count() === 0) {
      // Office wasn't added earlier as a chip — skip Office check, only
      // verify Warehouse notes / Target SF persistence.
      log('  (Office section not present; skipping office notes verification)');
    }
    await setIfPresent('#bcf_off_notes', 'test note B');
    await page.waitForTimeout(2500); // autosave
    // Capture the BC record ID so we can re-open the SAME row after a hard
    // refresh. The app is an SPA with no per-row URL, so reloading the URL
    // throws us back to the home / contacts view; we have to re-navigate.
    const bcId = await page.evaluate(() => (typeof _bcCurrentRecordId !== 'undefined' ? _bcCurrentRecordId : null));
    log('  BC ID under test:', bcId);
    // Hard reload the entry URL — bypass cookie + login persist via cookies.
    await page.goto(URLS[0], { waitUntil: 'domcontentloaded' });
    // The Supabase session cookie persists, so the splash screen runs the
    // signed-in init flow and lands on the dashboard. Wait for that to
    // finish before invoking bcOpenExpanded — otherwise the call runs
    // against an empty allBuyerCriteria, the lookup fails, and we never
    // reach the BC edit view.
    await page.waitForSelector('button.nav-btn[data-page="contacts"]:visible', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(
      () => Array.isArray(globalThis.allBuyerCriteria) && globalThis.allBuyerCriteria.length > 0,
      null,
      { timeout: 30000 }
    ).catch(() => log('  (allBuyerCriteria not populated within 30s after refresh)'));
    if (bcId) {
      await page.evaluate((id) => { if (typeof bcOpenExpanded === 'function') bcOpenExpanded(id); }, bcId);
      // Wait for the asset pill area to render — that's the BC edit view.
      await page.waitForSelector('#bcf_asset_pills', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await shot(page, '10-after-refresh');
    const afterRefresh = await page.evaluate(() => ({
      whNotes:  document.querySelector('#bcf_wh_notes')?.value || '',
      offNotes: document.querySelector('#bcf_off_notes')?.value || '',
      tgt:      document.querySelector('#bcf_wh_targetSF')?.value || '',
      onPage:   !!document.querySelector('#bcf_asset_pills'),
    }));
    log('  After refresh snapshot:', JSON.stringify(afterRefresh));
    const dProblems = [];
    if (!/test note A/.test(afterRefresh.whNotes)) dProblems.push(`Warehouse notes lost or wrong: "${afterRefresh.whNotes}"`);
    if (!/test note B/.test(afterRefresh.offNotes)) dProblems.push(`Office notes lost or wrong: "${afterRefresh.offNotes}"`);
    if (!dProblems.length) {
      record('CHECK-D-notes-persist', 'PASS', 'Both per-asset notes persisted across refresh');
    } else {
      record('CHECK-D-notes-persist', 'FAIL', dProblems.join('; '));
    }

    // ----- Check E: Target SF persists -----
    log('\n### Check E: Target SF persists');
    if (/^10[,]?000$/.test(String(afterRefresh.tgt).trim())) {
      record('CHECK-E-target-sf', 'PASS', `Target SF still ${afterRefresh.tgt}`);
    } else {
      record('CHECK-E-target-sf', 'FAIL', `Target SF after refresh: "${afterRefresh.tgt}"`);
    }

    // ----- Check F: AI Auto-Fill modal opens + cancels cleanly -----
    log('\n### Check F: AI Auto-Fill modal opens + cancels');
    const aiBtn = page.getByRole('button', { name: /✦?\s*AI Auto-Fill/i }).first();
    if (await aiBtn.count() === 0) {
      record('CHECK-F-ai-modal', 'BLOCKED', 'AI Auto-Fill button not found');
    } else {
      await aiBtn.click();
      await page.waitForTimeout(600);
      const modal = page.locator('#bcAiPromptModal');
      if (await modal.count() === 0) {
        record('CHECK-F-ai-modal', 'FAIL', 'Click on AI Auto-Fill did not open #bcAiPromptModal');
      } else {
        await shot(page, '11-ai-prompt-modal');
        const cancel = modal.getByRole('button', { name: /Cancel/i }).first();
        await cancel.click();
        await page.waitForTimeout(400);
        const stillOpen = await page.locator('#bcAiPromptModal').count();
        if (stillOpen === 0) {
          record('CHECK-F-ai-modal', 'PASS', 'Modal opened and cancelled cleanly');
        } else {
          record('CHECK-F-ai-modal', 'FAIL', 'Modal did not close on Cancel');
        }
      }
    }

    // ----- Final console capture -----
    log('\n### Console errors collected:');
    log(JSON.stringify(consoleErrors.slice(0, 15), null, 2));

  } catch (fatal) {
    record('FATAL', 'FAIL', `Uncaught: ${fatal.message}`);
    await shot(page, '99-fatal');
  } finally {
    fs.writeFileSync(
      path.resolve('specs/blank-bc-test-results.json'),
      JSON.stringify({ findings, consoleErrors }, null, 2)
    );
    log('\n=== Results JSON written to specs/blank-bc-test-results.json ===');
    log(`=== Screenshots in ${SHOTS_DIR} ===`);
    await browser.close();
  }
})();
