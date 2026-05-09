// schemas/tasks.js — ace_tasks + ace_task_notifications ↔ Airtable-style maps.
// v113.21 added multi-agent assignment, buyer link, sort_order, overdue-plan.

export const SB_TASK_MAP = {
  id:'id', task:'Task', due_date:'Due Date', priority:'Priority',
  notes:'Notes', status:'Status',
  property_id:'Property ID', contact_id:'Contact ID',
  buyer_criteria_id:'Buyer Criteria ID',
  task_type:'Task Type',
  communication_type:'Communication Type',
  assigned_to_user_id:'Assigned To', assigned_by_user_id:'Assigned By',
  assigned_at:'Assigned At',
  sort_order:'Sort Order',
  overdue_plan:'Overdue Plan', overdue_plan_at:'Overdue Plan At',
  created_by_user_id:'Created By', created_at:'Created At', updated_at:'Updated At'
};

// v113.21: Notifications table map
export const SB_NOTIF_MAP = {
  id:'id', recipient_user_id:'Recipient', actor_user_id:'Actor',
  task_id:'Task ID', type:'Type', message:'Message',
  read_at:'Read At', created_at:'Created At'
};
