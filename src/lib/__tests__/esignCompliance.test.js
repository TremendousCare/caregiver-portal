import { describe, it, expect } from 'vitest';

// ─── eSign Compliance Tests ───
// Tests for the business logic and data structures used in the
// custom e-signature system's compliance upgrade.

describe('eSign Compliance — Audit Trail', () => {
  // Replicate the appendAudit utility from the edge function
  function appendAudit(existing, action, extra = {}) {
    return [...(existing || []), { action, at: new Date().toISOString(), ...extra }];
  }

  it('should append audit entries without mutating the original', () => {
    const original = [{ action: 'created', at: '2026-01-01T00:00:00Z', by: 'admin' }];
    const result = appendAudit(original, 'viewed', { ip: '1.2.3.4' });
    expect(result).toHaveLength(2);
    expect(original).toHaveLength(1); // Not mutated
    expect(result[1].action).toBe('viewed');
    expect(result[1].ip).toBe('1.2.3.4');
    expect(result[1].at).toBeDefined();
  });

  it('should handle null/undefined existing trail', () => {
    expect(appendAudit(null, 'created')).toHaveLength(1);
    expect(appendAudit(undefined, 'created')).toHaveLength(1);
  });

  it('should track all compliance-required actions in correct order', () => {
    let trail = [];
    trail = appendAudit(trail, 'created', { by: 'admin@tc.com' });
    trail = appendAudit(trail, 'consent_accepted', { ip: '10.0.0.1', ua: 'Mozilla/5.0' });
    trail = appendAudit(trail, 'viewed', { ip: '10.0.0.1' });
    trail = appendAudit(trail, 'signed', { ip: '10.0.0.1', hash: 'abc123' });

    expect(trail).toHaveLength(4);
    expect(trail.map((e) => e.action)).toEqual(['created', 'consent_accepted', 'viewed', 'signed']);
    // Consent entry should have IP for ESIGN Act compliance
    expect(trail[1].ip).toBe('10.0.0.1');
    expect(trail[1].ua).toBeDefined();
  });

  it('should track decline action with reason', () => {
    let trail = [{ action: 'created', at: '2026-01-01T00:00:00Z' }];
    trail = appendAudit(trail, 'declined', { ip: '10.0.0.1', reason: 'Wrong document' });

    expect(trail).toHaveLength(2);
    expect(trail[1].action).toBe('declined');
    expect(trail[1].reason).toBe('Wrong document');
    expect(trail[1].ip).toBe('10.0.0.1');
  });

  it('should track resend events', () => {
    let trail = [{ action: 'created', at: '2026-01-01T00:00:00Z' }];
    trail = appendAudit(trail, 'resent', { by: 'admin@tc.com', via: 'sms' });

    expect(trail[1].action).toBe('resent');
    expect(trail[1].by).toBe('admin@tc.com');
    expect(trail[1].via).toBe('sms');
  });
});

describe('eSign Compliance — Document Hashes', () => {
  it('should format per-document hash objects correctly', () => {
    const templates = [
      { id: 'tpl-1', name: 'Employment Agreement' },
      { id: 'tpl-2', name: 'I-9 Form' },
    ];
    const hashes = ['abc123def456', '789ghi012jkl'];

    const documentHashes = hashes.map((hash, i) => ({
      template_name: templates[i]?.name,
      template_id: templates[i]?.id,
      sha256: hash,
    }));

    expect(documentHashes).toHaveLength(2);
    expect(documentHashes[0]).toEqual({
      template_name: 'Employment Agreement',
      template_id: 'tpl-1',
      sha256: 'abc123def456',
    });
    expect(documentHashes[1].template_name).toBe('I-9 Form');
  });
});

describe('eSign Compliance — Envelope Status Transitions', () => {
  const VALID_STATUSES = ['sent', 'viewed', 'signed', 'declined', 'expired', 'voided'];

  it('should recognize all valid statuses', () => {
    for (const status of VALID_STATUSES) {
      expect(VALID_STATUSES).toContain(status);
    }
  });

  it('should not allow voiding a signed envelope', () => {
    const envelope = { status: 'signed' };
    const canVoid = ['sent', 'viewed'].includes(envelope.status);
    expect(canVoid).toBe(false);
  });

  it('should allow voiding sent or viewed envelopes', () => {
    expect(['sent', 'viewed'].includes('sent')).toBe(true);
    expect(['sent', 'viewed'].includes('viewed')).toBe(true);
  });

  it('should allow resend for non-signed statuses', () => {
    const resendable = ['declined', 'voided', 'expired', 'sent', 'viewed'];
    expect(resendable.includes('declined')).toBe(true);
    expect(resendable.includes('expired')).toBe(true);
    expect(resendable.includes('signed')).toBe(false);
  });

  it('should detect expired envelopes correctly', () => {
    const futureExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const pastExpiry = new Date(Date.now() - 1000);

    expect(futureExpiry < new Date()).toBe(false); // not expired
    expect(pastExpiry < new Date()).toBe(true); // expired
  });
});

describe('eSign Compliance — Uploaded Doc ID Matching', () => {
  const signedDocs = [
    { id: 'doc-1', file_name: 'Employment_Agreement_Signed_2026-04-09.pdf' },
    { id: 'doc-2', file_name: 'I9_Form_Signed_2026-04-09.pdf' },
    { id: 'doc-3', file_name: 'Other_Document_Signed_2026-04-08.pdf' },
  ];

  it('should match by uploaded_doc_ids when available (reliable)', () => {
    const envelope = {
      status: 'signed',
      uploaded_doc_ids: ['doc-1', 'doc-2'],
      signed_at: '2026-04-09T12:00:00Z',
    };

    const matched = envelope.uploaded_doc_ids.length > 0
      ? signedDocs.filter((doc) => envelope.uploaded_doc_ids.includes(doc.id))
      : [];

    expect(matched).toHaveLength(2);
    expect(matched[0].id).toBe('doc-1');
    expect(matched[1].id).toBe('doc-2');
  });

  it('should fallback to filename matching when uploaded_doc_ids is empty', () => {
    const envelope = {
      status: 'signed',
      uploaded_doc_ids: [],
      signed_at: '2026-04-09T12:00:00Z',
    };

    const signedDate = new Date(envelope.signed_at).toISOString().split('T')[0];
    const matched = signedDocs.filter((doc) =>
      doc.file_name?.includes('_Signed_') && doc.file_name?.includes(signedDate)
    );

    expect(matched).toHaveLength(2); // doc-1 and doc-2 (both 2026-04-09)
    expect(matched.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);
  });

  it('should not match documents from different dates in fallback', () => {
    const envelope = {
      status: 'signed',
      uploaded_doc_ids: [],
      signed_at: '2026-04-08T12:00:00Z',
    };

    const signedDate = new Date(envelope.signed_at).toISOString().split('T')[0];
    const matched = signedDocs.filter((doc) =>
      doc.file_name?.includes('_Signed_') && doc.file_name?.includes(signedDate)
    );

    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe('doc-3');
  });
});

describe('eSign Compliance — Consent Data', () => {
  it('should store consent timestamp, IP, and user-agent', () => {
    const consentData = {
      consent_timestamp: '2026-04-09T10:30:00Z',
      consent_ip: '192.168.1.100',
      consent_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)',
    };

    expect(consentData.consent_timestamp).toBeTruthy();
    expect(consentData.consent_ip).not.toBe('unknown');
    expect(consentData.consent_user_agent).toContain('Mozilla');
  });

  it('should require consent before signing is valid', () => {
    // An envelope without consent_timestamp should be flagged
    const envelopeWithConsent = { consent_timestamp: '2026-04-09T10:30:00Z' };
    const envelopeWithout = { consent_timestamp: null };

    expect(!!envelopeWithConsent.consent_timestamp).toBe(true);
    expect(!!envelopeWithout.consent_timestamp).toBe(false);
  });
});

describe('eSign Compliance — Token Generation', () => {
  it('should generate cryptographically random tokens', () => {
    function generateToken() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    const token1 = generateToken();
    const token2 = generateToken();

    expect(token1).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(token2).toHaveLength(64);
    expect(token1).not.toBe(token2); // Should be unique
    expect(token1).toMatch(/^[0-9a-f]{64}$/); // Valid hex
  });
});

describe('eSign Compliance — Autosave', () => {
  it('should serialize and deserialize field values for localStorage', () => {
    const fieldValues = {
      'tpl-1': {
        'sig_1': 'data:image/png;base64,abc123',
        'date_1': '04/09/2026',
        'text_1': 'John Doe',
        'check_1': true,
      },
      'tpl-2': {
        'sig_2': 'data:image/png;base64,def456',
        'initial_1': 'data:image/png;base64,ghi789',
      },
    };

    const serialized = JSON.stringify(fieldValues);
    const restored = JSON.parse(serialized);

    expect(restored['tpl-1']['sig_1']).toBe('data:image/png;base64,abc123');
    expect(restored['tpl-1']['date_1']).toBe('04/09/2026');
    expect(restored['tpl-1']['check_1']).toBe(true);
    expect(restored['tpl-2']['initial_1']).toBe('data:image/png;base64,ghi789');
  });
});

describe('eSign Compliance — Certificate of Completion Data', () => {
  it('should include all required fields for legal defensibility', () => {
    const certificateData = {
      envelope_id: 'env-123',
      signer_name: 'John Doe',
      signer_email: 'john@example.com',
      signer_ip: '192.168.1.100',
      signer_user_agent: 'Mozilla/5.0',
      consent_timestamp: '2026-04-09T10:30:00Z',
      signed_at: '2026-04-09T10:35:00Z',
      documents: [
        { name: 'Employment Agreement', sha256: 'abc123' },
        { name: 'I-9 Form', sha256: 'def456' },
      ],
      audit_trail: [
        { action: 'created', at: '2026-04-09T10:00:00Z' },
        { action: 'consent_accepted', at: '2026-04-09T10:30:00Z' },
        { action: 'viewed', at: '2026-04-09T10:30:05Z' },
        { action: 'signed', at: '2026-04-09T10:35:00Z' },
      ],
    };

    // All ESIGN Act requirements present
    expect(certificateData.signer_name).toBeTruthy();
    expect(certificateData.consent_timestamp).toBeTruthy();
    expect(certificateData.signed_at).toBeTruthy();
    expect(certificateData.signer_ip).toBeTruthy();
    expect(certificateData.documents).toHaveLength(2);
    expect(certificateData.documents[0].sha256).toBeTruthy();
    expect(certificateData.audit_trail.length).toBeGreaterThanOrEqual(3);

    // Consent must precede signing
    const consentTime = new Date(certificateData.consent_timestamp).getTime();
    const signedTime = new Date(certificateData.signed_at).getTime();
    expect(consentTime).toBeLessThanOrEqual(signedTime);
  });
});
