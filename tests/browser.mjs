import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import axe from 'axe-core';

const executablePath = process.env.BROWSER_BIN || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4185', '--strictPort'], { stdio: 'pipe' });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview server did not start.')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('4185')) { clearTimeout(timer); resolve(); } });
    server.on('error', reject);
  });
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4185/');
  await page.getByRole('button', { name: 'Kick-off and site briefing', exact: true }).waitFor();
  if (process.env.PLANNER_SCREENSHOT) await page.screenshot({ path: process.env.PLANNER_SCREENSHOT, animations: 'disabled' });
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(() => globalThis.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] }));
  assert.deepEqual(result.violations.map(x => ({ id: x.id, targets: x.nodes.map(node => node.target) })), []);

  const dragBar = page.getByRole('button', { name: /^Edit Kick-off and site briefing/ });
  const oldLabel = await dragBar.getAttribute('aria-label');
  const bar = await dragBar.boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2 + 34, bar.y + bar.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  await page.waitForFunction(old => document.querySelector('button[aria-label^="Edit Kick-off and site briefing"]')?.getAttribute('aria-label') !== old, oldLabel);
  assert.notEqual(await dragBar.getAttribute('aria-label'), oldLabel);
  const handle = await page.locator('.bar-shell').filter({ has: dragBar }).locator('.resize-handle.end').boundingBox();
  const movedLabel = await dragBar.getAttribute('aria-label');
  await page.mouse.move(handle.x + 4, handle.y + 7);
  await page.mouse.down(); await page.mouse.move(handle.x + 21, handle.y + 7, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(old => document.querySelector('button[aria-label^="Edit Kick-off and site briefing"]')?.getAttribute('aria-label') !== old, movedLabel);
  await dragBar.press('Enter');
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('dialog').getByLabel('% Complete', { exact: true }).inputValue(), '100');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const scale of ['Month', 'Quarter', 'Year', 'Week']) {
    await page.getByRole('button', { name: scale, exact: true }).click();
    assert.equal(await page.getByRole('button', { name: scale, exact: true }).getAttribute('aria-pressed'), 'true');
  }
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name').fill('Browser test project');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('Filter by project').selectOption({ label: 'Browser test project' });
  await page.getByRole('button', { name: 'Add task', exact: false }).first().click();
  await page.getByLabel('Task name').fill('Browser test task');
  await page.getByRole('dialog').locator('select[name=status]').selectOption('In Progress');
  assert.equal(await page.getByLabel('% Complete', { exact: true }).inputValue(), '50');
  await page.getByLabel('% Complete', { exact: true }).fill('35');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: 'Browser test task', exact: true }).waitFor();

  const workbook = process.env.PLANNER_TEST_WORKBOOK;
  if (workbook && existsSync(workbook)) {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.locator('input[type=file]').setInputFiles(workbook);
    await page.getByRole('heading', { name: 'Review import' }).waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes('45'));
    assert.equal(await page.getByRole('button', { name: 'Confirm import' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Close panel' }).click();
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto('http://127.0.0.1:4185/');
  await mobile.getByRole('button', { name: 'Kick-off and site briefing', exact: true }).click();
  await mobile.getByRole('dialog').waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(errors, []);
  console.log('Desktop and mobile interactions, keyboard editing, persistence and axe accessibility checks passed.');
} finally {
  await browser?.close();
  server.kill();
}
