/* Pünktlich Köln – Verspätungsstatistik & Abfahrtsplanung für KVB-Stadtbahn und Busse */
(function () {
  'use strict';
  const S = window.PStats;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Speicher (immer mit try/catch) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
  };

  const DEFAULTS = { thr: 3, api: 'https://api.transitous.org', remote: 'https://raw.githubusercontent.com/froetom-crypto/Claude-Test/stats-data/stats.json', collect: true };
  let cfg = { ...DEFAULTS, ...store.get('pk.cfg', {}) };
  if (/transport\.rest/.test(cfg.api)) cfg.api = DEFAULTS.api; // alte, abgeschaltete Schnittstelle
  if (!cfg.remote) cfg.remote = DEFAULTS.remote;
  let favs = store.get('pk.favs', []);            // [{id,name}]
  let local = store.get('pk.lines', {});          // key -> Aggregat
  let seen = store.get('pk.seen', {});            // obsId -> zeitstempel (Dedupe)
  let remote = store.get('pk.remote', null);      // {generated, lines}
  // alte Schlüssel ohne Verkehrsbetrieb verwerfen (vor der Deutschland-Erweiterung)
  for (const k of Object.keys(local)) if (k.split('|').length < 3) delete local[k];
  if (remote && remote.lines) for (const k of Object.keys(remote.lines)) if (k.split('|').length < 3) delete remote.lines[k];

  // ---------- Hilfen ----------
  const hm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  const pct = (x, d = 0) => (x == null ? '–' : (x * 100).toFixed(d).replace('.', ',') + ' %');
  const num = (x, d = 1) => (x == null ? '–' : x.toFixed(d).replace('.', ','));
  function level(p) {
    if (p == null) return { cls: '', txt: 'keine Daten' };
    if (p >= 0.9) return { cls: 'st-good', txt: 'sehr zuverlässig' };
    if (p >= 0.8) return { cls: 'st-warn', txt: 'meist pünktlich' };
    if (p >= 0.65) return { cls: 'st-serious', txt: 'unzuverlässig' };
    return { cls: 'st-critical', txt: 'sehr unzuverlässig' };
  }
  const statusTag = (p, txt) => { const l = level(p); return `<span class="status ${l.cls}">${esc(txt || l.txt)}</span>`; };

  const PRODUCT = {
    tram: 'Bahn', subway: 'U-Bahn', bus: 'Bus', suburban: 'S-Bahn', regional: 'RB',
    regionalExpress: 'RE', national: 'IC', nationalExpress: 'ICE', ferry: 'Fähre', taxi: 'Taxi',
  };
  function normLine(line) {
    if (!line) return null;
    const { name, product } = S.normLineName(line.name || line.fahrtNr, line.product || 'unknown');
    const agency = String(line.agency || '').trim();
    return { key: `${product}|${name}|${agency}`, name, product, agency, label: name };
  }
  const productName = (p) => PRODUCT[p] || p;
  // "Bahn 18", aber "RE8", "S11", "ICE" ohne doppelte Gattung
  const lineTitle = (l) => (/^(S|U|RE|RB|ICE|ICD|IC|EC|ECE|NJ|RJX?|FLX|FlixBus)/i.test(l.label || l.name) ? (l.label || l.name) : `${productName(l.product)} ${l.label || l.name}`);

  // ---------- API ----------
  const cache = new Map();
  let netErr = 0;
  async function api(path, params = {}, ttl = 60e3) {
    const u = new URL(cfg.api.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    const key = u.toString();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.p;
    const p = (async () => {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 15000);
        try {
          const r = await fetch(key, { signal: ctl.signal, headers: { accept: 'application/json' } });
          clearTimeout(to);
          if (r.status === 429) throw new Error('Zu viele Anfragen – bitte kurz warten.');
          if (!r.ok) throw new Error(`Auskunft antwortet mit Fehler ${r.status}`);
          netErr = 0; setNet();
          return await r.json();
        } catch (e) {
          clearTimeout(to);
          lastErr = e.name === 'AbortError' ? new Error('Zeitüberschreitung bei der Auskunft') : e instanceof TypeError ? new Error('Keine Verbindung zur Live-Auskunft (offline, oder diese Ansicht blockiert Internetzugriffe).') : e;
          await new Promise((res) => setTimeout(res, 700));
        }
      }
      netErr++; setNet();
      throw lastErr;
    })();
    cache.set(key, { t: Date.now(), p });
    p.catch(() => cache.delete(key));
    return p;
  }
  function setNet() {
    const el = $('#net');
    el.textContent = !navigator.onLine ? 'offline' : netErr ? 'Auskunft gestört' : 'live';
  }
  addEventListener('online', setNet); addEventListener('offline', setNet);

  // ---------- Adapter für Transitous (MOTIS-API, freie Fahrplan- und Echtzeitdaten) ----------
  const MODE = {
    TRAM: 'tram', SUBWAY: 'subway', METRO: 'subway', BUS: 'bus', COACH: 'bus', SUBURBAN: 'suburban',
    REGIONAL_RAIL: 'regional', RAIL: 'regional', REGIONAL_FAST_RAIL: 'regionalExpress',
    HIGHSPEED_RAIL: 'nationalExpress', LONG_DISTANCE: 'national', NIGHT_RAIL: 'national', FERRY: 'ferry', ODM: 'taxi',
  };
  const TRANSIT = (m) => !!MODE[m] || (m && !['WALK', 'BIKE', 'CAR', 'RENTAL', 'FLEX', 'CAR_PARKING', 'CAR_DROPOFF'].includes(m));
  const KOELN = [50.9375, 6.9603];
  const distKm = (lat, lon) => Math.hypot((lat - KOELN[0]) * 111, (lon - KOELN[1]) * 70);
  const stationOf = (id) => String(id || '').replace(/:\d+:\d+$/, '');

  async function searchLocations(q) {
    const res = await api('/api/v1/geocode', { text: q, language: 'de' }, 300e3);
    return (Array.isArray(res) ? res : []).filter((x) => x && Number.isFinite(x.lat)).map((x) => {
      const city = (x.areas || []).find((a) => a.default)?.name || '';
      const isStop = x.type === 'STOP';
      const name = x.type === 'ADDRESS' ? [x.street || x.name, x.houseNumber].filter(Boolean).join(' ') + (city ? ', ' + city : '') : x.name;
      return { type: isStop ? 'stop' : 'location', poi: x.type === 'PLACE', id: x.id, name, address: name, latitude: x.lat, longitude: x.lon, city, d: distKm(x.lat, x.lon) };
    }).map((x, i) => ({ ...x, i })).sort((a, b) => ((a.d < 60 ? 0 : 1) - (b.d < 60 ? 0 : 1)) || a.i - b.i); // Köln & Umgebung zuerst, sonst ganz Deutschland
  }

  function normDep(s) {
    const pl = s.place || {};
    const line = normLine({ name: s.routeShortName || s.displayName || s.tripShortName, product: MODE[s.mode] || 'unknown', agency: s.agencyName });
    const planned = Date.parse(pl.scheduledDeparture || pl.departure);
    const when = pl.departure ? Date.parse(pl.departure) : null;
    const cancelled = !!(s.cancelled || s.tripCancelled || pl.cancelled);
    return {
      id: `${s.tripId || line.key + '@' + planned}|${stationOf(pl.stopId)}`,
      tripId: s.tripId, line, direction: s.headsign || s.tripTo?.name || '', planned, when: cancelled ? null : when,
      delayMin: s.realTime && when ? (when - planned) / 60e3 : null, cancelled,
      platform: pl.track || pl.scheduledTrack || '', stopId: pl.stopId, stopName: pl.name, city: S.cityOf(pl.lat, pl.lon),
      ends: !!(s.tripTo && s.tripTo.stopId === pl.stopId),
    };
  }

  async function departures(stopId, from, durationMin, ttl = 60e3) {
    const res = await api('/api/v1/stoptimes', {
      stopId, time: new Date(from).toISOString(), n: Math.min(300, Math.max(40, Math.round(durationMin * 1.6))),
    }, ttl);
    const end = from + durationMin * 60e3;
    return (res.stopTimes || []).map(normDep)
      .filter((d) => d.line && !d.ends && Number.isFinite(d.planned) && d.planned >= from && d.planned < end);
  }

  function normItinerary(it) {
    return {
      legs: (it.legs || []).map((l) => {
        const pDep = l.from?.scheduledDeparture || l.scheduledStartTime || l.startTime;
        const dep = l.from?.departure || l.startTime;
        const pArr = l.to?.scheduledArrival || l.scheduledEndTime || l.endTime;
        const arr = l.to?.arrival || l.endTime;
        const base = {
          origin: { id: l.from?.stopId, name: l.from?.name === 'START' ? 'Start' : l.from?.name },
          destination: { id: l.to?.stopId, name: l.to?.name === 'END' ? 'Ziel' : l.to?.name },
          plannedDeparture: pDep, departure: dep, plannedArrival: pArr, arrival: arr,
        };
        if (!TRANSIT(l.mode)) return { ...base, walking: true };
        return {
          ...base,
          departureDelay: l.realTime ? (Date.parse(dep) - Date.parse(pDep)) / 1000 : null,
          line: { name: l.routeShortName || l.displayName || l.tripShortName || '?', product: MODE[l.mode] || 'unknown', agency: l.agencyName },
          direction: l.headsign || '', cancelled: !!(l.cancelled || l.tripCancelled),
          departurePlatform: l.from?.track || l.from?.scheduledTrack || '',
        };
      }),
    };
  }

  async function searchJourneys(from, to, target, onlyLocal, cursor) {
    const params = { fromPlace: placeParam(from), toPlace: placeParam(to), numItineraries: 6 };
    if (cursor) params.pageCursor = cursor; else { params.time = new Date(target).toISOString(); params.arriveBy = 'true'; }
    if (onlyLocal) params.transitModes = 'TRAM,SUBWAY,BUS,SUBURBAN,REGIONAL_RAIL,REGIONAL_FAST_RAIL,FERRY';
    let res;
    try { res = await api('/api/v1/plan', params, 30e3); }
    catch (e) { if (!onlyLocal) throw e; delete params.transitModes; res = await api('/api/v1/plan', params, 30e3); }
    return { journeys: (res.itineraries || []).map(normItinerary), earlierRef: res.previousPageCursor };
  }

  // Vergangene Abfahrten haben endgültige Verspätungen → in die Statistik
  // nur die letzten 3 Stunden – ältere Echtzeitdaten sind oft nicht mehr verlässlich
  const isFinal = (d, now) => d.planned > now - 3 * 3600e3 && (d.cancelled ? d.planned < now : (d.planned + (d.delayMin || 0) * 60e3) < now - 2 * 60e3);

  function record(deps) {
    const now = Date.now();
    let added = 0;
    for (const d of deps) {
      if (!isFinal(d, now) || seen[d.id]) continue;
      seen[d.id] = now;
      const a = local[d.line.key] || (local[d.line.key] = S.newAgg(d.line.key, d.line.label, d.line.product, d.line.agency));
      S.addObs(a, { planned: d.planned, delayMin: d.delayMin, cancelled: d.cancelled, city: d.city });
      added++;
    }
    if (added) {
      for (const [k, t] of Object.entries(seen)) if (now - t > 3 * 864e5) delete seen[k];
      for (const a of Object.values(local)) S.pruneDays(a, now);
      store.set('pk.lines', local); store.set('pk.seen', seen);
    }
    return added;
  }

  function aggFromDeps(deps) {
    const now = Date.now(), out = {};
    for (const d of deps) {
      if (!isFinal(d, now)) continue;
      const a = out[d.line.key] || (out[d.line.key] = S.newAgg(d.line.key, d.line.label, d.line.product, d.line.agency));
      S.addObs(a, { planned: d.planned, delayMin: d.delayMin, cancelled: d.cancelled, city: d.city });
    }
    return out;
  }

  async function loadRemote(force) {
    if (!cfg.remote) return;
    if (!force && remote && Date.now() - (remote.fetched || 0) < 30 * 60e3) return;
    try {
      const r = await fetch(cfg.remote, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const lines = j.lines || {};
      for (const k of Object.keys(lines)) if (k.split('|').length < 3) delete lines[k];
      remote = { generated: j.generated, lines, fetched: Date.now() };
      store.set('pk.remote', remote);
    } catch (e) { console.warn('Server-Statistik nicht ladbar', e); }
  }
  const allLines = (src = 'all') =>
    src === 'local' ? local : src === 'remote' ? (remote?.lines || {}) : S.mergeMaps(local, remote?.lines);

  // ---------- Diagramme (Inline-SVG, eine Reihe, Hover-Tooltips) ----------
  function barChart({ values, labels, tips, max, dim = [], height = 120, yFmt = (v) => v, ticks }) {
    const W = 320, H = height, L = 30, B = 18, T = 6;
    const n = values.length, pw = W - L - 4, ph = H - B - T;
    const mx = max ?? Math.max(1, ...values.filter((v) => v != null));
    const bw = pw / n, gap = Math.min(2, bw * 0.25);
    const y = (v) => T + ph - (v / mx) * ph;
    const tk = ticks || [0, mx / 2, mx];
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
    for (const t of tk) s += `<line class="gridl" x1="${L}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 4}" y="${y(t) + 3}" text-anchor="end">${esc(yFmt(t))}</text>`;
    values.forEach((v, i) => {
      const x = L + i * bw + gap / 2, w = Math.max(1, bw - gap);
      s += `<g data-tip="${esc(tips[i])}">`;
      if (v != null && v > 0) {
        const h = Math.max(1, (v / mx) * ph), top = T + ph - h, r = Math.min(4, w / 2, h);
        // oben abgerundet, unten am Nulllinie verankert
        s += `<path class="bar${dim[i] ? ' dim' : ''}" d="M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${T + ph} Z"/>`;
      }
      s += `<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ph + B}"/></g>`;
      if (labels[i]) s += `<text x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${esc(labels[i])}</text>`;
    });
    s += `<line class="base" x1="${L}" x2="${W - 4}" y1="${T + ph}" y2="${T + ph}"/></svg>`;
    return s;
  }
  // Tooltip-Ebene
  const tip = $('#tip');
  function showTip(e) {
    const g = e.target.closest('[data-tip]');
    if (!g) { tip.hidden = true; return; }
    tip.textContent = g.dataset.tip; tip.hidden = false;
    const p = e.touches ? e.touches[0] : e;
    const x = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, p.clientX - tip.offsetWidth / 2));
    tip.style.left = x + 'px'; tip.style.top = Math.max(8, p.clientY - tip.offsetHeight - 14) + 'px';
  }
  document.addEventListener('pointermove', showTip);
  document.addEventListener('pointerdown', showTip);
  document.addEventListener('scroll', () => (tip.hidden = true), true);

  function lineProfileHTML(agg, title, opts = {}) {
    const thr = cfg.thr;
    const s = S.summary(agg, thr);
    const lv = level(s.punct);
    // Verteilung 0..15+
    const H = agg.hist.slice(0, 15).concat([agg.hist.slice(15).reduce((a, b) => a + b, 0)]);
    const tot = s.tot || 1;
    const hv = H.map((v) => (v / tot) * 100);
    const hist = barChart({
      values: hv.concat([(agg.cx / tot) * 100]),
      labels: H.map((_, i) => (i % 3 === 0 ? (i === 15 ? '15+' : String(i)) : '')).concat(['✕']),
      tips: H.map((v, i) => `${i === 15 ? '≥15' : i} Min.: ${pct(v / tot, 1)} (${v} Fahrten)`).concat([`Ausgefallen: ${pct(agg.cx / tot, 1)} (${agg.cx})`]),
      yFmt: (v) => Math.round(v) + '%',
    });
    let hours = '';
    const hp = agg.hours.map((c) => S.coarsePunct(c, thr));
    if (hp.some((h) => h.tot)) {
      hours = `<h3 style="margin-top:14px">Pünktlichkeit nach Uhrzeit</h3>` + barChart({
        values: hp.map((h) => (h.punct == null ? null : h.punct * 100)), max: 100, ticks: [0, 50, 100],
        labels: hp.map((_, i) => (i % 3 === 0 ? String(i) : '')),
        tips: hp.map((h, i) => `${i}–${i + 1} Uhr: ${h.tot ? pct(h.punct) + ' pünktlich, ' + pct(h.cancel, 1) + ' Ausfall' : 'keine Daten'} (${h.tot} Fahrten)`),
        dim: hp.map((h) => h.tot < 10), yFmt: (v) => v + '%',
      }) + `<p class="note">Blasse Balken: weniger als 10 Fahrten – noch wenig aussagekräftig.</p>`;
    }
    let wd = '';
    const wp = agg.wd.map((c) => S.coarsePunct(c, thr));
    if (wp.filter((h) => h.tot).length > 1) {
      const names = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      wd = `<h3 style="margin-top:14px">Nach Wochentag</h3>` + barChart({
        values: wp.map((h) => (h.punct == null ? null : h.punct * 100)), max: 100, ticks: [0, 50, 100], height: 100,
        labels: names, tips: wp.map((h, i) => `${names[i]}: ${h.tot ? pct(h.punct) + ' pünktlich' : 'keine Daten'} (${h.tot})`),
        dim: wp.map((h) => h.tot < 10), yFmt: (v) => v + '%',
      });
    }
    let trend = '';
    const days = Object.keys(agg.days).sort().slice(-30);
    if (days.length > 2) {
      const dp = days.map((d) => S.coarsePunct(agg.days[d], thr));
      trend = `<h3 style="margin-top:14px">Verlauf (Tage)</h3>` + barChart({
        values: dp.map((h) => (h.punct == null ? null : h.punct * 100)), max: 100, ticks: [0, 50, 100], height: 100,
        labels: days.map((d, i) => (i === 0 || i === days.length - 1 ? d.slice(8) + '.' + d.slice(5, 7) + '.' : '')),
        tips: dp.map((h, i) => `${days[i].split('-').reverse().join('.')}: ${pct(h.punct)} pünktlich, ${pct(h.cancel, 1)} Ausfall (${h.tot})`),
        dim: dp.map((h) => h.tot < 10), yFmt: (v) => v + '%',
      });
    }
    return `<div class="card">
      <div class="jhead"><h2>${esc(title)}</h2>${statusTag(s.punct)}</div>
      ${opts.sub ? `<p class="muted small" style="margin:0">${esc(opts.sub)}</p>` : ''}
      <div class="kpis">
        <div class="kpi"><b>${pct(s.punct)}</b><span>pünktlich (&lt;${thr} Min.)</span></div>
        <div class="kpi"><b>${pct(s.cancel, 1)}</b><span>Ausfälle</span></div>
        <div class="kpi"><b>${num(s.mean)}</b><span>Ø Min. Verspätung</span></div>
        <div class="kpi"><b>${pct(s.late5)}</b><span>≥ 5 Min. zu spät</span></div>
        <div class="kpi"><b>${s.n ? s.p90 + (s.p90 >= 30 ? '+' : '') : '–'}</b><span>Min. (9 von 10 besser)</span></div>
        <div class="kpi"><b>${s.tot}</b><span>Fahrten ausgewertet</span></div>
      </div>
      <h3 style="margin-top:6px">Verteilung der Verspätung (Minuten)</h3>${hist}
      ${hours}${wd}${trend}
      ${agg.nort ? `<p class="note">${agg.nort} Fahrten ohne Echtzeitdaten wurden nicht mitgezählt.</p>` : ''}
    </div>`;
  }

  // ---------- Ortssuche mit Vorschlägen ----------
  function attachSuggest(input, list, onPick, opts = {}) {
    let timer, seq = 0;
    input.addEventListener('input', () => {
      input._picked = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { list.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          let res = await searchLocations(q);
          if (opts.stopsOnly) res = res.filter((x) => x.type === 'stop');
          if (my !== seq) return;
          list.innerHTML = res.map((x, i) => `<li role="option" data-i="${i}">${esc(x.name || x.address)}<small>${x.type === 'stop' ? 'Haltestelle' : x.poi ? 'Ort' : 'Adresse'}${x.city && !String(x.name).includes(x.city) ? ' · ' + esc(x.city) : ''}</small></li>`).join('');
          list._res = res;
        } catch (e) { list.innerHTML = `<li>${esc(e.message)}</li>`; }
      }, 250);
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      const x = list._res[li.dataset.i];
      input.value = x.name || x.address; input._picked = x; list.innerHTML = '';
      onPick && onPick(x);
    });
    input.addEventListener('blur', () => setTimeout(() => (list.innerHTML = ''), 200));
  }
  async function resolvePlace(input) {
    if (input._picked) return input._picked;
    const q = input.value.trim();
    if (!q) throw new Error('Bitte Start und Ziel eingeben.');
    const res = await searchLocations(q);
    if (!res.length) throw new Error(`„${q}“ nicht gefunden.`);
    input._picked = res[0]; input.value = res[0].name || res[0].address;
    return res[0];
  }
  function placeParam(x) {
    if (x.type === 'stop' && x.id) return x.id;
    return `${x.latitude},${x.longitude}`;
  }

  // ---------- Simulation einer Verbindung ----------
  function distFrom(agg) {
    const s = S.summary(agg);
    const cum = []; let acc = 0;
    agg.hist.forEach((v) => { acc += v; cum.push(acc); });
    return { n: s.n, tot: s.tot, pc: s.tot ? agg.cx / s.tot : 0, cum, total: acc, median: s.median };
  }
  // Annahme, falls gar keine Daten: ~85 % unter 3 Min., 2 % Ausfall
  const PRIOR = (() => {
    const a = S.newAgg('prior', 'Annahme', 'x');
    const p = [40, 25, 15, 8, 5, 3, 2, 1, 0.5, 0.5]; p.forEach((v, i) => (a.hist[i] = v * 10));
    a.cx = 20; return a;
  })();
  function sampleDelaySec(d, rnd) {
    const r = rnd() * d.total;
    let m = 0; while (m < d.cum.length - 1 && d.cum[m] < r) m++;
    if (m === S.HB - 1) return (30 + -Math.log(1 - rnd()) * 10) * 60;
    return (m + rnd()) * 60;
  }
  function mulberry(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /**
   * legs: [{transit, dep, arr (ms, planned), liveDelay (s|null), cancelled, dist, headway (ms)}]
   * Fußwege gehen mit ihrer Dauer ein. Gibt Wahrscheinlichkeit & Risikoaufteilung zurück.
   */
  function simulate(legs, target, startAt, N = 3000) {
    const rnd = mulberry(12345 + legs.length);
    let ok = 0, rCancel = 0, rMiss = 0, rDelay = 0;
    const arrivals = [];
    const now = Date.now();
    for (let it = 0; it < N; it++) {
      let ready = startAt, cancelHit = false, missHit = false;
      for (const L of legs) {
        if (!L.transit) { ready = Math.max(ready, L.dep) + (L.arr - L.dep); continue; }
        const run = L.arr - L.dep;
        let k = 0, actDep;
        for (; k < 6; k++) {
          const planned = L.dep + k * L.headway;
          const known = k === 0 && L.liveDelay != null && L.dep - now < 45 * 60e3;
          if (k === 0 && L.cancelled) { cancelHit = true; continue; }
          if (!known && rnd() < L.dist.pc) { if (planned + 60e3 >= ready) cancelHit = true; continue; }
          let d;
          if (known) d = Math.max(Math.min(0, L.liveDelay), L.liveDelay + (sampleDelaySec(L.dist, rnd) - (L.dist.median + 0.5) * 60) * 0.5);
          else d = sampleDelaySec(L.dist, rnd);
          actDep = planned + d * 1000;
          if (actDep >= ready) break;
          if (k === 0) missHit = true;
        }
        if (actDep == null) actDep = L.dep + 6 * L.headway;
        ready = actDep + run;
      }
      arrivals.push(ready);
      if (ready <= target) ok++;
      else if (cancelHit) rCancel++;
      else if (missHit) rMiss++;
      else rDelay++;
    }
    arrivals.sort((a, b) => a - b);
    return {
      p: ok / N, rCancel: rCancel / N, rMiss: rMiss / N, rDelay: rDelay / N,
      p50: arrivals[Math.floor(N * 0.5)], p90: arrivals[Math.floor(N * 0.9)],
    };
  }

  function headwayFrom(deps, line, direction, around) {
    const ts = deps.filter((d) => d.line.key === line.key && (!direction || d.direction === direction))
      .map((d) => d.planned).sort((a, b) => a - b);
    const near = ts.filter((t) => Math.abs(t - around) < 90 * 60e3);
    const gaps = [];
    for (let i = 1; i < near.length; i++) if (near[i] - near[i - 1] > 60e3) gaps.push(near[i] - near[i - 1]);
    if (!gaps.length) return ({ bus: 20, tram: 10, subway: 10, suburban: 20, regional: 60, regionalExpress: 60, national: 120, nationalExpress: 60 }[line.product] || 20) * 60e3;
    gaps.sort((a, b) => a - b);
    return Math.min(120 * 60e3, gaps[Math.floor(gaps.length / 2)]);
  }

  // ---------- ROUTE ----------
  const routeOut = $('#route-out');
  let lastQuery = null;
  let routes = store.get('pk.routes', []);
  let routeMode = store.get('pk.mode', 'all'), lastEvals = null;
  function setMode(m) {
    routeMode = m; store.set('pk.mode', m);
    $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  }
  const short = (n) => String(n || '').replace(/^Köln[ ,]+/, '');
  function renderRouteFavs() {
    $('#route-favs').innerHTML = routes.map((r, i) => `<button class="chip" data-i="${i}">${esc(short(r.from.name))} → ${esc(short(r.to.name))}<small>an ${esc(r.time || '')} · tippen zum Berechnen</small></button>`).join('');
  }
  // Uhrzeit setzen; liegt sie heute schon zurück, gilt morgen
  function setArrival(time) {
    const now = Date.now();
    const today = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    let date = today;
    if (berlinToMs(today, time) < now) date = new Date(now + 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    $('#arr-date').value = date; $('#arr-time').value = time;
  }
  function initRoute() {
    const d = new Date(Date.now() + 45 * 60e3);
    $('#arr-date').value = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    $('#arr-time').value = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    const last = store.get('pk.lastRoute', null);
    if (last) {
      $('#from').value = last.from.name || last.from.address || ''; $('#from')._picked = last.from;
      $('#to').value = last.to.name || last.to.address || ''; $('#to')._picked = last.to;
      $('#walk').value = last.walk ?? 0; $('#conf').value = last.conf ?? '0.9';
    }
    attachSuggest($('#from'), $('#from-suggest'));
    attachSuggest($('#to'), $('#to-suggest'));
    $('#geo').addEventListener('click', () => {
      if (!navigator.geolocation) return alert('Standort wird nicht unterstützt.');
      $('#from').value = 'Standort wird ermittelt …';
      navigator.geolocation.getCurrentPosition((pos) => {
        $('#from')._picked = { type: 'location', address: 'Mein Standort', latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        $('#from').value = 'Mein Standort'; $('#walk').value = 0;
      }, (err) => { $('#from').value = ''; alert('Standort nicht verfügbar: ' + err.message); }, { enableHighAccuracy: true, timeout: 10000 });
    });
    $('#route-form').addEventListener('submit', (e) => { e.preventDefault(); planRoute(); });
    setMode(routeMode);
    $('#mode').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      setMode(b.dataset.mode);
      if (lastEvals) renderResult(); // ohne neue Abfrage umschalten
    });
    $('#swap').addEventListener('click', () => {
      const f = $('#from'), t = $('#to');
      [f.value, t.value] = [t.value, f.value]; [f._picked, t._picked] = [t._picked, f._picked];
    });
    $('#route-favs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]'); if (!b) return;
      const r = routes[b.dataset.i];
      if (e.target.closest('.del')) { routes.splice(b.dataset.i, 1); store.set('pk.routes', routes); renderRouteFavs(); return; }
      $('#from').value = r.from.name; $('#from')._picked = r.from;
      $('#to').value = r.to.name; $('#to')._picked = r.to;
      if (r.time) setArrival(r.time);
      planRoute();
    });
    renderRouteFavs();
  }

  function berlinToMs(date, time) {
    // Datum/Uhrzeit als Kölner Ortszeit interpretieren
    const guess = Date.parse(`${date}T${time}:00Z`);
    const off = (ms) => {
      const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms))) p[x.type] = x.value;
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
    };
    let t = guess - off(guess); t = guess - off(t); return t;
  }

  async function planRoute(extraRef) {
    try {
      routeOut.innerHTML = `<div class="loading">Suche Verbindungen und werte Statistik aus …</div>`;
      const from = await resolvePlace($('#from'));
      const to = await resolvePlace($('#to'));
      const target = berlinToMs($('#arr-date').value, $('#arr-time').value);
      const conf = Number($('#conf').value), walk = Math.max(0, Number($('#walk').value) || 0);
      store.set('pk.lastRoute', { from, to, walk, conf: $('#conf').value });
      lastEvals = null;
      const onlyRegional = routeMode === 'regional';
      const [main, reg] = await Promise.allSettled([
        searchJourneys(from, to, target, onlyRegional, extraRef),
        onlyRegional || extraRef ? Promise.resolve({ journeys: [] }) : searchJourneys(from, to, target, true),
      ]);
      if (main.status === 'rejected') throw main.reason;
      const res = main.value;
      let journeys = res.journeys.concat(reg.status === 'fulfilled' ? reg.value.journeys : []).filter((j) => j.legs?.length);
      if (extraRef && lastQuery) journeys = journeys.concat(lastQuery.journeys);
      const seenJ = new Set();
      journeys = journeys.filter((j) => { const k = j.legs.map((l) => (l.plannedDeparture || l.departure) + (l.line?.name || 'walk')).join(); if (seenJ.has(k)) return false; seenJ.add(k); return true; });
      lastQuery = { journeys, earlierRef: res.earlierRef, target, conf, walk };
      if (!journeys.length) { routeOut.innerHTML = `<div class="card">Keine Verbindung gefunden.</div>`; return; }
      routeOut.innerHTML = `<div class="loading">Werte Verspätungen der ${journeys.length} Verbindungen aus …</div>`;
      await evaluateJourneys(journeys, target, conf, walk, res.earlierRef);
    } catch (e) {
      routeOut.innerHTML = `<div class="card err"><b>Fehler:</b> ${esc(e.message)}<p class="note">Die Echtzeit-Auskunft (Transitous) ist manchmal kurz überlastet. Einfach nochmal versuchen.</p></div>`;
    }
  }

  async function evaluateJourneys(journeys, target, conf, walk, earlierRef) {
    const now = Date.now();
    const stopsNeeded = new Map(); // stopId -> {earliest, latest}
    for (const j of journeys) for (const l of j.legs) {
      if (l.walking || !l.line || !l.origin?.id) continue;
      const t = Date.parse(l.plannedDeparture || l.departure);
      const s = stopsNeeded.get(l.origin.id) || { min: t, max: t, name: l.origin.name };
      s.min = Math.min(s.min, t); s.max = Math.max(s.max, t); stopsNeeded.set(l.origin.id, s);
    }
    // je Haltestelle: letzte 90 Min. (Statistik) + Fenster um die Abfahrt (Takt)
    const depsBy = new Map();
    await Promise.all([...stopsNeeded].map(async ([id, s]) => {
      const out = [];
      const pastFrom = now - 90 * 60e3;
      const win1End = now + 30 * 60e3;
      try { out.push(...await departures(id, pastFrom, 120, 120e3)); } catch (e) { /* weiter ohne */ }
      if (s.max > win1End - 15 * 60e3 || s.min < pastFrom) {
        try { out.push(...await departures(id, s.min - 30 * 60e3, Math.min(240, (s.max - s.min) / 60e3 + 60), 120e3)); } catch (e) { /* weiter */ }
      }
      depsBy.set(id, out);
      record(out);
    }));

    const merged = allLines();
    const recentAll = aggFromDeps([...depsBy.values()].flat());
    const pooledByProduct = {};
    for (const a of Object.values(S.mergeMaps(merged, recentAll))) {
      pooledByProduct[a.product] = pooledByProduct[a.product] ? S.mergeAgg(pooledByProduct[a.product], a) : S.mergeAgg(null, a);
    }

    let evals = journeys.map((j) => {
      const legs = []; const info = [];
      for (const l of j.legs) {
        const dep = Date.parse(l.plannedDeparture || l.departure), arr = Date.parse(l.plannedArrival || l.arrival);
        if (l.walking || !l.line) {
          legs.push({ transit: false, dep, arr });
          info.push({ walk: true, l, dep, arr });
          continue;
        }
        const line = normLine(l.line);
        const deps = depsBy.get(l.origin?.id) || [];
        // Statistik dieser Linie: Verlauf (Handy + Server) + letzte 90 Min. an dieser Haltestelle
        const recent = aggFromDeps(deps.filter((d) => d.line.key === line.key))[line.key];
        let agg = S.mergeAgg(merged[line.key] || null, recent || null) || S.newAgg(line.key, line.label, line.product, line.agency);
        let basis = 'Linie';
        let n = S.summary(agg).tot;
        if (n < 15) {
          const pool = pooledByProduct[line.product];
          if (pool && S.summary(pool).tot >= 15) { agg = S.mergeAgg(agg, pool); basis = `alle ${productName(line.product)}-Linien`; }
          else { agg = S.mergeAgg(agg, PRIOR); basis = 'Annahme (zu wenig Daten)'; }
        }
        const live = typeof l.departureDelay === 'number' ? l.departureDelay : null;
        legs.push({
          transit: true, dep, arr, liveDelay: live, cancelled: !!l.cancelled,
          dist: distFrom(agg), headway: headwayFrom(deps, line, l.direction, dep),
        });
        info.push({ l, line, dep, arr, live, cancelled: !!l.cancelled, n, basis, sum: S.summary(agg, cfg.thr), headway: legs[legs.length - 1].headway });
      }
      const startAt = legs.length ? legs[0].dep - 60e3 : now; // 1 Min. vor Abfahrt an der Haltestelle
      const sim = simulate(legs, target, startAt);
      const leave = Date.parse(j.legs[0].plannedDeparture || j.legs[0].departure) - walk * 60e3;
      const long = info.some((x) => !x.walk && /^national/.test(x.line.product));
      const arrive = Date.parse(j.legs.at(-1).plannedArrival || j.legs.at(-1).arrival);
      return { j, legs, info, sim, leave, arrive, long, transfers: info.filter((x) => !x.walk).length - 1 };
    }).sort((a, b) => a.leave - b.leave);
    // Verbindungen, für die man schon zu spät losgehen müsste, ausblenden (falls es andere gibt)
    const future = evals.filter((e) => e.leave >= now - 60e3);
    if (future.length) evals.splice(0, evals.length, ...future);

    lastEvals = { evals, target, conf, earlierRef };
    renderResult();
  }

  // beste Verbindung einer Menge: die späteste, die die Sicherheit schafft, sonst die sicherste
  function pick(set, conf) {
    if (!set.length) return null;
    const good = set.filter((e) => e.sim.p >= conf);
    return good.length ? good[good.length - 1] : [...set].sort((a, b) => b.sim.p - a.sim.p)[0];
  }
  const dur = (e) => { const m = Math.round((e.arrive - e.leave) / 60e3); return m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`; };

  function renderResult() {
    const { evals: allEvals, target, conf, earlierRef } = lastEvals;
    const now = Date.now();
    const longs = allEvals.filter((e) => e.long), regs = allEvals.filter((e) => !e.long);
    const bestLong = pick(longs, conf), bestReg = pick(regs, conf);
    let evals = routeMode === 'fast' && longs.length ? longs : routeMode === 'regional' && regs.length ? regs : allEvals;
    const modeNote = routeMode === 'fast' && !longs.length ? 'Keine Verbindung mit ICE/IC gefunden – hier alle Verbindungen.'
      : routeMode === 'regional' && !regs.length ? 'Keine reine Regionalverbindung gefunden – hier alle Verbindungen.' : '';
    const rec = pick(evals, conf);
    const recOK = rec.sim.p >= conf;
    const lv = level(rec.sim.p);
    const minsTo = Math.round((rec.leave - now) / 60e3);
    const recLegs = rec.info.filter((x) => !x.walk);
    const firstLeg = recLegs[0];
    const how = recLegs.map((x) => lineTitle(x.line)).join(' → ');
    const verdict = !recOK ? 'Riskant – keine Verbindung ist sicher genug. Lieber früher los!'
      : rec.sim.p >= 0.95 ? 'Sehr sicher 👍' : rec.sim.p >= 0.9 ? 'Sicher' : 'Etwas Puffer einplanen';
    const biggest = [['Ausfall', rec.sim.rCancel], ['verpasster Umstieg', rec.sim.rMiss], ['Verspätung', rec.sim.rDelay]].sort((x, y) => y[1] - x[1])[0];
    let html = `<div class="card hero">
      <div class="muted">${recOK ? 'Geh spätestens los um' : 'Am sichersten: los um'}</div>
      <div class="big">${hm(rec.leave)}</div>
      <div class="sub">${minsTo >= 0 ? (minsTo < 120 ? `in ${minsTo} Min. · ` : '') : ''}${esc(how)}${firstLeg ? ` ab ${esc(firstLeg.l.origin?.name)} um ${hm(firstLeg.dep)}` : ''}</div>
      <div class="verdict">${statusTag(rec.sim.p, `${pct(rec.sim.p)} pünktlich`)}</div>
      <div class="verdict">${verdict}</div>
      ${1 - rec.sim.p >= 0.01 ? `<div class="why">Größtes Risiko: ${biggest[0]}</div>` : ''}
      ${firstLeg && (firstLeg.cancelled || (firstLeg.live || 0) >= 180) ? `<div class="why"><b>Live:</b> ${firstLeg.cancelled ? 'Diese Fahrt fällt aus!' : `${firstLeg.line.label} hat gerade +${Math.round(firstLeg.live / 60)} Min.`}</div>` : ''}
      <div class="row center"><button id="save-route" class="chip">☆ Strecke merken</button></div>
    </div>`;
    if (bestLong && bestReg) {
      const opt = (e, m, title) => `<button class="${routeMode === m || (routeMode === 'all' && e === rec) ? 'on' : ''}" data-mode="${m}">
        <div class="k">${title}</div><div class="t">${hm(e.leave)}</div>
        <div class="k">an ${hm(e.arrive)} · ${dur(e)}</div>
        <div class="k">${e.transfers <= 0 ? 'ohne Umstieg' : e.transfers + '× umsteigen'}</div>
        <div style="margin-top:4px">${statusTag(e.sim.p, pct(e.sim.p) + ' pünktlich')}</div></button>`;
      html = `<div class="card"><h3>ICE oder Regional?</h3><div class="compare" id="compare">${opt(bestLong, 'fast', 'Mit ICE/IC')}${opt(bestReg, 'regional', 'Nur Regional (D-Ticket)')}</div>
        <p class="note">Antippen, um diese Variante zu wählen. Beide sind mit der Statistik der jeweiligen Verkehrsbetriebe berechnet.</p></div>` + html;
    }
    if (modeNote) html = `<div class="card small muted">${modeNote}</div>` + html;
    html += `<div class="card">${journeyHTML(rec, true, target).replace(/^<div class="card journey rec">/, '<div class="journey">')}</div>`;
    const others = evals.filter((e) => e !== rec);
    if (others.length) html += `<details class="card"><summary>Andere Verbindungen (${others.length})</summary>${others.map((e) => journeyHTML(e, false, target)).join('')}
      ${earlierRef ? `<button id="earlier" style="width:100%;margin-top:8px">Frühere Verbindungen laden</button>` : ''}</details>`;
    html += `<p class="note">Berechnet aus echten Live-Daten und der Verspätungsstatistik jeder Linie (3000 simulierte Fahrten). Ankommen bis ${hm(target)}.</p>`;
    routeOut.innerHTML = html;
    (routeOut.firstElementChild || routeOut).scrollIntoView({ behavior: 'smooth', block: 'start' });
    const sv = $('#save-route');
    if (sv) {
      const key = (r) => (r.from.id || r.from.name) + '>' + (r.to.id || r.to.name);
      const cur = { from: $('#from')._picked, to: $('#to')._picked };
      const isSaved = () => routes.some((r) => key(r) === key(cur));
      sv.textContent = isSaved() ? '★ Gemerkt' : '☆ Strecke merken';
      sv.onclick = () => {
        if (isSaved()) return;
        routes = routes.concat([{ ...cur, time: $('#arr-time').value }]).slice(-6);
        store.set('pk.routes', routes); renderRouteFavs(); sv.textContent = '★ Gemerkt';
      };
    }
    const btn = $('#earlier'); if (btn) btn.onclick = () => planRoute(earlierRef);
    const cmp = $('#compare');
    if (cmp) cmp.onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) { setMode(b.dataset.mode); renderResult(); } };
  }

  function journeyHTML(e, isRec, target) {
    const { sim, info } = e;
    const first = info[0], last = info[info.length - 1];
    const legsHTML = info.map((x) => {
      if (x.walk) {
        const min = Math.round((x.arr - x.dep) / 60e3);
        if (min <= 0) return '';
        return `<li><span class="badge walk">Fuß</span><div>${min} Min. zu Fuß${x.l.destination?.name ? ' bis ' + esc(x.l.destination.name) : ''}</div></li>`;
      }
      const ld = x.live == null ? '<span class="muted">keine Echtzeit</span>'
        : x.live >= 60 * cfg.thr ? `<span class="delay late">+${Math.round(x.live / 60)}</span>`
        : `<span class="delay ok">${x.live >= 60 ? '+' + Math.floor(x.live / 60) : 'pünktlich'}</span>`;
      return `<li><span class="badge">${esc(x.line.label)}</span><div style="flex:1">
        <div><b>${hm(x.dep)}</b> ${esc(x.l.origin?.name)} ${x.cancelled ? '<span class="cancel">fällt aus</span>' : ld}</div>
        <div class="muted small">→ ${esc(x.l.direction || x.l.destination?.name)} · an ${hm(x.arr)} ${esc(x.l.destination?.name)}${x.l.departurePlatform ? ' · Gl./Steig ' + esc(x.l.departurePlatform) : ''}</div>
        <div class="muted small">${esc(x.line.agency || 'Unbekannter Betrieb')} · ${esc(x.line.label)}: ${pct(x.sum.punct)} pünktlich, ${pct(x.sum.cancel, 1)} Ausfall · Takt ~${Math.round(x.headway / 60e3)} Min. · Basis: ${esc(x.basis)} (${x.n} Fahrten)</div>
      </div></li>`;
    }).join('');
    const arrPlanned = Date.parse(e.j.legs.at(-1).plannedArrival || e.j.legs.at(-1).arrival);
    const buffer = Math.round((target - arrPlanned) / 60e3);
    const okW = sim.p * 100, cW = sim.rCancel * 100, mW = sim.rMiss * 100, dW = sim.rDelay * 100;
    return `<div class="card journey${isRec ? ' rec' : ''}">
      <div class="jhead"><div><div class="jtime">${hm(e.leave)} → ${hm(arrPlanned)}</div>
        <div class="muted small">${e.transfers <= 0 ? 'ohne Umstieg' : e.transfers + ' Umstieg' + (e.transfers > 1 ? 'e' : '')}${e.long ? '<span class="tag">ICE/IC</span>' : '<span class="tag">Regional</span>'} · ${buffer} Min. Puffer${isRec ? ' · <b>Empfehlung</b>' : ''}</div></div>
        <div style="text-align:right"><div class="prob">${pct(sim.p)}</div>${statusTag(sim.p)}</div></div>
      <div class="meter" title="pünktlich / Ausfall / Umstieg verpasst / Verspätung">
        <i style="width:${okW}%;background:var(--good)"></i><i style="width:${cW}%;background:var(--critical)"></i><i style="width:${mW}%;background:var(--serious)"></i><i style="width:${dW}%;background:var(--warn)"></i>
      </div>
      <div class="note">Ankunft wahrscheinlich ${hm(sim.p50)}, in 9 von 10 Fällen bis ${hm(sim.p90)} · Risiko: Ausfall ${pct(sim.rCancel)}, Umstieg verpasst ${pct(sim.rMiss)}, Verspätung ${pct(sim.rDelay)}</div>
      <details><summary>Details</summary><ul class="legs">${legsHTML}</ul></details>
    </div>`;
  }

  // ---------- HALTESTELLE ----------
  const stopOut = $('#stop-out');
  let currentStop = null, stopTimer = null;
  function renderFavChips() {
    $('#fav-chips').innerHTML = favs.map((f) => `<button class="chip" data-id="${esc(f.id)}">★ ${esc(f.name)}</button>`).join('');
  }
  function initStop() {
    attachSuggest($('#stop-q'), $('#stop-suggest'), (x) => openStop({ id: x.id, name: x.name }), { stopsOnly: true });
    $('#fav-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]'); if (!b) return;
      const f = favs.find((x) => x.id === b.dataset.id); if (f) { $('#stop-q').value = f.name; openStop(f); }
    });
    renderFavChips();
  }
  async function openStop(stop) {
    currentStop = stop;
    clearInterval(stopTimer);
    stopOut.innerHTML = `<div class="loading">Lade Abfahrten …</div>`;
    await renderStop();
    stopTimer = setInterval(() => currentStop === stop && !document.hidden && $('#tab-stop').classList.contains('active') && renderStop(), 60e3);
  }
  async function renderStop() {
    const stop = currentStop; const now = Date.now();
    try {
      const deps = await departures(stop.id, now - 90 * 60e3, 150, 30e3);
      record(deps);
      const isFav = favs.some((f) => f.id === stop.id);
      const upcoming = deps.filter((d) => (d.when || d.planned) >= now - 60e3).sort((a, b) => (a.when || a.planned) - (b.when || b.planned)).slice(0, 15);
      const recent = aggFromDeps(deps);
      const merged = allLines();
      const rows = Object.values(recent).map((a) => ({ a, s: S.summary(a, cfg.thr), hist: merged[a.key] ? S.summary(merged[a.key], cfg.thr) : null }))
        .sort((x, y) => x.a.name.localeCompare(y.a.name, 'de', { numeric: true }));
      const tot = Object.values(recent).reduce((acc, a) => S.mergeAgg(acc, a), null);
      const ts = tot ? S.summary(tot, cfg.thr) : null;
      let html = `<div class="card"><div class="jhead"><h2>${esc(stop.name)}</h2>
        <button id="fav-toggle" class="chip">${isFav ? '★ Favorit' : '☆ Merken'}</button></div>
        ${ts && ts.tot ? `<p class="small" style="margin:4px 0 0">Letzte 90 Min.: ${statusTag(ts.punct, pct(ts.punct) + ' pünktlich')} · ${pct(ts.cancel, 1)} Ausfälle · ${ts.tot} Fahrten</p>` : ''}</div>`;
      if (rows.length) {
        html += `<div class="card"><h3>Zuverlässigkeit je Linie</h3>
        <table class="stats"><thead><tr><th>Linie</th><th>Letzte 90 Min.</th><th>Ausfall</th><th>Langfristig</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click" data-key="${esc(r.a.key)}"><td><span class="badge">${esc(r.a.name)}</span></td>
          <td>${pct(r.s.punct)} <span class="muted small">(${r.s.tot})</span></td><td>${pct(r.s.cancel)}</td>
          <td>${r.hist ? pct(r.hist.punct) + ` <span class="muted small">(${r.hist.tot})</span>` : '–'}</td></tr>`).join('')}
        </tbody></table><p class="note">Pünktlich = weniger als ${cfg.thr} Min. Verspätung und nicht ausgefallen. Antippen für das Profil.</p></div>`;
      }
      html += `<div class="card"><h3>Nächste Abfahrten</h3>${upcoming.length ? upcoming.map(depHTML).join('') : '<p class="muted">Keine Abfahrten in der nächsten Stunde.</p>'}</div>`;
      stopOut.innerHTML = html;
      $('#fav-toggle').onclick = () => {
        favs = isFav ? favs.filter((f) => f.id !== stop.id) : favs.concat([{ id: stop.id, name: stop.name }]);
        store.set('pk.favs', favs); renderFavChips(); renderStop();
      };
      $$('tr.click', stopOut).forEach((tr) => tr.onclick = () => { showTab('lines'); openLine(tr.dataset.key); });
    } catch (e) {
      stopOut.innerHTML = `<div class="card err"><b>Fehler:</b> ${esc(e.message)}</div>`;
    }
  }
  function depHTML(d) {
    const t = d.when || d.planned;
    const dl = d.cancelled ? '<span class="cancel">fällt aus</span>'
      : d.delayMin == null ? '<span class="muted small">keine Echtzeit</span>'
      : d.delayMin >= cfg.thr ? `<span class="delay late">+${Math.floor(d.delayMin)}</span>`
      : `<span class="delay ok">${d.delayMin >= 1 ? '+' + Math.floor(d.delayMin) : 'pünktlich'}</span>`;
    return `<div class="dep"><span class="badge">${esc(d.line.label)}</span>
      <div>${esc(d.direction)}<div class="muted small">${productName(d.line.product)}${d.platform ? ' · Steig ' + esc(d.platform) : ''} · ${dl}</div></div>
      <div class="t">${d.cancelled ? `<s>${hm(d.planned)}</s>` : `<b>${hm(t)}</b>${d.when && hm(d.when) !== hm(d.planned) ? `<s>${hm(d.planned)}</s>` : ''}`}</div></div>`;
  }

  // ---------- LINIEN ----------
  let lineSrc = 'all', openKey = null, lineView = 'agencies', agencyFilter = null;
  const agencyOf = (a) => a.agency || 'Unbekannter Betrieb';
  const cityOfAgg = (a) => S.topCities(a, 1)[0] || '';
  const citiesOfAgg = (a) => S.topCities(a, 3);
  const prodGroup = (p) => (p === 'regionalExpress' ? 'regional' : p === 'nationalExpress' ? 'national' : p);
  const FILTERS = ['line-sort', 'f-city', 'line-prod', 'f-punct', 'f-cancel', 'f-min'];
  const FDEF = { 'line-sort': 'tot_desc', 'f-city': '', 'line-prod': '', 'f-punct': '', 'f-cancel': '', 'f-min': '1' };
  function initLines() {
    const saved = store.get('pk.filters', {});
    lineView = saved.view || 'agencies';
    for (const id of FILTERS) {
      const el = $('#' + id);
      if (saved[id] != null && id !== 'f-city') el.value = saved[id];
      el.addEventListener('change', () => { openKey = null; saveFilters(); renderLines(); });
    }
    pendingCity = saved['f-city'] || '';
    $('#line-q').addEventListener('input', () => { openKey = null; renderLines(); });
    $('#line-src').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      lineSrc = b.dataset.src; $$('#line-src button').forEach((x) => x.classList.toggle('on', x === b)); renderLines();
    });
    $('#line-view').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      setView(b.dataset.view); saveFilters(); renderLines();
    });
    $('#active-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-clear]'); if (!b) return;
      const k = b.dataset.clear;
      if (k === 'agency') agencyFilter = null;
      else if (k === 'q') $('#line-q').value = '';
      else $('#' + k).value = FDEF[k];
      saveFilters(); renderLines();
    });
    $('#f-reset').addEventListener('click', () => {
      for (const id of FILTERS) $('#' + id).value = FDEF[id];
      agencyFilter = null; $('#line-q').value = ''; saveFilters(); renderLines();
    });
    setView(lineView);
  }
  let pendingCity = '';
  function saveFilters() {
    const o = { view: lineView };
    for (const id of FILTERS) o[id] = $('#' + id).value;
    store.set('pk.filters', o);
  }
  function setView(v) { lineView = v; openKey = null; $$('#line-view button').forEach((x) => x.classList.toggle('on', x.dataset.view === v)); }
  function openLine(key) { openKey = key; renderLines(); scrollTo(0, 0); }
  function sortRows(rows, how, nameOf, cityOf) {
    const [k, dir] = how.split('_');
    const sign = dir === 'asc' ? 1 : -1;
    const val = (r) => (k === 'tot' ? r.s.tot : k === 'punct' ? r.s.punct : k === 'cancel' ? r.s.cancel : k === 'mean' ? r.s.mean : k === 'late5' ? r.s.late5 : null);
    return rows.sort((x, y) => {
      if (k === 'name') return sign * nameOf(x).localeCompare(nameOf(y), 'de', { numeric: true });
      if (k === 'city') return (cityOf(x) || 'zzz').localeCompare(cityOf(y) || 'zzz', 'de') || nameOf(x).localeCompare(nameOf(y), 'de', { numeric: true });
      const a = val(x), b = val(y);
      if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
      return sign * (a - b) || y.s.tot - x.s.tot;
    });
  }
  function passes(s, f) {
    if (s.tot < f.min) return false;
    if (f.punct) {
      const p = (s.punct ?? 0) * 100;
      if (f.punct === '95' && p < 95) return false;
      if (f.punct === '90' && p < 90) return false;
      if (f.punct === '80-90' && (p < 80 || p >= 90)) return false;
      if (f.punct === '-80' && p >= 80) return false;
      if (f.punct === '-65' && p >= 65) return false;
    }
    if (f.cancel !== '') {
      const c = (s.cancel ?? 0) * 100;
      if (f.cancel === '0' ? c > 0 : c <= Number(f.cancel)) return false;
    }
    return true;
  }
  const statCells = (s, withMean = true) => `<td><span class="status ${level(s.punct).cls}">${pct(s.punct)}</span></td><td>${pct(s.cancel, 1)}</td>${withMean ? `<td>${num(s.mean)}</td>` : ''}<td>${s.tot}</td>`;

  function renderLines() {
    const all = allLines(lineSrc);
    const meta = [];
    meta.push(`Dieses Handy: ${Object.keys(local).length} Linien`);
    meta.push(remote ? `Server-Statistik: ${Object.keys(remote.lines).length} Linien, Stand ${new Date(remote.generated).toLocaleString('de-DE')}` : cfg.remote ? 'Server-Statistik noch nicht erreichbar' : 'Keine Server-Statistik eingerichtet (siehe „Mehr“)');
    $('#lines-meta').textContent = meta.join(' · ');

    // Städte-Auswahl aus den vorhandenen Daten füllen
    const citySel = $('#f-city');
    const cur = citySel.value || pendingCity; pendingCity = '';
    const cityCount = {};
    for (const a of Object.values(all)) for (const [c, n] of Object.entries(a.cities || {})) cityCount[c] = (cityCount[c] || 0) + n;
    const cityList = Object.keys(cityCount).sort((x, y) => x.localeCompare(y, 'de'));
    citySel.innerHTML = '<option value="">Alle Städte</option>' + cityList.map((c) => `<option value="${esc(c)}">${esc(c)} (${cityCount[c]})</option>`).join('');
    citySel.value = cityList.includes(cur) ? cur : '';

    const f = { q: $('#line-q').value.trim().toLowerCase(), city: citySel.value, prod: $('#line-prod').value, punct: $('#f-punct').value,
      cancel: $('#f-cancel').value, min: Number($('#f-min').value) || 1, how: $('#line-sort').value };

    // aktive Filter als antippbare Chips
    const chips = [];
    if (agencyFilter) chips.push(['agency', 'Betrieb: ' + agencyFilter]);
    if (f.q) chips.push(['q', 'Suche: ' + f.q]);
    if (f.city) chips.push(['f-city', 'Stadt: ' + f.city]);
    if (f.prod) chips.push(['line-prod', productName(f.prod)]);
    if (f.punct) chips.push(['f-punct', 'Pünktlichkeit: ' + $('#f-punct').selectedOptions[0].text]);
    if (f.cancel !== '') chips.push(['f-cancel', 'Ausfälle: ' + $('#f-cancel').selectedOptions[0].text]);
    if (f.min > 1) chips.push(['f-min', `ab ${f.min} Fahrten`]);
    $('#active-filters').innerHTML = chips.map(([k, t]) => `<button class="chip" data-clear="${k}">${esc(t)} ✕</button>`).join('');

    const out = $('#lines-out');
    if (openKey && all[openKey]) {
      const a = all[openKey];
      const cities = citiesOfAgg(a);
      out.innerHTML = `<button id="back" style="margin-bottom:12px">← Zurück</button>` +
        lineProfileHTML(a, lineTitle(a), { sub: agencyOf(a) + (cities.length ? ' · ' + cities.join(', ') : '') + ' · ' + (lineSrc === 'local' ? 'Nur auf diesem Handy beobachtete Fahrten' : lineSrc === 'remote' ? 'Server-Statistik' : 'Handy + Server-Statistik') });
      $('#back').onclick = () => { openKey = null; renderLines(); };
      return;
    }

    // Basismenge: Linien nach Verkehrsmittel, Stadt, Betrieb
    const lines = Object.values(all).filter((a) => (!f.prod || prodGroup(a.product) === f.prod)
      && (!agencyFilter || agencyOf(a) === agencyFilter)
      && (!f.city || (a.cities && a.cities[f.city])));
    const empty = `<div class="card"><p>Nichts gefunden.</p><p class="muted small">Filter lockern (oben „Filter zurücksetzen“) oder anders suchen. Die Statistik wächst automatisch – der Hintergrund-Sammler wertet große Knoten in ganz Deutschland aus, und jede deiner Abfragen kommt dazu.</p></div>`;
    const qHit = (...vals) => !f.q || vals.some((v) => String(v || '').toLowerCase().includes(f.q));

    const group = (keyOf) => {
      const g = {};
      for (const a of lines) {
        const k = keyOf(a); if (!k) continue;
        const x = g[k] || (g[k] = { name: k, agg: null, n: 0, prods: new Set(), agencies: new Set() });
        x.agg = S.mergeAgg(x.agg, a); x.n++; x.prods.add(productName(prodGroup(a.product))); x.agencies.add(agencyOf(a));
      }
      return Object.values(g).map((x) => ({ ...x, s: S.summary(x.agg, cfg.thr) }));
    };

    if (lineView === 'cities' && !agencyFilter) {
      let rows = group((a) => cityOfAgg(a)).filter((r) => passes(r.s, f) && qHit(r.name, ...r.agencies));
      if (!rows.length) { out.innerHTML = empty; return; }
      rows = sortRows(rows, f.how, (r) => r.name, (r) => r.name);
      out.innerHTML = `<div class="card"><table class="stats"><thead><tr><th>Stadt</th><th>Pünktlich</th><th>Ausfall</th><th>Fahrten</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click" data-city="${esc(r.name)}"><td><b>${esc(r.name)}</b><div class="muted small">${r.agencies.size} Betrieb${r.agencies.size > 1 ? 'e' : ''} · ${r.n} Linien</div></td>${statCells(r.s, false)}</tr>`).join('')}
        </tbody></table><p class="note">Stadt antippen, um ihre Verkehrsbetriebe zu sehen.</p></div>`;
      $$('tr.click', out).forEach((tr) => tr.onclick = () => { $('#f-city').value = tr.dataset.city; pendingCity = tr.dataset.city; setView('agencies'); saveFilters(); renderLines(); scrollTo(0, 0); });
      return;
    }

    if (lineView === 'agencies' && !agencyFilter) {
      let rows = group((a) => agencyOf(a)).map((r) => ({ ...r, city: S.topCities(r.agg, 3) }))
        .filter((r) => passes(r.s, f) && qHit(r.name, ...r.city));
      if (!rows.length) { out.innerHTML = empty; return; }
      rows = sortRows(rows, f.how, (r) => r.name, (r) => r.city[0]);
      const shown = rows.slice(0, 200);
      out.innerHTML = `<div class="card"><p class="muted small" style="margin-top:0">${rows.length} Verkehrsbetrieb${rows.length > 1 ? 'e' : ''}</p><table class="stats"><thead><tr><th>Verkehrsbetrieb</th><th>Pünktlich</th><th>Ausfall</th><th>Fahrten</th></tr></thead><tbody>
        ${shown.map((r) => `<tr class="click" data-agency="${esc(r.name)}"><td><b>${esc(r.name)}</b><div class="muted small">📍 ${esc(r.city.join(', ') || 'Stadt unbekannt')}</div><div class="muted small">${r.n} Linie${r.n > 1 ? 'n' : ''} · ${esc([...r.prods].join(', '))}</div></td>${statCells(r.s, false)}</tr>`).join('')}
        </tbody></table><p class="note">${rows.length > shown.length ? `${shown.length} von ${rows.length} – Suche oder Filter nutzen. ` : ''}Betrieb antippen, um seine Linien zu sehen.</p></div>`;
      $$('tr.click', out).forEach((tr) => tr.onclick = () => { agencyFilter = tr.dataset.agency; setView('lines'); renderLines(); scrollTo(0, 0); });
      return;
    }

    let rows = lines.map((a) => ({ a, s: S.summary(a, cfg.thr), cities: citiesOfAgg(a) }))
      .filter((r) => r.s.tot > 0 && passes(r.s, f) && (!f.q || r.a.name.toLowerCase() === f.q || r.a.name.toLowerCase().startsWith(f.q) || qHit(agencyOf(r.a), ...r.cities) && f.q.length > 2));
    if (!rows.length) { out.innerHTML = empty; return; }
    rows = sortRows(rows, f.how, (r) => r.a.name, (r) => r.cities[0]);
    const shown = rows.slice(0, 300);
    out.innerHTML = `<div class="card"><p class="muted small" style="margin-top:0">${rows.length} Linie${rows.length > 1 ? 'n' : ''}</p><table class="stats"><thead><tr><th>Linie</th><th>Pünktlich</th><th>Ausfall</th><th>Ø Min.</th><th>Fahrten</th></tr></thead><tbody>
      ${shown.map((r) => `<tr class="click" data-key="${esc(r.a.key)}"><td><span class="badge">${esc(r.a.name)}</span> <span class="muted small">${productName(r.a.product)}</span><div class="muted small">${agencyFilter ? '' : esc(agencyOf(r.a)) + ' · '}📍 ${esc(r.cities.join(', ') || '–')}</div></td>${statCells(r.s)}</tr>`).join('')}
      </tbody></table><p class="note">${rows.length > shown.length ? `${shown.length} von ${rows.length} – Suche oder Filter nutzen. ` : ''}Antippen für das Zuverlässigkeitsprofil.</p></div>`;
    $$('tr.click', out).forEach((tr) => tr.onclick = () => openLine(tr.dataset.key));
  }
  const order = (p) => ['tram', 'subway', 'bus', 'suburban', 'regional', 'regionalExpress'].indexOf(p) + 1 || 9;

  // ---------- EINSTELLUNGEN ----------
  function initSettings() {
    $('#set-thr').value = cfg.thr; $('#set-api').value = cfg.api; $('#set-remote').value = cfg.remote; $('#set-collect').checked = cfg.collect;
    $('#set-save').onclick = async () => {
      cfg = { thr: Math.max(1, Math.min(5, Number($('#set-thr').value) || 3)), api: $('#set-api').value.trim() || DEFAULTS.api, remote: $('#set-remote').value.trim(), collect: $('#set-collect').checked };
      $('#set-thr').value = cfg.thr;
      store.set('pk.cfg', cfg); cache.clear();
      await loadRemote(true); dataInfo(); alert('Gespeichert.');
    };
    $('#data-export').onclick = () => {
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), lines: local }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'puenktlich-koeln-statistik.json'; a.click();
    };
    $('#data-clear').onclick = () => {
      if (!confirm('Alle auf diesem Handy gesammelten Statistiken löschen?')) return;
      local = {}; seen = {}; store.del('pk.lines'); store.del('pk.seen'); dataInfo();
    };
    dataInfo();
  }
  function dataInfo() {
    const n = Object.values(local).reduce((s, a) => s + S.summary(a).tot, 0);
    $('#data-info').textContent = `${n} Fahrten auf ${Object.keys(local).length} Linien gespeichert. Favoriten: ${favs.map((f) => f.name).join(', ') || 'keine'}.`;
  }

  // ---------- Hintergrund-Sammeln (solange App offen) ----------
  async function collectFavs() {
    if (!cfg.collect || document.hidden || !favs.length) return;
    for (const f of favs) {
      try { record(await departures(f.id, Date.now() - 60 * 60e3, 60, 150e3)); } catch { /* nächster Versuch später */ }
    }
  }

  // ---------- Tabs ----------
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'lines') renderLines();
    if (name === 'settings') dataInfo();
    try { sessionStorage.setItem('pk.tab', name); } catch { /* egal */ }
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- Start ----------
  initRoute(); initStop(); initLines(); initSettings(); setNet();
  try { const t = sessionStorage.getItem('pk.tab'); if (t) showTab(t); } catch { /* egal */ }
  loadRemote().then(() => { if ($('#tab-lines').classList.contains('active')) renderLines(); });
  collectFavs(); setInterval(collectFavs, 3 * 60e3);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
