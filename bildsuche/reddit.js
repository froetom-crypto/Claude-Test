// Reine Hilfsfunktionen (ohne DOM), damit sie auch in Node getestet werden können.

const IMG_EXT = /\.(jpe?g|png|webp|gif)(\?.*)?$/i;
const STOP = new Set(('a an the and or of in on at to with for from is are by my this that ' +
  'ein eine einer der die das und oder mit auf im in am an von zu ist sind').split(' '));

export function words(text) {
  return [...new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))];
}

const unescapeUrl = (u) => String(u).replace(/&amp;/g, '&');

// Größte Variante bis max. 640 px Breite (spart Tokens), sonst das Original.
function pickPreview(resolutions, source) {
  const fit = (resolutions || []).filter((r) => r.width <= 640);
  return (fit[fit.length - 1] || source)?.url || null;
}

// Bildbeiträge aus einer Reddit-Listing-Antwort (raw_json=1) holen.
export function extractImages(listing, { nsfw = false } = {}) {
  const out = [];
  for (const child of listing?.data?.children || []) {
    const p = child?.data;
    if (!p || p.is_video || p.removed_by_category) continue;
    if (p.over_18 && !nsfw) continue;
    let full = null, preview = null;

    if (p.is_gallery && p.media_metadata) {
      const first = p.gallery_data?.items?.[0]?.media_id || Object.keys(p.media_metadata)[0];
      const m = p.media_metadata[first];
      if (!m || m.status !== 'valid' || !m.s) continue;
      full = m.s.u || m.s.gif || null;
      preview = pickPreview((m.p || []).map((x) => ({ width: x.x, url: x.u })), { url: full });
    } else {
      const isImage = p.post_hint === 'image' || IMG_EXT.test(p.url || '');
      if (!isImage) continue;
      const pi = p.preview?.images?.[0];
      full = IMG_EXT.test(p.url || '') ? p.url : pi?.source?.url || null;
      preview = pi ? pickPreview(pi.resolutions, pi.source) : full;
    }
    if (!full || !preview) continue;
    full = unescapeUrl(full); preview = unescapeUrl(preview);
    out.push({
      id: p.id,
      title: p.title || '',
      subreddit: p.subreddit || '',
      author: p.author || '[gelöscht]',
      ups: p.ups ?? p.score ?? 0,
      permalink: `https://www.reddit.com${p.permalink}`,
      full,
      preview,
    });
  }
  return out;
}

// Vorauswahl: Titel-Übereinstimmung, mehrfach gefunden, Beliebtheit.
export function prefilter(cands, keywords, n) {
  const rank = (c) => {
    const t = words(c.title);
    const overlap = keywords.filter((k) => t.some((w) => w.startsWith(k) || k.startsWith(w))).length;
    const subHit = keywords.some((k) => (c.subreddit || '').toLowerCase().startsWith(k)) ? 2 : 0;
  return overlap * 3 + subHit + (c.hits || 1) * 2 + Math.log10(1 + Math.max(0, c.ups));
  };
  return [...cands].map((c) => ({ c, r: rank(c) })).sort((a, b) => b.r - a.r).slice(0, n).map((x) => x.c);
}

// Suchanfragen ohne Claude: von genau (alle Hauptwörter) bis breit (ODER-Verknüpfung).
export function buildQueries(english) {
  const kw = words(english);
  if (!kw.length) return [english];
  const q = [kw.slice(0, 4).join(' '), kw.slice(0, 2).join(' ')];
  if (kw.length > 1) q.push(kw.slice(0, 6).join(' OR '));
  return [...new Set(q)];
}

// Stichwörter ohne Farben, Verben und Füllwörter: gut für Subreddit-Namen und Titelsuche.
const WEAK = new Set(('red blue green yellow black white orange pink purple brown grey gray golden dark light bright ' +
  'big small little large tiny old young new beautiful cute happy sad funny ' +
  'sleeps sleeping sleep looks looking look sits sitting stands standing lies lying runs running walks walking ' +
  'plays playing holds holding eats eating outside inside into onto front behind while through under over next ' +
  'there here some very photo picture image camera').split(' '));
export function contentWords(text) {
  const all = words(text);
  const strong = all.filter((w) => !WEAK.has(w));
  return strong.length ? strong : all;
}
