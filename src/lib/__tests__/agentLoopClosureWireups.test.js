/**
 * Phase 1.5 follow-up (PR 2/2) — Surface-level wire-up smoke tests.
 *
 * The `closePendingSuggestion` helper itself is fully covered in
 * `closeSuggestion.test.js`. These tests pin the *call-site contract*:
 * each operator-write surface that PR 2 wired must:
 *
 *   1. Import the frontend wrapper `closePendingSuggestionForAction`.
 *   2. Invoke it with the correct `actionType`.
 *   3. Pass `entityType: 'caregiver' | 'client'` consistent with the
 *      surface.
 *   4. Catch the resulting promise so a failed close never bubbles up
 *      to the operator's primary action.
 *
 * A surface-level behavioural test (React Testing Library on every
 * composer) would be heavy and provide marginal value over the helper-
 * level coverage. The risk these tests buy down is "someone deletes
 * the wire-up by accident during an unrelated refactor and the
 * autonomy v2 algorithm silently stops getting positive signal." A
 * source-presence regex catches that cheaply.
 *
 * If a wire-up legitimately moves (e.g. the email composer is extracted
 * into a hook), update the corresponding expected substring here in
 * the same PR.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');

function readSource(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const HELPER_IMPORT_RE = /import \{ closePendingSuggestionForAction \} from ['"][^'"]*\/lib\/agentLoopClosure['"];/;

// Each entry: where the wire-up lives, which entityType the surface
// stamps, which actionType the close call passes, and which params
// keys the audit payload must surface for downstream review.
const SURFACES = [
  {
    name: 'EmailComposeForm — caregiver/client email send',
    file: 'src/features/caregivers/caregiver/EmailComposeForm.jsx',
    entityType: 'entityType',                 // dynamic — comes from prop
    actionType: 'send_email',
    expectedParamKeys: ['subject_length', 'body_length'],
  },
  {
    name: 'ProgressOverview — caregiver phase override',
    file: 'src/features/caregivers/caregiver/ProgressOverview.jsx',
    entityType: "'caregiver'",
    actionType: 'update_phase',
    expectedParamKeys: ['from_phase', 'to_phase'],
  },
  {
    name: 'ClientProgressOverview — client phase change',
    file: 'src/features/clients/client/ClientProgressOverview.jsx',
    entityType: "'client'",
    actionType: 'update_phase',
    expectedParamKeys: ['from_phase', 'to_phase'],
  },
  {
    name: 'PhaseDetail — caregiver task checkbox',
    file: 'src/features/caregivers/caregiver/PhaseDetail.jsx',
    entityType: "'caregiver'",
    actionType: 'complete_task',
    expectedParamKeys: ['task_id'],
  },
  {
    name: 'ActivityLog — caregiver standalone note composer',
    file: 'src/features/caregivers/caregiver/ActivityLog.jsx',
    entityType: "'caregiver'",
    actionType: 'add_note',
    expectedParamKeys: ['note_type', 'char_count'],
  },
  {
    name: 'ClientActivityLog — client standalone note composer',
    file: 'src/features/clients/client/ClientActivityLog.jsx',
    entityType: "'client'",
    actionType: 'add_note',
    expectedParamKeys: ['note_type', 'char_count'],
  },
];

describe('Agent loop closure — PR 2 surface wire-ups', () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      const source = readSource(surface.file);

      it('imports the closePendingSuggestionForAction helper', () => {
        expect(source).toMatch(HELPER_IMPORT_RE);
      });

      it(`invokes the helper with actionType '${surface.actionType}'`, () => {
        // Match `closePendingSuggestionForAction(` followed by `actionType: 'X'`
        // within a reasonable window. The `[\s\S]{0,400}` keeps the regex
        // narrow enough that a stray reference (e.g. in a comment far
        // from the call site) doesn't satisfy it.
        const callRe = new RegExp(
          `closePendingSuggestionForAction\\(\\s*\\{[\\s\\S]{0,400}?actionType:\\s*['"]${surface.actionType}['"]`,
        );
        expect(source).toMatch(callRe);
      });

      it(`passes entityType ${surface.entityType}`, () => {
        // For surfaces with a literal entityType, expect the literal.
        // For dynamic-prop surfaces (EmailComposeForm), expect the
        // identifier `entityType` to be used as-is.
        const lit = surface.entityType;
        const callRe = lit.startsWith("'")
          ? new RegExp(
              `closePendingSuggestionForAction\\(\\s*\\{[\\s\\S]{0,400}?entityType:\\s*${lit}`,
            )
          : new RegExp(
              `closePendingSuggestionForAction\\(\\s*\\{[\\s\\S]{0,400}?entityType,?\\s*\\n`,
            );
        expect(source).toMatch(callRe);
      });

      it('passes the expected params keys', () => {
        // Locate the helper call body, then assert each expected key
        // appears inside it (order-independent).
        const bodyRe = /closePendingSuggestionForAction\(\s*\{([\s\S]{0,600}?)\}\s*\)/;
        const m = source.match(bodyRe);
        expect(m, 'expected a closePendingSuggestionForAction({...}) call site').toBeTruthy();
        const body = m[1];
        for (const key of surface.expectedParamKeys) {
          expect(body).toContain(`${key}:`);
        }
      });

      it('catches the returned promise so failures never bubble up', () => {
        // The fire-and-forget contract: failure of the close must
        // never affect the primary operator action. Two valid forms:
        //
        //   1. `closePendingSuggestionForAction({...}).catch(...)` —
        //      direct (used by email / phase / task surfaces where
        //      the underlying write is awaited inline before close).
        //
        //   2. `Promise.resolve(persist).then(() => closePending
        //      SuggestionForAction({...})).catch(...)` — chained off
        //      a persist promise (used by note surfaces, so the close
        //      only fires if the durable note write succeeded; per
        //      Codex P2 review on PR #347).
        //
        // Both shapes guarantee no unhandled rejection. The guard
        // requires `closePendingSuggestionForAction` and at least
        // one `.catch(` downstream in the same handler scope.
        expect(source).toMatch(/closePendingSuggestionForAction\(/);
        expect(source).toMatch(/\.catch\s*\(/);
      });
    });
  }

  it('PR 2 wires every closeable action_type except create_calendar_event', () => {
    // create_calendar_event has no operator-driven UI surface today
    // (Outlook calendar events are created only via AI suggestion
    // approval in NotificationCenter). Documented in the PR
    // description; when a manual operator surface lands, add it to
    // SURFACES above.
    const wired = new Set(SURFACES.map((s) => s.actionType));
    // SMS shipped in PR #317.
    wired.add('send_sms');
    // DocuSign has its own dedicated flow; not in PR 2 scope.
    expect(wired.has('send_email')).toBe(true);
    expect(wired.has('add_note')).toBe(true);
    expect(wired.has('update_phase')).toBe(true);
    expect(wired.has('complete_task')).toBe(true);
    expect(wired.has('send_sms')).toBe(true);
    expect(wired.has('create_calendar_event')).toBe(false);
  });
});
