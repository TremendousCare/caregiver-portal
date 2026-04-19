import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_SYSTEM_PROMPT,
  buildSnapshotPrompt,
  buildUserMessage,
  buildCarePlanBlock,
  parseSnapshotResponse,
} from '../../../supabase/functions/care-plan-snapshot/prompt';

// ═══════════════════════════════════════════════════════════════
// Pure tests for the snapshot prompt builder + response parser.
// No Claude calls, no Deno globals.
//
// The snapshot is caregiver-facing (admin + caregiver tier). The
// user message wraps the care plan in <care_plan> tags and asks the
// model to produce <analysis>, <snapshot>, and <gaps> blocks.
// ═══════════════════════════════════════════════════════════════

describe('SNAPSHOT_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof SNAPSHOT_SYSTEM_PROMPT).toBe('string');
    expect(SNAPSHOT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('names the role (geriatric care coordinator)', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/geriatric care coordinator/i);
  });

  it('names the audience (caregiver meeting client for the first time)', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/caregiver/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/first time/i);
  });

  it('states the voice guidelines (warm, professional, confident)', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/warm/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/professional/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/confident/i);
  });

  it('includes the hard rules (no invention, no bullets, name not "the client")', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/never invent/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/bullet/i);
    expect(SNAPSHOT_SYSTEM_PROMPT).toMatch(/the client/i);
  });

  it('is deterministic — no dates, UUIDs, or per-render values', () => {
    expect(SNAPSHOT_SYSTEM_PROMPT).not.toMatch(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(SNAPSHOT_SYSTEM_PROMPT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(SNAPSHOT_SYSTEM_PROMPT).not.toMatch(/generated at/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildCarePlanBlock — the markdown chunk that goes inside <care_plan>
// ═══════════════════════════════════════════════════════════════

describe('buildCarePlanBlock', () => {
  it('returns empty string when no sections are populated', () => {
    const block = buildCarePlanBlock({ versionData: {}, tasks: [] });
    expect(block).toBe('');
  });

  it('renders admin + caregiver tier sections (clinical data included)', () => {
    const versionData = {
      snapshot: { narrative: 'Old AI text' },
      whoTheyAre: { fullName: 'Kevin' },
      healthProfile: { medications: [{ name: 'Lisinopril', dose: '10mg' }] },
      cognitionBehavior: { dementiaLevel: 'Mild' },
      matchCriteria: { match_gender: { flag: 'P' } },
      dailyLiving: { ambulation_mobilityLevel: 'Independent' },
      homeAndLife: { housekeeping_scope: 'Light' },
      dailyRhythm: { morningRoutine: 'Coffee' },
      homeEnvironment: { homeType: 'Single-family house' },
      careTeam: { pcpName: 'Dr. Chen' },
      goalsOrders: { careGoals: 'Safely recover' },
    };
    const block = buildCarePlanBlock({ versionData, tasks: [] });

    expect(block).toMatch(/## Who They Are/);
    expect(block).toMatch(/## Health Profile/);
    expect(block).toMatch(/## Cognition & Behavior/);
    expect(block).toMatch(/## Daily Living/);
    expect(block).toMatch(/## Home & Life/);
    expect(block).toMatch(/## Daily Rhythm/);
    expect(block).toMatch(/## Home Environment/);
    expect(block).toMatch(/## Care Team/);
    expect(block).toMatch(/## Goals & Orders/);

    // matchCriteria is admin-only hiring data — must NOT leak in.
    expect(block).not.toMatch(/## Caregiver Match Criteria/);
    expect(block).not.toMatch(/## Match Criteria/);
    // The snapshot section (the output) doesn't feed back as input.
    expect(block).not.toMatch(/## Snapshot/);
  });

  it('humanizes camelCase field ids into readable labels', () => {
    const versionData = {
      whoTheyAre: { pastProfession: 'Teacher', lifeContext: 'Widowed' },
    };
    const block = buildCarePlanBlock({ versionData, tasks: [] });
    expect(block).toMatch(/Past Profession: Teacher/);
    expect(block).toMatch(/Life Context: Widowed/);
  });

  it('renders arrays of primitives as comma-separated', () => {
    const versionData = {
      whoTheyAre: { languages: ['English', 'Spanish'] },
    };
    const block = buildCarePlanBlock({ versionData, tasks: [] });
    expect(block).toMatch(/Languages: English, Spanish/);
  });

  it('renders list-type fields (arrays of objects) with pipe separators', () => {
    const versionData = {
      healthProfile: {
        medications: [
          { name: 'Lisinopril', dose: '10mg', frequency: 'daily' },
          { name: 'Metformin', dose: '500mg' },
        ],
      },
    };
    const block = buildCarePlanBlock({ versionData, tasks: [] });
    expect(block).toMatch(/Lisinopril/);
    expect(block).toMatch(/Metformin/);
    expect(block).toMatch(/\|/); // pipe separator between rows
  });

  it('renders YN field values with their note', () => {
    const versionData = {
      dailyLiving: {
        ambulation_gaitBelt: { answer: 'Yes', note: 'Remove while seated' },
      },
    };
    const block = buildCarePlanBlock({ versionData, tasks: [] });
    expect(block).toMatch(/Yes \(Remove while seated\)/);
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
    const block = buildCarePlanBlock({ versionData, tasks: [] });
    expect(block).toMatch(/Full Name: Kevin/);
    expect(block).not.toMatch(/Preferred Name:/);
    expect(block).not.toMatch(/Religion:/);
    expect(block).not.toMatch(/Languages:/);
  });

  it('skips sections that have no meaningful content', () => {
    const versionData = {
      whoTheyAre: { fullName: 'Kevin' },
      dailyLiving: { ambulation_mobilityLevel: '' },
    };
    const block = buildCarePlanBlock({ versionData, tasks: [] });
    expect(block).toMatch(/## Who They Are/);
    expect(block).not.toMatch(/## Daily Living/);
  });

  it('renders task summary grouped by category', () => {
    const tasks = [
      { category: 'adl.bathing', taskName: 'Shower assist' },
      { category: 'adl.bathing', taskName: 'Dry off' },
      { category: 'iadl.housework', taskName: 'Vacuum' },
    ];
    const block = buildCarePlanBlock({ versionData: {}, tasks });
    expect(block).toMatch(/## Care tasks/);
    expect(block).toMatch(/Shower assist/);
    expect(block).toMatch(/Vacuum/);
    expect(block).toMatch(/ADL — bathing/);
    expect(block).toMatch(/IADL — housework/);
  });

  it('handles missing tasks array', () => {
    const block = buildCarePlanBlock({
      versionData: { whoTheyAre: { fullName: 'K' } },
    });
    expect(block).toMatch(/## Who They Are/);
    expect(block).not.toMatch(/## Care tasks/);
  });

  it('includes client display name when provided', () => {
    const block = buildCarePlanBlock({
      versionData: {},
      tasks: [],
      clientDisplayName: 'Kev',
    });
    expect(block).toMatch(/Kev/);
  });

  it('omits client display name line when not provided', () => {
    const block = buildCarePlanBlock({ versionData: {}, tasks: [] });
    expect(block).not.toMatch(/preferred display name/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildUserMessage — wraps the data block + writing instructions
// ═══════════════════════════════════════════════════════════════

describe('buildUserMessage', () => {
  it('wraps the care plan data in <care_plan> tags', () => {
    const msg = buildUserMessage({
      versionData: { whoTheyAre: { fullName: 'Kevin' } },
      tasks: [],
    });
    expect(msg).toMatch(/<care_plan>/);
    expect(msg).toMatch(/<\/care_plan>/);
    expect(msg).toMatch(/Kevin/);
  });

  it('falls back to a placeholder when no data is populated', () => {
    const msg = buildUserMessage({ versionData: {}, tasks: [] });
    expect(msg).toMatch(/<care_plan>/);
    expect(msg).toMatch(/no care plan data populated yet/i);
  });

  it('includes the analysis / snapshot / gaps instructions', () => {
    const msg = buildUserMessage({
      versionData: { whoTheyAre: { fullName: 'Kevin' } },
      tasks: [],
    });
    expect(msg).toMatch(/<analysis>/);
    expect(msg).toMatch(/<snapshot>/);
    expect(msg).toMatch(/<gaps>/);
    expect(msg).toMatch(/Clinical priorities/);
    expect(msg).toMatch(/Personhood/);
    expect(msg).toMatch(/Red flags/);
    expect(msg).toMatch(/through-line/);
  });

  it('specifies the 400-600 word length target', () => {
    const msg = buildUserMessage({ versionData: {}, tasks: [] });
    expect(msg).toMatch(/400-600 words/);
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

  it('summary tracks populated sections (admin + caregiver tier)', () => {
    const result = buildSnapshotPrompt({
      versionData: {
        whoTheyAre: { fullName: 'K' },
        healthProfile: { medications: [{ name: 'X', dose: '1mg' }] },
        dailyRhythm: { morningRoutine: 'coffee' },
        homeAndLife: {}, // empty — not counted
      },
      tasks: [{ category: 'adl.bathing', taskName: 'x' }],
    });
    expect(result.summary.populatedSections.sort()).toEqual(
      ['dailyRhythm', 'healthProfile', 'whoTheyAre'].sort(),
    );
    expect(result.summary.populatedSectionCount).toBe(3);
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
// System prompt stability — identical across calls
// ═══════════════════════════════════════════════════════════════

describe('System prompt stability', () => {
  it('system prompt is identical across calls', () => {
    const a = buildSnapshotPrompt({ versionData: {}, tasks: [] });
    const b = buildSnapshotPrompt({
      versionData: { whoTheyAre: { fullName: 'Different client' } },
      tasks: [{ category: 'adl.bathing', taskName: 'x' }],
    });
    expect(a.system).toBe(b.system);
    expect(a.system.length).toBe(b.system.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseSnapshotResponse — pulls narrative + gaps out of the tags
// ═══════════════════════════════════════════════════════════════

describe('parseSnapshotResponse', () => {
  it('extracts narrative from <snapshot> tags', () => {
    const raw = `<analysis>
Some thinking here.
</analysis>

<snapshot>
Kevin is 78, a retired Navy man...
</snapshot>

<gaps>
- No allergy info
</gaps>`;
    const { narrative, gaps } = parseSnapshotResponse(raw);
    expect(narrative).toBe('Kevin is 78, a retired Navy man...');
    expect(gaps).toBe('- No allergy info');
  });

  it('returns empty gaps when the tag is missing', () => {
    const raw = `<snapshot>
Kevin is 78.
</snapshot>`;
    const { narrative, gaps } = parseSnapshotResponse(raw);
    expect(narrative).toBe('Kevin is 78.');
    expect(gaps).toBe('');
  });

  it('falls back to full text (minus scaffolding) when <snapshot> is missing', () => {
    const raw = `<analysis>
Thinking
</analysis>

Kevin is 78. This is the narrative without a snapshot tag.

<gaps>
- Missing stuff
</gaps>`;
    const { narrative } = parseSnapshotResponse(raw);
    expect(narrative).toMatch(/Kevin is 78/);
    expect(narrative).not.toMatch(/Thinking/);
    expect(narrative).not.toMatch(/Missing stuff/);
  });

  it('handles non-string input gracefully', () => {
    expect(parseSnapshotResponse(null)).toEqual({ narrative: '', gaps: '' });
    expect(parseSnapshotResponse(undefined)).toEqual({ narrative: '', gaps: '' });
    expect(parseSnapshotResponse(123)).toEqual({ narrative: '', gaps: '' });
  });

  it('trims whitespace inside extracted tags', () => {
    const raw = `<snapshot>

    Kevin is 78.

  </snapshot>`;
    const { narrative } = parseSnapshotResponse(raw);
    expect(narrative).toBe('Kevin is 78.');
  });

  it('is case-insensitive on tag names', () => {
    const raw = `<SNAPSHOT>Kevin.</SNAPSHOT><Gaps>stuff</Gaps>`;
    const { narrative, gaps } = parseSnapshotResponse(raw);
    expect(narrative).toBe('Kevin.');
    expect(gaps).toBe('stuff');
  });
});
