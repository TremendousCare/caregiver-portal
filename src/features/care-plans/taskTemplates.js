// ═══════════════════════════════════════════════════════════════
// taskTemplates — starter library of common care plan tasks
//
// Used by the "Quick add" chips in TaskEditor's NewTaskForm. The
// goal is to make the most common entries one click away so the
// schedulers and intake nurses can stop typing the same handful of
// tasks every time a new care plan goes through.
//
// Templates are organized by `TASK_CATEGORIES` key. Each entry
// shapes itself like the form output of NewTaskForm — picking a
// template pre-fills the form's name / description / shifts /
// priority. The user can still edit before saving. Free-text
// entry remains the default; templates are only suggestions.
//
// Resist unbounded growth. Five-to-eight templates per category is
// the sweet spot. Below ~four and the picker doesn't feel useful;
// above ten and it becomes harder to scan than to type. When in
// doubt, omit niche templates and let the user free-text them.
//
// Replaces the team's earlier ask for "add mobility / PT / OT /
// speech support / encourage exercise as fields" — those are tasks,
// not fields, and live here as templates under adl.ambulation.
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} TaskTemplate
 * @property {string}   name         Required. Shown on the chip and
 *                                   filled into the task name input.
 * @property {string?}  description  Optional. Fills the description
 *                                   textarea when the chip is picked.
 * @property {string[]?} shifts      Defaults to ['all'] when omitted.
 * @property {string?}  priority     'standard' | 'critical' | 'optional'.
 *                                   Defaults to 'standard' when omitted.
 * @property {string?}  safetyNotes  Optional safety reminder, surfaced
 *                                   to caregivers on the shift.
 */

/** @type {Object<string, TaskTemplate[]>} */
const TEMPLATES_BY_CATEGORY = {
  // ── ADL: Ambulation / mobility ───────────────────────────
  'adl.ambulation': [
    {
      name: 'Encourage daily walk',
      description: '10–15 minutes around the home or outside as tolerated.',
      shifts: ['morning', 'afternoon'],
    },
    {
      name: 'PT exercises',
      description: 'Follow the physical therapist\'s prescribed routine.',
      shifts: ['morning'],
    },
    {
      name: 'OT exercises',
      description: 'Follow the occupational therapist\'s prescribed routine.',
      shifts: ['morning'],
    },
    {
      name: 'Speech therapy exercises',
      description: 'Follow speech therapist\'s prescribed routine (articulation, swallowing, cognitive drills).',
    },
    {
      name: 'Range-of-motion exercises',
      description: 'Gentle passive or active range-of-motion to maintain flexibility.',
    },
    {
      name: 'Walker / cane assistance',
      description: 'Ensure walker or cane is within reach; assist with transfers.',
      safetyNotes: 'Verify brakes are engaged before any transfer.',
    },
    {
      name: 'Fall prevention check',
      description: 'Scan for clutter, loose rugs, poor lighting, and other fall hazards each shift.',
      priority: 'critical',
    },
    {
      name: 'Encourage standing breaks',
      description: 'Prompt the client to stand or shift position every 1–2 hours.',
    },
  ],

  // ── ADL: Transfers ───────────────────────────────────────
  'adl.transfers': [
    {
      name: 'Bed-to-chair transfer',
      description: 'Assist with sit-to-stand and pivot to chair.',
    },
    {
      name: 'Chair-to-bed transfer',
      description: 'Assist back to bed; ensure pillow / blanket positioning.',
    },
    {
      name: 'Gait belt usage',
      description: 'Apply gait belt before any standing transfer.',
      priority: 'critical',
      safetyNotes: 'Never lift by clothing or under arms — always use the gait belt.',
    },
    {
      name: 'Hoyer lift transfer',
      description: 'Two-person Hoyer lift transfer per client\'s sling instructions.',
      priority: 'critical',
      safetyNotes: 'Two-person transfer required. Confirm sling type and clip positions.',
    },
    {
      name: 'Wheelchair-to-toilet transfer',
      description: 'Pivot transfer or grab-bar assisted depending on ability.',
    },
    {
      name: 'Bedside commode transfer',
      shifts: ['overnight'],
    },
  ],

  // ── ADL: Bathing ─────────────────────────────────────────
  'adl.bathing': [
    {
      name: 'Assist with shower',
      description: 'Shower chair, hand-held showerhead, supervise or hands-on per care plan.',
      shifts: ['morning'],
    },
    {
      name: 'Assist with tub bath',
      shifts: ['morning'],
    },
    {
      name: 'Bed bath',
      description: 'Full bed bath using basin and washcloths.',
    },
    {
      name: 'Sponge bath',
      description: 'Partial sponge bath on non-shower days.',
    },
    {
      name: 'Hair wash',
      description: 'Wash and dry hair; weekly or as preferred.',
    },
    {
      name: 'Skin check during bath',
      description: 'Inspect skin for redness, breakdown, or bruising and report to office.',
      priority: 'critical',
    },
    {
      name: 'Apply lotion after bath',
      description: 'Moisturize legs, arms, and back. Avoid between toes.',
    },
  ],

  // ── ADL: Dressing & grooming ─────────────────────────────
  'adl.dressing': [
    {
      name: 'Assist with dressing',
      description: 'Lay out clothes; hands-on as needed.',
      shifts: ['morning'],
    },
    {
      name: 'Assist with undressing for bed',
      shifts: ['evening'],
    },
    {
      name: 'Oral care / brush teeth',
      description: 'Brush teeth or assist with denture care twice daily.',
      shifts: ['morning', 'evening'],
    },
    {
      name: 'Denture care',
      description: 'Clean and store dentures per client\'s routine.',
    },
    {
      name: 'Hair brushing / styling',
    },
    {
      name: 'Shave (electric razor)',
      description: 'Electric razor only — no blade razors per safety policy.',
      safetyNotes: 'Use electric razor only. No blade razors.',
    },
    {
      name: 'Nail care',
      description: 'File nails. Do not clip if client has diabetes or thin skin.',
      safetyNotes: 'No clipping if diabetic or on blood thinners — refer to nurse.',
    },
  ],

  // ── ADL: Toileting ───────────────────────────────────────
  'adl.toileting': [
    {
      name: 'Toilet assist',
      description: 'Walk to bathroom, assist with clothing, supervise as needed.',
    },
    {
      name: 'Incontinence brief change',
      description: 'Check and change briefs every 2–3 hours or as needed.',
    },
    {
      name: 'Peri care',
      description: 'Perineal care with each brief change to prevent skin breakdown.',
      priority: 'critical',
    },
    {
      name: 'Bedpan / urinal assistance',
      shifts: ['overnight'],
    },
    {
      name: 'Track bowel movements',
      description: 'Log BMs daily. Report to office if 3+ days without a BM.',
    },
    {
      name: 'Catheter care',
      description: 'Empty bag, check for kinks, clean insertion site per nurse\'s instructions.',
      priority: 'critical',
      safetyNotes: 'Report cloudy urine, blood, or strong odor immediately.',
    },
  ],

  // ── ADL: Feeding ─────────────────────────────────────────
  'adl.feeding': [
    {
      name: 'Prepare meal',
      description: 'Prepare per dietary plan and client preferences.',
    },
    {
      name: 'Assist with eating',
      description: 'Hands-on feeding assistance or cueing as needed.',
    },
    {
      name: 'Encourage hydration',
      description: 'Offer water or preferred drink every hour while awake.',
    },
    {
      name: 'Track fluid intake',
      description: 'Log estimated fluid intake. Report to office if below target.',
    },
    {
      name: 'Aspiration precautions',
      description: 'Client sits upright during and 30 min after meals. Thickened liquids if ordered.',
      priority: 'critical',
      safetyNotes: 'Stop feeding immediately and call 911 if coughing, choking, or color change.',
    },
    {
      name: 'Wash dishes after meals',
    },
    {
      name: 'Document refused meals',
      description: 'If client refuses a meal, note what was offered and refused in shift notes.',
    },
  ],

  // ── IADL: Housework ──────────────────────────────────────
  'iadl.housework': [
    { name: 'Light dusting of common areas' },
    { name: 'Vacuum living room and bedroom' },
    { name: 'Mop kitchen and bathroom floors' },
    { name: 'Clean bathroom (toilet, sink, counters)' },
    { name: 'Take out trash and recycling' },
    { name: 'Make bed / change linens (weekly)' },
    { name: 'Tidy and put items away' },
  ],

  // ── IADL: Laundry ────────────────────────────────────────
  'iadl.laundry': [
    { name: 'Wash and dry one load' },
    { name: 'Fold and put away laundry' },
    { name: 'Strip and remake bed linens' },
    { name: 'Hand-wash delicates' },
  ],

  // ── IADL: Meal prep ──────────────────────────────────────
  'iadl.meal_prep': [
    {
      name: 'Prep breakfast',
      shifts: ['morning'],
    },
    {
      name: 'Prep lunch',
      shifts: ['afternoon'],
    },
    {
      name: 'Prep dinner',
      shifts: ['evening'],
    },
    {
      name: 'Prep snacks for the day',
    },
    {
      name: 'Grocery list prep',
      description: 'Note items running low; pass to family or office.',
    },
  ],

  // ── IADL: Medication support ────────────────────────────
  'iadl.medication': [
    {
      name: 'Medication reminder',
      description: 'Remind client to take meds at scheduled time. Caregivers do not administer.',
      priority: 'critical',
    },
    {
      name: 'Set up pill box (weekly)',
      description: 'Per nurse / family\'s written list. Verify against medication list.',
      priority: 'critical',
      safetyNotes: 'Cross-check every refill against the current medication list. Never improvise.',
    },
    {
      name: 'Refill reminder',
      description: 'Notify family / office when prescriptions are running low.',
    },
    {
      name: 'Document refusals',
      description: 'If client refuses a medication, log it and notify the office.',
      priority: 'critical',
    },
  ],

  // ── IADL: Errands / transportation ──────────────────────
  'iadl.errands': [
    { name: 'Drive to medical appointment' },
    { name: 'Pharmacy pickup' },
    { name: 'Grocery shopping' },
    { name: 'Bank / post office errand' },
    { name: 'Companion outing (park, library, café)' },
  ],
};

/**
 * Return the starter templates for a given task category.
 * Returns an empty array for unknown categories so the caller can
 * render "no templates" without a null check.
 *
 * @param {string} categoryKey  e.g. 'adl.bathing'
 * @returns {TaskTemplate[]}
 */
export function getTemplatesForCategory(categoryKey) {
  if (!categoryKey) return [];
  return TEMPLATES_BY_CATEGORY[categoryKey] || [];
}

/**
 * Normalize a template into the shape that NewTaskForm submits when
 * the user clicks "Add task". Used by the Quick-add chip to populate
 * form state. Defaults match NewTaskForm's defaults so a single click
 * is enough to save without further editing.
 *
 * @param {string} categoryKey
 * @param {TaskTemplate} template
 * @returns {{
 *   category: string,
 *   taskName: string,
 *   description: string,
 *   shifts: string[],
 *   priority: string,
 *   safetyNotes: string,
 *   daysOfWeek: number[]
 * }}
 */
export function templateToFormState(categoryKey, template) {
  return {
    category: categoryKey,
    taskName: template.name || '',
    description: template.description || '',
    shifts: Array.isArray(template.shifts) && template.shifts.length > 0
      ? [...template.shifts]
      : ['all'],
    priority: template.priority || 'standard',
    safetyNotes: template.safetyNotes || '',
    daysOfWeek: [],
  };
}

// Exposed for tests + future settings UIs.
export const ALL_TEMPLATES_BY_CATEGORY = TEMPLATES_BY_CATEGORY;
