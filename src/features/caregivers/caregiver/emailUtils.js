/**
 * Email thread grouping utilities for the Messaging Center.
 *
 * Groups email notes by normalized subject line into conversation threads.
 */

/**
 * Strip reply/forward prefixes and normalize a subject line for grouping.
 * "Re: Re: Fwd: Welcome to Tremendous Care" → "welcome to tremendous care"
 */
export function normalizeSubject(subject) {
  if (!subject) return '';
  let result = subject.trim();
  // Loop to strip all nested Re:/Fwd:/FW: prefixes
  let prev;
  do {
    prev = result;
    result = result.replace(/^(re|fwd|fw)\s*:\s*/i, '');
  } while (result !== prev);
  return result.trim().toLowerCase();
}

/**
 * Extract a subject line from a legacy email note's text field.
 * Legacy format: "Email sent — Subject: Some Subject\n\nBody text..."
 */
export function extractSubjectFromText(text) {
  if (!text) return '(No subject)';
  const match = text.match(/Subject:\s*(.+?)(?:\n|$)/);
  return match ? match[1].trim() : '(No subject)';
}

/**
 * Extract the body portion from a legacy email note's text field.
 * Legacy format: "Email sent — Subject: Some Subject\n\nBody text..."
 */
export function extractBodyFromText(text) {
  if (!text) return '';
  // Find the double newline after the subject line
  const idx = text.indexOf('\n\n');
  if (idx === -1) return text;
  return text.substring(idx + 2).trim();
}

/**
 * Group email notes into threads by normalized subject.
 *
 * Returns an array of thread objects sorted by most recent message:
 * [{ subject, normalizedKey, messages[], lastTimestamp }]
 *
 * Each message within a thread is sorted chronologically (oldest first).
 */
export function groupEmailsByThread(emails) {
  const threads = new Map();

  for (const email of emails) {
    const rawSubject = email.subject || extractSubjectFromText(email.text);
    const key = normalizeSubject(rawSubject);
    const groupKey = key || `_no_subject_${email.timestamp}`;

    if (!threads.has(groupKey)) {
      threads.set(groupKey, {
        subject: email.subject || extractSubjectFromText(email.text),
        normalizedKey: groupKey,
        messages: [],
        lastTimestamp: 0,
      });
    }

    const thread = threads.get(groupKey);
    thread.messages.push(email);

    const ts = new Date(email.timestamp).getTime();
    if (ts > thread.lastTimestamp) {
      thread.lastTimestamp = ts;
      // Keep the most recent subject variant (may have "Re:" prefix)
      thread.subject = email.subject || extractSubjectFromText(email.text);
    }
  }

  // Sort messages within each thread chronologically (oldest first)
  for (const thread of threads.values()) {
    thread.messages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  // Sort threads by most recent message (newest thread first)
  return Array.from(threads.values()).sort(
    (a, b) => b.lastTimestamp - a.lastTimestamp
  );
}
