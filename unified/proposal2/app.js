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

import '../proposal/setup.js';
import { FIELD_BY_KEY, FRAGMENT_CAP, MAX_RESULT_WINDOW, PAGE_SIZE, SCOPES, SCOPE_KEYS, SORTS } from '../config.js';
import {
  archiveNodeLabel, conceptUsage, countOf, esMsearch, esSearch, facetAggs, fetchArchiveChildren,
  inventoryManifest, personLabels, placeLabels, resolveChips, splitTitles, viewerUrl,
} from '../api.js';
import {
  annotatedToHtml, archiveTree, countHits, documentCard, documentFacets, escapeHtml, formatCount, legendHtml, objectCard,
  personCard, personFacets, personIds,
} from '../render.js';
import { buildHighlightQuery, buildQuery, collectFieldNodes, diagnose, encodeToken, parse, plainTerms, positionalProblem, readBack, REGIONS } from '../proposal/query.js';
import { createEditor } from '../proposal/editor.js';
import { conceptLabelsEn } from '../proposal/labels.js';
import { ANY_FIELDS, completionSource } from '../proposal/suggest.js';
import { conceptCard, conceptCardIds, narrowerConcepts } from '../proposal/conceptcard.js';
import { activeVariants, compactQuery, expandTree, fetchExpansions, lexicalTerms, msearchBatched, offKey, QueryTooLargeError } from './expansion.js';
import { documentScans, fractions, hitQuery, locate, positionsBody, scanNumber, scanThumbnail, snippetText } from './scans.js';

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
const expansionEl = $('#expansion');

const emptyFilters = () => Object.fromEntries(SCOPE_KEYS.map((scope) => [scope, []]));
// `expand`: query expansion on or off. `expandOff`: the variants the user unticked (see expansion.js).
const state = { q: '', scope: 'documents', page: 1, sort: 'relevance', filters: emptyFilters(), year: '', expand: true, expandOff: new Set() };
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
  state.expandOff = new Set();
  runSearch();
  editor.focus();
});

// --- The + menu ---------------------------------------------------------------------------
//
// Version 2: the structural terms are split in two.
//   1. Which documents: properties of the document itself (type, period, archive, …). These only
//      narrow down documents; the other tabs can't use them.
//   2. What's in them, and the reference data: persons, places, ships, … Each can be searched as a
//      mention in the documents (Documents tab) or as a record in the reference data (its own tab).
//      It is the same query text either way; the option only picks the tab you land on.

const insertAttrs = (text, cursor = text.length, complete = false, raw = false, scope = '') => `data-insert="${escapeHtml(text)}" data-cursor="${cursor}"${complete ? ' data-complete="true"' : ''}${raw ? ' data-raw="true"' : ''}${scope ? ` data-scope="${scope}"` : ''}`;

// One option: a plain-language label, the text it inserts, and the tab it opens.
// `field` gives the colour; `cursor` places the cursor inside the inserted text.
const opt = (label, text, { field = '', hint = '', scope = 'documents', complete, cursor } = {}) => ({
  label, text, field, hint, scope, complete: complete ?? /:$/.test(text), cursor,
});

const DOCUMENT_OPTIONS = [
  {
    label: 'A specific document',
    options: [
      opt('by words in its title', 'title:', { field: 'title', hint: 'Words in the title of the document', complete: false }),
      opt('by inventory number', 'inventory:', { field: 'inventory', hint: 'Inventory number, or e.g. 11* for a range' }),
    ],
  },
  {
    label: 'Of a type',
    options: [opt('document type', 'documenttype:', { field: 'documenttype', hint: 'e.g. brief, resolutie; includes narrower types' })],
  },
  {
    label: 'From a period',
    options: [opt('year or years', 'year:', { field: 'year', hint: 'e.g. year:1685 or year:1680-1690', complete: false })],
  },
  {
    label: 'From a part of the archive',
    options: [
      opt('archive series', 'archive:', { field: 'archive', hint: 'A series or section of the archive' }),
      opt('settlement', 'settlement:', { field: 'settlement', hint: 'The settlement the document belongs to, e.g. Batavia, Goede Hoop' }),
    ],
  },
  {
    label: 'Only in a part of each document',
    note: 'Wraps the terms in brackets. Not in the index yet: searched in the whole document.',
    options: Object.entries(REGIONS).map(([key, region]) => opt(`in ${region.label}`, `${key}:()`, { cursor: key.length + 2, hint: `Only in ${region.label}`, complete: false, field: '' })).map((option) => ({ ...option, code: `${option.text.slice(0, -1)} … )` })),
  },
];

// One row per thing. The options find mentions in the documents; on the thing's own tab the same
// query shows the records in the reference data.
const CONTENT_THINGS = [
  {
    key: 'person', label: 'Persons',
    options: [
      opt('a specific person', 'person:', { field: 'person', hint: 'Pick a person: found by every recorded spelling. Typed without picking: any person whose name contains the text' }),
      opt('any person', 'person:* ', { field: 'person', hint: 'Any word tagged as a person', complete: false }),
      opt('role', 'role:', { field: 'role', hint: 'A role tagged at that spot in the text, e.g. koopman. Documents only' }),
      opt('occupation', 'profession:', { field: 'profession', hint: 'An occupation or a whole group of them' }),
      opt('status', 'status:', { field: 'status', hint: 'In documents: specific statuses only (weduwe, gevangene, …); broader ones are not tagged' }),
      opt('appellation', 'identity:', { field: 'identity', hint: 'Ethno-religious appellation. In documents: specific ones only (Chinees, …)' }),
    ],
  },
  {
    key: 'place', label: 'Places',
    options: [opt('a specific place', 'place:', { field: 'place' }), opt('any place', 'place:* ', { field: 'place', complete: false })],
  },
  {
    key: 'ship', label: 'Ships',
    options: [opt('a specific ship', 'ship:', { field: 'ship' }), opt('any ship or object', 'ship:* ', { field: 'ship', complete: false })],
  },
  {
    key: 'organisation', label: 'Organisations', note: 'incl. polities',
    options: [opt('a specific organisation', 'organisation:', { field: 'organisation' }), opt('any group', 'organisation:* ', { field: 'organisation', complete: false })],
  },
  {
    key: 'annotation', label: 'Events', note: 'tags in the text only',
    options: [opt('an event type', 'event:', { field: 'annotation', hint: 'e.g. Payment, Voyage, Attack' }), opt('any event', 'event:* ', { field: 'annotation', complete: false })],
  },
  {
    key: 'concept', label: 'Concepts',
    options: [opt('a thesaurus concept', 'concept:', { field: 'concept', hint: 'Wherever it is used. Includes its narrower concepts' })],
  },
];

// These don't pick a tab: they keep whichever one you are on (Documents by default).
CONTENT_THINGS.forEach((thing) => thing.options.forEach((option) => { option.scope = ''; }));

const TAB_LABEL = (scope) => SCOPES[scope]?.label || scope;

function optionHtml(option) {
  const code = option.code || option.text.trim();
  const title = [option.hint, option.scope && `Opens the ${TAB_LABEL(option.scope)} tab`].filter(Boolean).join('. ');
  return `<button type="button" class="menu-option"${option.field ? ` data-field="${option.field}"` : ''} ${insertAttrs(option.text, option.cursor ?? option.text.length, option.complete, false, option.scope)} title="${escapeHtml(title)}">${escapeHtml(option.label)} <code>${escapeHtml(code)}</code></button>`;
}

function documentBlockHtml() {
  return `<div class="menu-block menu-block-documents">
    <h3><span class="menu-step">1</span> Which documents</h3>
    <p class="menu-note">The documents themselves. These narrow down <strong>documents</strong> only; persons, places and the other records can't be searched by them.</p>
    ${DOCUMENT_OPTIONS.map((row) => `<div class="menu-row">
      <span class="menu-row-label">${escapeHtml(row.label)}</span>
      <span class="menu-row-options">${row.options.map(optionHtml).join('')}</span>
      ${row.note ? `<p class="menu-note menu-row-note">${escapeHtml(row.note)}</p>` : ''}
    </div>`).join('')}
  </div>`;
}

function contentBlockHtml() {
  const rows = CONTENT_THINGS.map((thing) => `<div class="menu-row">
    <span class="menu-row-label"><span class="menu-swatch" data-field="${thing.key}"></span>${escapeHtml(thing.label)}${thing.note ? ` <span class="menu-hint">${escapeHtml(thing.note)}</span>` : ''}</span>
    <span class="menu-row-options">${thing.options.map(optionHtml).join('')}</span>
  </div>`).join('');
  return `<div class="menu-block menu-block-content">
    <h3><span class="menu-step">2</span> What's in them, and the reference data</h3>
    <p class="menu-note">Each term finds <strong>mentions in the documents</strong>. The same query also finds the <strong>records</strong> in the reference data, on their own tab.</p>
    ${rows}
    <p class="menu-note menu-pick-note">Words in the text: just type them. <code>person:…</code> picks a specific record from the suggestions; typed without picking (<code>person:adriaan</code>) it finds every person containing that text. <code>person:*</code> means any person.</p>
  </div>`;
}

function plusMenuHtml() {
  return `
    <div class="menu-section menu-structure">
      ${documentBlockHtml()}
      ${contentBlockHtml()}
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
    </div>`;
}

function togglePlusMenu(open = plusMenu.hidden) {
  plusMenu.hidden = !open;
  plusButton.setAttribute('aria-expanded', String(open));
  if (open && !plusMenu.innerHTML) plusMenu.innerHTML = plusMenuHtml();
}

// Picking an option also picks the tab the next search opens on. When results are showing, the
// tab is marked straight away, so it is clear where you will land.
function selectScope(scope) {
  if (!SCOPES[scope] || !SCOPE_KEYS.includes(scope)) return;
  if (state.scope !== scope) state.page = 1;
  state.scope = scope;
  tabsEl.querySelectorAll('[data-scope]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.scope === scope)));
}

plusButton.addEventListener('click', () => togglePlusMenu());
plusMenu.addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault(); // keep the cursor in the editor
});
plusMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-insert]');
  if (button) {
    if (button.dataset.scope) selectScope(button.dataset.scope);
    editor.insert(button.dataset.insert, { cursor: Number(button.dataset.cursor), complete: button.dataset.complete === 'true', raw: button.dataset.raw === 'true' });
    togglePlusMenu(false);
    return;
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
  state.expand = params.get('expand') !== 'off';
  try {
    const off = JSON.parse(params.get('expandoff') || '[]');
    state.expandOff = new Set(Array.isArray(off) ? off.filter((key) => typeof key === 'string') : []);
  } catch (error) {
    state.expandOff = new Set();
  }
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
  if (!state.expand) params.set('expand', 'off');
  if (state.expand && state.expandOff.size) params.set('expandoff', JSON.stringify([...state.expandOff]));
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
  if (aggs && scope === 'documents') delete aggs.professions; // not shown on the documents tab
  if (aggs) body.aggs = aggs;
  return body;
}

async function runSearch({ replace = false } = {}) {
  document.body.dataset.mode = hasSearch() ? 'results' : 'home';
  renderFilterRow();
  renderFeedback(editor.getText());
  writeUrl({ replace });
  const token = ++runToken;
  if (!hasSearch()) {
    expansionEl.hidden = true;
    return;
  }
  statusEl.textContent = 'Searching…';
  statusEl.classList.remove('is-error');
  sortWrap.hidden = true;
  paginationEl.innerHTML = '';

  // An empty bar with only filters means "everything on this tab, filtered".
  const typed = parse(state.q || '*');
  try {
    const fieldChips = [...collectFieldNodes(typed), ...Object.values(state.filters).flat()];
    const terms = lexicalTerms(typed);
    const [expansions] = await Promise.all([
      state.expand && terms.length ? fetchExpansions(terms) : { byKey: {}, failed: false },
      resolveChips(fieldChips),
      resolveVariants(fieldChips),
    ]);
    if (token !== runToken) return;
    renderExpansion(terms, expansions);
    // The tree that is searched: every lexical term OR its variants that are ticked.
    // Only in documents: the variants are spellings found in the transcriptions, while the other
    // tabs search the (curated) names of records. It also keeps those queries small.
    const expanded = state.expand ? expandTree(typed, expansions.byKey, state.expandOff) : typed;
    const treeFor = (scope) => (scope === 'documents' ? expanded : typed);
    const highlightQuery = compactQuery(buildHighlightQuery(expanded, state.filters.documents));
    // Tab counts: the query (and the date) only. The active tab also gets its own facet filters.
    const queries = Object.fromEntries(SCOPE_KEYS.map((scope) => [scope, compactQuery(buildQuery(treeFor(scope), scope === state.scope ? filtersFor(scope) : yearChips(scope), scope))]));
    const searches = SCOPE_KEYS.filter((scope) => queries[scope]).map((scope) => ({
      scope,
      index: SCOPES[scope].index,
      body: scope === state.scope
        ? searchBody(scope, queries[scope], highlightQuery, { size: PAGE_SIZE, from: (state.page - 1) * PAGE_SIZE, sort: state.sort })
        : { size: 0, track_total_hits: true, query: queries[scope] },
    }));
    const responses = await msearchBatched(esMsearch, searches);
    if (token !== runToken) return;
    const byScope = {};
    searches.forEach((search, index) => {
      byScope[search.scope] = responses[index];
    });
    await renderOutcome(byScope, queries, treeFor(state.scope), highlightQuery, token);
  } catch (error) {
    if (token !== runToken) return;
    console.error(error);
    statusEl.textContent = error instanceof QueryTooLargeError
      ? 'This search is too long for the server. Untick some expanded variants under the search bar, or switch off Expand words.'
      : 'The search could not be completed. Please try again.';
    statusEl.classList.add('is-error');
    resultsEl.innerHTML = '';
    facetsEl.innerHTML = '';
  }
}

// --- Query expansion ----------------------------------------------------------------------
//
// Under the bar: which words were expanded and with what. Every variant can be unticked, per
// variant, per method (source) or per word. Changes search again at once.

let lastExpansion = { terms: [], byKey: {} };
let expansionOpen = false;

const checkedState = (count, total) => (count === 0 ? 'none' : count === total ? 'all' : 'some');

function variantsChecked(key, source) {
  return source.expansions.filter((variant) => !state.expandOff.has(offKey(key, source.id, variant))).length;
}

function checkbox(attrs, status, label, count) {
  return `<label class="x-check"><input type="checkbox" ${attrs}${status === 'all' ? ' checked' : ''}${status === 'some' ? ' data-indeterminate="true"' : ''} />${label}${count === undefined ? '' : ` <span class="x-count">${formatCount(count)}</span>`}</label>`;
}

function renderExpansion(terms, { byKey, failed }) {
  lastExpansion = { terms, byKey };
  const expanded = terms.filter((term) => byKey[term.key]);
  if (!terms.length) {
    expansionEl.hidden = true;
    expansionEl.innerHTML = '';
    return;
  }
  const toggle = `<label class="x-switch" title="Spelling variants and synonyms from kweepeer.globalise.nl, for the words you typed, searched in the text of documents. Fields, wildcards and fuzzy words are not expanded; other tabs search names as typed."><input type="checkbox" data-x-switch ${state.expand ? 'checked' : ''} /> Expand words</label>`;
  let summary;
  if (!state.expand) summary = '<span class="x-summary-text">Off: only the words as typed are searched.</span>';
  else if (!expanded.length) summary = `<span class="x-summary-text">${failed ? 'The expansion service could not be reached; the words are searched as typed.' : 'No variants found for these words.'}</span>`;
  else {
    const parts = expanded.map((term) => {
      const active = activeVariants(term.key, byKey, state.expandOff).length;
      return `<strong>${escapeHtml(term.text)}</strong> <span class="x-count">+${formatCount(active)}</span>`;
    }).join(', ');
    summary = `<span class="x-summary-text">In documents, also searching variants of ${parts}${failed ? ' <span class="x-warn">(some words could not be expanded)</span>' : ''}</span>`;
  }
  const details = state.expand && expanded.length ? expanded.map((term) => {
    const entry = byKey[term.key];
    // Counted once each, also when several methods suggest the same variant.
    const total = new Set(entry.sources.flatMap((source) => source.expansions.map((variant) => variant.toLowerCase()))).size;
    const checked = activeVariants(term.key, byKey, state.expandOff).length;
    const sources = entry.sources.map((source) => {
      const on = variantsChecked(term.key, source);
      const variants = source.expansions.map((variant) => `<li>${checkbox(`data-x-term="${escapeHtml(term.key)}" data-x-source="${escapeHtml(source.id)}" data-x-variant="${escapeHtml(variant)}"`, state.expandOff.has(offKey(term.key, source.id, variant)) ? 'none' : 'all', escapeHtml(variant))}</li>`).join('');
      return `<div class="x-source">
        ${checkbox(`data-x-term="${escapeHtml(term.key)}" data-x-source="${escapeHtml(source.id)}"`, checkedState(on, source.expansions.length), `<span class="x-method">${escapeHtml(source.name)}</span>`, source.expansions.length)}
        <ul class="x-variants">${variants}</ul>
      </div>`;
    }).join('');
    return `<div class="x-term">
      ${checkbox(`data-x-term="${escapeHtml(term.key)}"`, checkedState(checked, total), `<strong>${escapeHtml(term.text)}</strong>`, total)}
      <div class="x-sources">${sources}</div>
    </div>`;
  }).join('') : '';
  expansionEl.innerHTML = `<div class="x-head">${toggle}${summary}${details ? `<button type="button" class="x-more" data-x-open aria-expanded="${expansionOpen}">${expansionOpen ? 'Hide' : 'Show'} variants</button>` : ''}</div>
    ${details ? `<div class="x-body"${expansionOpen ? '' : ' hidden'}>${details}<p class="x-note">From <a href="https://kweepeer.globalise.nl" target="_blank" rel="noopener">kweepeer</a>. Untick what you don't want; the search updates at once.</p></div>` : ''}`;
  expansionEl.querySelectorAll('[data-indeterminate]').forEach((input) => {
    input.indeterminate = true;
  });
  expansionEl.hidden = false;
}

// Turns a set of variants on or off: all on when any is off, otherwise all off.
function setVariants(items) {
  const allOn = items.every(([key, source, variant]) => !state.expandOff.has(offKey(key, source, variant)));
  items.forEach(([key, source, variant]) => {
    const id = offKey(key, source, variant);
    if (allOn) state.expandOff.add(id);
    else state.expandOff.delete(id);
  });
}

expansionEl.addEventListener('click', (event) => {
  const more = event.target.closest('[data-x-open]');
  if (!more) return;
  expansionOpen = !expansionOpen;
  more.setAttribute('aria-expanded', String(expansionOpen));
  more.textContent = `${expansionOpen ? 'Hide' : 'Show'} variants`;
  expansionEl.querySelector('.x-body').hidden = !expansionOpen;
});

expansionEl.addEventListener('change', (event) => {
  const input = event.target;
  if (input.matches('[data-x-switch]')) {
    state.expand = input.checked;
  } else if (input.dataset.xTerm) {
    const { xTerm: key, xSource: sourceId, xVariant: variant } = input.dataset;
    const entry = lastExpansion.byKey[key];
    if (!entry) return;
    // A variant goes on or off under every method that suggested it, so it is really (not) searched.
    const sources = entry.sources.filter((source) => variant !== undefined || !sourceId || source.id === sourceId);
    const items = sources.flatMap((source) => source.expansions
      .filter((value) => variant === undefined || value.toLowerCase() === variant.toLowerCase())
      .map((value) => [key, source.id, value]));
    setVariants(items);
  } else {
    return;
  }
  state.page = 1;
  runSearch();
});

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
  if (scope === 'documents') return hits.map((hit, index) => documentCard(hit, index, FRAGMENT_CAP, { thumb: false, newTab: false })).join('');
  const terms = plainTerms(tree, []);
  if (scope === 'persons') {
    const ids = hits.flatMap((hit) => personIds(hit._source));
    const relations = hits.flatMap((hit) => hit._source.relations || []);
    const [labelOf, nameOf] = await Promise.all([conceptLabelsEn(ids), personLabels(relations)]);
    return hits.map((hit) => personCard(hit, terms, labelOf, nameOf)).join('');
  }
  if (scope === 'concepts') {
    const ids = hits.map((hit) => hit._id);
    const [usage, narrower] = await Promise.all([conceptUsage(ids).catch(() => []), narrowerConcepts(ids)]);
    const labelOf = await conceptLabelsEn(conceptCardIds(hits, narrower));
    const byId = new Map(usage.map((item) => [item.id, item]));
    return hits.map((hit) => conceptCard(hit, terms, byId.get(hit._id), labelOf, narrower.get(hit._id))).join('');
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
    // No occupation facet on documents; document type is shown even when the index has none for
    // these results (a language facet is to follow).
    const leaves = (aggs.documentTypes?.buckets || []).map((bucket) => bucket.key.split('|').pop());
    const labelOf = await conceptLabelsEn(leaves);
    const roots = (aggs.archive?.buckets || []).map(toArchiveNode);
    return documentFacets(aggs, labelOf, roots, state.year, total, {
      professions: false,
      emptyDocTypes: 'None of these documents has a document type in the index yet.',
    });
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

// --- Cards: counts, "show more", reader (as in ../app.js) ----------------------

function afterRender(token) {
  if (!current.hits.length) return;
  prepareSnippets(current.hits);
  nameAnnotations(resultsEl).catch(() => {});
  fillDocTypes(resultsEl).catch(() => {});
  fetchExactCounts(token);
}

// --- Snippets on their scans (see scans.js) ------------------------------------------------
//
// Every snippet gets a thumbnail of the scan it is on and the scan's number; both, and the snippet
// itself, open the viewer at that scan. There is no thumbnail for the document as a whole. A card
// is worked out when it comes near the screen.

const POSITION_BATCH = 6; // fragments per position request (requests must stay small)
const snippetFragments = new WeakMap(); // <p class="result-snippet"> -> raw highlight fragment
let snippetObserver = null;

function prepareSnippets(hits) {
  snippetObserver?.disconnect();
  snippetObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      snippetObserver.unobserve(entry.target);
      locateSnippets(entry.target);
    }), { rootMargin: '400px 0px' })
    : null;
  hits.forEach((hit, index) => {
    const card = resultsEl.querySelector(`.card-document[data-index="${index}"]`);
    if (!card) return;
    const fragments = hit.highlight?.annotatedText || [];
    card.querySelectorAll('.result-snippet:not(.is-empty)').forEach((paragraph, i) => attachSnippet(paragraph, fragments[i]));
    if (snippetObserver) snippetObserver.observe(card);
    else locateSnippets(card);
  });
}

// Wraps a snippet in a row with a thumbnail placeholder (filled in by showScan) and puts the
// scan-number tag in front of the text.
function attachSnippet(paragraph, fragment) {
  if (!fragment) return;
  snippetFragments.set(paragraph, fragment);
  const row = document.createElement('div');
  row.className = 'snippet-row';
  const thumb = document.createElement('a');
  thumb.className = 'snippet-thumb is-pending';
  thumb.setAttribute('aria-hidden', 'true'); // the scan tag is the accessible link
  thumb.tabIndex = -1;
  const label = document.createElement('a');
  label.className = 'scan-tag is-pending';
  label.textContent = 'Scan …';
  paragraph.replaceWith(row);
  paragraph.prepend(label);
  row.append(thumb, paragraph);
}

// Locates the snippets of a card that haven't been yet (or the given ones), in text order, so
// each can start looking from the scan of the one before.
async function locateSnippets(card, paragraphs) {
  const hit = current.hits[Number(card.dataset.index)];
  const todo = (paragraphs || [...card.querySelectorAll('.result-snippet')]).filter((p) => snippetFragments.has(p) && !p.dataset.located);
  if (!hit || !todo.length) return;
  todo.forEach((p) => { p.dataset.located = 'pending'; });
  const fragments = todo.map((p) => snippetFragments.get(p));
  const batches = [];
  for (let i = 0; i < fragments.length; i += POSITION_BATCH) batches.push(fragments.slice(i, i + POSITION_BATCH));
  const [manifest, responses] = await Promise.all([
    inventoryManifest(hit._source.inventoryNumber),
    msearchBatched(esMsearch, batches.map((batch) => ({ index: 'documents', body: positionsBody(hit._id, batch) }))).catch(() => []),
  ]);
  const where = batches.flatMap((batch, i) => fractions(responses[i]?.hits?.hits?.[0]?.fields?.positions, batch.length));
  const scans = documentScans(hit._source, manifest);
  // The words highlighted in all of the card's snippets, for highlighting on the scan.
  const q = hitQuery([...card.querySelectorAll('.result-snippet')].map((p) => snippetFragments.get(p)));
  let hint = null;
  for (const [i, paragraph] of todo.entries()) {
    if (!card.isConnected) return; // a new search replaced the results
    const found = await locate(fragments[i], scans, where[i], hint).catch(() => null);
    if (found) hint = found.position;
    showScan(paragraph, hit._source, manifest, scans, found, { q, snippet: snippetText(fragments[i]) });
  }
}

function showScan(paragraph, doc, manifest, scans, found, highlight) {
  const label = paragraph.querySelector(':scope > .scan-tag');
  const thumb = paragraph.parentElement?.querySelector(':scope > .snippet-thumb');
  paragraph.dataset.located = found ? 'yes' : 'no';
  const url = viewerUrl(doc, found?.scan, highlight);
  paragraph.dataset.viewer = url;
  [label, thumb].forEach((link) => {
    if (!link) return;
    link.href = url;
    link.classList.remove('is-pending');
  });
  if (!found) {
    if (label) {
      label.textContent = 'Scan ?';
      label.title = 'This passage could not be found on a scan here. Opens the document in the viewer, which looks for it.';
    }
    if (thumb) thumb.title = label?.title || '';
    return;
  }
  const title = `${found.scan}: scan ${found.position + 1} of ${scans.length} in this document. Open it in the viewer.`;
  if (label) {
    label.textContent = `Scan ${scanNumber(found.scan)}`;
    label.title = title;
  }
  const src = scanThumbnail(manifest, found.scan, 240);
  if (!thumb || !src) return;
  thumb.title = title;
  const image = document.createElement('img');
  image.src = src;
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove());
  thumb.replaceChildren(image);
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
    responses = await msearchBatched(esMsearch, pending.map(({ hit }) => ({ index: 'documents', body: { size: 1, _source: false, query: singleDocQuery(hit._id), highlight: documentHighlight(highlightQuery, 0, 0) } })));
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
    const card = button.closest('.card-document');
    const added = fragments.slice(FRAGMENT_CAP).map((fragment) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'result-snippet';
      paragraph.innerHTML = annotatedToHtml(fragment);
      return paragraph;
    });
    button.before(...added);
    added.forEach((paragraph, i) => attachSnippet(paragraph, fragments[FRAGMENT_CAP + i])); // once in the page: it wraps them
    button.remove();
    nameAnnotations(list).catch(() => {});
    if (card) locateSnippets(card, added);
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
  // The rest of a snippet opens its scan in the viewer (not when text is being selected).
  const snippet = target.closest('.result-snippet[data-viewer]');
  if (snippet && !target.closest('a, button') && !window.getSelection()?.toString()) {
    window.location.assign(snippet.dataset.viewer);
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
