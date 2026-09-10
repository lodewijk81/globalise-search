# GLOBALISE search prototype

This repository contains two temporary search interfaces for the GLOBALISE corpus:

1. **Root frontend** (`index.html` / `results.html` in the repo root) — queries the
   Elasticsearch backend behind
   [https://transcriptions.globalise.huygens.knaw.nl/](https://transcriptions.globalise.huygens.knaw.nl/)
   and links each result to the beta GLOBALISE research portal at
   [https://dev.globalise.nl/](https://dev.globalise.nl/).
2. **`new-index/` frontend** — queries the newer Elasticsearch index at
   [https://index.globalise.huygens.knaw.nl/](https://index.globalise.huygens.knaw.nl/)
   through the hosted proxy at
   [https://search.globalise.huygens.knaw.nl/](https://search.globalise.huygens.knaw.nl/).
   This version is more advanced than the root frontend, since it also allows querying
   reference data (people, places, professions) and annotations on the corpus, not just
   the plain text. It is actively in development, so further changes are expected.

Neither interface is the final production experience — both are intentionally temporary
prototypes.

## What this project does

- searches the GLOBALISE Elasticsearch index (either backend, depending on which
  frontend is used)
- displays result snippets and metadata
- supports basic sorting and pagination
- links each result to the beta research portal for full contextual viewing
- (`new-index/` only) supports structured filters, boolean/proximity query syntax, and
  suggestion-driven filter chips backed by the corpus's people/place/profession
  annotations

## Query syntax (new-index frontend)

The search box in `new-index/` accepts more than plain keywords:

- **Structured filters**: `person:`, `personname:` (alias `name`), `place:`
  (alias `location`), `profession:`, `documenttype:` (alias `type`/`doctype`),
  `settlement:`, `inventory:` (alias `inv`/`invnr`) and `year:` (alias `date`,
  accepts a single year or a range like `1680-1690`). `person:` matches
  generic, occupation-inferred mentions of a person (e.g. searching on a role
  like "koopman"); `personname:` matches a specific named individual (e.g.
  "Sleuter") and, when picked from a suggestion, matches every recorded
  spelling variant of that person. These can also be added as chips via the
  suggestion dropdown.
- **Typing a filter's value**: while a `field:` value is unquoted, a single
  space keeps you inside that same value — needed for multi-word values like
  `personname:Jogem Hendrik` — and the suggestion dropdown stays open. A
  second consecutive space (or accepting a suggestion) closes that filter and
  starts a new term. Wrapping the value in quotes (`personname:"Jogem
  Hendrik"`) avoids this ambiguity entirely.
- **Wildcards** (`*`, `?`) and **fuzziness** (`~1`, `~2`, or bare `~` for
  `AUTO`), e.g. `timmerman*` or `timmerman~1`.
- **Boolean operators** `AND`, `OR`, `NOT` and parentheses for grouping, e.g.
  `(place:Amsterdam OR place:Deventer) NOT profession:koopman`. `AND` is
  optional between clauses — `NOT` alone already excludes a term.
- **Proximity search**: wrap terms in `(...)~N` to require them within `N`
  words of each other, e.g. `(amsterdam timmerman)~5`. Words inside a
  proximity group may end in `~`/`~N` for a fuzzy match, e.g.
  `(amsterdam~ timmerman)~10`. A structured filter can also be combined with
  free text in the same group, e.g. `(place:Amsterdam timmerman)~5`; see
  "Search logic" below for how this is resolved.

Result links and thumbnails point at the first scan of a document; documents
that span a scan range (e.g. `NL-HaNA_1.04.02_4059_0491-0492`) are linked
using just the first scan (`..._0491`).

## Search logic (`new-index/app.js`)

This section explains how a query typed into the `new-index` search box is turned into
an Elasticsearch request, and how suggestions are produced.

### Two indices, one client

`app.js` talks to two indices behind the proxy:

- `documents` (`.../documents/_search`) — the main corpus index, holding document text,
  metadata (`inventoryNumber`, `settlement`, `startDate`/`endDate`, etc.) and a nested
  `observances` array of annotated Person/Place mentions per document.
- `autocomplete` (`.../autocomplete/_search`) — a separate completion-suggester index
  dedicated to named individuals (e.g. "Jogem Hendrik Sleuter") and their known spelling
  variants. This is distinct from the generic Person mentions inferred from occupation
  words (e.g. "bakker") that live in `documents`.

### Structured fields (`person:`, `place:`, `profession:`, etc.)

Each structured field is defined once (`FIELD_DEFS`) with a `kind` that decides how a
`field:value` chip is turned into an Elasticsearch clause:

- **`nested`** (`person`, `place`) — matched against the `observances` nested field.
  When a value was picked from a suggestion, it carries a resolved entity `id`, and the
  query matches on `observances.id` rather than the literal text — this also catches
  spelling variants and OCR noise sharing the same real-world entity (e.g. "Amsterdam",
  "amsterdam" and "amsterd.m" all resolve to the same id). A manually typed value falls
  back to a case-insensitive wildcard match on `observances.label`.
- **`personname`** — matched as an exact phrase (`match_phrase`) against the free-text
  `text` field, using every known spelling variant of the resolved person when the value
  came from a suggestion.
- **`text`** (`profession`, `documenttype`) — matched with `match` on the label-path
  field, unless the value is a resolved hierarchy level (e.g. picking a category rather
  than a specific profession), in which case a `term` query against a `.tree` sub-field
  matches that level and every more specific value beneath it.
- **`keyword`** (`settlement`, `inventory`) — matched with an exact `term` query when
  possible, or a wildcard query when the value contains `*`/`?` or isn't flagged exact.
- **`year`** — parsed into a `startDate`/`endDate` range query; a bare year or a
  `YYYY-YYYY` range are both accepted.

### Free-text and boolean expressions

The keyword box is run through a small hand-written tokenizer and recursive-descent
parser (`tokenizeQueryExpression` / `parseQueryTokens`) rather than being sent to
Elasticsearch as-is. It recognizes parentheses, `AND`/`OR`/`NOT`, quoted phrases,
`field:value` tokens, and `(...)~N` proximity groups, and builds the equivalent nested
`bool`/`must`/`should`/`must_not` clause tree. Plain runs of words that aren't part of
any structured syntax fall through to a `query_string` query against the `text` field
(`default_operator: AND`). If the parser itself throws, the whole input is used as a
`query_string` query as a fallback.

Proximity groups (`(...)~N`) are compiled into native Elasticsearch `span_near` queries,
not sent anywhere else for processing. A group of plain words becomes a `span_near` of
`span_term`s (or `span_multi`/fuzzy terms). A `field:value` item inside a group is only
resolvable this way for `person`, `place` and `profession` (via `PROXIMITY_OBSERVANCE_TYPE`)
— for these, the client first runs two small aggregation queries against `documents` to
resolve the typed value to a shared entity id and then fetch every literal spelling
recorded under that id, so the span query matches any of them. Fields with no such
mapping (`documenttype`, `personname`, `settlement`, `inventory`, `year`) fall back to
matching the literal typed value as a phrase.

### Suggestions (autocomplete dropdown)

There's no dedicated `/suggest` endpoint — suggestions are produced with one of four
strategies depending on the field's `kind`, all documented in `buildSuggestRequestBody`:

- `nested` fields aggregate on `observances.id`, giving exact corpus-wide counts and one
  clean suggestion per real entity.
- `personname` queries the `autocomplete` index's completion suggester directly.
- `keyword` fields run a plain `terms` aggregation, merging same-value-different-casing
  buckets client-side.
- `text` fields (`profession`, `documenttype`) have no aggregatable sub-field, so the
  client samples up to 300 matching documents and de-duplicates hierarchy levels
  client-side instead — see "Known limitations" below.

### Sorting, results and thumbnails

Every search request is sent to Elasticsearch sorted by `_score` only. "Sort by year" and
"sort by inventory number" are applied **client-side**, re-ordering just the current page
of (up to) 10 fetched results — see "Known limitations" below for what this means in
practice. Each result's viewer link and thumbnail are built from a IIIF manifest fetched
per-document from `data.globalise.huygens.knaw.nl`, pointing into the `dev.globalise.nl`
viewer; documents spanning multiple scans are linked to their first scan only. Highlighted
snippets come from Elasticsearch's `highlight` on the `text` field; for structural-only
queries (e.g. `person:` with no free text) nothing gets highlighted, so the UI falls back
to a plain excerpt of the document text.

## Known limitations

- **"Sort by year/inventory" isn't a real sort.** Since the server-side query always
  sorts by relevance (`_score`), the year/inventory sort options only re-order the 10
  results already on the current page. Paging through a "sorted" result set does not
  give a globally sorted list.
- **Profession/document-type suggestions are approximate.** These fields have no
  aggregatable keyword sub-field or `fielddata` enabled, so suggestions are derived from
  a 300-document sample rather than an exact aggregation; counts reflect "seen in this
  sample," not real corpus-wide frequency, and rare values may not surface at all.
- **Free-text word runs are passed to Elasticsearch's `query_string` syntax largely
  unescaped.** Stray Lucene special characters in a query can produce a parse error or
  unintended query behaviour rather than a clean literal search.
- **Thumbnails are fetched one IIIF manifest per result, uncached, on every render** — up
  to 10 extra requests per results page, adding latency and repeated load on
  `data.globalise.huygens.knaw.nl`.
- **Proximity groups that mix in a `person:`/`place:`/`profession:` term add extra
  round-trips.** Each such item needs two sequential aggregation queries to resolve its
  spelling variants before the main search can run.
- **Parser fallback is silent.** If the boolean/proximity expression fails to parse, the
  raw text is quietly resubmitted as a plain `query_string` query with no indication to
  the user that their structured syntax wasn't understood.
- **Sort direction is fixed** — year sorts descending and inventory number sorts
  ascending only, with no way for the user to reverse either.

## Suggested future improvements

- Enable server-side aggregation (e.g. `fielddata: true`, or a keyword sub-field) on
  `professionLabelPaths.tree` / `documentTypeLabelPaths.tree` so profession/document-type
  suggestions get exact, corpus-wide counts instead of a sampled approximation.
- Move sorting server-side (Elasticsearch `sort` on `inventoryNumber` / `startDate`) so
  sorted results are correct across the whole result set, not just within a page.
- Batch or cache IIIF manifest lookups for thumbnails instead of one fetch per result per
  render.
- Surface parser errors or ambiguous fallbacks to the user instead of silently
  substituting a `query_string` query.
- Add automated tests around the tokenizer/parser, given how much query behaviour now
  depends on it.
- Add a user-facing toggle for sort direction.

## Local development

Both frontends are static sites and can be served locally with any static file server.
For the `new-index/` frontend specifically:

```bash
cd /path/to/globalise-search/new-index
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000/index.html
```

`new-index/` talks directly to the hosted proxy at
`https://search.globalise.huygens.knaw.nl/`, so no local proxy needs to be started or
kept running — just serve the static files and open them in a browser.

## Deployment

This project is configured for GitHub Pages and is intended as a static front-end deployment.

## Notes

- Both interfaces are temporary; `new-index/` is under active development and its query
  behaviour may change.
- The live viewer and research context remain in the beta GLOBALISE portal at https://dev.globalise.nl/
- The root frontend's Elasticsearch backend is managed separately and is exposed through
  the transcriptions site at https://transcriptions.globalise.huygens.knaw.nl/
- The `new-index/` frontend's Elasticsearch backend is exposed through the hosted proxy
  at https://search.globalise.huygens.knaw.nl/