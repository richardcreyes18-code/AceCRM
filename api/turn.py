"""
Vercel serverless function — voice agent turn handler.

  POST /api/turn
    body: multipart/form-data with field "audio" (webm/mp3/wav)
    returns: { transcript, reply, audio (base64 mp3) }

Pipeline: audio → Whisper → command match (regex) → live Supabase fetch
        → Claude (persona + settings + command spec + live data) → TTS (onyx)

Env vars required (set in Vercel dashboard → Project → Settings → Env Variables):
  OPENAI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY
"""

import os
import io
import re
import sys
import json
import base64
import traceback
from pathlib import Path
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from openai import OpenAI
from anthropic import Anthropic


PROJECT_ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = PROJECT_ROOT / "ace-agent"
COMMANDS_DIR = AGENT_DIR / "commands"

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"].strip()
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"].strip()
SUPABASE_URL = os.environ["SUPABASE_URL"].strip().rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"].strip()

openai = OpenAI(api_key=OPENAI_API_KEY)
anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)


# ───────────────── direct PostgREST client ─────────────────
# We call Supabase via httpx instead of the `supabase` Python SDK or
# stdlib urllib. Both of those failed inside Vercel's Python runtime
# with `[Errno 16] Device or resource busy` on every outbound request
# to *.supabase.co. The openai and anthropic SDKs (also httpx-based)
# work fine in the same function, so a direct httpx.Client call sidesteps
# whatever Lambda-level socket weirdness is breaking the stdlib path.
_SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept": "application/json",
}


def sb_select(table: str, params) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    print(f"[sb_select] GET {url} params={params}", file=sys.stderr, flush=True)
    try:
        with httpx.Client(timeout=10.0, http2=False) as client:
            r = client.get(url, params=params, headers=_SB_HEADERS)
        print(f"[sb_select] {r.status_code} for {table} ({len(r.content)} bytes)",
              file=sys.stderr, flush=True)
        if r.status_code >= 400:
            raise RuntimeError(
                f"PostgREST {r.status_code} on {table}: {r.text[:300]}"
            )
        return r.json()
    except Exception as e:
        print(f"[sb_select] EXCEPTION {type(e).__name__}: {e}",
              file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        raise


# One-time startup log (per cold start) so we can verify env var is set
# without leaking the key. URL is not secret; key length is enough to
# confirm it's populated.
print(
    f"[startup] SUPABASE_URL={SUPABASE_URL!r} "
    f"KEY_LEN={len(SUPABASE_KEY)} HOST={SUPABASE_URL.split('//')[-1] if '//' in SUPABASE_URL else SUPABASE_URL}",
    file=sys.stderr, flush=True,
)

PERSONA = (AGENT_DIR / "persona.md").read_text()
SETTINGS = (AGENT_DIR / "settings.md").read_text()

CLAUDE_MODEL = "claude-sonnet-4-6"
WHISPER_MODEL = "whisper-1"
TTS_MODEL = "tts-1"
TTS_VOICE = "onyx"
MAX_REPLY_TOKENS = 250

STAGE_RANK = {"Spread": 1, "Pitch Out": 2, "Accepted": 3, "Starter": 4, "Asking": 5}


# ───────────────── helpers ─────────────────
def _iso_hours_ago(h: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=h)).isoformat()


def _fmt_money(n) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return str(n)
    if n >= 1_000_000:
        return f"${n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"${n / 1_000:.0f}K"
    return f"${n:.0f}"


def _days_since(ts):
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).days
    except (ValueError, AttributeError):
        return None


# ───────────────── live Supabase fetches ─────────────────
def fetch_daily_brief() -> dict:
    today = datetime.now(timezone.utc).date().isoformat()
    tasks = sb_select("ace_tasks", [
        ("select", "task,due_date,priority,status"),
        ("due_date", f"lte.{today}"),
        ("due_date", "not.is.null"),
    ]) or []
    open_tasks = [
        t for t in tasks
        if (t.get("status") or "").lower() not in ("done", "completed", "archived")
    ][:5]

    cutoff = _iso_hours_ago(7 * 24)
    deals = sb_select("ace_properties", [
        ("select", "address,property_name,pipeline_stage,asking_price,pitch_out_price,top_priority,updated_at"),
        ("deleted_at", "is.null"),
        ("is_archived", "eq.false"),
        ("updated_at", f"gte.{cutoff}"),
        ("order", "updated_at.desc"),
        ("limit", "20"),
    ]) or []
    deals.sort(key=lambda d: STAGE_RANK.get(d.get("pipeline_stage") or "", 99))
    recent_moves = []
    for d in deals[:5]:
        recent_moves.append({
            "label": d.get("address") or d.get("property_name") or "unnamed",
            "stage": d.get("pipeline_stage"),
            "asking": _fmt_money(d["asking_price"]) if d.get("asking_price") else None,
            "pitch_out": _fmt_money(d["pitch_out_price"]) if d.get("pitch_out_price") else None,
            "days_ago": _days_since(d.get("updated_at")),
        })

    top_priority = sb_select("ace_properties", [
        ("select", "address,property_name,pipeline_stage,updated_at"),
        ("deleted_at", "is.null"),
        ("is_archived", "eq.false"),
        ("top_priority", "eq.true"),
        ("order", "updated_at.asc"),
        ("limit", "5"),
    ]) or []
    top_priority_active = [
        {
            "label": p.get("address") or p.get("property_name") or "unnamed",
            "stage": p.get("pipeline_stage"),
            "days_idle": _days_since(p.get("updated_at")),
        }
        for p in top_priority
        if (p.get("pipeline_stage") or "") not in ("Closed", "Dead", "Lost")
    ]

    return {
        "tasks_due_or_overdue": open_tasks,
        "recent_deal_moves": recent_moves,
        "top_priority_active": top_priority_active,
    }


def fetch_contact(name: str) -> dict:
    if not name:
        return {"error": "no name provided"}

    contacts = sb_select("ace_contacts", [
        ("select", "id,name,company,contact_role,phone_mobile,phone_office,email,updated_at"),
        ("deleted_at", "is.null"),
        ("name", f"ilike.*{name}*"),
        ("order", "updated_at.desc"),
        ("limit", "3"),
    ]) or []

    if not contacts:
        return {"matches": [], "query": name}

    if len(contacts) > 1:
        return {
            "matches": [
                {"name": c.get("name"), "company": c.get("company"),
                 "role": c.get("contact_role")}
                for c in contacts
            ],
            "query": name,
        }

    c = contacts[0]
    notes = sb_select("ace_contact_notes", [
        ("select", "subject,body,created_at"),
        ("contact_id", f"eq.{c['id']}"),
        ("deleted_at", "is.null"),
        ("order", "created_at.desc"),
        ("limit", "2"),
    ]) or []
    props = sb_select("ace_properties", [
        ("select", "address,property_name,pipeline_stage"),
        ("owner_contact_id", f"eq.{c['id']}"),
        ("deleted_at", "is.null"),
        ("is_archived", "eq.false"),
        ("limit", "3"),
    ]) or []
    return {
        "contact": {
            "name": c.get("name"),
            "company": c.get("company"),
            "role": c.get("contact_role"),
            "phone": c.get("phone_mobile") or c.get("phone_office"),
        },
        "recent_notes": [
            {"subject": n.get("subject"), "body": n.get("body"),
             "days_ago": _days_since(n.get("created_at"))}
            for n in notes
        ],
        "owned_properties": [
            {"label": p.get("address") or p.get("property_name"),
             "stage": p.get("pipeline_stage")}
            for p in props
        ],
    }


# ───────────────── crm-ai-assist (writes pipeline) ─────────────────
# The dashboard's ✦ AI Assistant (Claude Haiku 4.5, /functions/v1/crm-ai-assist)
# extracts structured write intents from natural language: seller_lead,
# buyer_criteria, update_deal, pitch_log. The voice agent forwards write-y
# transcripts to the same function so we don't duplicate intent extraction.
# Commits still go through the dashboard preview UI for now (v222 will add
# spoken-confirmation commits).
def forward_to_assist(transcript: str, prev_turns=None) -> dict:
    messages = []
    for turn in (prev_turns or [])[-5:]:
        u = (turn.get("transcript") or "").strip()
        a = (turn.get("reply") or "").strip()
        if u:
            messages.append({"role": "user", "content": u})
        if a:
            messages.append({"role": "assistant", "content": a})
    messages.append({"role": "user", "content": transcript})

    url = f"{SUPABASE_URL}/functions/v1/crm-ai-assist"
    print(f"[crm-ai-assist] POST with {len(messages)} messages",
          file=sys.stderr, flush=True)
    try:
        with httpx.Client(timeout=30.0, http2=False) as client:
            r = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": "application/json",
                    "apikey": SUPABASE_KEY,
                },
                json={
                    "messages": messages,
                    "attachments": [],
                    "context": {},
                },
            )
    except Exception as e:
        print(f"[crm-ai-assist] EXCEPTION {type(e).__name__}: {e}",
              file=sys.stderr, flush=True)
        return {"error": f"{type(e).__name__}: {e}"}

    if r.status_code >= 400:
        return {"error": f"crm-ai-assist {r.status_code}: {r.text[:300]}"}

    response = r.json()
    if response.get("error"):
        return {"error": response["error"]}
    result = response.get("result") or {}
    # Always tag so Claude knows this is a write-intent payload, not read data.
    result["_write_intent"] = True
    return result


def fetch_entity(query: str) -> dict:
    """Try both contact and deal lookups in parallel; return whichever has data.
    Used when the user says 'tell me about X' / 'look up X' without specifying
    whether X is a person or a property."""
    contact_data = None
    deal_data = None
    try:
        contact_data = fetch_contact(query)
    except Exception as e:
        contact_data = {"error": f"{type(e).__name__}: {e}"}
    try:
        deal_data = fetch_deal(query)
    except Exception as e:
        deal_data = {"error": f"{type(e).__name__}: {e}"}

    contact_has = contact_data and not contact_data.get("error") and (
        contact_data.get("contact") or contact_data.get("matches")
    )
    deal_has = deal_data and not deal_data.get("error") and (
        deal_data.get("deal") or deal_data.get("matches")
    )

    return {
        "query": query,
        "contact_result": contact_data if contact_has else None,
        "deal_result": deal_data if deal_has else None,
    }


def fetch_recent_deals(_args: str = "") -> dict:
    rows = sb_select("ace_properties", [
        ("select",
         "id,address,property_name,complex_name,"
         "property_type_text,crm_asset_classification,"
         "pipeline_stage,asking_price,municipality,state,created_at"),
        ("deleted_at", "is.null"),
        ("is_archived", "eq.false"),
        ("order", "created_at.desc"),
        ("limit", "5"),
    ]) or []
    return {
        "recent_deals": [
            {
                "label": d.get("address") or d.get("property_name") or d.get("complex_name") or "unnamed",
                "asset_type": d.get("property_type_text") or d.get("crm_asset_classification"),
                "city": d.get("municipality"),
                "state": d.get("state"),
                "stage": d.get("pipeline_stage"),
                "asking": _fmt_money(d["asking_price"]) if d.get("asking_price") else None,
                "days_ago": _days_since(d.get("created_at")),
            }
            for d in rows
        ]
    }


def fetch_deal(query: str) -> dict:
    if not query:
        return {"error": "no query provided"}
    or_filter = (
        f"(address.ilike.*{query}*,"
        f"property_name.ilike.*{query}*,"
        f"complex_name.ilike.*{query}*)"
    )
    deals = sb_select("ace_properties", [
        ("select",
         "id,address,property_name,complex_name,pipeline_stage,deal_tag,"
         "asking_price,offer_price,pitch_out_price,target_seller_net,"
         "cap_rate_crm,number_of_units,no_of_units,owner_contact_id,updated_at"),
        ("deleted_at", "is.null"),
        ("is_archived", "eq.false"),
        ("or", or_filter),
        ("order", "updated_at.desc"),
        ("limit", "3"),
    ]) or []

    if not deals:
        return {"matches": [], "query": query}

    if len(deals) > 1:
        return {
            "matches": [
                {"label": d.get("address") or d.get("property_name"),
                 "stage": d.get("pipeline_stage")}
                for d in deals
            ],
            "query": query,
        }

    d = deals[0]
    units = d.get("number_of_units") or d.get("no_of_units")
    deal = {
        "label": d.get("address") or d.get("property_name") or "unnamed",
        "stage": d.get("pipeline_stage"),
        "asking_price": _fmt_money(d["asking_price"]) if d.get("asking_price") else None,
        "offer_price": _fmt_money(d["offer_price"]) if d.get("offer_price") else None,
        "pitch_out_price": _fmt_money(d["pitch_out_price"]) if d.get("pitch_out_price") else None,
        "target_seller_net": _fmt_money(d["target_seller_net"]) if d.get("target_seller_net") else None,
        "cap_rate": d.get("cap_rate_crm"),
        "units": units,
        "days_since_update": _days_since(d.get("updated_at")),
    }

    owner = None
    if d.get("owner_contact_id"):
        rows = sb_select("ace_contacts", [
            ("select", "name,company"),
            ("id", f"eq.{d['owner_contact_id']}"),
            ("deleted_at", "is.null"),
            ("limit", "1"),
        ]) or []
        if rows:
            owner = {"name": rows[0].get("name"), "company": rows[0].get("company")}

    offers = sb_select("ace_deal_offers", [
        ("select", "offer_type,party_name,amount,offer_date,is_winning,presentation_status"),
        ("deal_id", f"eq.{d['id']}"),
        ("deleted_at", "is.null"),
        ("order", "offer_date.desc"),
        ("limit", "2"),
    ]) or []
    offer_list = [
        {
            "type": o.get("offer_type"),
            "party": o.get("party_name"),
            "amount": _fmt_money(o["amount"]) if o.get("amount") else None,
            "date": o.get("offer_date"),
            "winning": o.get("is_winning"),
        }
        for o in offers
    ]

    open_tasks = sb_select("ace_tasks", [
        ("select", "task,due_date,priority,status"),
        ("property_id", f"eq.{d['id']}"),
        ("order", "due_date.asc"),
        ("limit", "3"),
    ]) or []
    open_tasks = [
        t for t in open_tasks
        if (t.get("status") or "").lower() not in ("done", "completed", "archived")
    ]

    return {
        "deal": deal,
        "owner": owner,
        "recent_offers": offer_list,
        "open_tasks": open_tasks,
    }


# ───────────────── routing ─────────────────
_NUM_WORDS = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|few|several)"

# Trim a free-form search query at natural sentence breakers so a long
# voice utterance ("409 Main Street in West Orange that I added three
# days ago, the multifamily") collapses to the searchable head ("409
# Main Street in West Orange") before hitting PostgREST ILIKE.
_BREAKERS = [
    r"\s+that\s+", r"\s+which\s+", r"\s+who\s+", r"\s+where\s+",
    r"\s*,\s*", r"\s+\-\s+",
]
_BREAKER_RE = re.compile("|".join(_BREAKERS), re.IGNORECASE)


def clean_entity_query(query: str) -> str:
    parts = _BREAKER_RE.split(query, maxsplit=1)
    return parts[0].strip() if parts else query.strip()


# Pronoun-style references that mean "the entity from the prior turn".
# When matched AND we have a prev turn with a known command+args, we
# reuse that command instead of trying to parse an entity from this turn.
_PRONOUN_RE = re.compile(
    r"\b(?:that|this|the\s+(?:previous|last|same))\s+"
    r"(?:deal|property|contact|guy|person|one|address|listing|thing)\b"
    r"|\bthat\s+one\b"
    r"|\bthe\s+same\s+one\b",
    re.IGNORECASE,
)


# Phrases that indicate the user wants to CREATE / UPDATE / LOG something
# rather than read. Matched conservatively — when in doubt we let it fall
# through to read commands or general Claude.
_WRITE_INTENT_RE = re.compile(
    r"\b(?:create|add|new|log|enter)\s+(?:a\s+|the\s+)?"
    r"(?:seller|buyer|lead|pitch|deal|contact|property|note|task)\b"
    r"|\bupdate\s+(?:the\s+)?(?:asking|price|stage|note|pipeline|noi|cap\s+rate|owner)\b"
    r"|\bchange\s+(?:the\s+)?(?:asking|price|stage|owner|note|priority)\b"
    r"|\bset\s+(?:the\s+)?(?:asking|price|stage|gross|noi|cap)\b"
    r"|\bmove\s+.+?\s+to\s+(?:.+?\s+)?(?:stage|pitch\s+out|spread|accepted|asking|starter|closed)\b"
    r"|\bstar\s+.+?\s+(?:as\s+)?(?:top\s+priority|priority|hot)\b"
    r"|\barchive\s+(?:the\s+)?(?:deal|property|.+)\b"
    r"|\bmark\s+.+?\s+(?:top\s+priority|as\s+priority|archived)\b"
    r"|\bappend\s+(?:a\s+)?note\b"
    r"|\b(?:i|just)\s+(?:spoke|talked|met|called|got\s+a\s+call|got\s+off\s+the\s+phone)\b"
    r"|\bpitched\s+.+?\s+to\b"
    r"|\b(?:spoke|talked)\s+with\s+.+?\s+(?:about|at)\b",
    re.IGNORECASE,
)

# Confirmation phrases — "yes" / "do it" / "confirm" — used to commit a
# pending write that the previous turn previewed. v221 just acknowledges;
# v222 will execute.
_CONFIRM_RE = re.compile(
    r"^\s*(?:yes|yeah|yep|yup|correct|confirm|do\s+it|go\s+ahead|"
    r"that'?s\s+right|sounds?\s+good|commit\s+it)\s*[.!]?\s*$",
    re.IGNORECASE,
)


def match_command(transcript: str, prev_turns=None):
    t = transcript.lower().strip().rstrip(".?!")

    # If the previous turn left a pending write preview AND this turn is a
    # confirmation, route to a commit handler.
    if prev_turns and _CONFIRM_RE.match(t):
        for prev in reversed(prev_turns):
            facts = prev.get("facts") or {}
            if isinstance(facts, dict) and facts.get("_write_intent"):
                return ("write-commit", json.dumps(facts))

    # Pronoun resolution — re-target the most recent entity-bearing turn.
    if prev_turns and _PRONOUN_RE.search(t):
        for prev in reversed(prev_turns):
            cmd = prev.get("command")
            args = prev.get("args")
            if cmd and args and cmd != "daily-brief.md" and cmd != "recent-deals.md":
                return (cmd, args)

    # Write intents — forward to crm-ai-assist for structured extraction.
    if _WRITE_INTENT_RE.search(t):
        return ("write-intent", transcript)

    if re.search(
        r"\b(daily|morning)\s+brief(ing)?\b"
        r"|\bbrief\s+me\b"
        r"|\b(?:my\s+|today'?s\s+)?briefing\b"
        r"|\bwhat'?s\s+on\s+(?:my|the)\s+(?:plate|agenda)\b",
        t,
    ):
        return ("daily-brief.md", "")

    # Recent deals — broadened to handle "latest three deals", "deals
    # that I've inputted", "[N] most recent deals", etc.
    if re.search(
        r"\b(?:most\s+)?recent\s+deals?\b"
        rf"|\b(?:latest|newest)\s+(?:{_NUM_WORDS})?\s*(?:deals?|properties?|listings?)\b"
        rf"|\blast\s+(?:{_NUM_WORDS})?\s*deals?\b"
        rf"|\b{_NUM_WORDS}\s+(?:most\s+)?(?:recent|latest|newest)\s+deals?\b"
        r"|\bdeals?\s+(?:that\s+)?(?:i'?ve|i\s+have)\s+(?:added|inputted|entered|created|put\s+in)\b"
        r"|\bwhat\s+deals?\s+(?:have\s+)?i\s+(?:added|inputted|entered)\b"
        r"|\bnew\s+deals?\s+in\s+the\s+system\b",
        t,
    ):
        return ("recent-deals.md", "")

    # Universal entity lookup — "tell me about X" is ambiguous (contact
    # or deal?) so we try both. Also handles "look up", "pull up",
    # "find", "search for", "info on".
    m = re.search(
        r"\b(?:tell\s+me\s+about|what\s+about|info\s+on|"
        r"look\s+up|lookup|pull\s+up|search\s+for|find)\s+(.+)$",
        t,
    )
    if m:
        return ("entity-lookup.md", clean_entity_query(m.group(1)))

    # Explicit single-table commands still work as overrides.
    m = re.search(r"\bcontact\s+lookup\s+(.+)$", t)
    if m:
        return ("contact-lookup.md", clean_entity_query(m.group(1)))

    m = re.search(
        r"\b(?:deal\s+snapshot|snapshot|deal\s+on|"
        r"what'?s\s+(?:going\s+on|happening)\s+(?:on|with))\s+(.+)$",
        t,
    )
    if m:
        return ("deal-snapshot.md", clean_entity_query(m.group(1)))

    return None


def fetch_for(command_file: str, args: str, prev_turns=None):
    try:
        if command_file == "daily-brief.md":
            return fetch_daily_brief()
        if command_file == "contact-lookup.md":
            return fetch_contact(args)
        if command_file == "deal-snapshot.md":
            return fetch_deal(args)
        if command_file == "recent-deals.md":
            return fetch_recent_deals(args)
        if command_file == "entity-lookup.md":
            return fetch_entity(args)
        if command_file == "write-intent":
            return forward_to_assist(args, prev_turns)
        if command_file == "write-commit":
            # v221: acknowledge only. v222 will execute the writes.
            try:
                pending = json.loads(args)
            except json.JSONDecodeError:
                pending = {}
            return {
                "_pending_commit": True,
                "intent": pending.get("intent"),
                "summary": pending.get("summary"),
                "_note": "v221: voice commit not implemented yet — open the ✦ button on the dashboard to confirm and commit.",
            }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    return None


def ask_claude(transcript: str, command_file, facts, prev_turns=None) -> str:
    blocks = [PERSONA, SETTINGS]

    if prev_turns:
        recent = prev_turns[-3:]
        lines = ["# Recent conversation (most recent last) — for pronoun & follow-up resolution"]
        for turn in recent:
            u = (turn.get("transcript") or "").strip()
            a = (turn.get("reply") or "").strip()
            if u:
                lines.append(f"- USER: {u}")
            if a:
                lines.append(f"  ACE:  {a}")
        blocks.append("\n".join(lines))

    if command_file:
        cmd_path = COMMANDS_DIR / command_file
        if cmd_path.exists():
            blocks.append(
                f"# Command spec (FOR YOUR REFERENCE ONLY)\n"
                f"Below is the spec for '{command_file}'. The SQL queries shown "
                f"are documentation — they have ALREADY been executed on your "
                f"behalf and the results are in the 'Live data from Supabase' "
                f"block below. Use the spec only to understand HOW to phrase "
                f"the answer (which fields matter, what order to lead with). "
                f"Do NOT describe, paraphrase, or repeat the SQL aloud.\n\n"
                f"{cmd_path.read_text()}"
            )

    if facts is not None:
        blocks.append(
            "# Live data from Supabase (already fetched for you)\n"
            "These are the real, current values from AceCRM. Use them verbatim. "
            "Do NOT invent numbers, names, or dates not in this block. "
            "If a field is null/missing, omit it from your reply.\n\n"
            f"```json\n{json.dumps(facts, indent=2, default=str)}\n```"
        )

    blocks.append(
        "# Output rules — STRICT\n"
        "You are speaking through a TTS voice (OpenAI onyx). Your reply will "
        "be read aloud verbatim, so:\n"
        "- 2 sentences max for reads. 3 sentences max for write previews.\n"
        "- Plain spoken English. No markdown, no bullet points, no headers.\n"
        "- NEVER write tool-call syntax (no <tool_call>, no <function_call>, "
        "no XML tags of any kind). You do NOT have tools available.\n"
        "- NEVER write or describe SQL queries, JSON, code blocks, or column "
        "names. The user is hearing this, not reading it.\n"
        "- If the 'Live data' block above is missing or empty for a command, "
        "say 'I don't have that data right now' and stop.\n"
        "- For general questions (no command matched), answer from your own "
        "knowledge in Ricky's voice — short, direct, no hedging.\n"
        "\n"
        "# Write-intent handling (when data has _write_intent: true)\n"
        "The crm-ai-assist function returned a structured intent (seller_lead, "
        "buyer_criteria, update_deal, or pitch_log). Speak a natural-language "
        "preview of what's about to happen using the fields in the data, then "
        "end with: 'Say yes to confirm, or open the ✦ button to edit fields.' "
        "Example for seller_lead: 'Got it — about to create John Smith with "
        "phone 201-555-1234, plus a 12-unit multifamily at 45 Park Ave Bayonne "
        "asking $2.5M. Say yes to confirm, or open the ✦ button to edit fields.'\n"
        "\n"
        "# Confirmation handling (when data has _pending_commit: true)\n"
        "User said yes to a previous write preview. Voice-commit isn't wired "
        "yet — say exactly: 'Voice commits land in the next push. For now, "
        "tap the ✦ button on the dashboard to commit it.'\n"
        "\n"
        "# Clarifying questions (when data has clarifying_questions array)\n"
        "Speak the FIRST clarifying question conversationally, ignore the "
        "rest. Example data: clarifying_questions: ['What's the phone number?', "
        "'What's the asking price?'] → 'What's the phone number?'"
    )
    system = "\n\n---\n\n".join(blocks)

    msg = anthropic.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=MAX_REPLY_TOKENS,
        system=system,
        messages=[{"role": "user", "content": transcript}],
    )
    return msg.content[0].text.strip()


# ───────────────── openai I/O ─────────────────
def transcribe(audio_bytes: bytes, filename: str) -> str:
    bio = io.BytesIO(audio_bytes)
    bio.name = filename or "audio.webm"
    r = openai.audio.transcriptions.create(model=WHISPER_MODEL, file=bio)
    return (r.text or "").strip()


_TAG_RE = re.compile(r"<[^>]+>")
_CODE_RE = re.compile(r"```[\s\S]*?```")


def sanitize_for_tts(text: str) -> str:
    """Strip XML/HTML tags and code fences before TTS — last-resort guard
    against the model leaking tool-call syntax or SQL into the voice channel."""
    text = _CODE_RE.sub("", text)
    text = _TAG_RE.sub("", text)
    text = text.strip()
    return text or "I had nothing to say back."


def synthesize(text: str) -> bytes:
    clean = sanitize_for_tts(text)
    r = openai.audio.speech.create(model=TTS_MODEL, voice=TTS_VOICE, input=clean)
    return r.content


# ───────────────── FastAPI handler ─────────────────
app = FastAPI()


@app.get("/api/debug/supabase")
def debug_supabase():
    """Hit this directly in your browser — instant Supabase reachability test.
    No audio, no Whisper, no Claude, no TTS — just one GET to PostgREST."""
    out = {
        "supabase_url": SUPABASE_URL,
        "supabase_key_length": len(SUPABASE_KEY),
        "openai_key_set": bool(OPENAI_API_KEY),
        "anthropic_key_set": bool(ANTHROPIC_API_KEY),
    }
    try:
        rows = sb_select("ace_properties", [("select", "id"), ("limit", "1")])
        out["ok"] = True
        out["sample_row_count"] = len(rows)
        out["sample_row_id"] = rows[0]["id"] if rows else None
    except Exception as e:
        out["ok"] = False
        out["error_type"] = type(e).__name__
        out["error_message"] = str(e)[:500]
    return out


from fastapi import Form


@app.post("/api/turn")
async def turn(
    audio: UploadFile = File(...),
    history: str = Form("[]"),
):
    try:
        try:
            prev_turns = json.loads(history) if history else []
            if not isinstance(prev_turns, list):
                prev_turns = []
        except json.JSONDecodeError:
            prev_turns = []

        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(400, "empty audio")

        transcript = transcribe(audio_bytes, audio.filename or "audio.webm")
        if not transcript:
            return JSONResponse(
                {"transcript": "", "reply": "", "audio": "", "error": "no speech"}
            )

        match = match_command(transcript, prev_turns=prev_turns)
        cmd_file, args, facts = None, "", None
        if match:
            cmd_file, args = match
            facts = fetch_for(cmd_file, args, prev_turns=prev_turns)

        reply = ask_claude(transcript, cmd_file, facts, prev_turns=prev_turns)
        mp3 = synthesize(reply)
        audio_b64 = base64.b64encode(mp3).decode("ascii")

        return {
            "transcript": transcript,
            "reply": reply,
            "audio": audio_b64,
            "command": cmd_file,
            "args": args,
            "facts": facts,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")
