// Which scan a snippet is on: for the link to the viewer, the scan number and a thumbnail of that
// scan next to the snippet.
//
// The documents index has the text of a whole document, without scan boundaries. So:
// 1. Elasticsearch gives the position of each snippet in that text (a script field on the
//    document, one small request per card). The position divided by the length is a first guess
//    at the scan: a document of 20 scans with the snippet halfway is probably on its 10th scan.
// 2. The transcription of that scan (the word annotations, from the object store) is searched for
//    the words of the snippet around the first hit. If they are not there, the neighbouring scans
//    are tried, nearest first.
// 3. The thumbnail is the whole scan, from its IIIF image service (in the inventory's manifest).
//
// The plain text of the inventory with a text range per scan (in the manifest) would give the
// scan without guessing, but the ranges don't match the published text at the moment, and the
// file can't be read in parts (it is stored compressed).

const TRANSCRIPTIONS = 'https://objectstore.surf.nl/87435b768620494e8e911c83d1997f24:globalise-data/annotations/transcriptions';
const MAX_TRIES = 30; // scans looked at per snippet at most (nearest first; usually 1 or 2)
const CONTEXT = 5; // words on either side of the hit that are compared
const CONCURRENCY = 6;
const TIMEOUT_MS = 10000;

// --- The scans of a document ---------------------------------------------------------------

// NL-HaNA_1.04.02_4054_0369-0372 -> the scan ids from the manifest, first to last. The manifest
// order is used rather than counting, in case numbers are skipped or have suffixes.
export function documentScans(doc, manifest) {
  const match = /^(.+_)(\d+)-(\d+)$/.exec(doc.name || '');
  const first = match ? `${match[1]}${match[2]}` : doc.name;
  const last = match ? `${match[1]}${match[3]}` : doc.name;
  const ids = (manifest?.items || []).map((canvas) => canvasScan(canvas.id));
  const from = ids.indexOf(first);
  const to = ids.indexOf(last);
  if (from >= 0 && to >= from) return ids.slice(from, to + 1);
  if (!match) return [first];
  // No manifest: count. Keeps the width of the number (0369).
  const width = match[2].length;
  const out = [];
  for (let n = Number(match[2]); n <= Number(match[3]); n += 1) out.push(`${match[1]}${String(n).padStart(width, '0')}`);
  return out;
}

const canvasScan = (id) => String(id || '').split('canvas:').pop();

// The scan's number as printed on the archive's scans: NL-HaNA_1.04.02_4054_0371 -> 371.
export function scanNumber(scan) {
  const match = /_(\d+)([A-Za-z]*)$/.exec(scan);
  return match ? `${Number(match[1])}${match[2]}` : scan;
}

// A thumbnail of a whole scan, `height` pixels high, from its IIIF image service in the manifest.
// Height rather than width, because a scan can be one page or a two-page spread.
export function scanThumbnail(manifest, scan, height = 240) {
  const canvas = (manifest?.items || []).find((item) => canvasScan(item.id) === scan);
  const body = canvas?.items?.[0]?.items?.[0]?.body;
  const service = [].concat(body?.service || [])[0];
  const id = service?.id || service?.['@id'];
  return id ? `${id}/full/,${height}/0/default.jpg` : '';
}

// --- Snippets ------------------------------------------------------------------------------

// The highlighter returns the stored text with `_hit_term=…` added to the annotations it marks
// (and plain words wrapped as [word](_hit_term=word)). Undo that to get the stored text back.
export function unhighlight(fragment) {
  return String(fragment)
    .replace(/\[([^\]]*)\]\((?:_hit_term=[^&)]*&?)+\)/g, '$1')
    .replace(/\((?:_hit_term=[^&)]*&)+/g, '(');
}

// The snippet for the viewer's link (see hitQuery): a few words of plain text around the first hit
// in the fragment. The viewer only finds a snippet that lies within one of its own highlight
// fragments around a hit, and those don't end where ours do, so the whole fragment often fails;
// a short piece around a hit is found. Annotation markup is dropped, also where the fragment
// starts or ends inside an annotation ("…atavia](type%3APlace) van" or "[Batavia](_hit_ter").
const SNIPPET_CONTEXT = 30; // characters on each side of the hit, extended to whole words
export function snippetText(fragment) {
  const cleaned = String(fragment)
    .replace(/^([^[\]]*)\]\([^)]*\)/, '$1')
    .replace(/^[^\s[\]()]*\)/, '')
    .replace(/\[([^\]]*)\](\([^)]*)?$/, '$1')
    .replace(/\[([^\]]*)$/, '$1');
  let text = '';
  let hit = null;
  let last = 0;
  for (const match of cleaned.matchAll(ANNOTATED)) {
    text += cleaned.slice(last, match.index);
    if (!hit && match[2].includes('_hit_term') && match[1].trim()) hit = [text.length, text.length + match[1].length];
    text += match[1];
    last = match.index + match[0].length;
  }
  text += cleaned.slice(last);
  if (!hit) return text.trim();
  const start = text.lastIndexOf(' ', Math.max(0, hit[0] - SNIPPET_CONTEXT)) + 1;
  const after = text.indexOf(' ', Math.min(text.length, hit[1] + SNIPPET_CONTEXT));
  return text.slice(start, after < 0 ? text.length : after).trim();
}

// The viewer on globalise.nl highlights a search on the scan when its link carries the query (`q`,
// in the portal's search syntax) and a snippet. The prototype's syntax (pills, NOT IN, regions,
// proximity) doesn't translate, so `q` is the words that were highlighted in the document's
// snippets, each quoted, joined by OR: the viewer then highlights those words.
const MAX_HIT_TERMS = 20;
export function hitQuery(fragments) {
  const terms = new Map();
  for (const fragment of fragments) {
    for (const match of String(fragment || '').matchAll(ANNOTATED)) {
      const text = match[1].replace(/\s+/g, ' ').trim();
      if (!match[2].includes('_hit_term') || !text) continue;
      const key = text.toLowerCase();
      if (!terms.has(key) && terms.size < MAX_HIT_TERMS) terms.set(key, text);
    }
  }
  return [...terms.values()].map((term) => `"${term.replace(/["\\]/g, '\\$&')}"`).join(' OR ');
}

// Words of a fragment, with which ones are hits. Annotation markup is dropped.
const ANNOTATED = /\[([^\]]*)\]\(([^)]*)\)/g;
export function fragmentWords(fragment) {
  const words = [];
  let last = 0;
  const push = (text, hit) => text.split(/\s+/).forEach((word) => {
    const norm = normalize(word);
    if (norm) words.push({ norm, hit });
  });
  for (const match of String(fragment).matchAll(ANNOTATED)) {
    push(fragment.slice(last, match.index), false);
    push(match[1], match[2].includes('_hit_term'));
    last = match.index + match[0].length;
  }
  push(String(fragment).slice(last), false);
  return words;
}

const normalize = (word) => word.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

// Pieces of the stored text to look for, longest first: the whole fragment, then its start, middle
// and end (a fragment may begin or end inside an annotation, which then isn't in the stored text
// as such).
export function needles(fragment) {
  const raw = unhighlight(fragment);
  const piece = 60;
  if (raw.length <= piece) return [raw];
  const middle = Math.floor((raw.length - piece) / 2);
  return [raw, raw.slice(0, piece), raw.slice(middle, middle + piece), raw.slice(-piece)];
}

// The search body that returns, for each fragment, its position in the document's text (or -1),
// followed by the length of the text.
export function positionsBody(docId, fragments) {
  return {
    size: 1,
    _source: false,
    query: { ids: { values: [docId] } },
    script_fields: {
      positions: {
        script: {
          source: "String t = params._source.annotatedText; if (t == null) { return null; } List out = new ArrayList(); for (def group : params.n) { int pos = -1; for (def s : group) { pos = t.indexOf(s); if (pos >= 0) { break; } } out.add(pos); } out.add(t.length()); return out;",
          params: { n: fragments.map(needles) },
        },
      },
    },
  };
}

// [-1 | position, …, length] -> a fraction per fragment, or null.
export function fractions(values, count) {
  if (!Array.isArray(values) || values.length !== count + 1) return Array(count).fill(null);
  const length = values[count] || 0;
  return values.slice(0, count).map((pos) => (pos >= 0 && length ? pos / length : null));
}

// --- Transcriptions ------------------------------------------------------------------------

const pages = new Map(); // scan -> Promise<{ words, lines } | null>
let running = 0;
const waiting = [];

async function limited(task) {
  if (running >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

// The words of a scan, in reading order.
function parsePage(data) {
  const words = (data?.items || [])
    .filter((item) => item.textGranularity === 'word')
    .map((item) => ({ norm: normalize([].concat(item.body || []).find((body) => body?.value)?.value || '') }));
  return { words: words.filter((word) => word.norm) };
}

export function scanTranscription(scan) {
  if (!pages.has(scan)) {
    pages.set(scan, limited(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(`${TRANSCRIPTIONS}/${encodeURIComponent(scan)}.json`, { signal: controller.signal });
        return response.ok ? parsePage(await response.json()) : null;
      } finally {
        clearTimeout(timer);
      }
    }).catch(() => {
      pages.delete(scan); // try again another time
      return null;
    }));
  }
  return pages.get(scan);
}

// --- Matching ------------------------------------------------------------------------------

// Two words are the same if they are equal, or one begins with the other and they differ by a
// letter or two (the transcriptions split and join words in different places: Trans„ porteerd).
const same = (a, b) => a === b || ((a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 2 && Math.min(a.length, b.length) >= 3);

// The best place on a page for the words of a fragment, around its first hit (or its middle when
// it has none): { index, score, of } with `of` the number of words compared.
export function matchOnPage(words, page) {
  if (!words.length || !page?.words.length) return null;
  const firstHit = words.findIndex((word) => word.hit);
  const anchor = firstHit >= 0 ? firstHit : Math.floor(words.length / 2);
  const from = Math.max(0, anchor - CONTEXT);
  const to = Math.min(words.length, anchor + CONTEXT + 1);
  let best = null;
  page.words.forEach((word, j) => {
    if (!same(word.norm, words[anchor].norm)) return;
    // Compare the context word by word, allowing one word to be missing or extra on either side.
    let score = 1;
    [[-1, from], [1, to - 1]].forEach(([step, end]) => {
      let i = anchor + step;
      let k = j + step;
      let slack = 1;
      while (step < 0 ? i >= end : i <= end) {
        const there = page.words[k];
        if (there && same(there.norm, words[i].norm)) {
          score += 1;
        } else if (slack && page.words[k + step] && same(page.words[k + step].norm, words[i].norm)) {
          k += step; slack -= 1; score += 1;
        } else if (slack && words[i + step] && there && same(there.norm, words[i + step].norm)) {
          i += step; slack -= 1; score += 1;
        }
        i += step;
        k += step;
      }
    });
    if (!best || score > best.score) best = { index: j, score, anchor, from, to };
  });
  return best && { ...best, of: to - from };
}

// Good enough: most of the context agrees. A short fragment, or one at the edge of a scan, has
// less context, so the bar is relative, with at least three words.
const accept = (match) => match && match.score >= Math.min(3, match.of) && match.score >= match.of * 0.5;

// Scans to try, in order: the previous snippet's scan and the next one (snippets come in text
// order), then outward from the guess: 4, 5, 3, 6, 2 … The guess from the position can be well
// off (tables and empty pages hold little text), so the search goes on past the neighbours.
function tryOrder(count, guess, hint) {
  const order = [];
  const add = (index) => {
    if (index >= 0 && index < count && !order.includes(index)) order.push(index);
  };
  if (hint != null) {
    add(hint);
    add(hint + 1);
  }
  add(guess);
  for (let d = 1; d < count; d += 1) {
    add(guess + d);
    add(guess - d);
  }
  return order.slice(0, MAX_TRIES);
}

// Where a fragment is: { scan, position (0-based in the document) } or null.
// `hint` is the scan index of the snippet before it in the same document, if known.
export async function locate(fragment, scans, fraction, hint = null) {
  if (!scans.length) return null;
  const words = fragmentWords(fragment);
  if (!words.length) return null;
  const guess = fraction == null ? (hint ?? 0) : Math.min(scans.length - 1, Math.floor(fraction * scans.length));
  let best = null;
  for (const index of tryOrder(scans.length, guess, hint)) {
    const page = await scanTranscription(scans[index]);
    const match = matchOnPage(words, page);
    if (accept(match) && (!best || match.score > best.match.score)) best = { index, match, page };
    if (best && best.match.score === best.match.of) break; // every word found: stop looking
    if (best && best.match.score >= best.match.of * 0.75) break; // good enough; don't fetch more
  }
  if (!best) return null;
  return { scan: scans[best.index], position: best.index };
}
