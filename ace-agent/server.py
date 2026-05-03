#!/usr/bin/env python3
"""
ace-agent web server.

Run:   python ace-agent/server.py
Open:  http://localhost:8000

Trigger in the browser: Spacebar (when not typing in an input) or click the mic.

Pipeline per turn:
  audio  →  Whisper (whisper-1)  →  command match or Claude  →  TTS (tts-1, onyx)
"""

import os
import sys
import io
import re
import base64
from pathlib import Path
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from openai import OpenAI
from anthropic import Anthropic
from supabase import create_client, Client


AGENT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = AGENT_DIR.parent

load_dotenv(AGENT_DIR / ".env")
load_dotenv(PROJECT_DIR / ".env")


def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(
            f"Missing env var: {name}.\n"
            f"Copy ace-agent/.env.example to ace-agent/.env and fill it in."
        )
    return v


OPENAI_API_KEY = _require("OPENAI_API_KEY")
ANTHROPIC_API_KEY = _require("ANTHROPIC_API_KEY")
SUPABASE_URL = _require("SUPABASE_URL")
SUPABASE_KEY = _require("SUPABASE_KEY")

openai = OpenAI(api_key=OPENAI_API_KEY)
anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

PERSONA = (AGENT_DIR / "persona.md").read_text()
SETTINGS = (AGENT_DIR / "settings.md").read_text()

CLAUDE_MODEL = "claude-sonnet-4-6"
WHISPER_MODEL = "whisper-1"
TTS_MODEL = "tts-1"
TTS_VOICE = "onyx"
MAX_REPLY_TOKENS = 200


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


def _days_since(ts) -> int | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).days
    except (ValueError, AttributeError):
        return None


# ───────────────── openai I/O ─────────────────
def transcribe(audio_bytes: bytes, filename: str) -> str:
    bio = io.BytesIO(audio_bytes)
    bio.name = filename or "audio.webm"
    r = openai.audio.transcriptions.create(model=WHISPER_MODEL, file=bio)
    return (r.text or "").strip()


def synthesize(text: str) -> bytes:
    r = openai.audio.speech.create(model=TTS_MODEL, voice=TTS_VOICE, input=text)
    return r.content


# ───────────────── supabase commands ─────────────────
STAGE_RANK = {
    "Spread": 1, "Pitch Out": 2, "Accepted": 3, "Starter": 4, "Asking": 5,
}


def cmd_daily_brief() -> str:
    parts = []

    # Tasks due today / overdue
    today = datetime.now(timezone.utc).date().isoformat()
    tasks = (
        supabase.table("ace_tasks")
        .select("task,due_date,priority")
        .lte("due_date", today)
        .not_.is_("due_date", "null")
        .execute()
        .data or []
    )
    open_tasks = [t for t in tasks if (t.get("status") or "").lower() not in ("done", "completed", "archived")]
    if open_tasks:
        bits = []
        for t in open_tasks[:3]:
            bits.append((t.get("task") or "untitled task").strip())
        parts.append(f"{len(open_tasks)} task{'s' if len(open_tasks) != 1 else ''} on the board: " + "; ".join(bits) + ".")

    # Recent deal moves (48h)
    cutoff = _iso_hours_ago(48)
    deals = (
        supabase.table("ace_properties")
        .select("address,property_name,pipeline_stage,updated_at")
        .is_("deleted_at", "null")
        .eq("is_archived", False)
        .gte("updated_at", cutoff)
        .order("updated_at", desc=True)
        .limit(10)
        .execute()
        .data or []
    )
    deals.sort(key=lambda d: STAGE_RANK.get(d.get("pipeline_stage") or "", 99))
    if deals:
        bits = []
        for d in deals[:3]:
            label = d.get("address") or d.get("property_name") or "unnamed"
            stage = d.get("pipeline_stage") or "no stage"
            bits.append(f"{label} at {stage}")
        parts.append("Recent moves: " + "; ".join(bits) + ".")

    # Stale top-priority
    stale_cutoff = _iso_hours_ago(14 * 24)
    stale = (
        supabase.table("ace_properties")
        .select("address,property_name,pipeline_stage,updated_at")
        .is_("deleted_at", "null")
        .eq("is_archived", False)
        .eq("top_priority", True)
        .lt("updated_at", stale_cutoff)
        .order("updated_at", desc=False)
        .limit(2)
        .execute()
        .data or []
    )
    stale = [s for s in stale if (s.get("pipeline_stage") or "") not in ("Closed", "Dead", "Lost")]
    if stale:
        labels = [s.get("address") or s.get("property_name") or "unnamed" for s in stale]
        parts.append(f"Heads up — {', '.join(labels)} flagged top priority and not touched in 2+ weeks.")

    if not parts:
        return "Quiet morning. Nothing pressing in Ace."
    return " ".join(parts)


def cmd_contact_lookup(name: str) -> str:
    if not name:
        return "Who do you want me to look up?"
    pattern = f"%{name}%"
    contacts = (
        supabase.table("ace_contacts")
        .select("id,name,company,contact_role,phone_mobile,updated_at")
        .is_("deleted_at", "null")
        .ilike("name", pattern)
        .order("updated_at", desc=True)
        .limit(3)
        .execute()
        .data or []
    )
    if not contacts:
        return f"Nothing on {name} in Ace."

    if len(contacts) > 1:
        opts = ", ".join(
            f"{c.get('name','?')}{' at ' + c['company'] if c.get('company') else ''}"
            for c in contacts
        )
        return f"A few matches: {opts}. Which one?"

    c = contacts[0]
    notes = (
        supabase.table("ace_contact_notes")
        .select("subject,body,created_at")
        .eq("contact_id", c["id"])
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
        .data or []
    )
    props = (
        supabase.table("ace_properties")
        .select("address,property_name,pipeline_stage")
        .eq("owner_contact_id", c["id"])
        .is_("deleted_at", "null")
        .eq("is_archived", False)
        .limit(2)
        .execute()
        .data or []
    )

    parts = [c.get("name") or "Unknown"]
    if c.get("contact_role") and c.get("company"):
        parts.append(f"{c['contact_role']} at {c['company']}")
    elif c.get("company"):
        parts.append(c["company"])
    out = ", ".join(parts) + "."

    if notes:
        body = (notes[0].get("body") or "").strip().replace("\n", " ")
        if len(body) > 160:
            body = body[:160] + "…"
        if body:
            out += f" Last note: {body}"

    if props:
        labels = [p.get("address") or p.get("property_name") or "?" for p in props]
        out += f" Owns {', '.join(labels)}."

    return out


def cmd_deal_snapshot(query: str) -> str:
    if not query:
        return "Which deal?"
    pattern = f"%{query}%"
    deals = (
        supabase.table("ace_properties")
        .select(
            "id,address,property_name,complex_name,pipeline_stage,deal_tag,"
            "asking_price,offer_price,pitch_out_price,target_seller_net,"
            "cap_rate_crm,number_of_units,no_of_units,"
            "owner_contact_id,top_priority,updated_at"
        )
        .is_("deleted_at", "null")
        .eq("is_archived", False)
        .or_(
            f"address.ilike.{pattern},"
            f"property_name.ilike.{pattern},"
            f"complex_name.ilike.{pattern}"
        )
        .order("updated_at", desc=True)
        .limit(3)
        .execute()
        .data or []
    )
    if not deals:
        return f"No deal matching {query} in Ace."

    if len(deals) > 1:
        opts = ", ".join(
            d.get("address") or d.get("property_name") or "?" for d in deals
        )
        return f"A few matches: {opts}. Which one?"

    d = deals[0]
    label = d.get("address") or d.get("property_name") or "unnamed"
    stage = d.get("pipeline_stage") or "no stage"
    units = d.get("number_of_units") or d.get("no_of_units")

    money_bits = []
    if d.get("asking_price"):
        money_bits.append(f"asking {_fmt_money(d['asking_price'])}")
    if d.get("pitch_out_price"):
        money_bits.append(f"pitch-out {_fmt_money(d['pitch_out_price'])}")
    elif d.get("offer_price"):
        money_bits.append(f"offer {_fmt_money(d['offer_price'])}")

    out = f"{label}. {stage}"
    if money_bits:
        out += ", " + ", ".join(money_bits)
    if units:
        out += f", {units} units"
    if d.get("cap_rate_crm"):
        out += f", cap {d['cap_rate_crm']}"
    out += "."

    if d.get("owner_contact_id"):
        owner = (
            supabase.table("ace_contacts")
            .select("name,company")
            .eq("id", d["owner_contact_id"])
            .is_("deleted_at", "null")
            .limit(1)
            .execute()
            .data or []
        )
        if owner:
            o = owner[0]
            owner_str = o.get("name") or "owner unknown"
            if o.get("company"):
                owner_str += f" at {o['company']}"
            out += f" Owner {owner_str}."

    offers = (
        supabase.table("ace_deal_offers")
        .select("offer_type,party_name,amount,offer_date,is_winning")
        .eq("deal_id", d["id"])
        .is_("deleted_at", "null")
        .order("offer_date", desc=True)
        .limit(1)
        .execute()
        .data or []
    )
    if offers:
        o = offers[0]
        amt = _fmt_money(o["amount"]) if o.get("amount") else ""
        party = o.get("party_name") or "buyer"
        win = " (winning)" if o.get("is_winning") else ""
        out += f" Latest offer {amt} from {party}{win}."

    days = _days_since(d.get("updated_at"))
    if days is not None and days > 14 and stage not in ("Closed", "Dead", "Lost"):
        out += f" No movement in {days} days."

    return out


# ───────────────── routing ─────────────────
def route(transcript: str) -> str:
    t = transcript.lower().strip().rstrip(".?!")

    if re.search(r"\b(daily|morning)\s+brief\b|\bbrief\s+me\b", t):
        return cmd_daily_brief()

    m = re.search(
        r"\b(?:contact\s+lookup|look\s+up|lookup|find\s+contact|find)\s+(.+)$", t
    )
    if m:
        return cmd_contact_lookup(m.group(1).strip())

    m = re.search(
        r"\b(?:deal\s+snapshot|snapshot|deal\s+on|"
        r"what'?s\s+(?:going\s+on|happening)\s+with)\s+(.+)$",
        t,
    )
    if m:
        return cmd_deal_snapshot(m.group(1).strip())

    return ask_claude(transcript)


def ask_claude(prompt: str) -> str:
    system = (
        f"{PERSONA}\n\n---\n\n{SETTINGS}\n\n---\n\n"
        "You are speaking through a TTS voice (OpenAI onyx). "
        "Reply in 2 sentences max, plain spoken English, no markdown, no bullet "
        "points. Under ~30 seconds of audio. If you don't have the data, say so "
        "in one sentence and stop."
    )
    msg = anthropic.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=MAX_REPLY_TOKENS,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text.strip()


# ───────────────── FastAPI ─────────────────
app = FastAPI(title="ace-agent")


@app.get("/")
def index():
    return FileResponse(AGENT_DIR / "index.html")


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

        reply = route(transcript)
        mp3 = synthesize(reply)
        audio_b64 = base64.b64encode(mp3).decode("ascii")

        print(f"\n🗣  You:  {transcript}\n🔊 Ace: {reply}\n")
        return {"transcript": transcript, "reply": reply, "audio": audio_b64}

    except HTTPException:
        raise
    except Exception as e:
        print(f"⚠  /api/turn error: {type(e).__name__}: {e}")
        raise HTTPException(500, f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    import uvicorn
    print("ace-agent → http://localhost:8000\n  Spacebar or click the mic to record.")
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
