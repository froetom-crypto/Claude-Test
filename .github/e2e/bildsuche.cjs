// Echter Test der Reddit-Bildsuche ohne API-Schlüssel (echtes Reddit, echte Modelle). Läuft in GitHub Actions.
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'de-DE' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
  page.on('requestfailed', (r) => console.log('FAILED', r.failure()?.errorText, r.url().slice(0, 160)));
  page.on('response', (r) => {
    const u = r.url();
    if (/reddit\.com|pullpush|wsrv\.nl|huggingface|jsdelivr|redd\.it|imgur/.test(u) && (r.status() >= 300 || /reddit\.com|pullpush/.test(u))) console.log('HTTP', r.status(), u.slice(0, 160));
  });
  await page.goto(process.env.URL || 'http://localhost:8080/bildsuche/');
  const desc = process.env.DESC || 'Eine rote Katze schläft auf einer Fensterbank, draußen schneit es';
  await page.fill('#desc', desc);
  await page.click('#go');
  let last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 12 * 60 * 1000) {
    await page.waitForTimeout(3000);
    const s = (await page.textContent('#status')).trim();
    if (s !== last) { console.log(`STATUS [${Math.round((Date.now() - t0) / 1000)}s]:`, s); last = s; }
    if (await page.$eval('#go', (el) => !el.disabled)) break;
  }
  const results = await page.$$eval('.result', (els) => els.map((e) => `${e.querySelector('.score')?.textContent} | ${e.querySelector('h2').textContent} | ${e.querySelector('a').href}`));
  console.log('ERGEBNISSE:\n' + results.join('\n'));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'bildsuche.png', fullPage: true });
  await b.close();
  if (!results.length) process.exit(1);
})();
