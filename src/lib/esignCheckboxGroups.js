// Shared logic for checkbox "groups" — grouped checkboxes behave as radio
// buttons (at most one selected, required groups need exactly one).
//
// The server edge function (supabase/functions/esign/index.ts) duplicates
// normalizeCheckboxGroups and getRequiredGroupViolations because Supabase
// only bundles code under supabase/functions/. Keep the two implementations
// in sync.

function readGroupName(field) {
  if (!field || field.type !== 'checkbox') return '';
  return typeof field.group === 'string' ? field.group.trim() : '';
}

function isTruthyCheckboxValue(v) {
  return v === true || v === 'true';
}

export function groupCheckboxFields(fields) {
  const groups = new Map();
  for (const f of fields || []) {
    const name = readGroupName(f);
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  }
  return groups;
}

export function isRadioGroupMember(field, fields) {
  const name = readGroupName(field);
  if (!name) return false;
  const members = groupCheckboxFields(fields).get(name);
  return !!members && members.length >= 2;
}

export function getRequiredGroupViolations(fields, values) {
  const violations = [];
  for (const [groupName, members] of groupCheckboxFields(fields)) {
    const required = members.some((m) => m.required === true);
    if (!required) continue;
    const anyChecked = members.some((m) => isTruthyCheckboxValue(values?.[m.id]));
    if (!anyChecked) {
      const first = members[0];
      violations.push({ groupName, page: first.page || 1, fieldId: first.id });
    }
  }
  return violations;
}

export function normalizeCheckboxGroups(fields, values) {
  const out = { ...(values || {}) };
  const corrections = [];
  for (const [groupName, members] of groupCheckboxFields(fields)) {
    const truthy = members.filter((m) => isTruthyCheckboxValue(out[m.id]));
    if (truthy.length <= 1) continue;
    const [keep, ...clear] = truthy;
    for (const m of clear) out[m.id] = false;
    corrections.push({
      groupName,
      keptFieldId: keep.id,
      clearedFieldIds: clear.map((m) => m.id),
    });
  }
  return { values: out, corrections };
}
