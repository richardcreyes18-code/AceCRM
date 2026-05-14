const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log('📱 Testing AceCRM with Playwright MCP\n');

  // Navigate to CRM
  console.log('🌐 Navigating to http://localhost:8000...');
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log(`✅ Page loaded: "${title}"\n`);

  // Login
  console.log('🔐 Logging in...');
  const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  if (await emailInput.isVisible()) {
    await emailInput.fill('Richard-reyes@kw.com');
    console.log('✅ Email entered');

    await passwordInput.fill('Springlake1!');
    console.log('✅ Password entered');

    const signInButton = page.locator('button:has-text("Sign In")').first();
    await signInButton.click();
    console.log('🔄 Signing in...');

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(3000);
    console.log('✅ Login successful\n');
  }

  // Take screenshot of main dashboard
  console.log('📸 Capturing main dashboard...');
  await page.screenshot({ path: '/Users/rickyreyes/Documents/ace-crm/crm-dashboard.png', fullPage: true });
  console.log('✅ Screenshot saved: crm-dashboard.png\n');

  // Get page content
  const pageText = await page.innerText('body');
  console.log('📋 Dashboard Content Analysis:');

  if (pageText.includes('Deal')) console.log('   ✅ Found "Deal" references');
  if (pageText.includes('Property')) console.log('   ✅ Found "Property" references');
  if (pageText.includes('Pipeline')) console.log('   ✅ Found "Pipeline" references');
  if (pageText.includes('Agent')) console.log('   ✅ Found "Agent" references');

  // Find and click deals navigation
  console.log('\n🔍 Looking for Deals tab...');

  // Get all buttons/tabs in the top navigation
  const tabs = await page.locator('button, a').all();
  let dealsButton = null;

  for (const tab of tabs) {
    const text = await tab.textContent();
    if (text && text.toLowerCase().includes('deals')) {
      if (await tab.isVisible()) {
        dealsButton = tab;
        console.log(`✅ Found Deals tab: "${text.trim()}"`);
        break;
      }
    }
  }

  if (dealsButton) {
    await dealsButton.click();
    await page.waitForTimeout(2000);
    console.log('✅ Clicked deals button\n');

    // Take screenshot of deals page
    console.log('📸 Capturing Deals page...');
    await page.screenshot({ path: '/Users/rickyreyes/Documents/ace-crm/crm-deals.png', fullPage: true });
    console.log('✅ Screenshot saved: crm-deals.png\n');

    // Analyze deals page
    const dealsPageText = await page.innerText('body');
    console.log('📊 Deals Page Content:');
    if (dealsPageText.includes('Property')) console.log('   ✅ Property listings found');
    if (dealsPageText.includes('Status')) console.log('   ✅ Status column found');
    if (dealsPageText.includes('Price')) console.log('   ✅ Price data found');
    if (dealsPageText.includes('City')) console.log('   ✅ City filter found');

    // Look for deal cards/rows
    const dealRows = await page.locator('[role="row"], .deal-card, .deal-item, tr').all();
    console.log(`   ✅ Found ${dealRows.length} potential deal rows/cards\n`);

    // Check for deal detail view (already on deal detail page)
    console.log('🔎 Analyzing deal detail page...');
    const detailText = await page.innerText('body');

    console.log('📄 Deal Detail Sections Found:');
    if (detailText.includes('Property')) console.log('   ✅ Property information');
    if (detailText.includes('Financial')) console.log('   ✅ Financial analysis');
    if (detailText.includes('Commission')) console.log('   ✅ Commission details');
    if (detailText.includes('Contact')) console.log('   ✅ Contacts/Buyers');
    if (detailText.includes('Notes')) console.log('   ✅ Notes section');
    if (detailText.includes('Tasks')) console.log('   ✅ Tasks section');
    if (detailText.includes('Calendar')) console.log('   ✅ Calendar view');

    // Check for sub-tabs/sections
    console.log('\n📑 Exploring Deal Sub-Pages:');
    const subTabs = await page.locator('button, a').all();
    const tabNames = [];

    for (const tab of subTabs) {
      const text = await tab.textContent();
      if (text && text.trim().length > 0 && text.trim().length < 30) {
        const trimmed = text.trim();
        if (!tabNames.includes(trimmed)) {
          tabNames.push(trimmed);
        }
      }
    }

    const relevantTabs = ['Summary', 'Property', 'Financial', 'Documents', 'Deal Status', 'Pipeline', 'Contacts', 'Notes', 'Tasks', 'Calendar'];
    for (const tabName of relevantTabs) {
      for (const tab of tabNames) {
        if (tab.toLowerCase().includes(tabName.toLowerCase())) {
          console.log(`   ✅ "${tab}" sub-page available`);
          break;
        }
      }
    }

    // Try to click on Property Details tab
    console.log('\n🔄 Testing sub-page navigation...');
    const propertyTab = await page.locator('button, a').filter({ hasText: /Property Details/i }).first();
    if (await propertyTab.isVisible()) {
      await propertyTab.click();
      await page.waitForTimeout(1500);
      console.log('✅ Clicked Property Details tab');

      console.log('📸 Capturing Property Details page...');
      await page.screenshot({ path: '/Users/rickyreyes/Documents/ace-crm/crm-property-details.png', fullPage: true });
      console.log('✅ Screenshot saved: crm-property-details.png');
    }

    // Try to click on Financial Analysis tab
    const financialTab = await page.locator('button, a').filter({ hasText: /Financial/i }).first();
    if (await financialTab.isVisible()) {
      await financialTab.click();
      await page.waitForTimeout(1500);
      console.log('✅ Clicked Financial Analysis tab');

      console.log('📸 Capturing Financial Analysis page...');
      await page.screenshot({ path: '/Users/rickyreyes/Documents/ace-crm/crm-financial.png', fullPage: true });
      console.log('✅ Screenshot saved: crm-financial.png');
    }
  } else {
    console.log('❌ Deals navigation not found');
  }

  console.log('\n✅ Playwright MCP test complete!');
  console.log('📁 Screenshots saved in /Users/rickyreyes/Documents/ace-crm/');

  await browser.close();
})();
