// ═══════════════════════════════════════════════════════════════
// Message Template Helpers
//
// Pure helpers for the `message_templates` table — admin-managed
// reusable SMS templates that staff can select from the inline
// composer. The placeholder renderer is reused from broadcastHelpers
// so 1:1 SMS and shift broadcasts share a single substitution engine.
//
// Placeholders available for 1:1 caregiver templates:
//   {{firstName}}   caregiver's first name
//   {{lastName}}    caregiver's last name
//   {{fullName}}    "firstName lastName" trimmed
//
// Unknown placeholders render as empty strings (defensive — same
// behavior as broadcastHelpers.renderTemplate).
// ═══════════════════════════════════════════════════════════════

import { supabase } from '../../../lib/supabase';
import { renderTemplate } from '../../scheduling/broadcastHelpers';

// ─── Categories ─────────────────────────────────────────────────
// Hardcoded for now. If we ever want editable categories, promote
// to a small `message_template_categories` table and migrate.

export const MESSAGE_TEMPLATE_CATEGORIES = ['onboarding', 'scheduling', 'general'];

export const MESSAGE_TEMPLATE_CATEGORY_LABELS = {
  onboarding: 'Onboarding',
  scheduling: 'Scheduling',
  general: 'General',
};

export function isValidCategory(category) {
  return MESSAGE_TEMPLATE_CATEGORIES.includes(category);
}

// ─── Placeholder substitution ───────────────────────────────────

/**
 * Build merge-field values for a 1:1 SMS to a caregiver. Mirrors
 * broadcastHelpers.buildMergeFields shape but without shift/client
 * context — this runs in the composer where there's no shift.
 */
export function buildCaregiverMergeFields(caregiver) {
  const firstName = caregiver?.firstName || '';
  const lastName = caregiver?.lastName || '';
  const fullName = `${firstName} ${lastName}`.trim();
  return { firstName, lastName, fullName };
}

/**
 * Render a template body by substituting caregiver merge fields.
 * Returns empty string for null/undefined template.
 */
export function renderCaregiverTemplate(templateBody, caregiver) {
  const fields = buildCaregiverMergeFields(caregiver);
  return renderTemplate(templateBody, fields);
}

// ─── Validation ─────────────────────────────────────────────────

const MAX_NAME_LENGTH = 80;
const MAX_BODY_LENGTH = 1600; // SMS soft cap, same as broadcast

/**
 * Validate a template draft before save. Returns null if OK, or
 * an error string suitable for inline form display.
 */
export function validateTemplateDraft(draft) {
  if (!draft) return 'Missing template data.';
  const name = (draft.name || '').trim();
  const body = (draft.body || '').trim();
  if (!name) return 'Name is required.';
  if (name.length > MAX_NAME_LENGTH) {
    return `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  }
  if (!isValidCategory(draft.category)) {
    return 'Pick a category.';
  }
  if (!body) return 'Message body cannot be empty.';
  if (body.length > MAX_BODY_LENGTH) {
    return `Message must be ${MAX_BODY_LENGTH} characters or fewer.`;
  }
  return null;
}

// ─── Supabase CRUD ──────────────────────────────────────────────
// Thin wrappers — all authorization is enforced server-side via RLS.
// Callers handle errors/toasts; helpers stay pure and throw on error
// so React Query / try-catch patterns work naturally.

/**
 * Load active (non-archived) templates ordered by category then name.
 * Staff call this from the composer; admins call listAllTemplates()
 * from the Settings UI to also see archived rows.
 */
export async function listActiveTemplates() {
  const { data, error } = await supabase
    .from('message_templates')
    .select('id, name, category, body, is_archived, updated_at')
    .eq('is_archived', false)
    .order('category', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Load all templates (active + archived) for the admin UI.
 */
export async function listAllTemplates() {
  const { data, error } = await supabase
    .from('message_templates')
    .select('id, name, category, body, is_archived, created_at, updated_at, created_by, updated_by')
    .order('is_archived', { ascending: true })
    .order('category', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createTemplate({ name, category, body, createdBy }) {
  const err = validateTemplateDraft({ name, category, body });
  if (err) throw new Error(err);
  const { data, error } = await supabase
    .from('message_templates')
    .insert({
      name: name.trim(),
      category,
      body: body.trim(),
      created_by: createdBy || null,
      updated_by: createdBy || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateTemplate(id, { name, category, body, updatedBy }) {
  const err = validateTemplateDraft({ name, category, body });
  if (err) throw new Error(err);
  const { data, error } = await supabase
    .from('message_templates')
    .update({
      name: name.trim(),
      category,
      body: body.trim(),
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function archiveTemplate(id, updatedBy) {
  const { data, error } = await supabase
    .from('message_templates')
    .update({
      is_archived: true,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function unarchiveTemplate(id, updatedBy) {
  const { data, error } = await supabase
    .from('message_templates')
    .update({
      is_archived: false,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── UI helpers ─────────────────────────────────────────────────

/**
 * Group templates by category for rendering in sections. Returns an
 * array of { category, label, templates } in the canonical category
 * order. Categories with no templates are omitted.
 */
export function groupTemplatesByCategory(templates) {
  const buckets = new Map();
  for (const t of templates || []) {
    if (!buckets.has(t.category)) buckets.set(t.category, []);
    buckets.get(t.category).push(t);
  }
  return MESSAGE_TEMPLATE_CATEGORIES
    .filter((cat) => buckets.has(cat))
    .map((cat) => ({
      category: cat,
      label: MESSAGE_TEMPLATE_CATEGORY_LABELS[cat],
      templates: buckets.get(cat),
    }));
}

/**
 * Case-insensitive search across template name and body. Used by
 * the composer popover's search box.
 */
export function searchTemplates(templates, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return templates || [];
  return (templates || []).filter(
    (t) =>
      (t.name || '').toLowerCase().includes(q) ||
      (t.body || '').toLowerCase().includes(q),
  );
}

/**
 * Available placeholder chips for the admin template editor. Kept
 * here (not in broadcastHelpers) because 1:1 templates have a
 * smaller field set than shift broadcasts.
 */
export const CAREGIVER_TEMPLATE_PLACEHOLDERS = [
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'fullName', label: 'Full Name' },
];
