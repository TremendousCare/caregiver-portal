// Phase 1.6.1 — call_taxonomy CRUD helpers.
//
// Thin wrappers over the Supabase queries the Settings UI uses. Reads
// go straight to the table (gated by RLS); writes go through the
// `upsert_call_taxonomy_row_v1` RPC (admin-gated server-side).
//
// Kept as plain JS so it's testable without React + Supabase mocking
// gymnastics — the test file exercises these helpers against a small
// in-memory supabase mock.

import { supabase } from './supabase';

export const CALL_TAXONOMY_AXES = ['call_type', 'red_flag'];

/**
 * Fetch every taxonomy row for the current org. Sorted by axis then
 * the operator's sort_order. Includes archived rows so the UI can
 * surface them under a "show archived" toggle.
 */
export async function listCallTaxonomy() {
  const { data, error } = await supabase
    .from('call_taxonomy')
    .select('id, axis, slug, label, description, sort_order, is_active, created_at, updated_at')
    .order('axis', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * Insert or update a taxonomy row. Routes through the SECURITY
 * DEFINER RPC; the admin gate is enforced server-side.
 *
 * @param {Object} input
 * @param {'call_type'|'red_flag'} input.axis
 * @param {string} input.slug
 * @param {string} input.label
 * @param {string|null} [input.description]
 * @param {number} [input.sortOrder]
 * @param {boolean} [input.isActive]
 * @returns {Promise<string>} the row's id
 */
export async function upsertCallTaxonomyRow({
  axis,
  slug,
  label,
  description = null,
  sortOrder = 0,
  isActive = true,
}) {
  if (!CALL_TAXONOMY_AXES.includes(axis)) {
    throw new Error(`invalid axis: ${axis}`);
  }
  if (!slug || typeof slug !== 'string') throw new Error('slug is required');
  if (!label || typeof label !== 'string') throw new Error('label is required');
  const { data, error } = await supabase.rpc('upsert_call_taxonomy_row_v1', {
    p_axis:        axis,
    p_slug:        slug,
    p_label:       label,
    p_description: description ?? null,
    p_sort_order:  Number.isFinite(sortOrder) ? sortOrder : 0,
    p_is_active:   isActive !== false,
  });
  if (error) throw error;
  return data;
}

/** Archive a row by toggling is_active to false. Slug stays reserved. */
export async function archiveCallTaxonomyRow(row) {
  return upsertCallTaxonomyRow({
    axis:        row.axis,
    slug:        row.slug,
    label:       row.label,
    description: row.description,
    sortOrder:   row.sort_order,
    isActive:    false,
  });
}

/** Restore an archived row. */
export async function unarchiveCallTaxonomyRow(row) {
  return upsertCallTaxonomyRow({
    axis:        row.axis,
    slug:        row.slug,
    label:       row.label,
    description: row.description,
    sortOrder:   row.sort_order,
    isActive:    true,
  });
}

/**
 * Slugify a label into a candidate slug. Mirrors the planner's
 * vocabulary — lowercase, underscores, alphanumeric only. The UI
 * suggests this when the admin types a label; the admin can always
 * override.
 */
export function slugifyLabel(label) {
  if (!label || typeof label !== 'string') return '';
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}
