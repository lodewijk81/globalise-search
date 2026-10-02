"""Translates a natural-language question into a structured search over the GLOBALISE index.

Claude gets the corpus-grounding tools from corpus_tools.py and must check its candidate
search terms against the actual corpus (Word2Vec neighbours + document counts) before
answering. Its final answer is JSON in the structured-query shape documented in
corpus_tools.py, which the server turns into a results.html link.
"""

import json
import os

import anthropic

import corpus_tools as ct

MAX_TOOL_ROUNDS = 15

ENTITY_LIST_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {"label": {"type": "string"}, "id": {"type": "string"}},
        "required": ["label", "id"],
        "additionalProperties": False,
    },
}
NULLABLE_YEAR = {"anyOf": [{"type": "integer"}, {"type": "null"}]}

STRUCTURED_QUERY_PROPERTIES = {
    "concepts": {
        "type": "array",
        "description": "Each concept is an OR-group of search terms; documents must match every concept.",
        "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "Short name of the concept in the user's language."},
                "terms": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["label", "terms"],
            "additionalProperties": False,
        },
    },
    "places": {**ENTITY_LIST_SCHEMA, "description": "Annotated places (ids from resolve_entity); each one is required."},
    "persons": {**ENTITY_LIST_SCHEMA, "description": "Annotated person roles/occupations (ids from resolve_entity); each one is required."},
    "settlements": {
        "type": "array",
        "items": {"type": "string"},
        "description": "VOC settlement the document belongs to (exact names from the list); any of these.",
    },
    "year_from": NULLABLE_YEAR,
    "year_to": NULLABLE_YEAR,
}
STRUCTURED_QUERY_REQUIRED = list(STRUCTURED_QUERY_PROPERTIES)

FINAL_ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "interpretation": {
            "type": "string",
            "description": "One or two sentences, in the user's language, on how the question was translated into a search.",
        },
        **STRUCTURED_QUERY_PROPERTIES,
        "notes": {
            "type": "string",
            "description": "Caveats in the user's language: parts of the question the search cannot express, or empty.",
        },
    },
    "required": ["interpretation", *STRUCTURED_QUERY_REQUIRED, "notes"],
    "additionalProperties": False,
}

TOOLS = [
    {
        "name": "related_terms",
        "description": (
            "Word2Vec neighbours of one lowercase word, from a model trained on this corpus's "
            "transcriptions. Returns likely spelling/transcription variants and related words, each "
            "with its document count. Only works for words that occur in the corpus (historical Dutch)."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"word": {"type": "string"}},
            "required": ["word"],
            "additionalProperties": False,
        },
    },
    {
        "name": "term_counts",
        "description": (
            "Number of documents containing each term. Terms can be single words, multi-word phrases "
            "(matched as exact phrases), or wildcard patterns such as peper*."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"terms": {"type": "array", "items": {"type": "string"}}},
            "required": ["terms"],
            "additionalProperties": False,
        },
    },
    {
        "name": "resolve_entity",
        "description": (
            "Finds annotated places, or person roles/occupations (e.g. koopman, predikant, slaaf), whose "
            "label contains the given name. Each candidate has an id that covers all its recorded "
            "spelling variants, plus a document count."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_type": {"type": "string", "enum": ["place", "person"]},
                "name": {"type": "string"},
            },
            "required": ["entity_type", "name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "preview_query",
        "description": (
            "Runs a candidate structured query and returns the total number of matching documents "
            "and highlighted snippets from the top 5, so you can judge whether the results fit the question."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "object",
                    "properties": STRUCTURED_QUERY_PROPERTIES,
                    "required": STRUCTURED_QUERY_REQUIRED,
                    "additionalProperties": False,
                }
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]

TOOL_FUNCTIONS = {
    "related_terms": lambda args: ct.related_terms(args["word"]),
    "term_counts": lambda args: ct.term_counts(args["terms"]),
    "resolve_entity": lambda args: ct.resolve_entity(args["entity_type"], args["name"]),
    "preview_query": lambda args: ct.preview_query(args["query"]),
}

SYSTEM_PROMPT_TEMPLATE = """\
You translate research questions about the archives of the Dutch East India Company (VOC) into \
searches over the GLOBALISE corpus. Questions may be in English or Dutch.

## The corpus
- {total_documents:,} documents: handwritten VOC records (letters, reports, resolutions, \
accounts, journals), 17th and 18th century, transcribed by handwriting recognition (HTR).
- The text is historical Dutch with inconsistent spelling, plus transcription noise: words broken \
across line ends, misread letters. A modern or English word usually finds little or nothing. \
Example: "koffie" occurs in 237 documents, but the period spellings "koffij" and "coffij" occur in \
about 6,000 and 23,000.
- Free-text matching is on whole lowercase words: no stemming, so plural and inflected forms are \
separate terms. A trailing wildcard (slaa*) covers inflections, but only use one if term_counts \
shows that it doesn't pull in too many unrelated words.
- Annotations: mentions of places and of persons by role/occupation (koopman, predikant, \
soldaat, slaaf…) are tagged with entity ids that group spelling variants together. Named \
individuals are not available here.
- Settlement: the VOC office a document belongs to. {documents_without_settlement:,} documents \
have no settlement, so filtering on settlement excludes most of the corpus. Use it only when the \
question is about documents from a particular office, not about a place merely being mentioned \
(use a place entity, or the place name as a concept, for that). Available settlements with \
document counts: {settlements}

## How to work
1. Break the question into concepts that a relevant document must mention, plus any constraints \
(place, role, period, settlement). Use as few concepts as needed. Every concept you add is \
another requirement, and too many concepts make the search come back empty.
2. For each concept, propose 17th/18th-century Dutch words for it from your own knowledge, \
then ground them in the corpus: use related_terms to find spelling variants and corpus vocabulary \
you didn't think of, and term_counts to check frequencies. Include spelling variants generously, \
because that's where recall comes from. Add related words only when they really express the same \
concept: the neighbours of peper include other spices like cardamom, which are a different concept. \
Leave out short fragments (pper, bata), and leave out very generic words that would match most \
documents.
3. Use resolve_entity when a place or a role is central to the question. A place id covers all \
its spelling variants. Pick the candidate whose labels actually are that place or role.
4. Run preview_query on your candidate query. If the result is empty or very small, loosen it \
(fewer concepts, more variants, wider period). If it's huge and the snippets are off-topic, \
tighten it. Read the snippets to check they're relevant. Two or three previews are usually enough.
5. {final_step} Term lists hold lowercase corpus words. Write the interpretation and the notes in \
the language of the question.
"""

FINAL_STEP = {
    # Claude: the final message is constrained to FINAL_ANSWER_SCHEMA via output_config.format.
    "anthropic": "Give your final answer as JSON in the required format.",
    # OpenAI-compatible APIs: combining tools with a response format isn't reliable across
    # models, so the final answer is itself a tool call.
    "scaleway": "Give your final answer by calling the submit_answer tool.",
}

# Models selectable on the page. "effort" is passed as Claude's output_config.effort or as the
# OpenAI-style reasoning_effort; supported values differ per model (see the Scaleway model
# catalogue). The Scaleway models were picked as the strongest open-weight models with tool
# calling in Scaleway's Serverless catalogue (Oct 2026).
MODELS = {
    "claude-opus-5-5": {"label": "Claude Opus 5.5", "provider": "anthropic", "effort": "medium"},
    "claude-sonnet-5-5": {"label": "Claude Sonnet 5.5", "provider": "anthropic", "effort": "medium"},
    "qwen3.5-397b-a17b": {"label": "Qwen3.5 397B (Scaleway)", "provider": "scaleway", "effort": "medium"},
    "glm-5.2": {"label": "GLM-5.2 (Scaleway)", "provider": "scaleway", "effort": "high"},
    "mistral-medium-3.5-128b": {"label": "Mistral Medium 3.5 (Scaleway)", "provider": "scaleway", "effort": "high"},
    "deepseek-v4-flash-0731": {"label": "DeepSeek V4 Flash (Scaleway)", "provider": "scaleway", "effort": "high"},
}

SCALEWAY_BASE_URL = "https://api.scaleway.ai/v1"
MAX_NUDGES = 2  # times an OpenAI-compatible model may answer in plain text before we give up


def build_system_prompt(schema_card, provider):
    settlements = ", ".join(f"{name} ({count:,})" for name, count in schema_card["settlements"])
    return SYSTEM_PROMPT_TEMPLATE.format(
        total_documents=schema_card["total_documents"],
        documents_without_settlement=schema_card["documents_without_settlement"],
        settlements=settlements,
        final_step=FINAL_STEP[provider],
    )


def normalize_answer(answer):
    """Fills in missing keys, so a model that leaves out an empty list doesn't break the page."""
    if not isinstance(answer, dict):
        raise RuntimeError("The model's final answer was not a JSON object.")
    normalized = {
        "interpretation": answer.get("interpretation") or "",
        "notes": answer.get("notes") or "",
        "year_from": answer.get("year_from"),
        "year_to": answer.get("year_to"),
    }
    for key in ("concepts", "places", "persons", "settlements"):
        normalized[key] = answer.get(key) or []
    return normalized


def run_tool(name, args, trace):
    try:
        result = TOOL_FUNCTIONS[name](args)
        is_error = False
    except Exception as error:  # report tool failures back to the model, don't crash
        result = {"error": f"{type(error).__name__}: {error}"}
        is_error = True
    trace.append({"tool": name, "input": args, "result": result, "is_error": is_error})
    return json.dumps(result, ensure_ascii=False), is_error


def available_models():
    has_key = {
        "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
        and not os.environ["ANTHROPIC_API_KEY"].startswith("sk-ant-REPLACE"),
        "scaleway": bool(os.environ.get("SCW_SECRET_KEY", "").strip())
        and not os.environ["SCW_SECRET_KEY"].startswith("REPLACE"),
    }
    return [
        {"id": model_id, "label": m["label"], "available": has_key[m["provider"]]}
        for model_id, m in MODELS.items()
    ]


class NLSearchAgent:
    def __init__(self, schema_card):
        self.schema_card = schema_card
        self.default_model = os.environ.get("LLM_MODEL", "claude-opus-5-5")
        self._clients = {}

    def _client(self, provider):
        if provider not in self._clients:
            if provider == "anthropic":
                self._clients[provider] = anthropic.Anthropic()
            else:
                from openai import OpenAI

                self._clients[provider] = OpenAI(
                    base_url=SCALEWAY_BASE_URL, api_key=os.environ.get("SCW_SECRET_KEY"), timeout=300
                )
        return self._clients[provider]

    def translate(self, question, model_id=None):
        """Returns (structured_answer, trace, usage). Raises RuntimeError on refusals/limits;
        provider API errors (anthropic.* / openai.*) propagate to the caller."""
        model_id = model_id or self.default_model
        if model_id not in MODELS:
            raise RuntimeError(f"Unknown model: {model_id}")
        config = MODELS[model_id]
        # LLM_EFFORT in .env overrides the effort of the Claude models.
        effort = os.environ.get("LLM_EFFORT", config["effort"]) if config["provider"] == "anthropic" else config["effort"]
        run = self._translate_anthropic if config["provider"] == "anthropic" else self._translate_openai
        answer, trace, usage = run(question, model_id, effort, build_system_prompt(self.schema_card, config["provider"]))
        usage["effort"] = effort
        return normalize_answer(answer), trace, usage

    # --- Claude (Anthropic API) ------------------------------------------------------------

    def _translate_anthropic(self, question, model_id, effort, system_prompt):
        client = self._client("anthropic")
        messages = [{"role": "user", "content": question}]
        trace = []
        usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "llm_calls": 0,
        }

        for _ in range(MAX_TOOL_ROUNDS):
            response = client.beta.messages.create(
                model=model_id,
                max_tokens=16000,
                # If a safety classifier declines, retry on Anthropic's recommended fallback model.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                # Caches the system prompt + tools + conversation so far across tool rounds.
                cache_control={"type": "ephemeral"},
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
                output_config={
                    "effort": effort,
                    "format": {"type": "json_schema", "schema": FINAL_ANSWER_SCHEMA},
                },
            )
            usage["llm_calls"] += 1
            for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                usage[key] += getattr(response.usage, key, 0) or 0

            if response.stop_reason == "refusal":
                raise RuntimeError("The model declined this request.")
            if response.stop_reason == "max_tokens":
                raise RuntimeError("The model ran out of output tokens before finishing.")

            if response.stop_reason == "end_turn":
                text = next((b.text for b in response.content if b.type == "text"), "")
                return json.loads(text), trace, usage

            messages.append({"role": "assistant", "content": response.content})
            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                content, is_error = run_tool(block.name, block.input, trace)
                tool_results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": content, "is_error": is_error}
                )
            messages.append({"role": "user", "content": tool_results})

        raise RuntimeError(f"No final answer after {MAX_TOOL_ROUNDS} rounds of tool calls.")

    # --- OpenAI-compatible (Scaleway Generative APIs) ----------------------------------------

    def _translate_openai(self, question, model_id, effort, system_prompt):
        client = self._client("scaleway")
        tools = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
            for t in TOOLS
        ] + [
            {
                "type": "function",
                "function": {
                    "name": "submit_answer",
                    "description": "Submit the final structured search. Call this once, when you are done.",
                    "parameters": FINAL_ANSWER_SCHEMA,
                },
            }
        ]
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": question}]
        trace = []
        usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "llm_calls": 0}
        nudges = 0

        for _ in range(MAX_TOOL_ROUNDS):
            response = client.chat.completions.create(
                model=model_id,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=16000,
                # Passed as a raw field: accepted values differ per model (none/low/medium/high/max).
                extra_body={"reasoning_effort": effort},
            )
            usage["llm_calls"] += 1
            if response.usage:
                usage["input_tokens"] += response.usage.prompt_tokens or 0
                usage["output_tokens"] += response.usage.completion_tokens or 0
                details = getattr(response.usage, "prompt_tokens_details", None)
                usage["cache_read_input_tokens"] += getattr(details, "cached_tokens", 0) or 0

            choice = response.choices[0]
            message = choice.message
            if choice.finish_reason == "length":
                raise RuntimeError("The model ran out of output tokens before finishing.")

            if not message.tool_calls:
                # Some models answer in plain text despite the instruction; accept JSON, else nudge.
                try:
                    return json.loads(message.content or ""), trace, usage
                except json.JSONDecodeError:
                    pass
                if nudges >= MAX_NUDGES:
                    raise RuntimeError("The model stopped without submitting a structured answer.")
                nudges += 1
                messages.append({"role": "assistant", "content": message.content or ""})
                messages.append({"role": "user", "content": "Please finish by calling the submit_answer tool."})
                continue

            messages.append(
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [
                        {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                        for c in message.tool_calls
                    ],
                }
            )
            for call in message.tool_calls:
                try:
                    args = json.loads(call.function.arguments or "{}")
                except json.JSONDecodeError as error:
                    content = json.dumps({"error": f"Arguments were not valid JSON: {error}"})
                    trace.append({"tool": call.function.name, "input": call.function.arguments, "result": content, "is_error": True})
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
                    continue
                if call.function.name == "submit_answer":
                    return args, trace, usage
                if call.function.name not in TOOL_FUNCTIONS:
                    content = json.dumps({"error": f"Unknown tool {call.function.name}"})
                else:
                    content, _ = run_tool(call.function.name, args, trace)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": content})

        raise RuntimeError(f"No final answer after {MAX_TOOL_ROUNDS} rounds of tool calls.")
