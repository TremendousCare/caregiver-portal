import { getClientPhase, getDaysInClientPhase, getDaysSinceCreated, isTaskDone } from './utils';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * Generates a sorted list of action items for clients based on urgency rules.
 *
 * @param {Array} clients - Array of client objects (camelCase app format)
 * @returns {Array} Action items sorted by severity (critical first)
 */
export const generateClientActionItems = (clients) => {
  const items = [];

  clients.forEach((client) => {
    const name = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Unnamed';
    const phase = getClientPhase(client);
    const daysInPhase = getDaysInClientPhase(client);
    const daysSinceCreated = getDaysSinceCreated(client);

    // Skip terminal phases
    if (phase === 'won' || phase === 'lost') return;

    // ── Speed to Lead: new_lead + no initial_call_attempted + > 30 min ──
    if (phase === 'new_lead' && !isTaskDone(client.tasks?.initial_call_attempted)) {
      const created = client.createdAt
        ? (typeof client.createdAt === 'number' ? client.createdAt : new Date(client.createdAt).getTime())
        : null;
      if (created) {
        const minutesSinceCreated = (Date.now() - created) / 60000;
        if (minutesSinceCreated > 30) {
          items.push({
            clientId: client.id,
            clientName: name,
            type: 'speed_to_lead',
            message: `New lead ${Math.round(minutesSinceCreated)} minutes old — no initial call attempted. Goal: contact within 30 minutes.`,
            severity: 'critical',
            phase,
          });
        }
      }
    }

    // ── No Contact: initial_contact + > 2 days ──
    if (phase === 'initial_contact' && daysInPhase > 2) {
      items.push({
        clientId: client.id,
        clientName: name,
        type: 'no_contact',
        message: `Day ${daysInPhase} in Initial Contact — still no live contact with decision-maker.`,
        severity: 'warning',
        phase,
      });
    }

    // ── Assessment Overdue: assessment + > 7 days ──
    if (phase === 'assessment' && daysInPhase > 7) {
      items.push({
        clientId: client.id,
        clientName: name,
        type: 'assessment_overdue',
        message: `Assessment phase open ${daysInPhase} days — home visit may be delayed or needs rescheduling.`,
        severity: 'warning',
        phase,
      });
    }

    // ── Proposal Follow-up: proposal + > 3 days without proposal_followup ──
    if (phase === 'proposal' && daysInPhase > 3 && !isTaskDone(client.tasks?.proposal_followup)) {
      items.push({
        clientId: client.id,
        clientName: name,
        type: 'proposal_followup',
        message: `Proposal sent ${daysInPhase} days ago — follow-up call not completed.`,
        severity: 'warning',
        phase,
      });
    }

    // ── Stale Lead: any active phase (not won/lost/nurture) + > 14 days in phase ──
    if (phase !== 'won' && phase !== 'lost' && phase !== 'nurture' && daysInPhase > 14) {
      // Don't duplicate if we already have a more specific action for this client/phase
      const hasSpecific = items.some(
        (item) => item.clientId === client.id && item.type !== 'stale_lead'
      );
      if (!hasSpecific) {
        items.push({
          clientId: client.id,
          clientName: name,
          type: 'stale_lead',
          message: `${daysInPhase} days in ${phase} phase — lead may be going cold. Consider follow-up or moving to nurture.`,
          severity: 'warning',
          phase,
        });
      }
    }

    // ── Nurture Check: nurture + > 30 days since last note ──
    if (phase === 'nurture') {
      const notes = client.notes || [];
      const lastNoteTs = notes.length > 0
        ? Math.max(...notes.map((n) => new Date(n.timestamp || n.date || 0).getTime()))
        : 0;
      const daysSinceLastNote = lastNoteTs > 0
        ? Math.floor((Date.now() - lastNoteTs) / 86400000)
        : daysSinceCreated;

      if (daysSinceLastNote > 30) {
        items.push({
          clientId: client.id,
          clientName: name,
          type: 'nurture_check',
          message: `${daysSinceLastNote} days since last activity — time for a nurture check-in.`,
          severity: 'info',
          phase,
        });
      }
    }
  });

  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return items;
};
