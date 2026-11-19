-- Portal feature: buyer-facing shareable deal links.

ALTER TABLE ace_properties
  ADD COLUMN IF NOT EXISTS portal_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS authorization_source text,
  ADD COLUMN IF NOT EXISTS authorization_notes text,
  ADD COLUMN IF NOT EXISTS commission_structure text,
  ADD COLUMN IF NOT EXISTS commission_rate_pct numeric,
  ADD COLUMN IF NOT EXISTS commission_notes text;

ALTER TABLE ace_properties DROP CONSTRAINT IF EXISTS ace_properties_authorization_source_chk;
ALTER TABLE ace_properties ADD CONSTRAINT ace_properties_authorization_source_chk
  CHECK (authorization_source IS NULL OR authorization_source IN
    ('verbal','email_confirm','signed_listing','signed_oneoff','none'));

ALTER TABLE ace_properties DROP CONSTRAINT IF EXISTS ace_properties_commission_structure_chk;
ALTER TABLE ace_properties ADD CONSTRAINT ace_properties_commission_structure_chk
  CHECK (commission_structure IS NULL OR commission_structure IN
    ('seller_pays','buyer_pays_finder','split','all_in'));

CREATE TABLE IF NOT EXISTS ace_deal_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES ace_properties(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  is_published boolean NOT NULL DEFAULT false,
  nda_required boolean NOT NULL DEFAULT true,
  hide_address boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by_user_id uuid REFERENCES ace_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 0,
  unique_viewer_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ace_deal_shares_token_idx ON ace_deal_shares(token);
CREATE INDEX IF NOT EXISTS ace_deal_shares_deal_id_idx ON ace_deal_shares(deal_id);

CREATE TABLE IF NOT EXISTS ace_deal_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES ace_deal_shares(id) ON DELETE CASCADE,
  viewer_email text,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text,
  duration_seconds integer,
  scroll_depth_pct integer,
  made_offer boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ace_deal_views_share_idx
  ON ace_deal_views(share_id, viewed_at DESC);

CREATE OR REPLACE FUNCTION _ace_deal_views_recount() RETURNS trigger AS $$
DECLARE
  target_share uuid;
BEGIN
  target_share := COALESCE(NEW.share_id, OLD.share_id);
  UPDATE ace_deal_shares s
     SET view_count = (SELECT COUNT(*) FROM ace_deal_views v WHERE v.share_id = target_share),
         unique_viewer_count = (
           SELECT COUNT(DISTINCT lower(trim(v.viewer_email)))
             FROM ace_deal_views v
            WHERE v.share_id = target_share
              AND v.viewer_email IS NOT NULL
              AND trim(v.viewer_email) <> ''
         ),
         updated_at = now()
   WHERE s.id = target_share;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ace_deal_views_recount_ins ON ace_deal_views;
CREATE TRIGGER ace_deal_views_recount_ins
  AFTER INSERT OR DELETE OR UPDATE OF viewer_email, made_offer ON ace_deal_views
  FOR EACH ROW EXECUTE FUNCTION _ace_deal_views_recount();

CREATE OR REPLACE FUNCTION _ace_deal_shares_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ace_deal_shares_touch_upd ON ace_deal_shares;
CREATE TRIGGER ace_deal_shares_touch_upd
  BEFORE UPDATE ON ace_deal_shares
  FOR EACH ROW EXECUTE FUNCTION _ace_deal_shares_touch();

ALTER TABLE ace_deal_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE ace_deal_views  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ace_deal_shares_auth_all ON ace_deal_shares;
CREATE POLICY ace_deal_shares_auth_all ON ace_deal_shares
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ace_deal_views_auth_select ON ace_deal_views;
CREATE POLICY ace_deal_views_auth_select ON ace_deal_views
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ace_deal_views_auth_write ON ace_deal_views;
CREATE POLICY ace_deal_views_auth_write ON ace_deal_views
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ace_deal_shares TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ace_deal_views  TO authenticated;
