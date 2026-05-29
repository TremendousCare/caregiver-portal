// ═══════════════════════════════════════════════════════════════
// assessmentDraftClient
//
// Drafts a care plan from a transcribed in-home assessment.
//
//   1. Build the per-section extraction schemas from sections.js
//      (the same buildVoiceFieldSchema / buildVoiceTaskSchema the
//      voice-capture flow uses) for every draft-eligible section.
//   2. Call the assessment-extract-care-plan edge function, which runs
//      Claude over the assessment transcript and returns validated
//      field claims + task proposals per section.
//   3. Ensure a DRAFT care plan version exists for the client, then
//      apply the claims through the existing audited storage.js path
//      (saveDraft / createTask) — same writes as a manual edit, so
//      events / current_version_id / version numbering are all handled.
//
// The edge function never writes; all persistence flows through
// storage.js here so there is exactly one care-plan write path.
// ═══════════════════════════════════════════════════════════════

import { supabase } from '../../../lib/supabase';
import { CARE_PLAN_SECTIONS } from '../sections';
import { buildVoiceFieldSchema } from './voiceFieldSchema';
import { buildVoiceTaskSchema } from './voiceTaskSchema';
import {
  eligibleAssessmentSections,
  claimsToFieldPatch,
  taskClaimToCreateInput,
  summarizeDraftResult,
} from '../../../lib/assessmentCarePlan';
import {
  getCarePlanForClient,
  createCarePlan,
  createNewDraftVersion,
  saveDraft,
  createTask,
} from '../storage';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

// Build the { sectionId, schema, taskSchema, currentValues } payload for
// every draft-eligible section. currentValues come from the existing
// draft (if any) so Claude preserves unchanged fields.
export function buildDraftSectionsPayload(currentValuesBySection = {}) {
  return eligibleAssessmentSections(CARE_PLAN_SECTIONS)
    .map((section) => {
      const schema = buildVoiceFieldSchema(section);
      if (!schema || !Array.isArray(schema.fields) || schema.fields.length === 0) return null;
      const taskSchema = buildVoiceTaskSchema(section);
      const payload = {
        sectionId: section.id,
        schema,
        currentValues: currentValuesBySection?.[section.id] || {},
      };
      if (taskSchema) payload.taskSchema = taskSchema;
      return payload;
    })
    .filter(Boolean);
}

// Call the edge function. Returns the parsed per-section results.
export async function requestAssessmentDraft({ assessmentId, currentValuesBySection }) {
  if (!supabase || !SUPABASE_URL) throw new Error('Not connected.');
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in.');

  const sections = buildDraftSectionsPayload(currentValuesBySection);
  if (sections.length === 0) throw new Error('No care-plan sections are available to draft.');

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/assessment-extract-care-plan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assessment_id: assessmentId, sections }),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const b = await resp.json();
      detail = b.error || b.detail || JSON.stringify(b);
    } catch { detail = await resp.text().catch(() => ''); }
    throw new Error(`Care-plan draft failed (${resp.status}): ${String(detail).slice(0, 200)}`);
  }
  return resp.json();
}

// Resolve a DRAFT version to write into: reuse the current draft, branch
// a new draft off a published version, or create the plan if none exists.
async function ensureDraftVersion(clientId, existing, userId) {
  if (!existing) {
    const created = await createCarePlan(clientId, { createdBy: userId });
    return { carePlanId: created.plan.id, versionId: created.currentVersion.id };
  }
  const carePlanId = existing.plan.id;
  const cv = existing.currentVersion;
  if (!cv) {
    throw new Error('This client has a care plan with no current version — open the Care Plan section once to initialize it, then retry.');
  }
  if (cv.status === 'draft') return { carePlanId, versionId: cv.id };
  const draft = await createNewDraftVersion(carePlanId, {
    fromVersionId: cv.id,
    reason: 'Drafted from in-home assessment',
    userId,
  });
  return { carePlanId, versionId: draft.id };
}

// Full orchestration: extract from the transcript, ensure a draft
// version, apply field patches + tasks. Returns the target version id
// and a summary for the toast.
export async function draftCarePlanFromAssessment({ assessmentId, clientId, userId }) {
  if (!clientId) throw new Error('clientId is required.');

  const existing = await getCarePlanForClient(clientId);
  const currentValuesBySection = existing?.currentVersion?.data || {};

  const result = await requestAssessmentDraft({ assessmentId, currentValuesBySection });

  const { carePlanId, versionId } = await ensureDraftVersion(clientId, existing, userId);

  for (const section of result.sections || []) {
    if (!section.ok) continue;
    const patch = claimsToFieldPatch(section.extracted);
    if (Object.keys(patch).length > 0) {
      await saveDraft(versionId, section.sectionId, patch, { userId });
    }
    for (const taskClaim of section.proposedTasks || []) {
      await createTask(versionId, taskClaimToCreateInput(taskClaim), { userId });
    }
  }

  return {
    carePlanId,
    versionId,
    summary: summarizeDraftResult(result.sections),
    costUsd: result.costUsd ?? null,
  };
}
