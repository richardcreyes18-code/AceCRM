-- v372: auto-resolve clear-negative dedupe candidates.
--
-- When phone-match candidates ALSO have different names AND both
-- contacts have non-empty different emails, the pair is almost
-- certainly two unrelated people sharing a phone (household, business
-- line, prior number reassignment). These don't deserve human review
-- time. Auto-mark them `status='not_duplicates'` at detection time
-- so the queue UI (which filters status=eq.pending) never surfaces
-- them.
--
-- For phone-match groups the gate is:
--   pair_clear_negative = names NOT similar
--                         AND email_a IS NOT NULL AND email_b IS NOT NULL
--                         AND email_a <> email_b
--
-- For groups of 3+, ANY clear-negative pair makes the whole group a
-- clear negative (since auto-merge would re-point everything into one
-- contact). The user can still manually decide to merge any subset
-- via the "Manual merge" path off the Settings → Recent Merges UI if
-- they want to.
--
-- Email-match groups: we DON'T auto-skip there. A shared email is a
-- stronger signal of identity than a shared phone, and the inverse
-- ("emails match, names + phones differ") is rare enough that we'd
-- rather have the human look. They stay as `tier='medium',
-- match_signal='email_names_differ'`.

CREATE OR REPLACE FUNCTION public.run_dedupe_detection()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_phone_high         int := 0;
  v_phone_medium       int := 0;
  v_phone_auto_skipped int := 0;
  v_email_high         int := 0;
  v_email_medium       int := 0;
  v_name_count         int := 0;
  v_kept_count         int := 0;
  v_total              int;
BEGIN
  DELETE FROM ace_contact_dedupe_candidates WHERE status = 'pending';

  -- ─── Tier 1: Phone-match groups ─────────────────────────────────────
  --
  -- Classification for each group of contacts sharing a phone:
  --   * clear_negative: any pair has BOTH different names AND different
  --     non-empty emails → status='not_duplicates' (auto-skipped).
  --   * else all names similar pairwise              → tier 'high'.
  --   * else                                          → tier 'medium'.
  WITH normalized AS (
    SELECT
      id,
      name,
      LOWER(TRIM(SPLIT_PART(COALESCE(email,''), '+', 1))) AS email_norm,
      REGEXP_REPLACE(COALESCE(phone_number,''), '[^0-9]', '', 'g') AS phone_digits
    FROM ace_contacts
    WHERE deleted_at IS NULL
  ),
  groups AS (
    SELECT
      phone_digits,
      ARRAY_AGG(id          ORDER BY id) AS contact_ids,
      ARRAY_AGG(name        ORDER BY id) AS names,
      ARRAY_AGG(email_norm  ORDER BY id) AS emails,
      COUNT(*)::int AS n
    FROM normalized
    WHERE LENGTH(phone_digits) >= 10
    GROUP BY phone_digits
    HAVING COUNT(*) > 1
  ),
  classified AS (
    SELECT
      contact_ids,
      phone_digits,
      EXISTS (
        SELECT 1
          FROM generate_subscripts(names, 1) i,
               generate_subscripts(names, 1) j
         WHERE i < j
           AND NOT _dd_names_similar(names[i], names[j])
           AND emails[i] <> ''
           AND emails[j] <> ''
           AND emails[i] <> emails[j]
      ) AS clear_negative,
      NOT EXISTS (
        SELECT 1
          FROM generate_subscripts(names, 1) i,
               generate_subscripts(names, 1) j
         WHERE i < j
           AND NOT _dd_names_similar(names[i], names[j])
      ) AS all_similar
    FROM groups
  ),
  ins AS (
    INSERT INTO ace_contact_dedupe_candidates
      (contact_ids, tier, match_signal, match_value, status, status_set_at)
    SELECT
      contact_ids,
      CASE
        WHEN clear_negative THEN 'low'
        WHEN all_similar    THEN 'high'
        ELSE 'medium'
      END,
      CASE
        WHEN clear_negative THEN 'phone_clear_negative'
        WHEN all_similar    THEN 'phone'
        ELSE 'phone_names_differ'
      END,
      phone_digits,
      CASE WHEN clear_negative THEN 'not_duplicates' ELSE 'pending' END,
      CASE WHEN clear_negative THEN now() ELSE NULL END
    FROM classified
    RETURNING
      (CASE WHEN status = 'not_duplicates' THEN 1 ELSE 0 END) AS auto_skipped,
      (CASE WHEN tier = 'high'    AND status = 'pending' THEN 1 ELSE 0 END) AS h,
      (CASE WHEN tier = 'medium'  AND status = 'pending' THEN 1 ELSE 0 END) AS m
  )
  SELECT
    COALESCE(SUM(h), 0)::int,
    COALESCE(SUM(m), 0)::int,
    COALESCE(SUM(auto_skipped), 0)::int
  INTO v_phone_high, v_phone_medium, v_phone_auto_skipped
  FROM ins;

  -- ─── Tier 2: Email-match groups (unchanged from v370) ───────────────
  WITH already_grouped AS (
    SELECT UNNEST(contact_ids) AS contact_id
    FROM ace_contact_dedupe_candidates
    WHERE match_signal IN ('phone','phone_names_differ','phone_clear_negative')
  ),
  normalized AS (
    SELECT
      c.id,
      c.name,
      LOWER(TRIM(SPLIT_PART(COALESCE(c.email,''), '+', 1))) AS email_norm
    FROM ace_contacts c
    WHERE c.deleted_at IS NULL
      AND c.id NOT IN (SELECT contact_id FROM already_grouped)
  ),
  groups AS (
    SELECT
      email_norm,
      ARRAY_AGG(id   ORDER BY id) AS contact_ids,
      ARRAY_AGG(name ORDER BY id) AS names,
      COUNT(*) AS n
    FROM normalized
    WHERE email_norm <> '' AND email_norm LIKE '%@%'
    GROUP BY email_norm
    HAVING COUNT(*) > 1
  ),
  classified AS (
    SELECT
      contact_ids,
      email_norm,
      NOT EXISTS (
        SELECT 1
          FROM generate_subscripts(names, 1) i,
               generate_subscripts(names, 1) j
         WHERE i < j
           AND NOT _dd_names_similar(names[i], names[j])
      ) AS all_similar
    FROM groups
  ),
  ins AS (
    INSERT INTO ace_contact_dedupe_candidates (contact_ids, tier, match_signal, match_value)
    SELECT
      contact_ids,
      CASE WHEN all_similar THEN 'high' ELSE 'medium' END,
      CASE WHEN all_similar THEN 'email' ELSE 'email_names_differ' END,
      email_norm
    FROM classified
    RETURNING (CASE WHEN tier='high' THEN 1 ELSE 0 END) AS h
  )
  SELECT
    COALESCE(SUM(h), 0)::int,
    COALESCE(COUNT(*) - SUM(h), 0)::int
  INTO v_email_high, v_email_medium
  FROM ins;

  -- ─── Tier 3: Name-only match (unchanged) ───────────────────────────
  WITH already_grouped AS (
    SELECT UNNEST(contact_ids) AS contact_id
    FROM ace_contact_dedupe_candidates
    WHERE match_signal IN (
      'phone','phone_names_differ','phone_clear_negative',
      'email','email_names_differ'
    )
  ),
  normalized AS (
    SELECT
      c.id,
      LOWER(TRIM(REGEXP_REPLACE(c.name, '\s+', ' ', 'g'))) AS name_norm
    FROM ace_contacts c
    WHERE c.deleted_at IS NULL
      AND c.id NOT IN (SELECT contact_id FROM already_grouped)
  ),
  groups AS (
    SELECT
      name_norm,
      ARRAY_AGG(id ORDER BY id) AS contact_ids,
      COUNT(*) AS n
    FROM normalized
    WHERE LENGTH(name_norm) >= 5
    GROUP BY name_norm
    HAVING COUNT(*) > 1
  )
  INSERT INTO ace_contact_dedupe_candidates (contact_ids, tier, match_signal, match_value)
  SELECT contact_ids, 'medium', 'name', name_norm
  FROM groups;
  GET DIAGNOSTICS v_name_count = ROW_COUNT;

  SELECT COUNT(*) INTO v_kept_count
  FROM ace_contact_dedupe_candidates
  WHERE status NOT IN ('pending');

  v_total := v_phone_high + v_phone_medium + v_email_high + v_email_medium + v_name_count;

  RETURN jsonb_build_object(
    'success',              true,
    'pending_groups',       v_total,
    'high_phone',           v_phone_high,
    'medium_phone',         v_phone_medium,
    'auto_skipped_phone',   v_phone_auto_skipped,
    'high_email',           v_email_high,
    'medium_email',         v_email_medium,
    'medium_name',          v_name_count,
    'kept_decisions',       v_kept_count,
    'scanned_at',           now()
  );
END;
$function$;

COMMENT ON FUNCTION public.run_dedupe_detection() IS
  'v372: phone-match groups where names AND emails BOTH differ are '
  'auto-resolved as not_duplicates (status=''not_duplicates'') so they '
  'never reach the review queue — they''re almost always household '
  'phones or business lines, not the same person. Same name-aware '
  'tier logic as v370 otherwise.';
