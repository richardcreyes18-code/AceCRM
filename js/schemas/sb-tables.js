// schemas/sb-tables.js — Supabase table-name lookups.
// Single source of truth for the table strings used by _sbGet / _sbPatch / etc.
// Currently duplicated in the legacy <script> in index.html (line ~966); the
// duplicate will be deleted once every consumer imports from this module.

export const SB_TABLES = {
  properties:    'ace_properties',
  contacts:      'ace_contacts',
  buyerCriteria: 'ace_buyer_criteria',
  tasks:         'ace_tasks',
  buyerInterests:'ace_buyer_interests',
  // v102.12: submissionBuyer / submissionSeller removed. The tables they
  // referenced (ace_submissions_buyer, ace_submissions_seller) were dropped
  // in the v102.12 migration after v102.9 rewired lead intake to write
  // directly to the real tables.
  documents:     'ace_documents',
  tenantMix:     'ace_properties',  // tenant mix lives in the property record
  // v102.28: portfolios feature — two new tables added in the add_portfolios
  // migration. Deals reference a portfolio via ace_properties.portfolio_id.
  portfolios:        'ace_portfolios',
  portfolioOffers:   'ace_portfolio_offers',
  // v102.31: buyer pitch log — tracks which properties have been sent
  // to which buyer contacts. Deals can be in-system (deal_id FK) or
  // off-system (offsystem_address + offsystem_agent_name text fields).
  buyerPitches:      'ace_buyer_pitches',
  // v113.31: full Gmail conversation storage (sent + received).
  // Rows are inserted by gmail-send (outbound) and gmail-sync (inbound +
  // any outbound that wasn't logged at send time). Uniqueness is enforced
  // per mailbox via (gmail_message_id, user_email).
  emails:            'ace_emails',
  // v102.34: editable app-wide lists (asset_types, preferred_cities).
  // Rows are keyed by list_key + value; is_active=false acts as a tombstone
  // so _appListAdd can "reactivate over insert" when a value is re-added
  // after a soft-delete.
  appLists:          'ace_app_lists',
  // v102.38: per-agent Workbench (private triage queue)
  workbench:         'ace_workbench_items',
  // v111.2: AI asset type classification suggestions (Haiku-powered)
  aiAssetSuggestions:'ace_ai_asset_suggestions',
  // v113.1: per-agent Personal Pipelines (parallel to company pipeline)
  agentPipelines:        'ace_agent_pipelines',
  agentPipelineStages:   'ace_agent_pipeline_stages',
  agentPipelineDeals:    'ace_agent_pipeline_deals',
  agentPipelinePortfolios:'ace_agent_pipeline_portfolios',
  agentPipelineViews:  'ace_agent_pipeline_views', // v113.3: saved filter presets
  // v113.9: user-entered comparable sales. Separate records, FK to the
  // subject deal in ace_properties. Unlike the "From Your Pipeline" comps
  // (filtered allDeals), these are market comps the user types in manually.
  manualComps:         'ace_manual_comps',
  // v113.21: Task notifications — bell dropdown, triggered on assign / overdue-plan / completed.
  taskNotifications:   'ace_task_notifications',
  // v157: junction table for shared tasks (multi-assignee). Per-(task,user)
  // sort_order so each agent has their own queue position for the task.
  taskAssignees:       'ace_task_assignees'
};
