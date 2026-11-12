/*
 * Gemeinsame Statistik-Logik für App (Browser) und Sammler (Node).
 *
 * Aggregat einer Linie:
 *   hist[31]  Anzahl Abfahrten mit Verspätung 0,1,…,29, ≥30 Minuten (abgerundet, früh = 0)
 *   cx        Anzahl Ausfälle
 *   nort      Abfahrten ohne Echtzeitdaten (zählen nicht in die Quote)
 *   hours[24] / wd[7] / days{YYYY-MM-DD}  jeweils grobe Verteilung C = [cx, 0,1,2,3,4, 5–9, ≥10]
 */
(function (root) {
  'use strict';

  const HB = 31;   // Buckets im Feinhistogramm
  const CB = 8;    // Buckets in der groben Verteilung
  const KEEP_DAYS = 60;

  const zeros = (n) => new Array(n).fill(0);

  function newAgg(key, name, product) {
    return {
      key, name, product,
      hist: zeros(HB), cx: 0, nort: 0,
      hours: Array.from({ length: 24 }, () => zeros(CB)),
      wd: Array.from({ length: 7 }, () => zeros(CB)),
      days: {},
    };
  }

  const coarse = (min) => (min < 5 ? 1 + min : min < 10 ? 6 : 7);

  // Ortszeit Köln für Stunden/Wochentage – unabhängig von der Zeitzone des Geräts/Servers
  const fmtParts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const WD = { Mo: 0, Di: 1, Mi: 2, Do: 3, Fr: 4, Sa: 5, So: 6 };
  function berlin(ms) {
    const p = {};
    for (const x of fmtParts.formatToParts(new Date(ms))) p[x.type] = x.value;
    return {
      hour: Number(p.hour) % 24,
      wd: WD[p.weekday.replace('.', '')] ?? 0,
      date: `${p.year}-${p.month}-${p.day}`,
    };
  }

  /**
   * obs: { key, name, product, planned (ms), delayMin (Zahl|null), cancelled (bool) }
   */
  function addObs(agg, obs) {
    const t = berlin(obs.planned);
    let ci;
    if (obs.cancelled) { agg.cx++; ci = 0; }
    else if (obs.delayMin == null) { agg.nort++; return; }
    else {
      const m = Math.max(0, Math.min(HB - 1, Math.floor(obs.delayMin)));
      agg.hist[m]++;
      ci = coarse(m);
    }
    agg.hours[t.hour][ci]++;
    agg.wd[t.wd][ci]++;
    (agg.days[t.date] || (agg.days[t.date] = zeros(CB)))[ci]++;
  }

  function pruneDays(agg, nowMs) {
    const cut = berlin(nowMs - KEEP_DAYS * 864e5).date;
    for (const d of Object.keys(agg.days)) if (d < cut) delete agg.days[d];
  }

  function addArr(a, b) { for (let i = 0; i < b.length; i++) a[i] = (a[i] || 0) + (b[i] || 0); return a; }

  function mergeAgg(a, b) {
    const out = newAgg(a ? a.key : b.key, (a || b).name, (a || b).product);
    for (const x of [a, b]) {
      if (!x) continue;
      addArr(out.hist, x.hist); out.cx += x.cx || 0; out.nort += x.nort || 0;
      x.hours.forEach((h, i) => addArr(out.hours[i], h));
      x.wd.forEach((h, i) => addArr(out.wd[i], h));
      for (const [d, v] of Object.entries(x.days || {})) out.days[d] = addArr(out.days[d] || zeros(CB), v);
    }
    return out;
  }

  function mergeMaps(...maps) {
    const out = {};
    for (const m of maps) {
      if (!m) continue;
      for (const [k, v] of Object.entries(m)) out[k] = out[k] ? mergeAgg(out[k], v) : mergeAgg(null, v);
    }
    return out;
  }

  /** Kennzahlen aus einem Feinhistogramm. thr = "pünktlich heißt < thr Minuten" */
  function summary(agg, thr = 3) {
    const n = agg.hist.reduce((s, v) => s + v, 0);
    const tot = n + agg.cx;
    let ok = 0, sum = 0, late5 = 0;
    agg.hist.forEach((v, m) => {
      if (m < thr) ok += v;
      if (m >= 5) late5 += v;
      sum += v * (m === HB - 1 ? 35 : m + 0.5);
    });
    let acc = 0, p90 = 0, med = 0;
    for (let m = 0; m < HB; m++) {
      acc += agg.hist[m];
      if (!med && acc >= n * 0.5) med = m;
      if (acc >= n * 0.9) { p90 = m; break; }
    }
    return {
      n, tot,
      punct: tot ? ok / tot : null,          // pünktlich und nicht ausgefallen
      punctRun: n ? ok / n : null,           // pünktlich unter den gefahrenen
      cancel: tot ? agg.cx / tot : null,
      late5: tot ? late5 / tot : null,
      mean: n ? sum / n : null,
      median: med, p90,
    };
  }

  /** Pünktlichkeit aus grober Verteilung (für Stunden / Tage), thr 1..5 exakt */
  function coarsePunct(c, thr = 3) {
    const tot = c.reduce((s, v) => s + v, 0);
    if (!tot) return { tot: 0, punct: null, cancel: null };
    let ok = 0;
    const lim = Math.min(thr, 5);
    for (let m = 0; m < lim; m++) ok += c[1 + m];
    return { tot, punct: ok / tot, cancel: c[0] / tot };
  }

  const api = { newAgg, addObs, mergeAgg, mergeMaps, summary, coarsePunct, pruneDays, berlin, HB, CB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PStats = api;
})(typeof self !== 'undefined' ? self : this);
