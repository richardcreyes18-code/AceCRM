-- v378: cold-calling pipeline feature.
-- Four new tables, generic names (no ace_* prefix): lead_lists, leads,
-- call_logs, scripts. Supports CSV-imported lead lists, per-lead call
-- history, and a shared script library.

-- ─── lead_lists ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_lists (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  source              text,           -- 'propstream' | 'manual' | 'csv' | 'other'
  source_notes        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES ace_users(id),
  total_count         int NOT NULL DEFAULT 0,
  active_count        int NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  notes               text,
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_lead_lists_status
  ON lead_lists(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_lists_created_by
  ON lead_lists(created_by_user_id) WHERE deleted_at IS NULL;

-- ─── leads ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id                 uuid NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  name                    text,
  phone                   text,
  phone_secondary         text,
  email                   text,
  mailing_address         text,
  mailing_city            text,
  mailing_state           text,
  mailing_zip             text,
  property_address        text,
  property_city           text,
  property_state          text,
  property_zip            text,
  property_type           text,
  bedrooms                int,
  bathrooms               numeric,
  sqft                    int,
  lot_size                numeric,
  year_built              int,
  owner_occupied          boolean,
  last_sale_date          date,
  last_sale_price         numeric,
  estimated_value         numeric,
  equity_pct              numeric,
  loan_balance            numeric,
  status                  text NOT NULL DEFAULT 'new',
    -- 'new'|'attempted'|'no_answer'|'voicemail'|'callback'|
    -- 'interested'|'not_interested'|'dnc'|'converted'
  assigned_to_user_id     uuid REFERENCES ace_users(id),
  last_call_at            timestamptz,
  next_followup_at        timestamptz,
  total_attempts          int NOT NULL DEFAULT 0,
  converted_to_contact_id uuid REFERENCES ace_contacts(id),
  notes                   text,
  raw_import_data         jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);

CREATE INDEX IF NOT EXISTS idx_leads_list_id
  ON leads(list_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_status
  ON leads(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to
  ON leads(assigned_to_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_next_followup
  ON leads(next_followup_at) WHERE deleted_at IS NULL AND next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_phone
  ON leads(phone) WHERE deleted_at IS NULL;

-- ─── scripts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scripts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  category            text,            -- 'opening'|'rebuttal'|'voicemail'|'follow_up'|'closing'|'other'
  body                text,
  tags                text[],
  is_active           boolean NOT NULL DEFAULT true,
  created_by_user_id  uuid REFERENCES ace_users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scripts_unique_active_name
  ON scripts(name) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_scripts_category
  ON scripts(category) WHERE is_active = true;

-- ─── call_logs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES ace_users(id),
  call_at             timestamptz NOT NULL DEFAULT now(),
  outcome             text,
    -- 'answered'|'no_answer'|'voicemail'|'busy'|'wrong_number'|
    -- 'dnc'|'callback_scheduled'|'interested'|'not_interested'
  duration_seconds    int,
  notes               text,
  script_id           uuid REFERENCES scripts(id) ON DELETE SET NULL,
  batchdialer_call_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_lead_id_call_at
  ON call_logs(lead_id, call_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_user_id
  ON call_logs(user_id);

-- ─── updated_at triggers ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _lists_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_lists_touch ON lead_lists;
CREATE TRIGGER trg_lead_lists_touch
  BEFORE UPDATE ON lead_lists
  FOR EACH ROW EXECUTE FUNCTION _lists_touch_updated_at();

DROP TRIGGER IF EXISTS trg_leads_touch ON leads;
CREATE TRIGGER trg_leads_touch
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION _lists_touch_updated_at();

DROP TRIGGER IF EXISTS trg_scripts_touch ON scripts;
CREATE TRIGGER trg_scripts_touch
  BEFORE UPDATE ON scripts
  FOR EACH ROW EXECUTE FUNCTION _lists_touch_updated_at();

-- ─── roll-up counts on lead_lists ──────────────────────────────────────
-- active = status NOT IN ('converted','dnc','not_interested') AND deleted_at IS NULL
CREATE OR REPLACE FUNCTION _lists_recount(p_list_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE lead_lists
     SET total_count  = (SELECT count(*) FROM leads
                          WHERE list_id = p_list_id AND deleted_at IS NULL),
         active_count = (SELECT count(*) FROM leads
                          WHERE list_id = p_list_id
                            AND deleted_at IS NULL
                            AND status NOT IN ('converted','dnc','not_interested'))
   WHERE id = p_list_id;
$$;

CREATE OR REPLACE FUNCTION _leads_after_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM _lists_recount(OLD.list_id);
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM _lists_recount(NEW.list_id);
    RETURN NEW;
  ELSE -- UPDATE: recount if status/list/soft-delete changed
    IF NEW.list_id    <> OLD.list_id
       OR NEW.status  <> OLD.status
       OR (NEW.deleted_at IS NULL) <> (OLD.deleted_at IS NULL) THEN
      PERFORM _lists_recount(NEW.list_id);
      IF NEW.list_id <> OLD.list_id THEN
        PERFORM _lists_recount(OLD.list_id);
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_recount ON leads;
CREATE TRIGGER trg_leads_recount
  AFTER INSERT OR UPDATE OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION _leads_after_change();

-- ─── total_attempts + last_call_at auto-update from call_logs ──────────
CREATE OR REPLACE FUNCTION _call_logs_after_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE leads
     SET total_attempts = total_attempts + 1,
         last_call_at   = GREATEST(COALESCE(last_call_at, NEW.call_at), NEW.call_at)
   WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_logs_bump ON call_logs;
CREATE TRIGGER trg_call_logs_bump
  AFTER INSERT ON call_logs
  FOR EACH ROW EXECUTE FUNCTION _call_logs_after_insert();

-- ─── RLS: match the existing ace_* pattern (RLS off, single-user org) ──
ALTER TABLE lead_lists DISABLE ROW LEVEL SECURITY;
ALTER TABLE leads       DISABLE ROW LEVEL SECURITY;
ALTER TABLE scripts     DISABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs   DISABLE ROW LEVEL SECURITY;
