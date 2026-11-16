# Query syntax prototype, + menu version 2 (`unified/proposal2/`)

The same prototype as [`../proposal/`](../proposal/README.md), with a different **+** menu. Only
`app.js` (the menu part), `index.html` and `proposal2.css` are its own; everything else
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
   Persons tab. So the intro says this once, and each row ends with **records →**, which switches to
   that tab (and searches again if the bar has text). Events have no records. The terms in this part
   keep whichever tab you are on; the "Which documents" terms switch to Documents.

Combine, Words and Examples are as in version 1.
