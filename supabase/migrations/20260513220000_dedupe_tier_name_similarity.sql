-- v370: name-aware dedupe tier classification.
--
-- Before this, `run_dedupe_detection()` tagged every phone-match and
-- every email-match group as `'high'` confidence, regardless of whether
-- the names in the group actually look alike. That gave the Contact
-- Dedupe queue ~405 "high" rows containing pairs like
-- "Joseph Taylor" + "Gary Matrix Development Group" — same phone, no
-- relation. The "✨ Auto-merge N high-confidence" button became unsafe
-- because clicking it would merge unrelated contacts.
--
-- New behavior:
--   * Phone-match group AND every pair of names passes
--     `_dd_names_similar` → tier 'high', match_signal 'phone'.
--   * Phone-match group with at least one dissimilar name pair →
--     tier 'medium', match_signal 'phone_names_differ' so the queue
--     subtitle clearly flags it.
--   * Email-match groups: same logic ('email' vs 'email_names_differ').
--   * Name-only groups: unchanged → 'medium', signal 'name'.
--
-- After this migration, the user clicks "Scan now" once (or waits for
-- the 3:17 AM cron) and the queue re-tiers itself.

-- ────────────────────────────────────────────────────────────────────
-- 1. _dd_names_similar(a, b) — token+prefix+nickname+trigram matcher.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._dd_names_similar(a text, b text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  na text;
  nb text;
  ta text[];
  tb text[];
  -- Nickname dictionary. Lookup is bidirectional: any value in this
  -- map is treated as an alias for the canonical (key) name. Both
  -- directions are expanded into token sets so the comparison is
  -- symmetric.
  nicknames jsonb := '{
    "robert":     ["bob","rob","robbie","bobby"],
    "richard":    ["rick","dick","rich","richie"],
    "michael":    ["mike","mick","mickey"],
    "william":    ["bill","billy","will","willy"],
    "james":      ["jim","jimmy","jamie"],
    "thomas":     ["tom","tommy"],
    "daniel":     ["dan","danny"],
    "david":      ["dave","davy"],
    "joseph":     ["joe","joey","jojo"],
    "edward":     ["ed","eddie","ted","ned"],
    "edwin":      ["ed","eddie"],
    "ronald":     ["ron","ronnie"],
    "jeffrey":    ["jeff","jeffy"],
    "matthew":    ["matt","matty"],
    "nicholas":   ["nick","nicky"],
    "samuel":     ["sam","sammy"],
    "benjamin":   ["ben","benny"],
    "alexander":  ["alex","al"],
    "anthony":    ["tony","ant"],
    "charles":    ["charlie","chuck","chas"],
    "donald":     ["don","donny"],
    "douglas":    ["doug","dougy"],
    "gerald":     ["jerry","gerry"],
    "kenneth":    ["ken","kenny"],
    "lawrence":   ["larry","lar"],
    "patrick":    ["pat","paddy"],
    "peter":      ["pete","petey"],
    "raymond":    ["ray"],
    "stephen":    ["steve","stevie"],
    "steven":     ["steve","stevie"],
    "theodore":   ["ted","theo","teddy"],
    "timothy":    ["tim","timmy"],
    "christopher":["chris","christy"],
    "elizabeth":  ["liz","beth","betty","lizzy","betsy","eliza"],
    "katherine":  ["kate","kathy","katie","kat"],
    "catherine":  ["kate","cathy","katie","cat"],
    "susan":      ["sue","susie"],
    "margaret":   ["peggy","maggie","meg","margy"],
    "jennifer":   ["jen","jenny","jenn"],
    "kimberly":   ["kim","kimmy"],
    "deborah":    ["deb","debbie","debby"],
    "christina":  ["chris","tina","christy"],
    "christine":  ["chris","tina","christy"],
    "patricia":   ["pat","patty","trish","tricia"],
    "rebecca":    ["becky","becca"],
    "barbara":    ["barb","babs"],
    "andrew":     ["andy","drew"],
    "francis":    ["frank","franky"],
    "frederick":  ["fred","freddy","rick"],
    "harold":     ["hal","harry"],
    "henry":      ["hank","harry"],
    "joshua":     ["josh"],
    "joanne":     ["jo","jojo"],
    "lawrence":   ["larry"],
    "vincent":    ["vince","vinny","vin"],
    "zachary":    ["zach","zack"]
  }'::jsonb;
BEGIN
  na := lower(trim(coalesce(a, '')));
  nb := lower(trim(coalesce(b, '')));
  IF na = '' OR nb = '' THEN RETURN false; END IF;

  -- Strip common punctuation that doesn't affect identity. Periods
  -- around middle initials, commas, apostrophes, dashes.
  na := regexp_replace(na, '[\.,'']', '', 'g');
  nb := regexp_replace(nb, '[\.,'']', '', 'g');
  -- Collapse internal whitespace
  na := regexp_replace(na, '\s+', ' ', 'g');
  nb := regexp_replace(nb, '\s+', ' ', 'g');

  -- Exact (normalized) match — short-circuit.
  IF na = nb THEN RETURN true; END IF;

  -- Tokenize. Skip 1-char tokens (middle initials) so "Chris L Smith"
  -- and "Chris Smith" share { chris, smith } in both lists.
  ta := ARRAY(SELECT t FROM unnest(regexp_split_to_array(na, '\s+')) AS t WHERE length(t) >= 2);
  tb := ARRAY(SELECT t FROM unnest(regexp_split_to_array(nb, '\s+')) AS t WHERE length(t) >= 2);

  IF array_length(ta, 1) IS NULL OR array_length(tb, 1) IS NULL THEN
    -- Fall back to trigram on the originals if tokenization stripped
    -- everything (e.g. names made entirely of single chars).
    RETURN similarity(na, nb) >= 0.55;
  END IF;

  -- Expand each token list with its nickname aliases. For a token X:
  --   - if X is a canonical name (key in the dict) → add every alias
  --   - if X is an alias of some canonical name Y → add Y + the other aliases
  -- The expansion is done in-place; we then compare the two expanded sets.
  DECLARE
    ta_expanded text[] := ta;
    tb_expanded text[] := tb;
    tok text;
    canon text;
    aliases text[];
  BEGIN
    FOREACH tok IN ARRAY ta LOOP
      IF nicknames ? tok THEN
        ta_expanded := ta_expanded || ARRAY(SELECT jsonb_array_elements_text(nicknames -> tok));
      ELSE
        -- Tok might be an alias. Look up its canonical form.
        SELECT key INTO canon FROM jsonb_each(nicknames) AS e(key, val)
          WHERE val ? tok LIMIT 1;
        IF canon IS NOT NULL THEN
          ta_expanded := ta_expanded || ARRAY[canon] || ARRAY(SELECT jsonb_array_elements_text(nicknames -> canon));
        END IF;
      END IF;
    END LOOP;
    FOREACH tok IN ARRAY tb LOOP
      IF nicknames ? tok THEN
        tb_expanded := tb_expanded || ARRAY(SELECT jsonb_array_elements_text(nicknames -> tok));
      ELSE
        SELECT key INTO canon FROM jsonb_each(nicknames) AS e(key, val)
          WHERE val ? tok LIMIT 1;
        IF canon IS NOT NULL THEN
          tb_expanded := tb_expanded || ARRAY[canon] || ARRAY(SELECT jsonb_array_elements_text(nicknames -> canon));
        END IF;
      END IF;
    END LOOP;
    ta := ta_expanded;
    tb := tb_expanded;
  END;

  -- Token-overlap test with prefix matching (Chris → Christopher).
  -- A token "x" from list A matches a token "y" from list B if:
  --   - x = y (exact)
  --   - length(x) >= 3 AND y starts with x (Chris prefix-of Christopher)
  --   - length(y) >= 3 AND x starts with y (the reverse)
  --
  -- Require >= 1 matching token. For names this is usually a shared
  -- surname; the dictionary covers nickname pairs that don't share
  -- any literal characters (Bob ↔ Robert).
  IF EXISTS (
    SELECT 1 FROM unnest(ta) AS x, unnest(tb) AS y
    WHERE x = y
       OR (length(x) >= 3 AND y LIKE x || '%')
       OR (length(y) >= 3 AND x LIKE y || '%')
  ) THEN
    RETURN true;
  END IF;

  -- Final fallback: trigram similarity on the full normalized strings.
  -- 0.55 is conservative (default Postgres threshold is 0.3); we want
  -- to be sure before claiming similarity. Catches typos like
  -- "Bryon Stoner" ↔ "Byron Stoner".
  RETURN similarity(na, nb) >= 0.55;
END;
$$;

COMMENT ON FUNCTION public._dd_names_similar(text, text) IS
  'v370: returns true when two contact names plausibly refer to the same '
  'person. Token-overlap + 3-char prefix matching + a nickname dictionary '
  '(bob↔robert, mike↔michael, …) + trigram fallback ≥0.55. Used by '
  'run_dedupe_detection to assign tier=high only to name-similar pairs.';

-- ────────────────────────────────────────────────────────────────────
-- 2. run_dedupe_detection() — rewrite with name-aware tier assignment.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.run_dedupe_detection()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_phone_high     int := 0;
  v_phone_medium   int := 0;
  v_email_high     int := 0;
  v_email_medium   int := 0;
  v_name_count     int := 0;
  v_kept_count     int := 0;
  v_total          int;
BEGIN
  -- Clear stale pending candidates. Keep skipped/not_duplicates/merged
  -- so prior user decisions stick.
  DELETE FROM ace_contact_dedupe_candidates WHERE status = 'pending';

  -- ─── Tier 1: Phone-match groups, split by name similarity ──────────
  --
  -- Build the candidate groups in a single CTE, then check every pair
  -- of names in each group via _dd_names_similar. A group is "high"
  -- iff every distinct pair passes; otherwise it's "medium".
  WITH normalized AS (
    SELECT
      id,
      name,
      REGEXP_REPLACE(COALESCE(phone_number,''), '[^0-9]', '', 'g') AS phone_digits
    FROM ace_contacts
    WHERE deleted_at IS NULL
  ),
  groups AS (
    SELECT
      phone_digits,
      ARRAY_AGG(id    ORDER BY id) AS contact_ids,
      ARRAY_AGG(name  ORDER BY id) AS names,
      COUNT(*) AS n
    FROM normalized
    WHERE LENGTH(phone_digits) >= 10
    GROUP BY phone_digits
    HAVING COUNT(*) > 1
  ),
  classified AS (
    SELECT
      contact_ids,
      phone_digits,
      -- Pairwise similarity check. NOT EXISTS dissimilar pair → high.
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
      CASE WHEN all_similar THEN 'phone' ELSE 'phone_names_differ' END,
      phone_digits
    FROM classified
    RETURNING (CASE WHEN tier='high' THEN 1 ELSE 0 END) AS h
  )
  SELECT
    COALESCE(SUM(h), 0)::int,
    COALESCE(COUNT(*) - SUM(h), 0)::int
  INTO v_phone_high, v_phone_medium
  FROM ins;

  -- ─── Tier 2: Email-match groups, same name-aware split ─────────────
  WITH already_grouped AS (
    SELECT UNNEST(contact_ids) AS contact_id
    FROM ace_contact_dedupe_candidates
    WHERE status = 'pending'
      AND match_signal IN ('phone','phone_names_differ')
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

  -- ─── Tier 3: Name-only match (medium) — unchanged ─────────────────
  WITH already_grouped AS (
    SELECT UNNEST(contact_ids) AS contact_id
    FROM ace_contact_dedupe_candidates
    WHERE status = 'pending'
      AND match_signal IN ('phone','phone_names_differ','email','email_names_differ')
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
  WHERE status != 'pending';

  v_total := v_phone_high + v_phone_medium + v_email_high + v_email_medium + v_name_count;

  RETURN jsonb_build_object(
    'success',           true,
    'pending_groups',    v_total,
    'high_phone',        v_phone_high,
    'medium_phone',      v_phone_medium,
    'high_email',        v_email_high,
    'medium_email',      v_email_medium,
    'medium_name',       v_name_count,
    'kept_decisions',    v_kept_count,
    'scanned_at',        now()
  );
END;
$function$;

COMMENT ON FUNCTION public.run_dedupe_detection() IS
  'v370: name-aware dedupe tier classification. Phone- and email-match '
  'groups are tiered as ''high'' only when every pair of names in the '
  'group passes _dd_names_similar; otherwise they''re demoted to '
  '''medium'' with match_signal ''phone_names_differ'' or '
  '''email_names_differ'' so the UI can surface the demotion reason.';
