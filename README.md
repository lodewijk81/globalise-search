# GLOBALISE search prototype

This repository contains a temporary search interface for the GLOBALISE corpus. 

The interface is connected to the Elastic search backend behind:
https://transcriptions.globalise.huygens.knaw.nl/

Search results link through to the beta GLOBALISE research portal at:
https://dev.globalise.nl/

It is intentionally a temporary prototype and not the final production experience. 

## What this project does

- searches the GLOBALISE Elasticsearch index
- displays result snippets and metadata
- supports basic sorting and pagination
- links each result to the beta research portal for full contextual viewing

## Query syntax (new index)

The search box in `new-index/` accepts more than plain keywords:

- **Structured filters**: `person:`, `place:`, `profession:`, `documenttype:`
  (alias `type`/`doctype`), `settlement:`, `inventory:` (alias `inv`/`invnr`)
  and `year:` (alias `date`, accepts a single year or a range like
  `1680-1690`). These can also be added as chips via the suggestion dropdown.
- **Wildcards** (`*`, `?`) and **fuzziness** (`~1`, `~2`, or bare `~` for
  `AUTO`), e.g. `timmerman*` or `timmerman~1`.
- **Boolean operators** `AND`, `OR`, `NOT` and parentheses for grouping, e.g.
  `(place:Amsterdam OR place:Deventer) NOT profession:koopman`. `AND` is
  optional between clauses — `NOT` alone already excludes a term.
- **Proximity search**: wrap terms in `(...)~N` to require them within `N`
  words of each other, e.g. `(amsterdam timmerman)~5`. Words inside a
  proximity group may end in `~`/`~N` for a fuzzy match, e.g.
  `(amsterdam~ timmerman)~10`. A structured filter can also be combined with
  free text in the same group, e.g. `(place:Amsterdam timmerman)~5` — since
  Elasticsearch can't natively relate a nested annotation to a free-text
  term's position, the proxy (`new-index/proxy.py`) re-checks the real word
  distance for these mixed groups using the document text and the stored
  annotation offsets.

Result links and thumbnails point at the first scan of a document; documents
that span a scan range (e.g. `NL-HaNA_1.04.02_4059_0491-0492`) are linked
using just the first scan (`..._0491`).

## Local development

The search UI and its proxy both need to run locally. The proxy forwards search
requests to the Elasticsearch backend, which is only reachable from the HuC
domain. Before starting either process, connect to the HuC network through the
VPN or work from one of the participating institutes.

Install the proxy dependencies if needed:

```bash
python3 -m pip install flask requests
```

Then open two terminals. In the first terminal, start the proxy:

```bash
cd /path/to/globalise-search/new-index
python3 proxy.py
```

In the second terminal, start the local search UI:

```bash
cd /path/to/globalise-search/new-index
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000/index.html
```

Keep both terminals running while using the search interface. The proxy listens
on `http://localhost:5050` and the local search UI listens on
`http://localhost:8000`.

## Deployment

This project is configured for GitHub Pages and is intended as a static front-end deployment.

## Notes

- This is a temporary search interface.
- The live viewer and research context remain in the beta GLOBALISE portal at https://dev.globalise.nl/
- The Elasticsearch backend is managed separately and is exposed through the transcriptions site at https://transcriptions.globalise.huygens.knaw.nl/
