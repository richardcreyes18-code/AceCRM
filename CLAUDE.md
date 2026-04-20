# Ace Acquisitions CRM — Project Context
## What this is
Single-file HTML CRM for Ace Acquisitions (NJ commercial real estate brokerage).
Backend: Supabase (project id: kxtuegjptvzqycgyzehj).
Current working file: Ace_Acquisitions_CRM_Supabase_v111.11.html
This file lives in ~/Documents/ace-crm/
## How to edit
- Make all edits directly to the HTML file
- Run the syntax check after every edit (see below)
- Bump the version number in the filename when shipping (v111.10 → v111.11)
- Keep the prior version on disk until browser-tested
## Syntax check — run after every single edit
```bash
FILE=~/Documents/ace-crm/Ace_Acquisitions_CRM_Supabase_v111.11.html
END=$(grep -n "^</script>" "$FILE" | tail -1 | cut -d: -f1)
sed -n "1640,$((END-1))p" "$FILE" > /tmp/main.js
node -e "const fs=require('fs');try{new Function(fs.readFileSync('/tmp/main.js','utf8'));console.log('✓ SYNTAX OK');}catch(e){console.log('✗',e.message);}"
```
## Critical rules — never break these
- NEVER use `<script>` tags inside template literals — breaks the enclosing script block
- NEVER edit tables: `fub_contacts`, `fub_notes`, `fub_deals`, `fub_calls` — read-only, owned by Ricky's boss
- `getConfig()` returns `{url, key}` NOT `{base, key}`
- `_sbPost` / `_sbPatch` / `_sbGet` all go through the crm-proxy Edge Function
- RLS is OFF on all `ace_*` tables
- Supabase Edge Functions timeout at 150s — chunked/resumable patterns required for large jobs
- FUB (Follow Up Boss) API rate limit: 250 req/min — 11s wait on 429
## Backend — Supabase project kxtuegjptvzqycgyzehj
**Edge Functions (all deployed, don't recreate):**
- `crm-proxy` (v10) — all CRUD + RPC passthrough. Has safeDecode() fix for ilike % wildcards.
- `fub-stages-sync` (v4) — chunked FUB deal stage sync with confidence gate (addr score ≥ 4)
- `fub-calls-sync` — pulls FUB calls into fub_calls
- `fub-probe` — diagnostic
- `ai-parse-deal`, `ai-parse-batch` — Claude Haiku deal parsing
- `bc-auto-extract` — buyer criteria extraction
- `crm-ai-assist` — AI chat assistant
- `setup-users`, `admin-users` — user management
**Key tables:**
- `ace_properties` — main deals table. Has `fub_deal_id BIGINT` column (v111.9 addition)
- `ace_contacts` — 17,878 contacts, 17,557 have `fub_contact_id`
- `ace_fub_sync_log` — sync run history
- `ace_fub_unmatched_deals` — 1,626 FUB deals needing manual triage
- `ace_portfolios`, `ace_portfolio_members` — portfolio grouping
**Key RPCs:**
- `_fub_unmatched_counts()` — aggregate stats for unmatched review page
- `merge_contacts` (v3), `preview_merge_contacts`, `undo_merge`
- `run_dedupe_detection`, `_normalize_phone`
- `analyze_fub_import`, `execute_fub_import`, `undo_fub_import`
- `run_asset_type_cleanup`
## Current data state (as of 2026-04-19)
- 10,213 properties in ace_properties
- 17,878 contacts in ace_contacts
- 4,444 properties back-referenced to FUB deals via fub_deal_id
- 1,626 FUB deals pending review in ace_fub_unmatched_deals
- Hot Active Listing count: 21 (FUB shows 33; 12-deal gap = deals whose properties aren't in CRM)
## What was just shipped — v111.10
1. FUB pipeline sync UI — Settings → "Open sync →" tile. Runs fub-stages-sync Edge Function in chunks, shows live progress + history table.
2. Unmatched FUB deals review — Settings → "Open review →" tile. Paginated table with filters (pipeline, stage, low-confidence), per-row Link/Ignore actions, bulk actions, Link modal with address search.
3. crm-proxy v10 fix — safeDecode() prevents URIError on SQL wildcard % in ilike filters.
4. RPC _fub_unmatched_counts() — avoids PostgREST 1000-row cap for stats strip.
5. fub-stages-sync v4 — confidence gate: requires address similarity score ≥ 4 before updating stage. Low-confidence matches logged to ace_fub_unmatched_deals with resolution_notes='low_confidence_score_N'.
## Pending backlog (priority order)
1. Browser-test v111.10: open Settings, run a dry-run sync, open review page, filter by Hot Active, try linking one deal via the modal
2. Portfolio chips on contact detail page — contacts who are in ace_portfolios should show portfolio name chips on their detail view
3. Dedupe UI wiring — merge_contacts RPC exists, needs a working merge button with preview step (preview_merge_contacts RPC)
4. Reassign 453 no-agent + 193 Cole-Manowski Ship 3 imports — bulk UPDATE on ace_properties.fub_assigned_to
5. Twilio/Gmail/Contact Page 6-phase build (biggest item): DB tables → Twilio Edge Fns → Gmail OAuth → Contact page UI v2 → Click-to-call → Polish. Need: Twilio account + NJ number + SID/Auth Token + Gmail API OAuth2 Client ID. ~$5-15/mo.
## How to find things in the file
The file is 40,000+ lines. Always grep before reading large sections:
```bash
grep -n "functionName\|keyword" Ace_Acquisitions_CRM_Supabase_v111.10.html | head -20
```
Key line ranges (approximate, grep to confirm):
- DB call helpers (_sbGet, _sbPatch, etc): ~line 1968
- showSettingsPage(): ~line 21289
- Settings tiles (FUB sync, dedupe, etc): ~line 21344–21420
- _fubSyncOpen() and driver: ~line 37268
- _fubUnmatchedOpen() and review page: ~line 37580
- _fubImportOpen() and helpers: ~line 36676
- showDedupePage(): ~line 25131
- Dashboard: ~line 2600
## Git workflow
Branch strategy: all work goes to `staging` first. Richard reviews on the
Vercel staging URL, then merges to `main` to go live.

**ALWAYS work on the staging branch:**
```bash
cd ~/Documents/ace-crm
git checkout staging
```

**Ship a new version (run these steps in order):**
```bash
# 1. Bump version — copy edited file to new version number
cp Ace_Acquisitions_CRM_Supabase_v111.11.html Ace_Acquisitions_CRM_Supabase_v111.12.html
# (make edits to the new file, run syntax check)

# 2. Update index.html — Vercel always serves this file
cp Ace_Acquisitions_CRM_Supabase_v111.12.html index.html

# 3. Commit and push to staging
git add Ace_Acquisitions_CRM_Supabase_v111.12.html index.html CLAUDE.md
git commit -m "v111.12: description of what changed"
git push origin staging
```

Vercel auto-deploys the staging branch to its preview URL for review.
Richard merges staging → main on GitHub when ready to go live.

Always commit a working version before starting new work.
