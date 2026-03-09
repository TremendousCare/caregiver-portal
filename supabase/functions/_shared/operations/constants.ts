// ─── Updatable Field Allowlists ───
// Single source of truth for which entity fields can be updated via tools.
// Used by both ai-chat tool handlers and autonomous Edge Functions.

export const UPDATABLE_CAREGIVER_FIELDS = [
  "phone",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "per_id",
  "has_hca",
  "has_dl",
  "hca_expiration",
  "availability",
  "preferred_shift",
  "years_experience",
  "languages",
  "specializations",
  "certifications",
  "source",
  "source_detail",
] as const;

export const UPDATABLE_CLIENT_FIELDS = [
  "phone",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "contact_name",
  "relationship",
  "care_recipient_name",
  "care_recipient_age",
  "care_needs",
  "hours_needed",
  "start_date_preference",
  "budget_range",
  "insurance_info",
  "referral_source",
  "referral_detail",
  "priority",
  "assigned_to",
  "lost_reason",
  "lost_detail",
] as const;
