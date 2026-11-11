"""
Guards around the model calls of POST /answer (ML/AI review, 2026-11-11). Pure functions, so they are unit-tested
without a model (backend/tests/test_ai_guard.py).

- Data minimization: the candidate's email and phone go to the model as placeholders and are put back in the answers
  afterwards; the model never sees them, and they cannot leak into an essay answer by accident.
- Prompt budget: the resume, the page text and the already-filled list are capped, so one long page cannot push the
  prompt past a provider's limit (Groq 413s) or bury the questions.
- Untrusted text is fenced: page text gets explicit begin/end markers, and any marker inside it is neutralized, so a
  job page cannot close the fence and talk to the model as instructions.
- Output contract: one answer per asked field, nothing else; unknown ids dropped, missing ones added as
  NEEDS_USER_INPUT, confidence clamped to 0..1, needs_user_input consistent with the answer, an option pick matched
  to the field's own option text, free text cut to the field's max length at a word boundary.
- Telemetry: one JSON line per model call (provider, model, prompt version, latency, sizes, outcome counts), with no
  personal data, so quality and cost can be followed over time.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

PROMPT_VERSION = "answer-v3-2026-11-11"
NEEDS = "NEEDS_USER_INPUT"

RESUME_MAX_CHARS = int(os.getenv("RESUME_MAX_CHARS", "12000"))
PAGE_MAX_CHARS = int(os.getenv("PAGE_MAX_CHARS", "8000"))
FILLED_MAX_ITEMS = int(os.getenv("FILLED_MAX_ITEMS", "40"))

UNTRUSTED_BEGIN = "<<<UNTRUSTED PAGE TEXT BEGIN>>>"
UNTRUSTED_END = "<<<UNTRUSTED PAGE TEXT END>>>"

# Placeholders the model sees instead of the real values.
_SECRET_FIELDS = {"email": "{{CANDIDATE_EMAIL}}", "phone": "{{CANDIDATE_PHONE}}"}


def redact_candidate(candidate: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """The candidate with email/phone replaced by placeholders, and the placeholder → value map to restore them."""
    out = dict(candidate)
    restore: Dict[str, str] = {}
    for key, token in _SECRET_FIELDS.items():
        value = str(out.get(key) or "").strip()
        if value:
            out[key] = token
            restore[token] = value
    return out, restore


def redact_text(text: str, restore: Dict[str, str]) -> str:
    """The same values replaced in free text (the resume's header carries them), the phone in any spacing."""
    out = text or ""
    for token, value in restore.items():
        if token == _SECRET_FIELDS["phone"]:
            digits = re.sub(r"\D", "", value)[-10:]
            if len(digits) == 10:
                # The last 10 digits with any separators between them, and an optional country code before.
                pattern = r"(?:\+?\d{1,3}[\s.-]*)?" + r"[\s().-]*".join(digits)
                out = re.sub(pattern, token, out)
        elif value:
            out = re.sub(re.escape(value), token, out, flags=re.IGNORECASE)
    return out


def restore_answer(text: str, restore: Dict[str, str]) -> str:
    for token, value in restore.items():
        text = text.replace(token, value)
    return text


def cap_text(text: Optional[str], limit: int) -> str:
    """At most `limit` characters, cut at a line or word boundary, with a marker saying so."""
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    cut = t[:limit]
    for sep in ("\n", " "):
        at = cut.rfind(sep)
        if at > limit * 0.8:
            cut = cut[:at]
            break
    return cut.rstrip() + f"\n[… cut: {len(t) - len(cut)} more characters not shown]"


def fence_untrusted(text: Optional[str], limit: int = PAGE_MAX_CHARS) -> str:
    """Page text inside markers it cannot close itself."""
    t = cap_text(text, limit)
    t = t.replace("<<<", "‹‹‹").replace(">>>", "›››")
    return f"{UNTRUSTED_BEGIN}\n{t}\n{UNTRUSTED_END}" if t else "(none)"


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def match_option(answer: str, options: List[str]) -> Optional[str]:
    """The field's own option for an answer that names it (case, spacing and punctuation ignored), else None."""
    if not options:
        return answer
    a = _norm(answer)
    for o in options:
        if _norm(o) == a:
            return o
    # "Yes, I am" → "Yes": an option that the answer starts with, longest first, when it is a whole word.
    for o in sorted(options, key=lambda x: -len(x)):
        n = _norm(o)
        if n and (a.startswith(n + " ") or a == n):
            return o
    return None


def cut_to_length(text: str, max_length: Optional[int]) -> str:
    if not max_length or max_length <= 0 or len(text) <= max_length:
        return text
    cut = text[: max_length + 1]
    at = cut.rfind(" ")
    cut = cut[:at] if at > max_length / 2 else text[:max_length]
    return cut.rstrip(" ,;:-–—")


def postprocess(answers: Iterable[Dict[str, Any]], fields: List[Dict[str, Any]], restore: Dict[str, str]) -> List[Dict[str, Any]]:
    """Enforce the output contract (see the module docstring)."""
    by_id = {f["id"]: f for f in fields}
    seen: Dict[str, Dict[str, Any]] = {}
    for a in answers:
        fid = a.get("field_id")
        if fid not in by_id or fid in seen:
            continue
        field = by_id[fid]
        text = restore_answer(str(a.get("answer") or "").strip(), restore)
        try:
            conf = float(a.get("confidence", 0))
        except (TypeError, ValueError):
            conf = 0.0
        conf = min(1.0, max(0.0, conf))
        source = str(a.get("source") or "ai_generated")
        if not text or text == NEEDS or a.get("needs_user_input"):
            seen[fid] = {"field_id": fid, "answer": NEEDS, "confidence": 0.0, "source": "missing", "needs_user_input": True}
            continue
        options = field.get("options") or []
        if options:
            picked = match_option(text, options)
            if picked is None:
                seen[fid] = {"field_id": fid, "answer": text, "confidence": min(conf, 0.4), "source": f"{source}:not-an-option", "needs_user_input": False}
                continue
            text = picked
        else:
            ml = field.get("max_length")
            try:
                text = cut_to_length(text, int(ml) if ml not in (None, "") else None)
            except (TypeError, ValueError):
                pass
        seen[fid] = {"field_id": fid, "answer": text, "confidence": conf, "source": source, "needs_user_input": False}
    for fid in by_id:
        if fid not in seen:
            seen[fid] = {"field_id": fid, "answer": NEEDS, "confidence": 0.0, "source": "missing:not-answered", "needs_user_input": True}
    return [seen[f["id"]] for f in fields]


class CallLog:
    """One JSON line per model call in backend/llm-calls.jsonl (no personal data: sizes and counts only)."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or os.getenv("LLM_CALL_LOG", os.path.join(os.path.dirname(__file__), "..", "llm-calls.jsonl"))

    def write(self, **record: Any) -> None:
        record = {"ts": round(time.time(), 3), "prompt_version": PROMPT_VERSION, **record}
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass  # telemetry never breaks an answer


def outcome_counts(answers: List[Dict[str, Any]]) -> Dict[str, int]:
    needs = sum(1 for a in answers if a["needs_user_input"])
    low = sum(1 for a in answers if not a["needs_user_input"] and a["confidence"] < 0.5)
    return {"answered": len(answers) - needs, "needs_user_input": needs, "low_confidence": low}
