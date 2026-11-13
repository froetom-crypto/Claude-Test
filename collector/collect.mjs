// Sammelt alle 15 Min. die tatsächlichen Abfahrten (Verspätung/Ausfall) an zentralen
// Kölner Haltestellen und schreibt eine kompakte Linienstatistik nach stats.json.
// Aufruf: node collector/collect.mjs <pfad/zu/stats.json>
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../stats.js');

const API = process.env.TRANSPORT_API || 'https://api.transitous.org';
const OUT = process.argv[2] || 'stats.json';
const MODE = { TRAM: 'tram', SUBWAY: 'subway', METRO: 'subway', BUS: 'bus', SUBURBAN: 'suburban', REGIONAL_RAIL: 'regional', RAIL: 'regional', REGIONAL_FAST_RAIL: 'regionalExpress', HIGHSPEED_RAIL: 'nationalExpress', LONG_DISTANCE: 'national', NIGHT_RAIL: 'national' };
const STATE = OUT.replace(/stats\.json$/, 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let last = '';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'puenktlich-koeln-stats (github actions)' } });
      if (r.ok) return r.json();
      last = 'HTTP ' + r.status;
      if (r.status === 429) await sleep(15000);
      if (r.status === 400 || r.status === 404) break;
    } catch (e) { last = e.message; }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`fehlgeschlagen (${last}): ${u}`);
}

function normName(n) {
  n = String(n || '?').trim();
  return n.replace(/^(STR|Str|Tram|Stadtbahn|Bus|BUS)\s+/, '').trim() || n;
}

const now = Date.now();
let state;
try { state = JSON.parse(await readFile(OUT, 'utf8')); } catch { state = {}; }
try { Object.assign(state, JSON.parse(await readFile(STATE, 'utf8'))); } catch { /* erster Lauf */ }
state.lines ||= {}; state.stops ||= []; state.seen ||= {};
state.stops = state.stops.filter((s) => s.src === 'transitous'); // alte IDs verwerfen
for (const k of Object.keys(state.lines)) if (k.split('|').length < 3) delete state.lines[k]; // alte Schlüssel ohne Verkehrsbetrieb
const names = JSON.parse(await readFile(new URL('./stops.json', import.meta.url), 'utf8'));

// Haltestellen-IDs einmalig auflösen
for (const name of names) {
  if (state.stops.find((s) => s.query === name)) continue;
  try {
    const res = await get('/api/v1/geocode', { text: name, language: 'de' });
    const hit = res.find((x) => x.type === 'STOP' && (x.country || 'DE') === 'DE');
    if (hit) state.stops.push({ src: 'transitous', query: name, id: hit.id, name: hit.name, lastEnd: now - 60 * 60e3 });
    else console.warn('nicht gefunden:', name);
  } catch (e) { console.warn(e.message); }
  await sleep(300);
}

let added = 0;
for (const st of state.stops) {
  const from = Math.max(st.lastEnd || 0, now - 90 * 60e3);
  const to = now - 20 * 60e3;                // erst nach 20 Min. ist die Verspätung endgültig
  if (to - from < 5 * 60e3) continue;
  try {
    // ab 15 Min. vor dem Fenster abfragen, weil die Liste nach tatsächlicher Abfahrt sortiert ist
    const res = await get('/api/v1/stoptimes', { stopId: st.id, time: new Date(from).toISOString(), n: 300 });
    for (const s of res.stopTimes || []) {
      const pl = s.place || {};
      let product = MODE[s.mode];
      if (!product || (s.tripTo && s.tripTo.stopId === pl.stopId)) continue;
      const planned = Date.parse(pl.scheduledDeparture);
      if (!(planned >= from && planned < to)) continue;
      const id = `${s.tripId}|${String(pl.stopId).replace(/:\d+:\d+$/, '')}`;
      if (state.seen[id]) continue;
      state.seen[id] = now;
      const agency = String(s.agencyName || '').trim();
      const nl = S.normLineName(s.routeShortName || s.displayName, product);
      product = nl.product;
      const name = nl.name, key = `${product}|${name}|${agency}`;
      const agg = state.lines[key] ||= S.newAgg(key, name, product, agency);
      const cancelled = !!(s.cancelled || s.tripCancelled || pl.cancelled);
      const delayMin = s.realTime && pl.departure ? (Date.parse(pl.departure) - planned) / 60e3 : null;
      S.addObs(agg, { planned, cancelled, delayMin });
      added++;
    }
    st.lastEnd = to;
  } catch (e) { console.warn(st.name, e.message); }
  await sleep(300);
}

for (const [k, t] of Object.entries(state.seen)) if (now - t > 6 * 3600e3) delete state.seen[k];
for (const a of Object.values(state.lines)) S.pruneDays(a, now);
state.generated = new Date(now).toISOString();
// öffentliche Statistik (lädt die App) und interner Zustand (Dedupe, Haltestellen) getrennt
await writeFile(OUT, JSON.stringify({ generated: state.generated, lines: state.lines }));
await writeFile(STATE, JSON.stringify({ stops: state.stops, seen: state.seen }));
console.log(`${added} neue Fahrten, ${Object.keys(state.lines).length} Linien`);
