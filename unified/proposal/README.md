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
| English labels | Thesaurus concepts (facets, card tags, suggestions) are shown with their English prefLabel from the JSON-LD in the object store (`labels.js`). The search index lists all labels in one `title` field, without saying which is preferred or in which language |
| Concept suggestions | Occupation, status, identity, role, document type and thesaurus suggestions come from the thesaurus index, limited to the branches of the thesaurus that field uses. Each one is counted in documents and persons with the same clauses the search uses, and concepts that would find nothing are left out (`concept:` still offers a few, marked *thesaurus only*, because it also searches the Thesaurus tab). A label other than the main one that matched the typed text is shown (*matches “…”*) |
| Hierarchy in suggestions | Below the matches: the broader concepts of the best match, and its most used narrower ones, each with counts, so a whole group or a more specific concept can be picked. The side panel of a highlighted concept shows its place in the thesaurus and a definition |
| Concept cards | The Thesaurus tab shows every label, the broader concepts (clickable, one line per place in the hierarchy), narrower concepts, definitions with their sources, related terms, links to Getty AAT, Wikidata and other vocabularies, and where the concept is used (`conceptcard.js`) |
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
| `concepts.js` | Concept suggestions, counts and hierarchy from the thesaurus index; parsing definitions and external matches |
| `conceptcard.js` | The cards on the Thesaurus tab |
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
- Only Documents and Persons have facets. Since 13 November 2026 the thesaurus index has labels, definitions, external matches, `related` and hierarchy paths (`facets.concept_hierarchy`); the place, ship, organisation and polity indexes have the same fields, mostly empty. Persons have no dates yet (`start`/`end` are empty).
- On 13 November 2026 the thesaurus index had 2,634 concepts (8,705 before), and most occupation,
  status and identity concepts used in persons and documents were missing from it (e.g. *ambtenaar*).
  Those can't be suggested, though their labels still come from the object store.
- In the thesaurus index, definitions (`description`) are stored but not searchable, `related` holds
  labels rather than ids, and the concept schemes themselves have no records, so they have no names.
- For documents, a broader status or identity finds only places tagged with exactly that concept,
  not with its narrower ones (the text holds `personId:<concept>`, without paths).
- There is no rulership index yet.
- The thesaurus index doesn't say which label is preferred or what language each label is in; that is only in the JSON-LD.
- Persons, ships, organisations and polities have no id in the text yet, so a picked record is
  matched by all of its recorded spellings.
