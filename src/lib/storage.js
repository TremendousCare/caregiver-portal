import { supabase, isSupabaseConfigured } from './supabase';
import { DEFAULT_PHASE_TASKS, DEFAULT_BOARD_COLUMNS } from './constants';

// ═══════════════════════════════════════════════════════════════
// Storage Abstraction Layer
//
// This module provides the same API regardless of backend:
// - If Supabase is configured → reads/writes to Supabase tables
// - If not → falls back to localStorage (single-user, dev mode)
//
// When you set up Supabase, the app switches automatically —
// no code changes needed in any component.
// ═══════════════════════════════════════════════════════════════

const CAREGIVERS_KEY = 'tc-caregivers-v2';
const PHASE_TASKS_KEY = 'tc-phase-tasks-v1';
const BOARD_COLUMNS_KEY = 'tc-board-columns-v1';
const ORIENTATION_KEY = 'tc-orientation-v1';
const AUTH_KEY = 'tc-auth-v1';

// ─── Phase Tasks (module-level, shared across components) ────
// This is intentionally mutable at module scope so all utility
// functions can reference the current task definitions.
let _phaseTasks = JSON.parse(JSON.stringify(DEFAULT_PHASE_TASKS));

export const getPhaseTasks = () => _phaseTasks;

export const setPhaseTasks = (tasks) => {
  _phaseTasks = tasks;
};

// ─── localStorage Helpers ────────────────────────────────────
const localGet = (key) => {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
};

const localSet = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error('localStorage save failed:', e);
  }
};

// ─── Supabase Helpers ────────────────────────────────────────
// These use a simple key-value "app_data" table for settings,
// and a "caregivers" table for caregiver records.
// See /supabase/schema.sql for the table definitions.

const supabaseGetKV = async (key) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('app_data')
    .select('value')
    .eq('key', key)
    .single();
  if (error || !data) return null;
  return data.value;
};

const supabaseSetKV = async (key, value) => {
  if (!supabase) return;
  await supabase
    .from('app_data')
    .upsert({ key, value }, { onConflict: 'key' });
};

// ═══════════════════════════════════════════════════════════════
// Public API — these are what components import
// ═══════════════════════════════════════════════════════════════

// ─── Caregivers ──────────────────────────────────────────────

export const loadCaregivers = async () => {
  try {
    if (isSupabaseConfigured()) {
      const { data, error } = await supabase
        .from('caregivers')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Map snake_case DB columns to camelCase app fields
      return (data || []).map(dbToCaregiver);
    }
    // Fallback: localStorage
    return localGet(CAREGIVERS_KEY) || [];
  } catch (e) {
    console.error('loadCaregivers failed:', e);
    return localGet(CAREGIVERS_KEY) || [];
  }
};

export const saveCaregivers = async (caregivers) => {
  try {
    if (isSupabaseConfigured()) {
      // For now, we do a simple full-replace strategy.
      // A more sophisticated approach would diff and upsert individual rows.
      // This is fine for teams < 20 users with < 500 caregivers.
      const rows = caregivers.map(caregiverToDb);
      const { error } = await supabase
        .from('caregivers')
        .upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      return;
    }
    localSet(CAREGIVERS_KEY, caregivers);
  } catch (e) {
    console.error('saveCaregivers failed:', e);
    // Always keep a localStorage backup
    localSet(CAREGIVERS_KEY, caregivers);
  }
};

export const deleteCaregiversFromDb = async (ids) => {
  if (isSupabaseConfigured()) {
    await supabase.from('caregivers').delete().in('id', ids);
  }
};

// ─── Phase Tasks ─────────────────────────────────────────────

export const loadPhaseTasks = async () => {
  try {
    if (isSupabaseConfigured()) {
      const val = await supabaseGetKV('phase_tasks');
      if (val) {
        _phaseTasks = typeof val === 'string' ? JSON.parse(val) : val;
        return;
      }
    }
    const local = localGet(PHASE_TASKS_KEY);
    if (local) _phaseTasks = local;
  } catch {
    // Keep defaults
  }
};

export const savePhaseTasks = async () => {
  try {
    if (isSupabaseConfigured()) {
      await supabaseSetKV('phase_tasks', _phaseTasks);
    }
    localSet(PHASE_TASKS_KEY, _phaseTasks);
  } catch {}
};

// ─── Board Columns ───────────────────────────────────────────

export const loadBoardColumns = async () => {
  try {
    if (isSupabaseConfigured()) {
      const val = await supabaseGetKV('board_columns');
      if (val) return typeof val === 'string' ? JSON.parse(val) : val;
    }
    return localGet(BOARD_COLUMNS_KEY) || DEFAULT_BOARD_COLUMNS;
  } catch {
    return DEFAULT_BOARD_COLUMNS;
  }
};

export const saveBoardColumns = async (columns) => {
  try {
    if (isSupabaseConfigured()) {
      await supabaseSetKV('board_columns', columns);
    }
    localSet(BOARD_COLUMNS_KEY, columns);
  } catch {}
};

// ─── Orientation Data ────────────────────────────────────────

export const loadOrientationData = async () => {
  try {
    if (isSupabaseConfigured()) {
      const val = await supabaseGetKV('orientation');
      if (val) return typeof val === 'string' ? JSON.parse(val) : val;
    }
    return localGet(ORIENTATION_KEY) || {};
  } catch {
    return {};
  }
};

export const saveOrientationData = async (data) => {
  try {
    if (isSupabaseConfigured()) {
      await supabaseSetKV('orientation', data);
    }
    localSet(ORIENTATION_KEY, data);
  } catch {}
};

// ─── Auth ────────────────────────────────────────────────────

export const loadAuthState = async () => {
  try {
    const val = localStorage.getItem(AUTH_KEY);
    return val === '"authenticated"' || val === 'authenticated';
  } catch {
    return false;
  }
};

export const saveAuthState = async () => {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify('authenticated'));
  } catch {}
};

// ═══════════════════════════════════════════════════════════════
// DB ↔ App Field Mapping
// ═══════════════════════════════════════════════════════════════

// Supabase uses snake_case, our app uses camelCase.
// These mappers handle the translation.

const dbToCaregiver = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  email: row.email,
  address: row.address,
  city: row.city,
  state: row.state,
  zip: row.zip,
  perId: row.per_id,
  hcaExpiration: row.hca_expiration,
  hasHCA: row.has_hca,
  hasDL: row.has_dl,
  source: row.source,
  sourceDetail: row.source_detail,
  applicationDate: row.application_date,
  availability: row.availability,
  yearsExperience: row.years_experience,
  languages: row.languages,
  specializations: row.specializations,
  certifications: row.certifications,
  preferredShift: row.preferred_shift,
  initialNotes: row.initial_notes,
  tasks: row.tasks || {},
  notes: row.notes || [],
  phaseTimestamps: row.phase_timestamps || {},
  phaseOverride: row.phase_override,
  boardStatus: row.board_status,
  boardNote: row.board_note,
  boardMovedAt: row.board_moved_at,
  archived: row.archived || false,
  archivedAt: row.archived_at,
  archiveReason: row.archive_reason,
  archiveDetail: row.archive_detail,
  archivePhase: row.archive_phase,
  createdAt: row.created_at,
});

const caregiverToDb = (cg) => ({
  id: cg.id,
  first_name: cg.firstName || '',
  last_name: cg.lastName || '',
  phone: cg.phone || '',
  email: cg.email || '',
  address: cg.address || '',
  city: cg.city || '',
  state: cg.state || '',
  zip: cg.zip || '',
  per_id: cg.perId || '',
  hca_expiration: cg.hcaExpiration || null,
  has_hca: cg.hasHCA || 'yes',
  has_dl: cg.hasDL || 'yes',
  source: cg.source || '',
  source_detail: cg.sourceDetail || '',
  application_date: cg.applicationDate || null,
  availability: cg.availability || '',
  years_experience: cg.yearsExperience || '',
  languages: cg.languages || '',
  specializations: cg.specializations || '',
  certifications: cg.certifications || '',
  preferred_shift: cg.preferredShift || '',
  initial_notes: cg.initialNotes || '',
  tasks: cg.tasks || {},
  notes: cg.notes || [],
  phase_timestamps: cg.phaseTimestamps || {},
  phase_override: cg.phaseOverride || null,
  board_status: cg.boardStatus || '',
  board_note: cg.boardNote || '',
  board_moved_at: cg.boardMovedAt || null,
  archived: cg.archived || false,
  archived_at: cg.archivedAt || null,
  archive_reason: cg.archiveReason || null,
  archive_detail: cg.archiveDetail || null,
  archive_phase: cg.archivePhase || null,
  created_at: cg.createdAt || Date.now(),
});
