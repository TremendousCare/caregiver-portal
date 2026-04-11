import { describe, it, expect } from 'vitest';

// ─── caregiverNeedsResponse ───────────────────────────────────
// Test the needs-response detection logic inline (same algorithm as useCommsTimeline)

function caregiverNeedsResponse(notes) {
  const smsNotes = (notes || [])
    .filter((n) => n.type === 'text')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (smsNotes.length === 0) return false;
  const mostRecent = smsNotes[smsNotes.length - 1];
  if (mostRecent.direction !== 'inbound') return false;
  const age = Date.now() - new Date(mostRecent.timestamp).getTime();
  if (age > 7 * 24 * 60 * 60 * 1000) return false;
  return true;
}

describe('caregiverNeedsResponse', () => {
  it('returns false for empty notes', () => {
    expect(caregiverNeedsResponse([])).toBe(false);
  });

  it('returns false for null/undefined notes', () => {
    expect(caregiverNeedsResponse(null)).toBe(false);
    expect(caregiverNeedsResponse(undefined)).toBe(false);
  });

  it('returns false when no SMS notes exist', () => {
    const notes = [
      { type: 'note', text: 'Internal note', timestamp: Date.now() },
      { type: 'call', text: 'Phone call', timestamp: Date.now(), direction: 'inbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(false);
  });

  it('returns false when most recent SMS is outbound', () => {
    const notes = [
      { type: 'text', text: 'Hi there', timestamp: Date.now() - 60000, direction: 'inbound' },
      { type: 'text', text: 'Thanks for reaching out', timestamp: Date.now(), direction: 'outbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(false);
  });

  it('returns true when most recent SMS is inbound and recent', () => {
    const notes = [
      { type: 'text', text: 'We sent you info', timestamp: Date.now() - 120000, direction: 'outbound' },
      { type: 'text', text: 'Thanks! I have a question', timestamp: Date.now() - 60000, direction: 'inbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(true);
  });

  it('returns false when most recent inbound SMS is older than 7 days', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const notes = [
      { type: 'text', text: 'Old message', timestamp: eightDaysAgo, direction: 'inbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(false);
  });

  it('returns true when inbound SMS is exactly 6 days old', () => {
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const notes = [
      { type: 'text', text: 'Recent enough', timestamp: sixDaysAgo, direction: 'inbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(true);
  });

  it('handles mixed note types correctly — only considers SMS', () => {
    const notes = [
      { type: 'text', text: 'Inbound SMS', timestamp: Date.now() - 60000, direction: 'inbound' },
      { type: 'note', text: 'Internal note added after', timestamp: Date.now() },
      { type: 'call', text: 'Call made after', timestamp: Date.now(), direction: 'outbound' },
    ];
    // The internal note and call don't count as a response — still needs SMS reply
    expect(caregiverNeedsResponse(notes)).toBe(true);
  });

  it('handles single inbound SMS correctly', () => {
    const notes = [
      { type: 'text', text: 'I am interested in the position', timestamp: Date.now() - 3600000, direction: 'inbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(true);
  });

  it('handles single outbound SMS correctly', () => {
    const notes = [
      { type: 'text', text: 'Welcome! Please apply at...', timestamp: Date.now() - 3600000, direction: 'outbound' },
    ];
    expect(caregiverNeedsResponse(notes)).toBe(false);
  });
});

// ─── Date formatting helpers ──────────────────────────────────
// Testing the date separator logic from SMSConversationView

function formatDateLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today - messageDay) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function isDifferentDay(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return d1.getFullYear() !== d2.getFullYear()
    || d1.getMonth() !== d2.getMonth()
    || d1.getDate() !== d2.getDate();
}

describe('formatDateLabel', () => {
  it('returns "Today" for today\'s date', () => {
    expect(formatDateLabel(new Date().toISOString())).toBe('Today');
  });

  it('returns "Yesterday" for yesterday\'s date', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatDateLabel(yesterday.toISOString())).toBe('Yesterday');
  });

  it('returns formatted date for older dates', () => {
    const oldDate = new Date('2026-01-15T12:00:00Z');
    const result = formatDateLabel(oldDate.toISOString());
    expect(result).toContain('Jan');
    expect(result).toContain('15');
  });
});

describe('isDifferentDay', () => {
  it('returns false for same day timestamps', () => {
    const ts1 = new Date('2026-03-15T10:00:00Z').getTime();
    const ts2 = new Date('2026-03-15T14:00:00Z').getTime();
    expect(isDifferentDay(ts1, ts2)).toBe(false);
  });

  it('returns true for different day timestamps', () => {
    const ts1 = new Date('2026-03-15T23:00:00Z').getTime();
    const ts2 = new Date('2026-03-16T01:00:00Z').getTime();
    expect(isDifferentDay(ts1, ts2)).toBe(true);
  });

  it('returns true for different months', () => {
    const ts1 = new Date('2026-02-28T12:00:00Z').getTime();
    const ts2 = new Date('2026-03-01T12:00:00Z').getTime();
    expect(isDifferentDay(ts1, ts2)).toBe(true);
  });

  it('returns true for different years', () => {
    const ts1 = new Date('2025-12-31T12:00:00Z').getTime();
    const ts2 = new Date('2026-01-01T12:00:00Z').getTime();
    expect(isDifferentDay(ts1, ts2)).toBe(true);
  });
});

// ─── Timeline deduplication logic ─────────────────────────────

function deduplicateTimeline(portalNotes, rcEntries) {
  const portalEntries = portalNotes.map((n, i) => ({
    ...n,
    id: `portal-${i}`,
    source: n.source || 'portal',
    timestamp: n.timestamp || n.date,
  }));

  const portalOutboundTexts = portalEntries.filter(
    (n) => n.type === 'text' && n.direction === 'outbound' && n.source === 'portal'
  );
  const portalRCNotes = portalEntries.filter((n) => n.source === 'ringcentral');

  const deduped = rcEntries.filter((rc) => {
    const rcTime = new Date(rc.timestamp).getTime();
    if (rc.type === 'text' && rc.direction === 'outbound') {
      if (portalOutboundTexts.some((pn) => Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000)) return false;
    }
    if (portalRCNotes.some((pn) => {
      if (pn.type !== rc.type || pn.direction !== rc.direction) return false;
      return Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000;
    })) return false;
    return true;
  });

  return [...portalEntries, ...deduped].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

describe('deduplicateTimeline', () => {
  it('returns portal notes when no RC entries', () => {
    const notes = [
      { type: 'note', text: 'Test note', timestamp: Date.now() },
    ];
    const result = deduplicateTimeline(notes, []);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Test note');
  });

  it('returns RC entries when no portal notes', () => {
    const rcEntries = [
      { type: 'text', text: 'Hi', timestamp: new Date().toISOString(), direction: 'inbound' },
    ];
    const result = deduplicateTimeline([], rcEntries);
    expect(result).toHaveLength(1);
  });

  it('deduplicates outbound texts within 2-minute window', () => {
    const now = Date.now();
    const notes = [
      { type: 'text', text: 'Hello', timestamp: now, direction: 'outbound', source: 'portal' },
    ];
    const rcEntries = [
      { type: 'text', text: 'Hello', timestamp: new Date(now + 30000).toISOString(), direction: 'outbound' },
    ];
    const result = deduplicateTimeline(notes, rcEntries);
    // Should have only 1 entry (the portal one), RC duplicate removed
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('portal');
  });

  it('keeps RC entries outside 2-minute window', () => {
    const now = Date.now();
    const notes = [
      { type: 'text', text: 'Hello', timestamp: now, direction: 'outbound', source: 'portal' },
    ];
    const rcEntries = [
      { type: 'text', text: 'Different', timestamp: new Date(now + 180000).toISOString(), direction: 'outbound' },
    ];
    const result = deduplicateTimeline(notes, rcEntries);
    expect(result).toHaveLength(2);
  });

  it('deduplicates webhook-written inbound notes', () => {
    const now = Date.now();
    const notes = [
      { type: 'text', text: 'Inbound msg', timestamp: now, direction: 'inbound', source: 'ringcentral' },
    ];
    const rcEntries = [
      { type: 'text', text: 'Inbound msg', timestamp: new Date(now + 5000).toISOString(), direction: 'inbound' },
    ];
    const result = deduplicateTimeline(notes, rcEntries);
    expect(result).toHaveLength(1);
  });

  it('sorts merged results newest first', () => {
    const now = Date.now();
    const notes = [
      { type: 'note', text: 'Older', timestamp: now - 60000 },
      { type: 'note', text: 'Newer', timestamp: now },
    ];
    const result = deduplicateTimeline(notes, []);
    expect(result[0].text).toBe('Newer');
    expect(result[1].text).toBe('Older');
  });
});
