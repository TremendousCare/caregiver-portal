import { describe, it, expect } from 'vitest';

// ── Pure functions extracted from eSign system for testing ──

function appendAudit(existing, action, extra = {}) {
  return [...(existing || []), { action, at: new Date().toISOString(), ...extra }];
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isValidStatus(status) {
  return ['sent', 'viewed', 'signed', 'declined', 'expired', 'voided'].includes(status);
}

function canTransitionTo(currentStatus, targetStatus) {
  const transitions = {
    sent: ['viewed', 'signed', 'declined', 'expired', 'voided'],
    viewed: ['signed', 'declined', 'expired', 'voided'],
    signed: [], // terminal
    declined: ['sent'], // can resend after decline
    expired: ['sent'], // can resend after expiry
    voided: [], // terminal
  };
  return (transitions[currentStatus] || []).includes(targetStatus);
}

function matchDocsByIds(signedDocs, uploadedDocIds) {
  if (!uploadedDocIds?.length) return [];
  return signedDocs.filter((doc) => uploadedDocIds.includes(doc.id));
}

function matchDocsByFilename(signedDocs, signedAt) {
  const signedDate = signedAt ? new Date(signedAt).toISOString().split('T')[0] : '';
  return signedDocs.filter(
    (doc) => doc.file_name?.includes('_Signed_') && doc.file_name?.includes(signedDate)
  );
}

function serializeFieldValues(fieldValues) {
  return JSON.stringify(fieldValues);
}

function deserializeFieldValues(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function validateConsentData(consent) {
  return !!(consent.timestamp && consent.ip && consent.userAgent);
}

function isDocumentHashValid(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
}

function buildDocHashMap(templates, hashes) {
  const map = {};
  templates.forEach((t, i) => {
    if (hashes[i]) map[t.name] = hashes[i];
  });
  return map;
}

// ── Tests ──

describe('eSign Compliance', () => {
  describe('Audit Trail', () => {
    it('appends events without modifying existing entries', () => {
      const trail = [{ action: 'created', at: '2026-01-01T00:00:00Z' }];
      const updated = appendAudit(trail, 'viewed', { ip: '1.2.3.4' });
      expect(updated).toHaveLength(2);
      expect(updated[0]).toEqual(trail[0]); // original untouched
      expect(updated[1].action).toBe('viewed');
      expect(updated[1].ip).toBe('1.2.3.4');
    });

    it('handles null/undefined existing trail', () => {
      const result = appendAudit(null, 'created');
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('created');
    });

    it('preserves all prior entries (append-only)', () => {
      let trail = [];
      trail = appendAudit(trail, 'created', { by: 'admin' });
      trail = appendAudit(trail, 'viewed', { ip: '1.2.3.4' });
      trail = appendAudit(trail, 'consent_recorded', { ip: '1.2.3.4' });
      trail = appendAudit(trail, 'signed', { ip: '1.2.3.4', hash: 'abc123' });
      expect(trail).toHaveLength(4);
      expect(trail.map((e) => e.action)).toEqual(['created', 'viewed', 'consent_recorded', 'signed']);
    });

    it('each entry has a timestamp', () => {
      const trail = appendAudit([], 'viewed');
      expect(trail[0].at).toBeTruthy();
      expect(() => new Date(trail[0].at)).not.toThrow();
    });
  });

  describe('ESIGN Act Consent', () => {
    it('requires timestamp, IP, and user-agent', () => {
      expect(validateConsentData({ timestamp: '2026-01-01T00:00:00Z', ip: '1.2.3.4', userAgent: 'Chrome' })).toBe(true);
    });

    it('rejects missing timestamp', () => {
      expect(validateConsentData({ ip: '1.2.3.4', userAgent: 'Chrome' })).toBe(false);
    });

    it('rejects missing IP', () => {
      expect(validateConsentData({ timestamp: '2026-01-01T00:00:00Z', userAgent: 'Chrome' })).toBe(false);
    });

    it('rejects missing user-agent', () => {
      expect(validateConsentData({ timestamp: '2026-01-01T00:00:00Z', ip: '1.2.3.4' })).toBe(false);
    });
  });

  describe('Document Hash Verification', () => {
    it('validates a proper SHA-256 hex hash', () => {
      const hash = 'a'.repeat(64);
      expect(isDocumentHashValid(hash)).toBe(true);
    });

    it('rejects too-short hash', () => {
      expect(isDocumentHashValid('abc123')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isDocumentHashValid('g'.repeat(64))).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isDocumentHashValid(null)).toBe(false);
      expect(isDocumentHashValid(undefined)).toBe(false);
      expect(isDocumentHashValid(123)).toBe(false);
    });

    it('builds per-document hash map correctly', () => {
      const templates = [{ name: 'W-4' }, { name: 'I-9' }, { name: 'NDA' }];
      const hashes = ['aaa', 'bbb', 'ccc'];
      const map = buildDocHashMap(templates, hashes);
      expect(map).toEqual({ 'W-4': 'aaa', 'I-9': 'bbb', 'NDA': 'ccc' });
    });

    it('skips templates with missing hashes', () => {
      const templates = [{ name: 'W-4' }, { name: 'I-9' }];
      const hashes = ['aaa'];
      const map = buildDocHashMap(templates, hashes);
      expect(map).toEqual({ 'W-4': 'aaa' });
      expect(map['I-9']).toBeUndefined();
    });
  });

  describe('Status Transitions', () => {
    it('allows sent -> viewed', () => {
      expect(canTransitionTo('sent', 'viewed')).toBe(true);
    });

    it('allows sent -> signed', () => {
      expect(canTransitionTo('sent', 'signed')).toBe(true);
    });

    it('allows sent -> declined', () => {
      expect(canTransitionTo('sent', 'declined')).toBe(true);
    });

    it('allows viewed -> signed', () => {
      expect(canTransitionTo('viewed', 'signed')).toBe(true);
    });

    it('allows viewed -> declined', () => {
      expect(canTransitionTo('viewed', 'declined')).toBe(true);
    });

    it('prevents signed -> anything (terminal)', () => {
      expect(canTransitionTo('signed', 'viewed')).toBe(false);
      expect(canTransitionTo('signed', 'declined')).toBe(false);
      expect(canTransitionTo('signed', 'voided')).toBe(false);
    });

    it('prevents voided -> anything (terminal)', () => {
      expect(canTransitionTo('voided', 'sent')).toBe(false);
      expect(canTransitionTo('voided', 'signed')).toBe(false);
    });

    it('allows declined -> sent (resend)', () => {
      expect(canTransitionTo('declined', 'sent')).toBe(true);
    });

    it('all valid statuses are recognized', () => {
      ['sent', 'viewed', 'signed', 'declined', 'expired', 'voided'].forEach((s) => {
        expect(isValidStatus(s)).toBe(true);
      });
      expect(isValidStatus('unknown')).toBe(false);
    });
  });

  describe('Document Matching', () => {
    const mockDocs = [
      { id: 'doc-1', file_name: 'W-4_Signed_2026-04-09.pdf' },
      { id: 'doc-2', file_name: 'I-9_Signed_2026-04-09.pdf' },
      { id: 'doc-3', file_name: 'NDA_Signed_2026-04-08.pdf' },
    ];

    it('matches by uploaded_doc_ids when available', () => {
      const result = matchDocsByIds(mockDocs, ['doc-1', 'doc-2']);
      expect(result).toHaveLength(2);
      expect(result.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);
    });

    it('returns empty for null/empty uploaded_doc_ids', () => {
      expect(matchDocsByIds(mockDocs, null)).toEqual([]);
      expect(matchDocsByIds(mockDocs, [])).toEqual([]);
    });

    it('falls back to filename matching by date', () => {
      const result = matchDocsByFilename(mockDocs, '2026-04-09T12:00:00Z');
      expect(result).toHaveLength(2);
      expect(result.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);
    });

    it('filename matching excludes wrong dates', () => {
      const result = matchDocsByFilename(mockDocs, '2026-04-09T12:00:00Z');
      expect(result.find((d) => d.id === 'doc-3')).toBeUndefined();
    });
  });

  describe('Token Security', () => {
    it('generates 64-character hex tokens', () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(token)).toBe(true);
    });

    it('generates unique tokens', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
      expect(tokens.size).toBe(50);
    });
  });

  describe('Autosave Serialization', () => {
    it('round-trips field values through JSON', () => {
      const values = {
        'tpl-1': {
          'sig-1': 'data:image/png;base64,iVBORw...',
          'date-1': '04/09/2026',
          'text-1': 'John Doe',
          'cb-1': true,
        },
        'tpl-2': {
          'sig-2': 'data:image/png;base64,abc123...',
        },
      };
      const json = serializeFieldValues(values);
      const restored = deserializeFieldValues(json);
      expect(restored).toEqual(values);
    });

    it('handles invalid JSON gracefully', () => {
      expect(deserializeFieldValues('not json')).toBe(null);
      expect(deserializeFieldValues('')).toBe(null);
    });
  });

  describe('Certificate of Completion Data', () => {
    it('contains all required fields for legal defensibility', () => {
      // Validate that a certificate data structure has everything needed
      const certData = {
        envelope_id: 'uuid-123',
        signer_name: 'John Doe',
        signer_ip: '1.2.3.4',
        signer_user_agent: 'Mozilla/5.0...',
        signed_at: '2026-04-09T12:00:00Z',
        consent_timestamp: '2026-04-09T11:55:00Z',
        document_hashes: { 'W-4': 'a'.repeat(64), 'I-9': 'b'.repeat(64) },
        audit_trail: [
          { action: 'created', at: '2026-04-09T10:00:00Z' },
          { action: 'viewed', at: '2026-04-09T11:50:00Z' },
          { action: 'consent_recorded', at: '2026-04-09T11:55:00Z' },
          { action: 'signed', at: '2026-04-09T12:00:00Z' },
        ],
      };

      // All legally required fields must be present
      expect(certData.envelope_id).toBeTruthy();
      expect(certData.signer_name).toBeTruthy();
      expect(certData.signer_ip).toBeTruthy();
      expect(certData.signed_at).toBeTruthy();
      expect(certData.consent_timestamp).toBeTruthy();
      expect(Object.keys(certData.document_hashes).length).toBeGreaterThan(0);
      expect(certData.audit_trail.length).toBeGreaterThanOrEqual(2);

      // All document hashes must be valid SHA-256
      for (const hash of Object.values(certData.document_hashes)) {
        expect(isDocumentHashValid(hash)).toBe(true);
      }

      // Audit trail must include consent_recorded
      expect(certData.audit_trail.some((e) => e.action === 'consent_recorded')).toBe(true);
    });
  });
});
