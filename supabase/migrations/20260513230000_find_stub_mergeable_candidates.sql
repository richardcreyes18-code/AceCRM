-- v371: helper RPC that returns medium-tier dedupe candidates safe to
-- auto-merge — groups where at most ONE contact carries real
-- attachments (properties, buyer_criteria, tasks, pitches, emails,
-- non-empty notes). The other contacts in those groups are empty
-- prospecting-list stubs, so merging them into the canonical contact
-- consolidates phones / fub_tags / addresses without losing data.
--
-- Live counts at deploy time: ~3,373 of 4,230 contacts in pending
-- medium-tier groups are empty stubs — roughly 80% of the volume.
-- This RPC lets the Contact Dedupe UI batch-clean them in one click.
--
-- An attachment-bearing contact is automatically preferred as the
-- survivor by the existing _ddAutoMergeOne logic (most deals wins),
-- so the only thing the client needs to do is iterate the candidate
-- ids this function returns.

DROP FUNCTION IF EXISTS public.find_stub_mergeable_candidates();

CREATE FUNCTION public.find_stub_mergeable_candidates()
RETURNS TABLE (
  candidate_id        uuid,
  cand_contact_ids    uuid[],
  cand_match_signal   text,
  contacts_total      int,
  contacts_with_data  int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH per_contact AS (
    SELECT
      d.id           AS cand_id,
      d.contact_ids  AS cand_contact_ids2,
      d.match_signal AS cand_signal,
      cid            AS contact_id_2,
      (
        (SELECT COUNT(*) FROM ace_properties p     WHERE p.owner_contact_id = cid AND p.deleted_at IS NULL) +
        (SELECT COUNT(*) FROM ace_buyer_criteria b WHERE b.contact_id = cid       AND b.deleted_at IS NULL) +
        (SELECT COUNT(*) FROM ace_tasks t          WHERE t.contact_id = cid) +
        (SELECT COUNT(*) FROM ace_buyer_pitches bp WHERE bp.contact_id = cid) +
        (SELECT COUNT(*) FROM ace_emails e         WHERE e.contact_id = cid) +
        CASE WHEN COALESCE(TRIM((SELECT contact_notes FROM ace_contacts WHERE id = cid)), '') = ''
             THEN 0 ELSE 1 END
      ) AS attach_score
    FROM ace_contact_dedupe_candidates d
    CROSS JOIN LATERAL UNNEST(d.contact_ids) AS cid
    WHERE d.status = 'pending' AND d.tier = 'medium'
  ),
  group_stats AS (
    SELECT
      cand_id,
      cand_contact_ids2,
      cand_signal,
      COUNT(*)::int                                 AS n_total,
      COUNT(*) FILTER (WHERE attach_score > 0)::int AS n_with_data
    FROM per_contact
    GROUP BY cand_id, cand_contact_ids2, cand_signal
  )
  SELECT
    cand_id           AS candidate_id,
    cand_contact_ids2 AS cand_contact_ids,
    cand_signal       AS cand_match_signal,
    n_total           AS contacts_total,
    n_with_data       AS contacts_with_data
  FROM group_stats
  WHERE n_with_data <= 1
  ORDER BY n_total ASC;
END;
$function$;

COMMENT ON FUNCTION public.find_stub_mergeable_candidates() IS
  'v371: lists medium-tier dedupe candidate groups where at most one '
  'contact carries real attachments. Safe-to-auto-merge — the existing '
  '_ddAutoMergeOne driver picks the data-bearing contact as survivor '
  'and absorbs the empty stubs (merge_contacts already unions phones, '
  'fub_tags, addresses, all_phones, all_emails so nothing is lost).';

GRANT EXECUTE ON FUNCTION public.find_stub_mergeable_candidates() TO authenticated;
