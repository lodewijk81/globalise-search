# Search everything (`unified/`)

One search box over all the new indices at `https://search.globalise.nl`. It is a static page
that talks straight to Elasticsearch, so any file server will do:

```bash
cd /path/to/globalise-search
python3 -m http.server 8000
# then open http://localhost:8000/unified/index.html
```

| File | What it holds |
| --- | --- |
| `config.js` | The indices, the filter pills, the annotation types, the sort options |
| `query.js` | Parses the box into a tree and compiles it for each index (no DOM, no network) |
| `api.js` | Requests, label lookups, pill suggestions, facet definitions |
| `render.js` | Cards, facets and annotated text as HTML |
| `app.js` | Page state, the search box, click handling |

## How the indexed fields are used

| Index | Field | Used for |
| --- | --- | --- |
| `documents` | `annotatedText` | Free text, wildcards, fuzzy, phrases, proximity; `place:`, `role:`, `annotation:` pills; coloured annotations in snippets and in the reader |
| | `title` | Card title, `title:` pill |
| | `startDate`, `endDate` | `year:` pill, decade chart, sorting |
| | `settlement` | `settlement:` pill and facet |
| | `inventoryNumber` | `inventory:` pill, sorting, viewer link |
| | `professionIdPaths` | `profession:` pill (includes everything below that level) and facet; list in the reader |
| | `documentTypeIdPaths` | `documenttype:` pill, facet, tags on the card |
| | `eadIdPaths`, `archiveDescription` | `archive:` pill, archive tree facet, breadcrumb on the card |
| | `scanCount` | Card, sorting |
| | `name`, `identifier` | Card, viewer link and thumbnail |
| `persons` | `titles` | Free text, `person:` pill, all spellings on the card |
| | `occupations`, `occupationIdPaths` | `profession:` pill, facet, tags |
| | `statuses`, `statusIdPaths` | `status:` pill, facet, tags |
| | `identities`, `identityIdPaths` | `identity:` pill, facet, tags |
| | `relations` | Links between person cards |
| Object indices | `title`, `identifier`, `id` | Search, pill suggestions, "Find in documents", record link |
| `thesaurus-objects` | `title` | Labels for every id above, `concept:` pill, usage counts per concept |

Not used yet: `dateBucket` is empty in the documents index, and `start` / `end` are empty in
the persons index. New fields on the object indices appear on the cards automatically.

## How pills become queries

- `annotatedText` holds the transcription with annotations such as
  `[Amsterdam](type%3APlace&placeId%3AGLOB2_937)`. Each annotation is indexed at the same
  position as its words, so `term: "placeId:GLOB2_937"` finds it and it can take part in
  `span_near` proximity directly.
- A pill picked from a suggestion carries the record's id. A typed pill has only text:
  concept pills look up the id first (`resolveChips`), and `place:Amster*` matches that
  spelling wherever it is tagged as a Place.
- The annotated highlighter adds `_hit_term=` to matching annotations. `render.js` turns that
  into `<mark>`, and counting those gives the matches per document.

## Good to know

- **Place records have one title, often a period spelling.** Amsterdam's is "Aemsteldam",
  so `place:` suggestions also ask the corpus which ids a typed spelling is tagged with.
- **Persons, ships, organisations and polities have no id in the text** (`personId` holds
  role concepts such as *koopman*). These pills match by name across every recorded spelling,
  so a ship called after a common word will also find that word.
- Inventory sorting is text order: `inventoryNumber` is a keyword and the server blocks scripts.
- Results can be paged through up to 10,000 per search, an Elasticsearch limit.
- A very short wildcard such as `pe*` also matches the annotation terms (`personId:…`).
