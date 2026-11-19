# /daily-brief

Morning rundown. Three blocks, in this order, spoken not listed. ~30 seconds total.

## What to pull

**1. Tasks due today or overdue**
```sql
SELECT id, task, due_date, priority, property_id, contact_id
FROM ace_tasks
WHERE (status IS NULL OR status NOT IN ('done', 'completed', 'archived'))
  AND due_date IS NOT NULL
  AND due_date <= CURRENT_DATE
ORDER BY due_date ASC,
  CASE priority
    WHEN 'High' THEN 1 WHEN 'high' THEN 1
    WHEN 'Medium' THEN 2 WHEN 'medium' THEN 2
    ELSE 3
  END
LIMIT 5;
```

**2. Recent property/deal activity (last 48h)**
Sort so Spread / Pitch Out / Accepted bubble first.
```sql
SELECT id, address, property_name, pipeline_stage, asking_price,
       offer_price, pitch_out_price, top_priority, updated_at
FROM ace_properties
WHERE deleted_at IS NULL
  AND is_archived = false
  AND updated_at >= NOW() - INTERVAL '48 hours'
ORDER BY
  CASE pipeline_stage
    WHEN 'Spread' THEN 1
    WHEN 'Pitch Out' THEN 2
    WHEN 'Accepted' THEN 3
    WHEN 'Starter' THEN 4
    WHEN 'Asking' THEN 5
    ELSE 6
  END,
  updated_at DESC
LIMIT 5;
```

**3. Top-priority deals not touched in 14+ days**
Catches anything important he's neglecting.
```sql
SELECT id, address, property_name, pipeline_stage, updated_at
FROM ace_properties
WHERE deleted_at IS NULL
  AND is_archived = false
  AND top_priority = true
  AND updated_at < NOW() - INTERVAL '14 days'
  AND pipeline_stage NOT IN ('Closed', 'Dead', 'Lost')
ORDER BY updated_at ASC
LIMIT 3;
```

## How to deliver it

Lead with whichever block has weight. Skip empty blocks silently — never announce "you have no tasks today."

> "Three tasks today — call Mike Chen back on Newark, submit the LOI for 412 Market, follow up with Atlas. Two deals moved overnight: 412 Market hit Spread, Elizabeth portfolio bumped to Pitch Out. Heads up — Paterson Hotel hasn't been touched in 22 days and it's flagged top priority."

## Edge cases
- All three empty: "Quiet morning. Nothing pressing in Ace."
- Only block 1 has data: just announce the tasks.
- More than 5 hot deals moved: only mention the top 3 by stage rank, then "and a few more in Pitch Out."

## Future additions (not wired yet)
- Google Calendar events for today
- Unread Quo SMS / Gmail emails from known contacts
