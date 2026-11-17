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
- The search is then the same tree with every term replaced by `(term OR "variant" OR …)`, on
  the **Documents** tab only: the variants are spellings found in the transcriptions, while the
  other tabs search the curated names of records, which are searched as typed. The variants are
  highlighted in the snippets.
- **Request size.** search.globalise.nl refuses request bodies over about 11,000 bytes (nginx
  answers 500 without CORS headers, so the browser shows a CORS error). So the alternatives are
  merged into one `query_string` (`compactQuery`), and the searches for the tabs are split over
  several `_msearch` requests of at most 8,000 bytes (`msearchBatched`). A single search that is
  still too long (around 10 or more expanded words) gets a message asking to untick variants.
- Under the bar: **Expand words** (on or off), the expanded words with how many variants are on,
  and **Show variants**: checkboxes per word, per method and per variant. A variant suggested by
  both methods goes on or off under both. Every change searches again. The choices are kept in
  the URL (`expand=off`, `expandoff=[…]`).
- If kweepeer can't be reached (5 s timeout), the words are searched as typed and the panel says so.

Example: `slaaf` finds 9,158 documents as typed and 46,921 with its 12 variants (16 November 2026).
The embedding variants are mostly HTR spellings (`slaaff`, `slaafp`) but also include noise
(`Claaf`, `slaaf—`), which is why unticking matters.

## Snippets on their scans

Every snippet on the **Documents** tab shows the number of the scan it is on (`Scan 371`) and a
strip of that scan with the lines it comes from. The scan number, the strip and the snippet text
open the viewer at that scan (`viewerUrl(doc, scan)`). Annotations in the snippet still add
themselves to the search. The code is in `scans.js`.

The documents index stores the text of a whole document without scan boundaries, so the scan is
found like this:

1. **Position.** A `script_fields` script on the document returns where each snippet starts in
   `annotatedText`, as a fraction of its length (one small request per card, in `_msearch`
   batches). A snippet halfway through a 20-scan document is probably on about its 10th scan.
2. **Check.** The transcription of that scan (line and word annotations with outlines,
   `objectstore.surf.nl/…/annotations/transcriptions/<scan>.json`, about 40 KB gzipped) is
   searched for the words around the snippet's first hit. If they are not there, it tries the
   previous snippet's scan, then scans further and further from the guess, up to 30. The guess
   can be well off: tables and empty pages hold little text.
3. **Strip.** The outlines of the matched lines (at most three) give the region, cut out by the
   IIIF image service of the scan (from the inventory's manifest). Long lines across a two-page
   spread are cut to about 2,400 px around the hit.

Cards are worked out when they come near the screen; transcriptions are cached and at most six
are fetched at once. In a test of 4 searches × 10 documents × 3 snippets (17 November 2026), 119
of 120 snippets were located, on average in 70–550 ms per card. The one missed was in a
183-scan document; a snippet that can't be located shows `Scan ?` and links to the first scan.

Notes:
- The hit word is not boxed on the strip: the word outlines in the transcriptions are
  approximate (often a word off). The line outlines are reliable.
- The manifest also has, per scan, a character range in the plain text of the inventory
  (`inventory:<n>.txt`), which would give the scan without guessing. But the ranges don't match
  the published text at the moment (for 4054_0369 they are about 370 characters off), and the
  file is stored gzipped, so it can't be read in parts.

## Facets on the documents tab

Year, settlement, document type and archive. There is no occupation facet on documents (it is
on persons). Document type is always shown: in the index of 5 November 2026 only 24 documents
have a type (`documentTypeIdPaths`), though the document records themselves often have one
(`classified_as`), so it mostly says that there are none yet. A language facet is to follow.
