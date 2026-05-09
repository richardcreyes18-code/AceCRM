-- v283: per-record marker for the most recent AI auto-fill apply.
-- Lets the UI sort/filter by "last autofilled" without scanning the
-- ai_autofill_log JSONB array, and gives both BC + contact records a
-- top-level recency signal.

ALTER TABLE ace_buyer_criteria
  ADD COLUMN IF NOT EXISTS last_ai_autofill_at timestamptz;

ALTER TABLE ace_contacts
  ADD COLUMN IF NOT EXISTS last_ai_autofill_at timestamptz;

CREATE INDEX IF NOT EXISTS ace_buyer_criteria_last_ai_autofill_at_idx
  ON ace_buyer_criteria (last_ai_autofill_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS ace_contacts_last_ai_autofill_at_idx
  ON ace_contacts (last_ai_autofill_at DESC NULLS LAST);

COMMENT ON COLUMN ace_buyer_criteria.last_ai_autofill_at IS
  'Timestamp of the most recent ✦ AI Auto-Fill apply on this BC. '
  'See ai_autofill_log for the full per-run history.';
COMMENT ON COLUMN ace_contacts.last_ai_autofill_at IS
  'Timestamp of the most recent ✦ AI Auto-Fill apply on this contact''s '
  'buyer-criteria record (set by the BC apply path).';
