// Sammelt alle 15 Min. die tatsächlichen Abfahrten (Verspätung/Ausfall) an zentralen
// Kölner Haltestellen und schreibt eine kompakte Linienstatistik nach stats.json.
// Aufruf: node collector/collect.mjs <pfad/zu/stats.json>
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../stats.js');

const API = process.env.TRANSPORT_API || 'https://v6.db.transport.rest';
const OUT = process.argv[2] || 'stats.json';
const LOCAL = new Set(['tram', 'subway', 'bus', 'suburban', 'regional', 'regionalExpress']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'puenktlich-koeln-stats (github actions)' } });
      if (r.ok) return r.json();
      if (r.status === 429) await sleep(15000);
    } catch { /* retry */ }
    await sleep(2000 * (i + 1));
  }
  throw new Error('fehlgeschlagen: ' + u);
}

function normName(line) {
  const n = String(line.name || '?').trim();
  return n.replace(/^(STR|Str|Tram|Stadtbahn|Bus|BUS|U|S|RB|RE)\s+/, '').trim() || n;
}

const now = Date.now();
let state;
try { state = JSON.parse(await readFile(OUT, 'utf8')); } catch { state = {}; }
state.lines ||= {}; state.stops ||= []; state.seen ||= {};
const names = JSON.parse(await readFile(new URL('./stops.json', import.meta.url), 'utf8'));

// Haltestellen-IDs einmalig auflösen
for (const name of names) {
  if (state.stops.find((s) => s.query === name)) continue;
  try {
    const res = await get('/locations', { query: name, results: 3, addresses: 'false', poi: 'false' });
    const hit = res.find((x) => (x.type === 'stop' || x.type === 'station') && /köln/i.test(x.name));
    if (hit) state.stops.push({ query: name, id: hit.id, name: hit.name, lastEnd: now - 60 * 60e3 });
    else console.warn('nicht gefunden:', name);
  } catch (e) { console.warn(e.message); }
  await sleep(400);
}

let added = 0;
for (const st of state.stops) {
  const from = Math.max(st.lastEnd || 0, now - 90 * 60e3);
  const to = now - 20 * 60e3;                // erst nach 20 Min. ist die Verspätung endgültig
  const dur = Math.floor((to - from) / 60e3);
  if (dur < 5) continue;
  try {
    const res = await get(`/stops/${encodeURIComponent(st.id)}/departures`, {
      when: new Date(from).toISOString(), duration: dur, results: 500, remarks: 'false', linesOfStops: 'false',
    });
    const list = Array.isArray(res) ? res : res.departures || [];
    for (const d of list) {
      if (!d.line || !LOCAL.has(d.line.product)) continue;
      const planned = Date.parse(d.plannedWhen || d.when);
      if (!(planned >= from && planned < to)) continue;
      const id = `${d.tripId}|${st.id}`;
      if (state.seen[id]) continue;
      state.seen[id] = now;
      const name = normName(d.line), key = `${d.line.product}|${name}`;
      const agg = state.lines[key] ||= S.newAgg(key, name, d.line.product);
      S.addObs(agg, { planned, cancelled: !!d.cancelled, delayMin: typeof d.delay === 'number' ? d.delay / 60 : null });
      added++;
    }
    st.lastEnd = to;
  } catch (e) { console.warn(st.name, e.message); }
  await sleep(400);
}

for (const [k, t] of Object.entries(state.seen)) if (now - t > 6 * 3600e3) delete state.seen[k];
for (const a of Object.values(state.lines)) S.pruneDays(a, now);
state.generated = new Date(now).toISOString();
await writeFile(OUT, JSON.stringify(state));
console.log(`${added} neue Fahrten, ${Object.keys(state.lines).length} Linien`);
