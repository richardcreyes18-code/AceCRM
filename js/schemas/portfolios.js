// schemas/portfolios.js — ace_portfolios ↔ Airtable-style label map.
// v102.28: Mirrors the structure of SB_PROP_MAP so the same _atToSb / _sbToAt
// helpers work — just pass SB_PORTFOLIO_MAP as the second argument.

export const SB_PORTFOLIO_MAP = {
  id:'id', name:'Name', description:'Description',
  package_price:'Package Price', package_asking_notes:'Package Asking Notes',
  status:'Status', pipeline_stage:'Pipeline Stage',
  is_archived:'Is Archived', top_priority:'Top Priority',
  assigned_agent:'Assigned Agent', owner_user_id:'Owner User ID',
  next_steps:'Next Steps', portfolio_notes:'Portfolio Notes',
  target_seller_net:'Target Seller Net',
  date_listed:'Date Listed', close_probability:'Close Probability',
  created_at:'Created Time', created_by_user_id:'Created By User ID',
  updated_at:'Updated Time'
};
