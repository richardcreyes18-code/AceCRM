-- v339: extend the v338 merge_fub_activity RPC so every successful
-- "Move calls/notes to existing & ignore" click ALSO registers the
-- mapping in fub_known_duplicates. After this, future fub-calls-sync
-- / fub-notes-sync runs will auto-redirect new activity for the
-- duplicate person_id onto the canonical id via the BEFORE triggers
-- shipped in 20260512000000_fub_known_duplicates.sql.
--
-- Adds three things on top of the v338 body:
--
--   * Cycle guard — refuses to register a mapping where the proposed
--     canonical (p_old_fub_id) is itself already marked as someone
--     else's duplicate. Prevents the table from drifting into a
--     contradictory state.
--
--   * UPSERT into fub_known_duplicates — records the (duplicate →
--     canonical) edge for future auto-redirect.
--
--   * Chain collapse — if rows already pointed at p_new_fub_id as
--     their canonical (i.e. an older A→B mapping where B is now
--     being marked as a duplicate of C), repoint them to p_old_fub_id
--     so the trigger lookup stays O(1) instead of walking the chain.
--
-- The function signature, return shape, and grant are unchanged from
-- v338. Clients keep calling it the same way.

CREATE OR REPLACE FUNCTION merge_fub_activity(
  p_old_fub_id integer,
  p_new_fub_id integer
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_calls_moved int := 0;
  v_notes_moved int := 0;
  v_caller_email text;
BEGIN
  IF p_old_fub_id IS NULL OR p_new_fub_id IS NULL THEN
    RAISE EXCEPTION 'Both p_old_fub_id and p_new_fub_id are required';
  END IF;
  IF p_old_fub_id = p_new_fub_id THEN
    RAISE EXCEPTION 'old and new FUB ids must differ';
  END IF;

  -- Cycle guard: refuse if the proposed canonical is itself a
  -- duplicate. Forces the user to untangle the existing chain
  -- before reusing the canonical id.
  IF EXISTS (
    SELECT 1 FROM fub_known_duplicates WHERE duplicate_fub_id = p_old_fub_id
  ) THEN
    RAISE EXCEPTION
      'FUB #% is itself marked as a duplicate. Resolve that mapping before using it as the canonical id.',
      p_old_fub_id;
  END IF;

  -- Re-key historical activity (v338 behavior).
  UPDATE fub_calls
     SET person_id = p_old_fub_id
   WHERE person_id = p_new_fub_id;
  GET DIAGNOSTICS v_calls_moved = ROW_COUNT;

  UPDATE fub_notes
     SET person_id = p_old_fub_id
   WHERE person_id = p_new_fub_id;
  GET DIAGNOSTICS v_notes_moved = ROW_COUNT;

  -- Register the mapping for future auto-redirect. ON CONFLICT
  -- handles re-clicks idempotently. Pulling the caller email is
  -- best-effort — auth.jwt() can throw if the JWT context isn't
  -- set up, so we wrap it.
  BEGIN
    v_caller_email := coalesce(auth.jwt() ->> 'email', 'unknown');
  EXCEPTION WHEN OTHERS THEN
    v_caller_email := 'unknown';
  END;

  INSERT INTO fub_known_duplicates (duplicate_fub_id, canonical_fub_id, resolved_by, reason)
  VALUES (
    p_new_fub_id,
    p_old_fub_id,
    v_caller_email,
    'Merged via reconcile-queue "Move calls/notes to existing & ignore" button'
  )
  ON CONFLICT (duplicate_fub_id) DO UPDATE
     SET canonical_fub_id = EXCLUDED.canonical_fub_id,
         resolved_at      = now(),
         resolved_by      = EXCLUDED.resolved_by,
         reason           = EXCLUDED.reason;

  -- Chain collapse: anything that was pointing at p_new_fub_id as
  -- its canonical now points at p_old_fub_id instead. Keeps the
  -- table flat and the BEFORE triggers fast.
  UPDATE fub_known_duplicates
     SET canonical_fub_id = p_old_fub_id
   WHERE canonical_fub_id = p_new_fub_id;

  RETURN json_build_object(
    'calls_moved', v_calls_moved,
    'notes_moved', v_notes_moved,
    'old_fub_id',  p_old_fub_id,
    'new_fub_id',  p_new_fub_id
  );
END;
$$;

COMMENT ON FUNCTION merge_fub_activity IS
  'v339: re-key fub_calls + fub_notes from a duplicate FUB person_id '
  'onto the canonical one AND register the mapping in '
  'fub_known_duplicates so future sync activity auto-redirects. '
  'Refuses to create cycles. Collapses transitive chains on the fly.';

-- Re-grant in case the function signature changed (it didn't, but
-- belt-and-suspenders for the CREATE OR REPLACE path).
GRANT EXECUTE ON FUNCTION merge_fub_activity(integer, integer) TO authenticated;
