// ─── Metrics Helper ───
// Fire-and-forget metric logging. Never blocks the main response path.
// Usage: logMetric(supabase, 'message-router', 'classification', 1200, true, { tokens: 150 })

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface MetricEntry {
  function_name: string;
  event_type: string;
  duration_ms?: number;
  success?: boolean;
  metadata?: Record<string, any>;
}

/**
 * Log a metric to the system_metrics table.
 * Fire-and-forget — errors are swallowed to never block the caller.
 */
export function logMetric(
  supabase: SupabaseClient,
  functionName: string,
  eventType: string,
  durationMs?: number,
  success: boolean = true,
  metadata: Record<string, any> = {},
): void {
  supabase
    .from("system_metrics")
    .insert({
      function_name: functionName,
      event_type: eventType,
      duration_ms: durationMs ?? null,
      success,
      metadata,
    })
    .then(() => {})
    .catch((err: Error) =>
      console.error(
        `[metrics] Failed to log ${functionName}/${eventType}:`,
        err,
      ),
    );
}

/**
 * Timer utility — returns a function that, when called, logs the elapsed time.
 * Usage:
 *   const done = startTimer(supabase, 'message-router', 'classification');
 *   // ... do work ...
 *   done(true, { tokens: 150 });
 */
export function startTimer(
  supabase: SupabaseClient,
  functionName: string,
  eventType: string,
): (success?: boolean, metadata?: Record<string, any>) => void {
  const start = Date.now();
  return (success: boolean = true, metadata: Record<string, any> = {}) => {
    const durationMs = Date.now() - start;
    logMetric(supabase, functionName, eventType, durationMs, success, metadata);
  };
}
