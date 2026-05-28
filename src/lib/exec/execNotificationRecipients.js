// Pure logic for resolving who receives an exec-task notification.
//
// Spec (locked with owner 2026-05-28):
//   - If the task has assigned_to set → that one email is the
//     recipient.
//   - If assigned_to is null → fan out to every owner email returned
//     by get_owner_emails(org_id).
//
// The lifecycle generator (planLifecycleInstance) already does the
// "manager → null" handoff at creation time: if a template has no
// default_assignee_email AND the staff member has no manager_email,
// the resulting row has assigned_to = NULL. So the dispatcher's
// fan-out triggers exactly when the user wants it: a lifecycle task
// for someone with no manager, an ad-hoc task left blank, a recurring
// template with no default assignee.
//
// All inputs are case-normalized to lowercase + trimmed so a
// caregiver-portal SET CASE leak (e.g. "KEVIN@TC.COM" vs
// "kevin@tc.com") doesn't double-notify or miss an owner.

export function resolveRecipients({ assignedTo, ownerEmails }) {
  if (assignedTo && typeof assignedTo === 'string' && assignedTo.trim()) {
    return [assignedTo.trim().toLowerCase()];
  }
  if (!Array.isArray(ownerEmails)) return [];
  const seen = new Set();
  const out = [];
  for (const e of ownerEmails) {
    if (!e || typeof e !== 'string') continue;
    const norm = e.trim().toLowerCase();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// Whether this task should also trigger an email send. The template
// linkage is the source of truth; ad-hoc tasks (template_id=null)
// never email.
export function shouldSendEmail(task) {
  return !!task?.exec_task_templates?.send_email_on_notify;
}

// Build the in-app + email subject. Lifecycle tasks pull the staff
// member's name into the subject so the bell preview reads naturally
// ("30-day check-in — Alex Rivera"). Recurring + ad-hoc just use the
// title.
export function buildToastTitle(task) {
  const base = task?.title ?? task?.exec_task_templates?.name ?? 'Executive task';
  if (task?.category === 'lifecycle' && task?.anchor_staff_email) {
    return `${base} — ${task.anchor_staff_email}`;
  }
  return base;
}

export function buildToastMessage(task) {
  const parts = [];
  if (task?.urgency && task.urgency !== 'warning') parts.push(task.urgency);
  if (task?.category) parts.push(task.category.replace('_', ' '));
  if (task?.recurrence_period) parts.push(task.recurrence_period);
  return parts.length === 0 ? 'Due now' : `${parts.join(' · ')} · due now`;
}

export function buildEmailSubject(task) {
  const t = buildToastTitle(task);
  const urg = task?.urgency === 'critical' ? '[URGENT] ' : '';
  return `${urg}Executive task due: ${t}`;
}

// Plain-text body. Keeps the email scannable; the link points back to
// /exec/tasks so the recipient can complete from there.
export function buildEmailBody(task, portalBaseUrl) {
  const lines = [];
  lines.push(`Task: ${buildToastTitle(task)}`);
  if (task?.urgency) lines.push(`Urgency: ${task.urgency}`);
  if (task?.due_at) lines.push(`Due: ${task.due_at}`);
  if (task?.description) {
    lines.push('');
    lines.push(task.description);
  }
  if (task?.exec_task_templates?.guidance) {
    lines.push('');
    lines.push('Guidance:');
    lines.push(task.exec_task_templates.guidance);
  }
  lines.push('');
  const link = `${(portalBaseUrl ?? 'https://caregiver-portal.vercel.app').replace(/\/$/, '')}/exec/tasks`;
  lines.push(`Open the Executive Tasks page to complete: ${link}`);
  return lines.join('\n');
}
