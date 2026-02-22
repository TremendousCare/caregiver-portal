import { describe, it, expect } from 'vitest';

// ── Pure functions extracted for testing ──

function calculateConfidence(sampleSize) {
  if (sampleSize >= 100) return 0.85;
  if (sampleSize >= 30) return 0.6;
  return 0; // Below threshold, no memory created
}

function calculateSuccessRate(outcomes) {
  if (!outcomes || outcomes.length === 0) return 0;
  const successes = outcomes.filter(
    o => o.outcome_type === 'response_received' || o.outcome_type === 'completed'
  ).length;
  return Math.round((successes / outcomes.length) * 100);
}

function calculateAvgResponseHours(outcomes) {
  const times = outcomes
    .filter(o => o.outcome_detail?.hours_to_outcome)
    .map(o => o.outcome_detail.hours_to_outcome);
  if (times.length === 0) return null;
  return Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10;
}

function shouldCreateMemory(sampleSize) {
  return sampleSize >= 30;
}

function buildMemoryContent(actionType, successRate, total, avgHours) {
  const label = actionType.replace(/_/g, ' ');
  let content = `${label}: ${successRate}% success rate (${total} observations)`;
  if (avgHours) content += `. Average response time: ${avgHours} hours`;
  return content;
}

// ── Tests ──

describe('Outcome Tracking — Confidence Calculation', () => {
  it('returns 0 for fewer than 30 data points', () => {
    expect(calculateConfidence(0)).toBe(0);
    expect(calculateConfidence(10)).toBe(0);
    expect(calculateConfidence(29)).toBe(0);
  });

  it('returns 0.6 for 30-99 data points (preliminary)', () => {
    expect(calculateConfidence(30)).toBe(0.6);
    expect(calculateConfidence(50)).toBe(0.6);
    expect(calculateConfidence(99)).toBe(0.6);
  });

  it('returns 0.85 for 100+ data points (established)', () => {
    expect(calculateConfidence(100)).toBe(0.85);
    expect(calculateConfidence(500)).toBe(0.85);
  });
});

describe('Outcome Tracking — Success Rate', () => {
  it('returns 0 for empty outcomes', () => {
    expect(calculateSuccessRate([])).toBe(0);
  });

  it('calculates correct percentage for mixed outcomes', () => {
    const outcomes = [
      { outcome_type: 'response_received' },
      { outcome_type: 'no_response' },
      { outcome_type: 'response_received' },
      { outcome_type: 'no_response' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(50);
  });

  it('counts completed as success', () => {
    const outcomes = [
      { outcome_type: 'completed' },
      { outcome_type: 'completed' },
      { outcome_type: 'expired' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(67);
  });

  it('returns 100 for all successes', () => {
    const outcomes = [
      { outcome_type: 'response_received' },
      { outcome_type: 'response_received' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(100);
  });

  it('returns 0 for all failures', () => {
    const outcomes = [
      { outcome_type: 'no_response' },
      { outcome_type: 'expired' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(0);
  });
});

describe('Outcome Tracking — Average Response Time', () => {
  it('returns null when no outcomes have response times', () => {
    const outcomes = [{ outcome_detail: {} }, { outcome_detail: {} }];
    expect(calculateAvgResponseHours(outcomes)).toBeNull();
  });

  it('calculates correct average', () => {
    const outcomes = [
      { outcome_detail: { hours_to_outcome: 2 } },
      { outcome_detail: { hours_to_outcome: 4 } },
      { outcome_detail: { hours_to_outcome: 6 } },
    ];
    expect(calculateAvgResponseHours(outcomes)).toBe(4);
  });

  it('ignores outcomes without response times', () => {
    const outcomes = [
      { outcome_detail: { hours_to_outcome: 3 } },
      { outcome_detail: {} },
      { outcome_detail: { hours_to_outcome: 5 } },
    ];
    expect(calculateAvgResponseHours(outcomes)).toBe(4);
  });
});

describe('Outcome Tracking — Memory Generation Gate', () => {
  it('does not create memory below 30 data points', () => {
    expect(shouldCreateMemory(29)).toBe(false);
  });

  it('creates memory at 30+ data points', () => {
    expect(shouldCreateMemory(30)).toBe(true);
    expect(shouldCreateMemory(100)).toBe(true);
  });
});

describe('Outcome Tracking — Memory Content', () => {
  it('builds content string with success rate and count', () => {
    const content = buildMemoryContent('sms_sent', 42, 38, null);
    expect(content).toBe('sms sent: 42% success rate (38 observations)');
  });

  it('includes average response time when available', () => {
    const content = buildMemoryContent('sms_sent', 42, 38, 4.5);
    expect(content).toBe('sms sent: 42% success rate (38 observations). Average response time: 4.5 hours');
  });

  it('formats action type labels correctly', () => {
    const content = buildMemoryContent('calendar_event_created', 80, 50, null);
    expect(content).toContain('calendar event created');
  });
});
