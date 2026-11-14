// Reddit-Bildsuche: Beschreibung eingeben -> Kandidaten von Reddit holen -> Claude bewertet die Bilder -> Top 5
import { Anthropic, jsonSchemaOutputFormat } from './vendor/anthropic-sdk.js';
import { extractImages, prefilter, words, buildQueries } from './reddit.js';

const MODEL = 'claude-opus-5-5';
const MAX_CANDIDATES = 40;
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

// Ersatz, wenn Reddit Abfragen aus dem Browser blockiert: PullPush, ein freies Reddit-Archiv mit CORS-Freigabe.
async function pullpushSearch(query, { sub, nsfw }) {
  const p = new URLSearchParams({ q: query.replace(/ OR /g, ' | '), size: '100' });
  if (sub) p.set('subreddit', sub);
  if (!nsfw) p.set('over_18', 'false');
  const r = await fetch(`https://api.pullpush.io/reddit/search/submission/?${p}`);
  if (!r.ok) throw new Error(`PullPush ${r.status}`);
  const j = await r.json();
  return { data: { children: (j.data || []).map((d) => ({ data: d })) } };
}

let redditBlocked = false;
async function searchPosts(query, opts) {
  if (!redditBlocked) {
    try { return await redditSearch(query, opts); } catch (e) { redditBlocked = true; console.warn('Reddit direkt nicht erreichbar, nehme PullPush:', e.message); }
  }
  return pullpushSearch(query, opts);
}

async function collectCandidates(queries, subreddits, nsfw) {
  const jobs = [
    ...queries.slice(0, 3).map((q) => ({ q })),
    ...subreddits.slice(0, 3).map((sub) => ({ q: queries[0], sub })),
  ];
  // erst eine Anfrage, damit klar ist, ob Reddit direkt geht; dann der Rest parallel
  const first = await Promise.allSettled([searchPosts(jobs[0].q, { sub: jobs[0].sub, nsfw })]);
  const rest = await Promise.allSettled(jobs.slice(1).map((j) => searchPosts(j.q, { sub: j.sub, nsfw })));
  const settled = [...first, ...rest];
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) {
    const why = settled.map((s) => s.reason?.message).filter(Boolean)[0] || 'unbekannt';
    throw new Error(`Reddit war nicht erreichbar (${why}). Bitte kurz warten und nochmal versuchen.`);
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
    content.push({ type: 'text', text: `Bild ${it.nr} (Titel: "${it.title}", r/${it.subreddit})` });
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
function render(list) {
  const ol = $('results');
  ol.replaceChildren();
  for (const it of list) {
    const li = document.createElement('li');
    li.className = 'card result';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = it.title;
    img.referrerPolicy = 'no-referrer';
    img.src = it.full;
    img.addEventListener('error', () => { if (img.src !== it.preview) img.src = it.preview; }, { once: true });
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
    link.textContent = `r/${it.subreddit} öffnen`;
    src.append(`von u/${it.author} · ${it.ups} Upvotes · `, link);
    meta.append(src);

    li.append(a, meta);
    ol.append(li);
  }
}

// ---------- Ablauf ohne API-Schlüssel: KI im Browser ----------
const LOCAL_CANDIDATES = 48;

async function searchLocal(desc, nsfw) {
  if (typeof WebAssembly !== 'object') throw new Error('Dieser Browser kann die Bild-KI nicht ausführen (kein WebAssembly).');
  const ai = await import('./local-ai.js');

  status('1/3 Bereite die Suche vor …');
  const english = await ai.toEnglish(desc, status);
  const queries = buildQueries(english);

  status(`2/3 Suche auf Reddit: ${queries.map((q) => `„${q}“`).join(', ')} …`);
  const cands = await collectCandidates(queries, [], nsfw);
  if (!cands.length) { status(`Reddit hat keine Bildbeiträge zu „${english}“ geliefert. Beschreibung anders formulieren?`); return; }

  const pool = prefilter(cands, words(english), LOCAL_CANDIDATES);
  status(`3/3 Bild-KI prüft ${pool.length} Bilder …`);
  const sims = await ai.rankWithClip(english, pool, status);

  const top = pool
    .map((it, i) => ({ it, s: sims[i] }))
    .filter((x) => x.s != null)
    .sort((a, b) => b.s - a.s)
    .slice(0, TOP)
    .map(({ it, s }) => ({ ...it, score: ai.simToPercent(s) }));
  render(top);
  status(top.length
    ? `Die ${top.length} ähnlichsten von ${pool.length} Bildern (kostenlose Bild-KI im Browser, gesucht nach „${english}“). Mit API-Schlüssel wird die Bewertung genauer.`
    : 'Die Bilder konnten nicht geladen werden.', !top.length);
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

  status(`2/3 Suche auf Reddit: ${queries.map((q) => `„${q}“`).join(', ')}${plan.subreddits.length ? ' · r/' + plan.subreddits.slice(0, 3).join(', r/') : ''} …`);
  const cands = await collectCandidates(queries, plan.subreddits, nsfw);
  if (!cands.length) { status('Reddit hat keine passenden Bildbeiträge geliefert. Beschreibung anders formulieren?'); return; }

  const kw = words(queries.join(' '));
  const pool = prefilter(cands, kw, MAX_CANDIDATES).map((it, i) => ({ ...it, nr: i + 1 }));
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
