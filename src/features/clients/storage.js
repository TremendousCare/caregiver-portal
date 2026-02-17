import { supabase, isSupabaseConfigured } from '../../lib/supabase';

// ═══════════════════════════════════════════════════════════════
// Client Storage Abstraction Layer
//
// This module provides the same API regardless of backend:
// - If Supabase is configured -> reads/writes to Supabase tables
// - If not -> falls back to localStorage (single-user, dev mode)
//
// Mirrors the caregiver storage pattern exactly.
// ═══════════════════════════════════════════════════════════════

const CLIENTS_KEY = 'tc-clients-v1';

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

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

// ─── Clients ────────────────────────────────────────────────

export const loadClients = async () => {
  try {
    if (isSupabaseConfigured()) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Map snake_case DB columns to camelCase app fields
      const mapped = (data || []).map(dbToClient);
      // Cache to localStorage for offline fallback
      if (mapped.length > 0) localSet(CLIENTS_KEY, mapped);
      return mapped;
    }
    // Fallback: localStorage
    return localGet(CLIENTS_KEY) || [];
  } catch (e) {
    console.error('loadClients failed:', e);
    return localGet(CLIENTS_KEY) || [];
  }
};

// ─── Single-record save (preferred for individual edits) ────
export const saveClient = async (client) => {
  try {
    if (isSupabaseConfigured()) {
      const row = clientToDb(client);
      const { error } = await supabase
        .from('clients')
        .upsert(row, { onConflict: 'id' });
      if (error) throw error;
    }
    // Update localStorage: replace just this record in the cached array
    const all = localGet(CLIENTS_KEY) || [];
    const idx = all.findIndex((c) => c.id === client.id);
    if (idx >= 0) {
      all[idx] = client;
    } else {
      all.unshift(client);
    }
    localSet(CLIENTS_KEY, all);
  } catch (e) {
    console.error('saveClient failed:', e);
    throw e;
  }
};

// ─── Bulk save for multi-select operations ──────────────────
export const saveClientsBulk = async (clients) => {
  try {
    if (isSupabaseConfigured()) {
      const rows = clients.map(clientToDb);
      const { error } = await supabase
        .from('clients')
        .upsert(rows, { onConflict: 'id' });
      if (error) throw error;
    }
    // Update localStorage: merge changed records into cached array
    const all = localGet(CLIENTS_KEY) || [];
    const changeMap = new Map(clients.map((c) => [c.id, c]));
    const updated = all.map((c) => changeMap.get(c.id) || c);
    // Add any new records not in the cached array
    for (const cl of clients) {
      if (!all.some((c) => c.id === cl.id)) updated.unshift(cl);
    }
    localSet(CLIENTS_KEY, updated);
  } catch (e) {
    console.error('saveClientsBulk failed:', e);
    throw e;
  }
};

export const deleteClientsFromDb = async (ids) => {
  if (isSupabaseConfigured()) {
    const { error } = await supabase.from('clients').delete().in('id', ids);
    if (error) throw new Error(error.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// DB <-> App Field Mapping
// ═══════════════════════════════════════════════════════════════

// Supabase uses snake_case, our app uses camelCase.
// These mappers handle the translation.

export const dbToClient = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  email: row.email,
  address: row.address,
  city: row.city,
  state: row.state,
  zip: row.zip,
  contactName: row.contact_name,
  relationship: row.relationship,
  careRecipientName: row.care_recipient_name,
  careRecipientAge: row.care_recipient_age,
  careNeeds: row.care_needs,
  hoursNeeded: row.hours_needed,
  startDatePreference: row.start_date_preference,
  budgetRange: row.budget_range,
  insuranceInfo: row.insurance_info,
  referralSource: row.referral_source,
  referralDetail: row.referral_detail,
  phase: row.phase || 'new_lead',
  phaseTimestamps: row.phase_timestamps || {},
  tasks: row.tasks || {},
  notes: row.notes || [],
  activeSequences: row.active_sequences || [],
  lostReason: row.lost_reason,
  lostDetail: row.lost_detail,
  assignedTo: row.assigned_to,
  priority: row.priority || 'normal',
  archived: row.archived || false,
  archivedAt: row.archived_at,
  archiveReason: row.archive_reason,
  archiveDetail: row.archive_detail,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const clientToDb = (cl) => ({
  id: cl.id,
  first_name: cl.firstName || '',
  last_name: cl.lastName || '',
  phone: cl.phone || '',
  email: cl.email || '',
  address: cl.address || '',
  city: cl.city || '',
  state: cl.state || '',
  zip: cl.zip || '',
  contact_name: cl.contactName || '',
  relationship: cl.relationship || '',
  care_recipient_name: cl.careRecipientName || '',
  care_recipient_age: cl.careRecipientAge || null,
  care_needs: cl.careNeeds || '',
  hours_needed: cl.hoursNeeded || '',
  start_date_preference: cl.startDatePreference || null,
  budget_range: cl.budgetRange || '',
  insurance_info: cl.insuranceInfo || '',
  referral_source: cl.referralSource || '',
  referral_detail: cl.referralDetail || '',
  phase: cl.phase || 'new_lead',
  phase_timestamps: cl.phaseTimestamps || {},
  tasks: cl.tasks || {},
  notes: cl.notes || [],
  active_sequences: cl.activeSequences || [],
  lost_reason: cl.lostReason || null,
  lost_detail: cl.lostDetail || null,
  assigned_to: cl.assignedTo || null,
  priority: cl.priority || 'normal',
  archived: cl.archived || false,
  archived_at: cl.archivedAt || null,
  archive_reason: cl.archiveReason || null,
  archive_detail: cl.archiveDetail || null,
  created_at: cl.createdAt || Date.now(),
  updated_at: cl.updatedAt || Date.now(),
});
