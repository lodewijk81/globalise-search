const API_URL = 'https://search.globalise.huygens.knaw.nl/documents/_search';
// Bulk endpoint used only for the follow-up "get the exact match count for these specific
// documents" requests — see fetchExactMatchCounts. Batches one query per document into a
// single HTTP round trip instead of firing a request per document.
const MSEARCH_URL = 'https://search.globalise.huygens.knaw.nl/documents/_msearch';
const AUTOCOMPLETE_URL = 'https://search.globalise.huygens.knaw.nl/autocomplete/_search';
const SUGGEST_MIN_CHARS = 2;
const SUGGEST_DEBOUNCE_MS = 250;

const pageType = document.body.dataset.page || 'landing';
const landingForm = document.querySelector('#landing-search-form');
const resultsForm = document.querySelector('#results-search-form');
const sortSelect = document.querySelector('#sort-select');
const resultsContainer = document.querySelector('#results');
const statusContainer = document.querySelector('#status');
const paginationContainer = document.querySelector('#pagination');

const pageSize = 10;
let currentSort = 'relevance';
let currentPage = 1;
let currentQuery = '';
let currentChips = [];
let currentResults = [];
// Bumped at the start of every search(); a follow-up async request (see fetchExactMatchCounts)
// captures the token at request time and checks it before touching the DOM, so a slow response
// from a superseded search can't overwrite results from a newer one.
let searchToken = 0;

// Structured search fields exposed by the "documents" index, selectable via "field:value" in the search bar.
const FIELD_DEFS = [
  { key: 'person', label: 'Person', hint: 'Find mentions of a person by role, e.g. am*', kind: 'nested', type: 'Person' },
  { key: 'personname', label: 'Person name', hint: 'Find a specific named individual, e.g. Sleuter', kind: 'personname', aliases: ['name'] },
  { key: 'place', label: 'Place', hint: 'Find places mentioned in the text, e.g. am*', kind: 'nested', type: 'Place', aliases: ['location'] },
  { key: 'profession', label: 'Profession', hint: 'Find by profession, e.g. koop*', kind: 'text', field: 'professionLabelPaths' },
  { key: 'documenttype', label: 'Document type', hint: 'Find by document type, e.g. brief', kind: 'text', field: 'documentTypeLabelPaths', aliases: ['type', 'doctype'] },
  { key: 'settlement', label: 'Settlement', hint: 'Find by settlement, e.g. bat*', kind: 'keyword', field: 'settlement' },
  { key: 'inventory', label: 'Inventory number', hint: 'Find by exact inventory number, or e.g. 11*', kind: 'keyword', field: 'inventoryNumber', exact: true, aliases: ['inv', 'invnr'] },
  { key: 'year', label: 'Year', hint: 'e.g. 1685 or 1680-1690', kind: 'year', aliases: ['date'] },
];

const FIELD_BY_KEY = new Map(FIELD_DEFS.map((def) => [def.key, def]));
const FIELD_ALIASES = new Map();
FIELD_DEFS.forEach((def) => {
  FIELD_ALIASES.set(def.key, def.key);
  (def.aliases || []).forEach((alias) => FIELD_ALIASES.set(alias, def.key));
});

// Fields eligible for cross-field value suggestions when typing a bare word (no "field:"
// prefix yet). "year" is excluded since it isn't looked up via the /suggest endpoint.
const CROSS_SUGGEST_FIELDS = FIELD_DEFS.filter((def) => def.kind !== 'year');
// Cap on how many cross-field value suggestions are shown at once, so the dropdown
// doesn't get overwhelmed when a short prefix matches many fields.
const CROSS_SUGGEST_MAX_RESULTS = 8;

function getSearchParams() {
  const params = new URLSearchParams(window.location.search);
  const filters = params.get('filters') || '';
  const q = params.get('q');
  return {
    q: q !== null ? q : filters ? '' : 'corea~1',
    page: Number(params.get('page')) || 1,
    sort: params.get('sort') || 'relevance',
    filters,
  };
}

// Chips are usually just "fieldKey:value" for a compact, readable URL. Chips that came from a
// resolved suggestion (a linked place/person entity, or a profession hierarchy level) carry
// extra metadata needed to reproduce the richer search clause in chipToEsClause — those are
// encoded as "fieldKey:<json>" instead. Plain "fieldKey:value" chips (including ones from
// older shared URLs) always decode fine; they just don't get the richer matching behavior.
function encodeChips(chips) {
  return chips
    .map((chip) => {
      const extra = {};
      if (chip.resolvedId) extra.id = chip.resolvedId;
      if (chip.variants && chip.variants.length) extra.variants = chip.variants;
      if (chip.hierarchical) extra.h = 1;
      if (Object.keys(extra).length === 0) {
        return `${chip.fieldKey}:${encodeURIComponent(chip.value)}`;
      }
      return `${chip.fieldKey}:${encodeURIComponent(JSON.stringify({ value: chip.value, ...extra }))}`;
    })
    .join('|');
}

function decodeChips(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .map((part) => {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex === -1) return null;
      const fieldKey = part.slice(0, separatorIndex);
      if (!FIELD_BY_KEY.has(fieldKey)) return null;
      const rawValue = decodeURIComponent(part.slice(separatorIndex + 1));
      if (rawValue.startsWith('{')) {
        try {
          const payload = JSON.parse(rawValue);
          if (!payload.value) return null;
          const chip = { fieldKey, value: payload.value };
          if (payload.id) chip.resolvedId = payload.id;
          if (payload.variants) chip.variants = payload.variants;
          if (payload.h) chip.hierarchical = true;
          return chip;
        } catch (error) {
          return null;
        }
      }
      return rawValue ? { fieldKey, value: rawValue } : null;
    })
    .filter(Boolean);
}

function updateQueryState(query, chips, page, sort) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (chips.length) params.set('filters', encodeChips(chips));
  if (page > 1) params.set('page', String(page));
  if (sort && sort !== 'relevance') params.set('sort', sort);

  const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
  window.history.replaceState({}, '', nextUrl);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeWildcardValue(value) {
  return String(value).replace(/([\\*?])/g, '\\$1');
}

// A value containing an explicit `*`/`?` is treated as a literal Elasticsearch wildcard
// pattern (e.g. "am*"), otherwise it's escaped and wrapped as a "*value*" substring match.
function hasExplicitWildcard(value) {
  return /[*?]/.test(value);
}

function toWildcardPattern(value) {
  return hasExplicitWildcard(value) ? value : `*${escapeWildcardValue(value)}*`;
}

// Turns a chip (field:value) into an Elasticsearch query clause against the "documents" index.
function chipToEsClause(chip) {
  const def = FIELD_BY_KEY.get(chip.fieldKey);
  const value = (chip.value || '').trim();
  if (!def || !value) return null;

  if (def.kind === 'nested') {
    // Chips picked from a suggestion carry the canonical entity id shared across every
    // recorded spelling of that person/place (see buildSuggestRequestBody's "nested" branch).
    // Matching on that id, rather than the literal label text, also catches variants a
    // wildcard would miss entirely — e.g. OCR noise like "amsterd.m" sharing Amsterdam's id.
    // A manually-typed value (no resolvedId) falls back to the previous wildcard match.
    const filter = chip.resolvedId
      ? [{ term: { 'observances.type': def.type } }, { term: { 'observances.id': chip.resolvedId } }]
      : [{ term: { 'observances.type': def.type } }];
    const clause = { nested: { path: 'observances', query: { bool: { filter } } } };
    if (!chip.resolvedId) {
      clause.nested.query.bool.must = [
        { wildcard: { 'observances.label': { value: toWildcardPattern(value), case_insensitive: true } } },
      ];
    }
    return clause;
  }

  if (def.kind === 'personname') {
    // Chips picked from a suggestion carry every known spelling variant for that individual
    // (from the autocomplete completion index's "labels"); match any of them as an exact
    // phrase in the free text. A manually-typed, unresolved value just matches that one phrase.
    const variants = chip.variants && chip.variants.length ? chip.variants : [value];
    return {
      bool: {
        should: variants.map((variant) => ({ match_phrase: { text: variant } })),
        minimum_should_match: 1,
      },
    };
  }

  if (def.kind === 'text') {
    if (hasExplicitWildcard(value)) {
      return { wildcard: { [def.field]: { value, case_insensitive: true } } };
    }
    // Chips picked from a hierarchy suggestion carry the exact "|"-joined path level (a
    // category or a full leaf profession). A term query against the .tree sub-field — indexed
    // with the same path_hierarchy delimiter — matches that level and every more specific
    // descendant beneath it, e.g. selecting "Ambachtslieden" also matches
    // "...|Ambachtslieden|timmerman" and "...|Ambachtslieden|kuiper". A manually-typed value
    // (no hierarchical flag) falls back to the previous loose word match.
    if (chip.hierarchical) {
      return { term: { [`${def.field}.tree`]: value } };
    }
    return { match: { [def.field]: value } };
  }

  if (def.kind === 'keyword') {
    return def.exact && !hasExplicitWildcard(value)
      ? { term: { [def.field]: value } }
      : { wildcard: { [def.field]: { value: toWildcardPattern(value), case_insensitive: true } } };
  }

  if (def.kind === 'year') {
    return buildYearRangeClause(value);
  }

  return null;
}

function buildYearRangeClause(value) {
  const rangeMatch = value.match(/^(\d{3,4})\s*-\s*(\d{3,4})$/);
  const singleMatch = value.match(/^(\d{3,4})$/);
  let fromYear;
  let toYear;

  if (rangeMatch) {
    [, fromYear, toYear] = rangeMatch;
  } else if (singleMatch) {
    fromYear = toYear = singleMatch[1];
  } else {
    return null;
  }

  return {
    bool: {
      filter: [
        { range: { startDate: { lte: `${toYear}-12-31` } } },
        { range: { endDate: { gte: `${fromYear}-01-01` } } },
      ],
    },
  };
}

// Result caps for the different suggestion strategies used below.
const SUGGEST_AGG_FETCH_SIZE = 30; // nested/keyword fields: raw ES buckets fetched, before merging case variants.
const SUGGEST_AGG_RESULT_SIZE = 10; // nested/keyword fields: how many merged, distinct values to keep.
const SUGGEST_TEXT_SAMPLE_SIZE = 300; // text fields: how many raw docs to sample and de-dup client-side.
const SUGGEST_TEXT_RESULT_SIZE = 10; // text fields: how many distinct values to keep after de-duping the sample.

// Builds the Elasticsearch request body used to look up suggestions for a given field and
// typed prefix. There is no dedicated /suggest endpoint on this cluster — suggestions are
// queried directly, via one of four strategies depending on how the field is actually indexed:
//  - "nested" (person/place): a nested aggregation on observances.id — the canonical entity id
//    shared across every recorded spelling of that mention (confirmed live: "Amsterdam",
//    "amsterdam" and even OCR-mangled "amsterd.m" all share id "GLOB2_937") — filtered to the
//    right observances.type, with a small sub-aggregation to pick a representative label per
//    id for display. Gives exact, corpus-wide counts and one clean suggestion per real entity.
//  - "personname": named individuals aren't resolved this way in the documents index at all
//    (see below) — instead this queries the separate "autocomplete" index directly, which is a
//    completion suggester built specifically for person names and their spelling variants.
//  - "keyword" (settlement/inventory): a plain terms aggregation on the field itself. Exact
//    counts.
//  - "text" (profession/documenttype): only indexed as analyzed text, with no aggregatable
//    keyword sub-field and no fielddata enabled, so a real aggregation isn't possible here.
//    Instead we sample matching documents and de-duplicate the raw values client-side in
//    extractSuggestionsFromResponse — counts there are "seen in this sample", not exact
//    corpus-wide counts. (The clean fix would be enabling `fielddata: true` on
//    professionLabelPaths.tree / documentTypeLabelPaths.tree server-side, which would let us
//    aggregate on the hierarchy directly — worth raising with whoever maintains the index.)
function buildSuggestRequestBody(def, prefix) {
  if (def.kind === 'nested') {
    const filter = [
      { term: { 'observances.type': def.type } },
      { prefix: { 'observances.label': { value: prefix, case_insensitive: true } } },
    ];
    return {
      size: 0,
      query: { nested: { path: 'observances', query: { bool: { filter } } } },
      aggs: {
        obs: {
          nested: { path: 'observances' },
          aggs: {
            filtered: {
              filter: { bool: { filter } },
              aggs: {
                by_id: {
                  terms: { field: 'observances.id', size: SUGGEST_AGG_FETCH_SIZE, order: { _count: 'desc' } },
                  aggs: {
                    top_label: { terms: { field: 'observances.label', size: 1, order: { _count: 'desc' } } },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  // Named individuals like "Jogem Hendrik Sleuter" aren't stored as Person-type observances in
  // the documents index at all — those are generic mentions inferred from occupation words
  // (e.g. "bakker" implies "a person, a baker, is mentioned"), not resolved named people. The
  // "autocomplete" index is a separate, dedicated Person-name completion index instead.
  if (def.kind === 'personname') {
    return {
      suggest: {
        'value-suggest': {
          prefix,
          completion: { field: 'labels', size: SUGGEST_AGG_FETCH_SIZE, skip_duplicates: true },
        },
      },
      _source: ['type', 'preferredLabel', 'identifier', 'labels'],
    };
  }

  if (def.kind === 'keyword') {
    return {
      size: 0,
      query: { prefix: { [def.field]: { value: prefix, case_insensitive: true } } },
      aggs: {
        top_values: { terms: { field: def.field, size: SUGGEST_AGG_FETCH_SIZE, order: { _count: 'desc' } } },
      },
    };
  }

  if (def.kind === 'text') {
    return {
      size: SUGGEST_TEXT_SAMPLE_SIZE,
      _source: [def.field],
      query: { match_phrase_prefix: { [def.field]: prefix } },
    };
  }

  return null; // e.g. "year", which has no live value suggestions.
}

// Builds every cumulative "|"-joined prefix level of a hierarchical path, from the root down
// to the full leaf value, e.g. "A|B|C" -> ["A", "A|B", "A|B|C"]. Used so that typing a category
// name (e.g. "ambachtslieden") can surface that category itself as a selectable suggestion —
// not just the specific leaf professions matched by a more specific prefix like "tim".
function cumulativeHierarchyLevels(value) {
  const parts = value.split('|');
  const levels = [];
  for (let i = 0; i < parts.length; i += 1) {
    levels.push(parts.slice(0, i + 1).join('|'));
  }
  return levels;
}

// Checks whether `value` genuinely contains the word sequence in `prefixWords`, mirroring the
// same semantics as the match_phrase_prefix query above (all words but the last must appear
// as an exact, consecutive sequence; the last word only needs to be a prefix match). This
// matters because "text" fields here are multi-valued: a document can match the query via one
// array entry while also carrying sibling entries that don't themselves contain the typed
// prefix at all — this filters those incidental siblings back out.
function valueMatchesPhrasePrefix(value, prefixWords) {
  const words = value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let start = 0; start <= words.length - prefixWords.length; start += 1) {
    let matched = true;
    for (let i = 0; i < prefixWords.length - 1; i += 1) {
      if (words[start + i] !== prefixWords[i]) {
        matched = false;
        break;
      }
    }
    if (matched && words[start + prefixWords.length - 1]?.startsWith(prefixWords[prefixWords.length - 1])) {
      return true;
    }
  }
  return false;
}

// observances.label / settlement / inventoryNumber are keyword fields, so a terms aggregation
// buckets on the exact stored string — including capitalization. Historical/OCR'd data often
// has the same real value stored under multiple casings (e.g. "Amsterdam" and "amsterdam" as
// separate buckets), which would otherwise show up as duplicate-looking suggestions. Since the
// actual search-time clause (chipToEsClause) already matches case-insensitively, it's safe to
// merge same-value-different-casing buckets here: sum their counts, and keep whichever exact
// casing occurred most often as the display value.
function mergeCaseInsensitiveDuplicates(items) {
  const merged = new Map(); // lowercase value -> { bestValue, bestCount, totalCount }
  items.forEach(({ value, count }) => {
    const key = value.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { bestValue: value, bestCount: count, totalCount: count });
      return;
    }
    existing.totalCount += count;
    if (count > existing.bestCount) {
      existing.bestValue = value;
      existing.bestCount = count;
    }
  });
  return Array.from(merged.values())
    .map(({ bestValue, totalCount }) => ({ value: bestValue, count: totalCount }))
    .sort((a, b) => b.count - a.count);
}

// Turns a suggestion response into a plain [{ value, count, resolvedId?, variants? }] list,
// using whichever strategy matches how the request was built in buildSuggestRequestBody above.
function extractSuggestionsFromResponse(def, prefix, data) {
  if (def.kind === 'nested') {
    const buckets = data?.aggregations?.obs?.filtered?.by_id?.buckets || [];
    return buckets
      .map((bucket) => {
        const topLabelBucket = bucket.top_label?.buckets?.[0];
        return {
          value: topLabelBucket ? topLabelBucket.key : bucket.key,
          count: bucket.doc_count,
          resolvedId: bucket.key,
        };
      })
      .slice(0, SUGGEST_AGG_RESULT_SIZE);
  }

  if (def.kind === 'personname') {
    const options = data?.suggest?.['value-suggest']?.[0]?.options || [];
    return options
      .map((option) => ({
        value: option._source?.preferredLabel || option.text,
        count: null, // the completion suggester ranks by relevance, not corpus frequency.
        resolvedId: option._source?.identifier,
        variants: option._source?.labels && option._source.labels.length ? option._source.labels : [option.text],
      }))
      .slice(0, SUGGEST_AGG_RESULT_SIZE);
  }

  if (def.kind === 'keyword') {
    const buckets = data?.aggregations?.top_values?.buckets || [];
    const items = buckets.map((bucket) => ({ value: bucket.key, count: bucket.doc_count }));
    return mergeCaseInsensitiveDuplicates(items).slice(0, SUGGEST_AGG_RESULT_SIZE);
  }

  if (def.kind === 'text') {
    const prefixWords = prefix.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!prefixWords.length) return [];
    const counts = new Map();
    (data?.hits?.hits || []).forEach((hit) => {
      const raw = hit._source?.[def.field];
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      values.forEach((value) => {
        // Check every level of the hierarchy independently, not just the full leaf value —
        // this lets a category name (e.g. "ambachtslieden") surface as its own suggestion,
        // separate from the more specific leaf professions beneath it (e.g. "timmerman").
        cumulativeHierarchyLevels(value).forEach((level) => {
          if (valueMatchesPhrasePrefix(level, prefixWords)) {
            counts.set(level, (counts.get(level) || 0) + 1);
          }
        });
      });
    });
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, SUGGEST_TEXT_RESULT_SIZE);
  }

  return [];
}

// Fetches and normalizes suggestions for one field. Resolves to [] on any failure (including
// non-OK responses) so callers querying several fields in parallel can proceed with whatever
// else succeeded, rather than one field's error taking down the whole suggestion list.
async function fetchSuggestionsForField(def, prefix, signal) {
  const body = buildSuggestRequestBody(def, prefix);
  if (!body) return [];
  const url = def.kind === 'personname' ? AUTOCOMPLETE_URL : API_URL;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) return [];
  const data = await response.json();
  return extractSuggestionsFromResponse(def, prefix, data);
}

// For hierarchical "text" fields (profession/documenttype), display the pipe-delimited path
// as a readable breadcrumb, e.g. "Ambachtslieden|timmerman" -> "Ambachtslieden › timmerman".
// The underlying value used when the suggestion is applied stays the original raw string.
function formatSuggestionValue(def, value) {
  return def.kind === 'text' ? value.split('|').join(' › ') : value;
}

// Determines what extra metadata (beyond fieldKey/value) a chip should carry when a
// suggestion item is applied, so chipToEsClause can build the richer, resolved query clause.
// Only matters when the suggestion becomes a standalone chip (see commitToken) — a value
// inserted inline into a larger typed expression is just plain text and can't carry this.
function buildChipExtra(def, item) {
  const extra = {};
  if ((def.kind === 'nested' || def.kind === 'personname') && item.resolvedId) {
    extra.resolvedId = item.resolvedId;
  }
  if (def.kind === 'personname' && item.variants && item.variants.length) {
    extra.variants = item.variants;
  }
  if (def.kind === 'text') {
    extra.hierarchical = true;
  }
  return extra;
}

async function buildEsQuery(keywordText, chips) {
  const expressionClause = await parseKeywordExpression(keywordText);
  const filter = chips.map(chipToEsClause).filter(Boolean);

  return {
    bool: {
      ...(expressionClause ? { must: [expressionClause] } : {}),
      ...(filter.length ? { filter } : {}),
    },
  };
}

// --- Boolean query expression parser -----------------------------------------------------
// Lets the keyword box accept things like `(place:Amsterdam OR place:Deventer) AND profession:timmerman`,
// mixing structured field filters with free text, AND/OR/NOT, and parentheses for grouping.
// It also accepts proximity groups like `(amsterdam timmerman)~5`: a parenthesised group
// immediately followed by `~N` becomes a single PROXGROUP token instead of LPAREN/.../RPAREN.
// Words inside a proximity group may end in `~` or `~N` to request a fuzzy match, e.g. `(amsterdam~ timmerman)~5`.

// Finds the index of the ")" balancing the "(" at startIndex, skipping quoted content, or -1.
function findMatchingParen(input, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      i = end === -1 ? input.length : end;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Splits the inside of a "(...)~N" proximity group into { kind: 'field' } or { kind: 'word' } items.
function tokenizeProximityItems(input) {
  const items = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }

    const fieldMatch = /^([A-Za-z]+)\s*:\s*/.exec(input.slice(i));
    const fieldKey = fieldMatch ? FIELD_ALIASES.get(fieldMatch[1].toLowerCase()) : null;
    if (fieldMatch && fieldKey) {
      let j = i + fieldMatch[0].length;
      let value;
      if (input[j] === '"') {
        const end = input.indexOf('"', j + 1);
        value = end === -1 ? input.slice(j + 1) : input.slice(j + 1, end);
        j = end === -1 ? n : end + 1;
      } else {
        const valueMatch = /^[^\s()]*/.exec(input.slice(j));
        value = valueMatch ? valueMatch[0] : '';
        j += value.length;
      }
      items.push({ kind: 'field', fieldKey, value });
      i = j;
      continue;
    }

    const wordMatch = /^[^\s()]+/.exec(input.slice(i));
    if (!wordMatch) {
      i += 1;
      continue;
    }
    const raw = wordMatch[0];
    i += raw.length;
    const fuzzyMatch = /^(.+?)~(\d*)$/.exec(raw);
    items.push(
      fuzzyMatch ? { kind: 'word', text: fuzzyMatch[1], fuzzy: fuzzyMatch[2] || 'AUTO' } : { kind: 'word', text: raw, fuzzy: null }
    );
  }

  return items;
}

// Splits a raw expression string into LPAREN/RPAREN/AND/OR/NOT/FIELDVALUE/WORD/PROXGROUP tokens.
function tokenizeQueryExpression(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      const closeIndex = findMatchingParen(input, i);
      if (closeIndex !== -1) {
        const slopMatch = /^~(\d+)/.exec(input.slice(closeIndex + 1));
        if (slopMatch) {
          const items = tokenizeProximityItems(input.slice(i + 1, closeIndex));
          tokens.push({ type: 'PROXGROUP', slop: Number(slopMatch[1]), items });
          i = closeIndex + 1 + slopMatch[0].length;
          continue;
        }
      }
      tokens.push({ type: 'LPAREN' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN' });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      const raw = end === -1 ? input.slice(i) : input.slice(i, end + 1);
      tokens.push({ type: 'WORD', text: raw });
      i = end === -1 ? n : end + 1;
      continue;
    }

    const fieldMatch = /^([A-Za-z]+)\s*:\s*/.exec(input.slice(i));
    const fieldKey = fieldMatch ? FIELD_ALIASES.get(fieldMatch[1].toLowerCase()) : null;
    if (fieldMatch && fieldKey) {
      let j = i + fieldMatch[0].length;
      let fieldValue;
      if (input[j] === '"') {
        const end = input.indexOf('"', j + 1);
        fieldValue = end === -1 ? input.slice(j + 1) : input.slice(j + 1, end);
        j = end === -1 ? n : end + 1;
      } else {
        const valueMatch = /^[^\s()]*/.exec(input.slice(j));
        fieldValue = valueMatch ? valueMatch[0] : '';
        j += fieldValue.length;
      }
      tokens.push({ type: 'FIELDVALUE', fieldKey, value: fieldValue });
      i = j;
      continue;
    }

    const keywordMatch = /^(AND|OR|NOT)(?![A-Za-z0-9_])/i.exec(input.slice(i));
    if (keywordMatch) {
      tokens.push({ type: keywordMatch[1].toUpperCase() });
      i += keywordMatch[0].length;
      continue;
    }

    const wordMatch = /^[^\s()]+/.exec(input.slice(i));
    tokens.push({ type: 'WORD', text: wordMatch[0] });
    i += wordMatch[0].length;
  }

  return tokens;
}

// Builds a span clause for a single (already-lowercased) literal string: a span_term for one
// word, or an in-order, zero-slop span_near of each word for a multi-word phrase.
function phraseToSpanClause(phrase) {
  const words = (phrase || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length === 1) return { span_term: { text: words[0] } };
  return { span_near: { clauses: words.map((word) => ({ span_term: { text: word } })), slop: 0, in_order: true } };
}

// Combines several literal spelling variants of the same real-world entity/concept (see
// resolveObservanceVariants) into a single span clause matching ANY of them at that position.
function variantsToSpanClause(variants) {
  const clauses = variants.map(phraseToSpanClause).filter(Boolean);
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : { span_or: { clauses } };
}

// Which observances.type a field's values can be resolved against for proximity purposes —
// i.e. where the literal, position-addressable spelling variants for that field's concept
// actually live. "place" and "person" resolve against their own observance type directly.
// "profession" hooks into the *generic* occupation-inferred Person observances instead of
// professionLabelPaths (confirmed live: "timmerman" shares one id with "timmerlieden",
// "Carpenter", "Zimmerman", OCR noise, and more) — the same annotation stream that backs the
// plain person: field, just reached via a different typed value. Fields with no entry here
// (documenttype, personname, settlement, inventory, year) have no such linkage available and
// fall back to matching the literal typed value/phrase.
const PROXIMITY_OBSERVANCE_TYPE = { person: 'Person', place: 'Place', profession: 'Person' };

// For a field:value item inside a proximity group, looks up every literal spelling recorded
// under the same shared observances.id as the typed value — two small aggregation queries:
// first find the id for the typed label, then fetch every label recorded under that id. Falls
// back to [value] if no id-linked variants are found (e.g. a typo with no exact match).
async function resolveObservanceVariants(observanceType, value, signal) {
  const trimmedValue = (value || '').trim();
  if (!trimmedValue) return [];

  const idFilter = [
    { term: { 'observances.type': observanceType } },
    { term: { 'observances.label': { value: trimmedValue, case_insensitive: true } } },
  ];
  const idBody = {
    size: 0,
    query: { nested: { path: 'observances', query: { bool: { filter: idFilter } } } },
    aggs: {
      obs: {
        nested: { path: 'observances' },
        aggs: {
          filtered: {
            filter: { bool: { filter: idFilter } },
            aggs: { by_id: { terms: { field: 'observances.id', size: 1, order: { _count: 'desc' } } } },
          },
        },
      },
    },
  };

  try {
    const idData = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(idBody),
      signal,
    }).then((response) => (response.ok ? response.json() : null));
    const resolvedId = idData?.aggregations?.obs?.filtered?.by_id?.buckets?.[0]?.key;
    if (!resolvedId) return [trimmedValue];

    const variantFilter = [
      { term: { 'observances.type': observanceType } },
      { term: { 'observances.id': resolvedId } },
    ];
    const variantsBody = {
      size: 0,
      query: { nested: { path: 'observances', query: { bool: { filter: variantFilter } } } },
      aggs: {
        obs: {
          nested: { path: 'observances' },
          aggs: {
            filtered: {
              filter: { bool: { filter: variantFilter } },
              aggs: { by_label: { terms: { field: 'observances.label', size: 50 } } },
            },
          },
        },
      },
    };
    const variantsData = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(variantsBody),
      signal,
    }).then((response) => (response.ok ? response.json() : null));
    const buckets = variantsData?.aggregations?.obs?.filtered?.by_label?.buckets || [];
    const variants = [...new Set(buckets.map((bucket) => bucket.key.toLowerCase()))];
    return variants.length ? variants : [trimmedValue];
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return [trimmedValue];
  }
}

// Builds the span clause for a single item inside a proximity group. Plain words become a
// span_term (or a fuzzy span_multi). A field:value item resolves to every known spelling
// variant when PROXIMITY_OBSERVANCE_TYPE has an entry for that field (see above); otherwise it
// falls back to matching the literal typed value/phrase, the same trade-off as before — span
// queries only work within one flat, position-indexed field, so even a resolved variant list
// is matched as literal text in `text`, not via the nested `observances` structure directly.
async function proximityItemToSpanClause(item, signal) {
  if (item.kind === 'word') {
    const value = item.text.toLowerCase();
    return item.fuzzy
      ? { span_multi: { match: { fuzzy: { text: { value, fuzziness: item.fuzzy } } } } }
      : { span_term: { text: value } };
  }
  const observanceType = PROXIMITY_OBSERVANCE_TYPE[item.fieldKey];
  if (!observanceType) return phraseToSpanClause(item.value);
  const variants = await resolveObservanceVariants(observanceType, item.value, signal);
  return variantsToSpanClause(variants);
}

// Builds the ES clause for a PROXGROUP token as a single native span_near query, whether the
// group is plain words, a mix of words and field:value items, or multiple field:value items.
// Item resolutions run in parallel via Promise.all, so a group's total extra latency is
// bounded by its single slowest resolution, not the number of items needing one.
async function buildProximityClause(group, signal) {
  const items = group.items.filter((item) => (item.kind === 'word' ? item.text : item.value));
  if (items.length < 2) return null;
  const clauses = (await Promise.all(items.map((item) => proximityItemToSpanClause(item, signal)))).filter(Boolean);
  if (clauses.length < 2) return null;
  return { span_near: { clauses, slop: group.slop, in_order: false } };
}

// Recursive-descent parser: orExpr := andExpr (OR andExpr)*, andExpr := notExpr (AND? notExpr)*.
// Async throughout because a PROXGROUP branch may need to resolve field values against the
// server (see buildProximityClause) before its clause can be built.
async function parseQueryTokens(tokens, signal) {
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseWordRun() {
    const words = [];
    while (peek()?.type === 'WORD') words.push(consume().text);
    const text = words.join(' ');
    return text ? { query_string: { query: text, default_field: 'text', default_operator: 'AND' } } : null;
  }

  async function parsePrimary() {
    const token = peek();
    if (!token) return null;
    if (token.type === 'LPAREN') {
      consume();
      const inner = await parseOr();
      if (peek()?.type === 'RPAREN') consume();
      return inner;
    }
    if (token.type === 'PROXGROUP') {
      consume();
      return buildProximityClause(token, signal);
    }
    if (token.type === 'FIELDVALUE') {
      consume();
      return chipToEsClause({ fieldKey: token.fieldKey, value: token.value });
    }
    if (token.type === 'WORD') {
      return parseWordRun();
    }
    // Stray token (e.g. an unmatched ")"): skip it so parsing can continue.
    consume();
    return null;
  }

  async function parseNot() {
    if (peek()?.type === 'NOT') {
      consume();
      const clause = await parsePrimary();
      return clause ? { bool: { must_not: [clause] } } : null;
    }
    return parsePrimary();
  }

  async function parseAnd() {
    const clauses = [await parseNot()].filter(Boolean);
    while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
      if (peek().type === 'AND') consume();
      const clause = await parseNot();
      if (clause) clauses.push(clause);
    }
    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : { bool: { must: clauses } };
  }

  async function parseOr() {
    const clauses = [await parseAnd()].filter(Boolean);
    while (peek()?.type === 'OR') {
      consume();
      const clause = await parseAnd();
      if (clause) clauses.push(clause);
    }
    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } };
  }

  return parseOr();
}

// Parses the whole keyword box into an ES query clause, supporting `field:value`, AND/OR/NOT,
// parentheses and `(...)~N` proximity groups (all built as native span_near queries). Async
// because a proximity group mixing in a field:value may need to resolve it against the server
// first (see resolveObservanceVariants) — `signal` lets that be aborted if the search changes.
async function parseKeywordExpression(keywordText, signal) {
  const trimmed = (keywordText || '').trim();
  if (!trimmed) return null;
  try {
    const tokens = tokenizeQueryExpression(trimmed);
    return tokens.length ? await parseQueryTokens(tokens, signal) : null;
  } catch (error) {
    console.error('Failed to parse query expression, falling back to plain text search', error);
    return { query_string: { query: trimmed, default_field: 'text', default_operator: 'AND' } };
  }
}

function describeChips(chips) {
  if (!chips.length) return '';
  const parts = chips.map((chip) => `${FIELD_BY_KEY.get(chip.fieldKey).label}: “${escapeHtml(chip.value)}”`);
  return ` with ${parts.join(', ')}`;
}

// Interactive "field:value" chip input: lets keyword search be combined with
// structured filters such as person:, place:, profession:, settlement:, inventory: and year:.
function createQueryBuilder({ formEl, chipsEl, inputEl, suggestionsEl, previewEl }) {
  let chips = [];
  let currentSuggestions = [];
  let selectedIndex = -1;
  let suggestRequestId = 0;
  let suggestDebounceTimer = null;
  let suggestAbortController = null;

  // Renders a read-only preview of how the raw text is understood: structured field:value
  // terms become chips, boolean keywords/parentheses become connectors, the rest stays as
  // plain free text. Only shown once the input contains actual boolean/structured syntax.
  function renderExpressionPreview() {
    if (!previewEl) return;
    let tokens = [];
    try {
      tokens = tokenizeQueryExpression(inputEl.value);
    } catch (error) {
      tokens = [];
    }

    const hasStructure = tokens.some((token) => token.type !== 'WORD');
    if (!hasStructure) {
      previewEl.hidden = true;
      previewEl.innerHTML = '';
      return;
    }

    previewEl.hidden = false;
    previewEl.innerHTML = tokens
      .map((token) => {
        if (token.type === 'FIELDVALUE') {
          const def = FIELD_BY_KEY.get(token.fieldKey);
          if (!def || !token.value) return '';
          return `
            <span class="query-chip is-inline" data-field="${token.fieldKey}">
              <span class="field-name">${escapeHtml(def.label)}:</span>
              <span>${escapeHtml(token.value)}</span>
            </span>
          `;
        }
        if (token.type === 'PROXGROUP') {
          const itemsHtml = token.items
            .map((item, index) => {
              const separator = index === 0 ? '' : '<span class="query-connector">near</span>';
              if (item.kind === 'field') {
                const def = FIELD_BY_KEY.get(item.fieldKey);
                if (!def || !item.value) return separator;
                return `${separator}<span class="query-chip is-inline" data-field="${item.fieldKey}">
                  <span class="field-name">${escapeHtml(def.label)}:</span>
                  <span>${escapeHtml(item.value)}</span>
                </span>`;
              }
              const fuzzySuffix = item.fuzzy ? `<span class="fuzzy-marker">~${item.fuzzy === 'AUTO' ? '' : item.fuzzy}</span>` : '';
              return `${separator}<span class="query-freetext">${escapeHtml(item.text)}${fuzzySuffix}</span>`;
            })
            .join('');
          return `
            <span class="query-proxgroup">
              <span class="query-connector is-paren">(</span>${itemsHtml}<span class="query-connector is-paren">)</span><span class="proximity-slop">~${token.slop}</span>
            </span>
          `;
        }
        if (token.type === 'AND' || token.type === 'OR' || token.type === 'NOT') {
          return `<span class="query-connector">${token.type}</span>`;
        }
        if (token.type === 'LPAREN') return '<span class="query-connector is-paren">(</span>';
        if (token.type === 'RPAREN') return '<span class="query-connector is-paren">)</span>';
        if (token.type === 'WORD') return `<span class="query-freetext">${escapeHtml(token.text)}</span>`;
        return '';
      })
      .join('');
  }

  function renderChips() {
    chipsEl.innerHTML = chips
      .map((chip, index) => {
        const isResolved = Boolean(chip.resolvedId || (chip.variants && chip.variants.length) || chip.hierarchical);
        return `
          <span class="query-chip" data-index="${index}" data-field="${chip.fieldKey}"${isResolved ? ' data-resolved="true"' : ''}>
            <span class="field-name">${escapeHtml(FIELD_BY_KEY.get(chip.fieldKey).label)}:</span>
            <span>${escapeHtml(chip.value)}</span>
            <button type="button" aria-label="Remove ${escapeHtml(FIELD_BY_KEY.get(chip.fieldKey).label)} filter">×</button>
          </span>
        `;
      })
      .join('');

    chipsEl.querySelectorAll('button[aria-label]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.closest('.query-chip').dataset.index);
        chips.splice(index, 1);
        renderChips();
        formEl.dispatchEvent(new CustomEvent('querybuilder:change'));
      });
    });
  }

  // Animates a suggestion chip preview flying from the dropdown into its final spot among the committed chips.
  function animateChipFlight(sourceEl, chipIndex) {
    const newChipEl = chipsEl.querySelector(`.query-chip[data-index="${chipIndex}"]`);
    if (!sourceEl || !newChipEl) return;

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = newChipEl.getBoundingClientRect();

    const clone = sourceEl.cloneNode(true);
    clone.classList.add('query-chip-flying');
    clone.style.left = `${sourceRect.left}px`;
    clone.style.top = `${sourceRect.top}px`;
    clone.style.width = `${sourceRect.width}px`;
    clone.style.height = `${sourceRect.height}px`;
    clone.style.margin = '0';
    clone.style.transformOrigin = 'top left';
    document.body.appendChild(clone);

    newChipEl.style.visibility = 'hidden';

    const dx = targetRect.left - sourceRect.left;
    const dy = targetRect.top - sourceRect.top;
    const scaleX = targetRect.width / sourceRect.width;
    const scaleY = targetRect.height / sourceRect.height;

    const finish = () => {
      clone.remove();
      newChipEl.style.visibility = '';
    };

    requestAnimationFrame(() => {
      clone.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s ease';
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
    });
    clone.addEventListener('transitionend', finish, { once: true });
    window.setTimeout(finish, 500);
  }

  function getTrailingToken() {
    const value = inputEl.value;
    // Unquoted values may contain single spaces (so multi-word names like "Jogem Hendrik" can
    // be typed and suggested without needing quotes) but stop at a double space, which signals
    // "done with this value, starting something new" — mirrors how getTrailingWord() picks up
    // whatever comes after. A quoted value ("...") can still contain anything, spaces included.
    const match = value.match(/(^|[\s(])([a-zA-Z]+)\s*:\s*("([^"]*)"|((?:[^\s()]|\s(?!\s))*))$/);
    if (!match) return null;
    const fieldKey = FIELD_ALIASES.get(match[2].toLowerCase());
    if (!fieldKey) return null;
    const tokenValue = match[4] !== undefined ? match[4] : match[5] || '';
    const start = match.index + match[1].length;
    const valueStart = value.length - (match[3] ? match[3].length : match[5].length);
    return { fieldKey, value: tokenValue, start, end: value.length, valueStart };
  }

  function getTrailingWord() {
    const value = inputEl.value;
    const match = value.match(/(^|[\s(])([a-zA-Z]+)$/);
    if (!match) return null;
    return { word: match[2], start: match.index + match[1].length, end: value.length };
  }

  // True when the trailing "field:value" token is the entire (trimmed) input, i.e. not
  // part of a larger boolean expression — this is what makes it eligible to become a chip.
  function isSoleToken(token) {
    const before = inputEl.value.slice(0, token.start);
    const after = inputEl.value.slice(token.end);
    return before.trim() === '' && after.trim() === '';
  }

  function commitToken(token, sourceEl, extra) {
    if (!token.value) return false;
    chips.push({ fieldKey: token.fieldKey, value: token.value, ...extra });
    inputEl.value = `${inputEl.value.slice(0, token.start)}${inputEl.value.slice(token.end)}`.replace(/\s+$/, '');
    renderChips();
    renderExpressionPreview();
    if (sourceEl) animateChipFlight(sourceEl, chips.length - 1);
    hideSuggestions();
    return true;
  }

  // Replaces just the value portion of a trailing "field:value" token in place, without
  // turning it into a chip — used when the token is part of a larger typed expression.
  function insertTokenValue(token, value) {
    const formatted = /\s/.test(value) ? `"${value}"` : value;
    inputEl.value = `${inputEl.value.slice(0, token.valueStart)}${formatted}${inputEl.value.slice(token.end)}`;
    const cursor = token.valueStart + formatted.length;
    inputEl.focus();
    inputEl.setSelectionRange(cursor, cursor);
    renderExpressionPreview();
    hideSuggestions();
    return true;
  }

  // Applies a chosen value to the trailing token: as a chip (carrying any extra resolved
  // metadata) when it's the sole input content, or as an in-place text replacement when it's
  // part of a bigger expression — inline text can't carry that extra metadata, so it falls
  // back to whatever plain-value matching chipToEsClause does for an unresolved value.
  function applyTokenValue(token, sourceEl, value, extra) {
    const finalToken = value === undefined ? token : { ...token, value };
    if (!finalToken.value) return false;
    return isSoleToken(token) ? commitToken(finalToken, sourceEl, extra) : insertTokenValue(token, finalToken.value);
  }


  function cancelPendingSuggestFetch() {
    window.clearTimeout(suggestDebounceTimer);
    if (suggestAbortController) suggestAbortController.abort();
    suggestRequestId += 1;
  }

  function hideSuggestions() {
    cancelPendingSuggestFetch();
    currentSuggestions = [];
    selectedIndex = -1;
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = '';
  }

  // Applies a cross-field value suggestion (e.g. picking "amsterdam" for "place" while the
  // input just has the bare word "am") — commits it as a chip (carrying any extra resolved
  // metadata) when it's the sole input content, or inserts a "field:value" segment in place
  // otherwise (inline text, so no extra metadata carries through).
  function applyWordSuggestion(word, fieldKey, value, sourceEl, extra) {
    if (!value) return false;
    const token = { fieldKey, value, start: word.start, end: word.end };
    if (isSoleToken(token)) return commitToken(token, sourceEl, extra);
    const formatted = /\s/.test(value) ? `"${value}"` : value;
    inputEl.value = `${inputEl.value.slice(0, word.start)}${fieldKey}:${formatted}${inputEl.value.slice(word.end)}`;
    const cursor = word.start + fieldKey.length + 1 + formatted.length;
    inputEl.focus();
    inputEl.setSelectionRange(cursor, cursor);
    renderExpressionPreview();
    hideSuggestions();
    return true;
  }

  // Debounced lookup of matching indexed values across every structured field at once (e.g.
  // "am" -> "place:amsterdam", "person:amrabat"), queried directly against the documents
  // index (see fetchSuggestionsForField). Only kicks in once the bare word is at least
  // SUGGEST_MIN_CHARS long.
  function fetchCrossFieldSuggestions(word) {
    const prefix = word.word.trim();
    if (prefix.length < SUGGEST_MIN_CHARS || hasExplicitWildcard(prefix)) return;

    const requestId = suggestRequestId;
    suggestDebounceTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      suggestAbortController = controller;
      try {
        const results = await Promise.all(
          CROSS_SUGGEST_FIELDS.map((def) =>
            fetchSuggestionsForField(def, prefix, controller.signal)
              .then((suggestions) => ({ def, suggestions }))
              .catch((error) => {
                if (error.name === 'AbortError') throw error;
                return { def, suggestions: [] };
              })
          )
        );
        if (requestId !== suggestRequestId) return;

        const valueItems = results
          .flatMap(({ def, suggestions }) =>
            suggestions
              .filter((item) => item.value.toLowerCase() !== prefix.toLowerCase())
              .map((item) => ({ def, item }))
          )
          .sort((a, b) => (b.item.count ?? 0) - (a.item.count ?? 0))
          .slice(0, CROSS_SUGGEST_MAX_RESULTS)
          .map(({ def, item }) => ({
            apply: (sourceEl) => applyWordSuggestion(word, def.key, item.value, sourceEl, buildChipExtra(def, item)),
            html: `
              <span class="query-chip query-chip-preview" data-field="${def.key}">
                <span class="field-name">${escapeHtml(def.label)}:</span>
                <span>${escapeHtml(formatSuggestionValue(def, item.value))}</span>
              </span>
              <span class="hint">${item.count == null ? 'Suggested' : `${item.count} result${item.count === 1 ? '' : 's'}`}</span>
            `,
          }));

        currentSuggestions = [...currentSuggestions, ...valueItems];
        renderSuggestions();
      } catch (error) {
        if (error.name !== 'AbortError') console.error(error);
      }
    }, SUGGEST_DEBOUNCE_MS);
  }

  // Shows suggestions for a bare trailing word with no "field:" prefix yet: matching field
  // names (e.g. "pl" -> "place:") plus, once it's at least SUGGEST_MIN_CHARS long, matching
  // indexed values across every structured field (e.g. "am" -> "place:amsterdam").
  function showWordSuggestions(word) {
    cancelPendingSuggestFetch();
    selectedIndex = -1;
    const lowerWord = word.word.toLowerCase();
    const fieldMatches = FIELD_DEFS.filter((def) => def.key.startsWith(lowerWord));

    currentSuggestions = fieldMatches.map((def) => ({
      apply: () => {
        const cursor = word.start + def.key.length + 1;
        inputEl.value = `${inputEl.value.slice(0, word.start)}${def.key}:${inputEl.value.slice(word.start + word.word.length)}`;
        inputEl.focus();
        inputEl.setSelectionRange(cursor, cursor);
        updateSuggestions();
      },
      html: `
        <span class="query-chip query-chip-preview" data-field="${def.key}"><span class="field-name">${escapeHtml(def.key)}:</span></span>
        <span class="hint">${escapeHtml(def.hint)}</span>
      `,
    }));

    if (currentSuggestions.length) {
      renderSuggestions();
    } else {
      suggestionsEl.hidden = true;
      suggestionsEl.innerHTML = '';
    }

    fetchCrossFieldSuggestions(word);
  }

  function buildTypedValueSuggestion(token, def) {
    if (!token.value) {
      return {
        apply: null,
        html: `
          <span class="query-chip query-chip-preview" data-field="${token.fieldKey}"><span class="field-name">${escapeHtml(def.label)}:</span></span>
          <span class="hint">${escapeHtml(def.hint)}</span>
        `,
      };
    }
    return {
      apply: (sourceEl) => applyTokenValue(token, sourceEl),
      html: `
        <span class="query-chip query-chip-preview" data-field="${token.fieldKey}">
          <span class="field-name">${escapeHtml(def.label)}:</span>
          <span>${escapeHtml(token.value)}</span>
        </span>
        <span class="hint">${hasExplicitWildcard(token.value) ? 'Wildcard search ↵' : 'Enter ↵'}</span>
      `,
    };
  }

  function showValueSuggestion(token) {
    const def = FIELD_BY_KEY.get(token.fieldKey);
    cancelPendingSuggestFetch();
    selectedIndex = -1;
    currentSuggestions = [buildTypedValueSuggestion(token, def)];
    renderSuggestions();
    fetchValueSuggestions(token, def);
  }

  // Debounced lookup of matching indexed values (e.g. "place:Am" -> "Amsterdam"), queried
  // directly against the documents index (see fetchSuggestionsForField).
  function fetchValueSuggestions(token, def) {
    const prefix = token.value.trim();
    if (def.kind === 'year' || prefix.length < SUGGEST_MIN_CHARS || hasExplicitWildcard(prefix)) return;

    const requestId = suggestRequestId;
    suggestDebounceTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      suggestAbortController = controller;
      try {
        const suggestions = await fetchSuggestionsForField(def, prefix, controller.signal);
        if (requestId !== suggestRequestId) return;

        const valueItems = suggestions
          .filter((item) => item.value.toLowerCase() !== prefix.toLowerCase())
          .map((item) => ({
            apply: (sourceEl) => applyTokenValue(token, sourceEl, item.value, buildChipExtra(def, item)),
            html: `
              <span class="query-chip query-chip-preview" data-field="${token.fieldKey}">
                <span class="field-name">${escapeHtml(def.label)}:</span>
                <span>${escapeHtml(formatSuggestionValue(def, item.value))}</span>
              </span>
              <span class="hint">${item.count == null ? 'Suggested' : `${item.count} result${item.count === 1 ? '' : 's'}`}</span>
            `,
          }));

        currentSuggestions = [currentSuggestions[0], ...valueItems];
        renderSuggestions();
      } catch (error) {
        if (error.name !== 'AbortError') console.error(error);
      }
    }, SUGGEST_DEBOUNCE_MS);
  }

  function selectableIndexes() {
    return currentSuggestions.map((item, index) => (item.apply ? index : -1)).filter((index) => index !== -1);
  }

  function updateSelectedHighlight() {
    suggestionsEl.querySelectorAll('.query-suggestion').forEach((el) => {
      const isSelected = Number(el.dataset.index) === selectedIndex;
      el.classList.toggle('is-selected', isSelected);
      if (isSelected) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function moveSelection(step) {
    const selectable = selectableIndexes();
    if (!selectable.length) return;
    const currentPos = selectable.indexOf(selectedIndex);
    const nextPos = currentPos === -1 ? (step > 0 ? 0 : selectable.length - 1) : (currentPos + step + selectable.length) % selectable.length;
    selectedIndex = selectable[nextPos];
    updateSelectedHighlight();
  }

  function renderSuggestions() {
    if (!currentSuggestions.length) {
      hideSuggestions();
      return;
    }
    suggestionsEl.hidden = false;
    suggestionsEl.innerHTML = currentSuggestions
      .map(
        (item, index) =>
          `<div class="query-suggestion${item.apply ? '' : ' is-static'}${index === selectedIndex ? ' is-selected' : ''}" data-index="${index}">${item.html}</div>`
      )
      .join('');

    suggestionsEl.querySelectorAll('.query-suggestion').forEach((el) => {
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const index = Number(el.dataset.index);
        const previewEl = el.querySelector('.query-chip-preview');
        currentSuggestions[index]?.apply?.(previewEl);
      });
      el.addEventListener('mousemove', () => {
        const index = Number(el.dataset.index);
        if (currentSuggestions[index]?.apply && index !== selectedIndex) {
          selectedIndex = index;
          updateSelectedHighlight();
        }
      });
    });
  }

  function updateSuggestions() {
    renderExpressionPreview();
    const token = getTrailingToken();
    if (token) {
      showValueSuggestion(token);
      return;
    }
    const word = getTrailingWord();
    if (word && word.word) {
      showWordSuggestions(word);
      return;
    }
    hideSuggestions();
  }

  inputEl.addEventListener('input', updateSuggestions);
  inputEl.addEventListener('blur', () => {
    window.setTimeout(hideSuggestions, 120);
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSuggestions();
      return;
    }
    if (event.key === 'ArrowDown' && currentSuggestions.length) {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp' && currentSuggestions.length) {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Tab' && currentSuggestions.length === 1 && currentSuggestions[0].apply && getTrailingWord()) {
      event.preventDefault();
      currentSuggestions[0].apply();
      return;
    }
    if (event.key === 'Backspace' && inputEl.value === '' && chips.length) {
      event.preventDefault();
      chips.pop();
      renderChips();
      hideSuggestions();
      formEl.dispatchEvent(new CustomEvent('querybuilder:change'));
      return;
    }
    if (event.key === 'Enter') {
      if (selectedIndex !== -1 && currentSuggestions[selectedIndex]?.apply) {
        event.preventDefault();
        const el = suggestionsEl.querySelector(`.query-suggestion[data-index="${selectedIndex}"] .query-chip-preview`);
        currentSuggestions[selectedIndex].apply(el);
        return;
      }
      const token = getTrailingToken();
      // Only intercept Enter to auto-chip a "field:value" token when it's the sole input;
      // inside a larger boolean expression, Enter should submit the form as usual so the
      // whole expression (parentheses, AND/OR/NOT) is parsed and searched.
      if (token && token.value && isSoleToken(token)) {
        event.preventDefault();
        const previewEl = suggestionsEl.querySelector('.query-chip-preview');
        commitToken(token, previewEl);
        return;
      }
      hideSuggestions();
    }
  });

  return {
    getChips: () => chips.slice(),
    setChips: (next) => {
      chips = next.slice();
      renderChips();
    },
    getKeywordText: () => inputEl.value.trim(),
    setKeywordText: (value) => {
      inputEl.value = value;
      renderExpressionPreview();
    },
  };
}

function getYearValue(result) {
  const dateValue = result?.startDate;
  if (!dateValue) return null;
  const parsed = Number(String(dateValue).slice(0, 4));
  return Number.isNaN(parsed) ? null : parsed;
}

function getInventoryNumber(result) {
  return result?.inventoryNumber || null;
}

// Documents can span a range of scans (e.g. "..._4059_0491-0492"); viewer links and
// thumbnails should always point at the first scan in that range.
function getFirstScanId(documentId) {
  const match = /^(.+_)(\d+)-\d+$/.exec(documentId || '');
  return match ? `${match[1]}${match[2]}` : documentId;
}

function buildViewerUrl(result) {
  const documentId = getFirstScanId(result?.name);
  const inventoryNumber = getInventoryNumber(result);

  if (!documentId || !inventoryNumber) {
    return '#';
  }

  const manifest = `https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/inventory:${inventoryNumber}.manifest`;
  const canvas = `https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/canvas:${documentId}`;
  const params = new URLSearchParams({
    manifest,
    canvas,
  });

  return `https://dev.globalise.nl/manifest?${params.toString()}`;
}

async function getThumbnailUrl(result) {
  const documentId = getFirstScanId(result?.name);
  const inventoryNumber = getInventoryNumber(result);

  if (!documentId || !inventoryNumber) {
    return '';
  }

  const manifestUrl = `https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/inventory:${inventoryNumber}.manifest`;

  try {
    const response = await fetch(manifestUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return '';
    }

    const manifest = await response.json();
    const canvases = Array.isArray(manifest?.items) ? manifest.items : [];

    const canvas = canvases.find((item) => typeof item?.id === 'string' && item.id.endsWith(documentId));

    if (!canvas) {
      return '';
    }

    const annotationPage = canvas?.items?.[0];
    const body = annotationPage?.items?.[0]?.body;

    return body && typeof body === 'object' && body.id
      ? body.id.replace('/full/max/', '/full/400,/')
      : '';
  } catch (error) {
    console.warn(`Unable to load thumbnail for ${documentId}:`, error);
    return '';
  }
}

// Must match `highlight.fields.text.number_of_fragments` in the main search payload above.
// Fewer fragments than this cap coming back means ES ran out of real matches, not out of room
// — so that count is already exact. Exactly this many means it's ambiguous (could be exactly
// this many, could be more), which is what triggers the exact-count follow-up request.
const FRAGMENT_CAP = 3;

// Turns one raw ES highlight fragment (which contains literal <mark>/</mark> around matched
// text, but is NOT otherwise HTML-escaped) into safe HTML: escape everything except the mark
// tags themselves, so stray "<" or "&" in OCR'd source text can't break the page.
function sanitizeHighlightFragment(raw) {
  const markRe = /<mark>([\s\S]*?)<\/mark>/g;
  let lastIndex = 0;
  let out = '';
  let match;
  while ((match = markRe.exec(raw))) {
    out += escapeHtml(raw.slice(lastIndex, match.index));
    out += `<mark>${escapeHtml(match[1])}</mark>`;
    lastIndex = markRe.lastIndex;
  }
  out += escapeHtml(raw.slice(lastIndex));
  return out;
}

// Counts real matches in a *fully* highlighted field (i.e. a `number_of_fragments: 0` result —
// see fetchExactMatchCounts). Used only for its count; the follow-up request is scoped to one
// document so there's no need to also carve display snippets out of it.
function countHighlightMarks(rawHighlighted) {
  return (rawHighlighted.match(/<mark>/g) || []).length;
}

// Returns the (possibly provisional) match count plus ready-to-render snippet blocks for a
// result, from the cheap capped-fragment highlight on the main search response. matchCount is
// 0 whenever there was nothing to highlight and we fell back to a plain excerpt — that fallback
// isn't a real "N matches" signal, so callers should treat 0 as "don't show a match badge".
// isExact is false exactly when fragments.length === FRAGMENT_CAP, meaning the real count might
// be higher; fetchExactMatchCounts resolves that ambiguity afterwards for just those results.
function getHighlightInfo(result) {
  const fragments = result?.highlight?.text ?? [];
  if (fragments.length) {
    return {
      snippets: fragments.map(sanitizeHighlightFragment),
      matchCount: fragments.length,
      isExact: fragments.length < FRAGMENT_CAP,
    };
  }

  // Structural-only searches (person:/place:/etc.) don't match anything in the "text" field,
  // so Elasticsearch has nothing to highlight. Fall back to a plain excerpt of the document text.
  const fullText = (result?.text || '').replace(/\s+/g, ' ').trim();
  if (!fullText) return { matchCount: 0, snippets: ['No snippet available.'], isExact: true };
  const excerpt = fullText.length > 300 ? `${fullText.slice(0, 300)}…` : fullText;
  return { matchCount: 0, snippets: [escapeHtml(excerpt)], isExact: true };
}

// Renders the match-count indicator shown on a result card, e.g. "●●●+ 3+ matches" while
// provisional, upgrading in place to e.g. "●●●+ 7 matches" once fetchExactMatchCounts resolves
// (see there). The dots are visually capped at 3 since a literal dot per match would grow
// unboundedly; the label text states the count, with a trailing "+" only while it's provisional.
function renderMatchBadge(matchCount, isExact, badgeId) {
  if (!matchCount) return '';
  const maxDots = 3;
  const filled = Math.min(matchCount, maxDots);
  const dots = Array.from({ length: maxDots }, (_, i) =>
    i < filled ? '<span class="match-dot match-dot--filled"></span>' : '<span class="match-dot"></span>'
  ).join('');
  const overflow = !isExact ? '<span class="match-dot-overflow">+</span>' : '';
  const label = `${matchCount}${isExact ? '' : '+'} ${matchCount === 1 && isExact ? 'match' : 'matches'}`;
  return `
    <span class="match-badge" id="${badgeId}" data-exact="${isExact}" title="${label} found in this document">
      <span class="match-dots">${dots}${overflow}</span>
      <span class="match-badge-label">${label}</span>
    </span>
  `;
}

// Renders each display snippet as its own block so multiple matches in one document are visibly
// distinct passages rather than one run-on paragraph. Leaves an empty, hidden placeholder line
// (targeted by moreId) that fetchExactMatchCounts fills in with "+N more matches not shown" if
// the resolved exact count turns out to exceed what's displayed here.
function renderSnippetList(snippets, moreId) {
  const items = snippets.map((snippet) => `<p class="result-snippet">${snippet}</p>`).join('');
  return `<div class="result-snippets">${items}<p class="result-snippet-more" id="${moreId}" hidden></p></div>`;
}

// For results whose highlight hit FRAGMENT_CAP (so the main request only tells us "at least
// this many", not the true total), fetches an exact count via a small follow-up request per
// document — batched into one `_msearch` call — and patches the already-rendered badge/snippet
// list in place. Each sub-query re-runs the exact same query as the main search (so match
// semantics stay identical) but scoped to a single document via an `ids` filter, with
// `number_of_fragments: 0` so Elasticsearch highlights the whole field and every match can be
// counted. Deliberately NOT done for every result on the page: documents in this corpus can be
// very long, and fully highlighting all of them on every page load would be slow and wasteful
// when, for most results, the capped fragment count is already exact.
async function fetchExactMatchCounts(pendingItems, esQuery, token) {
  if (!pendingItems.length) return;

  const ndjsonLines = [];
  pendingItems.forEach(({ id }) => {
    ndjsonLines.push(JSON.stringify({}));
    ndjsonLines.push(
      JSON.stringify({
        size: 1,
        _source: false,
        query: {
          bool: {
            filter: [{ ids: { values: [id] } }],
            must: [esQuery],
          },
        },
        highlight: {
          pre_tags: ['<mark>'],
          post_tags: ['</mark>'],
          fields: { text: { number_of_fragments: 0 } },
        },
      })
    );
  });

  let responses;
  try {
    const response = await fetch(MSEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: `${ndjsonLines.join('\n')}\n`,
    });
    if (!response.ok) throw new Error(`msearch failed with status ${response.status}`);
    const data = await response.json();
    responses = Array.isArray(data?.responses) ? data.responses : [];
  } catch (error) {
    console.warn('Unable to fetch exact match counts, leaving provisional counts in place:', error);
    return;
  }

  if (token !== searchToken) return; // a newer search has since started; discard these results

  pendingItems.forEach(({ badgeId, moreId, displayedCount }, i) => {
    const raw = responses[i]?.hits?.hits?.[0]?.highlight?.text?.[0];
    if (!raw) return;
    const matchCount = countHighlightMarks(raw);
    if (!matchCount) return;

    const badgeEl = document.getElementById(badgeId);
    if (badgeEl) {
      const label = `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`;
      badgeEl.dataset.exact = 'true';
      badgeEl.title = `${label} found in this document`;
      const labelEl = badgeEl.querySelector('.match-badge-label');
      if (labelEl) labelEl.textContent = label;
      badgeEl.querySelector('.match-dot-overflow')?.remove();
    }

    const moreEl = document.getElementById(moreId);
    if (moreEl && matchCount > displayedCount) {
      const hiddenCount = matchCount - displayedCount;
      moreEl.textContent = `+${hiddenCount} more ${hiddenCount === 1 ? 'match' : 'matches'} not shown`;
      moreEl.hidden = false;
    }
  });
}

function sortResults(results, sortKey) {
  const sorted = [...results];

  if (sortKey === 'inventory') {
    sorted.sort((a, b) => {
      const invA = Number(a.inventoryNumber || 0);
      const invB = Number(b.inventoryNumber || 0);
      return invA - invB;
    });
    return sorted;
  }

  if (sortKey === 'year') {
    sorted.sort((a, b) => {
      const yearA = getYearValue(a);
      const yearB = getYearValue(b);
      const valA = Number.isFinite(yearA) ? yearA : -Infinity;
      const valB = Number.isFinite(yearB) ? yearB : -Infinity;
      return valB - valA;
    });
    return sorted;
  }

  return results;
}

function getSortOptionState(results) {
  const hasYearData = results.some((result) => getYearValue(result) !== null);
  const yearOption = sortSelect?.querySelector('option[value="year"]');

  if (yearOption) {
    yearOption.hidden = !hasYearData;
    if (!hasYearData && currentSort === 'year') {
      currentSort = 'relevance';
      if (sortSelect) sortSelect.value = 'relevance';
    }
  }
}

async function search(keywordText, chips, page, sortKey = 'relevance') {
  const trimmedQuery = (keywordText || '').trim();
  const activeChips = chips || [];

  if (!trimmedQuery && !activeChips.length) {
    if (statusContainer) statusContainer.textContent = 'Please enter a search query or add a filter.';
    if (resultsContainer) resultsContainer.innerHTML = '<div class="empty-state">Please enter a search query or add a filter.</div>';
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  currentQuery = trimmedQuery;
  currentChips = activeChips;
  currentPage = page;
  currentSort = sortKey;
  updateQueryState(trimmedQuery, activeChips, page, sortKey);

  const token = ++searchToken;
  const from = (page - 1) * pageSize;
  const query = await buildEsQuery(trimmedQuery, activeChips);
  const payload = {
    from,
    size: pageSize,
    query,
    highlight: {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        // Cheap on purpose: documents in this corpus can be very long, so every result on every
        // page requesting the *entire* highlighted field would be expensive to compute and slow
        // to transmit. This gives fast, capped display snippets; getHighlightInfo below detects
        // when a result hit the cap (FRAGMENT_CAP) and, for just those ambiguous results,
        // fetchExactMatchCounts makes a separate, scoped, single-document request to get the
        // real count without paying that cost for every result on the page.
        text: { fragment_size: 150, number_of_fragments: FRAGMENT_CAP },
      },
    },
    sort: ['_score'],
  };

  if (statusContainer) {
    statusContainer.textContent = 'Searching…';
  }
  if (resultsContainer) {
    resultsContainer.innerHTML = '';
  }
  if (paginationContainer) {
    paginationContainer.innerHTML = '';
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = await response.json();
    const totalHits = Number(data?.hits?.total?.value ?? 0);
    const hits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];
    const results = hits.map((hit) => ({ ...hit._source, highlight: hit.highlight, _id: hit._id }));
    currentResults = results;
    getSortOptionState(results);

    const sortedResults = sortResults(results, currentSort);
    const pendingExactCounts = await renderResults(sortedResults, totalHits, page, trimmedQuery, activeChips, currentSort);
    // Deliberately not awaited: the page is already rendered with provisional "N+ matches"
    // badges (see FRAGMENT_CAP below), and this only refines the handful of results that hit
    // the cap. No reason to make the user wait on it.
    fetchExactMatchCounts(pendingExactCounts, query, token);
  } catch (error) {
    console.error(error);
    if (statusContainer) {
      statusContainer.textContent = 'Search failed. Please try again.';
    }
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="empty-state">Unable to load results.</div>';
    }
  }
}

async function renderResults(results, totalHits, page, query, chips, sortKey) {
  const totalPages = Math.max(1, Math.ceil(totalHits / pageSize));
  const startIndex = totalHits === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalHits);

  const sortLabel = sortKey === 'inventory' ? 'inventory number' : sortKey === 'year' ? 'year' : 'relevance';
  const queryLabel = query ? ` for “${escapeHtml(query)}”` : '';
  const chipsLabel = describeChips(chips);

  if (statusContainer) {
    statusContainer.textContent = totalHits
      ? `Showing ${startIndex}-${endIndex} of ${totalHits} results${queryLabel}${chipsLabel}, sorted by ${sortLabel}.`
      : `No results found${queryLabel}${chipsLabel}.`;
  }

  if (!results.length) {
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="empty-state">No matching results were returned.</div>';
    }
    if (paginationContainer) paginationContainer.innerHTML = '';
    return [];
  }

  const pendingExactCounts = [];
  const listHtml = await Promise.all(
    results.map(async (result, index) => {
      const documentId = result.name || 'Unknown document';
      const viewerUrl = buildViewerUrl(result);
      const { snippets, matchCount, isExact } = getHighlightInfo(result);
      const badgeId = `match-badge-${index}`;
      const moreId = `snippet-more-${index}`;
      if (!isExact && result._id) {
        pendingExactCounts.push({ index, id: result._id, badgeId, moreId, displayedCount: snippets.length });
      }
      const matchBadge = renderMatchBadge(matchCount, isExact, badgeId);
      const snippetHtml = renderSnippetList(snippets, moreId);
      const invNr = result.inventoryNumber || 'Unknown inventory';
      const settlement = result.settlement || 'Unknown';
      const year = getYearValue(result);
      const thumbnailUrl = await getThumbnailUrl(result);

      return `
        <article class="result-item">
          <div class="result-figure">
            ${thumbnailUrl
              ? `<a href="${viewerUrl}"><img src="${thumbnailUrl}" alt="Thumbnail for ${escapeHtml(documentId)}" loading="lazy" /></a>`
              : '<div class="result-thumb-placeholder">No image</div>'}
          </div>
          <div class="result-content">
            <div class="result-meta">
              <h2 class="result-title"><a href="${viewerUrl}">${escapeHtml(documentId)}</a>${matchBadge}</h2>
              <small>${year !== null ? `${escapeHtml(year)} · ` : ''}Inventory ${escapeHtml(invNr)} · ${escapeHtml(settlement)}</small>
            </div>
            ${snippetHtml}
            <div class="result-footer">
              <a href="${viewerUrl}">Open in viewer</a>
            </div>
          </div>
        </article>
      `;
    })
  ).then((items) => items.join(''));

  if (resultsContainer) {
    resultsContainer.innerHTML = listHtml;
  }
  renderPagination(page, totalPages, query, chips, sortKey);
  return pendingExactCounts;
}

function renderPagination(page, totalPages, query, chips, sortKey) {
  const prevButton = `
    <button type="button" ${page <= 1 ? 'disabled' : ''} data-page="${Math.max(1, page - 1)}" aria-label="Previous page">
      Previous
    </button>
  `;

  const nextButton = `
    <button type="button" ${page >= totalPages ? 'disabled' : ''} data-page="${Math.min(totalPages, page + 1)}" aria-label="Next page">
      Next
    </button>
  `;

  if (paginationContainer) {
    paginationContainer.innerHTML = `
      ${prevButton}
      <span class="page-indicator">Page ${page} of ${totalPages}</span>
      ${nextButton}
    `;

    const buttons = paginationContainer.querySelectorAll('button[data-page]');
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const targetPage = Number(button.dataset.page);
        if (!Number.isNaN(targetPage) && targetPage >= 1) {
          search(query, chips, targetPage, sortKey);
        }
      });
    });
  }
}

function initLandingPage() {
  if (!landingForm) return;

  const queryBuilder = createQueryBuilder({
    formEl: landingForm,
    chipsEl: document.querySelector('#landing-query-chips'),
    inputEl: document.querySelector('#landing-search-input'),
    suggestionsEl: document.querySelector('#landing-query-suggestions'),
    previewEl: document.querySelector('#landing-query-preview'),
  });

  const goToResults = () => {
    const text = queryBuilder.getKeywordText();
    const chips = queryBuilder.getChips();
    if (!text && !chips.length) return;
    const params = new URLSearchParams();
    if (text) params.set('q', text);
    if (chips.length) params.set('filters', encodeChips(chips));
    window.location.href = `results.html?${params.toString()}`;
  };

  landingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    goToResults();
  });
}

function initResultsPage() {
  if (!resultsForm || !statusContainer || !resultsContainer || !paginationContainer) return;

  const { q, page, sort, filters } = getSearchParams();
  currentPage = page;
  currentSort = sort || 'relevance';

  const queryBuilder = createQueryBuilder({
    formEl: resultsForm,
    chipsEl: document.querySelector('#results-query-chips'),
    inputEl: document.querySelector('#results-search-input'),
    suggestionsEl: document.querySelector('#results-query-suggestions'),
    previewEl: document.querySelector('#results-query-preview'),
  });
  queryBuilder.setKeywordText(q);
  queryBuilder.setChips(decodeChips(filters));

  if (sortSelect) sortSelect.value = currentSort;

  const runSearch = (targetPage) => {
    const text = queryBuilder.getKeywordText();
    const chips = queryBuilder.getChips();
    if (!text && !chips.length) return;
    search(text, chips, targetPage, currentSort);
  };

  resultsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(1);
  });
  resultsForm.addEventListener('querybuilder:change', () => runSearch(1));

  if (sortSelect) {
    sortSelect.addEventListener('change', (event) => {
      currentSort = event.target.value;
      search(currentQuery, currentChips, 1, currentSort);
    });
  }

  runSearch(page);
}

if (pageType === 'landing') {
  initLandingPage();
} else {
  initResultsPage();
}