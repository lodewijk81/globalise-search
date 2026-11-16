// Query expansion with kweepeer (https://kweepeer.globalise.nl), as on dev.globalise.nl/search.
//
// Only lexical terms are expanded: the plain words and "phrases" typed in the bar, also inside
// ( … )~N, regions and NOT (but not in `a NOT IN b`, a single span query). Fields (person:, place:, …), picked records, wildcards (slaa*) and fuzzy
// words (timmerman~1) are left alone. kweepeer has its own query parser, which reads `person:coen`
// as words and drops wildcards, so it is asked about one term at a time, never the whole query.
//
// The search itself is unchanged: the tree from query.js is rewritten so that a word becomes
// (word OR "variant" OR …), with node types the compiler already knows.

export const KWEEPEER = 'https://kweepeer.globalise.nl';
const TIMEOUT_MS = 5000;

const cache = new Map(); // term -> Promise<{ term, sources: [{ id, name, expansions }] } | null>

// The key used for a term everywhere: what the user typed, without quotes, in lower case.
const termKey = (text) => text.replace(/^"|"$/g, '').trim().toLowerCase();

function expandable(text) {
  const clean = text.replace(/^"|"$/g, '').trim();
  if (!clean || clean === '*') return false;
  if (/[*?]/.test(clean) || /~\d*$/.test(clean)) return false; // wildcards and fuzzy words
  if (/^[\d\s.,-]+$/.test(clean)) return false; // numbers
  return true;
}

// Every lexical term in the tree, in order, without duplicates.
export function lexicalTerms(tree) {
  const out = new Map();
  const add = (text) => {
    if (expandable(text)) out.set(termKey(text), text.replace(/^"|"$/g, '').trim());
  };
  const visitItem = (item) => {
    if (item.kind === 'or') item.items.forEach(visitItem);
    else if (item.kind === 'word' && !item.fuzzy) add(item.text);
    else if (item.kind === 'phrase') add(item.text);
  };
  const visit = (node) => {
    if (!node) return;
    if (node.t === 'words') node.words.forEach(add);
    if (node.t === 'prox') node.items.forEach(visitItem);
    if (node.t === 'region' || node.t === 'not') visit(node.inner);
    // Not inside `a NOT IN b`: that is one span query, which can't take alternatives.
    if (node.parts) node.parts.forEach(visit);
  };
  visit(tree);
  return [...out.entries()].map(([key, text]) => ({ key, text }));
}

// Variants that can't add anything are dropped: the term itself in another case, and anything
// without a letter or digit. Quotes are removed, because every variant is searched as a phrase.
function cleanVariants(term, values) {
  const seen = new Set([termKey(term)]);
  const out = [];
  values.forEach((value) => {
    const clean = String(value).replace(/["\\]/g, '').trim();
    const key = clean.toLowerCase();
    if (!clean || !/[\p{L}\p{N}]/u.test(clean) || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  });
  return out;
}

async function fetchTerm(text) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const q = /\s/.test(text) ? `"${text}"` : text;
    const response = await fetch(`${KWEEPEER}/?q=${encodeURIComponent(q)}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`kweepeer ${response.status}`);
    const data = await response.json();
    // kweepeer keys the result by its own reading of the term; for one term there is one key.
    const bySource = new Map();
    Object.values(data.terms || {}).flat().forEach((source) => {
      const entry = bySource.get(source.source_id) || { id: source.source_id, name: source.source_name || source.source_id, expansions: [] };
      entry.expansions.push(...(source.expansions || []));
      bySource.set(source.source_id, entry);
    });
    const sources = [...bySource.values()]
      .map((source) => ({ ...source, expansions: cleanVariants(text, source.expansions) }))
      .filter((source) => source.expansions.length);
    return { term: text, sources };
  } finally {
    window.clearTimeout(timer);
  }
}

// { key -> { term, sources } } for the terms kweepeer has variants for. `failed` is true when
// kweepeer couldn't be reached for at least one term (the search then runs without those).
export async function fetchExpansions(terms) {
  let failed = false;
  const results = await Promise.all(terms.map(({ key, text }) => {
    if (!cache.has(key)) {
      cache.set(key, fetchTerm(text).catch((error) => {
        cache.delete(key); // try again next time
        console.warn('Query expansion failed for', text, error);
        failed = true;
        return null;
      }));
    }
    return cache.get(key).then((result) => [key, result]);
  }));
  const byKey = {};
  results.forEach(([key, result]) => {
    if (result?.sources.length) byKey[key] = result;
  });
  return { byKey, failed };
}

// --- Which variants are on --------------------------------------------------------------------

// Everything is on by default; `off` holds the ones the user unticked, as "term\tsource\tvariant".
export const offKey = (term, source, variant) => `${term}\t${source}\t${variant.toLowerCase()}`;

// The variants that are on for a term, over all sources, without duplicates.
export function activeVariants(key, byKey, off) {
  const entry = byKey[key];
  if (!entry) return [];
  const seen = new Set();
  const out = [];
  entry.sources.forEach((source) => source.expansions.forEach((variant) => {
    if (off.has(offKey(key, source.id, variant)) || seen.has(variant.toLowerCase())) return;
    seen.add(variant.toLowerCase());
    out.push(variant);
  }));
  return out;
}

// --- Rewriting the tree -----------------------------------------------------------------------

export function expandTree(tree, byKey, off) {
  const variantsOf = (text) => (expandable(text) ? activeVariants(termKey(text), byKey, off) : []);

  const expandItem = (item) => {
    if (item.kind === 'or') return { ...item, items: item.items.flatMap((inner) => { const out = expandItem(inner); return out.kind === 'or' ? out.items : [out]; }) };
    if ((item.kind === 'word' && !item.fuzzy) || item.kind === 'phrase') {
      const variants = variantsOf(item.text);
      if (!variants.length) return item;
      return { kind: 'or', items: [item, ...variants.map((text) => ({ kind: 'phrase', text }))] };
    }
    return item;
  };

  const visit = (node) => {
    if (!node) return node;
    switch (node.t) {
      case 'words': {
        const parts = node.words.map((word) => {
          const variants = variantsOf(word);
          if (!variants.length) return null;
          return { t: 'or', parts: [{ t: 'words', words: [word] }, ...variants.map((text) => ({ t: 'words', words: [`"${text}"`] }))] };
        });
        if (parts.every((part) => !part)) return node;
        const all = parts.map((part, index) => part || { t: 'words', words: [node.words[index]] });
        return all.length === 1 ? all[0] : { t: 'and', parts: all };
      }
      case 'prox':
        return { ...node, items: node.items.map(expandItem) };
      case 'region':
      case 'not':
        return { ...node, inner: visit(node.inner) };
      default:
        return node.parts ? { ...node, parts: node.parts.map(visit) } : node;
    }
  };
  return visit(tree);
}

// --- Keeping requests small -------------------------------------------------------------------
//
// search.globalise.nl refuses request bodies over about 11,000 bytes (nginx answers 500, without
// CORS headers, so the browser reports a CORS error). Expanded queries get long, so:
// 1. compactQuery merges alternatives that are all query_string on the same field into one
//    query_string: (slaaf) OR ("slaven") OR … instead of one object per variant.
// 2. msearchBatched sends the searches of one _msearch in as many requests as needed.

// In bytes, with room to spare: the server's limit is a little under 11,000.
export const MAX_BODY = 8000;

const isMergeable = (clause) => {
  const qs = clause?.query_string;
  return qs && Object.keys(clause).length === 1 && Object.keys(qs).every((key) => ['query', 'default_field', 'default_operator'].includes(key));
};

// A single word or phrase needs no brackets in `a OR b`; anything longer does.
const group = (query) => (/^("[^"]*"|[^\s"()]+)$/.test(query) ? query : `(${query})`);

export function compactQuery(node) {
  if (Array.isArray(node)) return node.map(compactQuery);
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, compactQuery(value)]));
  const bool = out.bool;
  if (!bool || !Array.isArray(bool.should) || bool.should.length < 2) return out;
  const onlyShould = Object.keys(bool).every((key) => key === 'should' || (key === 'minimum_should_match' && Number(bool[key]) === 1));
  if (!onlyShould || Object.keys(out).length !== 1) return out;
  // Group the query_string clauses by field and operator; leave everything else as it is.
  const groups = new Map();
  const rest = [];
  bool.should.forEach((clause) => {
    if (!isMergeable(clause)) {
      rest.push(clause);
      return;
    }
    const { default_field: field, default_operator: operator = 'OR' } = clause.query_string;
    const id = `${field}\t${operator}`;
    if (!groups.has(id)) groups.set(id, { field, operator, queries: [] });
    groups.get(id).queries.push(clause.query_string.query);
  });
  const merged = [...groups.values()].map(({ field, operator, queries }) => ({
    query_string: {
      query: queries.length === 1 ? queries[0] : queries.map(group).join(' OR '),
      default_field: field,
      default_operator: operator,
    },
  }));
  const should = [...merged, ...rest];
  return should.length === 1 ? should[0] : { bool: { ...bool, should } };
}

export class QueryTooLargeError extends Error {}

const encoder = new TextEncoder();
const searchSize = ({ index, body }) => encoder.encode(JSON.stringify({ index })).length + encoder.encode(JSON.stringify(body)).length + 2;

// Like esMsearch, but split over several requests so that each stays under MAX_BODY.
export async function msearchBatched(esMsearch, searches, signal) {
  if (searches.some((search) => searchSize(search) > MAX_BODY)) {
    throw new QueryTooLargeError('A single search is larger than the server accepts.');
  }
  const batches = [];
  let batch = [];
  let size = 0;
  searches.forEach((search) => {
    const next = searchSize(search);
    if (batch.length && size + next > MAX_BODY) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(search);
    size += next;
  });
  if (batch.length) batches.push(batch);
  const results = await Promise.all(batches.map((items) => esMsearch(items, signal)));
  return results.flat();
}
