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
