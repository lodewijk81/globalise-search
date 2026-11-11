# Query syntax prototype (`unified/proposal/`)

A working prototype of the query syntax proposal for
[glob-portal-infomodel#122](https://github.com/globalise-huygens/glob-portal-infomodel/issues/122).
It shows how searching could **work**. It doesn't show how it should **look**: the visual design is Jona's.
It runs on the same work-in-progress indexes as `unified/`, at `https://search.globalise.nl`.

```bash
cd /path/to/globalise-search
python3 -m http.server 8000
# open http://localhost:8000/unified/proposal/
```

## What it shows

| Proposal | In the prototype |
| --- | --- |
| The search bar does the heavy lifting | One CodeMirror editor, like the portal's search field. A picked suggestion becomes an **inline pill** (`@{field\|id\|label}` in the text), so it can be combined with `AND`, `OR`, `NOT`, brackets and proximity |
| Three kinds of pills | A specific record (picked), any of a kind (`ship:*`, `event:*`), text in a field (`person:adriaan`). Click a pill to switch between them |
| Autocomplete with spaces | `jan pietersz co` keeps narrowing while there are matches. Results are grouped by type, with "Any …" options and the nested Person options from #123 |
| Alternatives in proximity | `(slaa* OR slav* place:Batavia)~5`: terms joined by `OR` inside `( … )~N` are alternatives (`span_or`). `NOT` isn't allowed there, and the bar says so |
| Not as part of | `batavia NOT IN place:*` (an Elasticsearch `span_not` query on `annotatedText`). There is no `IN`: `adriaan IN person:*` would mean the same as `person:adriaan` |
| Text regions | `header:( … )`, `margin:( … )`, `text:( … )` are parsed, highlighted and read back. **The index has no region fields yet**, so they are searched in the whole document, and the page says so |
| `+` menu | Everything you can search with, inserted at the cursor. Organised by thing (document, person, place, ship, organisation, event, concept), each with its properties. The list of properties is data (`THINGS` in `app.js`), so new properties from the indexes can be added there |
| Polities | Treated as organisations: one `organisation:` field and one Organisations tab over both indexes (`setup.js`) |
| English labels | Thesaurus concepts (facets, card tags, suggestions) are shown with their English prefLabel from the JSON-LD in the object store (`labels.js`). The search index only has the Dutch title |
| AND is the default | A faint *and* between terms (*near* inside `( … )~N`). It is not part of the text, and it shows how the bar splits the query, e.g. `person:jan pietersz` is *person “jan” and “pietersz”* |
| Feedback | Syntax highlighting, a plain-language reading of the query, and messages for unclosed brackets or quotes, unknown fields, and slow wildcards |
| Tabs and facets | One query for all tabs, each with a count. Facets filter only the active tab and are remembered per tab. The date carries over. Every facet value has a `+` to move it into the search instead |

## Files

| File | What it holds |
| --- | --- |
| `query.js` | A copy of `../query.js` with the additions above (tokens, `field:*`, `IN`/`NOT IN`, regions, `diagnose`, `readBack`) |
| `editor.js` | The CodeMirror editor: pills, highlighting, undo and redo |
| `suggest.js` | The autocomplete source |
| `setup.js` | Prototype-only changes to `../config.js`: polities as organisations, clearer labels |
| `labels.js` | English labels for thesaurus concepts |
| `app.js` | Page state, tabs, facets per tab, the `+` menu, pill options. Cards and facets come from `../render.js` |
| `../vendor/codemirror.js` | CodeMirror 6 as one ES module (see `../vendor/README.md`) |

## What we learned building it

- `@knaw-huc/searchfield` 0.0.7 (the portal's field) autocompletes one word only (`/\w*/`, so no
  spaces and no `ë`). It doesn't see a `field:` prefix before the cursor, and its grammar has no
  `field:value`, `( … )~N` or `NOT IN`. The prototype therefore uses CodeMirror directly, with the
  same token format.
- `NOT IN` works as a span query on `annotatedText`, because annotations are indexed at
  the positions of their words.
- Specific statuses and identities (weduwe, gevangene, burger, Vrijburger, Chinees, …) are tagged in
  the text like occupations (`personId:<concept>`), so `status:` and `identity:` also search documents
  and work in proximity and with `NOT IN`. Broader ones (juridische status, ethniciteit) are not tagged,
  and *tot slaaf gemaakt* isn't linked: words like *slaven* are tagged as a person without a concept.
- Fields without a position in the text (`title:`, `year:`, `archive:`, …) can't be used in `( … )~N`
  or `NOT IN`; the prototype says so instead of searching something else.
- Some concept ids in the indexes have no thesaurus record or JSON-LD (e.g. `e1bd2a95-…`).
- Only Documents and Persons have facets: the place, ship, organisation, polity and thesaurus indexes hold just `id`, `identifier` and `title`. Persons have no dates yet (`start`/`end` are empty).
- There is no rulership index yet.
- The thesaurus index has one (Dutch) title per concept; the English labels are only in the JSON-LD.
- Persons, ships, organisations and polities have no id in the text yet, so a picked record is
  matched by all of its recorded spellings.
