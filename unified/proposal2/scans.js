// Which scan a snippet is on, and where on the scan: for the link to the viewer, the scan number
// and a crop of the scan next to the snippet.
//
// The documents index has the text of a whole document, without scan boundaries. So:
// 1. Elasticsearch gives the position of each snippet in that text (a script field on the
//    document, one small request per card). The position divided by the length is a first guess
//    at the scan: a document of 20 scans with the snippet halfway is probably on its 10th scan.
// 2. The transcription of that scan (the line and word annotations with their outlines, from the
//    object store) is searched for the words of the snippet around the first hit. If they are not
//    there, the neighbouring scans are tried, nearest first.
// 3. The outlines of the matched lines give the region of the scan to show, cut out by the IIIF
//    image service. Word outlines are only used to centre a long line on the hit: they are
//    approximate (often a word off), so they aren't drawn.
//
// The plain text of the inventory with a text range per scan (in the manifest) would give the
// scan without guessing, but the ranges don't match the published text at the moment, and the
// file can't be read in parts (it is stored compressed).

const TRANSCRIPTIONS = 'https://objectstore.surf.nl/87435b768620494e8e911c83d1997f24:globalise-data/annotations/transcriptions';
const MAX_TRIES = 30; // scans looked at per snippet at most (nearest first; usually 1 or 2)
const CONTEXT = 5; // words on either side of the hit that are compared
const MAX_CROP_WIDTH = 2400; // canvas pixels, about a page column
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

// The image service and size of a scan, from the manifest.
export function scanImage(manifest, scan) {
  const canvas = (manifest?.items || []).find((item) => canvasScan(item.id) === scan);
  const body = canvas?.items?.[0]?.items?.[0]?.body;
  const service = [].concat(body?.service || [])[0];
  const id = service?.id || service?.['@id'];
  if (!id) return null;
  return { service: id, width: body.width || canvas.width, height: body.height || canvas.height, canvasWidth: canvas.width, canvasHeight: canvas.height };
}

// --- Snippets ------------------------------------------------------------------------------

// The highlighter returns the stored text with `_hit_term=…` added to the annotations it marks
// (and plain words wrapped as [word](_hit_term=word)). Undo that to get the stored text back.
export function unhighlight(fragment) {
  return String(fragment)
    .replace(/\[([^\]]*)\]\((?:_hit_term=[^&)]*&?)+\)/g, '$1')
    .replace(/\((?:_hit_term=[^&)]*&)+/g, '(');
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

// The points of an SvgSelector path ("M x,y x,y …z") as a bounding box.
function boxOf(target) {
  const svg = [].concat(target || []).map((part) => part?.selector).find((selector) => selector?.type === 'SvgSelector')?.value;
  const numbers = (svg?.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (numbers.length < 4) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    x0 = Math.min(x0, numbers[i]); x1 = Math.max(x1, numbers[i]);
    y0 = Math.min(y0, numbers[i + 1]); y1 = Math.max(y1, numbers[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function parsePage(data) {
  const lines = new Map(); // line id -> box
  const words = [];
  (data?.items || []).forEach((item) => {
    if (item.textGranularity === 'line') lines.set(item.id, boxOf(item.target));
    if (item.textGranularity !== 'word') return;
    const text = [].concat(item.body || []).find((body) => body?.value)?.value || '';
    const line = [].concat(item.target || []).map((part) => (typeof part === 'string' ? part : part?.id)).find((id) => lines.has(id));
    words.push({ norm: normalize(text), box: boxOf(item.target), line });
  });
  return { words: words.filter((word) => word.norm), lines };
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

// Where a fragment is: { scan, position (0-based in the document), region } or null.
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
  return { scan: scans[best.index], position: best.index, ...cropOf(best.page, best.match) };
}

// The lines with the matched words, as one region with some margin.
function cropOf(page, match) {
  const { index, anchor, from, to } = match;
  const lineIds = new Set();
  for (let k = index - (anchor - from); k < index + (to - anchor); k += 1) {
    if (page.words[k]?.line) lineIds.add(page.words[k].line);
  }
  // At most two lines either side of the hit's line, so the crop stays a strip.
  const hitLine = page.words[index].line;
  const ordered = [...page.lines.keys()];
  const at = ordered.indexOf(hitLine);
  const boxes = [...lineIds]
    .filter((id) => at < 0 || Math.abs(ordered.indexOf(id) - at) <= 1)
    .map((id) => page.lines.get(id))
    .filter(Boolean);
  if (!boxes.length && page.words[index].box) boxes.push(page.words[index].box);
  if (!boxes.length) return { region: null };
  let x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  let x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  // Long lines (a line across both pages of a spread) are cut to a window around the hit, so the
  // strip stays readable when it is scaled down.
  const mark = page.words[index].box;
  const maxWidth = Math.max(MAX_CROP_WIDTH, (y1 - y0) * 5);
  if (mark && x1 - x0 > maxWidth) {
    const centre = mark.x + mark.w / 2;
    x0 = Math.max(x0, Math.min(centre - maxWidth / 2, x1 - maxWidth));
    x1 = x0 + maxWidth;
  }
  const pad = 30;
  return { region: { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad } };
}

// The IIIF URL of a region (in canvas coordinates), scaled to fit `width` x `height` pixels.
export function cropUrl(image, region, width = 900, height = 200) {
  if (!image || !region) return '';
  const sx = image.width && image.canvasWidth ? image.width / image.canvasWidth : 1;
  const sy = image.height && image.canvasHeight ? image.height / image.canvasHeight : 1;
  const r = [region.x * sx, region.y * sy, region.w * sx, region.h * sy].map((n) => Math.max(0, Math.round(n)));
  return `${image.service}/${r.join(',')}/!${width},${height}/0/default.jpg`;
}
