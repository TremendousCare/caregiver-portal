import { supabase, isSupabaseConfigured } from './supabase';
import { DEFAULT_PHASE_TASKS, DEFAULT_BOARD_COLUMNS, DEFAULT_BOARD_LABELS } from './constants';

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
      const mapped = (data || []).map(dbToCaregiver);
      // Cache to localStorage for offline fallback
      if (mapped.length > 0) localSet(CAREGIVERS_KEY, mapped);
      return mapped;
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
      const rows = caregivers.map(caregiverToDb);
      const { error } = await supabase
        .from('caregivers')
        .upsert(rows, { onConflict: 'id' });
      if (error) throw error;
    }
    localSet(CAREGIVERS_KEY, caregivers);
  } catch (e) {
    console.error('saveCaregivers failed:', e);
    localSet(CAREGIVERS_KEY, caregivers);
    throw e;
  }
};

// ─── Single-record save (preferred for individual edits) ────
export const saveCaregiver = async (caregiver) => {
  try {
    if (isSupabaseConfigured()) {
      const row = caregiverToDb(caregiver);
      const { error } = await supabase
        .from('caregivers')
        .upsert(row, { onConflict: 'id' });
      if (error) throw error;
    }
    // Update localStorage: replace just this record in the cached array
    const all = localGet(CAREGIVERS_KEY) || [];
    const idx = all.findIndex((c) => c.id === caregiver.id);
    if (idx >= 0) {
      all[idx] = caregiver;
    } else {
      all.unshift(caregiver);
    }
    localSet(CAREGIVERS_KEY, all);
  } catch (e) {
    console.error('saveCaregiver failed:', e);
    throw e;
  }
};

// ─── Bulk save for multi-select operations ──────────────────
export const saveCaregiversBulk = async (caregivers) => {
  try {
    if (isSupabaseConfigured()) {
      const rows = caregivers.map(caregiverToDb);
      const { error } = await supabase
        .from('caregivers')
        .upsert(rows, { onConflict: 'id' });
      if (error) throw error;
    }
    // Update localStorage: merge changed records into cached array
    const all = localGet(CAREGIVERS_KEY) || [];
    const changeMap = new Map(caregivers.map((c) => [c.id, c]));
    const updated = all.map((c) => changeMap.get(c.id) || c);
    // Add any new records not in the cached array
    for (const cg of caregivers) {
      if (!all.some((c) => c.id === cg.id)) updated.unshift(cg);
    }
    localSet(CAREGIVERS_KEY, updated);
  } catch (e) {
    console.error('saveCaregiversBulk failed:', e);
    throw e;
  }
};

export const deleteCaregiversFromDb = async (ids) => {
  if (isSupabaseConfigured()) {
    const { error } = await supabase.from('caregivers').delete().in('id', ids);
    if (error) throw new Error(error.message);
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
  } catch (e) {
    console.error('loadPhaseTasks failed:', e);
  }
};

export const savePhaseTasks = async () => {
  try {
    if (isSupabaseConfigured()) {
      await supabaseSetKV('phase_tasks', _phaseTasks);
    }
    localSet(PHASE_TASKS_KEY, _phaseTasks);
  } catch (e) {
    console.error('savePhaseTasks failed:', e);
  }
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
  } catch (e) {
    console.error('saveBoardColumns failed:', e);
  }
};

// ─── Board Labels ────────────────────────────────────────────

export const loadBoardLabels = async () => {
  try {
    if (isSupabaseConfigured()) {
      const val = await supabaseGetKV('board_labels');
      if (val) return typeof val === 'string' ? JSON.parse(val) : val;
    }
    return localGet('tc-board-labels-v1') || DEFAULT_BOARD_LABELS;
  } catch {
    return DEFAULT_BOARD_LABELS;
  }
};

export const saveBoardLabels = async (labels) => {
  try {
    if (isSupabaseConfigured()) {
      await supabaseSetKV('board_labels', labels);
    }
    localSet('tc-board-labels-v1', labels);
  } catch (e) {
    console.error('saveBoardLabels failed:', e);
  }
};

// ─── Checklist Templates ────────────────────────────────────

export const loadChecklistTemplates = async () => {
  try {
    if (isSupabaseConfigured()) {
      const val = await supabaseGetKV('checklist_templates');
      if (val) return typeof val === 'string' ? JSON.parse(val) : val;
    }
    return localGet('tc-checklist-templates-v1') || [];
  } catch {
    return [];
  }
};

export const saveChecklistTemplates = async (templates) => {
  try {
    if (isSupabaseConfigured()) {
      await supabaseSetKV('checklist_templates', templates);
    }
    localSet('tc-checklist-templates-v1', templates);
  } catch (e) {
    console.error('saveChecklistTemplates failed:', e);
  }
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
  } catch (e) {
    console.error('saveOrientationData failed:', e);
  }
};

// ─── Auth ────────────────────────────────────────────────────
// Legacy auth functions removed in v4.4 — authentication is now
// handled by Supabase Auth (magic link) in AuthGate.jsx.
// The legacy passcode fallback still uses localStorage directly
// within AuthGate when Supabase is not configured.

// ═══════════════════════════════════════════════════════════════
// Boards (Multiple Kanban Boards)
// ═══════════════════════════════════════════════════════════════

export const loadBoards = async () => {
  try {
    if (isSupabaseConfigured()) {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data || []).map(dbToBoard);
    }
    return localGet('tc-boards-v1') || [];
  } catch (e) {
    console.error('loadBoards failed:', e);
    return localGet('tc-boards-v1') || [];
  }
};

export const loadBoard = async (boardId) => {
  try {
    if (isSupabaseConfigured()) {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .eq('id', boardId)
        .single();
      if (error) throw error;
      return data ? dbToBoard(data) : null;
    }
    const boards = localGet('tc-boards-v1') || [];
    return boards.find((b) => b.id === boardId) || null;
  } catch (e) {
    console.error('loadBoard failed:', e);
    return null;
  }
};

export const saveBoard = async (board) => {
  try {
    if (isSupabaseConfigured()) {
      const row = boardToDb(board);
      const { error } = await supabase
        .from('boards')
        .upsert(row, { onConflict: 'id' });
      if (error) throw error;
    }
    const all = localGet('tc-boards-v1') || [];
    const idx = all.findIndex((b) => b.id === board.id);
    if (idx >= 0) all[idx] = board; else all.push(board);
    localSet('tc-boards-v1', all);
  } catch (e) {
    console.error('saveBoard failed:', e);
    throw e;
  }
};

export const deleteBoard = async (boardId) => {
  try {
    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('boards').delete().eq('id', boardId);
      if (error) throw error;
    }
    const all = localGet('tc-boards-v1') || [];
    localSet('tc-boards-v1', all.filter((b) => b.id !== boardId));
  } catch (e) {
    console.error('deleteBoard failed:', e);
    throw e;
  }
};

// ─── Board Cards ────────────────────────────────────────────

export const loadBoardCards = async (boardId) => {
  try {
    if (isSupabaseConfigured()) {
      const { data, error } = await supabase
        .from('board_cards')
        .select('*')
        .eq('board_id', boardId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data || []).map(dbToBoardCard);
    }
    const all = localGet('tc-board-cards-v1') || [];
    return all.filter((c) => c.boardId === boardId);
  } catch (e) {
    console.error('loadBoardCards failed:', e);
    return [];
  }
};

export const saveBoardCard = async (card) => {
  try {
    if (isSupabaseConfigured()) {
      const row = boardCardToDb(card);
      const { error } = await supabase
        .from('board_cards')
        .upsert(row, { onConflict: 'id' });
      if (error) throw error;
    }
    const all = localGet('tc-board-cards-v1') || [];
    const idx = all.findIndex((c) => c.id === card.id);
    if (idx >= 0) all[idx] = card; else all.push(card);
    localSet('tc-board-cards-v1', all);
  } catch (e) {
    console.error('saveBoardCard failed:', e);
    throw e;
  }
};

export const saveBoardCardsBulk = async (cards) => {
  try {
    if (isSupabaseConfigured()) {
      const rows = cards.map(boardCardToDb);
      const { error } = await supabase
        .from('board_cards')
        .upsert(rows, { onConflict: 'id' });
      if (error) throw error;
    }
    const all = localGet('tc-board-cards-v1') || [];
    const changeMap = new Map(cards.map((c) => [c.id, c]));
    const updated = all.map((c) => changeMap.get(c.id) || c);
    for (const card of cards) {
      if (!all.some((c) => c.id === card.id)) updated.push(card);
    }
    localSet('tc-board-cards-v1', updated);
  } catch (e) {
    console.error('saveBoardCardsBulk failed:', e);
    throw e;
  }
};

export const deleteBoardCard = async (cardId) => {
  try {
    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('board_cards').delete().eq('id', cardId);
      if (error) throw error;
    }
    const all = localGet('tc-board-cards-v1') || [];
    localSet('tc-board-cards-v1', all.filter((c) => c.id !== cardId));
  } catch (e) {
    console.error('deleteBoardCard failed:', e);
    throw e;
  }
};

// ─── Board Data Migration ───────────────────────────────────
// Migrates existing single-board data to the new multi-board tables.
// Creates a default "Caregiver Board" from existing KV columns/labels
// and copies board_* fields from caregivers into board_cards.
export const migrateToMultiBoard = async (existingCaregivers) => {
  // Load existing board config from KV / localStorage
  const existingColumns = await loadBoardColumns();
  const existingLabels = await loadBoardLabels();
  const existingTemplates = await loadChecklistTemplates();
  const existingOrientation = await loadOrientationData();

  const boardId = crypto.randomUUID();
  const board = {
    id: boardId,
    name: 'Caregiver Board',
    slug: 'caregiver-board',
    description: 'Manage deployed caregivers — drag cards between columns',
    entityType: 'caregiver',
    columns: existingColumns,
    labels: existingLabels,
    checklistTemplates: existingTemplates,
    orientationData: existingOrientation,
    sortOrder: 0,
    createdAt: new Date().toISOString(),
  };

  await saveBoard(board);

  // Migrate caregiver board cards
  const cards = existingCaregivers
    .filter((cg) => cg.boardStatus)
    .map((cg) => ({
      id: crypto.randomUUID(),
      boardId: boardId,
      entityType: 'caregiver',
      entityId: cg.id,
      columnId: cg.boardStatus,
      sortOrder: 0,
      labels: cg.boardLabels || [],
      checklists: cg.boardChecklists || [],
      dueDate: cg.boardDueDate || null,
      description: cg.boardDescription || null,
      pinnedNote: cg.boardNote || null,
      movedAt: cg.boardMovedAt ? new Date(cg.boardMovedAt).toISOString() : null,
      createdAt: new Date().toISOString(),
    }));

  if (cards.length > 0) {
    await saveBoardCardsBulk(cards);
  }

  return board;
};

// ═══════════════════════════════════════════════════════════════
// DB ↔ App Field Mapping
// ═══════════════════════════════════════════════════════════════

// Supabase uses snake_case, our app uses camelCase.
// These mappers handle the translation.

export const dbToCaregiver = (row) => ({
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
  allergies: row.allergies,
  clientGenderPreference: row.client_gender_preference,
  initialNotes: row.initial_notes,
  tasks: row.tasks || {},
  notes: row.notes || [],
  phaseTimestamps: row.phase_timestamps || {},
  phaseOverride: row.phase_override,
  boardStatus: row.board_status,
  boardNote: row.board_note,
  boardMovedAt: row.board_moved_at,
  boardLabels: row.board_labels || [],
  boardChecklists: row.board_checklists || [],
  boardDueDate: row.board_due_date || null,
  boardDescription: row.board_description || null,
  archived: row.archived || false,
  archivedAt: row.archived_at,
  archiveReason: row.archive_reason,
  archiveDetail: row.archive_detail,
  archivePhase: row.archive_phase,
  archivedBy: row.archived_by,
  employmentStatus: row.employment_status || null,
  employmentStatusChangedAt: row.employment_status_changed_at,
  employmentStatusChangedBy: row.employment_status_changed_by,
  availabilityType: row.availability_type || '',
  currentAssignment: row.current_assignment || '',
  cprExpiryDate: row.cpr_expiry_date,
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
  has_hca: cg.hasHCA || null,
  has_dl: cg.hasDL || null,
  source: cg.source || '',
  source_detail: cg.sourceDetail || '',
  application_date: cg.applicationDate || null,
  availability: cg.availability || '',
  years_experience: cg.yearsExperience || '',
  languages: cg.languages || '',
  specializations: cg.specializations || '',
  certifications: cg.certifications || '',
  preferred_shift: cg.preferredShift || '',
  allergies: cg.allergies || null,
  client_gender_preference: cg.clientGenderPreference || null,
  initial_notes: cg.initialNotes || '',
  tasks: cg.tasks || {},
  notes: cg.notes || [],
  phase_timestamps: cg.phaseTimestamps || {},
  phase_override: cg.phaseOverride || null,
  board_status: cg.boardStatus || null,
  board_note: cg.boardNote || null,
  board_moved_at: cg.boardMovedAt || null,
  board_labels: cg.boardLabels || [],
  board_checklists: cg.boardChecklists || [],
  board_due_date: cg.boardDueDate || null,
  board_description: cg.boardDescription || null,
  archived: cg.archived || false,
  archived_at: cg.archivedAt || null,
  archive_reason: cg.archiveReason || null,
  archive_detail: cg.archiveDetail || null,
  archive_phase: cg.archivePhase || null,
  archived_by: cg.archivedBy || null,
  employment_status: cg.employmentStatus || null,
  employment_status_changed_at: cg.employmentStatusChangedAt || null,
  employment_status_changed_by: cg.employmentStatusChangedBy || null,
  availability_type: cg.availabilityType || '',
  current_assignment: cg.currentAssignment || '',
  cpr_expiry_date: cg.cprExpiryDate || null,
  created_at: cg.createdAt || Date.now(),
});

// ─── Board mapping ──────────────────────────────────────────

const dbToBoard = (row) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  entityType: row.entity_type,
  columns: row.columns || [],
  labels: row.labels || [],
  checklistTemplates: row.checklist_templates || [],
  orientationData: row.orientation_data || {},
  sortOrder: row.sort_order || 0,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const boardToDb = (b) => ({
  id: b.id,
  name: b.name,
  slug: b.slug,
  description: b.description || null,
  entity_type: b.entityType || 'caregiver',
  columns: b.columns || [],
  labels: b.labels || [],
  checklist_templates: b.checklistTemplates || [],
  orientation_data: b.orientationData || {},
  sort_order: b.sortOrder || 0,
  created_by: b.createdBy || null,
  created_at: b.createdAt || new Date().toISOString(),
});

const dbToBoardCard = (row) => ({
  id: row.id,
  boardId: row.board_id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  columnId: row.column_id,
  sortOrder: row.sort_order || 0,
  labels: row.labels || [],
  checklists: row.checklists || [],
  dueDate: row.due_date || null,
  description: row.description || null,
  pinnedNote: row.pinned_note || null,
  movedAt: row.moved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const boardCardToDb = (c) => ({
  id: c.id,
  board_id: c.boardId,
  entity_type: c.entityType || 'caregiver',
  entity_id: c.entityId,
  column_id: c.columnId || null,
  sort_order: c.sortOrder || 0,
  labels: c.labels || [],
  checklists: c.checklists || [],
  due_date: c.dueDate || null,
  description: c.description || null,
  pinned_note: c.pinnedNote || null,
  moved_at: c.movedAt || null,
  created_at: c.createdAt || new Date().toISOString(),
});
