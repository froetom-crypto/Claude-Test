// Kostenlose Variante ohne API-Schlüssel: Die KI läuft direkt im Browser.
//  - Xenova/opus-mt-de-en übersetzt eine deutsche Beschreibung ins Englische
//  - Xenova/siglip-base-patch16-224 (SigLIP, Nachfolger von CLIP) bewertet, wie gut Text und Bild zusammenpassen
// Die Modelle (zusammen ca. 300 MB) werden beim ersten Mal von Hugging Face geladen und danach
// im Browser-Cache gehalten. Die Bibliothek wird erst geladen, wenn diese Variante gebraucht wird.

const MODEL_ID = 'Xenova/siglip-base-patch16-224';
const TRANSLATE_ID = 'Xenova/opus-mt-de-en';

let lib = null;
let clip = null;
let translator = null;

async function loadLib() {
  if (!lib) {
    lib = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js');
    lib.env.allowLocalModels = false;
  }
  return lib;
}

// Fortschritt mehrerer Dateien zu einer Prozentzahl zusammenfassen.
function progressTracker(label, onStatus) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      onStatus(`${label} … ${Math.round((loaded / total) * 100)} % (${Math.round(total / 1e6)} MB, nur beim ersten Mal)`);
    }
  };
}

function friendly(e) {
  return new Error(`Die kostenlose Bild-KI konnte nicht geladen werden (${e?.message || e}). Braucht eine Verbindung zu huggingface.co und cdn.jsdelivr.net und einen aktuellen Browser. Alternativ einen API-Schlüssel eintragen.`);
}

async function loadClip(onStatus) {
  if (clip) return clip;
  try { return await loadClipInner(onStatus); } catch (e) { throw friendly(e); }
}

async function loadClipInner(onStatus) {
  const T = await loadLib();
  const progress_callback = progressTracker('Lade Bild-KI', onStatus);
  const opts = { dtype: 'q8', device: 'wasm', progress_callback };
  const [tokenizer, processor, textModel, visionModel] = await Promise.all([
    T.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
    T.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
    T.SiglipTextModel.from_pretrained(MODEL_ID, opts),
    T.SiglipVisionModel.from_pretrained(MODEL_ID, opts),
  ]);
  clip = { tokenizer, processor, textModel, visionModel };
  return clip;
}

const DE = /\b(der|die|das|ein|eine|einer|und|mit|auf|im|ist|sind|vor|von|zu|am|unter|neben|über|ich|nicht)\b|[äöüß]/gi;
const EN = /\b(the|a|an|and|with|on|in|is|are|of|at|by|under|next|over)\b/gi;

export function looksGerman(text) {
  return (text.match(DE) || []).length > (text.match(EN) || []).length;
}

export async function toEnglish(text, onStatus) {
  if (!looksGerman(text)) return text;
  if (!translator) {
    try {
      const T = await loadLib();
      translator = await T.pipeline('translation', TRANSLATE_ID, {
        dtype: 'q8', device: 'wasm', progress_callback: progressTracker('Lade Übersetzer', onStatus),
      });
    } catch (e) { throw friendly(e); }
  }
  onStatus('Übersetze die Beschreibung …');
  const out = await translator(text);
  return out?.[0]?.translation_text?.trim() || text;
}

// Nicht alle Bildserver liefern CORS-Header. Dann über den freien Bild-Proxy wsrv.nl laden
// (der verkleinert auch gleich, das spart Datenvolumen).
const viaProxy = (url) => `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=336&h=336&fit=inside&output=jpg`;

// Erst die Vorschau direkt, dann das Original direkt, zuletzt über den Proxy.
async function loadImage(T, it) {
  const tries = [it.preview, it.full !== it.preview ? it.full : null, viaProxy(it.full || it.preview)].filter(Boolean);
  let err;
  for (const url of tries) {
    try { return await T.RawImage.fromURL(url); } catch (e) { err = e; }
  }
  throw err;
}

function unit(data) {
  let n = 0;
  for (const v of data) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(data, (v) => v / n);
}

export function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Text-"Fingerabdrücke" (normierte Vektoren) für mehrere Texte auf einmal
export async function embedTexts(texts, onStatus) {
  const m = await loadClip(onStatus);
  const inputs = m.tokenizer(texts.map((t) => t.toLowerCase()), { padding: 'max_length', truncation: true });
  const { pooler_output } = await m.textModel(inputs);
  const dim = pooler_output.dims[1];
  return texts.map((_, i) => unit(pooler_output.data.subarray(i * dim, (i + 1) * dim)));
}

// Bild-"Fingerabdrücke"; null, wenn ein Bild nicht ladbar war
export async function embedImages(items, onStatus) {
  const T = await loadLib();
  const m = await loadClip(onStatus);
  const vecs = new Array(items.length).fill(null);
  let done = 0;
  const BATCH = 8;
  for (let i = 0; i < items.length; i += BATCH) {
    const group = items.slice(i, i + BATCH);
    const loaded = await Promise.all(group.map((it) => loadImage(T, it).catch(() => null)));
    const ok = loaded.map((img, k) => ({ img, idx: i + k })).filter((x) => x.img);
    if (ok.length) {
      const inputs = await m.processor(ok.map((x) => x.img));
      const { pooler_output } = await m.visionModel(inputs);
      const dim = pooler_output.dims[1];
      ok.forEach((x, k) => { vecs[x.idx] = unit(pooler_output.data.subarray(k * dim, (k + 1) * dim)); });
    }
    done += group.length;
    onStatus(`Bild-KI prüft ${items.length} Bilder … ${done}/${items.length}`);
  }
  return vecs;
}

// Ähnlichkeit Text/Bild in Prozent (SigLIP base: Logit ≈ 117 · cos − 12.9; −10 → 0 %, −1 → 100 %)
export const cosToPercent = (c) => Math.round(Math.max(0, Math.min(1, (117 * c - 12.9 + 10) / 9)) * 100);
