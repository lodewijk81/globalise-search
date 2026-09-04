const API_URL = 'http://localhost:5050/search';
const SUGGEST_URL = 'http://localhost:5050/suggest';
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

// Structured search fields exposed by the "documents" index, selectable via "field:value" in the search bar.
const FIELD_DEFS = [
  { key: 'person', label: 'Person', hint: 'Find persons mentioned in the text, e.g. am*', kind: 'nested', type: 'Person' },
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
                    value: toWildcardPattern(value),
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
    return hasExplicitWildcard(value)
      ? { wildcard: { [def.field]: { value, case_insensitive: true } } }
      : { match: { [def.field]: value } };
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

function buildEsQuery(keywordText, chips) {
  const expressionClause = parseKeywordExpression(keywordText);
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

// Splits a raw expression string into LPAREN/RPAREN/AND/OR/NOT/FIELDVALUE/WORD tokens.
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

// Recursive-descent parser: orExpr := andExpr (OR andExpr)*, andExpr := notExpr (AND? notExpr)*.
function parseQueryTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseWordRun() {
    const words = [];
    while (peek()?.type === 'WORD') words.push(consume().text);
    const text = words.join(' ');
    return text ? { query_string: { query: text, default_field: 'text', default_operator: 'AND' } } : null;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) return null;
    if (token.type === 'LPAREN') {
      consume();
      const inner = parseOr();
      if (peek()?.type === 'RPAREN') consume();
      return inner;
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

  function parseNot() {
    if (peek()?.type === 'NOT') {
      consume();
      const clause = parsePrimary();
      return clause ? { bool: { must_not: [clause] } } : null;
    }
    return parsePrimary();
  }

  function parseAnd() {
    const clauses = [parseNot()].filter(Boolean);
    while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
      if (peek().type === 'AND') consume();
      const clause = parseNot();
      if (clause) clauses.push(clause);
    }
    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : { bool: { must: clauses } };
  }

  function parseOr() {
    const clauses = [parseAnd()].filter(Boolean);
    while (peek()?.type === 'OR') {
      consume();
      const clause = parseAnd();
      if (clause) clauses.push(clause);
    }
    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } };
  }

  return parseOr();
}

// Parses the whole keyword box into an ES query clause, supporting `field:value`, AND/OR/NOT and parentheses.
function parseKeywordExpression(keywordText) {
  const trimmed = (keywordText || '').trim();
  if (!trimmed) return null;
  try {
    const tokens = tokenizeQueryExpression(trimmed);
    return tokens.length ? parseQueryTokens(tokens) : null;
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
    const match = value.match(/(^|[\s(])([a-zA-Z]+)\s*:\s*("([^"]*)"|([^\s()]*))$/);
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

  function commitToken(token, sourceEl) {
    if (!token.value) return false;
    chips.push({ fieldKey: token.fieldKey, value: token.value });
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

  // Applies a chosen value to the trailing token: as a chip when it's the sole input
  // content, or as an in-place replacement when it's part of a bigger expression.
  function applyTokenValue(token, sourceEl, value) {
    const finalToken = value === undefined ? token : { ...token, value };
    if (!finalToken.value) return false;
    return isSoleToken(token) ? commitToken(finalToken, sourceEl) : insertTokenValue(token, finalToken.value);
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

  function showFieldSuggestions(word, start) {
    cancelPendingSuggestFetch();
    selectedIndex = -1;
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

  // Debounced lookup of matching indexed values (e.g. "place:Am" -> "Amsterdam") from the /suggest endpoint.
  function fetchValueSuggestions(token, def) {
    const prefix = token.value.trim();
    if (def.kind === 'year' || prefix.length < SUGGEST_MIN_CHARS || hasExplicitWildcard(prefix)) return;

    const requestId = suggestRequestId;
    suggestDebounceTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      suggestAbortController = controller;
      try {
        const response = await fetch(SUGGEST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: token.fieldKey, prefix }),
          signal: controller.signal,
        });
        if (!response.ok || requestId !== suggestRequestId) return;
        const data = await response.json();
        if (requestId !== suggestRequestId) return;

        const valueItems = (data.suggestions || [])
          .filter((item) => item.value.toLowerCase() !== prefix.toLowerCase())
          .map((item) => ({
            apply: (sourceEl) => applyTokenValue(token, sourceEl, item.value),
            html: `
              <span class="query-chip query-chip-preview" data-field="${token.fieldKey}">
                <span class="field-name">${escapeHtml(def.label)}:</span>
                <span>${escapeHtml(item.value)}</span>
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

function getHighlightText(result) {
  const fragments = result?.highlight?.text ?? [];
  if (fragments.length) return fragments.join(' … ');

  // Structural-only searches (person:/place:/etc.) don't match anything in the "text" field,
  // so Elasticsearch has nothing to highlight. Fall back to a plain excerpt of the document text.
  const fullText = (result?.text || '').replace(/\s+/g, ' ').trim();
  if (!fullText) return 'No snippet available.';
  const excerpt = fullText.length > 300 ? `${fullText.slice(0, 300)}…` : fullText;
  return escapeHtml(excerpt);
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
      const snippet = getHighlightText(result);
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
