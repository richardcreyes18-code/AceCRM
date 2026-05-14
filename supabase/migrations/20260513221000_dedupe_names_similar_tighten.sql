-- v370.1: tighten _dd_names_similar — require EVERY token in the shorter
-- name to match a token in the longer name, not just any one.
--
-- v370's rule (any one token in common) returned true for
-- "John Smith" vs "Jane Smith" because they share "Smith" — but those
-- are different people sharing a surname. The new rule walks every
-- token in the shorter token-list and demands at least one match in
-- the longer list (via exact, 3-char prefix, or nickname expansion).
-- Trigram fallback is dropped to avoid catching cases like
-- John/Jane (~0.47 similarity).
--
-- Recheck the previous examples:
--   Chris Smith    vs Christopher Smith → ✓ chris~christopher, smith=smith
--   Bob Jones      vs Robert Jones     → ✓ bob~robert (nickname), jones=jones
--   Mike Smith     vs Michael Smith    → ✓ mike~michael, smith=smith
--   John Smith     vs Jane Smith       → ✗ john has no match in [jane,smith]
--   John           vs John Smith       → ✓ john=john (shorter list is [john] only)
--   Joseph Taylor  vs Gary Matrix Dev  → ✗ neither joseph nor taylor match
--   Donita Maynard vs Donita L Maynard → ✓ both donita & maynard match (L stripped)

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
  short_list text[];
  long_list  text[];
  ta_expanded text[];
  tb_expanded text[];
  tok text;
  canon text;
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
    "vincent":    ["vince","vinny","vin"],
    "zachary":    ["zach","zack"]
  }'::jsonb;
BEGIN
  na := lower(trim(coalesce(a, '')));
  nb := lower(trim(coalesce(b, '')));
  IF na = '' OR nb = '' THEN RETURN false; END IF;

  -- Strip punctuation, collapse whitespace.
  na := regexp_replace(na, '[\.,'']', '', 'g');
  nb := regexp_replace(nb, '[\.,'']', '', 'g');
  na := regexp_replace(na, '\s+', ' ', 'g');
  nb := regexp_replace(nb, '\s+', ' ', 'g');

  IF na = nb THEN RETURN true; END IF;

  -- Tokenize, drop 1-char tokens (middle initials).
  ta := ARRAY(SELECT t FROM unnest(regexp_split_to_array(na, '\s+')) AS t WHERE length(t) >= 2);
  tb := ARRAY(SELECT t FROM unnest(regexp_split_to_array(nb, '\s+')) AS t WHERE length(t) >= 2);
  IF array_length(ta, 1) IS NULL OR array_length(tb, 1) IS NULL THEN
    RETURN false;
  END IF;

  -- Expand each list with nickname aliases so "bob" and "robert" share
  -- a token after expansion.
  ta_expanded := ta;
  tb_expanded := tb;
  FOREACH tok IN ARRAY ta LOOP
    IF nicknames ? tok THEN
      ta_expanded := ta_expanded || ARRAY(SELECT jsonb_array_elements_text(nicknames -> tok));
    ELSE
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

  -- Walk the SHORTER (original, un-expanded) token list. For every
  -- token in it, require at least one match in the LONGER expanded
  -- list via exact equality OR 3-char prefix in either direction.
  -- Using the original short-list (not expanded) so we don't credit a
  -- shorter list for matching a nickname its tokens don't actually
  -- contain — only the longer list gets expanded for the lookup.
  IF array_length(ta, 1) <= array_length(tb, 1) THEN
    short_list := ta;  long_list := tb_expanded;
  ELSE
    short_list := tb;  long_list := ta_expanded;
  END IF;

  FOREACH tok IN ARRAY short_list LOOP
    IF NOT EXISTS (
      SELECT 1 FROM unnest(long_list) AS y
      WHERE y = tok
         OR (length(tok) >= 3 AND y LIKE tok || '%')
         OR (length(y)   >= 3 AND tok LIKE y || '%')
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public._dd_names_similar(text, text) IS
  'v370.1: tighter token-AND match. Every token in the shorter name '
  'list must have a match (exact / 3-char prefix / nickname) in the '
  'longer list. Rejects "John Smith" vs "Jane Smith" (no john↔jane '
  'match) while accepting "Chris Smith" vs "Christopher Smith" and '
  '"Bob Jones" vs "Robert Jones".';
