const API_URL = 'http://localhost:5050/search';

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

// Structured search fields exposed by the "documents" index, selectable via "field:value" in the search bar.
const FIELD_DEFS = [
  { key: 'person', label: 'Person', hint: 'Find persons mentioned in the text', kind: 'nested', type: 'Person' },
  { key: 'place', label: 'Place', hint: 'Find places mentioned in the text', kind: 'nested', type: 'Place', aliases: ['location'] },
  { key: 'profession', label: 'Profession', hint: 'Find by profession', kind: 'text', field: 'professionLabelPaths' },
  { key: 'documenttype', label: 'Document type', hint: 'Find by document type, e.g. brief', kind: 'text', field: 'documentTypeLabelPaths', aliases: ['type', 'doctype'] },
  { key: 'settlement', label: 'Settlement', hint: 'Find by settlement', kind: 'keyword', field: 'settlement' },
  { key: 'inventory', label: 'Inventory number', hint: 'Find by exact inventory number', kind: 'keyword', field: 'inventoryNumber', exact: true, aliases: ['inv', 'invnr'] },
  { key: 'year', label: 'Year', hint: 'e.g. 1685 or 1680-1690', kind: 'year', aliases: ['date'] },
];

const FIELD_BY_KEY = new Map(FIELD_DEFS.map((def) => [def.key, def]));
const FIELD_ALIASES = new Map();
FIELD_DEFS.forEach((def) => {
  FIELD_ALIASES.set(def.key, def.key);
  (def.aliases || []).forEach((alias) => FIELD_ALIASES.set(alias, def.key));
});

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

function encodeChips(chips) {
  return chips.map((chip) => `${chip.fieldKey}:${encodeURIComponent(chip.value)}`).join('|');
}

function decodeChips(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .map((part) => {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex === -1) return null;
      const fieldKey = part.slice(0, separatorIndex);
      const value = decodeURIComponent(part.slice(separatorIndex + 1));
      return FIELD_BY_KEY.has(fieldKey) && value ? { fieldKey, value } : null;
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

// Turns a chip (field:value) into an Elasticsearch query clause against the "documents" index.
function chipToEsClause(chip) {
  const def = FIELD_BY_KEY.get(chip.fieldKey);
  const value = (chip.value || '').trim();
  if (!def || !value) return null;

  if (def.kind === 'nested') {
    return {
      nested: {
        path: 'observances',
        query: {
          bool: {
            filter: [{ term: { 'observances.type': def.type } }],
            must: [
              {
                wildcard: {
                  'observances.label': {
                    value: `*${escapeWildcardValue(value)}*`,
                    case_insensitive: true,
                  },
                },
              },
            ],
          },
        },
      },
    };
  }

  if (def.kind === 'text') {
    return { match: { [def.field]: value } };
  }

  if (def.kind === 'keyword') {
    return def.exact
      ? { term: { [def.field]: value } }
      : { wildcard: { [def.field]: { value: `*${escapeWildcardValue(value)}*`, case_insensitive: true } } };
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

function buildEsQuery(keywordText, chips) {
  const must = [];
  if (keywordText) {
    must.push({
      query_string: {
        query: keywordText,
        default_field: 'text',
        default_operator: 'AND',
      },
    });
  }

  const filter = chips.map(chipToEsClause).filter(Boolean);

  return {
    bool: {
      ...(must.length ? { must } : {}),
      ...(filter.length ? { filter } : {}),
    },
  };
}

function describeChips(chips) {
  if (!chips.length) return '';
  const parts = chips.map((chip) => `${FIELD_BY_KEY.get(chip.fieldKey).label}: “${escapeHtml(chip.value)}”`);
  return ` with ${parts.join(', ')}`;
}

// Interactive "field:value" chip input: lets keyword search be combined with
// structured filters such as person:, place:, profession:, settlement:, inventory: and year:.
function createQueryBuilder({ formEl, chipsEl, inputEl, suggestionsEl }) {
  let chips = [];
  let currentSuggestions = [];

  function renderChips() {
    chipsEl.innerHTML = chips
      .map(
        (chip, index) => `
          <span class="query-chip" data-index="${index}" data-field="${chip.fieldKey}">
            <span class="field-name">${escapeHtml(FIELD_BY_KEY.get(chip.fieldKey).label)}:</span>
            <span>${escapeHtml(chip.value)}</span>
            <button type="button" aria-label="Remove ${escapeHtml(FIELD_BY_KEY.get(chip.fieldKey).label)} filter">×</button>
          </span>
        `
      )
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
    const match = value.match(/(^|\s)([a-zA-Z]+)\s*:\s*("([^"]*)"|(\S*))$/);
    if (!match) return null;
    const fieldKey = FIELD_ALIASES.get(match[2].toLowerCase());
    if (!fieldKey) return null;
    const tokenValue = match[4] !== undefined ? match[4] : match[5] || '';
    return { fieldKey, value: tokenValue, start: match.index + match[1].length, end: value.length };
  }

  function getTrailingWord() {
    const value = inputEl.value;
    const match = value.match(/(^|\s)([a-zA-Z]+)$/);
    if (!match) return null;
    return { word: match[2], start: match.index + match[1].length, end: value.length };
  }

  function commitToken(token, sourceEl) {
    if (!token.value) return false;
    chips.push({ fieldKey: token.fieldKey, value: token.value });
    inputEl.value = `${inputEl.value.slice(0, token.start)}${inputEl.value.slice(token.end)}`.replace(/\s+$/, '');
    renderChips();
    if (sourceEl) animateChipFlight(sourceEl, chips.length - 1);
    hideSuggestions();
    return true;
  }

  function hideSuggestions() {
    currentSuggestions = [];
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = '';
  }

  function showFieldSuggestions(word, start) {
    const lowerWord = word.toLowerCase();
    const matches = FIELD_DEFS.filter((def) => def.key.startsWith(lowerWord));
    if (!word || !matches.length) {
      hideSuggestions();
      return;
    }
    currentSuggestions = matches.map((def) => ({
      apply: () => {
        const cursor = start + def.key.length + 1;
        inputEl.value = `${inputEl.value.slice(0, start)}${def.key}:${inputEl.value.slice(start + word.length)}`;
        inputEl.focus();
        inputEl.setSelectionRange(cursor, cursor);
        updateSuggestions();
      },
      html: `
        <span class="query-chip query-chip-preview" data-field="${def.key}"><span class="field-name">${escapeHtml(def.key)}:</span></span>
        <span class="hint">${escapeHtml(def.hint)}</span>
      `,
    }));
    renderSuggestions();
  }

  function showValueSuggestion(token) {
    const def = FIELD_BY_KEY.get(token.fieldKey);
    if (!token.value) {
      currentSuggestions = [
        {
          apply: null,
          html: `
            <span class="query-chip query-chip-preview" data-field="${token.fieldKey}"><span class="field-name">${escapeHtml(def.label)}:</span></span>
            <span class="hint">${escapeHtml(def.hint)}</span>
          `,
        },
      ];
    } else {
      currentSuggestions = [
        {
          apply: (sourceEl) => commitToken(token, sourceEl),
          html: `
            <span class="query-chip query-chip-preview" data-field="${token.fieldKey}">
              <span class="field-name">${escapeHtml(def.label)}:</span>
              <span>${escapeHtml(token.value)}</span>
            </span>
            <span class="hint">Enter ↵</span>
          `,
        },
      ];
    }
    renderSuggestions();
  }

  function renderSuggestions() {
    if (!currentSuggestions.length) {
      hideSuggestions();
      return;
    }
    suggestionsEl.hidden = false;
    suggestionsEl.innerHTML = currentSuggestions
      .map((item, index) => `<div class="query-suggestion${item.apply ? '' : ' is-static'}" data-index="${index}">${item.html}</div>`)
      .join('');

    suggestionsEl.querySelectorAll('.query-suggestion').forEach((el) => {
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const index = Number(el.dataset.index);
        const previewEl = el.querySelector('.query-chip-preview');
        currentSuggestions[index]?.apply?.(previewEl);
      });
    });
  }

  function updateSuggestions() {
    const token = getTrailingToken();
    if (token) {
      showValueSuggestion(token);
      return;
    }
    const word = getTrailingWord();
    if (word && word.word) {
      showFieldSuggestions(word.word, word.start);
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
      const token = getTrailingToken();
      if (token && token.value) {
        event.preventDefault();
        const previewEl = suggestionsEl.querySelector('.query-chip-preview');
        commitToken(token, previewEl);
      }
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

function buildViewerUrl(result) {
  const documentId = result?.name;
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
  const documentId = result?.name;
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

function getHighlightText(hit) {
  const fragments = hit?.highlight?.text ?? [];
  const snippet = fragments.join(' … ');
  return snippet || 'No snippet available.';
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

  const from = (page - 1) * pageSize;
  const payload = {
    from,
    size: pageSize,
    query: buildEsQuery(trimmedQuery, activeChips),
    highlight: {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        text: { fragment_size: 150, number_of_fragments: 3 },
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
    const results = hits.map((hit) => ({ ...hit._source, highlight: hit.highlight }));
    currentResults = results;
    getSortOptionState(results);

    const sortedResults = sortResults(results, currentSort);
    await renderResults(sortedResults, totalHits, page, trimmedQuery, activeChips, currentSort);
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
    return;
  }

  const listHtml = await Promise.all(
    results.map(async (result) => {
      const documentId = result.name || 'Unknown document';
      const viewerUrl = buildViewerUrl(result);
      const snippet = getHighlightText({ highlight: result.highlight });
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
              <h2 class="result-title"><a href="${viewerUrl}">${escapeHtml(documentId)}</a></h2>
              <small>${year !== null ? `${escapeHtml(year)} · ` : ''}Inventory ${escapeHtml(invNr)} · ${escapeHtml(settlement)}</small>
            </div>
            <p class="result-snippet">${snippet}</p>
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
