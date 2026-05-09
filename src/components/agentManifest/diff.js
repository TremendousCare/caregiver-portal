// Phase 0.5 PR B — manifest diff renderer.
//
// Pure functions (no React) that compute diffs between two manifest
// values. The components (SaveConfirmationDialog, RevertConfirmationDialog,
// AgentVersionHistory's [Diff] modal) consume the diff structures and
// render React from them.
//
// Locked diff styles per §9 D8 + §4:
//   - system_prompt           → line-level unified diff (red/green)
//   - name, model             → inline before/after on a single line
//   - max_iterations          → inline before/after
//   - tool_allowlist          → added/removed columns
//   - autonomy_profile,
//     context_recipe,
//     outcome_definition      → canonical-JSON unified diff
//                              (JSON.stringify(obj, null, 2) on both
//                              sides + line-level unified diff)
//
// The unified diff implementation is intentionally simple — line-level,
// no LCS algorithm, no fuzzy matching. For the Phase 0.5 use case (a
// human reviewing a small prompt change before saving) it's enough.

const EDITABLE_FIELDS = [
  'name',
  'model',
  'max_iterations',
  'system_prompt',
  'tool_allowlist',
  'autonomy_profile',
  'context_recipe',
  'outcome_definition',
];

// Compute a structured diff between two agent rows. Returns one entry
// per editable field (omitting fields where current === proposed).
//
// Each entry is one of:
//   { field, kind: 'inline',     before, after }
//   { field, kind: 'lines',      lines: [{op:'context'|'add'|'del', text}] }
//   { field, kind: 'allowlist',  added: string[], removed: string[] }
//   { field, kind: 'json',       lines: [{op, text}] }
export function diffManifest(current, proposed) {
  if (!current || !proposed) return [];
  const entries = [];

  for (const field of EDITABLE_FIELDS) {
    const a = current[field];
    const b = proposed[field];
    if (deepEqual(a, b)) continue;

    if (field === 'system_prompt') {
      entries.push({
        field,
        kind: 'lines',
        lines: unifiedLineDiff(asString(a), asString(b)),
      });
    } else if (field === 'tool_allowlist') {
      const aSet = new Set(Array.isArray(a) ? a : []);
      const bSet = new Set(Array.isArray(b) ? b : []);
      const added   = [...bSet].filter(x => !aSet.has(x)).sort();
      const removed = [...aSet].filter(x => !bSet.has(x)).sort();
      entries.push({ field, kind: 'allowlist', added, removed });
    } else if (
      field === 'autonomy_profile' ||
      field === 'context_recipe' ||
      field === 'outcome_definition'
    ) {
      entries.push({
        field,
        kind: 'json',
        lines: unifiedLineDiff(canonicalJson(a), canonicalJson(b)),
      });
    } else {
      // name, model, max_iterations
      entries.push({
        field,
        kind: 'inline',
        before: asString(a),
        after:  asString(b),
      });
    }
  }

  return entries;
}

// Returns true when there are no editable-field differences.
export function isManifestUnchanged(current, proposed) {
  return diffManifest(current, proposed).length === 0;
}

// Build a `p_updates` jsonb payload from the proposed row that only
// contains keys whose value differs from current. The RPC's allowlist
// logic ignores extra keys silently, but sending only the changed
// keys keeps the audit summary minimal and the wire payload small.
export function buildUpdatePayload(current, proposed) {
  const out = {};
  for (const field of EDITABLE_FIELDS) {
    if (!deepEqual(current?.[field], proposed?.[field])) {
      out[field] = proposed[field];
    }
  }
  return out;
}

// ─── Helpers ───

function asString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function canonicalJson(v) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return String(v);
  }
}

// Trivial deep-equality for the manifest values we care about
// (primitives, arrays of strings, plain objects). Avoids pulling in
// lodash for one place.
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// Line-level unified-style diff. Splits on \n; emits one entry per
// line of context / addition / removal. Pure linear walk — no LCS
// — which means a prompt that's been wholly rewritten will show as a
// large delete + large add block. Fine for our use case.
//
// Algorithm: walk both files; when lines match, emit context. When
// they diverge, scan ahead in `b` for the next line that matches
// `a[i]`; everything before it in `b` is an add, everything we're
// skipping in `a` is a delete. If no future match, the rest is
// add/delete.
export function unifiedLineDiff(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after  ?? '').split('\n');
  const out = [];

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: 'context', text: a[i] });
      i++; j++;
      continue;
    }
    // Look ahead in b for a line matching a[i].
    let aheadInB = -1;
    if (i < a.length) {
      // Cap the lookahead so a 5000-line file doesn't get O(n^2).
      const limit = Math.min(b.length, j + 200);
      for (let k = j; k < limit; k++) {
        if (b[k] === a[i]) { aheadInB = k; break; }
      }
    }
    if (aheadInB >= 0) {
      // Lines b[j..aheadInB-1] are additions; emit them, then the
      // matching line resumes context.
      while (j < aheadInB) {
        out.push({ op: 'add', text: b[j] });
        j++;
      }
    } else if (i < a.length) {
      // a[i] doesn't appear in the lookahead window of b — treat as a
      // deletion. If we're also at a b line that doesn't match
      // anywhere ahead in a, emit as add too.
      out.push({ op: 'del', text: a[i] });
      i++;
      // Only consume one a-line per iteration; b advances next loop.
    } else {
      // Only b remaining.
      out.push({ op: 'add', text: b[j] });
      j++;
    }
  }

  return out;
}

// Display label for a field name.
export function fieldLabel(field) {
  switch (field) {
    case 'name':               return 'Display name';
    case 'system_prompt':      return 'System prompt';
    case 'tool_allowlist':     return 'Tool allowlist';
    case 'autonomy_profile':   return 'Autonomy profile';
    case 'context_recipe':     return 'Context recipe';
    case 'model':              return 'Model';
    case 'max_iterations':     return 'Max iterations';
    case 'outcome_definition': return 'Outcome definition';
    default:                   return field;
  }
}
