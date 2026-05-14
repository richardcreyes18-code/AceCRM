-- v368.2: merge_contacts hotfix — collapse duplicate ace_contact_fub_links
-- across the entire merge group, not just survivor↔loser pairs.
--
-- v368 / v368.1 pre-deleted loser-side links only when the SURVIVOR
-- already had a link to the same fub_contact_id. But the table's
-- `ace_contact_fub_links_pair_unique` constraint (UNIQUE(ace_id,
-- fub_contact_id)) also fires when TWO losers both link to the same
-- fub_contact_id — re-pointing loser_A to survivor is fine, then
-- re-pointing loser_B to survivor collides with what loser_A just
-- wrote.
--
-- The new pre-pass uses DISTINCT ON (fub_contact_id) to keep exactly
-- one link per FUB id across the survivor + every loser, preferring
-- the survivor's row when available, then the longest-known loser
-- link. Every other duplicate is hard-deleted. The remaining UPDATE
-- re-points the kept loser links to the survivor with no possible
-- collision.
--
-- Same logic in every other respect as v368.1.

CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_surviving_id uuid,
  p_loser_ids    uuid[],
  p_field_values jsonb,
  p_user_id      uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_surviving_before  jsonb;
  v_surviving_after   jsonb;
  v_losers_snapshot   jsonb := '[]'::jsonb;
  v_fk_repointed      jsonb := '[]'::jsonb;
  v_loser_id          uuid;
  v_loser_data        jsonb;
  v_repointed_count   int := 0;
  v_log_id            uuid;
  v_temp_count        int;
  v_unioned_types     text[];
  v_final_types       text[];
  v_bc_count          int;
  v_unioned_fub_tags   text[];
  v_unioned_all_phones jsonb;
  v_unioned_all_emails jsonb;
  v_unioned_addresses  jsonb;
  v_combined_migration text;
  v_surv_fub_contact_id bigint;
  v_loser_fub_contact_id bigint;
BEGIN
  IF p_surviving_id = ANY(p_loser_ids) THEN
    RAISE EXCEPTION 'Surviving contact cannot also be a loser';
  END IF;
  IF array_length(p_loser_ids, 1) IS NULL OR array_length(p_loser_ids, 1) < 1 THEN
    RAISE EXCEPTION 'Must provide at least one loser contact';
  END IF;

  SELECT to_jsonb(c.*) INTO v_surviving_before
    FROM ace_contacts c WHERE c.id = p_surviving_id AND c.deleted_at IS NULL;
  IF v_surviving_before IS NULL THEN
    RAISE EXCEPTION 'Surviving contact % not found or already deleted', p_surviving_id;
  END IF;

  SELECT COUNT(*) INTO v_temp_count FROM ace_contacts
    WHERE id = ANY(p_loser_ids) AND deleted_at IS NULL;
  IF v_temp_count != array_length(p_loser_ids, 1) THEN
    RAISE EXCEPTION 'One or more loser contacts not found or already deleted';
  END IF;

  SELECT COUNT(*) INTO v_bc_count
    FROM ace_buyer_criteria
    WHERE contact_id = ANY(ARRAY[p_surviving_id] || p_loser_ids)
      AND deleted_at IS NULL;
  IF v_bc_count >= 2 THEN
    RAISE EXCEPTION 'BC_COLLISION: % of these contacts have buyer criteria. Open each contact''s Buyer Criteria tab, consolidate the data into one, delete the others, then return to merge.', v_bc_count;
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT t FROM ace_contacts c, UNNEST(COALESCE(c.type, ARRAY[]::text[])) AS t
    WHERE c.id = p_surviving_id OR c.id = ANY(p_loser_ids)
  ) INTO v_unioned_types;

  IF p_field_values ? 'type' THEN
    v_final_types := ARRAY(SELECT jsonb_array_elements_text(p_field_values->'type'));
  ELSE
    v_final_types := v_unioned_types;
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT t FROM ace_contacts c, UNNEST(COALESCE(c.fub_tags, ARRAY[]::text[])) AS t
    WHERE c.id = p_surviving_id OR c.id = ANY(p_loser_ids)
  ) INTO v_unioned_fub_tags;

  SELECT COALESCE(jsonb_agg(DISTINCT elem ORDER BY elem), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements(COALESCE(all_phones, '[]'::jsonb)) AS elem
        FROM ace_contacts WHERE id = p_surviving_id OR id = ANY(p_loser_ids)
    ) e INTO v_unioned_all_phones;

  SELECT COALESCE(jsonb_agg(DISTINCT elem ORDER BY elem), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements(COALESCE(all_emails, '[]'::jsonb)) AS elem
        FROM ace_contacts WHERE id = p_surviving_id OR id = ANY(p_loser_ids)
    ) e INTO v_unioned_all_emails;

  SELECT COALESCE(jsonb_agg(DISTINCT elem ORDER BY elem), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements(COALESCE(addresses, '[]'::jsonb)) AS elem
        FROM ace_contacts WHERE id = p_surviving_id OR id = ANY(p_loser_ids)
    ) e INTO v_unioned_addresses;

  SELECT string_agg(NULLIF(TRIM(migration_notes), ''), E'\n\n' ORDER BY id = p_surviving_id DESC, created_at NULLS LAST)
    FROM ace_contacts
    WHERE (id = p_surviving_id OR id = ANY(p_loser_ids))
      AND migration_notes IS NOT NULL AND TRIM(migration_notes) <> ''
    INTO v_combined_migration;

  SELECT fub_contact_id INTO v_surv_fub_contact_id
    FROM ace_contacts WHERE id = p_surviving_id;
  IF v_surv_fub_contact_id IS NULL THEN
    SELECT fub_contact_id INTO v_loser_fub_contact_id
      FROM ace_contacts
      WHERE id = ANY(p_loser_ids) AND fub_contact_id IS NOT NULL
      ORDER BY created_at NULLS LAST
      LIMIT 1;
  END IF;

  FOR v_loser_id IN SELECT UNNEST(p_loser_ids) LOOP
    SELECT to_jsonb(c.*) INTO v_loser_data FROM ace_contacts c WHERE c.id = v_loser_id;
    v_losers_snapshot := v_losers_snapshot || jsonb_build_array(v_loser_data);
  END LOOP;

  -- v368.1: clear loser's fub_contact_id before survivor adopts it
  IF v_surv_fub_contact_id IS NULL AND v_loser_fub_contact_id IS NOT NULL THEN
    UPDATE ace_contacts SET fub_contact_id = NULL
      WHERE id = ANY(p_loser_ids) AND fub_contact_id = v_loser_fub_contact_id;
  END IF;

  UPDATE ace_contacts SET
    name            = COALESCE(p_field_values->>'name',            name),
    phone_number    = COALESCE(p_field_values->>'phone_number',    phone_number),
    secondary_phone = COALESCE(p_field_values->>'secondary_phone', secondary_phone),
    email           = COALESCE(p_field_values->>'email',           email),
    secondary_email = COALESCE(p_field_values->>'secondary_email', secondary_email),
    company         = COALESCE(p_field_values->>'company',         company),
    contact_notes   = COALESCE(p_field_values->>'contact_notes',   contact_notes),
    type            = v_final_types,
    fub_tags        = v_unioned_fub_tags,
    all_phones      = v_unioned_all_phones,
    all_emails      = v_unioned_all_emails,
    addresses       = v_unioned_addresses,
    migration_notes = COALESCE(v_combined_migration, migration_notes),
    fub_contact_id  = COALESCE(fub_contact_id, v_loser_fub_contact_id)
  WHERE id = p_surviving_id;

  SELECT to_jsonb(c.*) INTO v_surviving_after FROM ace_contacts c WHERE c.id = p_surviving_id;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_properties','column','owner_contact_id','row_id', id, 'old_id', owner_contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_properties WHERE owner_contact_id = ANY(p_loser_ids));
  UPDATE ace_properties SET owner_contact_id = p_surviving_id WHERE owner_contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_buyer_criteria','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_buyer_criteria WHERE contact_id = ANY(p_loser_ids) AND deleted_at IS NULL);
  UPDATE ace_buyer_criteria SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids) AND deleted_at IS NULL;
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_buyer_pitches','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_buyer_pitches WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_buyer_pitches SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_buyer_interests','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_buyer_interests WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_buyer_interests SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_contact_history','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_contact_history WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_contact_history SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_deal_offers','column','party_contact_id','row_id', id, 'old_id', party_contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_deal_offers WHERE party_contact_id = ANY(p_loser_ids));
  UPDATE ace_deal_offers SET party_contact_id = p_surviving_id WHERE party_contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_portfolio_offers','column','party_contact_id','row_id', id, 'old_id', party_contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_portfolio_offers WHERE party_contact_id = ANY(p_loser_ids));
  UPDATE ace_portfolio_offers SET party_contact_id = p_surviving_id WHERE party_contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_tasks','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_tasks WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_tasks SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  DELETE FROM ace_workbench_items wb_l
    WHERE wb_l.item_type = 'contact' AND wb_l.contact_id = ANY(p_loser_ids)
      AND EXISTS (SELECT 1 FROM ace_workbench_items wb_s
                   WHERE wb_s.item_type = 'contact' AND wb_s.contact_id = p_surviving_id AND wb_s.user_id = wb_l.user_id);
  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_workbench_items','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_workbench_items WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_workbench_items SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  DELETE FROM ace_agent_contacts ac_l
    WHERE ac_l.contact_id = ANY(p_loser_ids)
      AND EXISTS (SELECT 1 FROM ace_agent_contacts ac_s
                   WHERE ac_s.contact_id = p_surviving_id AND ac_s.user_id = ac_l.user_id);
  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_agent_contacts','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_agent_contacts WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_agent_contacts SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_migration_log','column','ace_contact_id','row_id', id, 'old_id', ace_contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_migration_log WHERE ace_contact_id = ANY(p_loser_ids));
  UPDATE ace_migration_log SET ace_contact_id = p_surviving_id WHERE ace_contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  -- v368.2: collapse duplicate (ace_id, fub_contact_id) pairs across the
  -- entire merge group BEFORE re-pointing. DISTINCT ON keeps one row per
  -- fub_contact_id, preferring the survivor's row when present (so the
  -- survivor's confidence/metadata sticks), else the oldest loser link.
  -- Every other duplicate is hard-deleted (orphan link, no audit value
  -- since the survivor already retains the canonical link).
  DELETE FROM ace_contact_fub_links fl
    WHERE (fl.ace_id = p_surviving_id OR fl.ace_id = ANY(p_loser_ids))
      AND fl.id NOT IN (
        SELECT DISTINCT ON (fub_contact_id) id
          FROM ace_contact_fub_links
         WHERE ace_id = p_surviving_id OR ace_id = ANY(p_loser_ids)
         ORDER BY fub_contact_id,
                  (ace_id = p_surviving_id) DESC,
                  linked_at ASC NULLS LAST,
                  id
      );

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_contact_fub_links','column','ace_id','row_id', id, 'old_id', ace_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_contact_fub_links WHERE ace_id = ANY(p_loser_ids));
  UPDATE ace_contact_fub_links SET ace_id = p_surviving_id WHERE ace_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_emails','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_emails WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_emails SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  v_fk_repointed := v_fk_repointed || (SELECT COALESCE(jsonb_agg(jsonb_build_object('table','ace_contact_notes','column','contact_id','row_id', id, 'old_id', contact_id, 'new_id', p_surviving_id)), '[]'::jsonb) FROM ace_contact_notes WHERE contact_id = ANY(p_loser_ids));
  UPDATE ace_contact_notes SET contact_id = p_surviving_id WHERE contact_id = ANY(p_loser_ids);
  GET DIAGNOSTICS v_temp_count = ROW_COUNT; v_repointed_count := v_repointed_count + v_temp_count;

  UPDATE ace_contacts SET deleted_at = now() WHERE id = ANY(p_loser_ids);
  UPDATE ace_contact_dedupe_candidates SET status = 'merged', status_set_at = now(), status_set_by = p_user_id
    WHERE status = 'pending' AND contact_ids <@ (p_loser_ids || p_surviving_id);

  INSERT INTO ace_contact_merge_log (surviving_id, loser_ids, losers_snapshot, surviving_before, surviving_after, fk_repointed, merged_by)
  VALUES (p_surviving_id, p_loser_ids, v_losers_snapshot, v_surviving_before, v_surviving_after, v_fk_repointed, p_user_id)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'success', true,
    'merge_log_id', v_log_id,
    'fk_repointed_count', v_repointed_count,
    'losers_archived', array_length(p_loser_ids, 1)
  );
END;
$function$;

COMMENT ON FUNCTION public.merge_contacts(uuid, uuid[], jsonb, uuid) IS
  'v368.2: no-data-loss merge. Pre-collapses duplicate ace_contact_fub_links '
  'across the WHOLE merge group (survivor + every loser) using DISTINCT ON '
  '(fub_contact_id) so re-pointing never trips '
  'ace_contact_fub_links_pair_unique. Audit log keeps full loser snapshots.';
