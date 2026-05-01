// ─── Post-conversation helpers ───
//
// Pure functions extracted from the legacy `ai-chat/index.ts` so both the
// `index_legacy.ts` rollback sibling and the new `shell.ts` runtime path
// can share them. Neutral imports only — directly importable from Vitest
// in Node for the shell unit tests.
//
// Phase 0.4: factored out as part of the cutover. Behaviour identical to
// the previous in-file definitions; the byte-equal Layer B parity
// fixtures + the new `aiChatShell.test.js` cover the contract.

/**
 * Map a tool name to the `events.event_type` used by post-conversation
 * observability. Returns null for tools whose execution does not warrant
 * an event row (read-only tools).
 */
export function toolNameToEventType(toolName: string): string | null {
  const map: Record<string, string> = {
    add_note: "note_added",
    update_phase: "phase_changed",
    complete_task: "task_completed",
    update_caregiver_field: "caregiver_updated",
    update_board_status: "board_status_changed",
    send_sms: "sms_sent",
    send_email: "email_sent",
    send_docusign_envelope: "docusign_sent",
    create_calendar_event: "calendar_event_created",
    update_calendar_event: "calendar_event_updated",
    add_client_note: "note_added",
    update_client_phase: "phase_changed",
    complete_client_task: "task_completed",
    update_client_field: "client_updated",
  };
  return map[toolName] || null;
}

// Intent patterns for topic categorization
const INTENT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(follow[- ]?up|stale|inactive|hasn'?t responded|no response)\b/i, label: "Follow-up" },
  { pattern: /\b(schedul|interview|calendar|meeting|appointment|availability)\b/i, label: "Scheduling" },
  { pattern: /\b(compliance|compliant|document|missing doc|hca|license|certification)\b/i, label: "Compliance" },
  { pattern: /\b(text|sms|send message|message them)\b/i, label: "SMS outreach" },
  { pattern: /\b(email|send email|inbox)\b/i, label: "Email" },
  { pattern: /\b(docusign|envelope|sign|signature)\b/i, label: "DocuSign" },
  { pattern: /\b(pipeline|stats|summary|overview|how many|report)\b/i, label: "Pipeline review" },
  { pattern: /\b(phase|move to|advance|update phase)\b/i, label: "Phase change" },
  { pattern: /\b(onboard|orient|training)\b/i, label: "Onboarding" },
  { pattern: /\b(client|family|patient|care recipient)\b/i, label: "Client management" },
  { pattern: /\b(call|phone|ring)\b/i, label: "Call review" },
];

/**
 * Extract conversation topics from the message stack for `context_snapshots`.
 * Pure — no I/O.
 */
export function extractTopics(
  messages: any[],
  caregivers?: any[],
  clients?: any[],
): Array<{ topic: string; status?: string }> {
  const topics: Array<{ topic: string; status?: string }> = [];
  const seen = new Set<string>();

  // Build a set of known entity names for matching
  const entityNames = new Set<string>();
  for (const cg of (caregivers || [])) {
    if (cg.first_name) entityNames.add(cg.first_name.toLowerCase());
    if (cg.first_name && cg.last_name) {
      entityNames.add(`${cg.first_name} ${cg.last_name}`.toLowerCase());
    }
  }
  for (const cl of (clients || [])) {
    if (cl.first_name) entityNames.add(cl.first_name.toLowerCase());
    if (cl.first_name && cl.last_name) {
      entityNames.add(`${cl.first_name} ${cl.last_name}`.toLowerCase());
    }
  }

  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const content = msg.content;

    // Detect intent
    let intent = "";
    for (const { pattern, label } of INTENT_PATTERNS) {
      if (pattern.test(content)) {
        intent = label;
        break;
      }
    }

    // Detect entity names mentioned
    const contentLower = content.toLowerCase();
    const mentionedEntities: string[] = [];
    for (const name of entityNames) {
      if (name.includes(" ") && contentLower.includes(name)) {
        // Full name match — prefer over first name
        const capitalized = name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        mentionedEntities.push(capitalized);
      }
    }
    // Fall back to first-name matches if no full name matched
    if (mentionedEntities.length === 0) {
      for (const name of entityNames) {
        if (!name.includes(" ") && contentLower.includes(name)) {
          mentionedEntities.push(name.charAt(0).toUpperCase() + name.slice(1));
        }
      }
    }

    // Build topic string
    let topic: string;
    const uniqueEntities = [...new Set(mentionedEntities)].slice(0, 2);
    if (intent && uniqueEntities.length > 0) {
      topic = `${intent}: ${uniqueEntities.join(", ")}`;
    } else if (intent) {
      topic = intent;
    } else if (uniqueEntities.length > 0) {
      topic = `Discussed: ${uniqueEntities.join(", ")}`;
    } else {
      // Fallback: first sentence, capped at 60 chars
      const firstSentence = content.split(/[.!?\n]/)[0].trim();
      topic = firstSentence.length > 60 ? firstSentence.slice(0, 60) + "..." : firstSentence;
    }

    if (!seen.has(topic)) {
      seen.add(topic);
      topics.push({ topic, status: "discussed" });
    }
  }

  return topics.slice(-5);
}
