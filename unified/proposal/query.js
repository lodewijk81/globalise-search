// Prototype copy of ../query.js for the query syntax proposal (#122). On top of the original:
// - picked suggestions are inline tokens in the text, `@{field|id|label}`, as in the portal's
//   search field (@knaw-huc/searchfield), so they can be combined like any other term;
// - `field:*` means "any annotation of this kind";
// - `x NOT IN field:…` (x, but not as part of such an annotation). There is no `IN`: `x IN person:*`
//   would mean the same as `person:x`;
// - text regions `header:( … )`, `margin:( … )`, `text:( … )`. The index has no region fields
//   yet, so these are parsed and explained but searched in the whole document.
// - diagnose() and readBack() for feedback under the search bar.

import { ANNOTATION_TYPES, FIELD_ALIASES, FIELD_BY_KEY } from '../config.js';

const TEXT = 'annotatedText';

// --- Proposal additions: tokens, regions, "any" -------------------------------------------

export const ENTITY_TOKEN = /@\{([^|}]+)\|([^|}]+)\|([^}]+)\}/g;
const ENTITY_TOKEN_AT = /^@\{([^|}]+)\|([^|}]+)\|([^}]+)\}/;

export function encodeToken(fieldKey, id, label) {
  return `@{${encodeURIComponent(fieldKey)}|${encodeURIComponent(id)}|${encodeURIComponent(label)}}`;
}

export function decodeToken(match) {
  try {
    return { fieldKey: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]), value: decodeURIComponent(match[3]) };
  } catch (error) {
    return null;
  }
}

function readToken(input, i) {
  const match = ENTITY_TOKEN_AT.exec(input.slice(i));
  if (!match) return null;
  const token = decodeToken(match);
  const fieldKey = token && FIELD_ALIASES.get(token.fieldKey.toLowerCase());
  if (!fieldKey) return null;
  return { fieldKey, value: token.value, id: token.id, next: i + match[0].length };
}

export const REGIONS = {
  header: { label: 'a header', aliases: ['header', 'heading', 'kop'] },
  margin: { label: 'a margin', aliases: ['margin', 'marginalia', 'marge'] },
  text: { label: 'the main text', aliases: ['text', 'main', 'body', 'tekst'] },
};
const REGION_ALIASES = new Map(Object.entries(REGIONS).flatMap(([key, def]) => def.aliases.map((alias) => [alias, key])));

// `header:( … )` or `header:word`. Returns the region and the text it applies to.
function readRegion(input, i) {
  const match = /^([A-Za-z]+)\s*:\s*/.exec(input.slice(i));
  const region = match ? REGION_ALIASES.get(match[1].toLowerCase()) : null;
  if (!region) return null;
  let j = i + match[0].length;
  if (input[j] === '(') {
    const close = findMatchingParen(input, j);
    const end = close === -1 ? input.length : close;
    return { region, inner: input.slice(j + 1, end), next: close === -1 ? input.length : close + 1 };
  }
  const field = readToken(input, j) || readFieldValue(input, j);
  if (field) return { region, inner: input.slice(j, field.next), next: field.next };
  const word = input[j] === '"' ? /^"[^"]*"?/.exec(input.slice(j))[0] : /^[^\s()]*/.exec(input.slice(j))[0];
  return { region, inner: word, next: j + word.length };
}

// What "any …" means in the annotated text: the annotation types that count as this kind.
const EVENT_TYPES = Object.keys(ANNOTATION_TYPES).filter((type) => ANNOTATION_TYPES[type].group === 'event');
const ANY_TYPES = {
  place: ['Place'],
  person: ['Person'],
  role: ['Person'],
  profession: ['Person'],
  ship: ['HumanMadeObject'],
  organisation: ['Group'],
  polity: ['Group'],
  annotation: EVENT_TYPES,
};

export const isAny = (chip) => !chip.id && String(chip.value).trim() === '*';

function anyDocumentClause(chip) {
  const types = ANY_TYPES[chip.fieldKey];
  if (!types) return undefined;
  return should(types.map((type) => annotationTerm('type', type)));
}

function anySpanFor(fieldKey) {
  const types = ANY_TYPES[fieldKey];
  return types ? anySpan(types.map((type) => ({ span_term: { [TEXT]: `type:${type}` } }))) : null;
}

function anyOtherClause(chip, scope) {
  if (scope === 'persons') {
    const field = { person: null, profession: 'occupations', status: 'statuses', identity: 'identities' }[chip.fieldKey];
    if (field === null) return { match_all: {} };
    return field ? { exists: { field } } : undefined;
  }
  const own = { places: 'place', organisations: 'organisation', polities: 'polity', ships: 'ship', concepts: 'concept' }[scope];
  return chip.fieldKey === own ? { match_all: {} } : undefined;
}

// --- Tokenizer ----------------------------------------------------------------------------

function findMatchingParen(input, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      i = end === -1 ? input.length : end;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Reads a `field:value` starting at i, returning null when the prefix isn't a known field.
function readFieldValue(input, i) {
  const fieldMatch = /^([A-Za-z]+)\s*:\s*/.exec(input.slice(i));
  const fieldKey = fieldMatch ? FIELD_ALIASES.get(fieldMatch[1].toLowerCase()) : null;
  if (!fieldKey) return null;
  let j = i + fieldMatch[0].length;
  let value;
  if (input[j] === '"') {
    const end = input.indexOf('"', j + 1);
    value = end === -1 ? input.slice(j + 1) : input.slice(j + 1, end);
    j = end === -1 ? input.length : end + 1;
  } else {
    value = /^[^\s()]*/.exec(input.slice(j))[0];
    j += value.length;
  }
  return { fieldKey, value, next: j };
}

function tokenizeProximityItems(input) {
  const items = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }
    const region = readRegion(input, i);
    if (region) {
      items.push({ kind: 'region', region: region.region, inner: region.inner });
      i = region.next;
      continue;
    }
    const field = readToken(input, i) || readFieldValue(input, i);
    if (field) {
      items.push({ kind: 'field', fieldKey: field.fieldKey, value: field.value, ...(field.id ? { id: field.id } : {}) });
      i = field.next;
      continue;
    }
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      const text = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
      items.push({ kind: 'phrase', text });
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    const raw = /^[^\s()]+/.exec(input.slice(i));
    if (!raw) {
      i += 1;
      continue;
    }
    i += raw[0].length;
    const fuzzy = /^(.+?)~(\d*)$/.exec(raw[0]);
    items.push(fuzzy ? { kind: 'word', text: fuzzy[1], fuzzy: fuzzy[2] || 'AUTO' } : { kind: 'word', text: raw[0], fuzzy: null });
  }
  return items;
}

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '(') {
      const close = findMatchingParen(input, i);
      const slop = close === -1 ? null : /^~(\d+)/.exec(input.slice(close + 1));
      if (slop) {
        tokens.push({ type: 'PROX', slop: Number(slop[1]), items: tokenizeProximityItems(input.slice(i + 1, close)) });
        i = close + 1 + slop[0].length;
      } else {
        tokens.push({ type: 'LPAREN' });
        i += 1;
      }
    } else if (ch === ')') {
      tokens.push({ type: 'RPAREN' });
      i += 1;
    } else if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      tokens.push({ type: 'WORD', text: end === -1 ? `${input.slice(i)}"` : input.slice(i, end + 1) });
      i = end === -1 ? input.length : end + 1;
    } else {
      const region = readRegion(input, i);
      const field = region ? null : readToken(input, i) || readFieldValue(input, i);
      const keyword = region || field ? null : /^(NOT\s+IN|AND|OR|NOT)(?![A-Za-z0-9_])/.exec(input.slice(i));
      if (region) {
        tokens.push({ type: 'REGION', region: region.region, inner: region.inner });
        i = region.next;
      } else if (field) {
        tokens.push({ type: 'FIELD', fieldKey: field.fieldKey, value: field.value, ...(field.id ? { id: field.id } : {}) });
        i = field.next;
      } else if (keyword) {
        tokens.push({ type: /^NOT\s+IN$/.test(keyword[1]) ? 'NOTIN' : keyword[1] });
        i += keyword[0].length;
      } else {
        const word = /^[^\s()]+/.exec(input.slice(i))[0];
        tokens.push({ type: 'WORD', text: word });
        i += word.length;
      }
    }
  }
  return tokens;
}

// --- Parser -------------------------------------------------------------------------------

// orExpr := andExpr (OR andExpr)*   andExpr := notExpr (AND? notExpr)*
export function parse(input) {
  const tokens = tokenize(input || '');
  let pos = 0;
  const peek = () => tokens[pos];

  // `single`: NOT applies to one word only (`a NOT b c` is a AND NOT b AND c, as in Lucene).
  function primary(single = false) {
    const token = peek();
    if (!token) return null;
    pos += 1;
    if (token.type === 'LPAREN') {
      const inner = or();
      if (peek()?.type === 'RPAREN') pos += 1;
      return inner;
    }
    if (token.type === 'PROX') return { t: 'prox', slop: token.slop, items: token.items };
    if (token.type === 'REGION') {
      const inner = parse(token.inner);
      return inner ? { t: 'region', region: token.region, inner } : null;
    }
    if (token.type === 'FIELD') {
      if (!token.value) return null;
      const chip = { fieldKey: token.fieldKey, value: token.value };
      if (token.id) chip.id = token.id;
      return { t: 'field', chip };
    }
    if (token.type === 'WORD') {
      const words = [token.text];
      while (!single && peek()?.type === 'WORD') {
        words.push(peek().text);
        pos += 1;
      }
      return { t: 'words', words };
    }
    return null; // a stray ")" or operator: skip it and keep going
  }

  function not() {
    if (peek()?.type === 'NOT') {
      pos += 1;
      const inner = primary(true);
      return inner ? { t: 'not', inner } : null;
    }
    return primary();
  }

  // `left NOT IN right`: binds tighter than AND, so `a NOT IN place:* b` is (a NOT IN place:*) AND b.
  function contained() {
    let left = not();
    while (left && peek()?.type === 'NOTIN') {
      pos += 1;
      const right = primary();
      if (!right) break;
      left = { t: 'in', negate: true, left, right };
    }
    return left;
  }

  function and() {
    const parts = [contained()].filter(Boolean);
    while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
      if (peek().type === 'AND') pos += 1;
      const next = contained();
      if (next) parts.push(next);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : { t: 'and', parts };
  }

  function or() {
    const parts = [and()].filter(Boolean);
    while (peek()?.type === 'OR') {
      pos += 1;
      const next = and();
      if (next) parts.push(next);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : { t: 'or', parts };
  }

  let tree = or();
  // A stray ")" stops or() early; carry on so that the rest of the input still counts.
  while (pos < tokens.length) {
    pos += 1;
    const rest = or();
    if (rest) tree = tree ? { t: 'and', parts: [tree, rest] } : rest;
  }
  return tree;
}

// Every field:value in a tree (also those inside proximity groups), for the resolver in api.js.
export function collectFieldNodes(tree, out = []) {
  if (!tree) return out;
  if (tree.t === 'field') out.push(tree.chip);
  if (tree.t === 'not' || tree.t === 'region') collectFieldNodes(tree.inner, out);
  if (tree.t === 'in') {
    collectFieldNodes(tree.left, out);
    collectFieldNodes(tree.right, out);
  }
  if (tree.parts) tree.parts.forEach((part) => collectFieldNodes(part, out));
  if (tree.t === 'prox') tree.items.filter((item) => item.kind === 'field').forEach((item) => out.push(item));
  return out;
}

// --- Shared helpers -----------------------------------------------------------------------

export const hasWildcard = (value) => /[*?]/.test(value);
const escapeWildcard = (value) => String(value).replace(/([\\*?])/g, '\\$1');
const containsPattern = (value) => (hasWildcard(value) ? value : `*${escapeWildcard(value)}*`);

// Keeps wildcards, fuzziness and quotes working, but stops ":" and friends being read as Lucene
// field syntax. Otherwise "Comp:s" (a common abbreviation in the corpus) would be a field query.
function escapeLucene(word) {
  if (word.startsWith('"')) return word;
  return word.replace(/([+\-!(){}[\]^:/\\&|<>=])/g, '\\$1');
}

const queryString = (words, field) => ({
  query_string: { query: words.map(escapeLucene).join(' '), default_field: field, default_operator: 'AND' },
});

const analyzedWords = (value) => value.toLowerCase().split(/[^\p{L}\p{N}*?']+/u).filter(Boolean);

function wordSpan(word, fuzzy = null) {
  const value = word.toLowerCase();
  if (fuzzy) return { span_multi: { match: { fuzzy: { [TEXT]: { value, fuzziness: fuzzy } } } } };
  if (hasWildcard(value)) return { span_multi: { match: { wildcard: { [TEXT]: { value } } } } };
  return { span_term: { [TEXT]: value } };
}

function phraseSpan(text) {
  const words = analyzedWords(text);
  if (!words.length) return null;
  if (words.length === 1) return wordSpan(words[0]);
  return { span_near: { clauses: words.map((word) => wordSpan(word)), slop: 0, in_order: true } };
}

const anySpan = (spans) => (spans.length === 1 ? spans[0] : { span_or: { clauses: spans } });

// The text as written, but only where the text is tagged with this annotation. This is what
// makes `place:Amster*` work without an id. Annotations share a position with their words.
function taggedSpan(annotation, text) {
  const little = phraseSpan(text);
  return little ? { span_within: { big: { span_term: { [TEXT]: annotation } }, little } } : null;
}

const annotationTerm = (key, value) => ({ term: { [TEXT]: `${key}:${value}` } });

const should = (clauses) => (clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } });

function variantsOf(chip) {
  const list = chip.variants && chip.variants.length ? chip.variants : [chip.value];
  return [...new Set(list.map((v) => v.trim()).filter(Boolean))];
}

export function canonicalAnnotationType(value) {
  const lower = value.trim().toLowerCase();
  return Object.keys(ANNOTATION_TYPES).find(
    (key) => key.toLowerCase() === lower || ANNOTATION_TYPES[key].label.toLowerCase() === lower
  ) || null;
}

export function yearRange(value) {
  const range = /^(\d{3,4})\s*-\s*(\d{3,4})$/.exec(value.trim());
  const single = /^(\d{3,4})$/.exec(value.trim());
  if (range) return [range[1], range[2]];
  if (single) return [single[1], single[1]];
  return null;
}

// --- Per-index clauses for one field:value ------------------------------------------------

const documentClauses = {
  place: (chip) => (chip.id ? annotationTerm('placeId', chip.id) : taggedSpan('type:Place', chip.value)),
  // Named people, ships, organisations and polities have no id in the text yet, so they are
  // found by name, using every spelling variant the authority record lists.
  person: names,
  ship: names,
  organisation: names,
  polity: names,
  role: (chip) => (chip.id ? annotationTerm('personId', chip.id) : taggedSpan('type:Person', chip.value)),
  // Specific statuses and identities (weduwe, gevangene, Chinees, …) are tagged in the text like
  // roles. Broader ones (e.g. "juridische status") are not, and there are no paths for them.
  status: (chip) => (chip.id ? annotationTerm('personId', chip.id) : taggedSpan('type:Person', chip.value)),
  identity: (chip) => (chip.id ? annotationTerm('personId', chip.id) : taggedSpan('type:Person', chip.value)),
  profession: (chip, mode) => {
    if (!chip.id) return taggedSpan('type:Person', chip.value);
    return mode === 'highlight' ? annotationTerm('personId', chip.id) : { match_phrase: { professionIdPaths: chip.id } };
  },
  concept: (chip, mode) => {
    if (!chip.id) return { match_none: {} };
    if (mode === 'highlight') return annotationTerm('personId', chip.id);
    return should([
      annotationTerm('personId', chip.id),
      { match_phrase: { professionIdPaths: chip.id } },
      { match_phrase: { documentTypeIdPaths: chip.id } },
    ]);
  },
  annotation: (chip) => {
    const type = canonicalAnnotationType(chip.value);
    return type ? annotationTerm('type', type) : { match_none: {} };
  },
  documenttype: (chip, mode) => {
    if (mode === 'highlight') return null;
    return chip.id ? { match_phrase: { documentTypeIdPaths: chip.id } } : { match_none: {} };
  },
  title: (chip, mode) => (mode === 'highlight' ? null : { match: { title: { query: chip.value, operator: 'and' } } }),
  settlement: (chip, mode) => {
    if (mode === 'highlight') return null;
    return chip.id !== undefined
      ? { term: { settlement: chip.id } }
      : { wildcard: { settlement: { value: containsPattern(chip.value), case_insensitive: true } } };
  },
  archive: (chip, mode) => {
    if (mode === 'highlight') return null;
    return chip.id
      ? { term: { 'eadIdPaths.tree': chip.id } }
      : { wildcard: { archiveDescription: { value: containsPattern(chip.value), case_insensitive: true } } };
  },
  inventory: (chip, mode) => {
    if (mode === 'highlight') return null;
    return hasWildcard(chip.value)
      ? { wildcard: { inventoryNumber: { value: chip.value } } }
      : { term: { inventoryNumber: chip.value } };
  },
  year: (chip, mode) => {
    if (mode === 'highlight') return null;
    const range = yearRange(chip.value);
    if (!range) return { match_none: {} };
    return {
      bool: {
        filter: [
          { range: { startDate: { lte: `${range[1]}-12-31` } } },
          { range: { endDate: { gte: `${range[0]}-01-01` } } },
        ],
      },
    };
  },
};

const NAME_TYPES = { person: 'Person', ship: 'HumanMadeObject', organisation: 'Group', polity: 'Group' };

function names(chip) {
  const variants = variantsOf(chip);
  if (variants.length === 1 && hasWildcard(variants[0])) {
    const type = NAME_TYPES[chip.fieldKey] || 'Person';
    return { span_within: { big: { span_term: { [TEXT]: `type:${type}` } }, little: phraseSpan(variants[0]) } };
  }
  return should(variants.map((variant) => ({ match_phrase: { [TEXT]: variant } })));
}

function personNameClause(value) {
  const words = hasWildcard(value) ? [value] : value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { match_none: {} };
  return {
    bool: { must: words.map((word) => ({ wildcard: { titles: { value: containsPattern(word), case_insensitive: true } } })) },
  };
}

const personClauses = {
  person: (chip) => (chip.id ? { ids: { values: [chip.id] } } : personNameClause(chip.value)),
  record: (chip) => ({ ids: { values: [chip.id || chip.value] } }),
  title: (chip) => personNameClause(chip.value),
  profession: (chip) => (chip.id ? { term: { occupations: chip.id } } : { match_none: {} }),
  status: (chip) => (chip.id ? { term: { statuses: chip.id } } : { match_none: {} }),
  identity: (chip) => (chip.id ? { term: { identities: chip.id } } : { match_none: {} }),
  concept: (chip) => {
    if (!chip.id) return { match_none: {} };
    return should([{ term: { occupations: chip.id } }, { term: { statuses: chip.id } }, { term: { identities: chip.id } }]);
  },
};

function objectClause(chip, scope) {
  // The pill for this object's own kind narrows the list to that record.
  const own = { places: 'place', organisations: 'organisation', polities: 'polity', ships: 'ship', concepts: 'concept' }[scope];
  if (chip.fieldKey === 'title' || chip.fieldKey === own) {
    if (chip.fieldKey === own && chip.id) return { ids: { values: [chip.id] } };
    if (hasWildcard(chip.value)) return queryString(chip.value.trim().split(/\s+/), 'title');
    return { match: { title: { query: chip.value, operator: 'and' } } };
  }
  return undefined;
}

// `mode` is 'filter' or 'highlight'. Returns undefined when this field can't apply to the scope,
// and null when it applies but has nothing to highlight.
export function fieldClause(chip, scope, mode = 'filter') {
  const def = FIELD_BY_KEY.get(chip.fieldKey);
  if (!def || !def.scopes.includes(scope)) return undefined;
  if (isAny(chip)) {
    if (scope !== 'documents') return anyOtherClause(chip, scope);
    if (mode === 'highlight' && chip.fieldKey === 'annotation') return null; // would mark every event
    return anyDocumentClause(chip);
  }
  if (scope === 'documents') return documentClauses[chip.fieldKey]?.(chip, mode);
  if (scope === 'persons') return personClauses[chip.fieldKey]?.(chip, mode);
  return objectClause(chip, scope);
}

// --- Per-index clauses for free text ------------------------------------------------------

function objectWord(word) {
  if (word.startsWith('"')) return { match_phrase: { title: word.replace(/^"|"$/g, '') } };
  if (hasWildcard(word) || /~\d*$/.test(word)) return queryString([word], 'title');
  return { bool: { should: [{ match: { title: { query: word, boost: 3 } } }, { prefix: { title: { value: word.toLowerCase() } } }], minimum_should_match: 1 } };
}

function personWord(word) {
  const clean = word.replace(/^"|"$/g, '').replace(/~\d*$/, '');
  if (!clean) return { match_none: {} };
  return {
    bool: {
      must: [{ wildcard: { titles: { value: containsPattern(clean), case_insensitive: true } } }],
      should: [{ wildcard: { titles: { value: hasWildcard(clean) ? clean : `${escapeWildcard(clean)}*`, case_insensitive: true, boost: 2 } } }],
    },
  };
}

function wordsClause(words, scope) {
  if (words.length === 1 && words[0] === '*') return { match_all: {} };
  if (scope === 'documents') return queryString(words, TEXT);
  const make = scope === 'persons' ? personWord : objectWord;
  const clauses = words.map(make);
  return clauses.length === 1 ? clauses[0] : { bool: { must: clauses } };
}

// --- Compile the tree ---------------------------------------------------------------------

function proxItemSpan(item) {
  if (item.kind === 'word') return wordSpan(item.text, item.fuzzy);
  if (item.kind === 'phrase') return phraseSpan(item.text);
  if (item.kind === 'region') return null; // proximity across text regions isn't possible (diagnose() says so)
  const value = (item.value || '').trim();
  if (!value) return null;
  if (!item.id && value === '*') return anySpanFor(item.fieldKey);
  if (item.fieldKey === 'place') return item.id ? { span_term: { [TEXT]: `placeId:${item.id}` } } : taggedSpan('type:Place', value);
  if (['role', 'profession', 'concept', 'status', 'identity'].includes(item.fieldKey)) {
    return item.id ? { span_term: { [TEXT]: `personId:${item.id}` } } : taggedSpan('type:Person', value);
  }
  if (item.fieldKey === 'annotation') {
    const type = canonicalAnnotationType(value);
    return type ? { span_term: { [TEXT]: `type:${type}` } } : null;
  }
  if (item.variants && item.variants.length) return anySpan(item.variants.map(phraseSpan).filter(Boolean));
  return phraseSpan(value);
}

// Fields that have positions in the text, so they can be used in ( … )~N and NOT IN.
const POSITIONAL = new Set(['place', 'person', 'ship', 'organisation', 'polity', 'role', 'profession', 'concept', 'annotation', 'status', 'identity']);

function positional(item) {
  if (item.kind !== 'field') return true;
  if (!POSITIONAL.has(item.fieldKey)) return false;
  return item.id || String(item.value).trim() !== '*' || Boolean(ANY_TYPES[item.fieldKey]);
}

// The first field in a proximity group or NOT IN that has no position in the text, if any.
export function positionalProblem(tree) {
  let found = null;
  const check = (item) => {
    if (!found && item && !positional(item)) found = `${item.fieldKey}:${item.value}`;
  };
  const visit = (node) => {
    if (!node || found) return;
    if (node.t === 'prox') node.items.forEach(check);
    if (node.t === 'in') {
      [node.left, node.right].forEach((side) => {
        if (side.t === 'field') check({ kind: 'field', ...side.chip });
        else if (side.t !== 'words') found = found || 'a group';
      });
    }
    if (node.t === 'not' || node.t === 'region') visit(node.inner);
    if (node.parts) node.parts.forEach(visit);
  };
  visit(tree);
  return found;
}

function proxClause(node, scope) {
  if (!node.items.every(positional)) return undefined; // e.g. title: has no position in the text
  const spans = node.items.map(proxItemSpan).filter(Boolean);
  if (spans.length < 2) return spans[0] || null;
  return { span_near: { clauses: spans, slop: node.slop, in_order: false } };
}

// Proximity needs word positions, which only documents have. Elsewhere it means "all of these".
function proxFallback(node, scope) {
  const parts = node.items
    .filter((item) => item.kind !== 'region')
    .map((item) => {
      if (item.kind === 'field') return fieldClause({ fieldKey: item.fieldKey, value: item.value, id: item.id }, scope);
      return wordsClause([item.kind === 'phrase' ? `"${item.text}"` : item.text], scope);
    });
  if (parts.includes(undefined)) return undefined;
  const clean = parts.filter(Boolean);
  return clean.length ? { bool: { must: clean } } : null;
}

// A tree node as one span (for NOT IN): words, a phrase or a single field.
function nodeSpan(node) {
  if (!node) return null;
  if (node.t === 'field') return proxItemSpan({ kind: 'field', ...node.chip });
  if (node.t === 'words') {
    const spans = node.words.map((word) => {
      if (word.startsWith('"')) return phraseSpan(word.replace(/^"|"$/g, ''));
      const fuzzy = /^(.+?)~(\d*)$/.exec(word);
      return fuzzy ? wordSpan(fuzzy[1], fuzzy[2] || 'AUTO') : wordSpan(word);
    }).filter(Boolean);
    if (spans.length < 2) return spans[0] || null;
    return { span_near: { clauses: spans, slop: 0, in_order: true } };
  }
  return null;
}

// `batavia NOT IN place:*`: the left part where it does not overlap the right part. Only
// documents have running text, so the other tabs can't answer this.
function inClause(node, scope) {
  if (scope !== 'documents' || positionalProblem(node)) return undefined;
  const include = nodeSpan(node.left);
  const exclude = nodeSpan(node.right);
  if (!include || !exclude) return { match_none: {} };
  return { span_not: { include, exclude } };
}

// Returns an ES clause, null for "nothing here", or undefined when the scope can't express part
// of the query at all (so that tab is shown as unavailable, not silently misleading).
export function compile(node, scope, mode = 'filter') {
  if (!node) return null;
  switch (node.t) {
    case 'words':
      return wordsClause(node.words, scope);
    case 'field':
      return fieldClause(node.chip, scope, mode);
    case 'prox':
      return scope === 'documents' ? proxClause(node, scope) : proxFallback(node, scope);
    case 'in':
      return inClause(node, scope);
    case 'region':
      // No region fields in the index yet: search the whole document, and say so (readBack).
      // Regions only exist in documents, so the other tabs can't run this query.
      return scope === 'documents' ? compile(node.inner, scope, mode) : undefined;
    case 'not': {
      if (mode === 'highlight') return null; // excluded terms can't appear in a hit
      const inner = compile(node.inner, scope, mode);
      if (inner === undefined) return undefined;
      return inner ? { bool: { must_not: [inner] } } : null;
    }
    case 'and':
    case 'or': {
      let parts = node.parts.map((part) => compile(part, scope, mode));
      // In an OR, a part that can't apply to this tab just finds nothing here
      // (`person:Coen OR place:Batavia` still finds Coen on the Persons tab).
      if (node.t === 'or' && mode !== 'highlight') {
        if (parts.every((part) => part === undefined)) return undefined;
        parts = parts.filter((part) => part !== undefined);
      }
      if (mode !== 'highlight' && parts.includes(undefined)) return undefined;
      const clean = parts.filter(Boolean);
      if (!clean.length) return null;
      if (clean.length === 1) return clean[0];
      if (mode === 'highlight' || node.t === 'or') return { bool: { should: clean, minimum_should_match: 1 } };
      return { bool: { must: clean } };
    }
    default:
      return null;
  }
}

// The complete query for one scope, or null when the scope can't run this search.
export function buildQuery(tree, chips, scope) {
  const expression = compile(tree, scope);
  if (expression === undefined) return null;

  const must = expression ? [expression] : [];
  const filter = [];
  for (const chip of chips) {
    const clause = fieldClause(chip, scope);
    if (clause === undefined) return null;
    if (clause) (FIELD_BY_KEY.get(chip.fieldKey).scored ? must : filter).push(clause);
  }
  if (!must.length && !filter.length) return { match_all: {} };
  return { bool: { ...(must.length ? { must } : {}), ...(filter.length ? { filter } : {}) } };
}

// What to mark in the document text. Separate from the main query because many filters match
// on other fields (dates, profession paths) that say nothing about where in the text to look.
export function buildHighlightQuery(tree, chips) {
  const clauses = [];
  const expression = compile(tree, 'documents', 'highlight');
  if (expression) clauses.push(expression);
  chips.forEach((chip) => {
    const clause = fieldClause(chip, 'documents', 'highlight');
    if (clause) clauses.push(clause);
  });
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } };
}

// Words worth marking client-side in names and titles (persons and object cards).
export function plainTerms(tree, chips) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (node.t === 'words') node.words.forEach((word) => out.push(word));
    if (node.t === 'field' && !isAny(node.chip)) out.push(node.chip.value);
    if (node.t === 'prox') node.items.forEach((item) => out.push(item.text || item.value || ''));
    if (node.t === 'region') visit(node.inner);
    if (node.t === 'in') {
      visit(node.left);
      visit(node.right);
    }
    if (node.parts) node.parts.forEach(visit);
  };
  visit(tree);
  chips.filter((chip) => ['person', 'title'].includes(chip.fieldKey)).forEach((chip) => out.push(chip.value));
  return out
    .flatMap((word) => word.replace(/["~\d*?]+$|^"/g, '').split(/\s+/))
    .map((word) => word.replace(/[*?"]/g, ''))
    .filter((word) => word.length > 1);
}

// --- Proposal additions: feedback under the search bar ------------------------------------

// Problems and remarks about the text in the bar. level: 'error' (part of the query is ignored)
// or 'note' (it works, but differently from what you might expect).
export function diagnose(input) {
  const out = [];
  const text = String(input || '').replace(ENTITY_TOKEN, 'TOKEN');
  const unquoted = text.replace(/"[^"]*"/g, '""');
  if ((text.match(/"/g) || []).length % 2) out.push({ level: 'error', text: 'A quote is not closed. Everything after it is read as one phrase.' });
  let depth = 0;
  let stray = false;
  for (const ch of unquoted) {
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) {
        stray = true;
        depth = 0;
      }
    }
  }
  if (depth > 0) out.push({ level: 'error', text: 'A bracket is not closed: the query is read as if it were closed at the end.' });
  if (stray) out.push({ level: 'error', text: 'There is a ")" without a matching "(". It is ignored.' });
  for (const match of unquoted.matchAll(/(^|[\s(])([A-Za-z]+):(?=[^\s)])/g)) {
    const name = match[2].toLowerCase();
    if (!FIELD_ALIASES.has(name) && !REGION_ALIASES.has(name)) {
      out.push({ level: 'note', text: `“${match[2]}:” is not a search field, so it is searched as ordinary text.` });
    }
  }
  const tokens = tokenize(input || '');
  const visit = (list) => list.forEach((token) => {
    if (token.type === 'PROX' && token.items.some((item) => item.kind === 'region')) {
      out.push({ level: 'error', text: 'Words in different text regions can’t be near each other. The region inside ( … )~N is ignored.' });
    }
    if (token.type === 'REGION') visit(tokenize(token.inner));
  });
  visit(tokens);
  if (tokens.some((token) => token.type === 'WORD' && token.text === 'IN')) {
    out.push({ level: 'note', text: '“IN” on its own is searched as a word. For a word inside an annotation, use the field: person:adriaan. For a word that is not part of one: batavia NOT IN place:*.' });
  }
  const problem = positionalProblem(parse(input || ''));
  if (problem) {
    out.push({ level: 'error', text: `${problem} has no position in the text, so it can’t be used inside ( … )~N or with NOT IN.` });
  }
  if (tokens.some((token) => token.type === 'REGION')) {
    out.push({ level: 'note', text: 'Headers and margins are not in the search index yet. In this prototype a text region is searched in the whole document.' });
  }
  if (/(^|[\s(":])\*[^\s)*]/.test(unquoted)) {
    out.push({ level: 'note', text: 'A * at the start of a word can make the search slow on the full corpus.' });
  }
  return out;
}

const NOUNS = {
  place: 'place', person: 'person', ship: 'ship', organisation: 'organisation', polity: 'polity', role: 'role',
  profession: 'profession', status: 'status', identity: 'identity', concept: 'concept', annotation: 'event',
};

function describeChip(chip) {
  const def = FIELD_BY_KEY.get(chip.fieldKey);
  const noun = NOUNS[chip.fieldKey] || def.label.toLowerCase();
  if (isAny(chip)) return `any ${noun}`;
  if (chip.fieldKey === 'year') return `dated ${chip.value}`;
  if (chip.fieldKey === 'annotation') return `a ${(ANNOTATION_TYPES[canonicalAnnotationType(chip.value)]?.label || chip.value).toLowerCase()} event`;
  if (chip.id) return `${noun} ${chip.value}`;
  return `${noun} “${chip.value}”`;
}

const describeWords = (words) => words.map((word) => (word.startsWith('"') ? word.replace(/^"|"$/g, '“').replace(/“$/, '”') : `“${word}”`)).join(' and ');

function describeItem(item) {
  if (item.kind === 'word') return `“${item.text}”`;
  if (item.kind === 'phrase') return `“${item.text}”`;
  if (item.kind === 'region') return `(${REGIONS[item.region].label}: ignored)`;
  return describeChip(item);
}

function describe(node) {
  if (!node) return '';
  switch (node.t) {
    case 'words': return describeWords(node.words);
    case 'field': return describeChip(node.chip);
    case 'prox': return `${node.items.map(describeItem).join(', ')} within ${node.slop} words of each other`;
    case 'not': return `not ${describe(node.inner)}`;
    case 'in': return `${describe(node.left)}, but not as part of ${describe(node.right)}`;
    case 'region': return `[in ${REGIONS[node.region].label}: ${describe(node.inner)}]`;
    case 'and': return node.parts.map((part) => (part.t === 'or' ? `(${describe(part)})` : describe(part))).join('; and ');
    case 'or': return node.parts.map(describe).join(', or ');
    default: return '';
  }
}

// One line of plain language: how the bar understood the query.
export function readBack(tree) {
  const text = describe(tree);
  return text ? `Looking for ${text}.` : '';
}
