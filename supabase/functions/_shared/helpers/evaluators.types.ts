// ─── Action Item Evaluator Types ─────────────────────────────
// Pure type definitions for the configurable action item engine.
// No runtime dependencies — importable by any Edge Function or test.

/** Adapter interface for accessing entity data in a type-agnostic way. */
export interface EntityAdapter {
  entityType: string;
  getId: (entity: any) => string;
  getName: (entity: any) => string;
  getPhase: (entity: any) => string;
  getDaysInPhase: (entity: any) => number;
  getDaysSinceCreation: (entity: any) => number;
  getMinutesSinceCreation: (entity: any) => number;
  isTaskDone: (entity: any, taskId: string) => boolean;
  getDateField: (entity: any, field: string) => string | null;
  getPhaseTimestamp: (entity: any, phase: string) => number | null;
  getLastNoteDate: (entity: any) => number | null;
  isTerminalPhase: (entity: any) => boolean;
}

/** Result of evaluating a single condition against an entity. */
export interface EvaluatorResult {
  matches: boolean;
  context: Record<string, any>;
}

/** Condition configuration from the action_item_rules table. */
export type ConditionConfig = Record<string, any>;

/** An action item rule from the database. */
export interface ActionItemRule {
  id: string;
  name: string;
  entity_type: string;
  condition_type: string;
  condition_config: ConditionConfig | null;
  urgency: string;
  urgency_escalation?: {
    min_days?: number;
    urgency?: string;
  } | null;
  icon?: string;
  title_template?: string;
  detail_template?: string;
  action_template?: string;
  enabled: boolean;
  sort_order?: number;
}

/** A generated action item for display on the dashboard. */
export interface ActionItem {
  entityId: string;
  entityType: string;
  name: string;
  urgency: string;
  icon: string;
  title: string;
  detail: string;
  action: string;
  ruleId: string;
  // Caregiver compatibility
  cgId?: string;
  // Client compatibility
  clientId?: string;
  clientName?: string;
  type?: string;
  message?: string;
  severity?: string;
  phase?: string;
}

/** Evaluator function signature. */
export type EvaluatorFn = (
  entity: any,
  config: ConditionConfig,
  adapter: EntityAdapter,
) => EvaluatorResult;
