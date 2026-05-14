const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log('🌐 Opening AceCRM...');
  await page.goto('http://localhost:8000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Login
  console.log('🔐 Logging in...');
  await page.fill('input[type="email"]', 'Richard-reyes@kw.com');
  await page.fill('input[type="password"]', 'Springlake1!');
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(3000);
  console.log('✅ Logged in');

  // Click "Add New Deal" button
  console.log('\n🔍 Clicking Add New Deal...');
  await page.locator('button, a').filter({ hasText: /Add New Deal/i }).first().click();
  await page.waitForTimeout(2000);

  // Click "Seller Lead"
  console.log('🏢 Selecting Seller Lead...');
  await page.locator('button, a, div').filter({ hasText: /^Seller Lead$/i }).first().click().catch(async () => {
    // Fallback: click any element containing "Seller Lead"
    await page.click('text=Seller Lead');
  });
  await page.waitForTimeout(2000);

  // Take screenshot of seller form
  await page.screenshot({ path: '/Users/rickyreyes/Documents/ace-crm/seller-form.png', fullPage: true });
  console.log('📸 Seller form screenshot saved');

  // Get form structure
  const inputs = await page.locator('input, select, textarea').all();
  console.log(`\n📝 Found ${inputs.length} form fields`);

  for (let i = 0; i < Math.min(inputs.length, 25); i++) {
    const placeholder = await inputs[i].getAttribute('placeholder').catch(() => null);
    const name = await inputs[i].getAttribute('name').catch(() => null);
    const id = await inputs[i].getAttribute('id').catch(() => null);
    const type = await inputs[i].getAttribute('type').catch(() => null);
    const tagName = await inputs[i].evaluate(el => el.tagName).catch(() => null);
    if (placeholder || name || id) {
      console.log(`   [${i}] <${tagName}> type=${type} name=${name} id=${id} placeholder="${placeholder}"`);
    }
  }

  // Get all labels visible
  console.log('\n🏷️  Form labels:');
  const labels = await page.locator('label').all();
  for (const label of labels.slice(0, 30)) {
    const text = await label.textContent();
    if (text && text.trim()) console.log(`   - "${text.trim()}"`);
  }

  console.log('\n⏸️  Pausing 30s for browser inspection...');
  await page.waitForTimeout(30000);

  await browser.close();
})();
