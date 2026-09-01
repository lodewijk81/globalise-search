const API_URL = 'https://index.globalise.huygens.knaw.nl/documents/_search';

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
let currentResults = [];

function getSearchParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    q: params.get('q') || 'corea~1',
    page: Number(params.get('page')) || 1,
    sort: params.get('sort') || 'relevance',
  };
}

function updateQueryState(query, page, sort) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
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

async function search(query, page, sortKey = 'relevance') {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    if (statusContainer) statusContainer.textContent = 'Please enter a search query.';
    if (resultsContainer) resultsContainer.innerHTML = '<div class="empty-state">Please enter a search query.</div>';
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  currentQuery = trimmedQuery;
  currentPage = page;
  currentSort = sortKey;
  updateQueryState(trimmedQuery, page, sortKey);

  const from = (page - 1) * pageSize;
  const payload = {
    from,
    size: pageSize,
    query: {
      query_string: {
        query: trimmedQuery,
        default_field: 'text',
        default_operator: 'AND',
      },
    },
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
    await renderResults(sortedResults, totalHits, page, trimmedQuery, currentSort);
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

async function renderResults(results, totalHits, page, query, sortKey) {
  const totalPages = Math.max(1, Math.ceil(totalHits / pageSize));
  const startIndex = totalHits === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalHits);

  const sortLabel = sortKey === 'inventory' ? 'inventory number' : sortKey === 'year' ? 'year' : 'relevance';

  if (statusContainer) {
    statusContainer.textContent = totalHits
      ? `Showing ${startIndex}-${endIndex} of ${totalHits} results for “${escapeHtml(query)}” sorted by ${sortLabel}.`
      : `No results found for “${escapeHtml(query)}”.`;
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
  renderPagination(page, totalPages, query, sortKey);
}

function renderPagination(page, totalPages, query, sortKey) {
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
          search(query, targetPage, sortKey);
        }
      });
    });
  }
}

function initLandingPage() {
  if (!landingForm) return;

  landingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector('#landing-search-input');
    const query = (input?.value || '').trim();
    if (!query) return;
    window.location.href = `results.html?q=${encodeURIComponent(query)}`;
  });
}

function initResultsPage() {
  if (!resultsForm || !statusContainer || !resultsContainer || !paginationContainer) return;

  const { q, page, sort } = getSearchParams();
  currentQuery = q;
  currentPage = page;
  currentSort = sort || 'relevance';

  const input = document.querySelector('#results-search-input');
  if (input) input.value = q;
  if (sortSelect) sortSelect.value = currentSort;

  resultsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextQuery = (input?.value || '').trim();
    if (!nextQuery) return;
    search(nextQuery, 1, currentSort);
  });

  if (sortSelect) {
    sortSelect.addEventListener('change', (event) => {
      const nextSort = event.target.value;
      search(currentQuery, 1, nextSort);
    });
  }

  search(q, page, currentSort);
}

if (pageType === 'landing') {
  initLandingPage();
} else {
  initResultsPage();
}
