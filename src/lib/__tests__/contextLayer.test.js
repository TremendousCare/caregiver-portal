import { describe, it, expect } from 'vitest';

// ──────────────────────────────────────────────────────────
// Pure functions replicated from the Edge Function context layer
// for testing. These mirror the logic in:
//   - supabase/functions/ai-chat/context/layers/memory.ts
//   - supabase/functions/ai-chat/context/consolidation.ts
//   - supabase/functions/ai-chat/index.ts (extractTopics, token budget)
// ──────────────────────────────────────────────────────────

// ── Memory Relevance Scoring ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'like', 'through', 'after', 'over', 'between', 'out', 'against', 'during',
  'without', 'before', 'under', 'around', 'among', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
  'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because', 'if',
  'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this', 'that',
  'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'up', 'then', 'also', 'tell', 'show', 'get', 'give', 'make',
]);

function extractKeywords(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  return new Set(words.filter(w => w.length > 2 && !STOP_WORDS.has(w)));
}

function scoreRelevance(memory, queryKeywords) {
  if (queryKeywords.size === 0) return 0.5;
  const memoryText = memory.content + ' ' + (memory.tags || []).join(' ');
  const memoryKeywords = extractKeywords(memoryText);
  let matches = 0;
  for (const kw of queryKeywords) {
    if (memoryKeywords.has(kw)) matches++;
  }
  return queryKeywords.size > 0 ? matches / queryKeywords.size : 0;
}

// ── Drift Detection ──

function parseSuccessRateFromContent(content) {
  const match = content.match(/(\d+)%\s*success\s*rate/i);
  return match ? parseInt(match[1], 10) : null;
}

function detectDrift(oldRate, newRate) {
  if (oldRate === null) return { drifted: false, delta: 0 };
  const delta = newRate - oldRate;
  return { drifted: Math.abs(delta) >= 15, delta };
}

// ── Topic Extraction ──

const INTENT_PATTERNS = [
  { pattern: /\b(follow[- ]?up|stale|inactive|hasn'?t responded|no response)\b/i, label: 'Follow-up' },
  { pattern: /\b(schedul|interview|calendar|meeting|appointment|availability)\b/i, label: 'Scheduling' },
  { pattern: /\b(compliance|compliant|document|missing doc|hca|license|certification)\b/i, label: 'Compliance' },
  { pattern: /\b(text|sms|send message|message them)\b/i, label: 'SMS outreach' },
  { pattern: /\b(email|send email|inbox)\b/i, label: 'Email' },
  { pattern: /\b(docusign|envelope|sign|signature)\b/i, label: 'DocuSign' },
  { pattern: /\b(pipeline|stats|summary|overview|how many|report)\b/i, label: 'Pipeline review' },
  { pattern: /\b(phase|move to|advance|update phase)\b/i, label: 'Phase change' },
  { pattern: /\b(onboard|orient|training)\b/i, label: 'Onboarding' },
  { pattern: /\b(client|family|patient|care recipient)\b/i, label: 'Client management' },
  { pattern: /\b(call|phone|ring)\b/i, label: 'Call review' },
];

function extractTopics(messages, caregivers = [], clients = []) {
  const topics = [];
  const seen = new Set();
  const entityNames = new Set();
  for (const cg of caregivers) {
    if (cg.first_name) entityNames.add(cg.first_name.toLowerCase());
    if (cg.first_name && cg.last_name)
      entityNames.add(`${cg.first_name} ${cg.last_name}`.toLowerCase());
  }
  for (const cl of clients) {
    if (cl.first_name) entityNames.add(cl.first_name.toLowerCase());
    if (cl.first_name && cl.last_name)
      entityNames.add(`${cl.first_name} ${cl.last_name}`.toLowerCase());
  }

  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    let intent = '';
    for (const { pattern, label } of INTENT_PATTERNS) {
      if (pattern.test(content)) { intent = label; break; }
    }
    const contentLower = content.toLowerCase();
    const mentionedEntities = [];
    for (const name of entityNames) {
      if (name.includes(' ') && contentLower.includes(name)) {
        const capitalized = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        mentionedEntities.push(capitalized);
      }
    }
    if (mentionedEntities.length === 0) {
      for (const name of entityNames) {
        if (!name.includes(' ') && contentLower.includes(name))
          mentionedEntities.push(name.charAt(0).toUpperCase() + name.slice(1));
      }
    }
    let topic;
    const uniqueEntities = [...new Set(mentionedEntities)].slice(0, 2);
    if (intent && uniqueEntities.length > 0) topic = `${intent}: ${uniqueEntities.join(', ')}`;
    else if (intent) topic = intent;
    else if (uniqueEntities.length > 0) topic = `Discussed: ${uniqueEntities.join(', ')}`;
    else {
      const firstSentence = content.split(/[.!?\n]/)[0].trim();
      topic = firstSentence.length > 60 ? firstSentence.slice(0, 60) + '...' : firstSentence;
    }
    if (!seen.has(topic)) {
      seen.add(topic);
      topics.push({ topic, status: 'discussed' });
    }
  }
  return topics.slice(-5);
}

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe('Memory Relevance — Keyword Extraction', () => {
  it('extracts meaningful keywords, filtering stop words', () => {
    const keywords = extractKeywords('What is the interview status for Sarah?');
    expect(keywords.has('interview')).toBe(true);
    expect(keywords.has('status')).toBe(true);
    expect(keywords.has('sarah')).toBe(true);
    expect(keywords.has('the')).toBe(false);
    expect(keywords.has('is')).toBe(false);
    expect(keywords.has('for')).toBe(false);
  });

  it('handles empty string', () => {
    expect(extractKeywords('').size).toBe(0);
  });

  it('strips punctuation', () => {
    const keywords = extractKeywords("Sarah's phone number?");
    expect(keywords.has('sarah')).toBe(true);
    expect(keywords.has('phone')).toBe(true);
    expect(keywords.has('number')).toBe(true);
  });
});

describe('Memory Relevance — Scoring', () => {
  it('returns 0.5 when no query is provided', () => {
    const score = scoreRelevance({ content: 'anything' }, new Set());
    expect(score).toBe(0.5);
  });

  it('scores 1.0 for perfect keyword match', () => {
    const query = extractKeywords('interview compliance');
    const score = scoreRelevance({ content: 'compliance check passed, interview went well' }, query);
    expect(score).toBe(1.0);
  });

  it('scores 0 for no keyword overlap', () => {
    const query = extractKeywords('docusign envelope');
    const score = scoreRelevance({ content: 'prefers morning shifts' }, query);
    expect(score).toBe(0);
  });

  it('scores partial match correctly', () => {
    const query = extractKeywords('interview phone schedule');
    const score = scoreRelevance({ content: 'phone number is 555-1234' }, query);
    // 'phone' matches, 'interview' and 'schedule' don't => 1/3
    expect(score).toBeCloseTo(0.333, 2);
  });

  it('includes tags in relevance scoring', () => {
    const query = extractKeywords('compliance');
    const score = scoreRelevance(
      { content: 'has valid HCA', tags: ['compliance', 'documents'] },
      query,
    );
    expect(score).toBe(1.0);
  });
});

describe('Drift Detection — Rate Parsing', () => {
  it('parses success rate from memory content', () => {
    expect(parseSuccessRateFromContent('sms sent: 42% success rate (38 observations)')).toBe(42);
  });

  it('parses with average response time', () => {
    expect(parseSuccessRateFromContent('email sent: 70% success rate (100 observations). Average response time: 4.5 hours')).toBe(70);
  });

  it('returns null for non-matching content', () => {
    expect(parseSuccessRateFromContent('Prefers morning shifts')).toBeNull();
  });

  it('handles 0% and 100%', () => {
    expect(parseSuccessRateFromContent('sms sent: 0% success rate (30 observations)')).toBe(0);
    expect(parseSuccessRateFromContent('sms sent: 100% success rate (50 observations)')).toBe(100);
  });
});

describe('Drift Detection — Threshold', () => {
  it('detects significant upward drift', () => {
    const { drifted, delta } = detectDrift(40, 60);
    expect(drifted).toBe(true);
    expect(delta).toBe(20);
  });

  it('detects significant downward drift', () => {
    const { drifted, delta } = detectDrift(70, 50);
    expect(drifted).toBe(true);
    expect(delta).toBe(-20);
  });

  it('does not flag small changes as drift', () => {
    const { drifted } = detectDrift(42, 48);
    expect(drifted).toBe(false);
  });

  it('flags exactly 15pp as drift', () => {
    const { drifted } = detectDrift(40, 55);
    expect(drifted).toBe(true);
  });

  it('handles null old rate (first memory)', () => {
    const { drifted, delta } = detectDrift(null, 60);
    expect(drifted).toBe(false);
    expect(delta).toBe(0);
  });
});

describe('Topic Extraction — Intent Detection', () => {
  it('detects follow-up intent', () => {
    const topics = extractTopics([
      { role: 'user', content: 'Who needs follow-up today?' },
    ]);
    expect(topics[0].topic).toBe('Follow-up');
  });

  it('detects scheduling intent', () => {
    const topics = extractTopics([
      { role: 'user', content: 'Schedule an interview for tomorrow' },
    ]);
    expect(topics[0].topic).toBe('Scheduling');
  });

  it('detects compliance intent', () => {
    const topics = extractTopics([
      { role: 'user', content: 'Check compliance documents for everyone' },
    ]);
    expect(topics[0].topic).toBe('Compliance');
  });

  it('detects email intent', () => {
    const topics = extractTopics([
      { role: 'user', content: 'Send an email to the new applicant' },
    ]);
    expect(topics[0].topic).toBe('Email');
  });
});

describe('Topic Extraction — Entity Recognition', () => {
  const caregivers = [
    { first_name: 'Sarah', last_name: 'Johnson' },
    { first_name: 'Maria', last_name: 'Garcia' },
  ];
  const clients = [
    { first_name: 'Robert', last_name: 'Smith' },
  ];

  it('extracts full name from message', () => {
    const topics = extractTopics(
      [{ role: 'user', content: "What's the status of Sarah Johnson?" }],
      caregivers,
      clients,
    );
    expect(topics[0].topic).toContain('Sarah Johnson');
  });

  it('combines intent with entity', () => {
    const topics = extractTopics(
      [{ role: 'user', content: 'Schedule an interview with Maria Garcia' }],
      caregivers,
      clients,
    );
    expect(topics[0].topic).toBe('Scheduling: Maria Garcia');
  });

  it('falls back to first name when full name not found', () => {
    const topics = extractTopics(
      [{ role: 'user', content: "Tell me about Sarah's progress" }],
      caregivers,
      clients,
    );
    expect(topics[0].topic).toContain('Sarah');
  });

  it('recognizes client names', () => {
    const topics = extractTopics(
      [{ role: 'user', content: 'Update on the Robert Smith client case' }],
      caregivers,
      clients,
    );
    expect(topics[0].topic).toContain('Robert Smith');
  });
});

describe('Topic Extraction — Fallback', () => {
  it('uses first sentence as fallback when no intent or entity', () => {
    const topics = extractTopics([
      { role: 'user', content: 'Good morning, how are you doing today' },
    ]);
    expect(topics[0].topic).toBe('Good morning, how are you doing today');
  });

  it('truncates long fallback topics at 60 chars', () => {
    const longMsg = 'A'.repeat(100);
    const topics = extractTopics([
      { role: 'user', content: longMsg },
    ]);
    expect(topics[0].topic.length).toBeLessThanOrEqual(63); // 60 + "..."
    expect(topics[0].topic.endsWith('...')).toBe(true);
  });

  it('skips non-user messages', () => {
    const topics = extractTopics([
      { role: 'assistant', content: 'Here is your pipeline summary' },
    ]);
    expect(topics.length).toBe(0);
  });

  it('skips non-string content (tool results)', () => {
    const topics = extractTopics([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '123' }] },
    ]);
    expect(topics.length).toBe(0);
  });

  it('deduplicates identical topics', () => {
    const topics = extractTopics([
      { role: 'user', content: 'Pipeline summary' },
      { role: 'user', content: 'Pipeline summary' },
    ]);
    expect(topics.length).toBe(1);
  });

  it('keeps at most 5 topics', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user',
      content: `Unique topic number ${i}`,
    }));
    const topics = extractTopics(messages);
    expect(topics.length).toBeLessThanOrEqual(5);
  });
});

describe('Topic Extraction — Multiple Messages', () => {
  const caregivers = [
    { first_name: 'Sarah', last_name: 'Johnson' },
  ];

  it('extracts distinct topics from multi-message conversation', () => {
    const topics = extractTopics(
      [
        { role: 'user', content: 'Schedule an interview with Sarah Johnson' },
        { role: 'assistant', content: 'Sure, checking availability...' },
        { role: 'user', content: 'Check Sarah compliance documents' },
      ],
      caregivers,
    );
    expect(topics.length).toBe(2);
    expect(topics[0].topic).toBe('Scheduling: Sarah Johnson');
    expect(topics[1].topic).toBe('Compliance: Sarah');
  });
});
