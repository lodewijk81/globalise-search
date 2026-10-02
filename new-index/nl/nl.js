// Natural-language search experiment: sends the question to the local server (server.py),
// shows the LLM's structured interpretation as an editable search, and keeps the hit count,
// preview and "open in full search" link in sync with the user's edits.

const form = document.querySelector('#nl-form');
const questionEl = document.querySelector('#nl-question');
const submitEl = document.querySelector('#nl-submit');
const modelEl = document.querySelector('#nl-model');
const statusEl = document.querySelector('#nl-status');
const resultEl = document.querySelector('#nl-result');
const queryEl = document.querySelector('#nl-query');
const totalEl = document.querySelector('#nl-total');
const openEl = document.querySelector('#nl-open');
const previewEl = document.querySelector('#nl-preview');
const traceEl = document.querySelector('#nl-trace');
const usageEl = document.querySelector('#nl-usage');

const COMPILE_DEBOUNCE_MS = 300;
const MODEL_STORAGE_KEY = 'nl-search-model';
const IIIF_BASE = 'https://data.globalise.huygens.knaw.nl/hdl:20.500.14722';

// The editable query: like the server's structured query, but every term carries a
// `checked` flag so switched-off terms stay visible (and can be switched back on).
let state = null;
let termCounts = {};
let compileTimer = null;
let compileToken = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Snippets come back from Elasticsearch with <mark> tags around matches; escape everything
// else so OCR text can never inject markup.
function renderSnippet(raw) {
  return escapeHtml(raw).replace(/&lt;(\/?)mark&gt;/g, '<$1mark>');
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', isError);
}

function formatCount(count) {
  return typeof count === 'number' ? count.toLocaleString('en-US') : '?';
}

// --- Models --------------------------------------------------------------------------------

function storedModel() {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function loadModels() {
  const response = await fetch('/api/models');
  const { models, default: defaultModel } = await response.json();
  modelEl.innerHTML = models
    .map(
      (m) =>
        `<option value="${escapeHtml(m.id)}" ${m.available ? '' : 'disabled'}>${escapeHtml(m.label)}${
          m.available ? '' : ' — no API key'
        }</option>`,
    )
    .join('');
  const wanted = [new URLSearchParams(window.location.search).get('model'), storedModel(), defaultModel];
  const pick = wanted.find((id) => models.some((m) => m.id === id && m.available)) || models.find((m) => m.available)?.id;
  if (pick) modelEl.value = pick;
}

modelEl.addEventListener('change', () => {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, modelEl.value);
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
});

// --- The generated search --------------------------------------------------------------------

function toStructuredQuery() {
  return {
    concepts: state.concepts
      .map((c) => ({ label: c.label, terms: c.terms.filter((t) => t.checked).map((t) => t.term) }))
      .filter((c) => c.terms.length),
    places: state.places,
    persons: state.persons,
    settlements: state.settlements,
    year_from: state.year_from,
    year_to: state.year_to,
  };
}

const AND = '<span class="query-connector">AND</span>';
const OR = '<span class="query-connector">OR</span>';

function filterChip(field, label, kind, index = '') {
  return `<span class="query-chip" data-field="${field}">
    <span class="field-name">${field}:</span><span>${escapeHtml(label)}</span>
    <button type="button" data-kind="${kind}" data-index="${index}" aria-label="Remove ${field} filter ${escapeHtml(label)}">×</button>
  </span>`;
}

function renderQuery() {
  const parts = state.concepts.map(
    (concept, ci) => `<span class="nl-group">
      <span class="nl-group-label">${escapeHtml(concept.label)}</span>
      ${concept.terms
        .map((t, ti) => {
          const count = termCounts[t.term];
          return `<button type="button" class="nl-term" aria-pressed="${t.checked}" data-concept="${ci}" data-term="${ti}">
            ${escapeHtml(t.term)}<span class="count ${count === 0 ? 'is-zero' : ''}">${formatCount(count)}</span>
          </button>`;
        })
        .join(OR)}
      <input class="nl-add-term" data-concept="${ci}" placeholder="+ term" aria-label="Add a term to ${escapeHtml(concept.label)}" />
    </span>`,
  );
  state.places.forEach((p, i) => parts.push(filterChip('place', p.label, 'places', i)));
  state.persons.forEach((p, i) => parts.push(filterChip('person', p.label, 'persons', i)));
  if (state.settlements.length) {
    // Several settlements are alternatives (a document has one), so they're ORed together.
    const chips = state.settlements.map((s, i) => filterChip('settlement', s, 'settlements', i)).join(OR);
    parts.push(state.settlements.length > 1 ? `<span class="nl-group">${chips}</span>` : chips);
  }
  if (state.year_from || state.year_to) {
    const from = state.year_from || state.year_to;
    const to = state.year_to || state.year_from;
    parts.push(filterChip('year', from === to ? `${from}` : `${from}–${to}`, 'year'));
  }
  queryEl.innerHTML = parts.join(AND) || '<span class="query-freetext">(empty search)</span>';
}

// --- Results preview (same look as results.html) ---------------------------------------------

function firstScanId(documentId) {
  const match = /^(.+_)(\d+)-\d+$/.exec(documentId || '');
  return match ? `${match[1]}${match[2]}` : documentId;
}

function viewerUrl(hit) {
  const scanId = firstScanId(hit.name);
  if (!scanId || !hit.inventory) return '#';
  const params = new URLSearchParams({
    manifest: `${IIIF_BASE}/inventory:${hit.inventory}.manifest`,
    canvas: `${IIIF_BASE}/canvas:${scanId}`,
  });
  return `https://dev.globalise.nl/manifest?${params.toString()}`;
}

// Inventory manifests are large and shared by many documents, so fetch each one once.
const manifestCache = new Map();

async function thumbnailUrl(hit) {
  const scanId = firstScanId(hit.name);
  if (!scanId || !hit.inventory) return '';
  if (!manifestCache.has(hit.inventory)) {
    manifestCache.set(
      hit.inventory,
      fetch(`${IIIF_BASE}/inventory:${hit.inventory}.manifest`, { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  const manifest = await manifestCache.get(hit.inventory);
  const canvas = (manifest?.items || []).find((item) => typeof item?.id === 'string' && item.id.endsWith(scanId));
  const body = canvas?.items?.[0]?.items?.[0]?.body;
  return body?.id ? body.id.replace('/full/max/', '/full/400,/') : '';
}

async function renderPreview(preview) {
  totalEl.textContent = formatCount(preview.total);
  if (!preview.hits.length) {
    previewEl.innerHTML = '<div class="empty-state">No matching documents.</div>';
    return;
  }
  const items = await Promise.all(
    preview.hits.map(async (hit) => {
      const url = viewerUrl(hit);
      const thumb = await thumbnailUrl(hit);
      return `<article class="result-item">
        <div class="result-figure">
          ${thumb
            ? `<a href="${url}"><img src="${escapeHtml(thumb)}" alt="Thumbnail for ${escapeHtml(hit.name)}" loading="lazy" /></a>`
            : '<div class="result-thumb-placeholder">No image</div>'}
        </div>
        <div class="result-content">
          <div class="result-meta">
            <h2 class="result-title"><a href="${url}">${escapeHtml(hit.name)}</a></h2>
            <small>${hit.year ? `${escapeHtml(hit.year)} · ` : ''}Inventory ${escapeHtml(hit.inventory || '?')} · ${escapeHtml(hit.settlement || 'Unknown')}</small>
          </div>
          <div class="result-snippets">
            ${hit.snippets.map((s) => `<p class="result-snippet">…${renderSnippet(s)}…</p>`).join('')}
          </div>
          <div class="result-footer"><a href="${url}">Open in viewer</a></div>
        </div>
      </article>`;
    }),
  );
  previewEl.innerHTML = items.join('');
}

function applyCompiled(compiled) {
  termCounts = { ...termCounts, ...compiled.concept_counts };
  renderQuery();
  openEl.href = compiled.results_url;
  return renderPreview(compiled.preview);
}

function scheduleCompile() {
  renderQuery();
  clearTimeout(compileTimer);
  compileTimer = setTimeout(async () => {
    const token = ++compileToken;
    totalEl.textContent = '…';
    try {
      const response = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: toStructuredQuery() }),
      });
      const data = await response.json();
      if (token !== compileToken) return; // a newer edit superseded this one
      if (!response.ok) throw new Error(data.error || response.statusText);
      await applyCompiled(data);
    } catch (error) {
      if (token === compileToken) setStatus(`Could not update the search: ${error.message}`, true);
    }
  }, COMPILE_DEBOUNCE_MS);
}

// --- Asking --------------------------------------------------------------------------------

function renderTrace(data) {
  const u = data.usage;
  usageEl.textContent = `${data.model_label} (effort ${u.effort}) · ${data.seconds}s · ${u.llm_calls} LLM calls · ${u.input_tokens.toLocaleString()} input tokens + ${u.cache_read_input_tokens.toLocaleString()} read from cache${
    u.cache_creation_input_tokens ? ` + ${u.cache_creation_input_tokens.toLocaleString()} written to cache` : ''
  } · ${u.output_tokens.toLocaleString()} output tokens (incl. reasoning)`;
  traceEl.innerHTML = data.trace
    .map(
      (step) => `<li>
        <code>${escapeHtml(step.tool)}</code> ${escapeHtml(JSON.stringify(step.input))}${step.is_error ? ' ⚠️' : ''}
        <details><summary>result</summary><pre>${escapeHtml(JSON.stringify(step.result, null, 1))}</pre></details>
      </li>`,
    )
    .join('');
}

function loadAnswer(data) {
  const a = data.answer;
  termCounts = data.concept_counts || {};
  state = {
    concepts: a.concepts.map((c) => ({
      label: c.label,
      // Terms the corpus doesn't contain at all start switched off; they'd only add noise.
      terms: c.terms.map((term) => {
        const t = term.toLowerCase();
        return { term: t, checked: termCounts[t] !== 0 };
      }),
    })),
    places: a.places,
    persons: a.persons,
    settlements: a.settlements,
    year_from: a.year_from,
    year_to: a.year_to,
  };
  document.querySelector('#nl-interpretation').textContent = a.interpretation;
  const notesEl = document.querySelector('#nl-notes');
  notesEl.textContent = a.notes || '';
  notesEl.hidden = !a.notes;
  renderTrace(data);
  resultEl.hidden = false;
  applyCompiled(data);
  // Switched-off zero-count terms change the query, so make the shown count match it.
  if (state.concepts.some((c) => c.terms.some((t) => !t.checked))) scheduleCompile();
}

async function ask(question) {
  submitEl.disabled = true;
  resultEl.hidden = true;
  const model = modelEl.value;
  const modelLabel = modelEl.selectedOptions[0]?.textContent || model;
  const started = Date.now();
  const tick = () =>
    setStatus(`${modelLabel} is translating your question and checking terms against the corpus… ${Math.round((Date.now() - started) / 1000)}s`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const response = await fetch('/api/nl-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, model }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    setStatus('');
    loadAnswer(data);
    const url = new URL(window.location);
    url.searchParams.set('q', question);
    url.searchParams.set('model', model);
    window.history.replaceState({}, '', url);
  } catch (error) {
    setStatus(`Something went wrong: ${error.message}`, true);
  } finally {
    clearInterval(timer);
    submitEl.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = questionEl.value.trim();
  if (question) ask(question);
});

document.querySelectorAll('.nl-example').forEach((button) => {
  button.addEventListener('click', () => {
    questionEl.value = button.textContent;
    form.requestSubmit();
  });
});

queryEl.addEventListener('click', (event) => {
  const term = event.target.closest('.nl-term');
  if (term) {
    const t = state.concepts[term.dataset.concept].terms[term.dataset.term];
    t.checked = !t.checked;
    scheduleCompile();
    return;
  }
  const remove = event.target.closest('button[data-kind]');
  if (remove) {
    const { kind, index } = remove.dataset;
    if (kind === 'year') {
      state.year_from = null;
      state.year_to = null;
    } else {
      state[kind].splice(Number(index), 1);
    }
    scheduleCompile();
  }
});

queryEl.addEventListener('keydown', (event) => {
  const input = event.target.closest('.nl-add-term');
  if (!input || event.key !== 'Enter') return;
  event.preventDefault();
  const term = input.value.trim().toLowerCase();
  const concept = state.concepts[input.dataset.concept];
  if (term && !concept.terms.some((t) => t.term === term)) {
    concept.terms.push({ term, checked: true });
    scheduleCompile();
  }
  input.value = '';
});

loadModels()
  .catch(() => setStatus('Could not load the model list — is server.py running?', true))
  .finally(() => {
    const initialQuestion = new URLSearchParams(window.location.search).get('q');
    if (initialQuestion) {
      questionEl.value = initialQuestion;
      ask(initialQuestion);
    }
  });
