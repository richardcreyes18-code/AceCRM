-- v339: permanent FUB-side duplicate mapping.
--
-- After v338, clicking "Move calls/notes to existing & ignore" on a
-- FUB-side-duplicate queue row re-keys the existing fub_calls /
-- fub_notes from the duplicate FUB person_id onto the canonical one.
-- That's a one-shot. FUB itself still has the duplicate person, so
-- every future fub-calls-sync (15 min) / fub-notes-sync (hourly)
-- run that inserts NEW activity under the duplicate id makes the
-- reconcile queue re-surface the same case.
--
-- This migration makes the merge permanent at the database layer —
-- no edge function changes required:
--
--   1. A new fub_known_duplicates table maps each known-duplicate
--      FUB id to its canonical FUB id.
--
--   2. BEFORE INSERT/UPDATE triggers on fub_calls + fub_notes consult
--      the table and rewrite NEW.person_id transparently. Chain-aware
--      (A → B → C resolves to C) with a 10-hop runaway cap.
--
--   3. A BEFORE INSERT trigger on ace_fub_reconcile_queue auto-flips
--      status='resolved' for any pending row whose fub_source_id is
--      already known as a duplicate, so the queue UI never re-surfaces
--      a previously-decided pair.
--
-- The v338 merge_fub_activity RPC is extended in a companion change
-- to UPSERT into fub_known_duplicates on every "Move calls/notes"
-- click — so the table populates organically as users work the queue.

-- ─────────────────────────────────────────────────────────────────
-- 1. Mapping table.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fub_known_duplicates (
  duplicate_fub_id INTEGER     PRIMARY KEY,
  canonical_fub_id INTEGER     NOT NULL,
  resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      TEXT,
  queue_id         UUID,
  reason           TEXT,
  CHECK (duplicate_fub_id <> canonical_fub_id)
);

CREATE INDEX IF NOT EXISTS fub_known_duplicates_canonical_idx
  ON fub_known_duplicates (canonical_fub_id);

COMMENT ON TABLE fub_known_duplicates IS
  'v339: maps duplicate FUB person_ids (the doomed side) to the '
  'canonical FUB person_id that ace_contacts is linked to. Consulted '
  'by BEFORE triggers on fub_calls + fub_notes so future sync '
  'activity for a duplicate id auto-flows onto the canonical record.';

-- ─────────────────────────────────────────────────────────────────
-- 2. Activity-redirect trigger function + triggers.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fub_redirect_duplicate_person_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current INT;
  v_next    INT;
  v_hops    INT := 0;
BEGIN
  IF NEW.person_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_current := NEW.person_id;
  -- Walk the duplicate chain. Capped at 10 hops as a runaway safety
  -- in case a misconfiguration ever introduces a cycle (the
  -- merge_fub_activity RPC's cycle guard should prevent this, but
  -- belt-and-suspenders).
  LOOP
    SELECT canonical_fub_id INTO v_next
      FROM fub_known_duplicates
     WHERE duplicate_fub_id = v_current;
    EXIT WHEN v_next IS NULL OR v_hops >= 10;
    v_current := v_next;
    v_hops := v_hops + 1;
  END LOOP;
  IF v_current <> NEW.person_id THEN
    NEW.person_id := v_current;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fub_redirect_duplicate_person_id IS
  'v339: BEFORE-row trigger that rewrites NEW.person_id to the '
  'canonical FUB id via fub_known_duplicates. Used on fub_calls + '
  'fub_notes so sync activity for known duplicates auto-flows onto '
  'the canonical record without edge function changes.';

DROP TRIGGER IF EXISTS trg_fub_calls_redirect ON fub_calls;
CREATE TRIGGER trg_fub_calls_redirect
  BEFORE INSERT OR UPDATE OF person_id ON fub_calls
  FOR EACH ROW
  EXECUTE FUNCTION fub_redirect_duplicate_person_id();

DROP TRIGGER IF EXISTS trg_fub_notes_redirect ON fub_notes;
CREATE TRIGGER trg_fub_notes_redirect
  BEFORE INSERT OR UPDATE OF person_id ON fub_notes
  FOR EACH ROW
  EXECUTE FUNCTION fub_redirect_duplicate_person_id();

-- ─────────────────────────────────────────────────────────────────
-- 3. Queue auto-resolve trigger function + trigger.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION recon_queue_skip_known_duplicate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only touch pending rows whose fub_source_id is already known to
  -- be a duplicate. Flip status='resolved' so the UI filter
  -- (status=eq.pending) skips them. Applies across all action types
  -- (merge, create, conflict) — if the queue logic ever flags a
  -- known duplicate under the wrong action, we still want it
  -- silenced.
  IF NEW.status = 'pending'
     AND NEW.fub_source_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM fub_known_duplicates
        WHERE duplicate_fub_id = NEW.fub_source_id
     )
  THEN
    NEW.status := 'resolved';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION recon_queue_skip_known_duplicate IS
  'v339: BEFORE-row trigger that auto-resolves pending reconcile '
  'queue rows whose fub_source_id is in fub_known_duplicates. '
  'Prevents the queue from re-surfacing a previously-decided pair.';

DROP TRIGGER IF EXISTS trg_recon_queue_skip_known_dup ON ace_fub_reconcile_queue;
CREATE TRIGGER trg_recon_queue_skip_known_dup
  BEFORE INSERT ON ace_fub_reconcile_queue
  FOR EACH ROW
  EXECUTE FUNCTION recon_queue_skip_known_duplicate();
