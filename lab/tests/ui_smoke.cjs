// UI smoke test: drives the real Lab UI in headless Chromium through the first-release workflow.
//   node lab/tests/ui_smoke.cjs [python]      (needs the `playwright` npm package and Chromium)
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');

const PY = process.argv[2] || 'python3';
const LAB = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mil-ui-'));
const shots = process.env.MIL_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

function startLab() {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [path.join(LAB, 'launch.py'), '--serve'], { env: { ...process.env, MIL_SETTINGS_DIR: path.join(tmp, 'settings') } });
    p.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]+/); if (m) resolve({ p, url: m[0] }); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('exit', (c) => reject(new Error('Lab exited ' + c)));
  });
}

(async () => {
  const { p: lab, url } = await startLab();
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const step = async (name, fn) => { process.stdout.write(`- ${name} … `); await fn(); await page.screenshot({ path: path.join(shots, name.replace(/\W+/g, '_') + '.png') }); console.log('ok'); };
  try {
    await page.goto(url);
    await step('create workspace with demo material', async () => {
      await page.fill('.panel input >> nth=0', 'UI smoke');
      await page.fill('.panel input >> nth=1', tmp);
      await page.check('input[type=checkbox]');
      await page.click('button:has-text("Create workspace")');
      await page.waitForSelector('text=Capability maturity', { timeout: 300000 });
    });
    const demo = path.join(tmp, 'UI smoke', 'audio', 'demo');
    await step('import a reference with the wizard', async () => {
      await page.click('a[href="#/references"]');
      await page.click('button:has-text("+ Import reference")');
      await page.click('button:has-text("Choose a folder…")');
      await page.fill('.modal-bg:last-child input', path.join(demo, 'references', 'ref-b'));
      await page.click('button:has-text("Use these")');
      await page.waitForSelector('.modal table');
      await page.click('.modal button:has-text("Next")');
      const roles = await page.$$eval('.modal select', (s) => s.map((x) => x.value));
      if (!roles.includes('master') || !roles.includes('vocals')) throw new Error('roles not recognised: ' + roles);
      await page.click('.modal button:has-text("Check files")');
      await page.waitForSelector('.modal .notice', { timeout: 120000 });
      await page.click('.modal button:has-text("Next")');
      await page.click('.modal button:has-text("Add to library")');
      await page.waitForSelector('text=ref-b');
    });
    await step('build a Sound Profile', async () => {
      await page.click('a[href="#/profiles"]');
      await page.click('button:has-text("+ New profile")');
      await page.click('.modal button:has-text("Build profile")');
      await page.waitForSelector('td >> text=Complete', { timeout: 300000 });
    });
    await step('analyse a mix with a known disturbance', async () => {
      await page.click('a[href="#/music"]');
      await page.waitForSelector('text=Operator settings');
      await page.click('button:has-text("Analyse & render")');
      await page.waitForSelector('.vbtn', { timeout: 600000 });
      await page.waitForTimeout(2500);
    });
    await step('play and switch versions without restarting', async () => {
      await page.click('text=▶ Play'); await page.waitForTimeout(1500);
      const t = (s) => +s.split('/')[0].trim().split(':').reduce((a, x) => a * 60 + +x, 0);
      const t1 = t(await page.$eval('.transport .time', (e) => e.textContent));
      await page.keyboard.press('Digit2'); await page.waitForTimeout(700);
      const t2 = t(await page.$eval('.transport .time', (e) => e.textContent));
      if (!(t1 > 0.5 && t2 > t1)) throw new Error(`playback did not continue across the switch (${t1} → ${t2})`);
      await page.keyboard.press('Space');
    });
    await step('record feedback', async () => {
      await page.click('.decision >> nth=0');
      await page.click('.decision.sel button:has-text("Correct adjustment")');
      await page.click('.decision.sel button.primary'); await page.waitForTimeout(600);
      await page.keyboard.press('n'); await page.fill('.modal textarea', 'smoke note'); await page.click('.modal button:has-text("Save note")'); await page.waitForTimeout(600);
      await page.click('.seg button:has-text("Overall evaluation")');
      await page.click('#main table tr:nth-child(1) .seg button:has-text("Improved")');
      await page.click('button.primary:has-text("evaluation")'); await page.waitForTimeout(600);
    });
    await step('blind trial', async () => {
      await page.click('.seg button:has-text("Blind tests")');
      await page.click('button:has-text("Start a blind trial")'); await page.waitForTimeout(2500);
      await page.click('button:has-text("I prefer A")');
      await page.waitForSelector('text=Revealed');
      await page.click('.modal button:has-text("Back to normal listening")'); await page.waitForTimeout(2000);
    });
    await step('export a research package', async () => {
      await page.click('a[href="#/export"]');
      await page.click('button:has-text("Create research package")');
      await page.waitForSelector('text=Package created');
    });
    await step('close and reopen the workspace', async () => {
      await page.click('a[href="#/settings"]');
      await page.click('button:has-text("Close / new workspace…")');
      await page.click('.panel a >> nth=0');
      await page.waitForSelector('text=Capability maturity');
      await page.click('a[href="#/history"]');
      await page.waitForSelector('#main table a');
    });
    if (errors.length) throw new Error('page errors: ' + errors.join('; '));
    console.log(`UI smoke test passed. Screenshots: ${shots}`);
  } catch (e) {
    console.error('\nUI smoke test FAILED:', e.message);
    await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await b.close(); lab.kill();
  }
})();
