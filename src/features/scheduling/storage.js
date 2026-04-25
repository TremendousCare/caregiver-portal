import { supabase, isSupabaseConfigured } from '../../lib/supabase';

// ═══════════════════════════════════════════════════════════════
// Scheduling Storage Layer
//
// Thin wrappers around Supabase for the 5 scheduling tables created
// in Phase 1. No localStorage fallback — scheduling is inherently
// multi-user and realtime, so offline doesn't make sense here. If
// Supabase is not configured (unit tests, dev without creds), all
// functions resolve to empty/noop values so callers can render.
//
// All mappers handle DB ↔ app case conversion (snake_case ↔ camelCase)
// to match the existing pattern in src/features/clients/storage.js
// and src/lib/storage.js.
//
// Tables:
//   service_plans, shifts, caregiver_availability,
//   caregiver_assignments, shift_offers
// ═══════════════════════════════════════════════════════════════


// ─── service_plans ────────────────────────────────────────────────

export const dbToServicePlan = (row) => ({
  id: row.id,
  clientId: row.client_id,
  title: row.title,
  serviceType: row.service_type,
  hoursPerWeek: row.hours_per_week != null ? Number(row.hours_per_week) : null,
  preferredTimes: row.preferred_times || {},
  recurrencePattern: row.recurrence_pattern || null,
  startDate: row.start_date,
  endDate: row.end_date,
  status: row.status || 'draft',
  notes: row.notes,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const servicePlanToDb = (plan) => ({
  id: plan.id,
  client_id: plan.clientId,
  title: plan.title ?? null,
  service_type: plan.serviceType ?? null,
  hours_per_week: plan.hoursPerWeek ?? null,
  preferred_times: plan.preferredTimes ?? {},
  recurrence_pattern: plan.recurrencePattern ?? null,
  start_date: plan.startDate ?? null,
  end_date: plan.endDate ?? null,
  status: plan.status ?? 'draft',
  notes: plan.notes ?? null,
  created_by: plan.createdBy ?? null,
  updated_at: new Date().toISOString(),
});

export const createServicePlan = async (plan) => {
  if (!isSupabaseConfigured()) return null;
  const row = servicePlanToDb(plan);
  delete row.id; // let Postgres generate
  const { data, error } = await supabase
    .from('service_plans')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return dbToServicePlan(data);
};

/**
 * Build a partial-update row for service_plans that only includes the
 * fields present in `patch`. Prevents accidental column wipes when
 * callers pass a small patch like `{ status: 'paused' }` — which
 * would otherwise clobber title, notes, dates, etc. via the full
 * servicePlanToDb mapper.
 *
 * Exported for unit testing.
 */
export const buildServicePlanPatchRow = (patch) => {
  const row = {};
  if (!patch || typeof patch !== 'object') return row;
  if ('clientId' in patch) row.client_id = patch.clientId;
  if ('title' in patch) row.title = patch.title;
  if ('serviceType' in patch) row.service_type = patch.serviceType;
  if ('hoursPerWeek' in patch) row.hours_per_week = patch.hoursPerWeek;
  if ('preferredTimes' in patch) row.preferred_times = patch.preferredTimes;
  if ('recurrencePattern' in patch) row.recurrence_pattern = patch.recurrencePattern;
  if ('startDate' in patch) row.start_date = patch.startDate;
  if ('endDate' in patch) row.end_date = patch.endDate;
  if ('status' in patch) row.status = patch.status;
  if ('notes' in patch) row.notes = patch.notes;
  if ('createdBy' in patch) row.created_by = patch.createdBy;
  row.updated_at = new Date().toISOString();
  return row;
};

export const updateServicePlan = async (id, patch) => {
  if (!isSupabaseConfigured()) return null;
  const row = buildServicePlanPatchRow(patch);
  const { data, error } = await supabase
    .from('service_plans')
    .update(row)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return dbToServicePlan(data);
};

export const getServicePlansForClient = async (clientId) => {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await supabase
    .from('service_plans')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(dbToServicePlan);
};


// ─── shifts ────────────────────────────────────────────────────

export const dbToShift = (row) => ({
  id: row.id,
  servicePlanId: row.service_plan_id,
  clientId: row.client_id,
  assignedCaregiverId: row.assigned_caregiver_id,
  startTime: row.start_time,
  endTime: row.end_time,
  status: row.status || 'open',
  recurrenceGroupId: row.recurrence_group_id,
  recurrenceRule: row.recurrence_rule,
  locationAddress: row.location_address,
  hourlyRate: row.hourly_rate != null ? Number(row.hourly_rate) : null,
  billableRate: row.billable_rate != null ? Number(row.billable_rate) : null,
  mileage: row.mileage != null ? Number(row.mileage) : null,
  requiredSkills: row.required_skills || [],
  instructions: row.instructions,
  notes: row.notes,
  cancelReason: row.cancel_reason,
  cancelledAt: row.cancelled_at,
  cancelledBy: row.cancelled_by,
  noShowNote: row.no_show_note,
  markedNoShowAt: row.marked_no_show_at,
  markedNoShowBy: row.marked_no_show_by,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const shiftToDb = (shift) => ({
  id: shift.id,
  service_plan_id: shift.servicePlanId ?? null,
  client_id: shift.clientId,
  assigned_caregiver_id: shift.assignedCaregiverId ?? null,
  start_time: shift.startTime,
  end_time: shift.endTime,
  status: shift.status ?? 'open',
  recurrence_group_id: shift.recurrenceGroupId ?? null,
  recurrence_rule: shift.recurrenceRule ?? null,
  location_address: shift.locationAddress ?? null,
  hourly_rate: shift.hourlyRate ?? null,
  billable_rate: shift.billableRate ?? null,
  mileage: shift.mileage ?? null,
  required_skills: shift.requiredSkills ?? [],
  instructions: shift.instructions ?? null,
  notes: shift.notes ?? null,
  cancel_reason: shift.cancelReason ?? null,
  cancelled_at: shift.cancelledAt ?? null,
  cancelled_by: shift.cancelledBy ?? null,
  no_show_note: shift.noShowNote ?? null,
  marked_no_show_at: shift.markedNoShowAt ?? null,
  marked_no_show_by: shift.markedNoShowBy ?? null,
  created_by: shift.createdBy ?? null,
  updated_at: new Date().toISOString(),
});

export const createShift = async (shift) => {
  if (!isSupabaseConfigured()) return null;
  const row = shiftToDb(shift);
  delete row.id;
  const { data, error } = await supabase
    .from('shifts')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return dbToShift(data);
};

export const updateShift = async (id, patch) => {
  if (!isSupabaseConfigured()) return null;
  // Only map fields present in the patch so we don't clobber columns
  const row = {};
  if ('servicePlanId' in patch) row.service_plan_id = patch.servicePlanId;
  if ('clientId' in patch) row.client_id = patch.clientId;
  if ('assignedCaregiverId' in patch) row.assigned_caregiver_id = patch.assignedCaregiverId;
  if ('startTime' in patch) row.start_time = patch.startTime;
  if ('endTime' in patch) row.end_time = patch.endTime;
  if ('status' in patch) row.status = patch.status;
  if ('locationAddress' in patch) row.location_address = patch.locationAddress;
  if ('hourlyRate' in patch) row.hourly_rate = patch.hourlyRate;
  if ('billableRate' in patch) row.billable_rate = patch.billableRate;
  if ('mileage' in patch) row.mileage = patch.mileage;
  if ('requiredSkills' in patch) row.required_skills = patch.requiredSkills;
  if ('instructions' in patch) row.instructions = patch.instructions;
  if ('notes' in patch) row.notes = patch.notes;
  if ('cancelReason' in patch) row.cancel_reason = patch.cancelReason;
  if ('cancelledAt' in patch) row.cancelled_at = patch.cancelledAt;
  if ('cancelledBy' in patch) row.cancelled_by = patch.cancelledBy;
  if ('noShowNote' in patch) row.no_show_note = patch.noShowNote;
  if ('markedNoShowAt' in patch) row.marked_no_show_at = patch.markedNoShowAt;
  if ('markedNoShowBy' in patch) row.marked_no_show_by = patch.markedNoShowBy;
  row.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('shifts')
    .update(row)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return dbToShift(data);
};

export const cancelShift = async (id, { reason, cancelledBy }) => {
  return updateShift(id, {
    status: 'cancelled',
    cancelReason: reason ?? null,
    cancelledAt: new Date().toISOString(),
    cancelledBy: cancelledBy ?? null,
  });
};

/**
 * Mark a shift as a no-show. Used when the scheduled start time has
 * passed and the assigned caregiver never clocked in. The note is
 * free-form (no dropdown) since reasons vary widely — the office
 * usually has spoken to someone by the time they're filling this in.
 *
 * Eligibility (status in [assigned, confirmed] and start time has
 * passed) is enforced in the UI via canMarkShiftNoShow(). The storage
 * layer does not re-check; if a caller bypasses the guard, the
 * status update will still succeed because 'no_show' is a valid
 * shifts.status value.
 */
export const markShiftNoShow = async (id, { note, markedBy }) => {
  return updateShift(id, {
    status: 'no_show',
    noShowNote: note ?? null,
    markedNoShowAt: new Date().toISOString(),
    markedNoShowBy: markedBy ?? null,
  });
};

/**
 * Apply calendar-window filters to a shifts query so the result contains
 * every shift that OVERLAPS the window, not just those that start inside it.
 *
 * A shift overlaps [startDate, endDate] when:
 *   shift.start_time <= endDate  AND  shift.end_time >= startDate
 *
 * The previous version filtered both bounds against start_time, which
 * silently dropped overnight shifts that began before startDate but ended
 * inside the window. Exported for unit testing; callers should prefer
 * getShifts().
 */
export const applyShiftWindowFilters = (query, filters = {}) => {
  let q = query;
  if (filters.startDate) q = q.gte('end_time', filters.startDate);
  if (filters.endDate) q = q.lte('start_time', filters.endDate);
  return q;
};

export const getShifts = async (filters = {}) => {
  if (!isSupabaseConfigured()) return [];
  let query = supabase.from('shifts').select('*');

  query = applyShiftWindowFilters(query, filters);
  if (filters.clientId) query = query.eq('client_id', filters.clientId);
  if (filters.caregiverId) {
    query = query.eq('assigned_caregiver_id', filters.caregiverId);
  }
  if (filters.status) {
    if (Array.isArray(filters.status)) {
      query = query.in('status', filters.status);
    } else {
      query = query.eq('status', filters.status);
    }
  }
  if (filters.servicePlanId) query = query.eq('service_plan_id', filters.servicePlanId);

  query = query.order('start_time', { ascending: true });

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(dbToShift);
};


// ─── caregiver_availability ────────────────────────────────────

export const dbToAvailability = (row) => ({
  id: row.id,
  caregiverId: row.caregiver_id,
  type: row.type || 'available',
  dayOfWeek: row.day_of_week,
  startTime: row.start_time,
  endTime: row.end_time,
  startDate: row.start_date,
  endDate: row.end_date,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  reason: row.reason,
  notes: row.notes,
  source: row.source ?? null,
  pinned: row.pinned === true,
  sourceResponseId: row.source_response_id ?? null,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const availabilityToDb = (row) => ({
  id: row.id,
  caregiver_id: row.caregiverId,
  type: row.type ?? 'available',
  day_of_week: row.dayOfWeek ?? null,
  start_time: row.startTime ?? null,
  end_time: row.endTime ?? null,
  start_date: row.startDate ?? null,
  end_date: row.endDate ?? null,
  effective_from: row.effectiveFrom ?? null,
  effective_until: row.effectiveUntil ?? null,
  reason: row.reason ?? null,
  notes: row.notes ?? null,
  source: row.source ?? null,
  pinned: row.pinned === true,
  source_response_id: row.sourceResponseId ?? null,
  created_by: row.createdBy ?? null,
  updated_at: new Date().toISOString(),
});

export const addAvailability = async (row) => {
  if (!isSupabaseConfigured()) return null;
  const dbRow = availabilityToDb(row);
  delete dbRow.id;
  const { data, error } = await supabase
    .from('caregiver_availability')
    .insert(dbRow)
    .select()
    .single();
  if (error) throw error;
  return dbToAvailability(data);
};

/**
 * Partial update for a caregiver_availability row. Only writes fields
 * present in the patch so a single-field toggle (e.g. `{ pinned: true }`)
 * doesn't clobber start_time / day_of_week / etc.
 */
export const updateAvailability = async (id, patch) => {
  if (!isSupabaseConfigured()) return null;
  const row = {};
  if ('type' in patch) row.type = patch.type;
  if ('dayOfWeek' in patch) row.day_of_week = patch.dayOfWeek;
  if ('startTime' in patch) row.start_time = patch.startTime;
  if ('endTime' in patch) row.end_time = patch.endTime;
  if ('startDate' in patch) row.start_date = patch.startDate;
  if ('endDate' in patch) row.end_date = patch.endDate;
  if ('reason' in patch) row.reason = patch.reason;
  if ('notes' in patch) row.notes = patch.notes;
  if ('source' in patch) row.source = patch.source;
  if ('pinned' in patch) row.pinned = patch.pinned === true;
  if ('sourceResponseId' in patch) row.source_response_id = patch.sourceResponseId;
  row.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('caregiver_availability')
    .update(row)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return dbToAvailability(data);
};

export const removeAvailability = async (id) => {
  if (!isSupabaseConfigured()) return false;
  const { error } = await supabase
    .from('caregiver_availability')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return true;
};

export const getAvailability = async (caregiverId) => {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await supabase
    .from('caregiver_availability')
    .select('*')
    .eq('caregiver_id', caregiverId);
  if (error) throw error;
  return (data || []).map(dbToAvailability);
};

/**
 * Bulk-fetch availability rows for many caregivers in a single query.
 * Used by the Phase 4c caregiver picker to rank eligibility without
 * issuing one query per caregiver.
 */
export const getAvailabilityForCaregivers = async (caregiverIds) => {
  if (!isSupabaseConfigured()) return [];
  if (!Array.isArray(caregiverIds) || caregiverIds.length === 0) return [];
  const { data, error } = await supabase
    .from('caregiver_availability')
    .select('*')
    .in('caregiver_id', caregiverIds);
  if (error) throw error;
  return (data || []).map(dbToAvailability);
};

/**
 * Bulk-fetch shifts assigned to any of the given caregivers within a
 * date window. Used by the caregiver picker to check conflicts and
 * compute hours-this-week without N+1 queries.
 */
export const getShiftsForCaregivers = async ({ caregiverIds, startDate, endDate }) => {
  if (!isSupabaseConfigured()) return [];
  if (!Array.isArray(caregiverIds) || caregiverIds.length === 0) return [];
  let query = supabase
    .from('shifts')
    .select('*')
    .in('assigned_caregiver_id', caregiverIds);
  if (startDate) query = query.gte('start_time', startDate);
  if (endDate) query = query.lte('start_time', endDate);
  const { data, error } = await query.order('start_time', { ascending: true });
  if (error) throw error;
  return (data || []).map(dbToShift);
};


// ─── caregiver_assignments ─────────────────────────────────────

export const dbToAssignment = (row) => ({
  id: row.id,
  caregiverId: row.caregiver_id,
  clientId: row.client_id,
  servicePlanId: row.service_plan_id,
  role: row.role || 'primary',
  status: row.status || 'active',
  startedAt: row.started_at,
  endedAt: row.ended_at,
  endReason: row.end_reason,
  notes: row.notes,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const assignmentToDb = (assignment) => ({
  id: assignment.id,
  caregiver_id: assignment.caregiverId,
  client_id: assignment.clientId,
  service_plan_id: assignment.servicePlanId ?? null,
  role: assignment.role ?? 'primary',
  status: assignment.status ?? 'active',
  started_at: assignment.startedAt ?? new Date().toISOString(),
  ended_at: assignment.endedAt ?? null,
  end_reason: assignment.endReason ?? null,
  notes: assignment.notes ?? null,
  created_by: assignment.createdBy ?? null,
  updated_at: new Date().toISOString(),
});

export const createAssignment = async (assignment) => {
  if (!isSupabaseConfigured()) return null;
  const row = assignmentToDb(assignment);
  delete row.id;
  const { data, error } = await supabase
    .from('caregiver_assignments')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return dbToAssignment(data);
};

export const endAssignment = async (id, endReason) => {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await supabase
    .from('caregiver_assignments')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      end_reason: endReason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return dbToAssignment(data);
};

export const getAssignmentsForCaregiver = async (caregiverId, { activeOnly = true } = {}) => {
  if (!isSupabaseConfigured()) return [];
  let query = supabase
    .from('caregiver_assignments')
    .select('*')
    .eq('caregiver_id', caregiverId);
  if (activeOnly) query = query.eq('status', 'active');
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(dbToAssignment);
};

export const getAssignmentsForClient = async (clientId, { activeOnly = true } = {}) => {
  if (!isSupabaseConfigured()) return [];
  let query = supabase
    .from('caregiver_assignments')
    .select('*')
    .eq('client_id', clientId);
  if (activeOnly) query = query.eq('status', 'active');
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(dbToAssignment);
};


// ─── shift_offers ──────────────────────────────────────────────
// Tracks every broadcast SMS sent to a caregiver about an open shift.
// Created and updated in the Phase 5 broadcast workflow. Unused until
// now — Phase 1 created the table and we're finally populating it.

export const dbToShiftOffer = (row) => ({
  id: row.id,
  shiftId: row.shift_id,
  caregiverId: row.caregiver_id,
  status: row.status || 'sent',
  sentAt: row.sent_at,
  respondedAt: row.responded_at,
  responseText: row.response_text,
  messageSid: row.message_sid,
  expiresAt: row.expires_at,
  notes: row.notes,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const shiftOfferToDb = (offer) => ({
  id: offer.id,
  shift_id: offer.shiftId,
  caregiver_id: offer.caregiverId,
  status: offer.status ?? 'sent',
  sent_at: offer.sentAt ?? new Date().toISOString(),
  responded_at: offer.respondedAt ?? null,
  response_text: offer.responseText ?? null,
  message_sid: offer.messageSid ?? null,
  expires_at: offer.expiresAt ?? null,
  notes: offer.notes ?? null,
  created_by: offer.createdBy ?? null,
  updated_at: new Date().toISOString(),
});

/**
 * Insert many shift_offer rows in a single request. Used by the
 * broadcast modal to record who the shift was offered to. Returns
 * the inserted rows (with generated ids and timestamps).
 */
export const createShiftOffers = async (offers) => {
  if (!isSupabaseConfigured()) return [];
  if (!Array.isArray(offers) || offers.length === 0) return [];
  const rows = offers.map((offer) => {
    const row = shiftOfferToDb(offer);
    delete row.id;
    return row;
  });
  const { data, error } = await supabase
    .from('shift_offers')
    .insert(rows)
    .select();
  if (error) throw error;
  return (data || []).map(dbToShiftOffer);
};

/**
 * Fetch all offer rows for a given shift. Used by the ShiftDrawer
 * to display "Offered to X · Y accepted · Z declined" tracking.
 */
export const getShiftOffersForShift = async (shiftId) => {
  if (!isSupabaseConfigured()) return [];
  if (!shiftId) return [];
  const { data, error } = await supabase
    .from('shift_offers')
    .select('*')
    .eq('shift_id', shiftId)
    .order('sent_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(dbToShiftOffer);
};

/**
 * Partial update for a shift_offer row. Follows the same pattern as
 * buildServicePlanPatchRow / updateShift — only fields explicitly
 * present in the patch are written, so status-only updates don't
 * clobber response_text or sent_at.
 */
export const updateShiftOffer = async (id, patch) => {
  if (!isSupabaseConfigured()) return null;
  const row = {};
  if ('status' in patch) row.status = patch.status;
  if ('respondedAt' in patch) row.responded_at = patch.respondedAt;
  if ('responseText' in patch) row.response_text = patch.responseText;
  if ('messageSid' in patch) row.message_sid = patch.messageSid;
  if ('expiresAt' in patch) row.expires_at = patch.expiresAt;
  if ('notes' in patch) row.notes = patch.notes;
  row.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('shift_offers')
    .update(row)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return dbToShiftOffer(data);
};


// ─── scheduling templates (Phase 5c) ───────────────────────────
// Team-wide SMS templates stored in app_data so the admin can tweak
// the wording once and have every scheduler see the new default.
// Falls back to the hardcoded default constants when no row exists.
//
// Keys:
//   'scheduling_broadcast_template'
//   'scheduling_confirmation_template'

/**
 * Read a template string from app_data. Returns `fallback` if
 * Supabase isn't configured or the key isn't set yet.
 */
export const getSchedulingTemplate = async (key, fallback = '') => {
  if (!isSupabaseConfigured()) return fallback;
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.value == null) return fallback;
    const value = data.value;
    // The value is stored as JSONB — could be a plain string or an object.
    // For templates we always store a plain string.
    if (typeof value === 'string') return value;
    return fallback;
  } catch (e) {
    console.warn(`getSchedulingTemplate(${key}) failed:`, e);
    return fallback;
  }
};

/**
 * Write a template string to app_data, upserting on the key.
 */
export const setSchedulingTemplate = async (key, value) => {
  if (!isSupabaseConfigured()) return false;
  try {
    const { error } = await supabase
      .from('app_data')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error(`setSchedulingTemplate(${key}) failed:`, e);
    throw e;
  }
};


// ─── clock_events ─────────────────────────────────────────────────
// Append-only audit log of caregiver clock-in / clock-out events.
// Auto-recorded rows (source='caregiver_app') come from the
// caregiver-clock edge function. Manual rows (source='manual_entry')
// come from office staff fixing a forgotten or incorrect punch from
// the ShiftDrawer.
//
// Edits never overwrite original_occurred_at after the first edit, so
// we always preserve the very first timestamp the row had — usually
// the auto-recorded time, but for manual rows whatever the office
// staff first entered.

export const dbToClockEvent = (row) => ({
  id: row.id,
  shiftId: row.shift_id,
  caregiverId: row.caregiver_id,
  eventType: row.event_type,
  occurredAt: row.occurred_at,
  latitude: row.latitude != null ? Number(row.latitude) : null,
  longitude: row.longitude != null ? Number(row.longitude) : null,
  accuracyM: row.accuracy_m != null ? Number(row.accuracy_m) : null,
  distanceFromClientM:
    row.distance_from_client_m != null ? Number(row.distance_from_client_m) : null,
  geofencePassed: row.geofence_passed,
  overrideReason: row.override_reason,
  source: row.source || 'caregiver_app',
  editedAt: row.edited_at,
  editedBy: row.edited_by,
  editReason: row.edit_reason,
  originalOccurredAt: row.original_occurred_at,
  createdAt: row.created_at,
});

/**
 * Load clock events for a shift, optionally scoped to a caregiver.
 *
 * Scoping by caregiverId matters because clock_events keeps history
 * keyed on (shift_id, caregiver_id): if a shift is reassigned, the
 * previous caregiver's punches stay in the table. The drawer panel
 * always passes the currently-assigned caregiver so the timeline only
 * shows that caregiver's events — mixing multiple caregivers'
 * punches into one summary would produce wrong actual start/end and
 * expose the wrong rows to edit/delete.
 */
export const getClockEventsForShift = async (shiftId, { caregiverId } = {}) => {
  if (!isSupabaseConfigured() || !shiftId) return [];
  let query = supabase
    .from('clock_events')
    .select('*')
    .eq('shift_id', shiftId);
  if (caregiverId) query = query.eq('caregiver_id', caregiverId);
  const { data, error } = await query.order('occurred_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(dbToClockEvent);
};

/**
 * Office-staff manual insert for a forgotten clock punch.
 *
 * GPS / geofence fields are NULL by design — there is no location to
 * evaluate after the fact. The `source='manual_entry'` flag plus
 * `edited_by` (set to the inserting staff member) make it obvious in
 * the UI that this row was not auto-recorded.
 */
export const insertManualClockEvent = async ({
  shiftId,
  caregiverId,
  eventType,
  occurredAt,
  editedBy,
  editReason,
}) => {
  if (!isSupabaseConfigured()) return null;
  if (!shiftId || !caregiverId || !eventType || !occurredAt) {
    throw new Error('Missing required fields for manual clock event.');
  }
  if (eventType !== 'in' && eventType !== 'out') {
    throw new Error('eventType must be "in" or "out".');
  }
  const { data, error } = await supabase
    .from('clock_events')
    .insert({
      shift_id: shiftId,
      caregiver_id: caregiverId,
      event_type: eventType,
      occurred_at: occurredAt,
      source: 'manual_entry',
      edited_by: editedBy ?? null,
      edit_reason: editReason ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return dbToClockEvent(data);
};

/**
 * Office-staff edit of a clock event's time. Preserves the original
 * timestamp on the first edit (subsequent edits leave
 * original_occurred_at untouched, so we always know the very first
 * value the row ever had).
 *
 * `editReason` is required by the UI but enforced here too as a
 * defense-in-depth check.
 */
export const updateClockEventTime = async (
  id,
  { occurredAt, editedBy, editReason },
) => {
  if (!isSupabaseConfigured()) return null;
  if (!id || !occurredAt) {
    throw new Error('Missing id or occurredAt for clock event edit.');
  }
  if (!editReason || !editReason.trim()) {
    throw new Error('A reason is required to edit a clock event.');
  }

  const { data: existing, error: readErr } = await supabase
    .from('clock_events')
    .select('occurred_at, original_occurred_at')
    .eq('id', id)
    .single();
  if (readErr) throw readErr;

  const patch = {
    occurred_at: occurredAt,
    edited_at: new Date().toISOString(),
    edited_by: editedBy ?? null,
    edit_reason: editReason.trim(),
  };
  if (!existing.original_occurred_at) {
    patch.original_occurred_at = existing.occurred_at;
  }

  const { data, error } = await supabase
    .from('clock_events')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return dbToClockEvent(data);
};

/**
 * Office-staff delete. Only manual_entry rows can be removed — an
 * auto-recorded caregiver punch is always preserved (edit it instead).
 */
export const deleteManualClockEvent = async (id) => {
  if (!isSupabaseConfigured()) return false;
  if (!id) throw new Error('Missing clock event id.');
  const { error } = await supabase
    .from('clock_events')
    .delete()
    .eq('id', id)
    .eq('source', 'manual_entry');
  if (error) throw error;
  return true;
};
