-- Matcher fix found in the first end-to-end run: trigram similarity penalises
-- long catalogue names ("GFCI receptacle, 15 A", "EV charger install — 48 A
-- Level 2 (…)"), so a model's short description never reached the match
-- threshold. Also score against the item's core name — the part before the
-- first comma, dash or bracket.
CREATE OR REPLACE FUNCTION price_book_core_name(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT btrim(split_part(regexp_replace(p_name, '\s+[—–-]\s+|\s*[,(]', '|', 'g'), '|', 1)) $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION price_book_core_name(text) TO app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_book_similarity(p_name text, p_aliases text[], p_query text) RETURNS real
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT greatest(
      similarity(lower(p_name), lower(p_query)),
      similarity(lower(price_book_core_name(p_name)), lower(p_query)),
      coalesce((SELECT max(similarity(lower(a), lower(p_query))) FROM unnest(p_aliases) a), 0)
    )
  $$;
