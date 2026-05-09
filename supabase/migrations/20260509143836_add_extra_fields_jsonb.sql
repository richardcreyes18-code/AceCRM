-- v288: per-record JSONB bucket for runtime-defined buyer-criteria
-- requirements fields. Lets new fields be added via Settings without
-- per-field schema migrations. Field schema lives in
-- ace_ai_settings.bc_field_definitions.

ALTER TABLE ace_buyer_criteria
  ADD COLUMN IF NOT EXISTS extra_fields jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN ace_buyer_criteria.extra_fields IS
  'Runtime-defined per-category requirements fields. Schema lives in '
  'ace_ai_settings.bc_field_definitions; values keyed by field col.';
