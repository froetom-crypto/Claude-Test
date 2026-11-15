// Reddit-Bildsuche: Beschreibung eingeben -> Kandidaten von Reddit holen -> Claude bewertet die Bilder -> Top 5
import { Anthropic, jsonSchemaOutputFormat } from './vendor/anthropic-sdk.js';
import { extractImages, prefilter, words, buildQueries, contentWords, detailParts } from './reddit.js';
import { searchWikimedia, searchOpenverse } from './sources.js';

const MODEL = 'claude-opus-5-5';
const MAX_CANDIDATES = 45;
const BATCH = 10;
const TOP = 5;
const KEY_STORE = 'bildsuche.apiKey';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* privat */ } },
};

$('key').value = store.get(KEY_STORE);
$('key').addEventListener('change', () => store.set(KEY_STORE, $('key').value.trim()));

function status(text, err = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', err);
}

// ---------- Reddit ----------
async function redditSearch(query, { sub, nsfw }) {
  const base = sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json` : 'https://www.reddit.com/search.json';
  const p = new URLSearchParams({ q: query, type: 'link', sort: 'relevance', t: 'all', limit: '50', raw_json: '1' });
  if (sub) p.set('restrict_sr', '1');
  if (nsfw) p.set('include_over_18', 'on');
  const r = await fetch(`${base}?${p}`);
  if (!r.ok) throw new Error(`Reddit ${r.status}`);
  return r.json();
}

// Reddit blockiert Abfragen von fremden Webseiten meistens. Dann: Arctic Shift, ein freies Reddit-Archiv
// mit CORS-Freigabe. Es liefert dieselben Beitragsdaten, verlangt aber immer ein Subreddit.
const ARCTIC = 'https://arctic-shift.photon-reddit.com/api';
const GENERAL_SUBS = ['pics', 'itookapicture'];

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Arctic Shift ist ein kostenloses Projekt: wenige Anfragen gleichzeitig, bei Überlastung kurz warten und wiederholen.
async function arctic(path, params) {
  const url = `${ARCTIC}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j.error) return j.data || [];
    const retry = r.status === 422 || r.status === 429 || r.status >= 500;
    if (!retry || attempt >= 2) throw new Error(`Arctic Shift ${r.status}${j.error ? ': ' + j.error : ''}`);
    await sleep(2000 * (attempt + 1) + Math.random() * 1000);
  }
}

// Führt Aufgaben mit höchstens `limit` gleichzeitig aus; `stop()` beendet vorzeitig.
async function pool(tasks, limit, stop = () => false) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !stop()) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; } catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results.filter(Boolean);
}

// Passendes Subreddit zu einem Stichwort, z. B. cat -> cats, dog -> dogpictures
async function subredditsFor(word, nsfw) {
  const re = new RegExp(`^${word}(s|es)?(pics|pictures|photos|photography|porn|images)?$`, 'i');
  const list = await arctic('subreddits/search', { subreddit_prefix: word, limit: '25' });
  return list
    .filter((s) => re.test(s.display_name || '') && s.allow_images !== false && (nsfw || !s.over18))
    .sort((x, y) => (y._meta?.num_posts || 0) - (x._meta?.num_posts || 0))
    .slice(0, 2)
    .map((s) => s.display_name);
}

const asListing = (posts) => ({ data: { children: posts.map((d) => ({ data: d })) } });

async function arcticCollect(englishText, extraSubs, nsfw) {
  const kw = contentWords(englishText);
  if (!kw.length) throw new Error('Bitte die Beschreibung etwas genauer formulieren.');
  const found = await pool(kw.slice(0, 3).map((k) => () => subredditsFor(k, nsfw).then((subs) => subs.map((sub) => ({ sub, k })))), 2);
  const topical = found.flatMap((f) => (f.status === 'fulfilled' ? f.value : []));
  for (const sub of extraSubs.slice(0, 3)) if (!topical.some((t) => t.sub.toLowerCase() === sub.toLowerCase())) topical.push({ sub, k: null });
  const subs = topical.slice(0, 4);

  // nur die letzten 2 Jahre: macht die Titelsuche in großen Subreddits viel schneller
  const after = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
  const titled = [], latest = [];
  for (const { sub, k } of subs) {
    const other = kw.find((w) => w !== k);
    if (other) titled.push({ subreddit: sub, title: other });
    latest.push(k ? { subreddit: sub } : { subreddit: sub, title: kw[0] });
  }
  const general = GENERAL_SUBS.flatMap((sub) => kw.slice(0, 2).map((w) => ({ subreddit: sub, title: w })));
  // wichtigste zuerst
  const jobs = [...titled, general[0], general[2], ...latest, general[1], general[3]].filter(Boolean);

  let images = 0, done = 0;
  const settled = await pool(jobs.map((j) => async () => {
    const listing = asListing(await arctic('posts/search', { ...j, after, limit: '100' }));
    images += extractImages(listing, { nsfw }).length;
    status(`Lade Reddit-Beiträge aus dem Archiv … ${++done}/${jobs.length} Anfragen, ${images} Bilder`);
    return listing;
  }), 2, () => images >= 150);
  return { settled, subs: [...new Set(subs.map((t) => t.sub))] };
}

let redditBlocked = false;

async function collectCandidates(queries, subreddits, nsfw, englishText = queries.join(' ')) {
  let settled = [];
  if (!redditBlocked) {
    const jobs = [...queries.slice(0, 3).map((q) => ({ q })), ...subreddits.slice(0, 3).map((sub) => ({ q: queries[0], sub }))];
    const first = await Promise.allSettled([redditSearch(jobs[0].q, { sub: jobs[0].sub, nsfw })]);
    if (first[0].status === 'fulfilled') {
      settled = [...first, ...await Promise.allSettled(jobs.slice(1).map((j) => redditSearch(j.q, { sub: j.sub, nsfw })))];
    } else {
      redditBlocked = true;
      console.warn('Reddit direkt gesperrt, nehme Arctic Shift:', first[0].reason?.message);
    }
  }
  if (redditBlocked) {
    status(`Reddit sperrt direkte Abfragen – suche über das Reddit-Archiv Arctic Shift …`);
    const r = await arcticCollect(englishText, subreddits, nsfw);
    settled = r.settled;
  }
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) {
    const why = settled.map((s) => s.reason?.message).filter(Boolean)[0] || 'unbekannt';
    throw new Error(`Reddit-Beiträge konnten nicht geladen werden (${why}). Bitte kurz warten und nochmal versuchen.`);
  }
  const byId = new Map();
  for (const s of ok) {
    for (const img of extractImages(s.value, { nsfw })) {
      const prev = byId.get(img.id);
      if (prev) prev.hits++; else byId.set(img.id, { ...img, hits: 1 });
    }
  }
  return [...byId.values()];
}

// ---------- Alle Quellen zusammen ----------
// Reddit (direkt oder über Arctic Shift), Wikimedia Commons und Openverse parallel abfragen.
async function gatherAll(queries, subreddits, nsfw, english) {
  const kw = contentWords(english);
  const q3 = kw.slice(0, 3).join(' ') || english;
  const q2 = kw.slice(0, 2).join(' ') || english;
  // zusätzlich je Einzelheit eine Suche (z. B. "cat", "window sill"), damit mehr passende Kandidaten dabei sind
  const partQ = detailParts(english).map((p) => contentWords(p).slice(0, 2).join(' ')).filter(Boolean);
  const wmQ = [...new Set([q3, q2, ...partQ])].slice(0, 4);
  const ovQ = [...new Set([q3, q2])];
  const jobs = [
    ['Reddit', collectCandidates(queries, subreddits, nsfw, english)],
    ...wmQ.map((q) => ['Wikimedia Commons', searchWikimedia(q, 30)]),
    ...ovQ.map((q) => ['Openverse', searchOpenverse(q)]),
  ];
  const names = jobs.map((j) => j[0]);
  const res = await Promise.allSettled(jobs.map((j) => j[1]));
  const valOf = (name) => res.flatMap((r, i) => (names[i] === name && r.status === 'fulfilled' ? r.value : []));
  const failed = [...new Set(res.map((r, i) => (r.status === 'rejected' ? `${names[i]} (${r.reason?.message || 'Fehler'})` : null)).filter(Boolean))];
  res.forEach((r, i) => r.status === 'rejected' && console.warn(names[i], r.reason?.message));

  const seen = new Set();
  // doppelte Bilder (gleiche Adresse oder gleicher Titel, z. B. Crossposts) nur einmal
  const uniq = (list) => list.filter((it) => {
    const keys = [it.full, it.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()].filter((k) => k && k.length > 8);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
  const groups = { reddit: uniq(valOf('Reddit')), wikimedia: uniq(valOf('Wikimedia Commons')), openverse: uniq(valOf('Openverse')) };
  return { groups, failed };
}

// Ausgewogene Auswahl: aus jeder Quelle die besten nach Titel, Rest auffüllen.
function balancedPool(groups, keywords, n) {
  const lists = Object.values(groups).filter((l) => l.length);
  if (!lists.length) return [];
  const per = Math.ceil(n / lists.length);
  const picked = lists.flatMap((l) => prefilter(l, keywords, per));
  const ids = new Set(picked.map((x) => x.id));
  const rest = prefilter(lists.flat().filter((x) => !ids.has(x.id)), keywords, Math.max(0, n - picked.length));
  return [...picked, ...rest].slice(0, n);
}

const sourceSummary = (groups) => `Reddit ${groups.reddit.length}, Wikimedia ${groups.wikimedia.length}, Openverse ${groups.openverse.length}`;

// ---------- Claude ----------
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    queries: { type: 'array', items: { type: 'string' }, description: '3 kurze englische Reddit-Suchanfragen, 2-4 Wörter, vom genauesten zum allgemeinsten' },
    subreddits: { type: 'array', items: { type: 'string' }, description: 'bis zu 3 passende Subreddit-Namen ohne r/' },
  },
  required: ['queries', 'subreddits'],
  additionalProperties: false,
};

const RATING_SCHEMA = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nr: { type: 'integer' },
          score: { type: 'integer', description: '0-100' },
          grund: { type: 'string', description: 'ein kurzer Satz auf Deutsch' },
        },
        required: ['nr', 'score', 'grund'],
        additionalProperties: false,
      },
    },
  },
  required: ['ratings'],
  additionalProperties: false,
};

function client(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

async function ask(c, { effort, schema, system, content }) {
  const msg = await c.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: jsonSchemaOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('Claude hat die Anfrage abgelehnt.');
  if (!msg.parsed_output) throw new Error(`Unerwartete Antwort von Claude (${msg.stop_reason}).`);
  return msg.parsed_output;
}

function planQueries(c, desc) {
  return ask(c, {
    effort: 'low',
    schema: PLAN_SCHEMA,
    system: 'Du hilfst, auf Reddit Bilder zu finden. Reddit-Suche durchsucht nur Beitragstitel, meist auf Englisch. Gib kurze, typische Titelbegriffe zurück, keine Satzzeichen oder Operatoren.',
    content: `Bildbeschreibung: ${desc}`,
  });
}

async function rateBatch(c, desc, items) {
  const content = [{ type: 'text', text: `Gesuchtes Bild: "${desc}"\n\nBewerte jedes der folgenden ${items.length} Bilder.` }];
  for (const it of items) {
    content.push({ type: 'text', text: `Bild ${it.nr} (Titel: "${it.title}", Quelle: ${it.source})` });
    content.push({ type: 'image', source: { type: 'url', url: it.preview } });
  }
  const out = await ask(c, {
    effort: 'medium',
    schema: RATING_SCHEMA,
    system: 'Du bewertest streng, wie genau ein Bild einer Beschreibung entspricht. Prüfe jedes Detail der Beschreibung (Motiv, Anzahl, Farben, Handlung, Umgebung, Stimmung, Perspektive). 90-100: alles stimmt. 60-89: Hauptmotiv stimmt, Details weichen ab. 30-59: nur teilweise passend. 0-29: passt nicht. Bewerte das, was auf dem Bild zu sehen ist, nicht den Titel. Gib für jedes Bild genau eine Bewertung mit seiner Nummer zurück.',
    content,
  });
  return out.ratings;
}

// Bewertet in 10er-Paketen parallel. Kann Anthropic ein Bild nicht laden, wird das Paket geteilt,
// bis das kaputte Bild allein übrig ist und übersprungen wird.
async function rateAll(c, desc, items, onProgress) {
  let done = 0;
  const run = async (group) => {
    try {
      const r = await rateBatch(c, desc, group);
      done += group.length; onProgress(done);
      return r;
    } catch (e) {
      const status = e?.status;
      if (status === 401 || status === 403) throw new Error('API-Schlüssel ungültig oder ohne Berechtigung.');
      if (status === 429) throw new Error('Zu viele Anfragen an die Claude-API – bitte kurz warten.');
      if (status === 400 && group.length > 1) {
        const mid = Math.ceil(group.length / 2);
        return [...await run(group.slice(0, mid)), ...await run(group.slice(mid))];
      }
      if (status === 400) { done += 1; onProgress(done); return []; }
      throw e;
    }
  };
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  return (await Promise.all(batches.map(run))).flat();
}

// ---------- Anzeige ----------
function render(list, { append = false, onSimilar = null } = {}) {
  const ol = $('results');
  if (!append) { ol.replaceChildren(); $('more').hidden = true; }
  for (const it of list) {
    const li = document.createElement('li');
    li.className = 'card result';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = it.title;
    img.referrerPolicy = 'no-referrer';
    // Vorschau (ca. 640 px) spart Datenvolumen; das Original öffnet der Link.
    const srcs = [it.preview, it.full, `https://wsrv.nl/?url=${encodeURIComponent(it.full)}&w=800&output=jpg`].filter((u, i, a) => u && a.indexOf(u) === i);
    let si = 0;
    img.src = srcs[0];
    img.addEventListener('error', () => { if (++si < srcs.length) img.src = srcs[si]; });
    const a = document.createElement('a');
    a.href = it.permalink; a.target = '_blank'; a.rel = 'noopener';
    a.append(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const head = document.createElement('div');
    head.className = 'head';
    if (it.score != null) {
      const s = document.createElement('span');
      s.className = 'score' + (it.score >= 80 ? ' hi' : '');
      s.textContent = `${it.score} %`;
      head.append(s);
    }
    const h = document.createElement('h2');
    h.textContent = it.title;
    head.append(h);
    meta.append(head);
    if (it.grund) {
      const p = document.createElement('p');
      p.className = 'why'; p.textContent = it.grund;
      meta.append(p);
    }
    const src = document.createElement('div');
    src.className = 'src';
    const link = document.createElement('a');
    link.href = it.permalink; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = `${it.source} öffnen`;
    if (it.credit) src.append(`${it.credit} · `);
    src.append(link);
    meta.append(src);
    if (onSimilar) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'similar';
      b.textContent = 'Mehr wie dieses';
      b.addEventListener('click', () => onSimilar(it));
      meta.append(b);
    }

    li.append(a, meta);
    ol.append(li);
  }
}

// ---------- Ablauf ohne API-Schlüssel: KI im Browser ----------
const LOCAL_CANDIDATES = 64;

async function searchLocal(desc, nsfw) {
  if (typeof WebAssembly !== 'object') throw new Error('Dieser Browser kann die Bild-KI nicht ausführen (kein WebAssembly).');
  const ai = await import('./local-ai.js');

  status('1/3 Bereite die Suche vor …');
  const english = await ai.toEnglish(desc, status);
  const queries = buildQueries(english);

  status(`2/3 Suche auf Reddit, Wikimedia Commons und Openverse nach „${english}“ …`);
  const { groups, failed } = await gatherAll(queries, [], nsfw, english);
  const pool = balancedPool(groups, words(english), LOCAL_CANDIDATES);
  if (!pool.length) throw new Error(`Keine Bilder zu „${english}“ gefunden${failed.length ? ` (nicht erreichbar: ${failed.join(', ')})` : ''}. Beschreibung anders formulieren?`);
  status(`3/3 Bild-KI prüft ${pool.length} Bilder (${sourceSummary(groups)}) …`);

  // Ganzer Satz + jede Einzelheit. Ein Bild muss möglichst ALLE Einzelheiten zeigen, um oben zu landen.
  const parts = detailParts(english);
  const [fullVec, ...partVecs] = await ai.embedTexts([english, ...parts], status);
  const vecs = await ai.embedImages(pool, status);
  const ranked = pool.flatMap((it, i) => {
    const v = vecs[i];
    if (!v) return [];
    const sFull = ai.cos(fullVec, v);
    const sParts = partVecs.map((p) => ai.cos(p, v));
    const mean = sParts.length ? sParts.reduce((x, y) => x + y, 0) / sParts.length : sFull;
    const weakest = sParts.length ? Math.min(...sParts) : sFull;
    const s = sParts.length ? 0.5 * sFull + 0.3 * mean + 0.2 * weakest : sFull;
    return [{ ...it, vec: v, s, score: ai.cosToPercent(s) }];
  }).sort((a, b) => b.s - a.s)
    // fast gleich aussehende Bilder (z. B. Serienfotos) nur einmal
    .filter((r, i, all) => !all.slice(0, i).some((q) => ai.cos(q.vec, r.vec) > 0.95));
  if (!ranked.length) { status('Die Bilder konnten nicht geladen werden.', true); return; }

  const note = `${parts.length ? ` Geprüft auf: ${parts.map((p) => `„${p}“`).join(', ')}.` : ''}${failed.length ? ` Nicht erreichbar: ${failed.join(', ')}.` : ''}`;
  // "Mehr wie dieses": Text-Übereinstimmung und Ähnlichkeit zum gewählten Bild kombinieren
  const z = (arr) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length; const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) || 1; return arr.map((x) => (x - m) / sd); };
  const onSimilar = (chosen) => {
    const others = ranked.filter((r) => r.id !== chosen.id);
    const zt = z(others.map((r) => r.s));
    const zi = z(others.map((r) => ai.cos(r.vec, chosen.vec)));
    const resorted = others.map((r, i) => ({ r, k: zt[i] + 1.2 * zi[i] })).sort((a, b) => b.k - a.k).map((x) => x.r);
    showRanked([chosen, ...resorted], { text: `Bilder wie „${chosen.title.slice(0, 60)}“, die auch zur Beschreibung passen.${note}`, onSimilar });
  };
  showRanked(ranked, {
    text: `Die passendsten von ${ranked.length} Bildern aus Reddit, Wikimedia Commons und Openverse (gesucht nach „${english}“).${note}`,
    onSimilar,
  });
}

// Ergebnisliste mit "Weitere 5 zeigen"; onSimilar (optional) zeigt den Knopf "Mehr wie dieses"
function showRanked(ranked, { text, onSimilar }) {
  let shown = 0;
  $('results').replaceChildren();
  const more = () => {
    const next = ranked.slice(shown, shown + TOP);
    shown += next.length;
    render(next, { append: true, onSimilar });
    $('more').hidden = shown >= ranked.length;
  };
  $('more').onclick = more;
  more();
  status(text);
  window.scrollTo({ top: $('status').offsetTop - 8, behavior: 'smooth' });
}

// ---------- Ablauf ----------
async function search(desc, nsfw) {
  const apiKey = $('key').value.trim();
  store.set(KEY_STORE, apiKey);
  $('results').replaceChildren();

  if (!apiKey) return searchLocal(desc, nsfw);

  const c = client(apiKey);
  status('1/3 Claude bereitet die Suchbegriffe vor …');
  let plan;
  try { plan = await planQueries(c, desc); } catch (e) {
    if (e?.status === 401) throw new Error('API-Schlüssel ungültig.');
    throw e;
  }
  const queries = plan.queries.filter(Boolean);
  if (!queries.length) queries.push(desc);

  status(`2/3 Suche auf Reddit, Wikimedia Commons und Openverse: ${queries.map((q) => `„${q}“`).join(', ')} …`);
  const { groups, failed } = await gatherAll(queries, plan.subreddits, nsfw, queries[0]);
  const kw = words(queries.join(' '));
  const pool = balancedPool(groups, kw, MAX_CANDIDATES).map((it, i) => ({ ...it, nr: i + 1 }));
  if (!pool.length) throw new Error(`Keine Bilder gefunden${failed.length ? ` (nicht erreichbar: ${failed.join(', ')})` : ''}. Beschreibung anders formulieren?`);
  status(`3/3 Claude prüft ${pool.length} Bilder … 0/${pool.length}`);
  const ratings = await rateAll(c, desc, pool, (n) => status(`3/3 Claude prüft ${pool.length} Bilder … ${n}/${pool.length}`));

  const byNr = new Map(pool.map((it) => [it.nr, it]));
  const top = ratings
    .filter((r) => byNr.has(r.nr))
    .map((r) => ({ ...byNr.get(r.nr), score: Math.max(0, Math.min(100, r.score)), grund: r.grund }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP);
  render(top);
  status(top.length
    ? `Die ${top.length} passendsten von ${pool.length} geprüften Bildern.${top[0].score < 60 ? ' Kein Bild passt wirklich gut – vielleicht die Beschreibung vereinfachen.' : ''}`
    : 'Keines der Bilder konnte bewertet werden.', !top.length);
}

$('search').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const desc = $('desc').value.trim();
  if (!desc) return;
  $('go').disabled = true;
  try {
    await search(desc, $('nsfw').checked);
  } catch (e) {
    console.error(e);
    status(e?.message || String(e), true);
  } finally {
    $('go').disabled = false;
  }
});
