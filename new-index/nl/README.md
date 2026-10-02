# Natural-language search (experiment)

Ask a question in English or Dutch ("Pepper trade on the Malabar coast in the 1680s",
"Brieven over gevluchte slaven op Ceylon"). An LLM translates it into a structured
search over the `new-index` Elasticsearch index. The result can be edited, and opened in the
existing `results.html`.

This runs **locally only**. It needs an LLM API key (Anthropic and/or Scaleway) and the GLOBALISE Word2Vec model,
neither of which can live on the static GitHub Pages site.

## Setup

```bash
cd new-index/nl
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then fill in ANTHROPIC_API_KEY and WORD2VEC_PATH
.venv/bin/python server.py
```

Then open <http://localhost:5055/>. The first start converts the 1.7 GB text model to gensim's
format in `.cache/`, which takes about a minute. After that the model loads in seconds.

## How it works

The hard part is vocabulary. The corpus is 17th/18th-century Dutch with HTR noise, so
modern or English words find little (`koffie`: 237 documents; `coffij`: 23,336). The LLM
therefore isn't trusted to know the corpus. It proposes terms and checks them through tools
(`corpus_tools.py`):

| Tool | What it gives the LLM |
|---|---|
| `related_terms` | Word2Vec neighbours from the model trained on the HTR text, split into likely spelling variants (similar spelling) and related words, each with a document count |
| `term_counts` | Document frequency of candidate terms in the live index |
| `resolve_entity` | Annotated places / person roles matching a name, with the entity id that groups their spelling variants |
| `preview_query` | Total hits and top-5 snippets for a candidate query, so it can loosen or tighten the query |

Its final answer is JSON: concepts (OR within, AND across), places, person roles,
settlements and a year range. `server.py` adds per-term counts, a preview, and a link to
`../results.html` using the same `q`/`filters` encoding as `app.js`. On the page you can untick
or add terms and remove filters, and the count and link update.

Each run is appended to `logs/YYYY-MM-DD.jsonl` (gitignored), with the question, the answer,
the full tool trace and token usage, for building an evaluation set later.

## Choosing a model

The page has a model picker, so the same question can be compared across models. Each run is
logged with the model it used. Models whose API key is missing are shown but disabled.

| Model | Provider | Notes |
|---|---|---|
| Claude Opus 5.5 | Anthropic | Default. Final answer is schema-constrained JSON |
| Claude Sonnet 5.5 | Anthropic | Faster and cheaper |
| Qwen3.5 397B | Scaleway | Recommended open-weight alternative: large and strongly multilingual |
| GLM-5.2 | Scaleway | Scaleway's strongest open-weight model for agentic work; mainly trained on English/Chinese |
| Mistral Medium 3.5 | Scaleway | European model |
| DeepSeek V4 Flash | Scaleway | Cheapest of the four |

Scaleway's Generative APIs are OpenAI-compatible (`https://api.scaleway.ai/v1`). Those models give
their final answer by calling a `submit_answer` tool rather than through a response format,
because combining tools and JSON output isn't reliable across open models. To add or change a
model, edit `MODELS` in `agent.py`. Model ids must match
[Scaleway's catalogue](https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/).

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | for the Claude models |
| `SCW_SECRET_KEY` | – | for the Scaleway models |
| `WORD2VEC_PATH` | – | required; plain-text word2vec file |
| `LLM_MODEL` | `claude-opus-5-5` | model preselected on the page |
| `LLM_EFFORT` | `medium` | Claude models only: `low` is faster and cheaper; `high` may pick terms more carefully |
| `PORT` | `5055` | |

## Known limitations

- **No `profession:` / `documenttype:` filters.** The index now stores these as id paths
  (`professionIdPaths`, `documentTypeIdPaths`) without labels, so there's nothing to map a
  word to. Note this also breaks those two filters in the main `new-index` interface, which still
  queries the old `professionLabelPaths` / `documentTypeLabelPaths` fields. Person *roles*
  (koopman, predikant…) are still available, via the `observances` annotations.
- **No named individuals** (`personname:`). These live in the separate `autocomplete` index
  and aren't exposed as a tool yet.
- **Slow-ish:** one question takes several LLM rounds plus Elasticsearch calls, typically
  tens of seconds.
- **Word2Vec "variants" are a heuristic** (spelling similarity plus a length check).
  Line-break fragments like `pper` and look-alikes like `paper` still come through, and the
  LLM is told to judge them.
- **Settlement filters** use the same case-insensitive "contains" match as `results.html`.
