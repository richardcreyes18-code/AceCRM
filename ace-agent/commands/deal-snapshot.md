# /deal-snapshot [address or deal name]

Everything he needs about a deal in 15 seconds of audio. Note: in this CRM a "deal" is a row in `ace_properties`.

## Arguments
- `query` — address fragment, property name, or complex name. Match all three.

## Query

```sql
-- Step 1: find the property (top 3 if ambiguous)
SELECT id, address, property_name, complex_name, municipality, state,
       pipeline_stage, deal_tag, next_steps,
       asking_price, offer_price, pitch_out_price, target_seller_net,
       cap_rate_crm, noi,
       COALESCE(number_of_units, no_of_units) AS units,
       owner_contact_id, top_priority, updated_at
FROM ace_properties
WHERE deleted_at IS NULL
  AND is_archived = false
  AND (
    address ILIKE '%' || :query || '%'
    OR property_name ILIKE '%' || :query || '%'
    OR complex_name ILIKE '%' || :query || '%'
  )
ORDER BY top_priority DESC NULLS LAST, updated_at DESC
LIMIT 3;
```

```sql
-- Step 2: owner contact name (single lookup)
SELECT name, company, contact_role
FROM ace_contacts
WHERE id = :owner_contact_id AND deleted_at IS NULL;
```

```sql
-- Step 3: recent offers on this deal
SELECT offer_type, party_name, amount, offer_date, is_winning, presentation_status
FROM ace_deal_offers
WHERE deal_id = :property_id
  AND deleted_at IS NULL
ORDER BY COALESCE(offer_date, created_at::date) DESC
LIMIT 3;
```

```sql
-- Step 4: open tasks on this deal
SELECT task, due_date, priority
FROM ace_tasks
WHERE property_id = :property_id
  AND (status IS NULL OR status NOT IN ('done', 'completed', 'archived'))
ORDER BY due_date ASC NULLS LAST
LIMIT 3;
```

## How to deliver it

Address (or property name), stage, headline price, owner, then the single most recent meaningful event.

> "412 Market Street, Newark. Spread stage, asking $4.2M, pitch-out $4.05M, 28 units, cap 7.1. Owner Mike Chen at Atlas. Latest offer is $3.95M from a buyer last Thursday — winning bid. One open task: send T12 by Friday."

## Stage-specific emphasis
- **Asking / Starter:** lead with asking price and last touch.
- **Accepted:** lead with target seller net and what's blocking close.
- **Pitch Out / Spread:** lead with the spread (`pitch_out_price` − `target_seller_net`) and the most recent offer party.
- **Closed / Dead:** brief recap, don't dwell.

## Multiple matches
Top 3, one-liner each:

> "Two on Market Street — 412 Market in Newark at Spread, and 88 Market in Elizabeth at Asking. Want the Newark one?"

## No match
> "No deal matching [query] in Ace."

## Stale flag
If `updated_at` is more than 14 days old and `pipeline_stage` is active (not Closed/Dead/Lost), append:

> "…heads up, no movement in 19 days."
