// All network access: search requests, label lookups and the pill suggestions.

import { ES_BASE, FIELD_BY_KEY, ANNOTATION_TYPES, SCOPES } from './config.js';
import { hasWildcard } from './query.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TEXT = 'annotatedText';

export async function esSearch(index, body, signal) {
  const response = await fetch(`${ES_BASE}/${index}/_search`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  return response.json();
}

// searches: [{ index, body }]. Each result is the response, or an { error } for that search.
export async function esMsearch(searches, signal) {
  if (!searches.length) return [];
  const ndjson = `${searches.flatMap(({ index, body }) => [JSON.stringify({ index }), JSON.stringify(body)]).join('\n')}\n`;
  const response = await fetch(`${ES_BASE}/_msearch`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: ndjson, signal });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  const data = await response.json();
  return data.responses || [];
}

export const countOf = (response) => Number(response?.hits?.total?.value ?? 0);
const countBody = (query) => ({ size: 0, track_total_hits: true, query });

// --- Labels -------------------------------------------------------------------------------

// Most indexed fields hold thesaurus ids or place ids. Labels are fetched once per session.
const labelCache = new Map();

export const splitTitles = (titles) => [
  ...new Set(
    (Array.isArray(titles) ? titles : titles ? [titles] : [])
      .flatMap((title) => String(title).split('|'))
      .map((title) => title.trim())
      .filter(Boolean)
  ),
];

async function fetchLabels(index, ids, titleField = 'title') {
  const missing = [...new Set(ids)].filter((id) => id && !labelCache.has(`${index}:${id}`));
  for (let i = 0; i < missing.length; i += 1000) {
    const batch = missing.slice(i, i + 1000);
    const data = await esSearch(index, { size: batch.length, _source: [titleField], query: { ids: { values: batch } } });
    (data.hits?.hits || []).forEach((hit) => labelCache.set(`${index}:${hit._id}`, splitTitles(hit._source[titleField])[0] || hit._id));
    batch.forEach((id) => {
      if (!labelCache.has(`${index}:${id}`)) labelCache.set(`${index}:${id}`, null);
    });
  }
}

export async function conceptLabels(ids) {
  await fetchLabels('thesaurus-objects', ids);
  return (id) => labelCache.get(`thesaurus-objects:${id}`) || null;
}

export async function placeLabels(ids) {
  await fetchLabels('place-objects', ids);
  return (id) => labelCache.get(`place-objects:${id}`) || null;
}

export async function personLabels(ids) {
  await fetchLabels('persons', ids, 'titles');
  return (id) => labelCache.get(`persons:${id}`) || null;
}

// --- Filling in ids for typed pills -------------------------------------------------------

const resolveCache = new Map();

// `profession:koopman` typed by hand has only the word; the indices need the concept id.
export async function resolveConcept(value) {
  const key = value.trim().toLowerCase();
  if (resolveCache.has(key)) return resolveCache.get(key);
  const data = await esSearch('thesaurus-objects', { size: 30, _source: ['title'], query: { match_phrase: { title: value } } });
  const hits = data.hits?.hits || [];
  const exact = hits.find((hit) => splitTitles(hit._source.title).some((title) => title.toLowerCase() === key));
  const id = exact?._id || hits[0]?._id || null;
  resolveCache.set(key, id);
  return id;
}

// Mutates each chip that needs a concept id and doesn't have one yet.
export async function resolveChips(chips) {
  await Promise.all(
    chips.map(async (chip) => {
      if (chip.id || FIELD_BY_KEY.get(chip.fieldKey)?.source !== 'concept' || hasWildcard(chip.value)) return;
      const id = await resolveConcept(chip.value);
      if (id) chip.id = id;
    })
  );
}

// --- Thumbnails ---------------------------------------------------------------------------

const manifestCache = new Map();

const firstScanId = (name) => {
  const match = /^(.+_)(\d+)-\d+$/.exec(name || '');
  return match ? `${match[1]}${match[2]}` : name;
};

const manifestUrl = (inventory) => `https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/inventory:${inventory}.manifest`;

export function viewerUrl(doc) {
  const scan = firstScanId(doc.name);
  if (!scan || !doc.inventoryNumber) return '#';
  const params = new URLSearchParams({
    manifest: manifestUrl(doc.inventoryNumber),
    canvas: `https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/canvas:${scan}`,
  });
  return `https://dev.globalise.nl/manifest?${params}`;
}

export async function thumbnailUrl(doc) {
  const scan = firstScanId(doc.name);
  if (!scan || !doc.inventoryNumber) return '';
  if (!manifestCache.has(doc.inventoryNumber)) {
    manifestCache.set(
      doc.inventoryNumber,
      fetch(manifestUrl(doc.inventoryNumber), { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
    );
  }
  const manifest = await manifestCache.get(doc.inventoryNumber);
  const canvas = manifest?.items?.find((item) => typeof item?.id === 'string' && item.id.endsWith(scan));
  const body = canvas?.items?.[0]?.items?.[0]?.body;
  return body?.id ? body.id.replace('/full/max/', '/full/400,/') : '';
}

// --- Suggestions --------------------------------------------------------------------------

const titlePrefixQuery = (prefix) => ({ match_phrase_prefix: { title: { query: prefix, max_expansions: 200 } } });

async function objectCandidates(scope, prefix, signal, size = 8) {
  const data = await esSearch(SCOPES[scope].index, { size, query: titlePrefixQuery(prefix) }, signal);
  return (data.hits?.hits || []).map((hit) => {
    const variants = splitTitles(hit._source.title);
    // Several ships can share a name, so always say which record this is.
    return { value: variants[0] || hit._id, id: hit._id, variants, note: variants[1] ? `also ${variants[1]}` : hit._id };
  });
}

function usageSearch(countAs, id) {
  if (countAs === 'role') return { index: 'documents', body: countBody({ term: { [TEXT]: `personId:${id}` } }) };
  if (countAs === 'profession') return { index: 'documents', body: countBody({ match_phrase: { professionIdPaths: id } }) };
  if (countAs === 'documenttype') return { index: 'documents', body: countBody({ match_phrase: { documentTypeIdPaths: id } }) };
  if (countAs === 'status') return { index: 'persons', body: countBody({ term: { statuses: id } }) };
  if (countAs === 'identity') return { index: 'persons', body: countBody({ term: { identities: id } }) };
  return null;
}

// The thesaurus holds everything from professions to tools, so each pill keeps only the
// concepts that are actually used in the field it filters.
async function conceptSuggestions(def, prefix, signal) {
  const candidates = await objectCandidates('concepts', prefix, signal, 30);
  if (def.countAs === 'concept') return candidates.slice(0, 8).map((item) => ({ ...item, variants: undefined }));
  const responses = await esMsearch(candidates.map((item) => usageSearch(def.countAs, item.id)), signal);
  const unit = ['status', 'identity'].includes(def.countAs) ? 'persons' : 'documents';
  return candidates
    .map((item, index) => ({ value: item.value, id: item.id, count: countOf(responses[index]), unit }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// Place records have one title each, often an old spelling: Amsterdam's is "Aemsteldam". So the
// place list also asks the corpus which ids the typed spelling is actually tagged with.
async function attestedPlaces(prefix, signal) {
  const pattern = `${prefix.toLowerCase().replace(/[*?\\]/g, '')}*`;
  const query = {
    span_within: {
      big: { span_term: { [TEXT]: 'type:Place' } },
      little: { span_multi: { match: { wildcard: { [TEXT]: { value: pattern } } } } },
    },
  };
  const data = await esSearch(
    'documents',
    { size: 25, _source: false, query, highlight: { fields: { [TEXT]: { type: 'annotated', number_of_fragments: 8, fragment_size: 80 } } } },
    signal
  );
  const seen = new Map();
  (data.hits?.hits || []).forEach((hit) => {
    (hit.highlight?.[TEXT] || []).forEach((fragment) => {
      for (const match of fragment.matchAll(/\[([^\]]+)\]\(([^)]*_hit_term[^)]*)\)/g)) {
        const id = /placeId%3A([^&)]+)/.exec(match[2])?.[1];
        if (!id) continue;
        const surface = match[1].trim();
        const key = `${surface.toLowerCase()}|${id}`;
        const entry = seen.get(key) || { value: surface, id, seen: 0 };
        entry.seen += 1;
        seen.set(key, entry);
      }
    });
  });
  // One suggestion per place, using the spelling the corpus uses most often.
  const best = new Map();
  [...seen.values()].sort((a, b) => b.seen - a.seen).forEach((entry) => {
    if (!best.has(entry.id)) best.set(entry.id, entry);
  });
  return [...best.values()].slice(0, 6);
}

async function placeSuggestions(prefix, signal) {
  const [objects, attested] = await Promise.all([
    objectCandidates('places', prefix, signal, 12),
    attestedPlaces(prefix, signal).catch(() => []),
  ]);
  const label = await placeLabels(attested.map((item) => item.id));
  const merged = new Map();
  attested.forEach((item) => {
    const record = label(item.id);
    const differs = record && record.toLowerCase() !== item.value.toLowerCase();
    merged.set(item.id, { value: item.value, id: item.id, note: differs ? `record: ${record}` : '' });
  });
  objects.forEach((item) => {
    if (!merged.has(item.id)) merged.set(item.id, { value: item.value, id: item.id });
  });
  const items = [...merged.values()];
  const responses = await esMsearch(items.map((item) => ({ index: 'documents', body: countBody({ term: { [TEXT]: `placeId:${item.id}` } }) })), signal);
  return items
    .map((item, index) => ({ ...item, count: countOf(responses[index]), unit: 'documents' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function personSuggestions(prefix, signal) {
  const words = prefix.trim().split(/\s+/).filter(Boolean);
  const data = await esSearch(
    'persons',
    {
      size: 10,
      _source: ['titles'],
      query: { bool: { must: words.map((word) => ({ wildcard: { titles: { value: `*${word.replace(/([\\*?])/g, '\\$1')}*`, case_insensitive: true } } })) } },
    },
    signal
  );
  return (data.hits?.hits || []).map((hit) => {
    const variants = splitTitles(hit._source.titles);
    return { value: variants[0] || hit._id, id: hit._id, variants, note: variants.length > 1 ? `${variants.length} spellings` : '' };
  });
}

async function keywordSuggestions(field, prefix, signal) {
  const data = await esSearch(
    'documents',
    {
      size: 0,
      query: { prefix: { [field]: { value: prefix, case_insensitive: true } } },
      aggs: { values: { terms: { field, size: 10 } } },
    },
    signal
  );
  return (data.aggregations?.values?.buckets || []).map((bucket) => ({ value: bucket.key, id: bucket.key, count: bucket.doc_count, unit: 'documents' }));
}

let annotationCounts = null;

export function loadAnnotationCounts() {
  if (!annotationCounts) {
    const types = Object.keys(ANNOTATION_TYPES);
    annotationCounts = esMsearch(types.map((type) => ({ index: 'documents', body: countBody({ term: { [TEXT]: `type:${type}` } }) })))
      .then((responses) => new Map(types.map((type, index) => [type, countOf(responses[index])])))
      .catch(() => new Map());
  }
  return annotationCounts;
}

async function annotationSuggestions(prefix) {
  const counts = await loadAnnotationCounts();
  const lower = prefix.toLowerCase();
  return Object.entries(ANNOTATION_TYPES)
    .filter(([type, info]) => !lower || type.toLowerCase().includes(lower) || info.label.toLowerCase().includes(lower))
    .map(([type, info]) => ({ value: type, display: info.label, count: counts.get(type) ?? null, unit: 'documents' }))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, 12);
}

// archiveDescription is the readable form of eadIdPaths: its parts after the first line up with
// the levels of the path, which gives each level both a label and a filterable id.
export function archiveLevels(source) {
  const parts = String(source.archiveDescription || '').split(' • ').slice(1);
  const paths = source.eadIdPaths || [];
  const path = paths.find((candidate) => candidate.split('|').length === parts.length) || paths[0] || '';
  const ids = path.split('|');
  return parts.map((label, depth) => ({ label, path: ids.slice(0, depth + 1).join('|') }));
}

async function archiveSuggestions(prefix, signal) {
  const pattern = `*${prefix.replace(/([\\*?])/g, '\\$1')}*`;
  const data = await esSearch(
    'documents',
    { size: 200, _source: ['archiveDescription', 'eadIdPaths'], query: { wildcard: { archiveDescription: { value: pattern, case_insensitive: true } } } },
    signal
  );
  const lower = prefix.toLowerCase();
  const seen = new Map();
  (data.hits?.hits || []).forEach((hit) => {
    archiveLevels(hit._source)
      .filter((level) => level.label.toLowerCase().includes(lower))
      .forEach((level) => {
        const entry = seen.get(level.path) || { value: level.label, id: level.path, seen: 0 };
        entry.seen += 1;
        seen.set(level.path, entry);
      });
  });
  const items = [...seen.values()].sort((a, b) => b.seen - a.seen).slice(0, 10);
  const responses = await esMsearch(items.map((item) => ({ index: 'documents', body: countBody({ term: { 'eadIdPaths.tree': item.id } }) })), signal);
  return items.map((item, index) => ({ value: item.value, id: item.id, count: countOf(responses[index]), unit: 'documents' }));
}

// Everything a suggestion can carry ends up on the chip that is created from it.
export async function suggestionsFor(def, prefix, signal) {
  switch (def.source) {
    case 'place':
      return placeSuggestions(prefix, signal);
    case 'person':
      return personSuggestions(prefix, signal);
    case 'ship':
      return objectCandidates('ships', prefix, signal);
    case 'organisation':
      return objectCandidates('organisations', prefix, signal);
    case 'polity':
      return objectCandidates('polities', prefix, signal);
    case 'concept':
      return conceptSuggestions(def, prefix, signal);
    case 'annotation':
      return annotationSuggestions(prefix);
    case 'settlement':
      return keywordSuggestions('settlement', prefix, signal);
    case 'inventory':
      return keywordSuggestions('inventoryNumber', prefix, signal);
    case 'archive':
      return archiveSuggestions(prefix, signal);
    default:
      return [];
  }
}

// --- Facets -------------------------------------------------------------------------------

// Skip the broad top levels of a hierarchy; a list of "Beroepen" and "Rang" tells nobody much.
const DEEP_PATHS = '([^|]+\\|){2,}[^|]+';

const ARCHIVE_NODE_SOURCE = { top_hits: { size: 5, _source: ['archiveDescription', 'eadIdPaths'] } };

export const archiveInclude = (parent) => (parent ? `${parent.replace(/\|/g, '\\|')}\\|[^|]+` : '[^|]+');

export function archiveTermsAgg(parent) {
  return { terms: { field: 'eadIdPaths.tree', size: 60, include: archiveInclude(parent), order: { _count: 'desc' } }, aggs: { sample: ARCHIVE_NODE_SOURCE } };
}

export function facetAggs(scope) {
  if (scope === 'documents') {
    return {
      years: { date_histogram: { field: 'startDate', calendar_interval: 'year' } },
      settlements: { terms: { field: 'settlement', size: 13 } },
      professions: { terms: { field: 'professionIdPaths.tree', size: 30, include: DEEP_PATHS } },
      documentTypes: { terms: { field: 'documentTypeIdPaths.tree', size: 20 } },
      archive: archiveTermsAgg(''),
    };
  }
  if (scope === 'persons') {
    return {
      occupations: { terms: { field: 'occupationIdPaths.tree', size: 30, include: DEEP_PATHS } },
      statuses: { terms: { field: 'statuses', size: 12 } },
      identities: { terms: { field: 'identities', size: 12 } },
    };
  }
  return null;
}

// Children of one node in the archive tree, restricted to the current search.
export async function fetchArchiveChildren(parent, query) {
  const data = await esSearch('documents', { size: 0, query, aggs: { archive: archiveTermsAgg(parent) } });
  return data.aggregations?.archive?.buckets || [];
}

export function archiveNodeLabel(bucket) {
  const depth = bucket.key.split('|').length - 1;
  for (const hit of bucket.sample?.hits?.hits || []) {
    const level = archiveLevels(hit._source)[depth];
    if (level && level.path === bucket.key) return level.label;
  }
  return 'Archive section';
}

// --- Where a thesaurus concept is used ----------------------------------------------------

export async function conceptUsage(ids) {
  const perConcept = (id) => [
    { index: 'documents', body: countBody({ term: { [TEXT]: `personId:${id}` } }) },
    { index: 'documents', body: countBody({ match_phrase: { professionIdPaths: id } }) },
    { index: 'documents', body: countBody({ match_phrase: { documentTypeIdPaths: id } }) },
    { index: 'persons', body: countBody({ term: { occupations: id } }) },
    { index: 'persons', body: countBody({ term: { statuses: id } }) },
    { index: 'persons', body: countBody({ term: { identities: id } }) },
    { index: 'persons', body: { size: 0, aggs: { paths: { terms: { field: 'occupationIdPaths.tree', size: 1, include: `(.*\\|)?${id}` } } } } },
    { index: 'documents', body: { size: 0, aggs: { paths: { terms: { field: 'documentTypeIdPaths.tree', size: 1, include: `(.*\\|)?${id}` } } } } },
  ];
  const responses = await esMsearch(ids.flatMap(perConcept));
  const size = perConcept('x').length;
  return ids.map((id, index) => {
    const r = responses.slice(index * size, (index + 1) * size);
    const path = r[6]?.aggregations?.paths?.buckets?.[0]?.key || r[7]?.aggregations?.paths?.buckets?.[0]?.key || '';
    return { id, role: countOf(r[0]), profession: countOf(r[1]), documenttype: countOf(r[2]), occupation: countOf(r[3]), status: countOf(r[4]), identity: countOf(r[5]), path };
  });
}
