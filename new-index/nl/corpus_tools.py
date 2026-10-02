"""Corpus-grounding tools for the natural-language search experiment.

Everything the LLM is allowed to "know" about the corpus comes through here:
Word2Vec neighbours (spelling variants and related vocabulary, trained on the HTR text),
document frequencies from the live Elasticsearch index, and entity lookups against the
`observances` annotations. None of this needs an API key, so it can be tested on its own:

    python corpus_tools.py peper slaven
"""

import difflib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote, urlencode

import requests

ES_BASE = "https://search.globalise.huygens.knaw.nl/documents"
SEARCH_URL = f"{ES_BASE}/_search"
MSEARCH_URL = f"{ES_BASE}/_msearch"

# Word2Vec neighbours whose spelling is at least this similar to the query word are treated as
# spelling/HTR variants of it (peper → peeper, ceylon → ceijlon) rather than related concepts
# (peper → foelie). Tuned by eye on the GLOBALISE_100 model; see README.
VARIANT_SPELLING_SIMILARITY = 0.6
# ...and differs in length by at most this much — otherwise compounds that merely contain the
# word (peper → salpeter, a different commodity) would count as variants.
VARIANT_MAX_LENGTH_DIFFERENCE = 2
# Neighbours shorter than this are mostly line-break fragments of longer words ("pper", "bata").
MIN_TERM_LENGTH = 4

SAFE_TERM = re.compile(r"^[\w*?\- ]+$", re.UNICODE)


# --- Word2Vec ---------------------------------------------------------------------------

_kv = None


def load_word2vec():
    """Loads the model once. The raw text model takes ~40s to parse, so on first load it's
    converted to gensim's native format next to this file (.cache/), which then mmaps in ~2s."""
    global _kv
    if _kv is not None:
        return _kv
    from gensim.models import KeyedVectors

    source = Path(os.environ["WORD2VEC_PATH"]).expanduser()
    cache_dir = Path(__file__).parent / ".cache"
    cached = cache_dir / (source.stem + ".kv")
    if cached.exists():
        _kv = KeyedVectors.load(str(cached), mmap="r")
    else:
        print(f"Converting {source} to {cached} (one-off, ~1 minute)…", flush=True)
        _kv = KeyedVectors.load_word2vec_format(str(source), binary=False)
        cache_dir.mkdir(exist_ok=True)
        _kv.save(str(cached))
    return _kv


def looks_like_spelling_variant(a, b):
    return (
        abs(len(a) - len(b)) <= VARIANT_MAX_LENGTH_DIFFERENCE
        and difflib.SequenceMatcher(None, a, b).ratio() >= VARIANT_SPELLING_SIMILARITY
    )


# --- Elasticsearch helpers ---------------------------------------------------------------


def es_search(body, timeout=30):
    response = requests.post(SEARCH_URL, json=body, timeout=timeout)
    response.raise_for_status()
    return response.json()


def es_msearch(bodies, timeout=30):
    lines = []
    for body in bodies:
        lines.append("{}")
        lines.append(json.dumps(body))
    response = requests.post(
        MSEARCH_URL,
        data="\n".join(lines) + "\n",
        headers={"Content-Type": "application/x-ndjson"},
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()["responses"]


def text_clause(term):
    """How a single free-text term is matched — kept equivalent to what results.html does with
    the generated query string, so counts shown here match what the user gets there."""
    term = term.strip().lower()
    if "*" in term or "?" in term:
        return {"wildcard": {"text": {"value": term, "case_insensitive": True}}}
    if " " in term:
        return {"match_phrase": {"text": term}}
    return {"match": {"text": term}}


def term_doc_counts(terms):
    """Number of documents containing each term (single words, "multi word phrases", or
    wildcard patterns like peper*)."""
    terms = [t for t in dict.fromkeys(t.strip().lower() for t in terms) if t]
    if not terms:
        return {}
    responses = es_msearch(
        [{"size": 0, "track_total_hits": True, "query": text_clause(t)} for t in terms]
    )
    return {
        term: (resp.get("hits", {}).get("total", {}).get("value") if "error" not in resp else None)
        for term, resp in zip(terms, responses)
    }


# --- Tools exposed to the LLM -------------------------------------------------------------


def related_terms(word, topn=25):
    """Word2Vec neighbours of `word`, split into likely spelling variants vs. related words,
    each with its document frequency in the index."""
    kv = load_word2vec()
    word = word.strip().lower()
    if word not in kv.key_to_index:
        return {
            "word": word,
            "in_vocabulary": False,
            "note": "Not in the corpus vocabulary. If this is an English or modern-Dutch word, "
            "translate it to 17th/18th-century Dutch first and try again.",
        }
    neighbours = [
        (n, s) for n, s in kv.most_similar(word, topn=topn * 2) if len(n) >= MIN_TERM_LENGTH
    ][:topn]
    counts = term_doc_counts([word] + [n for n, _ in neighbours])
    variants, related = [], []
    for n, s in neighbours:
        entry = {"term": n, "similarity": round(float(s), 2), "doc_count": counts.get(n)}
        if looks_like_spelling_variant(word, n):
            variants.append(entry)
        else:
            related.append(entry)
    return {
        "word": word,
        "in_vocabulary": True,
        "doc_count": counts.get(word),
        "likely_spelling_variants": variants,
        "related_words": related,
    }


def term_counts(terms):
    return {"doc_counts": term_doc_counts(terms)}


def resolve_entity(entity_type, name, size=8):
    """Looks up annotated Place or Person (role/occupation) entities whose label contains
    `name`, grouped by the shared entity id that links all spelling variants together."""
    entity_type = {"place": "Place", "person": "Person"}.get(entity_type.lower(), entity_type)
    label_filter = [
        {"term": {"observances.type": entity_type}},
        {
            "wildcard": {
                "observances.label": {
                    "value": f"*{name.strip().lower()}*",
                    "case_insensitive": True,
                }
            }
        },
    ]
    data = es_search(
        {
            "size": 0,
            "aggs": {
                "obs": {
                    "nested": {"path": "observances"},
                    "aggs": {
                        "filtered": {
                            "filter": {"bool": {"filter": label_filter}},
                            "aggs": {
                                "by_id": {
                                    "terms": {"field": "observances.id", "size": size},
                                    "aggs": {
                                        "labels": {"terms": {"field": "observances.label", "size": 5}},
                                        "docs": {"reverse_nested": {}},
                                    },
                                }
                            },
                        }
                    },
                }
            },
        }
    )
    buckets = data["aggregations"]["obs"]["filtered"]["by_id"]["buckets"]
    return {
        "type": entity_type,
        "query": name,
        "candidates": [
            {
                "id": b["key"],
                "labels": [l["key"] for l in b["labels"]["buckets"]],
                "doc_count": b["docs"]["doc_count"],
            }
            for b in buckets
        ],
    }


# --- The structured query ------------------------------------------------------------------
#
# The LLM's final answer (and the frontend's edits to it) use this shape:
#   {
#     "concepts":   [{"label": "pepper", "terms": ["peper", "peeper"]}],   # AND across, OR within
#     "places":     [{"label": "Ceylon", "id": "GLOB_..."}],                # each required
#     "persons":    [{"label": "koopman", "id": "..."}],                    # roles/occupations
#     "settlements": ["Ceylon"],                                            # any of these
#     "year_from": 1680, "year_to": 1700
#   }


def clean_terms(terms):
    out = []
    for t in terms or []:
        t = " ".join(str(t).lower().split())
        # "and"/"or"/"not" would be read as boolean operators by the results page's parser.
        if t and SAFE_TERM.match(t) and t not in ("and", "or", "not") and t not in out:
            out.append(t)
    return out


def nested_entity_clause(entity_type, entity_id):
    return {
        "nested": {
            "path": "observances",
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"observances.type": entity_type}},
                        {"term": {"observances.id": entity_id}},
                    ]
                }
            },
        }
    }


def year_clause(year_from, year_to):
    year_from = year_from or year_to
    year_to = year_to or year_from
    if not year_from:
        return None
    return {
        "bool": {
            "filter": [
                {"range": {"startDate": {"lte": f"{int(year_to)}-12-31"}}},
                {"range": {"endDate": {"gte": f"{int(year_from)}-01-01"}}},
            ]
        }
    }


def structured_to_es(sq):
    must = []
    for concept in sq.get("concepts") or []:
        terms = clean_terms(concept.get("terms"))
        if terms:
            must.append(
                {"bool": {"should": [text_clause(t) for t in terms], "minimum_should_match": 1}}
            )
    for place in sq.get("places") or []:
        if place.get("id"):
            must.append(nested_entity_clause("Place", place["id"]))
    for person in sq.get("persons") or []:
        if person.get("id"):
            must.append(nested_entity_clause("Person", person["id"]))
    settlements = [s for s in sq.get("settlements") or [] if s]
    if settlements:
        # Same as results.html does for a typed settlement:value — a case-insensitive
        # "contains" wildcard (so "Ban" would also match "Bantam"; the LLM is told to use full names).
        must.append(
            {
                "bool": {
                    "should": [
                        {"wildcard": {"settlement": {"value": f"*{s}*", "case_insensitive": True}}}
                        for s in settlements
                    ],
                    "minimum_should_match": 1,
                }
            }
        )
    yc = year_clause(sq.get("year_from"), sq.get("year_to"))
    if yc:
        must.append(yc)
    return {"bool": {"must": must}} if must else {"match_all": {}}


def preview(sq, size=5):
    """Total hit count plus the top few highlighted snippets for a structured query."""
    query = structured_to_es(sq)
    highlight_terms = [t for c in sq.get("concepts") or [] for t in clean_terms(c.get("terms"))]
    body = {
        "size": size,
        "track_total_hits": True,
        "_source": ["name", "startDate", "endDate", "settlement", "inventoryNumber"],
        "query": query,
    }
    if highlight_terms:
        body["highlight"] = {
            "fields": {"text": {"number_of_fragments": 2, "fragment_size": 160}},
            "highlight_query": {
                "bool": {"should": [text_clause(t) for t in highlight_terms]}
            },
            "pre_tags": ["<mark>"],
            "post_tags": ["</mark>"],
        }
    data = es_search(body)
    return {
        "total": data["hits"]["total"]["value"],
        "hits": [
            {
                "name": h["_source"].get("name"),
                "year": (h["_source"].get("startDate") or "")[:4],
                "settlement": h["_source"].get("settlement"),
                "inventory": h["_source"].get("inventoryNumber"),
                "snippets": h.get("highlight", {}).get("text", []),
            }
            for h in data["hits"]["hits"]
        ],
    }


def preview_query(sq):
    """LLM-facing version of preview(): shorter snippets, plain text."""
    result = preview(sq, size=5)
    for hit in result["hits"]:
        hit["snippets"] = [re.sub(r"</?mark>", "**", s) for s in hit["snippets"]]
    return result


# --- Link to the existing results page ---------------------------------------------------


def encode_uri_component(value):
    return quote(str(value), safe="-_.!~*'()")


def structured_to_results_params(sq):
    """Translates the structured query into the `q` + `filters` URL parameters that
    new-index/results.html already understands, so the generated search can be opened, edited
    and shared there. Concepts become `(a OR b)` groups in `q`; resolved places/persons become
    chips carrying their entity id (same encoding as encodeChips in app.js)."""
    q_parts = []
    for concept in sq.get("concepts") or []:
        terms = [f'"{t}"' if " " in t else t for t in clean_terms(concept.get("terms"))]
        if len(terms) == 1:
            q_parts.append(terms[0])
        elif terms:
            q_parts.append("(" + " OR ".join(terms) + ")")

    chips = []
    for key, items in (("place", sq.get("places")), ("person", sq.get("persons"))):
        for item in items or []:
            if item.get("id"):
                payload = json.dumps(
                    {"value": item.get("label") or item["id"], "id": item["id"]},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                chips.append(f"{key}:{encode_uri_component(payload)}")

    settlements = [s for s in sq.get("settlements") or [] if s]
    if len(settlements) == 1:
        chips.append(f"settlement:{encode_uri_component(settlements[0])}")
    elif settlements:
        # Chips are ANDed together, so "any of these settlements" has to go in the query text.
        q_parts.append("(" + " OR ".join(f'settlement:"{s}"' for s in settlements) + ")")

    year_from, year_to = sq.get("year_from"), sq.get("year_to")
    if year_from or year_to:
        year_from, year_to = year_from or year_to, year_to or year_from
        value = str(year_from) if year_from == year_to else f"{year_from}-{year_to}"
        chips.append(f"year:{value}")

    params = {}
    if q_parts:
        # Adjacent groups are already ANDed by app.js's parser; the explicit AND is for readability.
        params["q"] = " AND ".join(q_parts)
    if chips:
        params["filters"] = "|".join(chips)
    return params


def results_url(sq, base="../results.html"):
    params = structured_to_results_params(sq)
    return f"{base}?{urlencode(params)}" if params else base


# --- Schema card (static facts about the index, for the system prompt) ---------------------


def build_schema_card():
    data = es_search(
        {
            "size": 0,
            "track_total_hits": True,
            "aggs": {
                "settlements": {"terms": {"field": "settlement", "size": 100}},
                "no_settlement": {"missing": {"field": "settlement"}},
            },
        }
    )
    total = data["hits"]["total"]["value"]
    buckets = data["aggregations"]["settlements"]["buckets"]
    without = sum(b["doc_count"] for b in buckets if not b["key"]) + data["aggregations"][
        "no_settlement"
    ]["doc_count"]
    settlements = sorted(
        ((b["key"], b["doc_count"]) for b in buckets if b["key"]), key=lambda kv: -kv[1]
    )
    return {"total_documents": total, "documents_without_settlement": without, "settlements": settlements}


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
    for w in sys.argv[1:] or ["peper"]:
        print(json.dumps(related_terms(w), ensure_ascii=False, indent=1))
