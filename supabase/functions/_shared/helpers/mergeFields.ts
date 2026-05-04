// ─── SMS Merge-Field Resolver ───
// Substitutes merge-field placeholders in a message body. Works for both
// caregivers (which expose `phase_override`) and clients (which expose
// `phase` directly).
//
// Supported placeholders (all case-insensitive):
//   snake_case: {{first_name}}, {{last_name}}, {{phone}}, {{email}}, {{phase}}
//   camelCase:  {{firstName}},  {{lastName}},  {{fullName}}
//
// Both formats resolve to the same underlying entity fields. The dual
// format exists because admin-managed Message Templates (the
// `message_templates` table, edited from Settings → Message Templates)
// use the camelCase convention, and bulk SMS sends those templates
// through this resolver per recipient. Existing snake_case templates
// continue to work unchanged.

export interface MergeFieldEntity {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  phase_override?: string | null;
  phase?: string | null;
}

export function resolveMergeFields(
  template: string,
  entity: MergeFieldEntity,
): string {
  // Caregivers store the active phase in `phase_override`; clients store
  // it directly in `phase`. {{phase}} resolves to whichever is present,
  // preferring the caregiver field for backwards compatibility.
  const phaseValue = entity.phase_override || entity.phase || "";
  const firstName = entity.first_name || "";
  const lastName = entity.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  return template
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{last_name\}\}/gi, lastName)
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{lastName\}\}/g, lastName)
    .replace(/\{\{fullName\}\}/g, fullName)
    .replace(/\{\{phone\}\}/gi, entity.phone || "")
    .replace(/\{\{email\}\}/gi, entity.email || "")
    .replace(/\{\{phase\}\}/gi, phaseValue);
}
