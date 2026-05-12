-- v355: add portfolio_id to ace_tasks so the Portfolio detail page can
-- own its own tasks (not just aggregate child-property tasks).
-- Reuses the existing soft-link pattern from property_id / contact_id —
-- nullable, no cascade, owned at the application layer.

ALTER TABLE ace_tasks
  ADD COLUMN IF NOT EXISTS portfolio_id uuid REFERENCES ace_portfolios(id);

CREATE INDEX IF NOT EXISTS idx_ace_tasks_portfolio_id
  ON ace_tasks(portfolio_id)
  WHERE portfolio_id IS NOT NULL;

COMMENT ON COLUMN ace_tasks.portfolio_id IS
  'v355: optional pointer to ace_portfolios. When set, the task is scoped '
  'to the whole portfolio rather than a single child property. The portfolio '
  'detail Tasks tab shows tasks WHERE portfolio_id = X UNION property_id IN '
  '(child_ids).';
