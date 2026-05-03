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
import json
import base64
from pathlib import Path
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from openai import OpenAI
from anthropic import Anthropic
from supabase import create_client, Client


PROJECT_ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = PROJECT_ROOT / "ace-agent"
COMMANDS_DIR = AGENT_DIR / "commands"

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

openai = OpenAI(api_key=OPENAI_API_KEY)
anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

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
    tasks = (
        supabase.table("ace_tasks")
        .select("task,due_date,priority,status")
        .lte("due_date", today)
        .not_.is_("due_date", "null")
        .execute().data or []
    )
    open_tasks = [
        t for t in tasks
        if (t.get("status") or "").lower() not in ("done", "completed", "archived")
    ][:5]

    cutoff = _iso_hours_ago(7 * 24)  # broaden to 7 days so a quiet 48h doesn't read as empty
    deals = (
        supabase.table("ace_properties")
        .select("address,property_name,pipeline_stage,asking_price,pitch_out_price,top_priority,updated_at")
        .is_("deleted_at", "null").eq("is_archived", False)
        .gte("updated_at", cutoff)
        .order("updated_at", desc=True)
        .limit(20).execute().data or []
    )
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

    # Always-on fallback: top-priority active deals so the brief is never empty
    top_priority = (
        supabase.table("ace_properties")
        .select("address,property_name,pipeline_stage,updated_at")
        .is_("deleted_at", "null").eq("is_archived", False)
        .eq("top_priority", True)
        .order("updated_at", desc=False).limit(5).execute().data or []
    )
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

    contacts = (
        supabase.table("ace_contacts")
        .select("id,name,company,contact_role,phone_mobile,phone_office,email,updated_at")
        .is_("deleted_at", "null")
        .ilike("name", f"%{name}%")
        .order("updated_at", desc=True)
        .limit(3).execute().data or []
    )
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
    notes = (
        supabase.table("ace_contact_notes")
        .select("subject,body,created_at")
        .eq("contact_id", c["id"]).is_("deleted_at", "null")
        .order("created_at", desc=True).limit(2).execute().data or []
    )
    props = (
        supabase.table("ace_properties")
        .select("address,property_name,pipeline_stage")
        .eq("owner_contact_id", c["id"])
        .is_("deleted_at", "null").eq("is_archived", False)
        .limit(3).execute().data or []
    )
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


def fetch_deal(query: str) -> dict:
    if not query:
        return {"error": "no query provided"}
    pattern = f"%{query}%"
    deals = (
        supabase.table("ace_properties")
        .select(
            "id,address,property_name,complex_name,pipeline_stage,deal_tag,"
            "asking_price,offer_price,pitch_out_price,target_seller_net,"
            "cap_rate_crm,number_of_units,no_of_units,owner_contact_id,updated_at"
        )
        .is_("deleted_at", "null").eq("is_archived", False)
        .or_(
            f"address.ilike.{pattern},"
            f"property_name.ilike.{pattern},"
            f"complex_name.ilike.{pattern}"
        )
        .order("updated_at", desc=True).limit(3).execute().data or []
    )
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
        rows = (
            supabase.table("ace_contacts")
            .select("name,company")
            .eq("id", d["owner_contact_id"]).is_("deleted_at", "null")
            .limit(1).execute().data or []
        )
        if rows:
            owner = {"name": rows[0].get("name"), "company": rows[0].get("company")}

    offers = (
        supabase.table("ace_deal_offers")
        .select("offer_type,party_name,amount,offer_date,is_winning,presentation_status")
        .eq("deal_id", d["id"]).is_("deleted_at", "null")
        .order("offer_date", desc=True).limit(2).execute().data or []
    )
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

    open_tasks = (
        supabase.table("ace_tasks")
        .select("task,due_date,priority,status")
        .eq("property_id", d["id"])
        .order("due_date", desc=False).limit(3).execute().data or []
    )
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
def match_command(transcript: str):
    t = transcript.lower().strip().rstrip(".?!")

    if re.search(
        r"\b(daily|morning)\s+brief(ing)?\b"
        r"|\bbrief\s+me\b"
        r"|\b(?:my\s+|today'?s\s+)?briefing\b"
        r"|\bwhat'?s\s+on\s+(?:my|the)\s+(?:plate|agenda)\b",
        t,
    ):
        return ("daily-brief.md", "")

    m = re.search(
        r"\b(?:contact\s+lookup|find\s+contact|lookup|look\s+up|find|pull\s+up|tell\s+me\s+about)\s+(.+)$",
        t,
    )
    if m:
        return ("contact-lookup.md", m.group(1).strip())

    m = re.search(
        r"\b(?:deal\s+snapshot|snapshot|deal\s+on|"
        r"what'?s\s+(?:going\s+on|happening)\s+(?:on|with))\s+(.+)$",
        t,
    )
    if m:
        return ("deal-snapshot.md", m.group(1).strip())

    return None


def fetch_for(command_file: str, args: str):
    try:
        if command_file == "daily-brief.md":
            return fetch_daily_brief()
        if command_file == "contact-lookup.md":
            return fetch_contact(args)
        if command_file == "deal-snapshot.md":
            return fetch_deal(args)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    return None


def ask_claude(transcript: str, command_file, facts) -> str:
    blocks = [PERSONA, SETTINGS]

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
        "- 2 sentences max. Under ~30 seconds of audio.\n"
        "- Plain spoken English. No markdown, no bullet points, no headers.\n"
        "- NEVER write tool-call syntax (no <tool_call>, no <function_call>, "
        "no XML tags of any kind). You do NOT have tools available.\n"
        "- NEVER write or describe SQL queries, JSON, code blocks, or column "
        "names. The user is hearing this, not reading it.\n"
        "- If the 'Live data' block above is missing or empty for a command, "
        "say 'I don't have that data right now' and stop. Do not improvise "
        "or pretend to query a database.\n"
        "- For general questions (no command matched), answer from your own "
        "knowledge in Ricky's voice — short, direct, no hedging."
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


@app.post("/api/turn")
async def turn(audio: UploadFile = File(...)):
    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(400, "empty audio")

        transcript = transcribe(audio_bytes, audio.filename or "audio.webm")
        if not transcript:
            return JSONResponse(
                {"transcript": "", "reply": "", "audio": "", "error": "no speech"}
            )

        match = match_command(transcript)
        cmd_file, args, facts = None, "", None
        if match:
            cmd_file, args = match
            facts = fetch_for(cmd_file, args)

        reply = ask_claude(transcript, cmd_file, facts)
        mp3 = synthesize(reply)
        audio_b64 = base64.b64encode(mp3).decode("ascii")

        return {
            "transcript": transcript,
            "reply": reply,
            "audio": audio_b64,
            "command": cmd_file,
            "facts": facts,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")
