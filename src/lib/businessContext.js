import { PHASES } from './constants';
import { getCurrentPhase, getOverallProgress, isTaskDone, getDaysSinceApplication } from './utils';
import { getPhaseTasks } from './storage';

const BUSINESS_OVERVIEW = `You are the AI assistant for Tremendous Care, a home care agency based in California.
Your role is to help recruiters manage their caregiver pipeline efficiently.

ABOUT THE BUSINESS:
- Tremendous Care recruits, onboards, and deploys home caregivers to clients
- The recruiting pipeline has 5 phases: Intake & Screen → Interview & Offer → Onboarding Packet → Verification & Handoff → Orientation
- Each phase has specific tasks that must be completed before a caregiver advances
- "Green Light" means a caregiver has cleared all critical compliance items (offer signed, I-9, W-4, HCA cleared, TB test, training)
- Caregivers who don't work out are "archived" with a reason (not deleted)

KEY TERMINOLOGY:
- HCA = Home Care Aide (state certification via Washington State HCA registry)
- PER ID = Provider Entity Registry ID (unique HCA identifier)
- Guardian = Background check system
- CareAcademy = Online training platform (5 hours required)
- WellSky = Care management software for scheduling and records
- DocuSign = Electronic signature platform for offer letters and onboarding packets
- Green Light = All critical compliance requirements met, ready for orientation
- The Chase = Follow-up protocol for unresponsive candidates

COMMUNICATION STYLE:
- Be helpful, concise, and professional
- When discussing caregivers, use their first name
- If asked about data you don't have, say so honestly
- You can suggest next actions based on where a caregiver is in the pipeline
- Format numbers and dates clearly
- Use bullet points for lists`;

export function buildSystemPrompt(caregivers, selectedCaregiver) {
  const active = caregivers.filter(cg => !cg.archived);
  const archived = caregivers.filter(cg => cg.archived);
  const phaseTasks = getPhaseTasks();

  // Pipeline stats
  const phaseCounts = {};
  for (const phase of PHASES) {
    phaseCounts[phase.label] = active.filter(cg => getCurrentPhase(cg) === phase.id).length;
  }

  let prompt = BUSINESS_OVERVIEW;

  prompt += `\n\nCURRENT PIPELINE SNAPSHOT:
- Total active caregivers: ${active.length}
- Archived: ${archived.length}`;

  for (const phase of PHASES) {
    prompt += `\n- ${phase.label}: ${phaseCounts[phase.label]}`;
  }

  // Add summary of all active caregivers
  if (active.length > 0 && active.length <= 50) {
    prompt += '\n\nACTIVE CAREGIVERS:';
    for (const cg of active) {
      const phase = getCurrentPhase(cg);
      const pct = getOverallProgress(cg);
      const days = getDaysSinceApplication(cg);
      prompt += `\n- ${cg.firstName} ${cg.lastName} | Phase: ${phase} | Progress: ${pct}% | Days in pipeline: ${days || '?'}`;
      if (cg.phone) prompt += ` | Phone: ${cg.phone}`;
      if (cg.source) prompt += ` | Source: ${cg.source}`;
    }
  }

  // If viewing a specific caregiver, include full detail
  if (selectedCaregiver) {
    const cg = selectedCaregiver;
    const phase = getCurrentPhase(cg);
    const phaseObj = PHASES.find(p => p.id === phase);

    prompt += `\n\nCURRENTLY VIEWING CAREGIVER: ${cg.firstName} ${cg.lastName}`;
    prompt += `\n- Phone: ${cg.phone || 'Not provided'}`;
    prompt += `\n- Email: ${cg.email || 'Not provided'}`;
    prompt += `\n- Current Phase: ${phaseObj?.label || phase}`;
    prompt += `\n- Overall Progress: ${getOverallProgress(cg)}%`;
    if (cg.source) prompt += `\n- Source: ${cg.source}${cg.sourceDetail ? ` (${cg.sourceDetail})` : ''}`;
    if (cg.yearsExperience) prompt += `\n- Years Experience: ${cg.yearsExperience}`;
    if (cg.languages) prompt += `\n- Languages: ${cg.languages}`;
    if (cg.specializations) prompt += `\n- Specializations: ${cg.specializations}`;
    if (cg.preferredShift) prompt += `\n- Preferred Shift: ${cg.preferredShift}`;
    if (cg.perId) prompt += `\n- PER ID: ${cg.perId}`;
    if (cg.availability) prompt += `\n- Availability: ${cg.availability}`;

    // Task status for each phase
    for (const p of PHASES) {
      const tasks = phaseTasks[p.id] || [];
      if (tasks.length === 0) continue;
      const done = tasks.filter(t => isTaskDone(cg.tasks?.[t.id])).length;
      if (done > 0 || p.id === phase) {
        prompt += `\n\n${p.label} Tasks (${done}/${tasks.length}):`;
        for (const task of tasks) {
          const isDone = isTaskDone(cg.tasks?.[task.id]);
          prompt += `\n  ${isDone ? '[x]' : '[ ]'} ${task.label}${task.critical ? ' (CRITICAL)' : ''}`;
        }
      }
    }

    // Recent notes
    if (cg.notes?.length > 0) {
      const recent = cg.notes.slice(-5);
      prompt += '\n\nRECENT NOTES:';
      for (const note of recent) {
        const date = note.timestamp ? new Date(note.timestamp).toLocaleDateString() : '?';
        const author = note.author ? ` (${note.author})` : '';
        const type = note.type ? ` [${note.type}]` : '';
        prompt += `\n- ${date}${author}${type}: ${note.text}`;
      }
    }
  }

  return prompt;
}
