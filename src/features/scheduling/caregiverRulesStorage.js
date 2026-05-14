import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import {
  planRuleClear,
  planRuleUpsert,
  previousDayString,
} from '../../lib/scheduling/caregiverRules';

// ═══════════════════════════════════════════════════════════════
// Scheduling Storage — service_plan_caregiver_rules
//
// Persistent day-of-week caregiver assignments per service plan.
// See docs/SCHEDULING_CAREGIVER_RULES.md for the full design.
//
// Defensive about pre-migration deploys
// -------------------------------------
// Vercel preview deploys hit the production Supabase instance.
// If this code ships before the migration is applied, queries
// against `service_plan_caregiver_rules` would throw and break
// the service plan view for every user. Each read swallows the
// "relation does not exist" error and logs a single warning, so
// the UI degrades to "no rules visible" instead of crashing.
// Writes from before the migration is applied are no-ops with a
// console warning so the team isn't silently losing data.
// ═══════════════════════════════════════════════════════════════

const RELATION_MISSING_CODES = new Set(['42P01', 'PGRST205', 'PGRST116']);

let warnedMissingTable = false;

function isMissingTableError(err) {
  if (!err) return false;
  if (err.code && RELATION_MISSING_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return (
    msg.includes('relation "public.service_plan_caregiver_rules" does not exist') ||
    msg.includes('service_plan_caregiver_rules" does not exist') ||
    msg.includes('Could not find the table')
  );
}

function logMissingTableOnce(operation) {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.warn(
    `[caregiverRulesStorage] ${operation}: service_plan_caregiver_rules table not found. ` +
      'Apply the 20260514000000 migration via the Deploy Database Migrations workflow to enable persistent day-of-week caregiver rules.',
  );
}

export const dbToRule = (row) => ({
  id: row.id,
  orgId: row.org_id,
  servicePlanId: row.service_plan_id,
  dayOfWeek: row.day_of_week,
  caregiverId: row.caregiver_id,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  notes: row.notes,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Shape used by pure helpers in src/lib/scheduling/caregiverRules.js
// (snake_case, matching the DB row).
export const dbToRulePlain = (row) => ({
  id: row.id,
  org_id: row.org_id,
  service_plan_id: row.service_plan_id,
  day_of_week: row.day_of_week,
  caregiver_id: row.caregiver_id,
  effective_from: row.effective_from,
  effective_to: row.effective_to,
});

/**
 * Fetch every rule for a service plan (including expired rules for
 * audit). The grid filters to "active right now" client-side via
 * `activeRulesByDayOfWeek`.
 */
export async function getRulesForServicePlan(servicePlanId) {
  if (!isSupabaseConfigured() || !servicePlanId) return [];
  try {
    const { data, error } = await supabase
      .from('service_plan_caregiver_rules')
      .select('*')
      .eq('service_plan_id', servicePlanId)
      .order('day_of_week', { ascending: true })
      .order('effective_from', { ascending: false });
    if (error) {
      if (isMissingTableError(error)) {
        logMissingTableOnce('getRulesForServicePlan');
        return [];
      }
      throw error;
    }
    return (data || []).map(dbToRule);
  } catch (err) {
    if (isMissingTableError(err)) {
      logMissingTableOnce('getRulesForServicePlan');
      return [];
    }
    throw err;
  }
}

/**
 * Fetch every active rule where this caregiver is the regular for
 * any day. Used by conflict detection and by the "remove caregiver
 * from client" cascade.
 */
export async function getActiveRulesForCaregiver(caregiverId, { asOf } = {}) {
  if (!isSupabaseConfigured() || !caregiverId) return [];
  const asOfDate = asOf || new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from('service_plan_caregiver_rules')
      .select('*')
      .eq('caregiver_id', caregiverId)
      .lte('effective_from', asOfDate)
      .or(`effective_to.is.null,effective_to.gte.${asOfDate}`);
    if (error) {
      if (isMissingTableError(error)) {
        logMissingTableOnce('getActiveRulesForCaregiver');
        return [];
      }
      throw error;
    }
    return (data || []).map(dbToRule);
  } catch (err) {
    if (isMissingTableError(err)) {
      logMissingTableOnce('getActiveRulesForCaregiver');
      return [];
    }
    throw err;
  }
}

/**
 * Fetch every active rule for any service plan owned by `clientId`
 * where `caregiverId` is the regular. Joins via service_plans so the
 * cascade can find all rules linked to one client→caregiver pair.
 */
export async function getActiveRulesForClientCaregiver(
  clientId,
  caregiverId,
  { asOf } = {},
) {
  if (!isSupabaseConfigured() || !clientId || !caregiverId) return [];
  const asOfDate = asOf || new Date().toISOString().slice(0, 10);

  // First load service_plan ids for the client, then filter rules.
  // Two-step keeps the query simple and works without server-side
  // joins / RPCs.
  try {
    const { data: plans, error: plansErr } = await supabase
      .from('service_plans')
      .select('id')
      .eq('client_id', clientId);
    if (plansErr) throw plansErr;
    const planIds = (plans || []).map((p) => p.id);
    if (planIds.length === 0) return [];

    const { data, error } = await supabase
      .from('service_plan_caregiver_rules')
      .select('*')
      .in('service_plan_id', planIds)
      .eq('caregiver_id', caregiverId)
      .lte('effective_from', asOfDate)
      .or(`effective_to.is.null,effective_to.gte.${asOfDate}`);
    if (error) {
      if (isMissingTableError(error)) {
        logMissingTableOnce('getActiveRulesForClientCaregiver');
        return [];
      }
      throw error;
    }
    return (data || []).map(dbToRule);
  } catch (err) {
    if (isMissingTableError(err)) {
      logMissingTableOnce('getActiveRulesForClientCaregiver');
      return [];
    }
    throw err;
  }
}

async function insertRuleRow(row) {
  const { data, error } = await supabase
    .from('service_plan_caregiver_rules')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function expireRuleRow(id, effectiveTo) {
  const { error } = await supabase
    .from('service_plan_caregiver_rules')
    .update({ effective_to: effectiveTo })
    .eq('id', id);
  if (error) throw error;
}

/**
 * High-level write: install `caregiverId` as the regular caregiver
 * for (plan, dayOfWeek) starting `effectiveFrom`. Closes any
 * currently-active rule for that pair (sets its effective_to to the
 * day before). Returns the new rule.
 *
 * No-op when the active rule already points to this caregiver.
 *
 * Pulls the fresh rule set before computing the plan, so concurrent
 * edits on different (plan, dow) pairs don't trip each other.
 */
export async function setRegularCaregiverForDay({
  servicePlanId,
  orgId,
  dayOfWeek,
  caregiverId,
  effectiveFrom,
  createdBy,
  notes,
}) {
  if (!isSupabaseConfigured()) return null;
  if (!servicePlanId || !orgId || !caregiverId) {
    throw new Error('setRegularCaregiverForDay: missing required field');
  }
  const today = effectiveFrom || new Date().toISOString().slice(0, 10);

  try {
    const existing = await getRulesForServicePlan(servicePlanId);
    const plan = planRuleUpsert({
      rules: existing.map((r) => ({
        id: r.id,
        day_of_week: r.dayOfWeek,
        caregiver_id: r.caregiverId,
        effective_from: r.effectiveFrom,
        effective_to: r.effectiveTo,
      })),
      servicePlanId,
      orgId,
      dayOfWeek,
      caregiverId,
      effectiveFrom: today,
      createdBy,
      notes,
    });

    if (plan.noop) {
      const active = existing.find(
        (r) =>
          r.dayOfWeek === dayOfWeek &&
          r.caregiverId === caregiverId &&
          r.effectiveFrom <= today &&
          (!r.effectiveTo || r.effectiveTo >= today),
      );
      return active ?? null;
    }

    for (const exp of plan.toExpire) {
      await expireRuleRow(exp.id, exp.effective_to);
    }

    if (plan.toInsert) {
      const inserted = await insertRuleRow(plan.toInsert);
      return dbToRule(inserted);
    }
    return null;
  } catch (err) {
    if (isMissingTableError(err)) {
      logMissingTableOnce('setRegularCaregiverForDay');
      return null;
    }
    throw err;
  }
}

/**
 * High-level write: remove the regular caregiver for (plan, dayOfWeek)
 * starting `effectiveFrom`. Expires every currently-active rule for
 * that pair. No-op when there's nothing active.
 */
export async function clearRegularCaregiverForDay({
  servicePlanId,
  dayOfWeek,
  effectiveFrom,
}) {
  if (!isSupabaseConfigured()) return { expired: 0 };
  if (!servicePlanId) throw new Error('clearRegularCaregiverForDay: servicePlanId required');
  const today = effectiveFrom || new Date().toISOString().slice(0, 10);

  try {
    const existing = await getRulesForServicePlan(servicePlanId);
    const plan = planRuleClear({
      rules: existing.map((r) => ({
        id: r.id,
        day_of_week: r.dayOfWeek,
        effective_from: r.effectiveFrom,
        effective_to: r.effectiveTo,
      })),
      dayOfWeek,
      effectiveFrom: today,
    });
    for (const exp of plan.toExpire) {
      await expireRuleRow(exp.id, exp.effective_to);
    }
    return { expired: plan.toExpire.length };
  } catch (err) {
    if (isMissingTableError(err)) {
      logMissingTableOnce('clearRegularCaregiverForDay');
      return { expired: 0 };
    }
    throw err;
  }
}

/**
 * Expire every active rule on every service plan for `clientId`
 * where this caregiver is the regular. Used by the "Remove caregiver
 * from this client's schedules" cascade on the client page. Returns
 * the set of (servicePlanId, dayOfWeek) pairs that were affected, so
 * the caller can also unassign future open shifts.
 */
export async function expireAllRulesForCaregiverOnClient({
  clientId,
  caregiverId,
  effectiveFrom,
}) {
  if (!isSupabaseConfigured()) return [];
  if (!clientId || !caregiverId) {
    throw new Error('expireAllRulesForCaregiverOnClient: clientId and caregiverId required');
  }
  const today = effectiveFrom || new Date().toISOString().slice(0, 10);
  const dayBefore = previousDayString(today);

  try {
    const rules = await getActiveRulesForClientCaregiver(clientId, caregiverId, {
      asOf: today,
    });
    const affected = [];
    for (const rule of rules) {
      await expireRuleRow(rule.id, dayBefore);
      affected.push({
        servicePlanId: rule.servicePlanId,
        dayOfWeek: rule.dayOfWeek,
        ruleId: rule.id,
      });
    }
    return affected;
  } catch (err) {
    if (isMissingTableError(err)) {
      logMissingTableOnce('expireAllRulesForCaregiverOnClient');
      return [];
    }
    throw err;
  }
}

// Re-export pure helpers so callers can import everything from one place.
export {
  pickActiveRule,
  resolveCaregiverForDate,
  resolveCaregiverForInstance,
  activeRulesByDayOfWeek,
  planRuleUpsert,
  planRuleClear,
  previousDayString,
} from '../../lib/scheduling/caregiverRules';
