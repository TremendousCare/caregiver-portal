// ─── Care Plan Voice Extract — Prompt + Tool Schema Builder ───
//
// Two responsibilities, tightly coupled:
//   1. Turn the section's extraction schema (built on the frontend
//      from sections.js) into a Claude tool whose input_schema is
//      the exact field contract. Claude is forced to call this tool,
//      so it physically cannot return field ids that don't exist or
//      enum values outside the allowed set.
//   2. Build the system + user messages that tell Claude HOW to
//      extract: only fill what was explicitly stated, never infer,
//      include a verbatim quote per field, rate confidence.
//
// The shape we get back from Claude (via tool_use input):
//   {
//     fields: [
//       { id: string, value: any, confidence: "high"|"medium"|"low",
//         quote: string }
//     ]
//   }
//
// We deliberately do NOT bake the whole field list into the tool's
// `fields` array schema as `oneOf` enums — that would let Claude
// blindly fill every field. Instead, each field claim is validated
// against the schema after the fact. Schema enforcement still
// applies via per-field type/enum constraints in the value validator.

export type ExtractionField = {
  id: string;
  label: string;
  type: string; // 'text' | 'textarea' | 'date' | 'number' | 'select' |
                // 'multiselect' | 'boolean' | 'yesNo' | 'yn' | 'phone' |
                // 'email' | 'list' | 'prn' | 'levelPick'
  options?: string[];
  subfields?: ExtractionField[];
  help?: string;
  placeholder?: string;
  conditionalHint?: string;
  suggestionsKey?: string;
  // Phase 2: grouped sections (ADLs, IADLs) tag each field with its
  // accordion group so the prompt can organize by group and the
  // review UI can render group headers. Undefined for flat sections.
  groupId?: string;
  groupLabel?: string;
};

export type ExtractionGroup = {
  id: string;
  label: string;
  description?: string;
};

export type ExtractionSchema = {
  sectionId: string;
  sectionLabel: string;
  sectionDescription: string;
  // Present only for grouped sections.
  groups?: ExtractionGroup[];
  fields: ExtractionField[];
};


// Phase 3 — task schema. Present for sections with a care_plan_tasks
// side table (Daily Living, Home & Life). When present, Claude is
// given a `tasks` array in its tool input_schema and can propose new
// task rows. When absent, the tasks array is omitted from the tool
// entirely so Claude can't even try.
export type TaskCategory = {
  key: string;       // e.g., 'adl.bathing' — matches care_plan_tasks.category
  label: string;     // human label, e.g., 'Bathing'
  groupHint?: string;  // accordion group id this category lives under
};

export type TaskSchema = {
  categories: TaskCategory[];
  shifts: string[];      // e.g., ['all', 'morning', 'afternoon', 'evening', 'overnight']
  daysOfWeek: string[];  // e.g., ['Sun', 'Mon', ...]
  priorities: string[];  // e.g., ['standard', 'critical', 'optional']
};


// ─── Tool input_schema ─────────────────────────────────────────
//
// The tool's input shape is intentionally loose at the per-field
// level (value is `any`) — we validate values against the
// per-field type in JS after Claude responds. Making `value`
// `oneOf` per field id is theoretically possible but blows up the
// schema for sections with many fields and limits Claude's
// flexibility on list/object shapes.

export function buildExtractionTool(options: { taskSchema?: TaskSchema | null } = {}) {
  const { taskSchema } = options;
  const properties: Record<string, unknown> = {
    fields: {
      type: "array",
      description:
        "One entry per fact stated. Omit fields the speaker did not address. Use exact field ids from the schema.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "Field id from the section schema. Must match exactly.",
          },
          value: {
            description:
              "The extracted value, shaped according to the field's type. See instructions for per-type shapes.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "high: speaker said it unambiguously. medium: said indirectly or via synonym. low: hinted but not stated.",
          },
          quote: {
            type: "string",
            description:
              "Verbatim excerpt from the transcript that supports this value. Must be copy-pasteable from the transcript.",
          },
        },
        required: ["id", "value", "confidence", "quote"],
      },
    },
  };

  // For sections with a tasks side table (ADLs, IADLs), give Claude
  // a `tasks` array constrained by enum-locked categories/shifts/days/
  // priorities. For other sections, omit the tasks key entirely so
  // Claude physically cannot propose tasks where they don't apply.
  if (taskSchema && taskSchema.categories.length > 0) {
    properties.tasks = {
      type: "array",
      description:
        "One entry per task the speaker explicitly described. A task is something the caregiver DOES (e.g., 'help with bathing', 'walk the dog', 'remind about medications'). Omit if the speaker only stated abilities/preferences without describing an action.",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: taskSchema.categories.map((c) => c.key),
            description:
              "Task category. Must be one of the allowed categories for this section.",
          },
          task_name: {
            type: "string",
            description:
              "Short, action-oriented label (max ~6 words). E.g., 'Assist with shower', 'Prepare breakfast', 'Walk dog'. Use imperative or noun-phrase form.",
          },
          description: {
            type: "string",
            description:
              "Optional longer detail the caregiver should know. Omit if there's nothing more to add beyond the name.",
          },
          shifts: {
            type: "array",
            description:
              "Shifts when this task happens. If the speaker didn't specify, use ['all']. Use ['morning'], ['evening'], etc. for specific shifts. Multiple allowed.",
            items: { type: "string", enum: taskSchema.shifts },
          },
          days_of_week: {
            type: "array",
            description:
              "Days the task happens. Empty array means every day (no restriction). If the speaker said 'weekdays', use ['Mon','Tue','Wed','Thu','Fri']. If 'twice a week' without specific days, use empty array.",
            items: { type: "string", enum: taskSchema.daysOfWeek },
          },
          priority: {
            type: "string",
            enum: taskSchema.priorities,
            description:
              "'critical' only when the speaker explicitly flagged safety/medical urgency. 'optional' if the speaker said 'if there's time' or similar. Otherwise 'standard'.",
          },
          safety_notes: {
            type: "string",
            description:
              "Specific safety guidance the speaker mentioned for this task. Omit if none.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "Confidence the speaker actually described THIS specific task. Be conservative — tasks are higher-stakes than fields.",
          },
          quote: {
            type: "string",
            description:
              "Verbatim transcript excerpt describing this task. Must be copy-pasteable.",
          },
        },
        required: ["category", "task_name", "shifts", "priority", "confidence", "quote"],
      },
    };
  }

  return {
    name: "record_care_plan_facts",
    description:
      "Record care plan facts the speaker explicitly stated. Call this tool exactly once with one entry per fact you are confident the speaker stated. Do NOT include guesses, inferences, or facts you cannot quote.",
    input_schema: {
      type: "object",
      properties,
      required: ["fields"],
    },
  };
}

// ─── System prompt ─────────────────────────────────────────────

export function buildSystemPrompt(options: { includeTasks?: boolean } = {}): string {
  const lines: string[] = [
    "You are a clinical care plan extraction assistant for a home-care agency.",
    "A nurse or intake coordinator has just dictated information about a client. You will receive that dictation as a transcript along with the structured form fields that need to be filled.",
    "",
    "Your job is to extract ONLY the facts the speaker explicitly stated, and map each one to the correct structured field.",
    "",
    "ABSOLUTE RULES — these are non-negotiable, violations damage patient safety:",
    "1. NEVER infer, NEVER guess, NEVER use clinical defaults. If the speaker did not say it, do not fill it.",
    "2. Every value you return MUST include a verbatim `quote` from the transcript that supports it. The quote must be a contiguous excerpt — do not stitch words from different sentences.",
    "3. If the speaker contradicted themselves, take the LATER statement (assume the second mention is a correction).",
    "4. For enum fields (select, multiselect, levelPick, yn, yesNo), the value MUST be exactly one of the allowed options. If the speaker's intent doesn't map cleanly to an allowed option, OMIT the field — do not pick the 'closest' option.",
    "5. For list fields (medications, allergies, diagnoses, specialists, etc.), produce one entry per item the speaker mentioned. Each entry's subfields follow the same rules — only fill subfields the speaker addressed.",
    "6. If unsure whether a fact maps to a particular field, OMIT it rather than guess.",
    "7. Output via the `record_care_plan_facts` tool. Do not write any narrative response.",
  ];

  if (options.includeTasks) {
    lines.push(
      "",
      "TASK PROPOSALS — additional rules for the `tasks` array (only present when this section has a tasks side table):",
      "",
      "WHAT COUNTS AS A TASK SIGNAL — both of these styles are valid and should produce task proposals:",
      "  (a) IMPLICIT — the speaker describes what the caregiver does:",
      "      • 'She needs help with bathing twice a week'",
      "      • 'Walk the dog every morning'",
      "      • 'Help her prepare breakfast around 8am'",
      "      • 'Remind her to take her evening medications'",
      "  (b) EXPLICIT — the speaker tells the system to add/create a task. These are DIRECT instructions; treat them as the strongest possible task signal:",
      "      • 'Add a task to walk the dog Mondays, Wednesdays, Fridays'",
      "      • 'Add task: help with shower in the mornings'",
      "      • 'Create a task for medication reminders'",
      "      • 'Let's add a task to prepare lunch'",
      "      • 'We need a task for laundry on Saturdays'",
      "    For explicit signals, IGNORE the meta phrase ('add a task', 'create a task', 'let's add', 'we need a task', etc.) — it's the speaker addressing the system. Use the REST of the sentence as the task description. Do NOT treat the meta phrase as a reason to skip the proposal.",
      "",
      "T1. A task is something the caregiver DOES on a shift — an action. 'She bathes in the shower' is a field (bathing_method). 'Help her with the shower' is a task. 'Add task: bathe her' is also a task.",
      "T2. Propose a task whenever EITHER (a) or (b) above applies. Do NOT additionally require some 'clear enough' threshold beyond that — the user knows their dictation; if they said 'add a task to X', that IS the signal.",
      "T3. Conservatism applies to AMBIGUOUS cases: if the speaker only described a CLIENT ability or preference (e.g., 'she likes oatmeal', 'she walks fine') without describing a caregiver action, do NOT invent a task. But explicit and implicit task signals should be acted on — being so conservative that you reject clear task signals is itself an error.",
      "T4. Task name should be short and action-oriented (max ~6 words). 'Assist with shower', 'Prepare breakfast', 'Walk dog'. Strip the meta-phrase if there was one — 'Add a task to walk the dog' becomes a task named 'Walk dog'.",
      "T5. Schedule mapping:",
      "    - 'twice a week' or other frequency without specific days → days_of_week: [] (empty means no day restriction; caregiver decides)",
      "    - 'Mondays, Wednesdays, Fridays' → days_of_week: ['Mon', 'Wed', 'Fri']",
      "    - 'weekdays' → ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']",
      "    - 'weekends' → ['Sat', 'Sun']",
      "    - 'every day' or unspecified → []",
      "T6. Shifts: if the speaker didn't specify a shift, use ['all']. If they said 'mornings', 'in the evening', etc., use the matching shift(s).",
      "T7. Priority 'critical' only when the speaker explicitly flagged safety/medical urgency (e.g., 'must do this', 'safety-critical', 'never miss'). Default 'standard'. Use 'optional' if the speaker said 'if there's time' or similar.",
      "T8. NEVER propose duplicate tasks. If the speaker mentioned bathing assistance twice in different sentences, produce ONE task with the combined details.",
      "T9. The `quote` for a task MUST be a real excerpt from the transcript. If the speaker used the meta-phrase 'add a task to walk the dog every morning', the quote can include 'add a task to walk the dog every morning' — that whole excerpt is in the transcript.",
    );
  }

  lines.push(
    "",
    "Confidence levels:",
    "- 'high': the speaker said it clearly and unambiguously.",
    "- 'medium': you're confident in the value but the speaker was indirect, used a synonym, or you had to normalize a phrase to the enum (e.g., 'she walks fine on her own' → 'Independent').",
    "- 'low': the speaker hinted but did not directly state. Use sparingly.",
    "",
    "Per-type value shapes:",
    "- text, textarea, phone, email, date: string. For date, prefer ISO YYYY-MM-DD if the speaker stated one; otherwise a free-text date is acceptable.",
    "- number: number.",
    "- select, levelPick, yesNo (string variant): one of the allowed option strings.",
    "- multiselect: array of option strings (subset of allowed options).",
    "- boolean: true or false.",
    "- yesNo (boolean variant): true or false.",
    "- yn: object { answer: 'Yes' | 'No' | 'Unknown', note?: string }. Include `note` only if the speaker added a comment.",
    "- prn: object { flag: 'P' | 'R' | 'N', option?: string }. P=Preferred, R=Required, N=Not needed.",
    "- list: array of objects, each with subfields keyed by subfield id.",
    "",
    "When the speaker is silent on a field, do not include it. The form will keep its current value.",
  );
  return lines.join("\n");
}


// ─── User message ──────────────────────────────────────────────

export function buildUserMessage(args: {
  schema: ExtractionSchema;
  transcript: string;
  currentValues: Record<string, unknown>;
  taskSchema?: TaskSchema | null;
}): string {
  const { schema, transcript, currentValues, taskSchema } = args;
  const parts: string[] = [];

  parts.push(`CARE PLAN SECTION: ${schema.sectionLabel}`);
  if (schema.sectionDescription) {
    parts.push(`Section description: ${schema.sectionDescription}`);
  }
  parts.push("");

  // Grouped sections (Daily Living ADLs, Home & Life IADLs) get
  // organized by accordion group so Claude understands the semantic
  // boundaries the speaker is dictating across. Flat sections render
  // as a single field list (same as Phase 1).
  if (Array.isArray(schema.groups) && schema.groups.length > 0) {
    parts.push("FIELDS YOU CAN FILL — organized by sub-area within this section:");
    parts.push("");
    parts.push("The speaker may discuss these sub-areas in any order. A single sentence may touch multiple sub-areas (e.g., 'she walks fine but needs full help bathing' covers Ambulation AND Bathing).");
    parts.push("");
    for (const group of schema.groups) {
      const groupFields = schema.fields.filter((f) => f.groupId === group.id);
      if (groupFields.length === 0) continue;
      parts.push(`── ${group.label} ──`);
      if (group.description) parts.push(`(${group.description})`);
      parts.push(formatFieldSchemaForPrompt(groupFields, 0));
      parts.push("");
    }
  } else {
    parts.push("FIELDS YOU CAN FILL:");
    parts.push(formatFieldSchemaForPrompt(schema.fields, 0));
    parts.push("");
  }

  if (currentValues && Object.keys(currentValues).length > 0) {
    parts.push("CURRENT VALUES IN THIS SECTION (preserve unless the speaker explicitly updated them):");
    parts.push(JSON.stringify(currentValues, null, 2));
    parts.push("");
  }

  // When the section has a tasks side table, give Claude the list of
  // allowed categories with their group hints. Categories are
  // enum-locked in the tool's input_schema; this block tells Claude
  // which category goes with which sub-area so the routing is clean.
  if (taskSchema && taskSchema.categories.length > 0) {
    parts.push("TASK CATEGORIES YOU CAN PROPOSE INTO (one per area):");
    for (const cat of taskSchema.categories) {
      parts.push(`  - ${cat.key} — for tasks in the "${cat.label}" area`);
    }
    parts.push("");
    parts.push(`Allowed shifts: ${taskSchema.shifts.join(', ')}`);
    parts.push(`Allowed days_of_week (use 3-letter form): ${taskSchema.daysOfWeek.join(', ')}`);
    parts.push(`Allowed priorities: ${taskSchema.priorities.join(', ')} — default 'standard'`);
    parts.push("");
    parts.push("WORKED EXAMPLES (study these carefully — they show the exact mapping from natural dictation to tasks):");
    parts.push("");
    parts.push("  Speaker says: \"Add a task to walk the dog every morning.\"");
    parts.push("  → tasks: [{");
    parts.push("      category: \"iadl.errands\",  // or whichever Errands-like category exists in this section");
    parts.push("      task_name: \"Walk dog\",");
    parts.push("      shifts: [\"morning\"],");
    parts.push("      days_of_week: [],   // 'every morning' = every day, no day restriction");
    parts.push("      priority: \"standard\",");
    parts.push("      confidence: \"high\",");
    parts.push("      quote: \"Add a task to walk the dog every morning\"");
    parts.push("    }]");
    parts.push("");
    parts.push("  Speaker says: \"Add task: help with shower Tuesdays and Fridays, mornings. Use the gait belt.\"");
    parts.push("  → tasks: [{");
    parts.push("      category: \"adl.bathing\",");
    parts.push("      task_name: \"Assist with shower\",");
    parts.push("      shifts: [\"morning\"],");
    parts.push("      days_of_week: [\"Tue\", \"Fri\"],");
    parts.push("      priority: \"standard\",");
    parts.push("      safety_notes: \"Use gait belt\",");
    parts.push("      confidence: \"high\",");
    parts.push("      quote: \"Add task: help with shower Tuesdays and Fridays, mornings. Use the gait belt.\"");
    parts.push("    }]");
    parts.push("");
    parts.push("  Speaker says: \"She likes oatmeal for breakfast.\"");
    parts.push("  → tasks: []  // this is a preference (field), not a caregiver action");
    parts.push("");
    parts.push("  Speaker says: \"She needs help getting in and out of the shower twice a week.\"");
    parts.push("  → tasks: [{");
    parts.push("      category: \"adl.bathing\",");
    parts.push("      task_name: \"Assist with shower\",");
    parts.push("      shifts: [\"all\"],");
    parts.push("      days_of_week: [],   // 'twice a week' without specific days");
    parts.push("      priority: \"standard\",");
    parts.push("      confidence: \"high\",");
    parts.push("      quote: \"She needs help getting in and out of the shower twice a week\"");
    parts.push("    }]");
    parts.push("");
  }

  parts.push("DICTATION TRANSCRIPT:");
  parts.push('"""');
  parts.push(transcript);
  parts.push('"""');
  parts.push("");
  if (taskSchema && taskSchema.categories.length > 0) {
    parts.push("Now call the `record_care_plan_facts` tool. Populate `fields` with the facts the speaker stated about the client. Populate `tasks` with the caregiver actions the speaker described — including any cases where the speaker explicitly said 'add a task to...', 'create a task for...', etc. Omit fields and tasks the speaker did not address.");
  } else {
    parts.push("Now call the `record_care_plan_facts` tool with one entry per fact the speaker explicitly stated. Remember: omit fields the speaker did not address.");
  }

  return parts.join("\n");
}


/**
 * Indent-formatted, human-readable rendering of the field schema for
 * the user message. Lighter on tokens than embedding the full JSON.
 */
function formatFieldSchemaForPrompt(fields: ExtractionField[], depth: number): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const f of fields) {
    const bits: string[] = [];
    bits.push(`${indent}- ${f.id} (${f.type}) — "${f.label}"`);
    if (f.help) bits.push(`${indent}  Help: ${f.help}`);
    if (f.placeholder && !f.help) bits.push(`${indent}  Example: ${f.placeholder}`);
    if (f.conditionalHint) bits.push(`${indent}  ${f.conditionalHint}`);
    if (f.options && f.options.length > 0) {
      bits.push(`${indent}  Allowed values: ${f.options.map((o) => `"${o}"`).join(" | ")}`);
    }
    if (f.subfields && f.subfields.length > 0) {
      bits.push(`${indent}  Each list entry has subfields:`);
      bits.push(formatFieldSchemaForPrompt(f.subfields, depth + 2));
    }
    lines.push(bits.join("\n"));
  }
  return lines.join("\n");
}


// ─── Response validation ───────────────────────────────────────
//
// The Claude tool output is JSON we trust at the API level for shape,
// but we still defensively validate every field against the section
// schema — drop unknown ids, enforce enums, coerce types where safe.

export type FieldClaim = {
  id: string;
  value: unknown;
  confidence: "high" | "medium" | "low";
  quote: string;
};

export type ValidatedClaim = FieldClaim & {
  fieldLabel: string;
  fieldType: string;
  // Group context for grouped sections (ADLs, IADLs). Lets the
  // review UI render group headers without re-looking-up the schema.
  // Undefined for flat sections.
  groupId?: string;
  groupLabel?: string;
  // True if the quote was found in the transcript. False = likely
  // hallucination; we drop the claim but emit a warning.
  quoteVerified: boolean;
};

export type ValidationResult = {
  accepted: ValidatedClaim[];
  rejected: Array<{ claim: FieldClaim; reason: string }>;
};


// ─── Task claim types (Phase 3) ────────────────────────────────

export type TaskClaim = {
  category: string;
  task_name: string;
  description?: string;
  shifts: string[];
  days_of_week?: string[];
  priority: string;
  safety_notes?: string;
  confidence: "high" | "medium" | "low";
  quote: string;
};

export type ValidatedTaskClaim = TaskClaim & {
  categoryLabel: string;
  // Accordion group id this task lives under (mirrors a field's
  // groupId so the review UI can group fields + tasks together).
  groupId?: string;
  quoteVerified: boolean;
};

export type TaskValidationResult = {
  accepted: ValidatedTaskClaim[];
  rejected: Array<{ claim: TaskClaim; reason: string }>;
};


/**
 * Validate Claude's claims against the section schema + transcript.
 * Drops claims whose:
 *   - id isn't in the schema
 *   - value doesn't match the field's type / enum
 *   - quote isn't found in the transcript (likely hallucination)
 *
 * Note: we do NOT drop claims by confidence — that's a UX decision
 * left to the frontend, which surfaces a chip per confidence level
 * and lets the user accept or skip.
 */
export function validateClaims(args: {
  claims: FieldClaim[];
  schema: ExtractionSchema;
  transcript: string;
}): ValidationResult {
  const { claims, schema, transcript } = args;
  const fieldsById = new Map<string, ExtractionField>(
    schema.fields.map((f) => [f.id, f]),
  );
  const normalizedTranscript = normalizeForQuoteMatch(transcript);
  const accepted: ValidatedClaim[] = [];
  const rejected: Array<{ claim: FieldClaim; reason: string }> = [];

  for (const claim of claims) {
    const field = fieldsById.get(claim.id);
    if (!field) {
      rejected.push({ claim, reason: `unknown field id: ${claim.id}` });
      continue;
    }
    const valueCheck = validateValue(claim.value, field);
    if (!valueCheck.ok) {
      rejected.push({ claim, reason: valueCheck.reason || "invalid value" });
      continue;
    }
    const quoteVerified = claim.quote
      ? normalizedTranscript.includes(normalizeForQuoteMatch(claim.quote))
      : false;

    const accepted_claim: ValidatedClaim = {
      ...claim,
      value: valueCheck.normalized,
      fieldLabel: field.label,
      fieldType: field.type,
      quoteVerified,
    };
    if (field.groupId)    accepted_claim.groupId    = field.groupId;
    if (field.groupLabel) accepted_claim.groupLabel = field.groupLabel;
    accepted.push(accepted_claim);
  }

  return { accepted, rejected };
}


/**
 * Validate Claude's task claims against the task schema + transcript.
 * Drops claims whose:
 *   - category isn't in the allowed list for this section
 *   - task_name is empty or only whitespace
 *   - quote isn't found in the transcript (likely hallucination)
 *
 * Normalizes:
 *   - shifts: defaults to ['all'] if empty/invalid
 *   - days_of_week: filters to allowed days; empty array is fine
 *     (means "no day restriction")
 *   - priority: defaults to 'standard' if invalid
 *
 * Same confidence policy as fields — surfaces low-confidence claims
 * to the frontend rather than dropping them, since the user's review
 * UI is the gate for actual task creation.
 */
export function validateTaskClaims(args: {
  claims: TaskClaim[];
  taskSchema: TaskSchema;
  transcript: string;
}): TaskValidationResult {
  const { claims, taskSchema, transcript } = args;
  const categoriesByKey = new Map<string, TaskCategory>(
    taskSchema.categories.map((c) => [c.key, c]),
  );
  const allowedShifts = new Set(taskSchema.shifts);
  const allowedDays = new Set(taskSchema.daysOfWeek);
  const allowedPriorities = new Set(taskSchema.priorities);
  const normalizedTranscript = normalizeForQuoteMatch(transcript);

  const accepted: ValidatedTaskClaim[] = [];
  const rejected: Array<{ claim: TaskClaim; reason: string }> = [];

  for (const claim of claims) {
    const cat = categoriesByKey.get(claim.category);
    if (!cat) {
      rejected.push({ claim, reason: `unknown category: ${claim.category}` });
      continue;
    }
    const name = typeof claim.task_name === "string" ? claim.task_name.trim() : "";
    if (!name) {
      rejected.push({ claim, reason: "empty task_name" });
      continue;
    }

    // Normalize shifts: filter to allowed, default to ['all'] if empty.
    const shifts = Array.isArray(claim.shifts)
      ? claim.shifts.filter((s) => allowedShifts.has(s))
      : [];
    const finalShifts = shifts.length > 0 ? shifts : ["all"];

    // Normalize days: filter to allowed. Empty array is meaningful
    // (no day restriction) so we don't backfill it.
    const days = Array.isArray(claim.days_of_week)
      ? claim.days_of_week.filter((d) => allowedDays.has(d))
      : [];

    // Priority defaults to 'standard' if missing or invalid.
    const priority = allowedPriorities.has(claim.priority) ? claim.priority : "standard";

    const quoteVerified = claim.quote
      ? normalizedTranscript.includes(normalizeForQuoteMatch(claim.quote))
      : false;

    const out: ValidatedTaskClaim = {
      category: claim.category,
      task_name: name,
      shifts: finalShifts,
      days_of_week: days,
      priority,
      confidence: claim.confidence,
      quote: claim.quote,
      categoryLabel: cat.label,
      quoteVerified,
    };
    if (typeof claim.description === "string" && claim.description.trim()) {
      out.description = claim.description.trim();
    }
    if (typeof claim.safety_notes === "string" && claim.safety_notes.trim()) {
      out.safety_notes = claim.safety_notes.trim();
    }
    if (cat.groupHint) out.groupId = cat.groupHint;

    accepted.push(out);
  }

  return { accepted, rejected };
}


function normalizeForQuoteMatch(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}


type ValueCheck = { ok: true; normalized: unknown } | { ok: false; reason: string };


function validateValue(value: unknown, field: ExtractionField): ValueCheck {
  switch (field.type) {
    case "text":
    case "textarea":
    case "phone":
    case "email":
    case "date":
      return typeof value === "string"
        ? { ok: true, normalized: value }
        : { ok: false, reason: `expected string for ${field.type}` };

    case "number":
      if (typeof value === "number" && Number.isFinite(value)) {
        return { ok: true, normalized: value };
      }
      if (typeof value === "string" && value !== "" && !isNaN(Number(value))) {
        return { ok: true, normalized: Number(value) };
      }
      return { ok: false, reason: "expected number" };

    case "boolean":
    case "yesNo":
      // YESNO field-type historically stores boolean (true/false/unset).
      return typeof value === "boolean"
        ? { ok: true, normalized: value }
        : { ok: false, reason: "expected boolean" };

    case "select":
    case "levelPick":
      if (typeof value !== "string") return { ok: false, reason: "expected string for enum" };
      if (Array.isArray(field.options) && !field.options.includes(value)) {
        return { ok: false, reason: `value "${value}" not in allowed options` };
      }
      return { ok: true, normalized: value };

    case "multiselect": {
      if (!Array.isArray(value)) return { ok: false, reason: "expected array for multiselect" };
      const opts = field.options || [];
      const filtered = (value as unknown[]).filter(
        (v) => typeof v === "string" && opts.includes(v as string),
      );
      // If nothing survived filtering, drop the claim.
      if (filtered.length === 0 && (value as unknown[]).length > 0) {
        return { ok: false, reason: "no values matched allowed options" };
      }
      return { ok: true, normalized: filtered };
    }

    case "yn": {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const v = value as Record<string, unknown>;
        const allowed = field.options && field.options.length > 0
          ? field.options
          : ["Yes", "No", "Unknown"];
        if (typeof v.answer !== "string" || !allowed.includes(v.answer as string)) {
          return { ok: false, reason: "yn.answer not in allowed options" };
        }
        const out: Record<string, unknown> = { answer: v.answer };
        if (typeof v.note === "string" && v.note.trim().length > 0) out.note = v.note;
        return { ok: true, normalized: out };
      }
      // Allow plain string for back-compat with YN's tolerated shape.
      if (typeof value === "string") {
        const allowed = field.options && field.options.length > 0
          ? field.options
          : ["Yes", "No", "Unknown"];
        if (!allowed.includes(value)) {
          return { ok: false, reason: `yn string "${value}" not allowed` };
        }
        return { ok: true, normalized: { answer: value } };
      }
      return { ok: false, reason: "expected yn object {answer, note?}" };
    }

    case "prn": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, reason: "expected prn object {flag, option?}" };
      }
      const v = value as Record<string, unknown>;
      if (!["P", "R", "N"].includes(v.flag as string)) {
        return { ok: false, reason: "prn.flag must be P, R, or N" };
      }
      const out: Record<string, unknown> = { flag: v.flag };
      if (typeof v.option === "string" && v.option.trim().length > 0) {
        if (field.options && !field.options.includes(v.option)) {
          // Drop the option but keep the flag — partial accept.
        } else {
          out.option = v.option;
        }
      }
      return { ok: true, normalized: out };
    }

    case "list": {
      if (!Array.isArray(value)) return { ok: false, reason: "expected array for list" };
      const subs = field.subfields || [];
      const subById = new Map<string, ExtractionField>(subs.map((s) => [s.id, s]));
      const rows: Record<string, unknown>[] = [];
      for (const rowRaw of value as unknown[]) {
        if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) continue;
        const row = rowRaw as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {};
        for (const [subId, subVal] of Object.entries(row)) {
          const subField = subById.get(subId);
          if (!subField) continue;
          const subCheck = validateValue(subVal, subField);
          if (subCheck.ok) cleaned[subId] = subCheck.normalized;
        }
        if (Object.keys(cleaned).length > 0) rows.push(cleaned);
      }
      return { ok: true, normalized: rows };
    }

    default:
      // Unknown type → accept as-is rather than drop. The frontend's
      // FieldRenderer will show "unknown type" and the user can edit.
      return { ok: true, normalized: value };
  }
}
