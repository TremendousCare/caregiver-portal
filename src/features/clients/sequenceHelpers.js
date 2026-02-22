// ═══════════════════════════════════════════════════════════════
// Sequence Helper Functions (exported for testing)
// ═══════════════════════════════════════════════════════════════

/**
 * Simple merge field substitution for client templates.
 */
export function resolveClientMergeFields(template, client) {
  return template
    .replace(/\{\{first_name\}\}/g, client.firstName || '')
    .replace(/\{\{last_name\}\}/g, client.lastName || '')
    .replace(/\{\{phone\}\}/g, client.phone || '')
    .replace(/\{\{email\}\}/g, client.email || '');
}

/**
 * Normalize action_type from sequence steps.
 */
export function normalizeSequenceAction(actionType) {
  switch (actionType) {
    case 'send_sms': case 'sms': return 'send_sms';
    case 'send_email': case 'email': return 'send_email';
    case 'create_task': case 'task': return 'create_task';
    default: return actionType;
  }
}

/**
 * Check whether a client should be auto-enrolled in a sequence.
 * Returns true if there are no active enrollments for this sequence.
 *
 * @param {Array} existingEnrollments - Rows from client_sequence_enrollments
 */
export function shouldAutoEnroll(existingEnrollments) {
  if (!existingEnrollments || existingEnrollments.length === 0) return true;
  return !existingEnrollments.some((e) => e.status === 'active');
}

/**
 * Build an enrollment record for inserting into client_sequence_enrollments.
 *
 * @param {string} clientId
 * @param {string} sequenceId
 * @param {string} startedBy - User email or 'system'
 * @param {number} [startFromStep=0] - Which step to begin from
 * @returns {Object} Row data for insert
 */
export function buildEnrollmentRecord(clientId, sequenceId, startedBy, startFromStep = 0) {
  return {
    client_id: clientId,
    sequence_id: sequenceId,
    status: 'active',
    current_step: startFromStep,
    started_by: startedBy,
    start_from_step: startFromStep,
  };
}
