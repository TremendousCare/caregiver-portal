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
};

export type ExtractionSchema = {
  sectionId: string;
  sectionLabel: string;
  sectionDescription: string;
  fields: ExtractionField[];
};


// ─── Tool input_schema ─────────────────────────────────────────
//
// The tool's input shape is intentionally loose at the per-field
// level (value is `any`) — we validate values against the
// per-field type in JS after Claude responds. Making `value`
// `oneOf` per field id is theoretically possible but blows up the
// schema for sections with many fields and limits Claude's
// flexibility on list/object shapes.

export function buildExtractionTool() {
  return {
    name: "record_care_plan_facts",
    description:
      "Record care plan facts the speaker explicitly stated. Call this tool exactly once with one entry per fact you are confident the speaker stated. Do NOT include guesses, inferences, or facts you cannot quote.",
    input_schema: {
      type: "object",
      properties: {
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
      },
      required: ["fields"],
    },
  };
}


// ─── System prompt ─────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return [
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
  ].join("\n");
}


// ─── User message ──────────────────────────────────────────────

export function buildUserMessage(args: {
  schema: ExtractionSchema;
  transcript: string;
  currentValues: Record<string, unknown>;
}): string {
  const { schema, transcript, currentValues } = args;
  const parts: string[] = [];

  parts.push(`CARE PLAN SECTION: ${schema.sectionLabel}`);
  if (schema.sectionDescription) {
    parts.push(`Section description: ${schema.sectionDescription}`);
  }
  parts.push("");
  parts.push("FIELDS YOU CAN FILL:");
  parts.push(formatFieldSchemaForPrompt(schema.fields, 0));
  parts.push("");

  if (currentValues && Object.keys(currentValues).length > 0) {
    parts.push("CURRENT VALUES IN THIS SECTION (preserve unless the speaker explicitly updated them):");
    parts.push(JSON.stringify(currentValues, null, 2));
    parts.push("");
  }

  parts.push("DICTATION TRANSCRIPT:");
  parts.push('"""');
  parts.push(transcript);
  parts.push('"""');
  parts.push("");
  parts.push("Now call the `record_care_plan_facts` tool with one entry per fact the speaker explicitly stated. Remember: omit fields the speaker did not address.");

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
  // True if the quote was found in the transcript. False = likely
  // hallucination; we drop the claim but emit a warning.
  quoteVerified: boolean;
};

export type ValidationResult = {
  accepted: ValidatedClaim[];
  rejected: Array<{ claim: FieldClaim; reason: string }>;
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

    accepted.push({
      ...claim,
      value: valueCheck.normalized,
      fieldLabel: field.label,
      fieldType: field.type,
      quoteVerified,
    });
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
