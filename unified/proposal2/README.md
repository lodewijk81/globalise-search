# Query syntax prototype, + menu version 2 (`unified/proposal2/`)

The same prototype as [`../proposal/`](../proposal/README.md), with a different **+** menu and
query expansion. Only `app.js` (the menu and the expansion panel), `expansion.js`, `index.html` and
`proposal2.css` are its own; everything else
(query parsing, editor, suggestions, concept cards, `setup.js`) is imported from `../proposal/`, so
fixes there apply here too.

```bash
cd /path/to/globalise-search
python3 -m http.server 8000
# open http://localhost:8000/unified/proposal2/
```

## The menu

The structural terms are split in two:

1. **Which documents.** Properties of the document itself: a specific document (title words,
   inventory number), a document type, a period (`year:`), a part of the archive (`archive:`,
   `settlement:`), and the part of each document to search in (`header:( … )` etc.). These narrow
   down documents only; the other tabs show *–* when they are used.
2. **What's in them, and the reference data.** One row per kind of thing: persons (a specific one,
   any, role, occupation, status, appellation), places, ships, organisations, events and concepts.
   The terms find mentions in the documents. The query language has no separate syntax for records:
   `person:coen` means documents mentioning Coen on the Documents tab and Coen's records on the
   Persons tab. The intro says this once; the tabs above the results take you to the records. Events
   have no records. The terms in this part
   keep whichever tab you are on; the "Which documents" terms switch to Documents.

Combine and Words are as in version 1; the examples are left out.

## Query expansion

As on dev.globalise.nl/search, typed words are expanded with spelling variants and synonyms from
[kweepeer](https://kweepeer.globalise.nl) (the INT Historisch Lexicon and the GLOBALISE word
embeddings). dev.globalise.nl uses `kweepeer.dev.huc.knaw.nl`; this prototype uses
`kweepeer.globalise.nl`.

- **Only lexical terms are expanded**: plain words and `"phrases"`, also inside `( … )~N`,
  regions and after `NOT`. Fields and picked records (`person:coen`), wildcards (`slaa*`), fuzzy
  words (`timmerman~1`), numbers and both sides of `NOT IN` (a single span query) are not.
  kweepeer's own parser reads `person:coen` as words and drops wildcards, so `expansion.js` sends
  it one term at a time from our own parse tree. Results are cached per term.
- The search is then the same tree with every term replaced by `(term OR "variant" OR …)`. The
  variants apply on every tab and are highlighted in the snippets.
- Under the bar: **Expand words** (on or off), the expanded words with how many variants are on,
  and **Show variants**: checkboxes per word, per method and per variant. A variant suggested by
  both methods goes on or off under both. Every change searches again. The choices are kept in
  the URL (`expand=off`, `expandoff=[…]`).
- If kweepeer can't be reached (5 s timeout), the words are searched as typed and the panel says so.

Example: `slaaf` finds 9,158 documents as typed and 46,921 with its 12 variants (16 November 2026).
The embedding variants are mostly HTR spellings (`slaaff`, `slaafp`) but also include noise
(`Claaf`, `slaaf—`), which is why unticking matters.
