# /contact-lookup [name]

Pull a contact and their recent context. One-breath answer.

## Arguments
- `name` — partial or full. Match case-insensitive against `ace_contacts.name`.

## Query

```sql
-- Step 1: find the contact (top 3 if ambiguous)
SELECT id, name, company, contact_role,
       phone_mobile, phone_office, phone_number,
       email, type, updated_at
FROM ace_contacts
WHERE deleted_at IS NULL
  AND name ILIKE '%' || :name || '%'
ORDER BY updated_at DESC NULLS LAST
LIMIT 3;
```

```sql
-- Step 2: recent structured notes on the matched contact
SELECT subject, body, created_at
FROM ace_contact_notes
WHERE contact_id = :contact_id
  AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 2;
```

```sql
-- Step 3: properties this contact owns
SELECT id, address, property_name, pipeline_stage, asking_price
FROM ace_properties
WHERE owner_contact_id = :contact_id
  AND deleted_at IS NULL
  AND is_archived = false
ORDER BY updated_at DESC
LIMIT 3;
```

## How to deliver it

Lead with name + role/company, then the most recent useful fact, then any properties they own (one-liner).

> "Mike Chen, principal at Atlas Capital. Last note Tuesday — he wants the T12 on Newark by Friday. Owns 412 Market and the Elizabeth portfolio."

## Multiple matches
Distinguish by company; don't ask him to clarify:

> "Two Mike Chens — one at Atlas Capital, one at Chen Hospitality. Atlas was touched yesterday."

## No match
> "Nothing on [name] in Ace."

Don't fall back to FUB unless he explicitly asks — those tables are read-only and the data is stale by design.

## What to skip
- Don't read full email or phone aloud unless asked. He has them in the CRM.
- Don't recite the `type` array as a list. Mention it only if it's load-bearing ("flagged as a buyer").
- Don't summarize old notes if a fresh one exists.

## Future additions (not wired yet)
- Recent `fub_calls` and `fub_notes` joined via `ace_contacts.fub_contact_id` → `person_id`
