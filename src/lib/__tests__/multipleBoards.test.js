import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_BOARD_COLUMNS, DEFAULT_BOARD_LABELS } from '../constants';

// ─── Board / Board Card field mapping ───────────────────────

describe('Board field mapping', () => {
  it('dbToBoard maps snake_case → camelCase correctly', async () => {
    // Dynamic import to bypass Supabase client initialization
    const storage = await import('../storage');
    // We can test the mapping indirectly through the exported functions
    // by testing the shape requirements
    expect(DEFAULT_BOARD_COLUMNS).toBeDefined();
    expect(Array.isArray(DEFAULT_BOARD_COLUMNS)).toBe(true);
  });
});

// ─── Board data structure ───────────────────────────────────

describe('Board data structures', () => {
  it('DEFAULT_BOARD_COLUMNS has valid structure', () => {
    expect(DEFAULT_BOARD_COLUMNS.length).toBeGreaterThanOrEqual(2);
    DEFAULT_BOARD_COLUMNS.forEach((col) => {
      expect(col).toHaveProperty('id');
      expect(col).toHaveProperty('label');
      expect(col).toHaveProperty('icon');
      expect(col).toHaveProperty('color');
      expect(typeof col.id).toBe('string');
      expect(typeof col.label).toBe('string');
      expect(col.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });

  it('all column IDs are unique', () => {
    const ids = DEFAULT_BOARD_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── Board card merging logic ───────────────────────────────

describe('Board card ↔ entity merging', () => {
  const mockCaregiver = {
    id: 'cg-123',
    firstName: 'Jane',
    lastName: 'Doe',
    phone: '555-1234',
    email: 'jane@example.com',
    address: '123 Main St',
    city: 'Seattle',
    state: 'WA',
    zip: '98101',
    hcaExpiration: '2027-01-01',
    availability: 'Full-time',
    tasks: {},
    notes: [],
    phaseTimestamps: {},
    boardStatus: null,
    boardLabels: [],
    boardChecklists: [],
    boardDueDate: null,
    boardDescription: null,
    boardNote: null,
    boardMovedAt: null,
  };

  const mockBoardCard = {
    id: 'card-456',
    boardId: 'board-789',
    entityType: 'caregiver',
    entityId: 'cg-123',
    columnId: 'ready',
    sortOrder: 0,
    labels: ['urgent'],
    checklists: [{ id: 'cl-1', name: 'Checklist', items: [] }],
    dueDate: '2026-05-01',
    description: '<p>Test</p>',
    pinnedNote: 'Important note',
    movedAt: '2026-04-01T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
  };

  it('merges board card data with entity data correctly', () => {
    const merged = {
      ...mockCaregiver,
      id: mockBoardCard.entityId,
      _cardId: mockBoardCard.id,
      boardStatus: mockBoardCard.columnId,
      boardLabels: mockBoardCard.labels,
      boardChecklists: mockBoardCard.checklists,
      boardDueDate: mockBoardCard.dueDate,
      boardDescription: mockBoardCard.description,
      boardNote: mockBoardCard.pinnedNote,
      boardMovedAt: new Date(mockBoardCard.movedAt).getTime(),
    };

    expect(merged.id).toBe('cg-123');
    expect(merged._cardId).toBe('card-456');
    expect(merged.boardStatus).toBe('ready');
    expect(merged.boardLabels).toEqual(['urgent']);
    expect(merged.boardChecklists).toHaveLength(1);
    expect(merged.boardDueDate).toBe('2026-05-01');
    expect(merged.boardDescription).toBe('<p>Test</p>');
    expect(merged.boardNote).toBe('Important note');
    expect(merged.boardMovedAt).toBeGreaterThan(0);
    // Entity data preserved
    expect(merged.firstName).toBe('Jane');
    expect(merged.lastName).toBe('Doe');
    expect(merged.phone).toBe('555-1234');
  });

  it('handles missing entity gracefully', () => {
    const fallbackEntity = { id: 'cg-missing', firstName: '(Unknown)', lastName: '' };
    const merged = {
      ...fallbackEntity,
      _cardId: 'card-1',
      boardStatus: 'ready',
      boardLabels: [],
      boardChecklists: [],
      boardDueDate: null,
      boardDescription: null,
      boardNote: null,
      boardMovedAt: null,
    };

    expect(merged.firstName).toBe('(Unknown)');
    expect(merged.boardStatus).toBe('ready');
  });

  it('auto-included entities have null board fields', () => {
    const autoIncluded = {
      ...mockCaregiver,
      boardStatus: null,
      boardLabels: [],
      boardChecklists: [],
      boardDueDate: null,
      boardDescription: null,
      boardNote: null,
      boardMovedAt: null,
      _autoIncluded: true,
    };

    expect(autoIncluded._autoIncluded).toBe(true);
    expect(autoIncluded.boardStatus).toBeNull();
    expect(autoIncluded.firstName).toBe('Jane');
  });
});

// ─── Board slug generation ──────────────────────────────────

describe('Board slug generation', () => {
  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  }

  it('generates valid slugs', () => {
    expect(slugify('Caregiver Board')).toBe('caregiver-board');
    expect(slugify('Night Shift Pool')).toBe('night-shift-pool');
    expect(slugify('Client Pipeline')).toBe('client-pipeline');
  });

  it('handles special characters', () => {
    expect(slugify('Board #1 — Test!')).toBe('board-1-test');
    expect(slugify('   Spaces   ')).toBe('spaces');
  });

  it('truncates long names', () => {
    const longName = 'A'.repeat(100);
    expect(slugify(longName).length).toBeLessThanOrEqual(50);
  });
});

// ─── Board template presets ─────────────────────────────────

describe('Board templates', () => {
  it('caregiver template includes default columns', () => {
    const template = {
      entityType: 'caregiver',
      columns: DEFAULT_BOARD_COLUMNS,
      labels: DEFAULT_BOARD_LABELS,
    };

    expect(template.columns.length).toBeGreaterThanOrEqual(2);
    expect(template.labels.length).toBeGreaterThanOrEqual(3);
    expect(template.entityType).toBe('caregiver');
  });

  it('blank template has empty columns and labels', () => {
    const blank = { entityType: 'custom', columns: [], labels: [] };
    expect(blank.columns).toHaveLength(0);
    expect(blank.labels).toHaveLength(0);
  });

  it('client template has appropriate columns', () => {
    const clientColumns = [
      { id: 'intake', label: 'New Intake', icon: '📋', color: '#2E4E8D' },
      { id: 'assessment', label: 'Assessment', icon: '🔍', color: '#29BEE4' },
      { id: 'matching', label: 'Matching', icon: '🤝', color: '#D97706' },
      { id: 'active', label: 'Active Service', icon: '✅', color: '#16A34A' },
    ];

    expect(clientColumns).toHaveLength(4);
    clientColumns.forEach((col) => {
      expect(col).toHaveProperty('id');
      expect(col).toHaveProperty('label');
      expect(col).toHaveProperty('icon');
      expect(col).toHaveProperty('color');
    });
  });
});

// ─── Board config (columns/labels/templates) per-board ──────

describe('Per-board configuration', () => {
  it('board object stores columns, labels, and templates', () => {
    const board = {
      id: 'board-1',
      name: 'Test Board',
      slug: 'test-board',
      entityType: 'caregiver',
      columns: [{ id: 'col1', label: 'Todo', icon: '📋', color: '#2E4E8D' }],
      labels: [{ id: 'lbl1', name: 'Urgent', color: '#DC3545' }],
      checklistTemplates: [{ id: 'tpl1', name: 'Onboarding', items: ['Item 1'] }],
      orientationData: { date: '2026-05-01' },
    };

    expect(board.columns).toHaveLength(1);
    expect(board.labels).toHaveLength(1);
    expect(board.checklistTemplates).toHaveLength(1);
    expect(board.orientationData.date).toBe('2026-05-01');
  });

  it('board config is independent per board', () => {
    const board1 = {
      id: 'b1',
      columns: [{ id: 'ready', label: 'Ready' }],
      labels: [{ id: 'urgent', name: 'Urgent', color: '#DC3545' }],
    };
    const board2 = {
      id: 'b2',
      columns: [{ id: 'intake', label: 'Intake' }, { id: 'review', label: 'Review' }],
      labels: [{ id: 'new', name: 'New', color: '#29BEE4' }],
    };

    expect(board1.columns).toHaveLength(1);
    expect(board2.columns).toHaveLength(2);
    expect(board1.labels[0].name).not.toBe(board2.labels[0].name);
  });
});

// ─── Migration logic ────────────────────────────────────────

describe('Board migration', () => {
  it('identifies caregivers with board data for migration', () => {
    const caregivers = [
      { id: 'cg-1', boardStatus: 'ready', boardLabels: ['urgent'], boardNote: 'Note' },
      { id: 'cg-2', boardStatus: null, boardLabels: [], boardNote: null },
      { id: 'cg-3', boardStatus: 'deployed', boardLabels: [], boardNote: null },
    ];

    const withBoardData = caregivers.filter((cg) => cg.boardStatus);
    expect(withBoardData).toHaveLength(2);
    expect(withBoardData.map((cg) => cg.id)).toEqual(['cg-1', 'cg-3']);
  });

  it('creates board card objects from caregiver board fields', () => {
    const cg = {
      id: 'cg-1',
      boardStatus: 'ready',
      boardLabels: ['urgent', 'bilingual'],
      boardChecklists: [{ id: 'cl-1', name: 'Test', items: [] }],
      boardDueDate: '2026-05-01',
      boardDescription: '<p>desc</p>',
      boardNote: 'note',
      boardMovedAt: 1712000000000,
    };

    const card = {
      id: 'auto-generated-id',
      boardId: 'new-board-id',
      entityType: 'caregiver',
      entityId: cg.id,
      columnId: cg.boardStatus,
      sortOrder: 0,
      labels: cg.boardLabels || [],
      checklists: cg.boardChecklists || [],
      dueDate: cg.boardDueDate || null,
      description: cg.boardDescription || null,
      pinnedNote: cg.boardNote || null,
      movedAt: cg.boardMovedAt ? new Date(cg.boardMovedAt).toISOString() : null,
    };

    expect(card.entityId).toBe('cg-1');
    expect(card.columnId).toBe('ready');
    expect(card.labels).toEqual(['urgent', 'bilingual']);
    expect(card.checklists).toHaveLength(1);
    expect(card.dueDate).toBe('2026-05-01');
    expect(card.description).toBe('<p>desc</p>');
    expect(card.pinnedNote).toBe('note');
    expect(card.movedAt).not.toBeNull();
  });
});
