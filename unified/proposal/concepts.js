// Thesaurus concepts for the suggestions and the concept cards, using the richer thesaurus index
// (labels, definitions, external matches, hierarchy paths).
//
// - Suggestions for a concept field (occupation, status, …) ask the index only for concepts in
//   the branches of the thesaurus that field actually uses. The branches are read from the
//   documents and persons indexes once per session.
// - Every suggestion is counted with the same clauses the search itself uses (fieldClause), in
//   documents and in persons, so a count says what picking it will find. Zero means it would find
//   nothing, so it isn't offered.
// - The hierarchy (broader and narrower concepts) comes from the thesaurus paths; narrower
//   concepts come from the paths in documents and persons, so only ones in use are listed.

import { countOf, esMsearch, esSearch, splitTitles } from '../api.js';
import { fieldClause } from './query.js';
import { conceptLabelsEn } from './labels.js';

const INDEX = 'thesaurus-objects';
const COUNT_SCOPES = ['documents', 'persons'];
const RECORD_SOURCE = ['title', 'description', 'identifier', 'related', 'facets.concept_hierarchy', 'facets.concept_scheme'];

// Where each field's concepts sit in the hierarchy fields of documents and persons.
const OCCUPATION_TREES = [['documents', 'professionIdPaths.tree'], ['persons', 'occupationIdPaths.tree']];
const STATUS_TREES = [['persons', 'statusIdPaths.tree']];
const IDENTITY_TREES = [['persons', 'identityIdPaths.tree']];
const DOCTYPE_TREES = [['documents', 'documentTypeIdPaths.tree']];
const TREES = {
  profession: OCCUPATION_TREES,
  status: STATUS_TREES,
  identity: IDENTITY_TREES,
  documenttype: DOCTYPE_TREES,
  // Roles in the text are occupation, status and identity concepts.
  role: [...OCCUPATION_TREES, ...STATUS_TREES, ...IDENTITY_TREES],
  concept: [...OCCUPATION_TREES, ...STATUS_TREES, ...IDENTITY_TREES, ...DOCTYPE_TREES],
};

const escapeRegex = (text) => text.replace(/[.?+*|{}[\]()"\\#@&<>~]/g, '\\$&');

// --- Records ------------------------------------------------------------------------------

const records = new Map(); // id -> _source | null

function remember(hits) {
  hits.forEach((hit) => records.set(hit._id, hit._source));
}

export const conceptRecord = (id) => records.get(id) || null;

export async function loadConcepts(ids) {
  const missing = [...new Set(ids.filter(Boolean))].filter((id) => !records.has(id));
  for (let i = 0; i < missing.length; i += 500) {
    const batch = missing.slice(i, i + 500);
    const data = await esSearch(INDEX, { size: batch.length, _source: RECORD_SOURCE, query: { ids: { values: batch } } }).catch(() => null);
    remember(data?.hits?.hits || []);
    batch.forEach((id) => {
      if (!records.has(id)) records.set(id, null);
    });
  }
}

// The broader concepts of a concept, one list per path, top first. Paths in the index start with
// the concept scheme, which is not a concept itself, and end with the concept.
export function broaderPaths(source, id) {
  const schemes = new Set((source?.facets?.concept_scheme || []).map((path) => path.split('|')[0]));
  return (source?.facets?.concept_hierarchy || [])
    .map((path) => path.split('|').filter((part) => !schemes.has(part)))
    .map((parts) => (parts[parts.length - 1] === id ? parts.slice(0, -1) : parts))
    .filter((parts) => parts.length);
}

// --- Counts -------------------------------------------------------------------------------

const countCache = new Map(); // `${field}:${id}` -> { documents, persons }

function countScopes(def) {
  return COUNT_SCOPES.filter((scope) => def.scopes.includes(scope));
}

// For each id: how many documents and persons the pill `def.key:id` would find.
export async function usageCounts(def, ids, signal) {
  const todo = [...new Set(ids)].filter((id) => !countCache.has(`${def.key}:${id}`));
  const searches = [];
  todo.forEach((id) => {
    countScopes(def).forEach((scope) => {
      const clause = fieldClause({ fieldKey: def.key, value: id, id }, scope);
      if (clause) searches.push({ id, scope, index: scope, body: { size: 0, track_total_hits: true, query: clause } });
    });
  });
  const responses = searches.length ? await esMsearch(searches.map(({ index, body }) => ({ index, body })), signal) : [];
  todo.forEach((id) => countCache.set(`${def.key}:${id}`, { documents: 0, persons: 0 }));
  searches.forEach((search, index) => {
    countCache.get(`${def.key}:${search.id}`)[search.scope] = countOf(responses[index]);
  });
  return new Map(ids.map((id) => [id, countCache.get(`${def.key}:${id}`)]));
}

const total = (counts) => (counts?.documents || 0) + (counts?.persons || 0);

export function countText(counts) {
  const parts = [];
  if (counts?.documents) parts.push(`${counts.documents.toLocaleString('en-US')} document${counts.documents === 1 ? '' : 's'}`);
  if (counts?.persons) parts.push(`${counts.persons.toLocaleString('en-US')} person${counts.persons === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// --- Which part of the thesaurus a field uses ---------------------------------------------

const rootCache = new Map(); // field -> Promise<string[]>

function fieldRoots(def) {
  if (!rootCache.has(def.key)) {
    const trees = TREES[def.key] || [];
    rootCache.set(def.key, esMsearch(trees.map(([index, field]) => ({
      index,
      body: { size: 0, aggs: { roots: { terms: { field, size: 100, include: '[^|]+' } } } },
    })))
      .then((responses) => [...new Set(responses.flatMap((response) => (response?.aggregations?.roots?.buckets || []).map((bucket) => bucket.key)))]
        .filter((key) => !key.includes('/')))
      .catch(() => []));
  }
  return rootCache.get(def.key);
}

const inBranches = (roots) => ({
  nested: {
    path: 'facets',
    query: { bool: { should: roots.map((root) => ({ match_phrase: { 'facets.concept_hierarchy': root } })), minimum_should_match: 1 } },
  },
});

// --- Suggestions --------------------------------------------------------------------------

// The label that matched what was typed, if it isn't the first one.
function matchedLabel(titles, typed) {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return titles.find((title) => {
    const parts = title.toLowerCase().split(/[\s.,;:()/-]+/);
    return words.every((word) => parts.some((part) => part.startsWith(word)));
  }) || null;
}

// Items for suggest.js: { value, id, counts, matched, unused }. Concepts that would find nothing
// are left out, except for the `concept:` field, which also searches the Thesaurus tab: there a
// few unused ones are offered after the rest, marked as such.
export async function conceptSuggestions(def, prefix, signal) {
  const roots = def.key === 'concept' ? [] : await fieldRoots(def);
  const filter = roots.length ? [inBranches(roots)] : [];
  const data = await esSearch(
    INDEX,
    { size: 25, _source: RECORD_SOURCE, query: { bool: { must: [{ match_phrase_prefix: { title: { query: prefix, max_expansions: 200 } } }], filter } } },
    signal
  );
  const hits = data.hits?.hits || [];
  remember(hits);
  const counts = await usageCounts(def, hits.map((hit) => hit._id), signal);
  const items = hits.map((hit) => {
    const titles = splitTitles(hit._source.title);
    const matched = matchedLabel(titles, prefix);
    return { value: titles[0] || hit._id, id: hit._id, counts: counts.get(hit._id), matched: matched !== titles[0] ? matched : null };
  });
  const used = items.filter((item) => total(item.counts) > 0).sort((a, b) => total(b.counts) - total(a.counts)).slice(0, 10);
  if (def.key !== 'concept') return used;
  const unused = items.filter((item) => !total(item.counts)).slice(0, 3).map((item) => ({ ...item, unused: true }));
  return [...used, ...unused];
}

// --- Hierarchy ----------------------------------------------------------------------------

// Broader concepts (top first) and the most used narrower ones, each with counts for this field.
// Concepts that would find nothing are left out.
export async function conceptHierarchy(def, id, signal) {
  await loadConcepts([id]);
  const paths = broaderPaths(records.get(id), id);
  const broader = [...new Set(paths.flat())];
  const trees = TREES[def.key] || [];
  const childResponses = trees.length
    ? await esMsearch(trees.map(([index, field]) => ({
      index,
      body: { size: 0, aggs: { children: { terms: { field, size: 20, include: `(.*\\|)?${escapeRegex(id)}\\|[^|]+` } } } },
    })), signal).catch(() => [])
    : [];
  const narrower = [...new Set(childResponses.flatMap((response) => (response?.aggregations?.children?.buckets || []).map((bucket) => bucket.key.split('|').pop())))];
  const [counts, labelOf] = await Promise.all([usageCounts(def, [...broader, ...narrower], signal), conceptLabelsEn([...broader, ...narrower])]);
  const shown = (conceptId) => labelOf(conceptId) && total(counts.get(conceptId)) > 0;
  // Indent by the number of shown concepts above it on its (first) path.
  const depth = new Map();
  paths.forEach((parts) => parts.filter(shown).forEach((part, index) => {
    if (!depth.has(part)) depth.set(part, index);
  }));
  const entry = (conceptId) => ({ id: conceptId, label: labelOf(conceptId), counts: counts.get(conceptId), depth: depth.get(conceptId) || 0 });
  return {
    broader: broader.filter(shown).map(entry),
    narrower: narrower.map(entry).filter((item) => item.label && total(item.counts) > 0)
      .sort((a, b) => total(b.counts) - total(a.counts))
      .slice(0, 8),
  };
}

// --- Card details -------------------------------------------------------------------------

const MATCH_SOURCES = [
  ['vocab.getty.edu', 'Getty AAT'],
  ['www.wikidata.org', 'Wikidata'],
  ['data.cultureelerfgoed.nl', 'RCE thesaurus'],
  ['d-nb.info', 'GND'],
  ['personsincontext.org', 'Persons in Context'],
  ['lod.enslaved.org', 'Enslaved.org'],
  ['data.openbudgets.eu', 'OpenBudgets'],
  ['data.indischherinneringscentrum.nl', 'Indisch Herinneringscentrum'],
];

// A definition is its text, then a line like "Cited from:", "Paraphrased from:" or "Geciteerd uit:"
// with Source and Reference lines. GLOBALISE's own definitions and its translations of quoted
// definitions start with a marker.
export function parseDefinition(raw) {
  let text = String(raw || '').trim();
  // Spelled in several ways: [GLOBALISE translation], [GLOBALISE vertaling], [Globalise Definitie], …
  const marker = /^\[GLOBALISE[- ]?(\w+)\]\s*/i.exec(text);
  const kind = marker ? (/^(defini)/i.test(marker[1]) ? 'definition' : 'translation') : null;
  const translated = kind === 'translation';
  if (marker) text = text.slice(marker[0].length);
  const [body, cite = ''] = text.split(/\n\s*(?:\p{L}+ (?:from|uit)|Source|Bron)\s*:\s*/iu);
  const source = /(?:Source|Bron)\s*:\s*(\S+)/i.exec(cite)?.[1] || null;
  const reference = /(?:Reference|Referentie)\s*:\s*(.+)/i.exec(cite)?.[1]?.replace(/\*/g, '').trim() || null;
  return { text: body.trim(), kind, translated, source, reference };
}

// Links to the same concept in other vocabularies. Zotero entries are sources, and other
// GLOBALISE thesaurus ids are records merged into this one; neither is listed here.
export function externalMatches(identifiers) {
  const out = [];
  (Array.isArray(identifiers) ? identifiers : [identifiers]).filter(Boolean).forEach((url) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (host === 'www.zotero.org' || host === 'data.globalise.huygens.knaw.nl' || host === 'www.w3.org') return;
    const name = MATCH_SOURCES.find(([known]) => known === host)?.[1] || host;
    out.push({ name, url });
  });
  return out;
}
