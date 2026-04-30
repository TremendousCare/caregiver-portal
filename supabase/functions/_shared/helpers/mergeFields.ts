// ─── SMS Merge-Field Resolver ───
// Substitutes {{first_name}}, {{last_name}}, {{phone}}, {{email}}, {{phase}}
// in a message body. Works for both caregivers (which expose `phase_override`)
// and clients (which expose `phase` directly).

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
  return template
    .replace(/\{\{first_name\}\}/gi, entity.first_name || "")
    .replace(/\{\{last_name\}\}/gi, entity.last_name || "")
    .replace(/\{\{phone\}\}/gi, entity.phone || "")
    .replace(/\{\{email\}\}/gi, entity.email || "")
    .replace(/\{\{phase\}\}/gi, phaseValue);
}
