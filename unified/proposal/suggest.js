// Autocomplete for the prototype's search bar (a CodeMirror completion source).
//
// - After `field:` it only suggests values of that field, plus "as typed" and "any …".
// - For bare words it suggests records of several types at once, grouped by type, and the
//   search fields whose name matches. Several words are allowed (`jan pietersz co`): a space
//   keeps the suggestions open as long as there are matches.
// - Picking a record inserts an inline token `@{field|id|label}`.

import { ANNOTATION_TYPES, FIELD_BY_KEY, FIELD_DEFS, FIELD_ALIASES } from '../config.js';
import { suggestionsFor } from '../api.js';
import { encodeToken, hasWildcard, REGIONS } from './query.js';
import { formatCount } from '../render.js';
import { startCompletion, closeCompletion } from '../vendor/codemirror.js';
import { englishLabel, loadEnglish } from './labels.js';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;
const MAX_WORDS = 5;
// Bare words are looked up in these fields, in this order.
const BARE_WORD_FIELDS = ['person', 'place', 'ship', 'organisation', 'profession', 'concept'];
// Fields where "any …" makes sense (see ANY_TYPES in query.js).
export const ANY_FIELDS = ['person', 'place', 'ship', 'organisation', 'annotation', 'profession', 'status', 'identity'];
// Jona's nested Person options (#123): the ways to search for persons.
const PERSON_WAYS = [
  { key: 'person', label: 'Person by name', detail: 'a named person, every recorded spelling' },
  { key: 'profession', label: 'Person by occupation', detail: 'e.g. koopman, or a group of occupations' },
  { key: 'status', label: 'Person by status', detail: 'e.g. vrij, tot slaaf gemaakt' },
  { key: 'identity', label: 'Person by ethno-religious appellation', detail: 'e.g. Chinees, Moor' },
  { key: 'role', label: 'Role mentioned in the text', detail: 'a role tagged at that spot, e.g. koopman' },
];

const quote = (value) => (/[\s()]/.test(value) ? `"${value}"` : value);
const anyLabel = (key) => (key === 'annotation' ? 'Any event' : `Any ${FIELD_BY_KEY.get(key).label.toLowerCase()}`);

function wait(context) {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(!context.aborted), DEBOUNCE_MS);
  });
}

function signalFor(context) {
  const controller = new AbortController();
  context.addEventListener?.('abort', () => controller.abort());
  return controller.signal;
}

const countDetail = (item) => {
  const parts = [];
  if (item.count != null) parts.push(`${formatCount(item.count)} ${item.unit || 'results'}`);
  if (item.note) parts.push(item.note);
  return parts.join(' · ');
};

// The lookups don't rank names, so put the ones where every typed word starts a word first
// ("jan pietersz co" → Jan Pietersz Coen before Jan Jacob Pietersz).
function rank(items, typed) {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (item) => {
    const label = String(item.display || item.value).toLowerCase();
    const parts = label.split(/[\s.:,;()-]+/);
    const starts = words.filter((word) => parts.some((part) => part.startsWith(word))).length;
    return starts * 10 + (label.startsWith(typed.toLowerCase()) ? 5 : 0) + (starts === words.length ? 20 : 0);
  };
  return items.map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

// Thesaurus concepts: show the English label, with the Dutch one as a note.
async function withEnglish(def, items) {
  if (def.source !== 'concept' || !items.length) return items;
  await loadEnglish(items.map((item) => item.id));
  return items.map((item) => {
    const en = englishLabel(item.id);
    if (!en || en === item.value) return item;
    return { ...item, display: en, note: [item.value, item.note].filter(Boolean).join(' · ') };
  });
}

function tokenOption(def, item, section) {
  const label = item.display || item.value;
  return {
    label,
    detail: countDetail(item),
    section,
    type: def.key,
    apply: encodeToken(def.key, String(item.id ?? item.value), label),
  };
}

// Inserts text and immediately asks for the next suggestions (e.g. after choosing `person:`).
const applyAndContinue = (text) => (view, completion, from, to) => {
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  window.setTimeout(() => startCompletion(view), 0);
};

// --- After `field:` -----------------------------------------------------------------------

const TRAILING_FIELD = /(^|[\s(])([A-Za-z]+)\s*:\s*("([^"]*)|((?:[^\s()"]|\s(?=[^\s()]))*))$/;

async function fieldCompletions(context, match) {
  const fieldKey = FIELD_ALIASES.get(match[2].toLowerCase());
  const def = FIELD_BY_KEY.get(fieldKey);
  if (!def || def.hidden) return null;
  const value = (match[4] !== undefined ? match[4] : match[5] || '').trim();
  const from = match.index + match[1].length;
  // Keep the name the user typed (`event:` is an alias of the annotation field).
  const typedName = match[2].toLowerCase();
  const name = typedName === 'event' ? 'event' : def.key;
  const prefix = `${name}:`;
  const options = [];
  // `event:` suggests only event and state types, not places, persons or dates.
  const keep = (item) => name !== 'event' || ['event', 'state'].includes(ANNOTATION_TYPES[item.value]?.group);

  if (!value) {
    if (def.key === 'person') {
      PERSON_WAYS.forEach((way, index) => options.push({
        label: way.label, detail: way.detail, section: { name: 'Search for persons', rank: 0 }, boost: 10 - index,
        apply: applyAndContinue(`${way.key}:`),
      }));
    }
    if (ANY_FIELDS.includes(def.key)) {
      options.push({ label: anyLabel(def.key), detail: `${name}:*`, section: { name: 'Any', rank: 1 }, apply: `${name}:* ` });
    }
    if (def.key === 'annotation' || def.source === 'annotation') {
      // Annotation types are a short list: show them straight away.
      const items = await suggestionsFor(def, '', signalFor(context)).catch(() => []);
      items.filter(keep).forEach((item) => options.push(tokenOption(def, item, { name: name === 'event' ? 'Event types' : 'Annotation types', rank: 2 })));
    }
    return options.length ? { from, options, filter: false } : null;
  }

  options.push({ label: `${prefix}${quote(value)}`, detail: hasWildcard(value) ? 'wildcard, as typed' : `${def.label.toLowerCase()} containing this text`, section: { name: 'As typed', rank: 0 }, apply: `${prefix}${quote(value)} ` });
  if (!def.source || hasWildcard(value) || value.length < MIN_CHARS) return { from, options, filter: false };
  if (!(await wait(context))) return null;
  const items = await withEnglish(def, await suggestionsFor(def, value, signalFor(context)).catch(() => []));
  rank(items.filter(keep), value).forEach((item) => options.push(tokenOption(def, item, { name: `${def.label}: pick one`, rank: 1 })));
  return { from, options, filter: false };
}

// --- Bare words ---------------------------------------------------------------------------

// The words typed since the last operator, bracket, quote or pill (at most MAX_WORDS).
function trailingRun(before) {
  if (/\s\s$/.test(before)) return null;
  const cut = Math.max(
    before.lastIndexOf('('), before.lastIndexOf(')'), before.lastIndexOf('"'), before.lastIndexOf('}'),
    ...[...before.matchAll(/(?:^|\s)(?:AND|OR|NOT|IN)(?=\s)/g)].map((m) => m.index + m[0].length)
  );
  let start = cut + 1;
  let run = before.slice(start);
  const lead = run.length - run.trimStart().length;
  start += lead;
  run = run.trim();
  if (!run || /[:~]/.test(run)) return null;
  const words = run.split(' ');
  if (words.length > MAX_WORDS) {
    const keep = words.slice(-MAX_WORDS).join(' ');
    start += run.length - keep.length;
    run = keep;
  }
  if (!/^[\p{L}\p{N}'.\- ]+$/u.test(run)) return null;
  return { run, from: start };
}

async function wordCompletions(context, run) {
  const options = [];
  const single = !run.run.includes(' ');
  const lower = run.run.toLowerCase();

  options.push({
    label: `Search for the words “${run.run}”`, detail: 'plain text, with spelling variants', section: { name: 'Text', rank: 0 },
    apply: (view) => closeCompletion(view),
  });

  if (single) {
    FIELD_DEFS.filter((def) => !def.hidden && [def.key, ...def.aliases].some((name) => name.startsWith(lower))).forEach((def) => {
      options.push({ label: `${def.key}:`, detail: def.hint, section: { name: 'Search fields', rank: 1 }, apply: applyAndContinue(`${def.key}:`) });
      if (ANY_FIELDS.includes(def.key)) options.push({ label: anyLabel(def.key), detail: `${def.key}:*`, section: { name: 'Search fields', rank: 1 }, apply: `${def.key}:* ` });
    });
    Object.entries(REGIONS).filter(([key, region]) => region.aliases.some((name) => name.startsWith(lower))).forEach(([key, region]) => {
      options.push({ label: `${key}:( … )`, detail: `only in ${region.label}`, section: { name: 'Where in the text', rank: 2 }, apply: applyAndContinue(`${key}:(`) });
    });
  }

  if (run.run.length < MIN_CHARS) return { from: run.from, options, filter: false };
  if (!(await wait(context))) return null;
  const signal = signalFor(context);
  const groups = await Promise.all(BARE_WORD_FIELDS.map((key) => {
    const def = FIELD_BY_KEY.get(key);
    return suggestionsFor(def, run.run, signal).then((items) => withEnglish(def, rank(items, run.run).slice(0, 3))).then((items) => ({ def, items })).catch(() => ({ def, items: [] }));
  }));
  if (context.aborted) return null;
  groups.forEach(({ def, items }, index) => {
    items.forEach((item) => options.push(tokenOption(def, item, { name: `${def.label}`, rank: 10 + index })));
  });
  const found = groups.filter(({ items }) => items.length).map(({ def }) => def.key);
  ['person', 'place'].filter((key) => found.includes(key)).forEach((key) => {
    options.push({
      label: `Any ${key} whose name contains “${run.run}”`, detail: `${key}:${quote(run.run)}`, section: { name: 'Text in a field', rank: 30 },
      apply: `${key}:${quote(run.run)} `,
    });
  });
  // Nothing but the "words" line: close, so that the space simply ends the value.
  return options.length > 1 ? { from: run.from, options, filter: false } : null;
}

export async function completionSource(context) {
  const before = context.state.sliceDoc(0, context.pos);
  const field = TRAILING_FIELD.exec(before);
  if (field && !Object.values(REGIONS).some((region) => region.aliases.includes(field[2].toLowerCase()))) {
    return fieldCompletions(context, field);
  }
  const run = trailingRun(before);
  if (!run) return null;
  if (!context.explicit && run.run.length < 1) return null;
  return wordCompletions(context, run);
}
