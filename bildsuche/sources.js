// Weitere freie Bilddatenbanken, die Abfragen aus dem Browser erlauben (ohne Schlüssel):
//  - Wikimedia Commons: über 100 Mio. freie Fotos
//  - Openverse: Suchmaschine für frei lizenzierte Bilder (Flickr, Museen, Wikimedia u. v. m.)

const cleanTitle = (t) => String(t || '')
  .replace(/^File:/i, '')
  .replace(/\.(jpe?g|png|webp|gif|tiff?)$/i, '')
  .replace(/_/g, ' ')
  .trim();

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();

export async function searchWikimedia(query, limit = 40) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrnamespace: '6', gsrsearch: `${query} filetype:bitmap`, gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|mime|user', iiurlwidth: '640',
  });
  const r = await fetch(`https://commons.wikimedia.org/w/api.php?${p}`);
  if (!r.ok) throw new Error(`Wikimedia ${r.status}`);
  const j = await r.json();
  const pages = Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.flatMap((pg) => {
    const ii = pg.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime || '')) return [];
    return [{
      id: `wm:${pg.pageid}`,
      title: cleanTitle(pg.title),
      source: 'Wikimedia Commons',
      credit: ii.user ? `von ${stripHtml(ii.user)}` : '',
      ups: 0,
      permalink: ii.descriptionurl || `https://commons.wikimedia.org/?curid=${pg.pageid}`,
      full: ii.url,
      preview: ii.thumburl || ii.url,
    }];
  });
}

const PROVIDER = { flickr: 'Flickr', wikimedia: 'Wikimedia', smithsonian: 'Smithsonian', nappy: 'nappy', stocksnap: 'StockSnap', rawpixel: 'rawpixel' };

// Ohne Konto erlaubt Openverse höchstens 20 Ergebnisse pro Abfrage (sonst 401).
export async function searchOpenverse(query, limit = 20) {
  const p = new URLSearchParams({ q: query, page_size: String(limit) });
  const r = await fetch(`https://api.openverse.org/v1/images/?${p}`);
  if (!r.ok) throw new Error(`Openverse ${r.status}`);
  const j = await r.json();
  return (j.results || []).filter((x) => x.url && !x.mature).map((x) => {
    const prov = PROVIDER[x.source] || x.source || x.provider || '';
    return {
      id: `ov:${x.id}`,
      title: x.title || '',
      source: `Openverse${prov ? ' · ' + prov : ''}`,
      credit: [x.creator ? `von ${x.creator}` : '', x.license ? `CC ${String(x.license).toUpperCase()}` : ''].filter(Boolean).join(' · '),
      ups: 0,
      permalink: x.foreign_landing_url || x.url,
      full: x.url,
      preview: x.thumbnail || x.url,
    };
  });
}
