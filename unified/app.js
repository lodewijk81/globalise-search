// Page state, the search box with its pills, and running searches.

import {
  FIELD_ALIASES, FIELD_BY_KEY, FIELD_DEFS, FRAGMENT_CAP, MAX_RESULT_WINDOW, PAGE_SIZE, SCOPES, SCOPE_KEYS, SORTS,
} from './config.js';
import { buildHighlightQuery, buildQuery, collectFieldNodes, hasWildcard, parse, plainTerms, tokenize } from './query.js';
import {
  archiveNodeLabel, conceptLabels, conceptUsage, countOf, esMsearch, esSearch, facetAggs, fetchArchiveChildren, loadAnnotationCounts,
  personLabels, placeLabels, resolveChips, suggestionsFor, thumbnailUrl,
} from './api.js';
import {
  annotatedToHtml, archiveTree, chipHtml, countHits, documentCard, documentFacets, escapeHtml, formatCount, legendHtml, objectCard,
  personCard, personFacets, personIds,
} from './render.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#search-form');
const input = $('#search-input');
const chipsEl = $('#query-chips');
const previewEl = $('#query-preview');
const suggestionsEl = $('#query-suggestions');
const tabsEl = $('#scope-tabs');
const statusEl = $('#status');
const resultsEl = $('#results');
const facetsEl = $('#facets');
const paginationEl = $('#pagination');
const sortWrap = $('#sort-wrap');
const sortSelect = $('#sort-select');

const state = { q: '', chips: [], scope: 'all', page: 1, sort: 'relevance' };
let runToken = 0;
// The compiled search behind what's on screen, reused by "Show more", the reader and the archive tree.
let current = { query: null, highlightQuery: null, hits: [] };

// --- URL ----------------------------------------------------------------------------------

function encodeChips(chips) {
  return chips
    .map((chip) => {
      const extra = {};
      if (chip.id !== undefined) extra.id = chip.id;
      if (chip.variants?.length > 1) extra.variants = chip.variants;
      const body = Object.keys(extra).length ? JSON.stringify({ value: chip.value, ...extra }) : chip.value;
      return `${chip.fieldKey}:${encodeURIComponent(body)}`;
    })
    .join('|');
}

function decodeChips(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .map((part) => {
      const separator = part.indexOf(':');
      if (separator === -1) return null;
      const fieldKey = part.slice(0, separator);
      if (!FIELD_BY_KEY.has(fieldKey)) return null;
      let body;
      try {
        body = decodeURIComponent(part.slice(separator + 1));
      } catch (error) {
        return null;
      }
      if (!body.startsWith('{')) return body ? { fieldKey, value: body } : null;
      try {
        const data = JSON.parse(body);
        return data.value ? { fieldKey, value: data.value, id: data.id, variants: data.variants } : null;
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  state.q = params.get('q') || '';
  state.chips = decodeChips(params.get('filters'));
  state.scope = SCOPES[params.get('scope')] ? params.get('scope') : 'all';
  state.page = Math.max(1, Number(params.get('page')) || 1);
  state.sort = params.get('sort') || 'relevance';
}

function writeUrl({ replace = false } = {}) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.chips.length) params.set('filters', encodeChips(state.chips));
  if (state.scope !== 'all') params.set('scope', state.scope);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  const url = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

// --- Search -------------------------------------------------------------------------------

const hasSearch = () => Boolean(state.q || state.chips.length);

const DOCUMENT_SOURCE = ['name', 'title', 'settlement', 'inventoryNumber', 'scanCount', 'archiveDescription', 'startDate', 'endDate', 'documentTypeIdPaths', 'eadIdPaths'];

function documentHighlight(highlightQuery, fragments = FRAGMENT_CAP, noMatch = 280) {
  return {
    fields: {
      annotatedText: {
        type: 'annotated',
        fragment_size: 240,
        number_of_fragments: fragments,
        ...(noMatch ? { no_match_size: noMatch } : {}),
        ...(highlightQuery ? { highlight_query: highlightQuery } : {}),
      },
    },
  };
}

function searchBody(scope, query, highlightQuery, { size, from = 0, sort = 'relevance', facets = false }) {
  const body = { size, from, track_total_hits: true, query };
  if (scope === 'documents') {
    body._source = DOCUMENT_SOURCE;
    body.highlight = documentHighlight(highlightQuery);
  }
  const chosen = (SORTS[scope] || []).find((option) => option.key === sort);
  if (chosen?.sort) body.sort = chosen.sort;
  if (facets) {
    const aggs = facetAggs(scope);
    if (aggs) body.aggs = aggs;
  }
  return body;
}

async function runSearch({ replace = false } = {}) {
  updateMode();
  renderChips();
  const token = ++runToken;
  if (!hasSearch()) {
    writeUrl({ replace });
    return;
  }
  writeUrl({ replace });
  statusEl.textContent = 'Searching…';
  statusEl.classList.remove('is-error');
  sortWrap.hidden = true;
  paginationEl.innerHTML = '';

  const tree = parse(state.q);
  let responses;
  let queries;
  let highlightQuery;
  try {
    await resolveChips([...state.chips, ...collectFieldNodes(tree)]);
    highlightQuery = buildHighlightQuery(tree, state.chips);
    queries = Object.fromEntries(SCOPE_KEYS.map((scope) => [scope, buildQuery(tree, state.chips, scope)]));
    const searches = SCOPE_KEYS.filter((scope) => queries[scope]).map((scope) => {
      const isActive = scope === state.scope;
      const body = isActive
        ? searchBody(scope, queries[scope], highlightQuery, { size: PAGE_SIZE, from: (state.page - 1) * PAGE_SIZE, sort: state.sort, facets: true })
        : state.scope === 'all'
          ? searchBody(scope, queries[scope], highlightQuery, { size: scope === 'documents' ? 3 : 4 })
          : { size: 0, track_total_hits: true, query: queries[scope] };
      return { scope, index: SCOPES[scope].index, body };
    });
    responses = await esMsearch(searches);
    if (token !== runToken) return;
    const byScope = {};
    searches.forEach((search, index) => {
      byScope[search.scope] = responses[index];
    });
    await renderOutcome(byScope, queries, tree, highlightQuery, token);
  } catch (error) {
    if (token !== runToken) return;
    console.error(error);
    statusEl.textContent = 'The search could not be completed. Please try again.';
    statusEl.classList.add('is-error');
    resultsEl.innerHTML = '';
    facetsEl.innerHTML = '';
  }
}

function renderTabs(byScope, queries) {
  const total = SCOPE_KEYS.reduce((sum, scope) => sum + (byScope[scope] && !byScope[scope].error ? countOf(byScope[scope]) : 0), 0);
  const tab = (key, label, count, disabled, title = '') => `
    <button type="button" role="tab" class="scope-tab" data-scope="${key}" aria-selected="${state.scope === key}"${disabled ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>
      ${label}<span class="scope-count">${count}</span>
    </button>`;
  tabsEl.innerHTML = tab('all', 'All', formatCount(total)) + SCOPE_KEYS.map((scope) => {
    if (!queries[scope]) return tab(scope, SCOPES[scope].label, '–', true, `This search can't be applied to ${SCOPES[scope].label.toLowerCase()}`);
    return tab(scope, SCOPES[scope].label, byScope[scope]?.error ? '!' : formatCount(countOf(byScope[scope])), false);
  }).join('');
}

async function cardsFor(scope, hits, tree, startIndex = 0) {
  if (scope === 'documents') return hits.map((hit, index) => documentCard(hit, startIndex + index, FRAGMENT_CAP)).join('');
  const terms = plainTerms(tree, state.chips);
  if (scope === 'persons') {
    const ids = hits.flatMap((hit) => personIds(hit._source));
    const relations = hits.flatMap((hit) => hit._source.relations || []);
    const [labelOf, nameOf] = await Promise.all([conceptLabels(ids), personLabels(relations)]);
    return hits.map((hit) => personCard(hit, terms, labelOf, nameOf)).join('');
  }
  if (scope === 'concepts') {
    const usage = await conceptUsage(hits.map((hit) => hit._id)).catch(() => []);
    const labelOf = await conceptLabels(usage.flatMap((item) => item.path.split('|')));
    const byId = new Map(usage.map((item) => [item.id, item]));
    return hits.map((hit) => objectCard(hit, scope, terms, byId.get(hit._id), labelOf)).join('');
  }
  return hits.map((hit) => objectCard(hit, scope, terms)).join('');
}

function describeFilters() {
  const parts = [];
  if (state.q) parts.push(`“${state.q}”`);
  state.chips.forEach((chip) => parts.push(`${FIELD_BY_KEY.get(chip.fieldKey).label}: ${chip.value}`));
  return parts.join(', ');
}

function fillThumbnails(hits) {
  hits.forEach(async (hit, index) => {
    const url = await thumbnailUrl(hit._source);
    const link = resultsEl.querySelector(`[data-thumb="${index}"]`);
    if (!url || !link) return;
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    link.replaceChildren(image);
  });
}

async function nameAnnotations(root) {
  const spans = [...root.querySelectorAll('.ann')];
  const places = spans.map((span) => span.dataset.place).filter(Boolean);
  const concepts = spans.map((span) => span.dataset.concept).filter(Boolean);
  const [placeOf, conceptOf] = await Promise.all([placeLabels(places), conceptLabels(concepts)]);
  spans.forEach((span) => {
    const name = span.dataset.place ? placeOf(span.dataset.place) : span.dataset.concept ? conceptOf(span.dataset.concept) : null;
    if (name) {
      span.title = `${span.title}: ${name}`;
      span.dataset.name = name;
    }
  });
}

async function fillDocTypes(root) {
  const rows = [...root.querySelectorAll('[data-doctypes]')];
  if (!rows.length) return;
  const labelOf = await conceptLabels(rows.flatMap((row) => JSON.parse(row.dataset.doctypes)));
  rows.forEach((row) => {
    row.innerHTML = JSON.parse(row.dataset.doctypes)
      .filter(labelOf)
      .map((id) => `<button type="button" class="tag" data-field="documenttype" data-add-chip="${escapeHtml(JSON.stringify({ fieldKey: 'documenttype', value: labelOf(id), id }))}">${escapeHtml(labelOf(id))}</button>`)
      .join('');
  });
}

async function renderOutcome(byScope, queries, tree, highlightQuery, token) {
  renderTabs(byScope, queries);
  const scope = state.scope;
  const scopesWithResults = SCOPE_KEYS.filter((key) => byScope[key] && !byScope[key].error && countOf(byScope[key]) > 0);

  if (scope === 'all') {
    facetsEl.innerHTML = '';
    facetsEl.hidden = true;
    const sections = await Promise.all(
      scopesWithResults.map(async (key) => {
        const count = countOf(byScope[key]);
        const hits = byScope[key].hits.hits;
        return `
          <section class="all-section" data-all="${key}">
            <header class="all-head">
              <h2>${SCOPES[key].label}<span>${formatCount(count)}</span></h2>
              ${count > hits.length ? `<button type="button" class="link-button" data-scope-link="${key}">See all ${formatCount(count)}</button>` : ''}
            </header>
            <div class="card-list">${await cardsFor(key, hits, tree)}</div>
          </section>`;
      })
    );
    if (token !== runToken) return;
    resultsEl.innerHTML = sections.join('') || '<div class="empty-state">Nothing found in any index. Try fewer filters, or a wildcard such as <code>timmer*</code>.</div>';
    const failed = SCOPE_KEYS.filter((key) => byScope[key]?.error);
    statusEl.textContent = scopesWithResults.length ? `Results for ${describeFilters()}` : `No results for ${describeFilters()}`;
    if (failed.length) reportError(failed);
    current = { query: queries.documents, highlightQuery, hits: byScope.documents?.hits?.hits || [] };
    afterRender(token);
    return;
  }

  const response = byScope[scope];
  if (!queries[scope] || !response) {
    facetsEl.hidden = true;
    facetsEl.innerHTML = '';
    resultsEl.innerHTML = `<div class="empty-state">This search can't be applied to ${SCOPES[scope].label.toLowerCase()}. Pick another tab above, or remove a filter.</div>`;
    statusEl.textContent = '';
    return;
  }
  if (response.error) {
    facetsEl.hidden = true;
    facetsEl.innerHTML = '';
    resultsEl.innerHTML = '<div class="empty-state">Elasticsearch could not run this query. Check for unbalanced quotes or parentheses.</div>';
    reportError([scope]);
    return;
  }

  const total = countOf(response);
  const hits = response.hits.hits;
  const html = await cardsFor(scope, hits, tree);
  const facetsHtml = await buildFacets(scope, response.aggregations, total);
  if (token !== runToken) return;

  facetsEl.innerHTML = facetsHtml;
  facetsEl.hidden = !facetsHtml;
  resultsEl.innerHTML = html ? `<div class="card-list">${html}</div>` : `<div class="empty-state">No ${SCOPES[scope].noun || SCOPES[scope].label.toLowerCase()} match this search.</div>`;
  const from = total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(state.page * PAGE_SIZE, total);
  const noun = SCOPES[scope].noun || SCOPES[scope].label.toLowerCase();
  const countNoun = total === 1 ? SCOPES[scope].singular : noun;
  statusEl.textContent = total ? `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)} ${countNoun} for ${describeFilters()}` : `No ${noun} for ${describeFilters()}`;

  renderSort(scope);
  renderPagination(total);
  current = { query: queries[scope], highlightQuery, hits: scope === 'documents' ? hits : [] };
  afterRender(token);
}

function afterRender(token) {
  if (!current.hits.length) return;
  fillThumbnails(current.hits);
  nameAnnotations(resultsEl).catch(() => {});
  fillDocTypes(resultsEl).catch(() => {});
  fetchExactCounts(token);
}

function reportError(scopes) {
  statusEl.textContent += `${statusEl.textContent ? ' ' : ''}(Could not search: ${scopes.map((key) => SCOPES[key].label).join(', ')}.)`;
  statusEl.classList.add('is-error');
}

async function buildFacets(scope, aggs, total) {
  if (!aggs) return '';
  if (scope === 'documents') {
    const leaves = [...(aggs.professions?.buckets || []), ...(aggs.documentTypes?.buckets || [])].map((bucket) => bucket.key.split('|').pop());
    const labelOf = await conceptLabels(leaves);
    const roots = (aggs.archive?.buckets || []).map(toArchiveNode);
    const year = state.chips.find((chip) => chip.fieldKey === 'year')?.value;
    return documentFacets(aggs, labelOf, roots, year, total);
  }
  if (scope === 'persons') {
    const ids = [...(aggs.occupations?.buckets || []), ...(aggs.statuses?.buckets || []), ...(aggs.identities?.buckets || [])].map((bucket) => bucket.key.split('|').pop());
    return personFacets(aggs, await conceptLabels(ids), total);
  }
  return '';
}

const toArchiveNode = (bucket) => ({ path: bucket.key, count: bucket.doc_count, label: archiveNodeLabel(bucket) });

function renderSort(scope) {
  const options = SORTS[scope];
  sortWrap.hidden = !options;
  if (!options) return;
  sortSelect.innerHTML = options.map((option) => `<option value="${option.key}">${option.label}</option>`).join('');
  sortSelect.value = options.some((option) => option.key === state.sort) ? state.sort : 'relevance';
}

function renderPagination(total) {
  const lastPage = Math.max(1, Math.ceil(Math.min(total, MAX_RESULT_WINDOW) / PAGE_SIZE));
  if (lastPage <= 1) {
    paginationEl.innerHTML = '';
    return;
  }
  const capped = total > MAX_RESULT_WINDOW ? ' <span class="page-note">(only the first 10,000 can be paged through; refine the search for the rest)</span>' : '';
  paginationEl.innerHTML = `
    <button type="button" data-page="${state.page - 1}"${state.page <= 1 ? ' disabled' : ''}>Previous</button>
    <span class="page-indicator">Page ${formatCount(state.page)} of ${formatCount(lastPage)}${capped}</span>
    <button type="button" data-page="${state.page + 1}"${state.page >= lastPage ? ' disabled' : ''}>Next</button>`;
}

// --- Match counts, "show more" and the reader ----------------------------------------------

// The first request only returns a few fragments, so a card at the cap may have more matches.
async function fetchExactCounts(token) {
  const { hits, query, highlightQuery } = current;
  const pending = hits
    .map((hit, index) => ({ hit, index }))
    .filter(({ hit }) => (hit.highlight?.annotatedText || []).length === FRAGMENT_CAP && (hit.highlight.annotatedText || []).some((fragment) => countHits(fragment)));
  if (!pending.length) return;
  const singleDocQuery = (id) => ({ bool: { filter: [{ ids: { values: [id] } }], must: [query] } });
  let responses;
  try {
    responses = await esMsearch(
      pending.map(({ hit }) => ({
        index: 'documents',
        body: { size: 1, _source: false, query: singleDocQuery(hit._id), highlight: documentHighlight(highlightQuery, 0, 0) },
      }))
    );
  } catch (error) {
    return;
  }
  if (token !== runToken) return;
  pending.forEach(({ hit, index }, i) => {
    const raw = responses[i]?.hits?.hits?.[0]?.highlight?.annotatedText?.[0];
    if (!raw) return;
    const total = countHits(raw);
    const shown = hit.highlight.annotatedText.reduce((sum, fragment) => sum + countHits(fragment), 0);
    const badge = document.getElementById(`hits-${index}`);
    if (badge) badge.textContent = `${formatCount(total)} ${total === 1 ? 'match' : 'matches'}`;
    const more = document.getElementById(`more-${index}`);
    if (more && total > shown) {
      more.hidden = false;
      more.textContent = `Show ${formatCount(total - shown)} more`;
      more.dataset.more = hit._id;
      more.dataset.total = total;
    }
  });
}

async function showMore(button) {
  const id = button.dataset.more;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const data = await esSearch('documents', {
      size: 1,
      _source: false,
      query: { bool: { filter: [{ ids: { values: [id] } }], must: [current.query] } },
      highlight: documentHighlight(current.highlightQuery, Number(button.dataset.total), 0),
    });
    const fragments = data.hits?.hits?.[0]?.highlight?.annotatedText || [];
    const list = button.parentElement;
    const added = fragments.slice(FRAGMENT_CAP).map((fragment) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'result-snippet';
      paragraph.innerHTML = annotatedToHtml(fragment);
      return paragraph;
    });
    button.before(...added);
    button.remove();
    nameAnnotations(list).catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
  }
}

async function toggleReader(button) {
  const index = button.dataset.reader;
  const reader = document.getElementById(`reader-${index}`);
  if (!reader.hidden) {
    reader.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'Read annotated text';
    return;
  }
  reader.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.textContent = 'Close text';
  if (reader.dataset.loaded) return;
  reader.innerHTML = '<p class="muted-note">Loading the annotated text…</p>';
  const docId = button.closest('[data-doc-id]').dataset.docId;
  try {
    const data = await esSearch('documents', {
      size: 1,
      _source: ['annotatedText', 'professionIdPaths'],
      query: { bool: { filter: [{ ids: { values: [docId] } }], must: [current.query] } },
      highlight: documentHighlight(current.highlightQuery, 0, 0),
    });
    const hit = data.hits?.hits?.[0];
    const raw = hit?.highlight?.annotatedText?.[0] || hit?._source?.annotatedText || '';
    const leaves = [...new Set((hit?._source?.professionIdPaths || []).map((path) => path.split('|').pop()))];
    const labelOf = await conceptLabels(leaves);
    const professions = leaves.filter(labelOf).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    const professionsHtml = professions.length
      ? `<div class="pill-row reader-professions"><span class="pill-label">Professions</span>${professions
          .slice(0, 60)
          .map((id) => `<button type="button" class="tag" data-field="profession" data-add-chip="${escapeHtml(JSON.stringify({ fieldKey: 'profession', value: labelOf(id), id }))}">${escapeHtml(labelOf(id))}</button>`)
          .join('')}${professions.length > 60 ? `<span class="tag-more">+${professions.length - 60}</span>` : ''}</div>`
      : '';
    reader.innerHTML = `
      <div class="legend" role="group" aria-label="Show or hide annotation types">${legendHtml()}</div>
      ${professionsHtml}
      <div class="reader-text">${annotatedToHtml(raw)}</div>`;
    reader.dataset.loaded = 'true';
    nameAnnotations(reader).catch(() => {});
  } catch (error) {
    reader.innerHTML = '<p class="muted-note">The text could not be loaded.</p>';
  }
}

async function toggleTree(button) {
  const children = button.closest('.tree-node').querySelector(':scope > .tree-children');
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  button.textContent = expanded ? '▸' : '▾';
  children.hidden = expanded;
  if (expanded || children.dataset.loaded) return;
  children.dataset.loaded = 'true';
  children.innerHTML = '<p class="muted-note">Loading…</p>';
  try {
    const buckets = await fetchArchiveChildren(button.dataset.treeToggle, current.query);
    if (!buckets.length) {
      children.innerHTML = '';
      button.hidden = true;
      return;
    }
    children.innerHTML = archiveTree(buckets.map(toArchiveNode));
  } catch (error) {
    children.innerHTML = '<p class="muted-note">Could not load this section.</p>';
    delete children.dataset.loaded;
  }
}

// --- Pills --------------------------------------------------------------------------------

function renderChips() {
  chipsEl.innerHTML = state.chips.map((chip, index) => chipHtml(chip, { removable: true, index })).join('');
  $('#reset-filters').hidden = !state.chips.length;
}

function addChip(chip) {
  if (chip.fieldKey === 'year') state.chips = state.chips.filter((existing) => existing.fieldKey !== 'year');
  const duplicate = state.chips.some((existing) => existing.fieldKey === chip.fieldKey && existing.value === chip.value && existing.id === chip.id);
  if (!duplicate) state.chips.push(chip);
  state.page = 1;
}

function renderPreview() {
  const tokens = tokenize(input.value);
  if (!tokens.some((token) => token.type !== 'WORD')) {
    previewEl.hidden = true;
    previewEl.innerHTML = '';
    return;
  }
  const fieldChip = (fieldKey, value) => (value ? `<span class="query-chip is-inline" data-field="${fieldKey}"><span class="field-name">${escapeHtml(FIELD_BY_KEY.get(fieldKey).label)}:</span><span>${escapeHtml(value)}</span></span>` : '');
  previewEl.hidden = false;
  previewEl.innerHTML = tokens
    .map((token) => {
      if (token.type === 'FIELD') return fieldChip(token.fieldKey, token.value);
      if (token.type === 'PROX') {
        const items = token.items
          .map((item, index) => {
            const separator = index ? '<span class="query-connector">near</span>' : '';
            if (item.kind === 'field') return separator + fieldChip(item.fieldKey, item.value);
            return `${separator}<span class="query-freetext">${escapeHtml(item.text)}${item.fuzzy ? '~' : ''}</span>`;
          })
          .join('');
        return `<span class="query-proxgroup">${items}<span class="proximity-slop">~${token.slop}</span></span>`;
      }
      if (['AND', 'OR', 'NOT'].includes(token.type)) return `<span class="query-connector">${token.type}</span>`;
      if (token.type === 'LPAREN') return '<span class="query-connector is-paren">(</span>';
      if (token.type === 'RPAREN') return '<span class="query-connector is-paren">)</span>';
      return `<span class="query-freetext">${escapeHtml(token.text)}</span>`;
    })
    .join('');
}

// --- Suggestions --------------------------------------------------------------------------

const SUGGEST_MIN_CHARS = 2;
const DEBOUNCE_MS = 220;
// Searched at once for a bare word: the things people are most likely to be looking for.
const BARE_WORD_FIELDS = ['place', 'person', 'ship', 'organisation', 'polity', 'profession', 'settlement'];

let suggestions = [];
let selected = -1;
let suggestTimer = null;
let suggestController = null;
let suggestRun = 0;

function cancelSuggest() {
  window.clearTimeout(suggestTimer);
  suggestController?.abort();
  suggestRun += 1;
}

function hideSuggestions() {
  cancelSuggest();
  suggestions = [];
  selected = -1;
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = '';
}

function paintSuggestions() {
  if (!suggestions.length) {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = '';
    return;
  }
  suggestionsEl.hidden = false;
  suggestionsEl.innerHTML = suggestions
    .map((item, index) => `<div class="query-suggestion${item.apply ? '' : ' is-static'}${index === selected ? ' is-selected' : ''}" data-index="${index}">${item.html}</div>`)
    .join('');
}

const countHint = (item) => {
  if (item.count != null) return `${formatCount(item.count)} ${item.unit || 'results'}`;
  return item.note || 'Suggested';
};

function suggestionRow(def, item) {
  const display = item.display || item.value;
  const note = item.count != null && item.note ? ` · ${escapeHtml(item.note)}` : '';
  return `
    <span class="query-chip query-chip-preview" data-field="${def.key}"><span class="field-name">${escapeHtml(def.label)}:</span><span>${escapeHtml(display)}</span></span>
    <span class="hint">${escapeHtml(countHint(item))}${note}</span>`;
}

function trailingField() {
  // A single space stays inside the value (for multi-word names); a double space ends it.
  const match = input.value.match(/(^|[\s(])([a-zA-Z]+)\s*:\s*("([^"]*)"|((?:[^\s()]|\s(?!\s))*))$/);
  if (!match) return null;
  const fieldKey = FIELD_ALIASES.get(match[2].toLowerCase());
  if (!fieldKey || FIELD_BY_KEY.get(fieldKey).hidden) return null;
  const value = match[4] !== undefined ? match[4] : match[5] || '';
  const start = match.index + match[1].length;
  return { fieldKey, value, start, end: input.value.length, valueStart: input.value.length - (match[3] ? match[3].length : 0) };
}

function trailingWord() {
  const match = input.value.match(/(^|[\s(])([\p{L}][\p{L}\p{N}]*)$/u);
  if (!match) return null;
  return { word: match[2], start: match.index + match[1].length, end: input.value.length };
}

const isSole = (token) => !input.value.slice(0, token.start).trim() && !input.value.slice(token.end).trim();

// With nothing else in the box a choice becomes a pill. Inside a longer expression it is written
// out as text, because the user is arranging AND/OR/NOT and a pill would pull it out of order.
function applyChoice(token, def, item) {
  if (isSole(token)) {
    input.value = '';
    const chip = { fieldKey: def.key, value: item.value };
    if (item.id !== undefined) chip.id = item.id;
    if (item.variants?.length > 1) chip.variants = item.variants;
    addChip(chip);
    hideSuggestions();
    renderPreview();
    runSearch();
    return;
  }
  const formatted = /\s/.test(item.value) ? `"${item.value}"` : item.value;
  input.value = `${input.value.slice(0, token.start)}${def.key}:${formatted}${input.value.slice(token.end)}`;
  input.focus();
  renderPreview();
  hideSuggestions();
}

function showFieldSuggestions(token) {
  const def = FIELD_BY_KEY.get(token.fieldKey);
  cancelSuggest();
  selected = -1;
  suggestions = [
    token.value
      ? {
          apply: () => applyChoice(token, def, { value: token.value }),
          html: `<span class="query-chip query-chip-preview" data-field="${def.key}"><span class="field-name">${escapeHtml(def.label)}:</span><span>${escapeHtml(token.value)}</span></span><span class="hint">${hasWildcard(token.value) ? 'Wildcard ↵' : 'As typed ↵'}</span>`,
        }
      : { apply: null, html: `<span class="query-chip query-chip-preview" data-field="${def.key}"><span class="field-name">${escapeHtml(def.label)}:</span></span><span class="hint">${escapeHtml(def.hint)}</span>` },
  ];
  paintSuggestions();

  const prefix = token.value.trim();
  const allowEmpty = def.source === 'annotation';
  if (!def.source || hasWildcard(prefix) || (prefix.length < SUGGEST_MIN_CHARS && !allowEmpty)) return;
  const run = suggestRun;
  suggestTimer = window.setTimeout(async () => {
    suggestController = new AbortController();
    try {
      const items = await suggestionsFor(def, prefix, suggestController.signal);
      if (run !== suggestRun) return;
      suggestions = [suggestions[0], ...items.map((item) => ({ apply: () => applyChoice(token, def, item), html: suggestionRow(def, item) }))];
      paintSuggestions();
    } catch (error) {
      if (error.name !== 'AbortError') console.error(error);
    }
  }, DEBOUNCE_MS);
}

function showWordSuggestions(word) {
  cancelSuggest();
  selected = -1;
  const lower = word.word.toLowerCase();
  const fieldMatches = FIELD_DEFS.filter((def) => !def.hidden && [def.key, ...def.aliases].some((name) => name.startsWith(lower)));
  suggestions = fieldMatches.map((def) => ({
    apply: () => {
      insertField(def.key, word);
    },
    html: `<span class="query-chip query-chip-preview" data-field="${def.key}"><span class="field-name">${escapeHtml(def.key)}:</span></span><span class="hint">${escapeHtml(def.hint)}</span>`,
  }));
  paintSuggestions();

  if (word.word.length < SUGGEST_MIN_CHARS) return;
  const run = suggestRun;
  suggestTimer = window.setTimeout(async () => {
    suggestController = new AbortController();
    const { signal } = suggestController;
    try {
      const groups = await Promise.all(
        BARE_WORD_FIELDS.map((key) =>
          suggestionsFor(FIELD_BY_KEY.get(key), word.word, signal)
            .then((items) => items.slice(0, 3).map((item) => ({ def: FIELD_BY_KEY.get(key), item })))
            .catch((error) => {
              if (error.name === 'AbortError') throw error;
              return [];
            })
        )
      );
      if (run !== suggestRun) return;
      const values = groups.flat().slice(0, 12).map(({ def, item }) => ({ apply: () => applyChoice(word, def, item), html: suggestionRow(def, item) }));
      suggestions = [...suggestions, ...values];
      paintSuggestions();
    } catch (error) {
      if (error.name !== 'AbortError') console.error(error);
    }
  }, DEBOUNCE_MS);
}

function updateSuggestions() {
  renderPreview();
  const token = trailingField();
  if (token) {
    showFieldSuggestions(token);
    return;
  }
  const word = trailingWord();
  if (word) showWordSuggestions(word);
  else hideSuggestions();
}

function insertField(key, word) {
  if (word) {
    input.value = `${input.value.slice(0, word.start)}${key}:${input.value.slice(word.end)}`;
  } else {
    const spacer = input.value && !/\s$/.test(input.value) ? ' ' : '';
    input.value = `${input.value}${spacer}${key}:`;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  updateSuggestions();
}

function moveSelection(step) {
  const selectable = suggestions.map((item, index) => (item.apply ? index : -1)).filter((index) => index !== -1);
  if (!selectable.length) return;
  const position = selectable.indexOf(selected);
  selected = position === -1 ? (step > 0 ? selectable[0] : selectable[selectable.length - 1]) : selectable[(position + step + selectable.length) % selectable.length];
  paintSuggestions();
  suggestionsEl.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
}

function submitBox() {
  state.q = input.value.trim();
  state.page = 1;
  hideSuggestions();
  if (hasSearch()) runSearch();
}

input.addEventListener('input', updateSuggestions);
input.addEventListener('blur', () => window.setTimeout(hideSuggestions, 120));
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideSuggestions();
  } else if (event.key === 'ArrowDown' && suggestions.length) {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'ArrowUp' && suggestions.length) {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === 'Backspace' && !input.value && state.chips.length) {
    event.preventDefault();
    state.chips.pop();
    state.page = 1;
    runSearch();
  } else if (event.key === 'Enter') {
    if (selected !== -1 && suggestions[selected]?.apply) {
      event.preventDefault();
      suggestions[selected].apply();
      return;
    }
    const token = trailingField();
    if (token?.value && isSole(token)) {
      event.preventDefault();
      applyChoice(token, FIELD_BY_KEY.get(token.fieldKey), { value: token.value });
    }
  }
});

suggestionsEl.addEventListener('mousedown', (event) => {
  const row = event.target.closest('.query-suggestion');
  if (!row) return;
  event.preventDefault();
  suggestions[Number(row.dataset.index)]?.apply?.();
});
suggestionsEl.addEventListener('mousemove', (event) => {
  const row = event.target.closest('.query-suggestion');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (suggestions[index]?.apply && index !== selected) {
    selected = index;
    suggestionsEl.querySelectorAll('.query-suggestion').forEach((el) => el.classList.toggle('is-selected', Number(el.dataset.index) === selected));
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitBox();
});

// --- Clicks anywhere on the page -----------------------------------------------------------

function annotationChip(span) {
  const text = span.textContent.trim();
  // The record's name, because the text itself is often a garbled or period spelling.
  const name = span.dataset.name || text;
  if (span.dataset.place) return { fieldKey: 'place', value: name, id: span.dataset.place };
  if (span.dataset.concept) return { fieldKey: 'role', value: name, id: span.dataset.concept };
  if (span.dataset.ann === 'Person') return { fieldKey: 'person', value: text };
  return { fieldKey: 'annotation', value: span.dataset.ann };
}

document.addEventListener('click', (event) => {
  const target = event.target;
  const removeButton = target.closest('[data-remove-chip]');
  if (removeButton) {
    state.chips.splice(Number(removeButton.dataset.removeChip), 1);
    state.page = 1;
    runSearch();
    return;
  }
  if (target.closest('[data-reset-filters]')) {
    state.chips = [];
    state.page = 1;
    // With no text left there is nothing to search, so go back to a clean start page.
    if (!state.q) {
      state.scope = 'all';
      state.sort = 'relevance';
    }
    runSearch();
    input.focus();
    return;
  }
  const addButton = target.closest('[data-add-chip]');
  if (addButton) {
    if (addButton.dataset.replaceQuery) {
      state.q = '';
      input.value = '';
      state.chips = [];
      renderPreview();
    }
    addChip(JSON.parse(addButton.dataset.addChip));
    if (addButton.dataset.toScope) state.scope = addButton.dataset.toScope;
    else if (state.scope === 'all') state.scope = 'documents';
    state.sort = 'relevance';
    state.page = 1;
    runSearch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const annotation = target.closest('.ann');
  if (annotation) {
    addChip(annotationChip(annotation));
    state.scope = 'documents';
    state.page = 1;
    runSearch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const scopeTab = target.closest('[data-scope]:not(article)');
  const scopeLink = target.closest('[data-scope-link]');
  if ((scopeTab && scopeTab.matches('.scope-tab')) || scopeLink) {
    const next = scopeLink ? scopeLink.dataset.scopeLink : scopeTab.dataset.scope;
    if (next !== state.scope) {
      state.scope = next;
      state.page = 1;
      state.sort = 'relevance';
      runSearch();
    }
    return;
  }
  const pageButton = target.closest('[data-page]');
  if (pageButton && !pageButton.disabled) {
    state.page = Number(pageButton.dataset.page);
    runSearch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const more = target.closest('[data-more]');
  if (more) {
    showMore(more);
    return;
  }
  const reader = target.closest('[data-reader]');
  if (reader) {
    toggleReader(reader);
    return;
  }
  const tree = target.closest('[data-tree-toggle]');
  if (tree) {
    toggleTree(tree);
    return;
  }
  const fieldPill = target.closest('[data-insert-field]');
  if (fieldPill) {
    insertField(fieldPill.dataset.insertField);
    return;
  }
  const example = target.closest('[data-example]');
  if (example) {
    const data = JSON.parse(example.dataset.example);
    state.q = data.q || '';
    input.value = state.q;
    renderPreview();
    state.chips = data.chips || [];
    state.scope = data.scope || 'all';
    state.page = 1;
    runSearch();
    return;
  }
  const clear = target.closest('[data-clear]');
  if (clear) {
    state.q = '';
    state.chips = [];
    state.scope = 'all';
    state.page = 1;
    state.sort = 'relevance';
    input.value = '';
    renderPreview();
    runSearch();
    input.focus();
  }
});

document.addEventListener('change', (event) => {
  const legend = event.target.closest('[data-legend]');
  if (legend) {
    legend.closest('.reader').querySelector('.reader-text').classList.toggle(`hide-${legend.dataset.legend}`, !legend.checked);
  }
});

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  state.page = 1;
  runSearch();
});

window.addEventListener('popstate', () => {
  readUrl();
  input.value = state.q;
  renderPreview();
  hideSuggestions();
  if (hasSearch()) runSearch({ replace: true });
  else updateMode();
});

// --- Start --------------------------------------------------------------------------------

function updateMode() {
  renderChips();
  document.body.dataset.mode = hasSearch() ? 'results' : 'home';
}

function renderFieldPills() {
  $('#field-pills').innerHTML = FIELD_DEFS.filter((def) => !def.hidden)
    .map((def) => `<button type="button" class="field-pill" data-field="${def.key}" data-insert-field="${def.key}" title="${escapeHtml(def.hint)}">${escapeHtml(def.label)}</button>`)
    .join('');
}

// Live numbers on the landing page, and shortcuts into browsing each index.
async function renderHomeIndices() {
  const box = $('#home-indices');
  try {
    const responses = await esMsearch(SCOPE_KEYS.map((scope) => ({ index: SCOPES[scope].index, body: { size: 0, track_total_hits: true } })));
    box.innerHTML = SCOPE_KEYS.map(
      (scope, index) => `<button type="button" class="index-card" data-example="${escapeHtml(JSON.stringify({ q: '*', scope }))}">
        <span class="index-count">${formatCount(countOf(responses[index]))}</span>
        <span class="index-label">${SCOPES[scope].label}</span>
      </button>`
    ).join('');
  } catch (error) {
    box.innerHTML = '';
  }
}

const EXAMPLES = [
  { text: 'timmerman', data: { q: 'timmerman' } },
  { text: 'Amsterdam, as a tagged place', pills: [['place', 'Amsterdam']], data: { chips: [{ fieldKey: 'place', value: 'Amsterdam', id: 'GLOB2_937' }], scope: 'documents' } },
  { text: 'koopman', pills: [['profession', 'koopman']], data: { q: 'profession:koopman' } },
  { text: 'tot slaaf gemaakt', pills: [['status', 'tot slaaf gemaakt']], data: { q: 'status:"tot slaaf gemaakt"', scope: 'persons' } },
  { pills: [['annotation', 'Attack'], ['year', '1740-1745']], data: { q: 'annotation:Attack year:1740-1745', scope: 'documents' } },
  { near: true, pills: [['place', 'Batavia'], ['annotation', 'Payment']], data: { q: '(place:Batavia annotation:Payment)~5', scope: 'documents' } },
  { pills: [['ship', 'Pepertuin']], data: { q: 'peper', scope: 'ships' } },
];

function renderExamples() {
  const pill = ([key, value]) => `<span class="query-chip is-inline" data-field="${key}"><span class="field-name">${escapeHtml(FIELD_BY_KEY.get(key).label)}:</span><span>${escapeHtml(value)}</span></span>`;
  $('#examples').innerHTML = EXAMPLES.map((example) => {
    const inner = example.near
      ? `${pill(example.pills[0])}<span class="query-connector">near</span>${pill(example.pills[1])}`
      : example.pills
        ? example.pills.map(pill).join('')
        : `<span class="query-freetext">${escapeHtml(example.text)}</span>`;
    return `<button type="button" class="query-example" data-example="${escapeHtml(JSON.stringify(example.data))}">${inner}</button>`;
  }).join('');
}

renderFieldPills();
renderExamples();
renderHomeIndices();
loadAnnotationCounts();
readUrl();
input.value = state.q;
renderPreview();
if (hasSearch()) runSearch({ replace: true });
else updateMode();
