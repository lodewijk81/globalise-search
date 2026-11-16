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
2. **What's in them, and the reference data.** Persons, places, ships, organisations, events and
   concepts. Each has two rows:
   - *mentioned in documents*: a specific one, any one (`person:*`), and for persons a role,
     occupation, status or appellation as tagged in the text. Opens the Documents tab.
   - *as records*: the same field searched in the reference data (person records by name,
     occupation, status, appellation; places, ships and organisations by name; the concept card on
     the Thesaurus tab). Opens that tab. Events have no records.

The query language has no separate syntax for "mention" versus "record": `person:coen` already
means documents mentioning Coen on the Documents tab and Coen's records on the Persons tab. So the
two rows insert the same text and differ only in the tab they select. When results are showing, that
tab is marked straight away. Combine, Words and Examples are as in version 1.
