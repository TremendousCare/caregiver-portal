// ═══════════════════════════════════════════════════════════════
// Care Plan Snapshot — Prompt Builder
//
// Pure function module (no Deno or Claude-specific imports) so it's
// importable by both the edge function (Deno) and Vitest (Node).
//
// Shape:
//   buildSnapshotPrompt({ versionData, tasks, clientDisplayName })
//     → { system, userMessage, summary }
//
// The snapshot is written for a caregiver meeting the client for the
// first time. It's shown on the client detail page to admin and
// caregiver users only (family sees a different, softer snapshot in
// the Communication Hub).
//
// The system prompt is the voice + hard rules.
// The user message carries the care plan data plus the structured
// "think then write" instructions that produce:
//   <analysis>…</analysis>
//   <snapshot>…</snapshot>
//   <gaps>…</gaps>
// The edge function parses those tags out of the response.
// ═══════════════════════════════════════════════════════════════


// Sections included in the user message. Mirrors the admin + caregiver
// tier in src/features/care-plans/sections.js — everything a caregiver
// meeting the client would benefit from knowing. `matchCriteria` is
// admin-only hiring data and deliberately excluded.
const CAREGIVER_VISIBLE_SECTIONS = [
  'whoTheyAre',
  'healthProfile',
  'cognitionBehavior',
  'dailyLiving',
  'homeAndLife',
  'dailyRhythm',
  'homeEnvironment',
  'careTeam',
  'goalsOrders',
];


// ── System prompt ─────────────────────────────────────────────

export const SNAPSHOT_SYSTEM_PROMPT = `You are an experienced geriatric care coordinator writing a narrative care snapshot for a caregiver meeting this client for the first time. Your goal is to help them see the whole person, not just a medical chart.

Voice: warm, professional, confident. You write like a human who has done this for 20 years — never clinical jargon for its own sake, never saccharine, never generic.

Hard rules:
- Never invent details not present in the source data
- Never use bullet points or section headers in the final snapshot
- If critical information is missing (e.g., allergies, emergency contact), note that explicitly rather than glossing over it
- Use the client's name, not "the client"`;


// ── User message builder ──────────────────────────────────────

const USER_MESSAGE_INSTRUCTIONS = `Before writing the snapshot, think through the client carefully inside <analysis> tags. Work through these questions in order:

1. Clinical priorities: What are the 3-4 most important health facts a caregiver must know on day one? Which conditions or medications carry the highest risk if mishandled?

2. Personhood: What non-clinical details best capture who this person is — their history, personality, what brings them joy, what they take pride in? What would a family member want the caregiver to know?

3. Daily reality: What does a good day look like for this client? What are their routines, preferences, communication style, food preferences, sleep patterns?

4. Tensions and nuance: Are there conflicts in the care plan (e.g., a food preference that clashes with a condition, family members who disagree on approach, stated independence vs. actual ability)? How should a caregiver navigate these?

5. Red flags: What specific changes in behavior, appetite, mobility, or mood should trigger escalation? What's normal for this person that might look concerning to someone who doesn't know them?

6. The through-line: If you could tell the caregiver only ONE thing about this client, what would it be? That thread should run through the whole snapshot.

7. Gaps: What important information is missing from the care plan that the caregiver should ask about?

Then write the care snapshot inside <snapshot> tags. It should be 400-600 words of flowing narrative prose — no headers, no bullets. Structure it naturally: who they are → their health picture → daily rhythms and preferences → what excellent care looks like for them specifically → what to watch for. Transitions should feel organic, not mechanical.

End with a brief <gaps> section listing any missing information the care team should collect.`;


/**
 * Render the care plan as a structured markdown block. This is what
 * gets substituted into the `<care_plan>…</care_plan>` wrapper in the
 * user message — one bullet per field, grouped by section, with the
 * care tasks appended at the end.
 */
export function buildCarePlanBlock({ versionData, tasks, clientDisplayName }) {
  const lines = [];

  for (const sectionId of CAREGIVER_VISIBLE_SECTIONS) {
    const sectionData = versionData?.[sectionId];
    if (!sectionData || !hasMeaningfulContent(sectionData)) continue;

    lines.push(`## ${labelForSection(sectionId)}`);
    for (const [fieldId, value] of Object.entries(sectionData)) {
      if (!isMeaningfulValue(value)) continue;
      lines.push(`- ${humanizeKey(fieldId)}: ${formatValue(value)}`);
    }
    lines.push('');
  }

  if (Array.isArray(tasks) && tasks.length > 0) {
    lines.push('## Care tasks');
    const byCategory = groupBy(tasks, (t) => t.category || 'other');
    for (const [category, categoryTasks] of Object.entries(byCategory)) {
      const names = categoryTasks
        .map((t) => t.taskName || t.task_name)
        .filter(Boolean);
      if (names.length === 0) continue;
      lines.push(`- ${labelForCategory(category)}: ${names.join('; ')}`);
    }
    lines.push('');
  }

  if (clientDisplayName) {
    lines.push(`(Preferred display name: ${clientDisplayName})`);
  }

  return lines.join('\n').trim();
}


/**
 * Build the full user message: data wrapped in `<care_plan>` tags,
 * followed by the analysis / snapshot / gaps instructions.
 */
export function buildUserMessage({ versionData, tasks, clientDisplayName }) {
  const carePlanBlock = buildCarePlanBlock({ versionData, tasks, clientDisplayName });
  return [
    "Here is the client's care plan data:",
    '<care_plan>',
    carePlanBlock || '(no care plan data populated yet)',
    '</care_plan>',
    '',
    USER_MESSAGE_INSTRUCTIONS,
  ].join('\n');
}


/**
 * Build the full prompt payload for a Claude request.
 */
export function buildSnapshotPrompt({ versionData, tasks, clientDisplayName }) {
  const userMessage = buildUserMessage({ versionData, tasks, clientDisplayName });

  const populatedSections = CAREGIVER_VISIBLE_SECTIONS
    .filter((id) => versionData?.[id] && hasMeaningfulContent(versionData[id]));

  const summary = {
    populatedSections,
    populatedSectionCount: populatedSections.length,
    taskCount: Array.isArray(tasks) ? tasks.length : 0,
    userMessageChars: userMessage.length,
  };

  return {
    system: SNAPSHOT_SYSTEM_PROMPT,
    userMessage,
    summary,
  };
}


// ── Response parsing ──────────────────────────────────────────

/**
 * Pull <snapshot> and <gaps> content out of the model's response.
 * Returns `{ narrative, gaps }`. If the model fails to use the
 * tags (shouldn't happen with this prompt, but guard anyway), fall
 * back to the full trimmed text as the narrative.
 */
export function parseSnapshotResponse(text) {
  if (typeof text !== 'string') return { narrative: '', gaps: '' };
  const narrative = extractTag(text, 'snapshot');
  const gaps = extractTag(text, 'gaps');
  if (narrative) return { narrative, gaps };
  // Fallback: no <snapshot> tag — use the whole response minus any
  // obvious scaffolding we can strip.
  const fallback = text
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<gaps>[\s\S]*?<\/gaps>/gi, '')
    .trim();
  return { narrative: fallback, gaps };
}

function extractTag(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}


// ── Helpers ───────────────────────────────────────────────────

function labelForSection(sectionId) {
  switch (sectionId) {
    case 'whoTheyAre':        return 'Who They Are';
    case 'healthProfile':     return 'Health Profile';
    case 'cognitionBehavior': return 'Cognition & Behavior';
    case 'dailyLiving':       return 'Daily Living (ADLs)';
    case 'homeAndLife':       return 'Home & Life (IADLs)';
    case 'dailyRhythm':       return 'Daily Rhythm';
    case 'homeEnvironment':   return 'Home Environment';
    case 'careTeam':          return 'Care Team';
    case 'goalsOrders':       return 'Goals & Orders';
    default:                  return sectionId;
  }
}

function labelForCategory(category) {
  return category
    .replace(/^adl\./, 'ADL — ')
    .replace(/^iadl\./, 'IADL — ')
    .replace(/_/g, ' ');
}

function humanizeKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function formatValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (v.length === 0) return '';
    if (typeof v[0] === 'object' && v[0] !== null) {
      return v
        .map((item) => Object.entries(item)
          .filter(([, val]) => isMeaningfulValue(val))
          .map(([k, val]) => `${humanizeKey(k)}=${String(val)}`)
          .join(' '))
        .filter((s) => s.length > 0)
        .join(' | ');
    }
    return v.join(', ');
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') {
    if ('answer' in v) {
      return v.note ? `${v.answer} (${v.note})` : String(v.answer || '');
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function isMeaningfulValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function hasMeaningfulContent(sectionData) {
  if (!sectionData || typeof sectionData !== 'object') return false;
  for (const v of Object.values(sectionData)) {
    if (isMeaningfulValue(v)) return true;
  }
  return false;
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}
