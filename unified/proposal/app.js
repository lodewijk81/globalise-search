// The query syntax prototype (#122). Adapted from ../app.js, with these differences:
//
// 1. The search bar is a CodeMirror editor with inline pills (editor.js, suggest.js).
//    Everything structural is written into the query; nothing is a separate pill row.
// 2. One query, all tabs. The tab only decides what you look at; every tab shows its count.
//    There is no "All" tab; a search starts on Documents.
// 3. Facets narrow down the active tab only. Their selections are remembered per tab and shown
//    in the "Filters on this tab" row. The date is the exception: it carries over to every tab
//    where it applies.
// 4. Every facet value and filter can be moved into the query ("+" / "→ search"), where it can be
//    combined with operators, proximity and regions, and applies to all tabs.
// 5. Under the bar: a plain-language reading of the query and any problems with it.

import './setup.js';
import { FIELD_BY_KEY, FRAGMENT_CAP, MAX_RESULT_WINDOW, PAGE_SIZE, SCOPES, SCOPE_KEYS, SORTS } from '../config.js';
import {
  archiveNodeLabel, conceptUsage, countOf, esMsearch, esSearch, facetAggs, fetchArchiveChildren,
  personLabels, placeLabels, resolveChips, splitTitles, thumbnailUrl,
} from '../api.js';
import {
  annotatedToHtml, archiveTree, countHits, documentCard, documentFacets, escapeHtml, formatCount, legendHtml, objectCard,
  personCard, personFacets, personIds,
} from '../render.js';
import { buildHighlightQuery, buildQuery, collectFieldNodes, diagnose, encodeToken, parse, plainTerms, positionalProblem, readBack, REGIONS } from './query.js';
import { createEditor } from './editor.js';
import { conceptLabelsEn } from './labels.js';
import { ANY_FIELDS, completionSource } from './suggest.js';

const $ = (selector) => document.querySelector(selector);
const tabsEl = $('#scope-tabs');
const statusEl = $('#status');
const resultsEl = $('#results');
const facetsEl = $('#facets');
const paginationEl = $('#pagination');
const sortWrap = $('#sort-wrap');
const sortSelect = $('#sort-select');
const readbackEl = $('#readback');
const diagnosticsEl = $('#diagnostics');
const filterRow = $('#filter-row');
const filterChipsEl = $('#filter-chips');
const plusButton = $('#plus-button');
const plusMenu = $('#plus-menu');
const popover = $('#pill-popover');

const emptyFilters = () => Object.fromEntries(SCOPE_KEYS.map((scope) => [scope, []]));
const state = { q: '', scope: 'documents', page: 1, sort: 'relevance', filters: emptyFilters(), year: '' };
let runToken = 0;
let current = { query: null, highlightQuery: null, hits: [] };

// --- The search bar -----------------------------------------------------------------------

const editor = createEditor($('#editor'), {
  placeholderText: 'Search for words, names, places, events… or press + for all options',
  completionSource,
  onSubmit: () => submit(),
  onChange: (text, history) => {
    $('#tool-undo').disabled = !history.canUndo;
    $('#tool-redo').disabled = !history.canRedo;
    renderFeedback(text);
  },
  onPillClick: (detail) => openPillMenu(detail),
});

const quote = (value) => (/[\s()"]/.test(value) ? `"${String(value).replace(/"/g, '')}"` : value);

// The query text for a facet value or filter: a token when it has an id, `field:value` otherwise.
function chipText(chip) {
  if (chip.fieldKey === 'year') return `year:${chip.value}`;
  if (chip.id !== undefined && chip.id !== null && chip.id !== '') return encodeToken(chip.fieldKey, String(chip.id), chip.value);
  return `${chip.fieldKey}:${quote(chip.value)}`;
}

function submit() {
  state.q = editor.getText().trim();
  state.page = 1;
  editor.closeCompletion();
  runSearch();
}

function addToQuery(chip, { scope } = {}) {
  const text = editor.getText().trim();
  // AND binds tighter than OR: "a OR b" + c must become "(a OR b) c", not "a OR (b c)".
  const existing = parse(text)?.t === 'or' ? `(${text})` : text;
  editor.setText(existing ? `${existing} ${chipText(chip)}` : chipText(chip));
  if (scope && SCOPES[scope]) state.scope = scope;
  submit();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderFeedback(text) {
  const tree = parse(text);
  const sentence = readBack(tree);
  readbackEl.hidden = !sentence;
  readbackEl.textContent = sentence;
  const problems = diagnose(text);
  diagnosticsEl.hidden = !problems.length;
  diagnosticsEl.innerHTML = problems.map((item) => `<li class="is-${item.level}">${escapeHtml(item.text)}</li>`).join('');
}

$('#tool-search').addEventListener('click', submit);
$('#tool-undo').addEventListener('click', () => editor.undo());
$('#tool-redo').addEventListener('click', () => editor.redo());
$('#tool-clear').addEventListener('click', () => {
  editor.clear();
  state.q = '';
  state.filters = emptyFilters();
  state.year = '';
  state.scope = 'documents';
  runSearch();
  editor.focus();
});

// --- The + menu ---------------------------------------------------------------------------

const insertAttrs = (text, cursor = text.length, complete = false, raw = false) => `data-insert="${escapeHtml(text)}" data-cursor="${cursor}"${complete ? ' data-complete="true"' : ''}${raw ? ' data-raw="true"' : ''}`;

// What you can search for, per kind of thing. Each thing can have properties; when the indexes
// get new properties (e.g. place type, ship type), they are added to its list and appear here.
const THINGS = [
  {
    key: 'document', label: 'Document', specific: null, any: null,
    note: 'Search on the properties of documents:',
    properties: ['title', 'year', 'documenttype', 'archive', 'inventory', 'settlement'],
  },
  { key: 'person', label: 'Person', specific: 'person', any: 'person', properties: ['profession', 'status', 'identity', 'role'] },
  { key: 'place', label: 'Place', specific: 'place', any: 'place', properties: [] },
  { key: 'ship', label: 'Ship', specific: 'ship', any: 'ship', properties: [] },
  { key: 'organisation', label: 'Organisation', specific: 'organisation', any: 'organisation', properties: [], note: 'Includes polities. Rulerships are not in the index yet.' },
  { key: 'annotation', label: 'Event', specific: 'event', any: 'event', properties: [] },
  { key: 'concept', label: 'Concept (thesaurus)', specific: 'concept', any: null, properties: [], note: 'Includes its narrower concepts.' },
];

function thingHtml(thing) {
  const buttons = [
    thing.specific ? `<button type="button" ${insertAttrs(`${thing.specific}:`, undefined, true)} title="Pick a specific one from the suggestions, or type text">${thing.specific}:…</button>` : '',
    thing.any ? `<button type="button" ${insertAttrs(`${thing.any}:* `)} title="Any ${escapeHtml(thing.label.toLowerCase())}">${thing.any}:*</button>` : '',
  ].join('');
  const properties = thing.properties.map((key) => {
    const def = FIELD_BY_KEY.get(key);
    return `<button type="button" class="menu-property" ${insertAttrs(`${key}:`, undefined, true)} title="${escapeHtml(def.hint)}">${escapeHtml(def.label.toLowerCase())} <code>${key}:</code></button>`;
  }).join('');
  return `<div class="menu-thing">
    <div class="menu-thing-head"><span class="menu-swatch" data-field="${thing.key}"></span><strong>${escapeHtml(thing.label)}</strong>${buttons ? `<span class="menu-buttons">${buttons}</span>` : ''}</div>
    ${thing.note ? `<p class="menu-note">${escapeHtml(thing.note)}</p>` : ''}
    ${properties ? `<div class="menu-properties">${thing.key === 'document' ? '' : '<span class="menu-by">by</span>'}${properties}</div>` : ''}
  </div>`;
}

function plusMenuHtml() {
  const regions = Object.entries(REGIONS).map(([key, region]) => `<button type="button" ${insertAttrs(`${key}:()`, key.length + 2)} title="Only in ${escapeHtml(region.label)}">${key}:( … )</button>`).join('');
  return `
    <div class="menu-section">
      <h3>Things</h3>
      <p class="menu-note"><code>person:…</code> picks a specific person from the suggestions; typed without picking (<code>person:adriaan</code>) it finds every person containing that text. <code>person:*</code> means any person.</p>
      ${THINGS.map(thingHtml).join('')}
    </div>
    <div class="menu-section">
      <h3>Where in the text</h3>
      <p class="menu-note">Applies to the part in brackets. Without a region: the whole document. <em>Not in the index yet: searched in the whole document.</em></p>
      <div class="menu-buttons">${regions}</div>
    </div>
    <div class="menu-section">
      <h3>Combine</h3>
      <p class="menu-note">Terms next to each other must all occur (AND).</p>
      <div class="menu-buttons">
        <button type="button" ${insertAttrs('AND ')}>AND</button>
        <button type="button" ${insertAttrs('OR ')}>OR</button>
        <button type="button" ${insertAttrs('NOT ')}>NOT</button>
        <button type="button" ${insertAttrs('()', 1)}>( … )</button>
        <button type="button" ${insertAttrs('( )~5', 1)} title="Everything inside the brackets within 5 words of each other">within 5 words ( … )~5</button>
        <button type="button" ${insertAttrs('NOT IN place:* ')} title="e.g. batavia NOT IN place:* finds Batavia when it is not tagged as a place (a ship, a person's name)">not as a place: … NOT IN place:*</button>
      </div>
    </div>
    <div class="menu-section">
      <h3>Words</h3>
      <div class="menu-buttons">
        <button type="button" ${insertAttrs('""', 1)}>"exact phrase"</button>
        <button type="button" ${insertAttrs('*', 1, false, true)} title="Any letters, e.g. slav*">wildcard *</button>
        <button type="button" ${insertAttrs('~1', 2, false, true)} title="One letter may differ, e.g. timmerman~1">fuzzy ~1</button>
      </div>
    </div>
    <div class="menu-section">
      <h3>Example</h3>
      <button type="button" class="menu-example" data-example-text="(place:Batavia event:Payment)~5 year:1680-1690">(place:Batavia event:Payment)~5 year:1680-1690</button>
    </div>`;
}

function togglePlusMenu(open = plusMenu.hidden) {
  plusMenu.hidden = !open;
  plusButton.setAttribute('aria-expanded', String(open));
  if (open && !plusMenu.innerHTML) plusMenu.innerHTML = plusMenuHtml();
}

plusButton.addEventListener('click', () => togglePlusMenu());
plusMenu.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault(); // keep the cursor in the editor
});
plusMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-insert]');
  if (button) {
    editor.insert(button.dataset.insert, { cursor: Number(button.dataset.cursor), complete: button.dataset.complete === 'true', raw: button.dataset.raw === 'true' });
    togglePlusMenu(false);
    return;
  }
  const example = event.target.closest('[data-example-text]');
  if (example) {
    editor.setText(example.dataset.exampleText);
    togglePlusMenu(false);
    submit();
  }
});

// --- Pill options -------------------------------------------------------------------------

let popoverRange = null;

function openPillMenu({ from, to, token, element }) {
  const def = FIELD_BY_KEY.get(token.fieldKey) || { key: token.fieldKey, label: token.fieldKey };
  const tokenText = editor.view.state.sliceDoc(from, to);
  const noun = def.key === 'annotation' ? 'event' : def.label.toLowerCase();
  const options = [
    ANY_FIELDS.includes(def.key) && def.key !== 'annotation'
      ? { label: `Any ${noun} containing “${token.value}”`, text: `${def.key}:${quote(token.value)}`, note: 'not just this record' }
      : null,
    ANY_FIELDS.includes(def.key) ? { label: `Any ${noun}`, text: `${def.key}:*` } : null,
    { label: 'Only in a header', text: `header:(${tokenText})`, note: 'not in the index yet' },
    { label: 'Only in a margin', text: `margin:(${tokenText})`, note: 'not in the index yet' },
    { label: 'Remove', text: '' },
  ].filter(Boolean);
  popover.innerHTML = `
    <p class="pop-head"><span class="pop-kind" data-field="${escapeHtml(def.key)}">${escapeHtml(def.label)}</span> ${escapeHtml(token.value)}</p>
    <p class="pop-id">This specific record: <code>${escapeHtml(token.id)}</code></p>
    <ul>${options.map((option, index) => `<li><button type="button" data-pop="${index}">${escapeHtml(option.label)}${option.note ? ` <span>(${escapeHtml(option.note)})</span>` : ''}</button></li>`).join('')}</ul>`;
  popoverRange = { from, to, options };
  const box = element.getBoundingClientRect();
  popover.style.top = `${window.scrollY + box.bottom + 6}px`;
  popover.style.left = `${Math.max(8, Math.min(window.scrollX + box.left, window.innerWidth - 320))}px`;
  popover.hidden = false;
}

popover.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pop]');
  if (!button || !popoverRange) return;
  const option = popoverRange.options[Number(button.dataset.pop)];
  editor.replace(popoverRange.from, popoverRange.to, option.text);
  popover.hidden = true;
  popoverRange = null;
});

document.addEventListener('mousedown', (event) => {
  if (!popover.hidden && !popover.contains(event.target) && !event.target.closest('.q-pill')) popover.hidden = true;
  if (!plusMenu.hidden && !plusMenu.contains(event.target) && event.target !== plusButton) togglePlusMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    popover.hidden = true;
    togglePlusMenu(false);
  }
});

// --- URL ----------------------------------------------------------------------------------

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  state.q = params.get('q') || '';
  state.scope = SCOPE_KEYS.includes(params.get('scope')) ? params.get('scope') : 'documents';
  state.page = Math.max(1, Number(params.get('page')) || 1);
  state.sort = params.get('sort') || 'relevance';
  state.year = params.get('year') || '';
  state.filters = emptyFilters();
  try {
    const saved = JSON.parse(params.get('filters') || '{}');
    SCOPE_KEYS.forEach((scope) => {
      if (Array.isArray(saved[scope])) state.filters[scope] = saved[scope].filter((chip) => FIELD_BY_KEY.has(chip?.fieldKey));
    });
  } catch (error) {
    // ignore a damaged URL
  }
}

function writeUrl({ replace = false } = {}) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.scope !== 'documents') params.set('scope', state.scope);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.year) params.set('year', state.year);
  const used = Object.fromEntries(Object.entries(state.filters).filter(([, chips]) => chips.length));
  if (Object.keys(used).length) params.set('filters', JSON.stringify(used));
  const url = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

// --- Search -------------------------------------------------------------------------------

const hasSearch = () => Boolean(state.q || state.year || Object.values(state.filters).some((chips) => chips.length));

const yearChips = (scope) => (state.year && FIELD_BY_KEY.get('year').scopes.includes(scope) ? [{ fieldKey: 'year', value: state.year }] : []);
const filtersFor = (scope) => [...yearChips(scope), ...state.filters[scope]];

// Picked persons, ships, organisations and polities have no id in the text yet: find them by
// every spelling their record lists (as the current prototype does for its pills).
const variantCache = new Map();
const VARIANT_INDEX = { person: ['persons', 'titles'], ship: ['ship-objects', 'title'], organisation: ['organisation-objects,polity-objects', 'title'] };

async function resolveVariants(chips) {
  await Promise.all(chips.map(async (chip) => {
    const source = VARIANT_INDEX[chip.fieldKey];
    if (!source || !chip.id) return;
    const key = `${chip.fieldKey}:${chip.id}`;
    if (!variantCache.has(key)) {
      const data = await esSearch(source[0], { size: 1, _source: [source[1]], query: { ids: { values: [chip.id] } } }).catch(() => null);
      variantCache.set(key, splitTitles(data?.hits?.hits?.[0]?._source?.[source[1]]));
    }
    const variants = variantCache.get(key);
    if (variants.length) chip.variants = variants;
  }));
}

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

function searchBody(scope, query, highlightQuery, { size, from = 0, sort = 'relevance' }) {
  const body = { size, from, track_total_hits: true, query };
  if (scope === 'documents') {
    body._source = DOCUMENT_SOURCE;
    body.highlight = documentHighlight(highlightQuery);
  }
  const chosen = (SORTS[scope] || []).find((option) => option.key === sort);
  if (chosen?.sort) body.sort = chosen.sort;
  const aggs = facetAggs(scope);
  if (aggs) body.aggs = aggs;
  return body;
}

async function runSearch({ replace = false } = {}) {
  document.body.dataset.mode = hasSearch() ? 'results' : 'home';
  renderFilterRow();
  renderFeedback(editor.getText());
  writeUrl({ replace });
  const token = ++runToken;
  if (!hasSearch()) return;
  statusEl.textContent = 'Searching…';
  statusEl.classList.remove('is-error');
  sortWrap.hidden = true;
  paginationEl.innerHTML = '';

  // An empty bar with only filters means "everything on this tab, filtered".
  const tree = parse(state.q || '*');
  try {
    const fieldChips = [...collectFieldNodes(tree), ...Object.values(state.filters).flat()];
    await Promise.all([resolveChips(fieldChips), resolveVariants(fieldChips)]);
    const highlightQuery = buildHighlightQuery(tree, state.filters.documents);
    // Tab counts: the query (and the date) only. The active tab also gets its own facet filters.
    const queries = Object.fromEntries(SCOPE_KEYS.map((scope) => [scope, buildQuery(tree, scope === state.scope ? filtersFor(scope) : yearChips(scope), scope)]));
    const searches = SCOPE_KEYS.filter((scope) => queries[scope]).map((scope) => ({
      scope,
      index: SCOPES[scope].index,
      body: scope === state.scope
        ? searchBody(scope, queries[scope], highlightQuery, { size: PAGE_SIZE, from: (state.page - 1) * PAGE_SIZE, sort: state.sort })
        : { size: 0, track_total_hits: true, query: queries[scope] },
    }));
    const responses = await esMsearch(searches);
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

function unavailableReason(scope) {
  const tree = parse(state.q);
  const text = JSON.stringify(tree || {});
  const problem = positionalProblem(tree);
  if (problem) return `${problem} has no position in the text, so it can't be used in ( … )~N or with NOT IN.`;
  if (/"t":"region"/.test(text)) return `Text regions only exist in documents, so this search can't be applied to ${SCOPES[scope].label.toLowerCase()}.`;
  if (/"t":"prox"/.test(text) || /"negate":true/.test(text)) return `Proximity and NOT IN need running text, which only documents have.`;
  return `Part of this search doesn't apply to ${SCOPES[scope].label.toLowerCase()}.`;
}

function renderTabs(byScope, queries) {
  tabsEl.innerHTML = SCOPE_KEYS.map((scope) => {
    const selected = state.scope === scope;
    if (!queries[scope]) {
      return `<button type="button" role="tab" class="scope-tab is-unavailable" data-scope="${scope}" aria-selected="${selected}" title="${escapeHtml(unavailableReason(scope))}">${SCOPES[scope].label}<span class="scope-count">–</span></button>`;
    }
    const count = byScope[scope]?.error ? '!' : formatCount(countOf(byScope[scope]));
    const filtered = state.filters[scope].length ? ' <span class="scope-filtered" title="This tab has its own filters">●</span>' : '';
    return `<button type="button" role="tab" class="scope-tab" data-scope="${scope}" aria-selected="${selected}">${SCOPES[scope].label}<span class="scope-count">${count}</span>${filtered}</button>`;
  }).join('');
}

async function cardsFor(scope, hits, tree) {
  if (scope === 'documents') return hits.map((hit, index) => documentCard(hit, index, FRAGMENT_CAP)).join('');
  const terms = plainTerms(tree, []);
  if (scope === 'persons') {
    const ids = hits.flatMap((hit) => personIds(hit._source));
    const relations = hits.flatMap((hit) => hit._source.relations || []);
    const [labelOf, nameOf] = await Promise.all([conceptLabelsEn(ids), personLabels(relations)]);
    return hits.map((hit) => personCard(hit, terms, labelOf, nameOf)).join('');
  }
  if (scope === 'concepts') {
    const usage = await conceptUsage(hits.map((hit) => hit._id)).catch(() => []);
    const labelOf = await conceptLabelsEn(usage.flatMap((item) => item.path.split('|')));
    const byId = new Map(usage.map((item) => [item.id, item]));
    return hits.map((hit) => objectCard(hit, scope, terms, byId.get(hit._id), labelOf)).join('');
  }
  return hits.map((hit) => objectCard(hit, scope, terms)).join('');
}

async function renderOutcome(byScope, queries, tree, highlightQuery, token) {
  renderTabs(byScope, queries);
  const scope = state.scope;
  const response = byScope[scope];
  if (!queries[scope] || !response) {
    facetsEl.hidden = true;
    facetsEl.innerHTML = '';
    resultsEl.innerHTML = `<div class="empty-state">${escapeHtml(unavailableReason(scope))} Pick another tab above.</div>`;
    statusEl.textContent = '';
    return;
  }
  if (response.error) {
    facetsEl.hidden = true;
    facetsEl.innerHTML = '';
    resultsEl.innerHTML = '<div class="empty-state">Elasticsearch could not run this query. Check the messages under the search bar.</div>';
    statusEl.textContent = '';
    console.error(response.error);
    return;
  }
  const total = countOf(response);
  const hits = response.hits.hits;
  const html = await cardsFor(scope, hits, tree);
  const facetsHtml = await buildFacets(scope, response.aggregations, total);
  if (token !== runToken) return;

  facetsEl.innerHTML = facetsHtml;
  facetsEl.hidden = !facetsHtml;
  decorateFacets();
  const noun = SCOPES[scope].noun || SCOPES[scope].label.toLowerCase();
  resultsEl.innerHTML = html ? `<div class="card-list">${html}</div>` : `<div class="empty-state">No ${noun} match this search.</div>`;
  const from = total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(state.page * PAGE_SIZE, total);
  statusEl.textContent = total ? `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)} ${total === 1 ? SCOPES[scope].singular : noun}` : `No ${noun}`;
  renderSort(scope);
  renderPagination(total);
  current = { query: queries[scope], highlightQuery, hits: scope === 'documents' ? hits : [] };
  afterRender(token);
}

async function buildFacets(scope, aggs, total) {
  if (!aggs) return '';
  if (scope === 'documents') {
    const leaves = [...(aggs.professions?.buckets || []), ...(aggs.documentTypes?.buckets || [])].map((bucket) => bucket.key.split('|').pop());
    const labelOf = await conceptLabelsEn(leaves);
    const roots = (aggs.archive?.buckets || []).map(toArchiveNode);
    return documentFacets(aggs, labelOf, roots, state.year, total).replace('<h3>Profession</h3>', '<h3>Occupation</h3>');
  }
  if (scope === 'persons') {
    const ids = [...(aggs.occupations?.buckets || []), ...(aggs.statuses?.buckets || []), ...(aggs.identities?.buckets || [])].map((bucket) => bucket.key.split('|').pop());
    return personFacets(aggs, await conceptLabelsEn(ids), total);
  }
  return '';
}

const toArchiveNode = (bucket) => ({ path: bucket.key, count: bucket.doc_count, label: archiveNodeLabel(bucket) });

// Every facet value gets a second action: add it to the search instead of filtering this tab.
function decorateFacets(root = facetsEl) {
  root.querySelectorAll('[data-add-chip]').forEach((element) => {
    const chip = JSON.parse(element.dataset.addChip);
    if (chip.fieldKey === 'year' || element.dataset.decorated) return;
    element.dataset.decorated = 'true';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'to-query';
    button.textContent = '+';
    button.title = `Add “${chip.value}” to the search (applies to all tabs and can be combined)`;
    button.dataset.toQuery = element.dataset.addChip;
    (element.closest('li') && !element.closest('.tree-row') ? element.closest('li') : element.parentElement).append(button);
  });
}

function renderFilterRow() {
  const scope = state.scope;
  const chips = [
    ...(state.year ? [{ chip: { fieldKey: 'year', value: state.year }, shared: true }] : []),
    ...state.filters[scope].map((chip, index) => ({ chip, index })),
  ];
  filterRow.hidden = !chips.length;
  filterChipsEl.innerHTML = chips.map(({ chip, index, shared }) => {
    const def = FIELD_BY_KEY.get(chip.fieldKey);
    return `<span class="query-chip filter-chip" data-field="${chip.fieldKey}">
      <span class="field-name">${escapeHtml(def.label)}:</span><span>${escapeHtml(chip.value)}</span>
      ${shared ? '<span class="filter-note" title="The date applies to every tab where documents have dates">all tabs</span>' : `<button type="button" class="filter-promote" data-promote="${index}" title="Move to the search bar: applies to all tabs and can be combined">→ search</button>`}
      <button type="button" data-remove-filter="${shared ? 'year' : index}" aria-label="Remove filter">×</button>
    </span>`;
  }).join('');
}

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
  paginationEl.innerHTML = `
    <button type="button" data-page="${state.page - 1}"${state.page <= 1 ? ' disabled' : ''}>Previous</button>
    <span class="page-indicator">Page ${formatCount(state.page)} of ${formatCount(lastPage)}</span>
    <button type="button" data-page="${state.page + 1}"${state.page >= lastPage ? ' disabled' : ''}>Next</button>`;
}

// --- Cards: thumbnails, counts, "show more", reader (as in ../app.js) ----------------------

function afterRender(token) {
  if (!current.hits.length) return;
  fillThumbnails(current.hits);
  nameAnnotations(resultsEl).catch(() => {});
  fillDocTypes(resultsEl).catch(() => {});
  fetchExactCounts(token);
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
  const [placeOf, conceptOf] = await Promise.all([placeLabels(places), conceptLabelsEn(concepts)]);
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
  const labelOf = await conceptLabelsEn(rows.flatMap((row) => JSON.parse(row.dataset.doctypes)));
  rows.forEach((row) => {
    row.innerHTML = JSON.parse(row.dataset.doctypes)
      .filter(labelOf)
      .map((id) => `<button type="button" class="tag" data-field="documenttype" data-add-chip="${escapeHtml(JSON.stringify({ fieldKey: 'documenttype', value: labelOf(id), id }))}">${escapeHtml(labelOf(id))}</button>`)
      .join('');
  });
}

async function fetchExactCounts(token) {
  const { hits, query, highlightQuery } = current;
  const pending = hits
    .map((hit, index) => ({ hit, index }))
    .filter(({ hit }) => (hit.highlight?.annotatedText || []).length === FRAGMENT_CAP && (hit.highlight.annotatedText || []).some((fragment) => countHits(fragment)));
  if (!pending.length) return;
  const singleDocQuery = (id) => ({ bool: { filter: [{ ids: { values: [id] } }], must: [query] } });
  let responses;
  try {
    responses = await esMsearch(pending.map(({ hit }) => ({ index: 'documents', body: { size: 1, _source: false, query: singleDocQuery(hit._id), highlight: documentHighlight(highlightQuery, 0, 0) } })));
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
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const data = await esSearch('documents', {
      size: 1,
      _source: false,
      query: { bool: { filter: [{ ids: { values: [button.dataset.more] } }], must: [current.query] } },
      highlight: documentHighlight(current.highlightQuery, Number(button.dataset.total), 0),
    });
    const fragments = data.hits?.hits?.[0]?.highlight?.annotatedText || [];
    const list = button.parentElement;
    button.before(...fragments.slice(FRAGMENT_CAP).map((fragment) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'result-snippet';
      paragraph.innerHTML = annotatedToHtml(fragment);
      return paragraph;
    }));
    button.remove();
    nameAnnotations(list).catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
  }
}

async function toggleReader(button) {
  const reader = document.getElementById(`reader-${button.dataset.reader}`);
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
      _source: ['annotatedText'],
      query: { bool: { filter: [{ ids: { values: [docId] } }], must: [current.query] } },
      highlight: documentHighlight(current.highlightQuery, 0, 0),
    });
    const hit = data.hits?.hits?.[0];
    const raw = hit?.highlight?.annotatedText?.[0] || hit?._source?.annotatedText || '';
    reader.innerHTML = `
      <div class="legend" role="group" aria-label="Show or hide annotation types">${legendHtml()}</div>
      <p class="muted-note">Click an annotation to add it to the search.</p>
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
    children.innerHTML = buckets.length ? archiveTree(buckets.map(toArchiveNode)) : '';
    if (!buckets.length) button.hidden = true;
    decorateFacets(children);
  } catch (error) {
    children.innerHTML = '<p class="muted-note">Could not load this section.</p>';
    delete children.dataset.loaded;
  }
}

// An annotation in a snippet or the reader, as something to search for.
function annotationChip(span) {
  const text = span.textContent.trim();
  const name = span.dataset.name || text;
  if (span.dataset.place) return { fieldKey: 'place', value: name, id: span.dataset.place };
  if (span.dataset.concept) return { fieldKey: 'role', value: name, id: span.dataset.concept };
  if (span.dataset.ann === 'Person') return { fieldKey: 'person', value: text };
  return { fieldKey: 'annotation', value: span.dataset.ann, id: span.dataset.ann };
}

// --- Clicks -------------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  const target = event.target;

  const toQuery = target.closest('[data-to-query]');
  if (toQuery) {
    addToQuery(JSON.parse(toQuery.dataset.toQuery));
    return;
  }
  const promote = target.closest('[data-promote]');
  if (promote) {
    const [chip] = state.filters[state.scope].splice(Number(promote.dataset.promote), 1);
    addToQuery(chip);
    return;
  }
  const remove = target.closest('[data-remove-filter]');
  if (remove) {
    if (remove.dataset.removeFilter === 'year') state.year = '';
    else state.filters[state.scope].splice(Number(remove.dataset.removeFilter), 1);
    state.page = 1;
    runSearch();
    return;
  }
  const addChip = target.closest('[data-add-chip]');
  if (addChip) {
    const chip = JSON.parse(addChip.dataset.addChip);
    // In the sidebar a value filters this tab. On a card (tags, related records) it is a search.
    if (facetsEl.contains(addChip)) {
      if (chip.fieldKey === 'year') state.year = state.year === chip.value ? '' : chip.value;
      else if (!state.filters[state.scope].some((existing) => existing.fieldKey === chip.fieldKey && existing.value === chip.value)) state.filters[state.scope].push(chip);
      state.page = 1;
      runSearch();
      return;
    }
    if (addChip.dataset.replaceQuery) editor.setText('');
    addToQuery(chip, { scope: addChip.dataset.toScope || 'documents' });
    return;
  }
  const annotation = target.closest('.ann');
  if (annotation) {
    addToQuery(annotationChip(annotation), { scope: 'documents' });
    return;
  }
  const scopeTab = target.closest('.scope-tab');
  if (scopeTab) {
    if (scopeTab.dataset.scope !== state.scope) {
      state.scope = scopeTab.dataset.scope;
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
  const example = target.closest('[data-example-query]');
  if (example) {
    editor.setText(example.dataset.exampleQuery);
    state.filters = emptyFilters();
    state.year = '';
    state.scope = example.dataset.exampleScope || 'documents';
    submit();
  }
});

document.addEventListener('change', (event) => {
  const legend = event.target.closest('[data-legend]');
  if (legend) legend.closest('.reader').querySelector('.reader-text').classList.toggle(`hide-${legend.dataset.legend}`, !legend.checked);
});

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  state.page = 1;
  runSearch();
});

window.addEventListener('popstate', () => {
  readUrl();
  editor.setText(state.q);
  runSearch({ replace: true });
});

// --- Examples -----------------------------------------------------------------------------

const EXAMPLES = [
  { want: 'Hendrick Swaardecroon OR Batavia, as picked records (pills)', q: `${encodeToken('person', 'Person_26454', 'Hendrick Swaardecroon')} OR ${encodeToken('place', 'GLOB2_894', 'Batavia')}` },
  { want: 'Payments near Batavia, 1680-1690', q: '(place:Batavia event:Payment)~5 year:1680-1690' },
  { want: 'Any person containing “adriaan” (annotations and records)', q: 'person:adriaan' },
  { want: '“batavia”, but not as a place (e.g. a ship called Batavia)', q: 'batavia NOT IN place:*' },
  { want: 'Any ship, together with pepper', q: 'ship:* peper' },
  { want: 'Slaves near a place matching *javaans*', q: '(slav* place:*javaans*)~5' },
  { want: 'All military occupations (includes the narrower ones)', q: encodeToken('profession', 'e0c5801f-60f4-4a54-bd3b-9f40a8f78e3e', 'Military occupations'), scope: 'persons' },
  { want: 'Text regions: missive in a header, slaves in a margin, koopman anywhere', q: 'header:(missive) margin:(slav*) koopman' },
  { want: 'A legal term from the South Asia Glossary (not tagged in the texts yet)', q: 'concept:binna', scope: 'concepts' },
];

function renderExamples() {
  $('#examples').innerHTML = EXAMPLES.map((example) => {
    const shown = example.q.replace(/@\{([^|}]+)\|[^|}]+\|([^}]+)\}/g, (m, field, label) => `[${decodeURIComponent(field)}: ${decodeURIComponent(label)}]`);
    return `<button type="button" class="example" data-example-query="${escapeHtml(example.q)}"${example.scope ? ` data-example-scope="${example.scope}"` : ''}>
      <span class="example-want">${escapeHtml(example.want)}</span>
      <code class="example-query">${escapeHtml(shown)}</code>
    </button>`;
  }).join('');
}

// --- Start --------------------------------------------------------------------------------

renderExamples();
readUrl();
editor.setText(state.q);
runSearch({ replace: true });
