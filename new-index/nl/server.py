"""Local server for the natural-language search experiment.

Serves the whole repository as static files (so the NL page can link straight into
../results.html) plus two JSON endpoints:

  GET  /api/models                        → selectable LLMs and whether their API key is set
  POST /api/nl-query  {"question": "...", "model": "..."}
                                           → LLM translation + counts + preview + results link
  POST /api/compile   {"query": {...}}     → counts + preview + results link for an edited query

Run:  .venv/bin/python server.py   then open http://localhost:5055/
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path

import anthropic
import openai
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
load_dotenv(HERE / ".env")

import corpus_tools as ct  # noqa: E402  (needs WORD2VEC_PATH from .env)
from agent import MODELS, NLSearchAgent, available_models  # noqa: E402

LOG_DIR = HERE / "logs"
RESULTS_PAGE = "../results.html"  # relative to /new-index/nl/

app = Flask(__name__, static_folder=str(REPO_ROOT), static_url_path="")
agent = None


def enrich(sq):
    """Adds what the page needs on top of a structured query: per-term document counts, the
    results.html link, and a preview of the top hits."""
    all_terms = [t for c in sq.get("concepts") or [] for t in ct.clean_terms(c.get("terms"))]
    counts = ct.term_doc_counts(all_terms)
    return {
        "concept_counts": {t: counts.get(t) for t in all_terms},
        "results_params": ct.structured_to_results_params(sq),
        "results_url": ct.results_url(sq, base=RESULTS_PAGE),
        "preview": ct.preview(sq),
    }


def log_run(record):
    LOG_DIR.mkdir(exist_ok=True)
    with open(LOG_DIR / f"{datetime.now():%Y-%m-%d}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


@app.before_request
def block_private_files():
    # The static root is the whole repo: never serve .env, .venv, .cache, .git or the logs.
    parts = request.path.strip("/").split("/")
    if any(p.startswith(".") for p in parts) or "logs" in parts or request.path.endswith(".py"):
        return "Not found", 404


@app.get("/")
def home():
    return redirect("/new-index/nl/")


@app.get("/new-index/nl/")
def nl_page():
    return app.send_static_file("new-index/nl/index.html")


@app.get("/api/models")
def models():
    return jsonify({"models": available_models(), "default": agent.default_model})


@app.post("/api/nl-query")
def nl_query():
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    model_id = body.get("model") or agent.default_model
    if not question:
        return jsonify({"error": "Empty question."}), 400
    if len(question) > 1000:
        return jsonify({"error": "Question is too long (max 1000 characters)."}), 400
    if model_id not in MODELS:
        return jsonify({"error": f"Unknown model: {model_id}"}), 400

    key_name = "ANTHROPIC_API_KEY" if MODELS[model_id]["provider"] == "anthropic" else "SCW_SECRET_KEY"
    if not any(m["id"] == model_id and m["available"] for m in available_models()):
        return jsonify({"error": f"No API key for this model — set {key_name} in new-index/nl/.env and restart."}), 400
    started = time.time()
    try:
        answer, trace, usage = agent.translate(question, model_id)
    except (anthropic.AuthenticationError, openai.AuthenticationError):
        return jsonify({"error": f"Invalid API key — check {key_name} in new-index/nl/.env."}), 500
    except openai.PermissionDeniedError:
        return jsonify(
            {"error": f"Scaleway refused the request — check that {key_name} has Generative APIs permissions for this project."}
        ), 500
    except (anthropic.RateLimitError, openai.RateLimitError):
        return jsonify({"error": "Rate limited by the LLM provider — try again in a minute."}), 429
    except anthropic.APIStatusError as error:
        return jsonify({"error": f"Anthropic API error ({error.status_code}): {error.message}"}), 502
    except openai.APIStatusError as error:
        return jsonify({"error": f"Scaleway API error ({error.status_code}): {error.message}"}), 502
    except (anthropic.APIConnectionError, openai.APIConnectionError):
        return jsonify({"error": "Could not reach the LLM provider."}), 502
    except (RuntimeError, json.JSONDecodeError) as error:
        return jsonify({"error": str(error)}), 502

    payload = {
        "question": question,
        "answer": answer,
        **enrich(answer),
        "trace": trace,
        "usage": usage,
        "model": model_id,
        "model_label": MODELS[model_id]["label"],
        "seconds": round(time.time() - started, 1),
    }
    log_run({"time": datetime.now().isoformat(timespec="seconds"), **payload})
    return jsonify(payload)


@app.post("/api/compile")
def compile_query():
    sq = (request.get_json(silent=True) or {}).get("query")
    if not isinstance(sq, dict):
        return jsonify({"error": "Missing query."}), 400
    return jsonify(enrich(sq))


def main():
    global agent
    usable = [m["label"] for m in available_models() if m["available"]]
    if not usable:
        print("⚠️  No LLM API key set in new-index/nl/.env (ANTHROPIC_API_KEY and/or SCW_SECRET_KEY).")
    print("Loading Word2Vec model…", flush=True)
    ct.load_word2vec()
    print("Fetching index facts for the system prompt…", flush=True)
    agent = NLSearchAgent(ct.build_schema_card())
    port = int(os.environ.get("PORT", 5055))
    print(f"Ready: http://localhost:{port}/  (models with a key: {', '.join(usable) or 'none'})")
    # threaded so the page's /api/compile calls aren't blocked by a long LLM request.
    app.run(port=port, threaded=True)


if __name__ == "__main__":
    main()
