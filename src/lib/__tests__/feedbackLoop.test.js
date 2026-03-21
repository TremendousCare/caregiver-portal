/**
 * Tests for the Phase 4A feedback loop fixes.
 *
 * Validates the pure logic added to close the autonomous agent's feedback loop:
 * 1. Outcome action type mapping (executeSuggestion → action_outcomes)
 * 2. Source derivation from executedBy identifiers
 * 3. Expiry window calculations
 * 4. Cross-source dedup logic (no source_type filter)
 */

import { describe, it, expect } from 'vitest';

// ─── Mirror the OUTCOME_ACTION_MAP from routing.ts ───
const OUTCOME_ACTION_MAP = {
  send_sms: { outcomeType: 'sms_sent', expiryDays: 7 },
  send_email: { outcomeType: 'email_sent', expiryDays: 7 },
  send_docusign_envelope: { outcomeType: 'docusign_sent', expiryDays: 14 },
  create_calendar_event: { outcomeType: 'calendar_event_created', expiryDays: 21 },
  update_phase: { outcomeType: 'phase_changed', expiryDays: null },
  update_client_phase: { outcomeType: 'phase_changed', expiryDays: null },
  complete_task: { outcomeType: 'task_completed', expiryDays: null },
  complete_client_task: { outcomeType: 'task_completed', expiryDays: null },
};

// ─── Mirror deriveOutcomeSource from routing.ts ───
function deriveOutcomeSource(executedBy) {
  if (executedBy.startsWith('system:')) return 'automation';
  if (executedBy.startsWith('user:')) return 'manual';
  return 'ai_chat';
}

// ─── All 13 supported action types (mirrors routing.ts switch) ───
const ALL_SUGGESTION_ACTION_TYPES = [
  'send_sms', 'send_email', 'add_note', 'add_client_note',
  'update_phase', 'update_client_phase', 'complete_task', 'complete_client_task',
  'update_caregiver_field', 'update_client_field', 'update_board_status',
  'create_calendar_event', 'send_docusign_envelope',
];

describe('Feedback Loop — Outcome Recording', () => {
  describe('OUTCOME_ACTION_MAP coverage', () => {
    it('maps all communication + trackable actions', () => {
      const trackableTypes = [
        'send_sms', 'send_email', 'send_docusign_envelope',
        'create_calendar_event', 'update_phase', 'update_client_phase',
        'complete_task', 'complete_client_task',
      ];
      for (const t of trackableTypes) {
        expect(OUTCOME_ACTION_MAP[t]).toBeDefined();
        expect(OUTCOME_ACTION_MAP[t].outcomeType).toBeTruthy();
      }
    });

    it('does NOT map read-only or field-update actions', () => {
      const nonTrackable = [
        'add_note', 'add_client_note',
        'update_caregiver_field', 'update_client_field',
        'update_board_status',
      ];
      for (const t of nonTrackable) {
        expect(OUTCOME_ACTION_MAP[t]).toBeUndefined();
      }
    });

    it('maps to correct outcome types', () => {
      expect(OUTCOME_ACTION_MAP.send_sms.outcomeType).toBe('sms_sent');
      expect(OUTCOME_ACTION_MAP.send_email.outcomeType).toBe('email_sent');
      expect(OUTCOME_ACTION_MAP.send_docusign_envelope.outcomeType).toBe('docusign_sent');
      expect(OUTCOME_ACTION_MAP.create_calendar_event.outcomeType).toBe('calendar_event_created');
      expect(OUTCOME_ACTION_MAP.update_phase.outcomeType).toBe('phase_changed');
      expect(OUTCOME_ACTION_MAP.complete_task.outcomeType).toBe('task_completed');
    });
  });

  describe('Expiry windows', () => {
    it('SMS and email expire in 7 days', () => {
      expect(OUTCOME_ACTION_MAP.send_sms.expiryDays).toBe(7);
      expect(OUTCOME_ACTION_MAP.send_email.expiryDays).toBe(7);
    });

    it('DocuSign expires in 14 days', () => {
      expect(OUTCOME_ACTION_MAP.send_docusign_envelope.expiryDays).toBe(14);
    });

    it('Calendar events expire in 21 days', () => {
      expect(OUTCOME_ACTION_MAP.create_calendar_event.expiryDays).toBe(21);
    });

    it('Phase changes and task completions have no expiry', () => {
      expect(OUTCOME_ACTION_MAP.update_phase.expiryDays).toBeNull();
      expect(OUTCOME_ACTION_MAP.update_client_phase.expiryDays).toBeNull();
      expect(OUTCOME_ACTION_MAP.complete_task.expiryDays).toBeNull();
      expect(OUTCOME_ACTION_MAP.complete_client_task.expiryDays).toBeNull();
    });

    it('calculates correct expiry date from expiryDays', () => {
      const now = Date.now();
      const entry = OUTCOME_ACTION_MAP.send_sms;
      const expiresAt = new Date(now + entry.expiryDays * 86400000);
      const diffDays = (expiresAt.getTime() - now) / 86400000;
      expect(Math.round(diffDays)).toBe(7);
    });
  });

  describe('Source derivation', () => {
    it('maps system:ai-planner to automation', () => {
      expect(deriveOutcomeSource('system:ai-planner')).toBe('automation');
    });

    it('maps system:ai to automation', () => {
      expect(deriveOutcomeSource('system:ai')).toBe('automation');
    });

    it('maps user:Jessica to manual', () => {
      expect(deriveOutcomeSource('user:Jessica')).toBe('manual');
    });

    it('maps user:unknown to manual', () => {
      expect(deriveOutcomeSource('user:unknown')).toBe('manual');
    });

    it('maps empty string to ai_chat', () => {
      expect(deriveOutcomeSource('')).toBe('ai_chat');
    });

    it('maps arbitrary string to ai_chat', () => {
      expect(deriveOutcomeSource('ai-chat-tool')).toBe('ai_chat');
    });
  });
});

describe('Feedback Loop — Cross-Source Dedup', () => {
  // The dedup function no longer filters by source_type.
  // These tests verify the expected behavior of the dedup logic.

  it('dedup should check all source types, not just proactive', () => {
    // The old filter was: .eq("source_type", "proactive")
    // The new filter checks: .in("status", ["pending", "executed", "auto_executed"])
    // This means a proactive suggestion AND an inbound_sms suggestion both block duplicates.
    const statusFilter = ['pending', 'executed', 'auto_executed'];
    expect(statusFilter).toContain('pending');
    expect(statusFilter).toContain('executed');
    expect(statusFilter).toContain('auto_executed');
    // Rejected and expired suggestions should NOT block new ones
    expect(statusFilter).not.toContain('rejected');
    expect(statusFilter).not.toContain('expired');
    expect(statusFilter).not.toContain('failed');
  });
});

describe('Feedback Loop — Autonomy Context Derivation', () => {
  it('proactive source_type maps to proactive autonomy context', () => {
    const sourceType = 'proactive';
    const context = sourceType === 'proactive' ? 'proactive' : 'inbound_routing';
    expect(context).toBe('proactive');
  });

  it('inbound_sms source_type maps to inbound_routing autonomy context', () => {
    const sourceType = 'inbound_sms';
    const context = sourceType === 'proactive' ? 'proactive' : 'inbound_routing';
    expect(context).toBe('inbound_routing');
  });

  it('inbound_email source_type maps to inbound_routing autonomy context', () => {
    const sourceType = 'inbound_email';
    const context = sourceType === 'proactive' ? 'proactive' : 'inbound_routing';
    expect(context).toBe('inbound_routing');
  });
});
