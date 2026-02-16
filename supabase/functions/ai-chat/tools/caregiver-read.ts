// ─── Caregiver Read Tools ───
// search_caregivers, get_caregiver_detail, get_pipeline_stats, list_stale_leads, check_compliance

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import {
  getPhase,
  getLastActivity,
  buildCaregiverSummary,
  buildCaregiverProfile,
  resolveCaregiver,
} from "../helpers/caregiver.ts";

// ── search_caregivers ──

registerTool(
  {
    name: "search_caregivers",
    description:
      "Search and filter caregivers by name, phase, city, source, or other fields. Returns matching caregiver summaries.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (name, city, phone, email, etc.)" },
        phase: { type: "string", description: "Filter by pipeline phase (Lead, Phone Screen, Interview, Background Check, Onboarding, Active)" },
        city: { type: "string", description: "Filter by city" },
        source: { type: "string", description: "Filter by recruitment source" },
        include_archived: { type: "boolean", description: "Include archived caregivers (default false)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let results = [...ctx.caregivers];
    if (!input.include_archived) results = results.filter((c: any) => !c.archived);
    if (input.phase) results = results.filter((c: any) => getPhase(c).toLowerCase() === input.phase.toLowerCase());
    if (input.city) results = results.filter((c: any) => c.city?.toLowerCase().includes(input.city.toLowerCase()));
    if (input.source) results = results.filter((c: any) => c.source?.toLowerCase().includes(input.source.toLowerCase()));
    if (input.query) {
      const q = input.query.toLowerCase();
      results = results.filter((c: any) => {
        const searchable = `${c.first_name} ${c.last_name} ${c.phone} ${c.email} ${c.city} ${c.address}`.toLowerCase();
        return searchable.includes(q);
      });
    }
    return { count: results.length, caregivers: results.map(buildCaregiverSummary) };
  },
);

// ── get_caregiver_detail ──

registerTool(
  {
    name: "get_caregiver_detail",
    description:
      "Get full detailed profile for a specific caregiver including all tasks, notes, and activity history.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "The caregiver's name (first, last, or full) \u2014 used if ID not known" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches found: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
    return { profile: buildCaregiverProfile(cg) };
  },
);

// ── get_pipeline_stats ──

registerTool(
  {
    name: "get_pipeline_stats",
    description:
      "Get pipeline statistics: counts by phase, stale leads, recent activity, conversion metrics.",
    input_schema: {
      type: "object",
      properties: {
        days_back: { type: "number", description: "Number of days to look back for activity stats (default 7)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const daysBack = input.days_back || 7;
    const active = ctx.caregivers.filter((c: any) => !c.archived);
    const cutoff = Date.now() - daysBack * 86400000;
    const phases: Record<string, number> = {};
    for (const cg of active) {
      const p = getPhase(cg);
      phases[p] = (phases[p] || 0) + 1;
    }
    const recentActivity = active.filter((c: any) => getLastActivity(c) > cutoff).length;
    const stale = active.filter((c: any) => getLastActivity(c) < cutoff);
    return {
      total_active: active.length,
      total_archived: ctx.caregivers.length - active.length,
      phase_distribution: phases,
      active_last_n_days: recentActivity,
      stale_count: stale.length,
      stale_leads: stale.slice(0, 5).map(buildCaregiverSummary),
    };
  },
);

// ── list_stale_leads ──

registerTool(
  {
    name: "list_stale_leads",
    description:
      "Find caregivers with no activity (notes/task completions) in X days. Helps identify people falling through the cracks.",
    input_schema: {
      type: "object",
      properties: {
        days_inactive: { type: "number", description: "Number of days of inactivity to consider stale (default 7)" },
        phase: { type: "string", description: "Optionally filter by phase" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const days = input.days_inactive || 7;
    const cutoff = Date.now() - days * 86400000;
    let leads = ctx.caregivers.filter((c: any) => !c.archived && getLastActivity(c) < cutoff);
    if (input.phase) leads = leads.filter((c: any) => getPhase(c).toLowerCase() === input.phase.toLowerCase());
    leads.sort((a: any, b: any) => getLastActivity(a) - getLastActivity(b));
    return {
      count: leads.length,
      days_inactive_threshold: days,
      caregivers: leads.map((c: any) => {
        const daysSince = Math.floor((Date.now() - getLastActivity(c)) / 86400000);
        return `${buildCaregiverSummary(c)} | Last activity: ${daysSince} days ago`;
      }),
    };
  },
);

// ── check_compliance ──

registerTool(
  {
    name: "check_compliance",
    description:
      "Check HCA expiration dates, missing documents, and compliance status across caregivers.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "Check a specific caregiver (omit to check all)" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        check_type: { type: "string", enum: ["hca_expiration", "missing_docs", "all"], description: "Type of compliance check (default: all)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const checkType = input.check_type || "all";
    let targets = ctx.caregivers.filter((c: any) => !c.archived);
    if (input.caregiver_id || input.name) {
      const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
      if (!cg) return { error: "Caregiver not found." };
      if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
      targets = [cg];
    }
    const issues: string[] = [];
    const today = new Date();
    for (const cg of targets) {
      const name = `${cg.first_name} ${cg.last_name}`;
      if (checkType === "all" || checkType === "hca_expiration") {
        if (cg.hca_expiration) {
          const exp = new Date(cg.hca_expiration);
          const daysUntil = Math.floor((exp.getTime() - today.getTime()) / 86400000);
          if (daysUntil < 0) issues.push(`${name}: HCA EXPIRED ${Math.abs(daysUntil)} days ago`);
          else if (daysUntil < 30) issues.push(`${name}: HCA expires in ${daysUntil} days (${cg.hca_expiration})`);
        }
        if (!cg.has_hca || cg.has_hca === "No") issues.push(`${name}: No HCA on file`);
      }
      if (checkType === "all" || checkType === "missing_docs") {
        if (!cg.has_dl || cg.has_dl === "No") issues.push(`${name}: No driver's license on file`);
        if (!cg.email) issues.push(`${name}: Missing email address`);
        if (!cg.phone) issues.push(`${name}: Missing phone number`);
      }
    }
    return {
      checked: targets.length,
      issues_found: issues.length,
      issues: issues.length > 0 ? issues : ["No compliance issues found."],
    };
  },
);
