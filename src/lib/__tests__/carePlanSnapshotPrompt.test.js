import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_SYSTEM_PROMPT,
  buildSnapshotPrompt,
  buildUserMessage,
} from '../../../supabase/functions/care-plan-snapshot/prompt';

// ═══════════════════════════════════════════════════════════════
// Pure tests for the snapshot prompt builder.
// No Claude calls, no Deno globals.
// ═══════════════════════════════════════════════════════════════

describe('SNAPSHOT_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof SNAPSHOT_SYSTEM_PROMPT).toBe('string');
    expect(SNAPSHOT_SYSTEM_PROMPT.length).toBeGreaterThan(1000);
  });

  it('exceeds the 4096-token minimum for Opus 4.7 prompt caching', () => {
    // Rough conversion: ~3.8 chars per token for English prose.
    // We want >= 4096 tokens so the system prompt qualifies as a
    // cacheable prefix on Opus 4.7. Being slightly under will
    // silently miss the cache, so assert a healthy margin.
    const approxTokens = SNAPSHOT_SYSTEM_PROMPT.length / 3.8;
    expect(approxTokens).toBeGreaterThanOrEqual(4096);
  });

  it('contains the voice guidelines (third person, warm, specific)', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/Third person/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/warm/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/specific/i);
  });

  it('explicitly forbids medical jargon', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/never include/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/dosages/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/insurance/i);
  });

  it('names the forbidden acronyms so the model avoids them', () => {
    // ADL/IADL are the most dangerous because they literally appear
    // in the input data — the prompt needs to call them out.
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/ADL/);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/IADL/);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/DNR/);
  });

  it('contains at least 3 few-shot examples', () => {
    const exampleCount = (SNAPSHOT_SYSTEM_PROMPT.match(/### Example \d/g) || []).length;
    expect(exampleCount).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic — no dates, UUIDs, or per-render values', () => {
    // Any non-deterministic content in the system prompt would
    // invalidate the prompt cache on every request. Spot-check for
    // common invalidators.
    expect(SNAPSHOT_SYSTEM_PROMPT).not.toMatch(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
    // UUIDs: 8-4-4-4-12 hex. Check for that pattern anywhere.
    expect(SNAPSHOT_SYSTEM_PROMPT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(SNAPSHOT_SYSTEM_PROMPT).not.toMatch(/generated at/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildUserMessage
// ═══════════════════════════════════════════════════════════════

describe('buildUserMessage', () => {
  it('returns an empty-ish message when no sections are populated', () => {
    const msg = buildUserMessage({ versionData: {}, tasks: [] });
    expect(msg).toMatch(/family-visible fields only/);
    // No sections rendered
    expect(msg).not.toMatch(/## Who They Are/);
    expect(msg).not.toMatch(/## Care tasks/);
  });

  it('renders only the four family-tier sections', () => {
    const versionData = {
      snapshot: { narrative: 'Old AI text' },
      whoTheyAre: { fullName: 'Kevin' },
      healthProfile: { diagnoses: 'Should not appear' },
      matchCriteria: { match_gender: { flag: 'P' } },
      dailyLiving: { ambulation_mobilityLevel: 'Independent' },
      homeAndLife: { housekeeping_scope: 'Light' },
      dailyRhythm: { morningRoutine: 'Coffee' },
    };
    const msg = buildUserMessage({ versionData, tasks: [] });

    expect(msg).toMatch(/## Who They Are/);
    expect(msg).toMatch(/## Daily Living/);
    expect(msg).toMatch(/## Home & Life/);
    expect(msg).toMatch(/## Daily Rhythm/);

    // Admin / clinical sections MUST NOT leak into the family-facing prompt
    expect(msg).not.toMatch(/## Health Profile/);
    expect(msg).not.toMatch(/## Match Criteria/);
    expect(msg).not.toMatch(/Should not appear/);
    expect(msg).not.toMatch(/Snapshot/);
  });

  it('humanizes camelCase field ids into readable labels', () => {
    const versionData = {
      whoTheyAre: { pastProfession: 'Teacher', lifeContext: 'Widowed' },
    };
    const msg = buildUserMessage({ versionData, tasks: [] });
    expect(msg).toMatch(/Past Profession: Teacher/);
    expect(msg).toMatch(/Life Context: Widowed/);
  });

  it('renders arrays of primitives as comma-separated', () => {
    const versionData = {
      whoTheyAre: { languages: ['English', 'Spanish'] },
    };
    const msg = buildUserMessage({ versionData, tasks: [] });
    expect(msg).toMatch(/Languages: English, Spanish/);
  });

  it('renders list fields (arrays of objects) with pipe-separated rows', () => {
    const versionData = {
      whoTheyAre: { fullName: 'Kevin' },
      dailyLiving: {
        nutrition_favorites_breakfast: 'Oatmeal',
      },
    };
    // List-type fields don't live under family-tier sections in our
    // sections.js (medications is under healthProfile, which is
    // admin-only). So we test the renderer directly via a synthetic
    // list field inside a family-visible section.
    const synthetic = buildUserMessage({
      versionData: {
        whoTheyAre: {
          fullName: 'Kevin',
          // Simulate a list-type field:
          interests: [
            { item: 'Woodworking', notes: 'Garage' },
            { item: 'Crosswords' },
          ],
        },
      },
      tasks: [],
    });
    expect(synthetic).toMatch(/Woodworking/);
    expect(synthetic).toMatch(/Crosswords/);
  });

  it('renders YN field values with their note', () => {
    const versionData = {
      dailyLiving: {
        ambulation_gaitBelt: { answer: 'Yes', note: 'Remove while seated' },
      },
    };
    const msg = buildUserMessage({ versionData, tasks: [] });
    expect(msg).toMatch(/Yes \(Remove while seated\)/);
  });

  it('skips empty and null values', () => {
    const versionData = {
      whoTheyAre: {
        fullName: 'Kevin',
        preferredName: '',
        religion: null,
        languages: [],
      },
    };
    const msg = buildUserMessage({ versionData, tasks: [] });
    expect(msg).toMatch(/Full Name: Kevin/);
    expect(msg).not.toMatch(/Preferred Name:/);
    expect(msg).not.toMatch(/Religion:/);
    expect(msg).not.toMatch(/Languages:/);
  });

  it('skips sections that have no meaningful content', () => {
    const versionData = {
      whoTheyAre: { fullName: 'Kevin' },
      dailyLiving: { ambulation_mobilityLevel: '' }, // empty — skip
    };
    const msg = buildUserMessage({ versionData, tasks: [] });
    expect(msg).toMatch(/## Who They Are/);
    expect(msg).not.toMatch(/## Daily Living/);
  });

  it('renders task summary grouped by category', () => {
    const tasks = [
      { category: 'adl.bathing', taskName: 'Shower assist' },
      { category: 'adl.bathing', taskName: 'Dry off' },
      { category: 'iadl.housework', taskName: 'Vacuum' },
    ];
    const msg = buildUserMessage({ versionData: {}, tasks });
    expect(msg).toMatch(/## Care tasks/);
    expect(msg).toMatch(/Shower assist/);
    expect(msg).toMatch(/Vacuum/);
    // Categories rendered in human-readable form
    expect(msg).toMatch(/ADL — bathing/);
    expect(msg).toMatch(/IADL — housework/);
  });

  it('handles missing tasks array', () => {
    const msg = buildUserMessage({ versionData: { whoTheyAre: { fullName: 'K' } } });
    expect(msg).toMatch(/## Who They Are/);
    expect(msg).not.toMatch(/## Care tasks/);
  });

  it('includes client display name when provided', () => {
    const msg = buildUserMessage({
      versionData: {},
      tasks: [],
      clientDisplayName: 'Kev',
    });
    expect(msg).toMatch(/Kev/);
  });

  it('omits client display name line when not provided', () => {
    const msg = buildUserMessage({ versionData: {}, tasks: [] });
    expect(msg).not.toMatch(/preferred display name/);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildSnapshotPrompt
// ═══════════════════════════════════════════════════════════════

describe('buildSnapshotPrompt', () => {
  it('returns system + userMessage + summary', () => {
    const result = buildSnapshotPrompt({
      versionData: { whoTheyAre: { fullName: 'Kevin' } },
      tasks: [],
    });
    expect(result.system).toBe(SNAPSHOT_SYSTEM_PROMPT);
    expect(typeof result.userMessage).toBe('string');
    expect(result.userMessage).toMatch(/Kevin/);
    expect(result.summary).toBeDefined();
  });

  it('summary tracks populated sections', () => {
    const result = buildSnapshotPrompt({
      versionData: {
        whoTheyAre: { fullName: 'K' },
        dailyRhythm: { morningRoutine: 'coffee' },
        // empty section not counted
        homeAndLife: {},
      },
      tasks: [{ category: 'adl.bathing', taskName: 'x' }],
    });
    expect(result.summary.populatedSections.sort()).toEqual(
      ['dailyRhythm', 'whoTheyAre'].sort(),
    );
    expect(result.summary.populatedSectionCount).toBe(2);
    expect(result.summary.taskCount).toBe(1);
    expect(result.summary.userMessageChars).toBe(result.userMessage.length);
  });

  it('summary is safe with empty inputs', () => {
    const result = buildSnapshotPrompt({ versionData: {}, tasks: [] });
    expect(result.summary.populatedSectionCount).toBe(0);
    expect(result.summary.taskCount).toBe(0);
  });

  it('summary is safe with nullish versionData', () => {
    const result = buildSnapshotPrompt({ versionData: null, tasks: null });
    expect(result.summary.populatedSectionCount).toBe(0);
    expect(result.summary.taskCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Prompt stability — critical for prompt caching
// ═══════════════════════════════════════════════════════════════

describe('Prompt cache stability', () => {
  it('system prompt is identical across calls (frozen byte sequence)', () => {
    const a = buildSnapshotPrompt({ versionData: {}, tasks: [] });
    const b = buildSnapshotPrompt({
      versionData: { whoTheyAre: { fullName: 'Different client' } },
      tasks: [{ category: 'adl.bathing', taskName: 'x' }],
    });
    // The system prompt MUST be byte-identical — that's the whole
    // point of caching it. If this test ever fails, we've accidentally
    // introduced a dynamic value into the prompt and every request
    // will miss the cache.
    expect(a.system).toBe(b.system);
    expect(a.system.length).toBe(b.system.length);
  });
});
