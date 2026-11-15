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
    if (/reddit\.com|pullpush|arctic-shift|openverse|wikimedia\.org\/w\/api|wsrv\.nl|huggingface|jsdelivr|redd\.it|imgur/.test(u) && (r.status() >= 300 || /reddit\.com|pullpush|arctic-shift|openverse\.org\/v1\/images\/\?|w\/api\.php/.test(u))) console.log('HTTP', r.status(), u.slice(0, 160));
  });
  if (process.env.MOCK) {
    // Reddit/PullPush blocken Rechenzentren -> Reddit-Antwort nachbauen, aber mit echten Fotos (Wikimedia)
    const W = 'https://upload.wikimedia.org/wikipedia/commons/';
    const imgs = [
      ['c1', 'My cat Cat03', W + '3/3a/Cat03.jpg'],
      ['c2', 'Cat in November', W + '4/4d/Cat_November_2010-1a.jpg'],
      ['d1', 'Yellow labrador looking', W + '2/26/YellowLabradorLooking_new.jpg'],
      ['c3', 'Kitten', W + 'b/bc/Juvenile_Ragdoll.jpg'],
    ];
    const listing = { data: { children: imgs.map(([id, title, url]) => ({ data: { id, title, subreddit: 'pics', author: 'x', ups: 1, permalink: `/r/pics/comments/${id}/`, post_hint: 'image', url, preview: { images: [{ source: { url, width: 640 }, resolutions: [] }] } } })) } };
    await page.route(/reddit\.com|pullpush\.io/, (r) => r.fulfill({ json: listing, headers: { 'access-control-allow-origin': '*' } }));
    await page.route(/commons\.wikimedia\.org\/w\/api\.php/, (r) => r.fulfill({ json: { query: { pages: {} } }, headers: { 'access-control-allow-origin': '*' } }));
    await page.route(/api\.openverse\.org\/v1\/images\/\?/, (r) => r.fulfill({ json: { results: [] }, headers: { 'access-control-allow-origin': '*' } }));
  }
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
  const results = await page.$$eval('.result', (els) => els.map((e) => `${e.querySelector('.score')?.textContent} | ${e.querySelector('h2').textContent} | ${e.querySelector('.src')?.textContent} | ${e.querySelector('a').href}`));
  console.log('ERGEBNISSE:\n' + results.join('\n'));
  console.log('BILDER GELADEN:', await page.$$eval('.result img', (els) => els.filter((i) => i.naturalWidth > 0).length), 'von', results.length);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `bildsuche-${process.env.SHOT || 'x'}.png`, fullPage: true });
  await b.close();
  if (!results.length) process.exit(1);
  if (process.env.EXPECT_FIRST && !results[0].includes(process.env.EXPECT_FIRST)) { console.log('FALSCHE REIHENFOLGE'); process.exit(1); }
})();
