// Phase 0.5 PR B — manifest field validators.
//
// Pure functions (no React, no supabase) so they're easy to unit-test
// and can be reused in both per-field [Edit] modals (live validation
// while typing) and the SaveConfirmationDialog (last-line check before
// hitting the RPC).
//
// Each validator returns either:
//   { ok: true }
//   { ok: false, error: 'human-readable message' }
//
// The RPC re-validates on the server (DB CHECK constraints + the
// allowlist + change_summary check) — these are UX-layer guards, not
// the security boundary.

const KNOWN_AUTONOMY_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const KNOWN_MODELS = new Set([
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

export function validateName(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Name cannot be empty.' };
  }
  if (value.length > 200) {
    return { ok: false, error: 'Name is too long (max 200 characters).' };
  }
  return { ok: true };
}

export function validateSystemPrompt(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'System prompt cannot be empty (DB CHECK).' };
  }
  return { ok: true };
}

export function validateMaxIterations(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    return { ok: false, error: 'Max iterations must be an integer.' };
  }
  if (n < 1) {
    return { ok: false, error: 'Max iterations must be >= 1 (DB CHECK).' };
  }
  if (n > 50) {
    return { ok: false, error: 'Max iterations capped at 50 (cost guard).' };
  }
  return { ok: true };
}

export function validateModel(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Model cannot be empty (DB CHECK).' };
  }
  // Locked D2 — free-text with non-blocking warning if not in known list.
  if (!KNOWN_MODELS.has(value)) {
    return {
      ok: true,
      warning: `"${value}" is not in the known-good list. Save anyway, but verify spelling.`,
    };
  }
  return { ok: true };
}

// tool_allowlist must be an array of known tool names. Universe is
// per-agent; we accept the universe as a parameter so the caller (the
// AgentManifestEditor) can pass the locked hard-coded list per locked D1.
export function validateToolAllowlist(value, knownTools) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Tool allowlist must be an array.' };
  }
  if (!Array.isArray(knownTools)) {
    return { ok: false, error: 'validator misuse: knownTools must be provided.' };
  }
  const known = new Set(knownTools);
  const unknown = value.filter(t => !known.has(t));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown tool(s): ${unknown.join(', ')}.`,
    };
  }
  // Detect duplicates.
  const seen = new Set();
  const dupes = [];
  for (const t of value) {
    if (seen.has(t)) dupes.push(t);
    seen.add(t);
  }
  if (dupes.length > 0) {
    return {
      ok: false,
      error: `Duplicate tool(s): ${[...new Set(dupes)].join(', ')}.`,
    };
  }
  return { ok: true };
}

// autonomy_profile is a JSON object with keys = action names, values
// = { current_level: 'L1'|'L2'|'L3'|'L4', ... }. Phase 1.2 hardens
// this with the v2 promotion algorithm; for 0.5 we accept anything
// shaped like the seed pattern.
export function validateAutonomyProfile(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Autonomy profile must be a JSON object.' };
  }
  const issues = [];
  for (const [action, config] of Object.entries(value)) {
    if (typeof action !== 'string' || action.length === 0) {
      issues.push(`Empty action key.`);
      continue;
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      issues.push(`${action}: value must be an object.`);
      continue;
    }
    if (!('current_level' in config)) {
      issues.push(`${action}: missing "current_level".`);
      continue;
    }
    if (!KNOWN_AUTONOMY_LEVELS.has(config.current_level)) {
      issues.push(
        `${action}.current_level "${config.current_level}" must be L1, L2, L3, or L4.`
      );
    }
  }
  if (issues.length > 0) {
    return { ok: false, error: issues.slice(0, 3).join(' ') };
  }
  return { ok: true };
}

// context_recipe and outcome_definition are JSON objects with no
// strict shape in 0.5. Just ensure they parse and aren't an array.
export function validateJsonObject(value, fieldName = 'value') {
  if (value === null || value === undefined) {
    // Allow null — the column is JSONB NOT NULL DEFAULT '{}'::jsonb,
    // so the RPC will accept null and the column default kicks in.
    // Return ok with a warning so the editor can show "(empty)".
    return { ok: true };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be a JSON object.` };
  }
  return { ok: true };
}

// Parse user-edited JSON text. Returns { ok, value, error } where
// `value` is the parsed object on success or undefined on failure.
export function parseJsonText(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'Input must be a string.' };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // Empty input maps to {} so the editor can clear a field by
    // selecting all + delete + save.
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Must be a JSON object (not array, null, or scalar).' };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err.message || String(err)}` };
  }
}
