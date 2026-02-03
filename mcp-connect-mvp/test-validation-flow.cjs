#!/usr/bin/env node
/**
 * Automated test for validation flow
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_CLIENT_PATH = path.join(__dirname, 'src/services/anthropicClient.ts');
const OPENAI_CLIENT_PATH = path.join(__dirname, 'src/services/openaiClient.ts');
const SCREENSHOT_DIR = path.join(__dirname, 'test-screenshots');

let anthropicOriginal, openaiOriginal;

function backupFiles() {
  anthropicOriginal = fs.readFileSync(ANTHROPIC_CLIENT_PATH, 'utf8');
  openaiOriginal = fs.readFileSync(OPENAI_CLIENT_PATH, 'utf8');
}

function restoreFiles() {
  if (anthropicOriginal) fs.writeFileSync(ANTHROPIC_CLIENT_PATH, anthropicOriginal);
  if (openaiOriginal) fs.writeFileSync(OPENAI_CLIENT_PATH, openaiOriginal);
  console.log('✓ Restored original files');
}

function injectInvalidAuth() {
  let anthropicCode = fs.readFileSync(ANTHROPIC_CLIENT_PATH, 'utf8');
  anthropicCode = anthropicCode.replace(
    /async checkCliAvailable\(\): Promise<\{ installed: boolean; authenticated: boolean; version\?: string \}> \{\n    const installCheck/,
    `async checkCliAvailable(): Promise<{ installed: boolean; authenticated: boolean; version?: string }> {
    // TEST: Simulating INVALID auth
    console.log('[Anthropic] TEST: Simulating INVALID authentication');
    return { installed: true, authenticated: false, version: 'TEST-INVALID' };
    const installCheck`
  );
  fs.writeFileSync(ANTHROPIC_CLIENT_PATH, anthropicCode);

  let openaiCode = fs.readFileSync(OPENAI_CLIENT_PATH, 'utf8');
  openaiCode = openaiCode.replace(
    /async checkCliAvailable\(\): Promise<\{ installed: boolean; authenticated: boolean; version\?: string \}> \{\n    const installCheck/,
    `async checkCliAvailable(): Promise<{ installed: boolean; authenticated: boolean; version?: string }> {
    // TEST: Simulating INVALID auth
    console.log('[OpenAI] TEST: Simulating INVALID authentication');
    return { installed: true, authenticated: false, version: 'TEST-INVALID' };
    const installCheck`
  );
  fs.writeFileSync(OPENAI_CLIENT_PATH, openaiCode);
  console.log('✓ Injected INVALID auth simulation');
}

function injectValidAuth() {
  let anthropicCode = fs.readFileSync(ANTHROPIC_CLIENT_PATH, 'utf8');
  anthropicCode = anthropicCode.replace(
    /async checkCliAvailable\(\): Promise<\{ installed: boolean; authenticated: boolean; version\?: string \}> \{\n    const installCheck/,
    `async checkCliAvailable(): Promise<{ installed: boolean; authenticated: boolean; version?: string }> {
    // TEST: Simulating VALID auth
    console.log('[Anthropic] TEST: Simulating VALID authentication');
    return { installed: true, authenticated: true, version: 'TEST-VALID' };
    const installCheck`
  );
  fs.writeFileSync(ANTHROPIC_CLIENT_PATH, anthropicCode);

  let openaiCode = fs.readFileSync(OPENAI_CLIENT_PATH, 'utf8');
  openaiCode = openaiCode.replace(
    /async checkCliAvailable\(\): Promise<\{ installed: boolean; authenticated: boolean; version\?: string \}> \{\n    const installCheck/,
    `async checkCliAvailable(): Promise<{ installed: boolean; authenticated: boolean; version?: string }> {
    // TEST: Simulating VALID auth
    console.log('[OpenAI] TEST: Simulating VALID authentication');
    return { installed: true, authenticated: true, version: 'TEST-VALID' };
    const installCheck`
  );
  fs.writeFileSync(OPENAI_CLIENT_PATH, openaiCode);
  console.log('✓ Injected VALID auth simulation');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR);
  }

  console.log('\n========================================');
  console.log('Validation Flow Test');
  console.log('========================================\n');

  backupFiles();

  let browser;
  try {
    // Step 1: Inject INVALID auth
    console.log('Step 1: Injecting INVALID auth...');
    injectInvalidAuth();
    await sleep(3000); // Wait for hot reload

    // Launch browser
    console.log('\nStep 2: Launching browser...');
    browser = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('StartupValidator') || text.includes('TEST') || text.includes('Validation')) {
        console.log('  [Browser]', text);
      }
    });

    // Navigate to app
    console.log('\nStep 3: Navigating to app...');
    await page.goto('http://localhost:5177', { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2000);

    // Click on LLM Providers
    console.log('\nStep 4: Clicking LLM Providers...');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent && btn.textContent.includes('LLM Providers')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await sleep(1500);

    // Screenshot: Error state
    console.log('\nStep 5: Screenshot of ERROR state...');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '1-error-state.png'), fullPage: true });
    console.log('  ✓ Saved: 1-error-state.png');

    // Check for error indicators
    const hasErrors = await page.evaluate(() => {
      const errorBanners = document.querySelectorAll('.validation-error-banner');
      const redStatus = document.querySelectorAll('.status-indicator.red');
      return { banners: errorBanners.length, redIndicators: redStatus.length };
    });
    console.log(`  Found: ${hasErrors.banners} error banner(s), ${hasErrors.redIndicators} red indicator(s)`);

    // Step 6: Click Refresh button
    console.log('\nStep 6: Clicking Refresh button...');
    const refreshClicked = await page.evaluate(() => {
      const btn = document.querySelector('.refresh-btn');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log(`  Refresh clicked: ${refreshClicked}`);
    await sleep(3000);

    // Screenshot after refresh (still invalid)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '2-after-refresh-still-error.png'), fullPage: true });
    console.log('  ✓ Saved: 2-after-refresh-still-error.png');

    // Step 7: Now inject VALID auth
    console.log('\nStep 7: Injecting VALID auth...');
    restoreFiles();
    await sleep(500);
    injectValidAuth();
    await sleep(3000); // Wait for hot reload

    // Reload page
    console.log('\nStep 8: Reloading page...');
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(2000);

    // Click on LLM Providers again
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent && btn.textContent.includes('LLM Providers')) {
          btn.click();
          return true;
        }
      }
    });
    await sleep(1500);

    // Screenshot: Success state
    console.log('\nStep 9: Screenshot of SUCCESS state...');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '3-success-state.png'), fullPage: true });
    console.log('  ✓ Saved: 3-success-state.png');

    // Check for success indicators
    const hasSuccess = await page.evaluate(() => {
      const greenStatus = document.querySelectorAll('.status-indicator.green');
      const errorBanners = document.querySelectorAll('.validation-error-banner');
      return { greenIndicators: greenStatus.length, errorBanners: errorBanners.length };
    });
    console.log(`  Found: ${hasSuccess.greenIndicators} green indicator(s), ${hasSuccess.errorBanners} error banner(s)`);

    // Step 10: Click Refresh to verify validation runs
    console.log('\nStep 10: Clicking Refresh to verify...');
    await page.evaluate(() => {
      const btn = document.querySelector('.refresh-btn');
      if (btn) btn.click();
    });
    await sleep(3000);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '4-after-refresh-success.png'), fullPage: true });
    console.log('  ✓ Saved: 4-after-refresh-success.png');

    console.log('\n========================================');
    console.log('TEST COMPLETE');
    console.log('========================================');
    console.log(`\nScreenshots in: ${SCREENSHOT_DIR}`);
    console.log('  1. 1-error-state.png - Should show red ERROR status');
    console.log('  2. 2-after-refresh-still-error.png - Should still show errors');
    console.log('  3. 3-success-state.png - Should show green ACTIVE status');
    console.log('  4. 4-after-refresh-success.png - Should confirm success after refresh');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
  } finally {
    console.log('\nCleaning up...');
    restoreFiles();
    if (browser) {
      console.log('Closing browser in 3 seconds...');
      await sleep(3000);
      await browser.close();
    }
  }
}

process.on('SIGINT', () => {
  console.log('\nInterrupted, restoring files...');
  restoreFiles();
  process.exit(1);
});

runTest();
