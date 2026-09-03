from flask import Flask, request, Response, jsonify
import requests

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

    response = requests.post(
        API_URL,
        headers={"Content-Type": "application/json"},
        data=request.data,
    )

    print("Elasticsearch status:", response.status_code)

    return Response(
        response.content,
        status=response.status_code,
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


if __name__ == "__main__":
    app.run(port=5050, debug=True)
