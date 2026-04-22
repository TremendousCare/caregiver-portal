-- Interview Evaluation Template
--
-- Adds the schema pieces needed for TAS staff to fill out a structured
-- Interview Evaluation form during the Interview phase, reusing the
-- existing survey_templates + survey_responses infrastructure.
--
-- Three things happen here:
--   1. New nullable columns on `caregivers` that the form writes back to.
--   2. `internal_only` flag on `survey_templates` so internal forms don't
--      get auto-sent to applicants by the survey-reminder automation.
--   3. Seed a default "Interview Evaluation" template with a stable UUID
--      so the Edit-Checklist UI can reference it and admins can edit the
--      question list from Settings without a redeploy.
--
-- All changes are additive and nullable — old code continues to work.

-- ─── 1. New caregiver profile fields ────────────────────────────────
ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS tb_test text,
  ADD COLUMN IF NOT EXISTS auto_insurance text,
  ADD COLUMN IF NOT EXISTS proposed_pay_rate numeric(6,2);

-- ─── 2. Internal-only flag on survey templates ──────────────────────
ALTER TABLE survey_templates
  ADD COLUMN IF NOT EXISTS internal_only boolean NOT NULL DEFAULT false;

-- ─── 3. Seed the Interview Evaluation template ──────────────────────
-- Stable ID so task definitions can reference it. Idempotent: skipped
-- if already present, so re-running the migration is safe.
INSERT INTO survey_templates (
  id,
  name,
  description,
  questions,
  enabled,
  internal_only,
  send_via,
  expires_hours,
  auto_archive_disqualified
) VALUES (
  '00000000-0000-0000-0000-0000000e0001',
  'Interview Evaluation',
  'Filled out by Talent Acquisition during the interview. Answers auto-populate the caregiver profile.',
  $json$[
    {"id":"q_phone","section":"Interview Evaluation","text":"Phone Number","type":"free_text","required":false,"profile_field":"phone"},
    {"id":"q_email","section":"Interview Evaluation","text":"Email","type":"free_text","required":false,"profile_field":"email"},
    {"id":"q_location","section":"Interview Evaluation","text":"Location (City / Area)","type":"free_text","required":false,"profile_field":"city"},
    {"id":"q_date","section":"Interview Evaluation","text":"Date of Interview","type":"free_text","required":false},
    {"id":"q_hca","section":"Interview Evaluation","text":"HCA Registered?","type":"yes_no","required":true,"options":["Yes","No"],"profile_field":"has_hca"},
    {"id":"q_perid","section":"Interview Evaluation","text":"Per ID #","type":"free_text","required":false,"profile_field":"per_id"},
    {"id":"q_tb","section":"Interview Evaluation","text":"TB Test (valid, < 2 years)?","type":"yes_no","required":true,"options":["Yes","No"],"profile_field":"tb_test"},
    {"id":"q_dl","section":"Interview Evaluation","text":"Valid CA Driver's License?","type":"yes_no","required":true,"options":["Yes","No"],"profile_field":"has_dl"},
    {"id":"q_auto","section":"Interview Evaluation","text":"Auto Insurance?","type":"yes_no","required":true,"options":["Yes","No"],"profile_field":"auto_insurance"},
    {"id":"q_allergies","section":"Interview Evaluation","text":"Any known allergies (pets, smoke, etc.)?","type":"free_text","required":false,"profile_field":"allergies"},
    {"id":"q_gender_pref","section":"Interview Evaluation","text":"Open to working with both Male and Female clients?","type":"multiple_choice","required":true,"options":["Both","Female only","Male only"],"profile_field":"client_gender_preference"},
    {"id":"q_availability","section":"Interview Evaluation","text":"Availability (days / shifts)","type":"free_text","required":false,"profile_field":"availability"},

    {"id":"q_years","section":"Caregiving Experience","text":"Years of caregiving experience","type":"multiple_choice","required":true,"options":["< 1 year","1-3 years","3-5 years","5-10 years","10+ years"],"profile_field":"years_experience"},
    {"id":"q_settings","section":"Caregiving Experience","text":"Where was experience gained?","type":"multi_select","required":false,"options":["Home Care","Facility","Family","Hospital","Other"]},

    {"id":"q_conditions","section":"Client Conditions","text":"Client conditions comfortable working with","type":"multi_select","required":false,"options":["Alzheimer's / Dementia","Parkinson's","Stroke","Cancer","Heart Conditions","Hospice"]},

    {"id":"q_general_exp","section":"Experience","text":"General care experience","type":"multi_select","required":false,"options":["Light housekeeping","Meal preparation","Errands","Companionship"]},
    {"id":"q_personal_care","section":"Experience","text":"Personal care experience","type":"multi_select","required":false,"options":["Personal Care","Dressing","Bathing","Incontinence care","Grooming","Oral hygiene","Stand-by assistance","Toileting","Assisting with walking/exercise"]},
    {"id":"q_mobility","section":"Experience","text":"Transfers & mobility experience","type":"multi_select","required":false,"options":["Pivot transfers","Gait belt","Hoyer lift","Bedridden clients","Occupied bed change"]},

    {"id":"q_infection","section":"Health & Safety","text":"How do you practice infection control?","type":"free_text","required":false},
    {"id":"q_condition_changes","section":"Health & Safety","text":"What changes in a client's condition would you report?","type":"free_text","required":false},

    {"id":"q_hospice_pass","section":"Hospice-Specific","text":"If you have worked with a hospice client, have you ever had a client pass while on your shift? If so, how did you handle it?","type":"free_text","required":false},

    {"id":"q_bed_to_chair","section":"Situational / Skill-Based","text":"How would you properly transfer a client from a bed to a wheelchair?","type":"free_text","required":false},
    {"id":"q_refusal","section":"Situational / Skill-Based","text":"A client refuses to eat or take medication. How would you handle it?","type":"free_text","required":false},
    {"id":"q_breathing","section":"Situational / Skill-Based","text":"If a client is having trouble breathing, experiencing chest pain, or showing confusion, how would you handle the situation?","type":"free_text","required":false},
    {"id":"q_alz_safety","section":"Situational / Skill-Based","text":"How do you keep a client with Alzheimer's or dementia safe in their home?","type":"free_text","required":false},
    {"id":"q_scope","section":"Situational / Skill-Based","text":"If a client or family asks you to do something outside of your job scope, how would you normally respond?","type":"free_text","required":false},
    {"id":"q_references","section":"Situational / Skill-Based","text":"If I reached out to a client or family member you worked for, what type of caregiver would they say you were? What feedback would they provide?","type":"free_text","required":false},
    {"id":"q_why","section":"Situational / Skill-Based","text":"Why did you choose to become a caregiver?","type":"free_text","required":false},

    {"id":"q_pay_rate","section":"Pay Rate","text":"Proposed pay rate (USD / hour)","type":"number","required":false,"profile_field":"proposed_pay_rate"}
  ]$json$::jsonb,
  true,
  true,
  'internal',
  0,
  false
)
ON CONFLICT (id) DO NOTHING;
