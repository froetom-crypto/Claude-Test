// Echter End-to-End-Test gegen die Live-API (läuft in GitHub Actions)
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await b.newPage({ viewport: { width: 390, height: 844 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => m.type() !== 'log' && console.log('CONSOLE', m.type(), m.text()));
  page.on('response', (r) => r.url().includes('transitous') && console.log('API', r.status(), r.url().slice(0, 160)));
  await page.goto('http://localhost:8080/');
  const txt = async (sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();
  // Haltestelle
  await page.click('[data-tab=stop]');
  await page.fill('#stop-q', 'Hamburg Hbf');
  await page.waitForSelector('#stop-suggest li[data-i]', { timeout: 20000 });
  console.log('VORSCHLAEGE:', await txt('#stop-suggest'));
  await page.click('#stop-suggest li[data-i]');
  await page.waitForSelector('#stop-out .card', { timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log('HALTESTELLE:', (await txt('#stop-out')).slice(0, 2500));
  await page.screenshot({ path: 'stop.png', fullPage: true });
  // Route
  await page.click('[data-tab=route]');
  await page.fill('#from', 'Köln Hbf'); await page.waitForSelector('#from-suggest li[data-i]'); await page.click('#from-suggest li[data-i]');
  await page.fill('#to', 'Hamburg Hbf'); await page.waitForSelector('#to-suggest li[data-i]'); await page.click('#to-suggest li[data-i]');
  await page.click('#route-form button.primary');
  await page.waitForSelector('#route-out .hero, #route-out .err, #route-out .card', { timeout: 60000 });
  await page.waitForSelector('#route-out .hero, #route-out .err', { timeout: 60000 }).catch(() => {});
  console.log('ROUTE:', (await txt('#route-out')).slice(0, 3000));
  await page.screenshot({ path: 'route.png', fullPage: true });
  // Linien
  await page.click('[data-tab=lines]'); await page.waitForTimeout(500);
  console.log('LINIEN:', (await txt('#tab-lines')).slice(0, 1500));
  await b.close();
})().catch((e) => { console.log('FEHLER', e); process.exit(1); });
