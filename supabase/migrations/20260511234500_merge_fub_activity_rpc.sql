-- v338: re-key fub_calls + fub_notes from a duplicate FUB person_id
-- onto the canonical one, so the FUB review queue's "Move history"
-- button can attach orphan calls/notes from a duplicate FUB record
-- onto the ace_contact that's already linked to a different FUB id.
--
-- USAGE (from the client):
--   const r = await _sbRpc('merge_fub_activity', {
--     p_old_fub_id: 90071,    -- survivor (already linked to an ace_contact)
--     p_new_fub_id: 101839,   -- duplicate (its calls/notes get moved)
--   });
--   // r = { calls_moved: 2, notes_moved: 0 }
--
-- Idempotent — running twice just moves 0 more rows the second time.
-- After this, the caller should still invoke resolve_queue_merge
-- with p_chosen_ace=null to mark the reconcile-queue row resolved.
--
-- Known limitation: if FUB itself still has #101839 as a separate
-- person, the next fub-calls-sync run will add NEW calls under
-- person_id=101839 and the queue will surface another merge
-- candidate. A `fub_known_duplicates` table consulted by the sync
-- functions would close that loop, but that's a separate change.

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
BEGIN
  IF p_old_fub_id IS NULL OR p_new_fub_id IS NULL THEN
    RAISE EXCEPTION 'Both p_old_fub_id and p_new_fub_id are required';
  END IF;
  IF p_old_fub_id = p_new_fub_id THEN
    RAISE EXCEPTION 'old and new FUB ids must differ';
  END IF;

  UPDATE fub_calls
     SET person_id = p_old_fub_id
   WHERE person_id = p_new_fub_id;
  GET DIAGNOSTICS v_calls_moved = ROW_COUNT;

  UPDATE fub_notes
     SET person_id = p_old_fub_id
   WHERE person_id = p_new_fub_id;
  GET DIAGNOSTICS v_notes_moved = ROW_COUNT;

  RETURN json_build_object(
    'calls_moved', v_calls_moved,
    'notes_moved', v_notes_moved,
    'old_fub_id',  p_old_fub_id,
    'new_fub_id',  p_new_fub_id
  );
END;
$$;

COMMENT ON FUNCTION merge_fub_activity IS
  'v338: re-key fub_calls + fub_notes from a duplicate FUB person_id '
  'onto the canonical one, so orphan history attaches to the ace_contact '
  'already linked to the canonical FUB record.';

-- Grant execute to authenticated users (matches the existing
-- resolve_queue_* RPC pattern — the function runs as security definer
-- so the actual UPDATE permission isn't required on the caller).
GRANT EXECUTE ON FUNCTION merge_fub_activity(integer, integer) TO authenticated;
