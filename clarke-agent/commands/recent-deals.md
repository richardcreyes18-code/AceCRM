# /recent-deals

Show the most recently added deals/properties. Triggered by phrasings like:
- *"What's the most recent deal I've added?"*
- *"Last three deals I inputted"*
- *"Newest deals"*
- *"Latest properties"*
- *"What deals have I added recently?"*

## Query

```sql
SELECT
  id, address, property_name, complex_name,
  property_type_text, crm_asset_classification,
  pipeline_stage, asking_price,
  municipality, state, created_at
FROM ace_properties
WHERE deleted_at IS NULL
  AND is_archived = false
ORDER BY created_at DESC
LIMIT 5;
```

## How to deliver it

Lead with the count, then walk top entries with address + asset type.

> "Last five deals you added: 412 Market in Newark — multifamily; 88 River Road in Elizabeth — boutique hotel; 1109 Smith Street in Jersey City — mixed-use; …"

If user asked for a specific number ("last three"), Claude trims from the top of the list. The fetch always returns 5 — formatting is Claude's job.

## What to skip
- Don't read the price unless asked.
- Don't read the pipeline stage unless asked.
- City + asset type is the meat — that's how Ricky orients on a fresh deal.
