import { supabase, isSupabaseConfigured } from '../../../lib/supabase';

// ═══════════════════════════════════════════════════════════════
// Voice extract client
//
// Thin wrapper around the `care-plan-voice-extract` edge function.
// supabase.functions.invoke is awkward for multipart, so this uses
// direct fetch with the user's bearer token — same pattern as the
// BD portal's bd-transcribe call in src/features/bd-portal/QuickCapture.jsx.
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';


/**
 * Send a recorded audio blob to the voice-extract edge function and
 * receive back the transcript + per-field extracted claims + (for
 * sections with a tasks side table) proposed tasks.
 *
 * @param {Object}  args
 * @param {Blob}    args.audio           - Recorded audio blob (webm/mp4)
 * @param {Object}  args.schema          - Extraction schema (from buildVoiceFieldSchema)
 * @param {Object=} args.taskSchema      - Task schema (from buildVoiceTaskSchema); null/omitted for sections without tasks
 * @param {Object}  args.currentValues   - Current section data (preserved unless updated)
 * @param {string}  args.versionId       - care_plan_versions.id (for audit event)
 * @param {string=} args.clientId        - clients.id (for audit event)
 * @param {string=} args.userId          - User identifier (for audit event)
 *
 * @returns {Promise<{
 *   transcript: string,
 *   extracted: Array<{
 *     id: string, value: any, confidence: 'high'|'medium'|'low',
 *     quote: string, fieldLabel: string, fieldType: string,
 *     quoteVerified: boolean,
 *   }>,
 *   rejected: Array<{ claim: any, reason: string }>,
 *   proposedTasks: Array<{
 *     category: string, task_name: string, description?: string,
 *     shifts: string[], days_of_week: string[], priority: string,
 *     safety_notes?: string, confidence: string, quote: string,
 *     categoryLabel: string, groupId?: string, quoteVerified: boolean,
 *   }>,
 *   rejectedTasks: Array<{ claim: any, reason: string }>,
 *   costUsd: number,
 *   model: string,
 *   transcriptionMs: number,
 *   extractionMs: number,
 * }>}
 */
export async function extractVoiceFields({
  audio, schema, taskSchema, currentValues, versionId, clientId, userId,
}) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }
  if (!SUPABASE_URL) {
    throw new Error('VITE_SUPABASE_URL is not set');
  }
  if (!audio) throw new Error('audio blob is required');
  if (!schema) throw new Error('schema is required');
  if (!versionId) throw new Error('versionId is required');

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in');

  const filename = audio.type.includes('mp4') ? 'memo.mp4'
    : audio.type.includes('mpeg') ? 'memo.mp3'
    : audio.type.includes('wav')  ? 'memo.wav'
    : audio.type.includes('ogg')  ? 'memo.ogg'
    : 'memo.webm';

  const form = new FormData();
  form.append('file', audio, filename);
  form.append('schema', JSON.stringify(schema));
  if (taskSchema) form.append('taskSchema', JSON.stringify(taskSchema));
  form.append('currentValues', JSON.stringify(currentValues || {}));
  form.append('versionId', versionId);
  if (clientId) form.append('clientId', clientId);
  if (userId)   form.append('userId',   userId);

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/care-plan-voice-extract`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      detail = body.detail || body.error || JSON.stringify(body);
    } catch {
      detail = await resp.text().catch(() => '');
    }
    throw new Error(`Voice extract failed (${resp.status}): ${detail.slice(0, 200)}`);
  }

  return resp.json();
}
