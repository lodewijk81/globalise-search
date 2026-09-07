from flask import Flask, request, Response, jsonify
import re
import requests
from itertools import product

app = Flask(__name__)

API_URL = "https://index.globalise.huygens.knaw.nl/documents/_search"

# Mirrors the FIELD_DEFS kinds used in app.js, just enough to build suggestion queries.
SUGGEST_FIELD_DEFS = {
    "person": {"kind": "nested", "type": "Person"},
    "place": {"kind": "nested", "type": "Place"},
    "profession": {"kind": "text", "field": "professionLabelPaths"},
    "documenttype": {"kind": "text", "field": "documentTypeLabelPaths"},
    "settlement": {"kind": "keyword", "field": "settlement"},
    "inventory": {"kind": "keyword", "field": "inventoryNumber"},
}

# --- Proximity search refinement -------------------------------------------------------
# Elasticsearch's span_near can't relate the free-text "text" field to structural
# "observances" annotations (span clauses must all target the same field, and observances
# are a separate nested type). app.js already sends a coarse query that guarantees a document
# contains all the terms; here we re-check real word distance using the stored observance
# "from"/"to" character offsets and the raw document text, since those aren't indexed and
# can't be used in an Elasticsearch query/script directly.

FIELD_NESTED_TYPES = {"person": "Person", "place": "Place"}


def _wildcard_regex(value):
    # Mirrors app.js toWildcardPattern: bare values match anywhere in the label (contains),
    # explicit "*"/"?" are treated as wildcard placeholders.
    if any(ch in value for ch in "*?"):
        pattern = re.escape(value).replace(r"\*", ".*").replace(r"\?", ".")
    else:
        pattern = ".*" + re.escape(value) + ".*"
    return re.compile("^" + pattern + "$", re.IGNORECASE)


def _word_positions(text, value, limit=8):
    pattern = re.compile(r"(?<!\w)" + re.escape(value) + r"(?!\w)", re.IGNORECASE)
    positions = []
    for match in pattern.finditer(text):
        positions.append((match.start(), match.end()))
        if len(positions) >= limit:
            break
    return positions


def _observance_positions(observances, field_key, value, limit=8):
    obs_type = FIELD_NESTED_TYPES.get(field_key)
    if not obs_type:
        return None  # not a text-anchored field (e.g. profession/settlement); can't constrain distance
    regex = _wildcard_regex(value)
    positions = []
    for obs in observances or []:
        if obs.get("type") != obs_type:
            continue
        if regex.match(obs.get("label") or ""):
            positions.append((obs.get("from", 0), obs.get("to", 0)))
            if len(positions) >= limit:
                break
    return positions


def _word_gap(text, span_start, span_end):
    if span_end <= span_start:
        return 0
    return max(len(text[span_start:span_end].split()) - 1, 0)


def _group_satisfied(source, group):
    text = source.get("text") or ""
    observances = source.get("observances") or []
    bounded_lists = []

    for term in group.get("terms", []):
        if term.get("type") == "field":
            positions = _observance_positions(
                observances, term.get("fieldKey"), term.get("value") or ""
            )
        else:
            positions = _word_positions(text, term.get("value") or "")
            if not positions and term.get("fuzzy"):
                # ES matched a fuzzy variant of this word but we can't locate its exact
                # spelling in the raw text, so we can't use it to constrain distance.
                positions = None
        if positions is None:
            continue
        if not positions:
            return False
        bounded_lists.append(positions)

    if len(bounded_lists) < 2:
        return True  # not enough position data to disprove proximity, so let it through

    best_gap = None
    for combo in product(*bounded_lists):
        span_start = min(start for start, _ in combo)
        span_end = max(end for _, end in combo)
        gap = _word_gap(text, span_start, span_end)
        if best_gap is None or gap < best_gap:
            best_gap = gap

    return best_gap is not None and best_gap <= group.get("slop", 0)


def hit_matches_proximity(hit, proximity_groups):
    source = hit.get("_source") or {}
    return all(_group_satisfied(source, group) for group in proximity_groups)


def escape_wildcard(value):
    return value.replace("\\", "\\\\").replace("*", "\\*").replace("?", "\\?")


def build_suggest_query(field_def, prefix):
    wildcard_value = f"{escape_wildcard(prefix)}*"

    if field_def["kind"] == "nested":
        filter_clause = {
            "bool": {
                "filter": [{"term": {"observances.type": field_def["type"]}}],
                "must": [
                    {
                        "wildcard": {
                            "observances.label": {
                                "value": wildcard_value,
                                "case_insensitive": True,
                            }
                        }
                    }
                ],
            }
        }
        return {
            "size": 0,
            "query": {"nested": {"path": "observances", "query": filter_clause}},
            "aggs": {
                "suggestions": {
                    "nested": {"path": "observances"},
                    "aggs": {
                        "filtered": {
                            "filter": filter_clause,
                            "aggs": {
                                "values": {
                                    "terms": {"field": "observances.label", "size": 10}
                                }
                            },
                        }
                    },
                }
            },
        }

    # keyword fields (settlement, inventoryNumber) support a plain terms aggregation directly.
    return {
        "size": 0,
        "query": {
            "wildcard": {
                field_def["field"]: {"value": wildcard_value, "case_insensitive": True}
            }
        },
        "aggs": {"values": {"terms": {"field": field_def["field"], "size": 10}}},
    }


def build_text_suggest_query(field_def, prefix):
    # professionLabelPaths / documentTypeLabelPaths have no keyword sub-field, so we can't
    # aggregate directly. Instead sample matching documents and extract "|"-separated path
    # segments starting with the prefix ourselves.
    return {
        "size": 50,
        "_source": [field_def["field"]],
        "query": {"match_phrase_prefix": {field_def["field"]: prefix}},
    }


def suggestions_from_text_hits(field_def, hits, prefix):
    prefix_lower = prefix.lower()
    counts = {}
    for hit in hits:
        for path in hit.get("_source", {}).get(field_def["field"]) or []:
            for segment in path.split("|"):
                segment = segment.strip()
                if segment.lower().startswith(prefix_lower):
                    counts[segment] = counts.get(segment, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:10]
    return [{"value": value, "count": None} for value, _ in ranked]


def extract_buckets(field_def, es_response):
    aggs = es_response.get("aggregations", {})
    if field_def["kind"] == "nested":
        return (
            aggs.get("suggestions", {})
            .get("filtered", {})
            .get("values", {})
            .get("buckets", [])
        )
    return aggs.get("values", {}).get("buckets", [])


@app.route("/suggest", methods=["POST", "OPTIONS"])
def suggest():
    if request.method == "OPTIONS":
        response = Response(status=204)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    body = request.get_json(silent=True) or {}
    field = body.get("field")
    prefix = (body.get("prefix") or "").strip()

    field_def = SUGGEST_FIELD_DEFS.get(field)
    if not field_def or len(prefix) < 2:
        response = jsonify({"suggestions": []})
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    es_query = (
        build_text_suggest_query(field_def, prefix)
        if field_def["kind"] == "text"
        else build_suggest_query(field_def, prefix)
    )

    es_response = requests.post(
        API_URL,
        headers={"Content-Type": "application/json"},
        json=es_query,
    )

    suggestions = []
    if es_response.ok:
        data = es_response.json()
        if field_def["kind"] == "text":
            suggestions = suggestions_from_text_hits(
                field_def, data.get("hits", {}).get("hits", []), prefix
            )
        else:
            buckets = extract_buckets(field_def, data)
            suggestions = [
                {"value": bucket["key"], "count": bucket["doc_count"]}
                for bucket in buckets
            ]

    response = jsonify({"suggestions": suggestions})
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


@app.route("/search", methods=["POST", "OPTIONS"])
def search():

    # CORS preflight
    if request.method == "OPTIONS":
        response = Response(status=204)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    # Actual search request
    print("Received POST from browser/client")
    print("Request body:", request.data.decode("utf-8"))

    body = request.get_json(silent=True) or {}
    proximity_groups = body.pop("proximity", None)

    if not proximity_groups:
        response = requests.post(
            API_URL,
            headers={"Content-Type": "application/json"},
            json=body,
        )
        print("Elasticsearch status:", response.status_code)
        return Response(
            response.content,
            status=response.status_code,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    # Proximity path: overfetch candidates already coarse-matched by ES, re-check real word
    # distance in Python (see hit_matches_proximity above), then filter/paginate ourselves.
    requested_from = int(body.get("from") or 0)
    requested_size = int(body.get("size") or 10)
    overfetch_size = min(200, max(requested_from + requested_size * 5, 50))

    es_body = dict(body)
    es_body["from"] = 0
    es_body["size"] = overfetch_size

    response = requests.post(
        API_URL,
        headers={"Content-Type": "application/json"},
        json=es_body,
    )
    print("Elasticsearch status:", response.status_code)

    if not response.ok:
        return Response(
            response.content,
            status=response.status_code,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    data = response.json()
    all_hits = data.get("hits", {}).get("hits", [])
    kept_hits = [
        hit for hit in all_hits if hit_matches_proximity(hit, proximity_groups)
    ]
    page_hits = kept_hits[requested_from : requested_from + requested_size]

    result = jsonify(
        {
            "hits": {
                "total": {"value": len(kept_hits), "relation": "eq"},
                "hits": page_hits,
            }
        }
    )
    result.headers["Access-Control-Allow-Origin"] = "*"
    return result


if __name__ == "__main__":
    app.run(port=5050, debug=True)
