-- v357: nightly auto-scan for new dedupe candidates.
--
-- Before this, `run_dedupe_detection()` only ran when the user clicked
-- "Scan now" on the Contact Dedupe page. That meant contacts created
-- after the last manual scan (e.g. the FUB hourly sync drops in new
-- rows, agent adds a buyer manually, etc.) didn't surface in the dedupe
-- queue until someone remembered to re-scan — leading to the "I see
-- these two contacts but they're not in dedupe" symptom.
--
-- Run at 3:17 AM nightly. That's well after the FUB hourly syncs have
-- settled and before agents start their day, so the queue is always
-- fresh when the office logs in.

SELECT cron.schedule(
  'run_dedupe_detection_nightly',
  '17 3 * * *',
  $$ SELECT public.run_dedupe_detection(); $$
);
