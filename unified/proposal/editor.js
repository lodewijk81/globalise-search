// The search bar of the prototype: a CodeMirror 6 editor, like the portal's search field
// (@knaw-huc/searchfield). A picked suggestion becomes an inline token, `@{field|id|label}`,
// shown as an atomic pill. Unlike searchfield 0.0.7, the autocomplete here also works for
// several words (names with spaces) and knows which field it is completing.

import {
  EditorState, EditorView, keymap, Decoration, ViewPlugin, WidgetType, MatchDecorator, placeholder,
  history, historyKeymap, defaultKeymap, undo, redo, undoDepth, redoDepth,
  autocompletion, startCompletion, closeCompletion, bracketMatching,
} from '../vendor/codemirror.js';
import { FIELD_ALIASES, FIELD_BY_KEY } from '../config.js';
import { ENTITY_TOKEN, REGIONS, decodeToken } from './query.js';

const REGION_NAMES = new Set(Object.values(REGIONS).flatMap((region) => region.aliases));

// --- Pills --------------------------------------------------------------------------------

class PillWidget extends WidgetType {
  constructor(token) {
    super();
    this.token = token;
  }

  eq(other) {
    return other.token.fieldKey === this.token.fieldKey && other.token.id === this.token.id && other.token.value === this.token.value;
  }

  toDOM(view) {
    const def = FIELD_BY_KEY.get(FIELD_ALIASES.get(this.token.fieldKey.toLowerCase()) || '');
    const pill = document.createElement('span');
    pill.className = 'q-pill';
    pill.dataset.field = def?.key || this.token.fieldKey;
    pill.title = `${def?.label || this.token.fieldKey}: ${this.token.value} (${this.token.id}). Click for options.`;
    const kind = document.createElement('span');
    kind.className = 'q-pill-kind';
    kind.textContent = def?.label || this.token.fieldKey;
    const label = document.createElement('span');
    label.className = 'q-pill-label';
    label.textContent = this.token.value;
    const cross = document.createElement('button');
    cross.type = 'button';
    cross.className = 'q-pill-remove';
    cross.textContent = '✕';
    cross.setAttribute('aria-label', `Remove ${this.token.value}`);
    pill.append(kind, label, cross);
    pill.addEventListener('mousedown', (event) => event.preventDefault());
    pill.addEventListener('click', (event) => {
      event.preventDefault();
      const range = pillRange(view, pill);
      if (!range) return;
      if (event.target === cross) {
        view.dispatch({ changes: { from: range.from, to: range.to, insert: '' } });
        view.focus();
        return;
      }
      view.dom.dispatchEvent(new CustomEvent('pillclick', { bubbles: true, detail: { ...range, token: this.token, element: pill } }));
    });
    return pill;
  }

  ignoreEvent() {
    return true;
  }
}

function pillRange(view, element) {
  const pos = view.posAtDOM(element);
  let found = null;
  view.plugin(pillPlugin)?.pills.between(pos, pos + 1, (from, to) => {
    found = { from, to };
  });
  return found;
}

const pillMatcher = new MatchDecorator({
  regexp: ENTITY_TOKEN,
  decoration: (match) => {
    const token = decodeToken(match);
    return token ? Decoration.replace({ widget: new PillWidget(token) }) : null;
  },
});

const pillPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.pills = pillMatcher.createDeco(view);
    }

    update(update) {
      this.pills = pillMatcher.updateDeco(update, this.pills);
    }
  },
  {
    decorations: (plugin) => plugin.pills,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.pills || Decoration.none),
  }
);

// --- Syntax highlighting ------------------------------------------------------------------

const SYNTAX = /(@\{[^}]*\})|("[^"]*"?)|(?<![\w])(NOT\s+IN|AND|OR|NOT)(?![\w])|([A-Za-z]+)\s*:|([()])|(~\d*)|([*?])/g;

const highlighter = new MatchDecorator({
  regexp: SYNTAX,
  decoration: (match) => {
    if (match[1]) return null;
    if (match[2]) return Decoration.mark({ class: 'q-str' });
    if (match[3]) return Decoration.mark({ class: 'q-op' });
    if (match[4]) {
      const name = match[4].toLowerCase();
      if (REGION_NAMES.has(name)) return Decoration.mark({ class: 'q-region' });
      return Decoration.mark({ class: FIELD_ALIASES.has(name) ? 'q-field' : 'q-unknown' });
    }
    if (match[5]) return Decoration.mark({ class: 'q-paren' });
    return Decoration.mark({ class: 'q-mod' });
  },
});

const highlightPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.marks = highlighter.createDeco(view);
    }

    update(update) {
      this.marks = highlighter.updateDeco(update, this.marks);
    }
  },
  { decorations: (plugin) => plugin.marks }
);

// --- Implicit AND -------------------------------------------------------------------------

// Terms next to each other must all occur: show a faint "and" in the gap. Inside ( … )~N the
// gap means "near" instead. The word is a widget, not part of the text.
class ImplicitWidget extends WidgetType {
  constructor(word) {
    super();
    this.word = word;
  }

  eq(other) {
    return other.word === this.word;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'q-implicit';
    span.textContent = this.word;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

const OPERATOR = /^(AND|OR|NOT)$/;

// Positions where an implicit operator sits, with the word to show there.
function implicitGaps(text) {
  const gaps = [];
  const stack = [{ prox: false, last: 'none', end: -1 }];
  const top = () => stack[stack.length - 1];
  const operand = (start, end) => {
    const group = top();
    if (group.last === 'operand' && start > group.end) gaps.push({ pos: group.end, word: group.prox ? 'near' : 'and' });
    group.last = 'operand';
    group.end = end;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      const end = close === -1 ? text.length : close + 1;
      const tail = /^~\d*/.exec(text.slice(end))?.[0] || '';
      operand(i, end + tail.length);
      i = end + tail.length;
    } else if (ch === '(') {
      // Find the matching bracket to see whether this is a proximity group.
      let depth = 0;
      let close = -1;
      for (let j = i; j < text.length; j += 1) {
        if (text[j] === '"') {
          const q = text.indexOf('"', j + 1);
          j = q === -1 ? text.length : q;
        } else if (text[j] === '(') depth += 1;
        else if (text[j] === ')' && (depth -= 1) === 0) {
          close = j;
          break;
        }
      }
      const prox = close !== -1 && /^~\d+/.test(text.slice(close + 1));
      const fieldPrefix = i > 0 && text[i - 1] === ':'; // region:( … ) belongs to the word before it
      if (!fieldPrefix) operand(i, i + 1);
      stack.push({ prox, last: 'none', end: -1, start: i, fieldPrefix });
      i += 1;
    } else if (ch === ')') {
      if (stack.length > 1) stack.pop();
      const tail = /^~\d*/.exec(text.slice(i + 1))?.[0] || '';
      top().end = i + 1 + tail.length;
      top().last = 'operand';
      i += 1 + tail.length;
    } else {
      const word = /^@\{[^}]*\}|^[^\s()"]+/.exec(text.slice(i))[0];
      const quoted = text[i + word.length] === '"' && word.endsWith(':'); // field:"value"
      if (OPERATOR.test(word) || (word === 'IN' && top().last === 'operator')) { // IN only as part of NOT IN
        top().last = 'operator';
        i += word.length;
      } else if (quoted) {
        const close = text.indexOf('"', i + word.length + 1);
        const end = close === -1 ? text.length : close + 1;
        operand(i, end);
        i = end;
      } else if (word.endsWith(':') && text[i + word.length] === '(') {
        operand(i, i + word.length); // region prefix; its group follows
        i += word.length;
      } else {
        operand(i, i + word.length);
        i += word.length;
      }
    }
  }
  return gaps;
}

const implicitPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }

    update(update) {
      if (update.docChanged) this.decorations = this.build(update.view);
    }

    build(view) {
      const gaps = implicitGaps(view.state.doc.toString());
      return Decoration.set(gaps.map((gap) => Decoration.widget({ widget: new ImplicitWidget(gap.word), side: 1 }).range(gap.pos)));
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// --- The editor ---------------------------------------------------------------------------

// options: { doc, placeholderText, completionSource(context), onSubmit(text), onChange(text, history), onPillClick(detail) }
export function createEditor(parent, options) {
  const notify = (state) => options.onChange?.(state.doc.toString(), { canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0 });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc || '',
      extensions: [
        history(),
        EditorView.lineWrapping,
        bracketMatching(),
        placeholder(options.placeholderText || ''),
        pillPlugin,
        highlightPlugin,
        implicitPlugin,
        autocompletion({ override: [options.completionSource], closeOnBlur: true, icons: false, maxRenderedOptions: 40 }),
        keymap.of([
          { key: 'Enter', run: () => (options.onSubmit?.(view.state.doc.toString()), true) },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) notify(update.state);
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'Search', spellcheck: 'false', autocapitalize: 'off' }),
      ],
    }),
  });

  view.dom.addEventListener('pillclick', (event) => options.onPillClick?.(event.detail));

  const api = {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
    },
    // Insert at the cursor with a space on either side where needed. `cursor` is the cursor's
    // offset inside `text` afterwards (default: the end); `complete` opens the suggestions.
    // `raw` inserts without spaces, for modifiers that belong to the word before (`*`, `~1`).
    insert(text, { cursor = text.length, complete = false, raw = false } = {}) {
      const { from, to } = view.state.selection.main;
      const before = view.state.sliceDoc(Math.max(0, from - 1), from);
      const after = view.state.sliceDoc(to, to + 1);
      const lead = !raw && before && !/[\s(]/.test(before) ? ' ' : '';
      const trail = !raw && after && !/[\s)]/.test(after) ? ' ' : '';
      const insert = `${lead}${text}${trail}`;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + lead.length + cursor }, scrollIntoView: true });
      view.focus();
      if (complete) window.setTimeout(() => startCompletion(view), 0);
    },
    replace(from, to, text) {
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      view.focus();
    },
    undo: () => undo(view),
    redo: () => redo(view),
    clear: () => api.setText(''),
    focus: () => view.focus(),
    complete: () => startCompletion(view),
    closeCompletion: () => closeCompletion(view),
  };
  return api;
}
