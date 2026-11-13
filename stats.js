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

  function newAgg(key, name, product, agency) {
    return {
      key, name, product, agency: agency || '', cities: {},
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
    if (obs.city) { agg.cities = agg.cities || {}; agg.cities[obs.city] = (agg.cities[obs.city] || 0) + 1; }
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
    if (!a && !b) return null;
    const out = newAgg(a ? a.key : b.key, (a || b).name, (a || b).product, (a || b).agency);
    for (const x of [a, b]) {
      if (!x) continue;
      addArr(out.hist, x.hist); out.cx += x.cx || 0; out.nort += x.nort || 0;
      x.hours.forEach((h, i) => addArr(out.hours[i], h));
      x.wd.forEach((h, i) => addArr(out.wd[i], h));
      for (const [d, v] of Object.entries(x.days || {})) out.days[d] = addArr(out.days[d] || zeros(CB), v);
      for (const [c, v] of Object.entries(x.cities || {})) out.cities[c] = (out.cities[c] || 0) + v;
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

  // Städte (Name, Breite, Länge) – damit jede Linie / jeder Betrieb einer Stadt zugeordnet werden kann
  const CITIES = [
    ['Berlin', 52.520, 13.405], ['Hamburg', 53.551, 9.994], ['München', 48.137, 11.575], ['Köln', 50.938, 6.960],
    ['Frankfurt am Main', 50.110, 8.682], ['Stuttgart', 48.776, 9.183], ['Düsseldorf', 51.227, 6.774], ['Leipzig', 51.340, 12.375],
    ['Dortmund', 51.514, 7.466], ['Essen', 51.456, 7.012], ['Bremen', 53.079, 8.802], ['Dresden', 51.050, 13.738],
    ['Hannover', 52.376, 9.732], ['Nürnberg', 49.452, 11.077], ['Duisburg', 51.435, 6.763], ['Bochum', 51.482, 7.216],
    ['Wuppertal', 51.256, 7.151], ['Bielefeld', 52.030, 8.532], ['Bonn', 50.737, 7.098], ['Münster', 51.960, 7.626],
    ['Mannheim', 49.488, 8.466], ['Karlsruhe', 49.007, 8.404], ['Augsburg', 48.370, 10.898], ['Wiesbaden', 50.078, 8.240],
    ['Mönchengladbach', 51.180, 6.442], ['Gelsenkirchen', 51.518, 7.086], ['Aachen', 50.776, 6.084], ['Braunschweig', 52.269, 10.521],
    ['Kiel', 54.323, 10.123], ['Chemnitz', 50.828, 12.921], ['Halle (Saale)', 51.483, 11.970], ['Magdeburg', 52.121, 11.628],
    ['Freiburg im Breisgau', 47.999, 7.842], ['Krefeld', 51.339, 6.586], ['Mainz', 49.993, 8.247], ['Lübeck', 53.866, 10.686],
    ['Erfurt', 50.978, 11.029], ['Oberhausen', 51.497, 6.863], ['Rostock', 54.092, 12.099], ['Kassel', 51.312, 9.480],
    ['Hagen', 51.367, 7.463], ['Potsdam', 52.391, 13.065], ['Saarbrücken', 49.240, 6.997], ['Hamm', 51.680, 7.815],
    ['Ludwigshafen', 49.477, 8.445], ['Oldenburg', 53.141, 8.214], ['Mülheim an der Ruhr', 51.427, 6.883], ['Osnabrück', 52.280, 8.047],
    ['Leverkusen', 51.046, 6.990], ['Heidelberg', 49.399, 8.672], ['Darmstadt', 49.873, 8.651], ['Solingen', 51.171, 7.084],
    ['Regensburg', 49.013, 12.102], ['Herne', 51.538, 7.219], ['Paderborn', 51.719, 8.754], ['Neuss', 51.198, 6.692],
    ['Ingolstadt', 48.766, 11.426], ['Offenbach am Main', 50.096, 8.776], ['Würzburg', 49.792, 9.953], ['Ulm', 48.401, 9.988],
    ['Heilbronn', 49.142, 9.219], ['Pforzheim', 48.892, 8.695], ['Wolfsburg', 52.423, 10.787], ['Göttingen', 51.541, 9.916],
    ['Bottrop', 51.524, 6.929], ['Reutlingen', 48.492, 9.204], ['Koblenz', 50.357, 7.589], ['Bremerhaven', 53.540, 8.581],
    ['Recklinghausen', 51.614, 7.198], ['Bergisch Gladbach', 50.992, 7.130], ['Erlangen', 49.590, 11.004], ['Jena', 50.927, 11.589],
    ['Remscheid', 51.179, 7.189], ['Trier', 49.750, 6.637], ['Salzgitter', 52.154, 10.333], ['Moers', 51.451, 6.626],
    ['Siegen', 50.875, 8.024], ['Hildesheim', 52.150, 9.951], ['Gütersloh', 51.906, 8.378], ['Cottbus', 51.756, 14.332],
    ['Kaiserslautern', 49.444, 7.769], ['Schwerin', 53.635, 11.401], ['Witten', 51.443, 7.335], ['Gera', 50.880, 12.083],
    ['Iserlohn', 51.376, 7.700], ['Zwickau', 50.719, 12.496], ['Flensburg', 54.784, 9.437], ['Düren', 50.804, 6.493],
    ['Ratingen', 51.297, 6.849], ['Lünen', 51.616, 7.528], ['Marl', 51.656, 7.090], ['Velbert', 51.340, 7.043],
    ['Brühl', 50.829, 6.904], ['Troisdorf', 50.816, 7.156], ['Frechen', 50.912, 6.811], ['Hürth', 50.877, 6.876],
    ['Siegburg', 50.796, 7.206], ['Konstanz', 47.660, 9.175], ['Rosenheim', 47.857, 12.128], ['Passau', 48.567, 13.431],
    ['Bamberg', 49.898, 10.902], ['Bayreuth', 49.945, 11.576], ['Fulda', 50.552, 9.676], ['Gießen', 50.584, 8.678],
    ['Marburg', 50.809, 8.771], ['Wilhelmshaven', 53.530, 8.106], ['Stralsund', 54.315, 13.089], ['Greifswald', 54.093, 13.388],
    ['Dessau-Roßlau', 51.836, 12.243], ['Plauen', 50.495, 12.138], ['Görlitz', 51.153, 14.987], ['Frankfurt (Oder)', 52.347, 14.550],
  ];
  /** nächstgelegene Stadt (bis 35 km), sonst '' */
  function cityOf(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    let best = '', bd = 35;
    const k = Math.cos(lat * Math.PI / 180) * 111;
    for (const [n, a, b] of CITIES) {
      const d = Math.hypot((lat - a) * 111, (lon - b) * k);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  /** Stadt aus dem Namen eines Verkehrsbetriebs ableiten ("Stadtwerke Bonn", "Leipziger Verkehrsbetriebe", "MVG" ...) */
  const ABBR = { KVB: 'Köln', BVG: 'Berlin', MVG: 'München', HVV: 'Hamburg', VGF: 'Frankfurt am Main', SSB: 'Stuttgart', LVB: 'Leipzig',
    DVB: 'Dresden', VAG: 'Nürnberg', BSAG: 'Bremen', ÜSTRA: 'Hannover', RSAG: 'Rostock', KVG: 'Kiel', KVV: 'Karlsruhe', ASEAG: 'Aachen',
    DSW21: 'Dortmund', DVG: 'Duisburg', EVAG: 'Essen', WSW: 'Wuppertal', SWB: 'Bonn', RNV: 'Mannheim', HEAG: 'Darmstadt', ESWE: 'Wiesbaden',
    MVV: 'München', VBK: 'Karlsruhe', SWM: 'München', HOCHBAHN: 'Hamburg', VHH: 'Hamburg', RHEINBAHN: 'Düsseldorf', BOGESTRA: 'Bochum' };
  function cityFromName(name) {
    if (!name) return '';
    const up = name.toUpperCase();
    for (const [k, v] of Object.entries(ABBR)) if (new RegExp('(^|[^A-ZÄÖÜ])' + k + '([^A-ZÄÖÜ]|$)').test(up)) return v;
    const low = name.toLowerCase();
    for (const [n] of CITIES) {
      const base = n.split(/[ (]/)[0].toLowerCase();
      const stem = base.length > 5 ? base.slice(0, 5) : base;  // "Münch" trifft München/Münchner, "Leipz" Leipziger
      if (new RegExp('(^|[^a-zäöüß])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(low)) return n;
    }
    return '';
  }
  /** häufigste Städte eines Aggregats (mit Rückfall auf den Betriebsnamen) */
  function topCities(agg, k = 2) {
    const c = Object.entries(agg.cities || {}).sort((x, y) => y[1] - x[1]).slice(0, k).map((x) => x[0]);
    if (c.length) return c;
    const g = cityFromName(agg.agency);
    return g ? [g] : [];
  }

  /** Einheitliche Liniennamen für App und Sammler: { name, product } */
  function normLineName(raw, product) {
    let name = String(raw || '?').trim().replace(/\s*\(\d+\)\s*$/, '');      // "RE7 (11292)" -> "RE7"
    const rail = /^(ICE|ICD|IC|EC|ECE|EN|NJ|RJX?|TGV|FLX|WB)\b/i.exec(name);
    if (rail || product === 'national' || product === 'nationalExpress') {
      const cat = (rail ? rail[1] : name.split(/\s+/)[0]).toUpperCase();
      return { name: cat, product: cat === 'ICE' || cat === 'ICD' ? 'nationalExpress' : 'national' };
    }
    name = name.replace(/^(STR|Str|Tram|Stadtbahn|Bus|BUS)\s+/, '').trim() || name;
    const isRailName = /^(S|RE|RB|U)\s?\d/i.test(name);
    if (product === 'bus' && /^(S|RE|RB)\s?\d/i.test(name)) return { name: name.replace(/\s+/g, '') + ' Ersatzbus', product: 'bus' };
    if (isRailName) {
      name = name.replace(/\s+/g, '');
      if (/^S\d/i.test(name)) product = 'suburban';
      else if (/^U\d/i.test(name)) product = 'subway';
      else if (/^RE\d/i.test(name)) product = 'regionalExpress';
      else if (/^RB\d/i.test(name)) product = 'regional';
    }
    return { name, product };
  }

  const api = { cityOf, cityFromName, topCities, normLineName, newAgg, addObs, mergeAgg, mergeMaps, summary, coarsePunct, pruneDays, berlin, HB, CB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PStats = api;
})(typeof self !== 'undefined' ? self : this);
