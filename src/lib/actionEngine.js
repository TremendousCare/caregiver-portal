import { getCurrentPhase, getDaysInPhase, getDaysSinceApplication, isTaskDone } from './utils';

const URGENCY = { critical: 0, warning: 1, info: 2 };

export const generateActionItems = (caregivers) => {
  const items = [];
  const now = Date.now();

  caregivers.forEach((cg) => {
    const name = `${cg.firstName} ${cg.lastName}`;
    const phase = getCurrentPhase(cg);
    const daysInPhase = getDaysInPhase(cg);
    const daysSinceApp = getDaysSinceApplication(cg);

    // ── 24-Hour Interview Standard ──
    if (phase === 'intake' && daysSinceApp >= 1 && !isTaskDone(cg.tasks?.calendar_invite)) {
      items.push({
        cgId: cg.id,
        name,
        urgency: daysSinceApp >= 2 ? 'critical' : 'warning',
        icon: '🕐',
        title: 'Interview not yet scheduled',
        detail: `Day ${daysSinceApp} — Goal is application to interview within 24 hours.`,
        action: 'Schedule virtual interview now',
      });
    }

    // ── Offer Letter Chase (Phase: interview) ──
    if (phase === 'interview' && isTaskDone(cg.tasks?.offer_letter_sent) && !isTaskDone(cg.tasks?.offer_hold)) {
      const sentTimestamp = cg.phaseTimestamps?.interview;
      if (sentTimestamp) {
        const daysSinceSent = Math.floor((now - sentTimestamp) / 86400000);
        if (daysSinceSent >= 3) {
          items.push({
            cgId: cg.id, name, urgency: 'critical', icon: '📝',
            title: 'Offer letter unsigned — Day ' + daysSinceSent,
            detail: 'Policy: retract offer if not accepted within 3 business days.',
            action: 'Call + text: final warning',
          });
        } else if (daysSinceSent >= 2) {
          items.push({
            cgId: cg.id, name, urgency: 'warning', icon: '📝',
            title: 'Offer letter unsigned — Day ' + daysSinceSent,
            detail: '"We cannot proceed without this."',
            action: 'Call + text follow-up',
          });
        }
      }
    }

    // ── 7-Day Onboarding Sprint ──
    if (phase === 'onboarding') {
      const sprintStart = cg.phaseTimestamps?.onboarding || cg.phaseTimestamps?.interview;
      if (sprintStart) {
        const sprintDay = Math.floor((now - sprintStart) / 86400000);
        if (sprintDay >= 7) {
          items.push({
            cgId: cg.id, name, urgency: 'critical', icon: '🚨',
            title: '7-Day Sprint EXPIRED',
            detail: `Day ${sprintDay} of onboarding — policy is to retract offer.`,
            action: 'Retract offer or escalate to management',
          });
        } else if (sprintDay >= 5) {
          items.push({
            cgId: cg.id, name, urgency: 'critical', icon: '⏰',
            title: `Onboarding deadline in ${7 - sprintDay} day${7 - sprintDay === 1 ? '' : 's'}`,
            detail: `Day ${sprintDay} of 7 — "Are you free now? I can help you on the phone."`,
            action: 'The Intervention: call and offer to help complete docs',
          });
        } else if (sprintDay >= 3) {
          items.push({
            cgId: cg.id, name, urgency: 'warning', icon: '📋',
            title: `Onboarding docs incomplete — Day ${sprintDay}`,
            detail: `${7 - sprintDay} days remaining in the 7-day sprint.`,
            action: 'Follow up: "Do you have any questions?"',
          });
        }
      }
    }

    // ── Verification stall ──
    if (phase === 'verification' && daysInPhase >= 3) {
      items.push({
        cgId: cg.id, name,
        urgency: daysInPhase >= 5 ? 'critical' : 'warning',
        icon: '✅',
        title: `Verification pending — Day ${daysInPhase}`,
        detail: 'Check: I-9 validation, HCA Guardian status, CareAcademy, WellSky entry.',
        action: 'Complete remaining verification items',
      });
    }

    // ── Orientation not scheduled ──
    if (phase === 'orientation' && !isTaskDone(cg.tasks?.invite_sent) && daysInPhase >= 1) {
      items.push({
        cgId: cg.id, name, urgency: 'warning', icon: '🎓',
        title: 'Orientation invite not sent',
        detail: 'Caregiver is ready — schedule for next Sunday orientation.',
        action: 'Send calendar invite with instructions',
      });
    }

    // ── HCA Expiration warnings ──
    if (cg.hcaExpiration) {
      const exp = new Date(cg.hcaExpiration + 'T00:00:00');
      const daysUntil = Math.ceil((exp - new Date()) / 86400000);
      if (daysUntil < 0) {
        items.push({
          cgId: cg.id, name, urgency: 'critical', icon: '⚠️',
          title: 'HCA registration EXPIRED',
          detail: `Expired ${Math.abs(daysUntil)} days ago. Caregiver cannot be deployed.`,
          action: 'Contact caregiver to renew HCA immediately',
        });
      } else if (daysUntil <= 30) {
        items.push({
          cgId: cg.id, name, urgency: 'warning', icon: '📅',
          title: `HCA expiring in ${daysUntil} days`,
          detail: `Expires ${exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. Begin renewal process.`,
          action: 'Send HCA renewal reminder',
        });
      } else if (daysUntil <= 90) {
        items.push({
          cgId: cg.id, name, urgency: 'info', icon: '📅',
          title: `HCA expiring in ${daysUntil} days`,
          detail: `Expires ${exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. Plan ahead for renewal.`,
          action: 'Note for upcoming renewal',
        });
      }
    }

    // ── Phase stall (general) ──
    if (phase === 'intake' && daysInPhase >= 4 && !isTaskDone(cg.tasks?.phone_screen)) {
      items.push({
        cgId: cg.id, name, urgency: 'warning', icon: '📞',
        title: `No phone screen after ${daysInPhase} days`,
        detail: 'Candidate may be lost. Consider final outreach attempt.',
        action: 'Day 5 final attempt or close out',
      });
    }
  });

  items.sort((a, b) => URGENCY[a.urgency] - URGENCY[b.urgency]);
  return items;
};
