// Save / load helpers for client_emergency_contacts and
// client_responsible_parties (migration 20260523010000).
//
// These promote two pieces of intake data from care_plan_versions.data
// JSONB to first-class tables so the AddClient intake form can capture
// them without forcing the office to build a care plan first. See the
// migration header for the full rationale.
//
// Design notes:
//   • All writes go through Supabase with RLS — no service-role here.
//     The new tables' policies require is_staff() + JWT org_id match.
//   • Each "save" is replace-then-insert per client (intake creates
//     the client fresh; edits later replace whole sets). This keeps
//     the priority ordering coherent and avoids partial-row drift.
//   • Empty inputs are no-ops, not errors. AddClient may submit with
//     zero contacts and zero RPs — that should silently succeed so
//     the client row is still created.
//   • All exported functions accept a Supabase client argument so
//     tests can pass a mock without touching the real module.

import { supabase as defaultClient } from './supabase';

// ─── Emergency Contacts ──────────────────────────────────────

/**
 * Coerce a UI-shape emergency contact into the DB row shape.
 * Drops blank rows so the office can leave optional rows empty.
 * Returns null if there's nothing meaningful to save.
 */
function normalizeEmergencyContact(input, clientId, priority) {
  if (!input) return null;
  const name = (input.name ?? '').trim();
  const phone = (input.phone ?? '').trim();
  // name + phone are NOT NULL on the table; a row missing either is
  // an empty slot, not data.
  if (!name || !phone) return null;
  return {
    client_id: clientId,
    priority,
    name,
    relationship: emptyToNull(input.relationship),
    phone,
    alt_phone: emptyToNull(input.altPhone),
    email: emptyToNull(input.email),
    notes: emptyToNull(input.notes),
  };
}

/**
 * Persist the full set of emergency contacts for a client.
 * Caller passes an ordered array; the array index becomes `priority`
 * (1-based) so the call order in the UI matches the DB.
 *
 * Returns { saved: number, error: Error | null }. Never throws.
 */
export async function saveEmergencyContacts(clientId, contacts, client = defaultClient) {
  if (!client || !clientId) return { saved: 0, error: null };

  // Normalize first (priorities reassigned below after filtering), then
  // drop empty slots, then compact priorities. If the office fills
  // contacts [#1, blank, #3], the saved rows should be priority 1 + 2,
  // not 1 + 3 — gaps in the call-order sequence are meaningless.
  const rows = (contacts ?? [])
    .map((c) => normalizeEmergencyContact(c, clientId, 0))
    .filter(Boolean)
    .map((row, i) => ({ ...row, priority: i + 1 }));

  // Replace-then-insert: blow away whatever was there for this
  // client, then bulk-insert the new set. Safe because the table is
  // tiny per client (typical: 1–4 rows) and we control the writer.
  const { error: delErr } = await client
    .from('client_emergency_contacts')
    .delete()
    .eq('client_id', clientId);
  if (delErr) return { saved: 0, error: delErr };

  if (rows.length === 0) return { saved: 0, error: null };

  const { error: insErr } = await client
    .from('client_emergency_contacts')
    .insert(rows);
  if (insErr) return { saved: 0, error: insErr };

  return { saved: rows.length, error: null };
}

/**
 * Load all emergency contacts for a client, ordered by priority asc.
 * Returns [] on missing client, missing supabase, or any error.
 */
export async function loadEmergencyContacts(clientId, client = defaultClient) {
  if (!client || !clientId) return [];
  const { data, error } = await client
    .from('client_emergency_contacts')
    .select('id, priority, name, relationship, phone, alt_phone, email, notes')
    .eq('client_id', clientId)
    .order('priority', { ascending: true });
  if (error) return [];
  return data ?? [];
}

// ─── Responsible Parties ─────────────────────────────────────

/**
 * Coerce a UI-shape RP into the DB row shape. Drops if name is empty
 * (the table requires it NOT NULL and an empty RP is just an empty
 * slot in the form, not data).
 */
function normalizeResponsibleParty(input, clientId, rank) {
  if (!input) return null;
  const name = (input.name ?? '').trim();
  if (!name) return null;
  return {
    client_id: clientId,
    rank,
    name,
    relationship: emptyToNull(input.relationship),
    phone: emptyToNull(input.phone),
    email: emptyToNull(input.email),
    contact_for: Array.isArray(input.contactFor) ? input.contactFor : [],
    hipaa_on_file: !!input.hipaaOnFile,
    financial_poa: !!input.financialPoa,
    healthcare_poa: !!input.healthcarePoa,
    is_main_point_of_contact: !!input.isMainPointOfContact,
    notes: emptyToNull(input.notes),
  };
}

/**
 * Persist primary + secondary RPs for a client. Accepts an object
 * shape `{ primary, secondary }` because that's how the form models
 * them; the migration's UNIQUE (client_id, rank) constraint matches.
 *
 * Enforces "at most one main point of contact" in JS before writing
 * so we don't rely on the DB index throwing — friendlier UX.
 *
 * Returns { saved: number, error: Error | null }. Never throws.
 */
export async function saveResponsibleParties(clientId, parties, client = defaultClient) {
  if (!client || !clientId) return { saved: 0, error: null };

  const primary = normalizeResponsibleParty(parties?.primary, clientId, 'primary');
  const secondary = normalizeResponsibleParty(parties?.secondary, clientId, 'secondary');

  // Defensive: if both have is_main_point_of_contact=true, keep
  // primary's flag and clear secondary's. The partial unique index
  // (uq_client_main_point_of_contact) would otherwise reject the
  // insert with a constraint violation.
  if (primary?.is_main_point_of_contact && secondary?.is_main_point_of_contact) {
    secondary.is_main_point_of_contact = false;
  }

  const rows = [primary, secondary].filter(Boolean);

  const { error: delErr } = await client
    .from('client_responsible_parties')
    .delete()
    .eq('client_id', clientId);
  if (delErr) return { saved: 0, error: delErr };

  if (rows.length === 0) return { saved: 0, error: null };

  const { error: insErr } = await client
    .from('client_responsible_parties')
    .insert(rows);
  if (insErr) return { saved: 0, error: insErr };

  return { saved: rows.length, error: null };
}

/**
 * Load RPs for a client. Returns `{ primary, secondary }` (either
 * may be null). Stable shape lets the UI bind directly.
 */
export async function loadResponsibleParties(clientId, client = defaultClient) {
  if (!client || !clientId) return { primary: null, secondary: null };
  const { data, error } = await client
    .from('client_responsible_parties')
    .select(
      'id, rank, name, relationship, phone, email, contact_for, hipaa_on_file, '
      + 'financial_poa, healthcare_poa, is_main_point_of_contact, notes'
    )
    .eq('client_id', clientId);
  if (error) return { primary: null, secondary: null };
  const byRank = Object.create(null);
  for (const row of data ?? []) byRank[row.rank] = row;
  return { primary: byRank.primary ?? null, secondary: byRank.secondary ?? null };
}

// ─── Internal ────────────────────────────────────────────────

function emptyToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
