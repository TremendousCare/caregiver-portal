import { describe, it, expect } from 'vitest';
import {
  parseTrelloCardContacts,
  normalizeContactName,
  matchContactByName,
  buildEnrichmentPatch,
} from '../bd/trelloContactParser.js';

// ──────────────────────────────────────────────────────────────────
// parseTrelloCardContacts — real card samples
// ──────────────────────────────────────────────────────────────────

describe('parseTrelloCardContacts — Regents Point card', () => {
  // Verbatim from staging: trello_id=680bccd40b3ca6ca298ea8bf
  const desc = `[Website](https://example.com "‌")

**Contact, Title | Phone | Email | LinkedIn**

- Ashley Kroslin, RSD | (949)854-9500 (c) | [EMAIL]
- Melissa Goldman, Director of Nursing | (949)509-2216 | [melissa.goldman@humangood.org](mailto:melissa.goldman@humangood.org "‌")
- Reyna Medina, Health Services Coordinator | [PHONE] | [reyna.medina@humangood.org](mailto:reyna.medina@humangood.org "‌")
- Melinda Forney, [TITLE] | [PHONE] | [EMAIL] | [LinkedIn]
- Sheila [LAST NAME], [TITLE] | [PHONE] | [EMAIL] | [LinkedIn]

**Relevant Partner Details (Newly Learned Facts)**

- Best to visit Wednesday - Friday after 2:00PM`;

  const contacts = parseTrelloCardContacts(desc);

  it('extracts five contacts and skips the "Best to visit" bullet', () => {
    expect(contacts).toHaveLength(5);
    expect(contacts.map((c) => c.name)).toEqual([
      'Ashley Kroslin',
      'Melissa Goldman',
      'Reyna Medina',
      'Melinda Forney',
      'Sheila',
    ]);
  });

  it('parses Ashley with mobile phone (c suffix) and skips [EMAIL] placeholder', () => {
    expect(contacts[0]).toEqual({
      name: 'Ashley Kroslin',
      title: 'RSD',
      phone: '(949)854-9500',
      phoneKind: 'mobile',
      email: null,
    });
  });

  it('parses Melissa with full title, unspecified phone kind, and unwrapped email', () => {
    expect(contacts[1]).toEqual({
      name: 'Melissa Goldman',
      title: 'Director of Nursing',
      phone: '(949)509-2216',
      phoneKind: null,
      email: 'melissa.goldman@humangood.org',
    });
  });

  it('parses Reyna with [PHONE] placeholder skipped but real email kept', () => {
    expect(contacts[2]).toEqual({
      name: 'Reyna Medina',
      title: 'Health Services Coordinator',
      phone: null,
      phoneKind: null,
      email: 'reyna.medina@humangood.org',
    });
  });

  it('parses fully-empty contact (Melinda) with all placeholders', () => {
    expect(contacts[3]).toEqual({
      name: 'Melinda Forney',
      title: null,
      phone: null,
      phoneKind: null,
      email: null,
    });
  });

  it('strips [LAST NAME] placeholder from "Sheila [LAST NAME]"', () => {
    expect(contacts[4].name).toBe('Sheila');
  });
});

describe('parseTrelloCardContacts — Hoag Irvine (Phone/Email/LinkedIn placeholders without brackets)', () => {
  // Verbatim from staging: trello_id=680bce1148702dcf6eacfbd4
  const desc = `**Name, Title | Phone | Email | LinkedIn**

- Olivia, Case Manager | Phone | Email | LinkedIn
- Nancy, Case Manager | (949)279-4984 (c) | Email | LinkedIn
- Cathy, Social Worker | Phone | Email | LinkedIn`;

  const contacts = parseTrelloCardContacts(desc);

  it('treats unbracketed "Phone" / "Email" / "LinkedIn" as placeholders', () => {
    expect(contacts[0]).toEqual({
      name: 'Olivia',
      title: 'Case Manager',
      phone: null,
      phoneKind: null,
      email: null,
    });
  });

  it('keeps Nancy\'s mobile phone via (c) suffix', () => {
    expect(contacts[1].phone).toBe('(949)279-4984');
    expect(contacts[1].phoneKind).toBe('mobile');
  });

  it('parses all three contacts', () => {
    expect(contacts.map((c) => c.name)).toEqual(['Olivia', 'Nancy', 'Cathy']);
  });
});

describe('parseTrelloCardContacts — Saddleback (mixed-format bullets)', () => {
  // Verbatim from staging: trello_id=68127adddc329ddb435c1707
  const desc = `**Name, Title | Phone | Email | LinkedIn**

- Luis, Security
- Ashley, Security
- Nora McCall, Title | Phone | [nmccall@memorialcare.org](mailto:nmccall@memorialcare.org "‌") | LinkedIn
- Lisa Martinez, Discharge Planner | Phone | [lmartinez2@memorialcare.org](mailto:lmartinez2@memorialcare.org "‌") | LinkedIn
- Oliver [LAST NAME], Director Acute Care Services | Phone | Email | LinkedIn
- Care Coordination Main Line (949)837-4500 x27073`;

  const contacts = parseTrelloCardContacts(desc);

  it('extracts name-only bullets without pipes', () => {
    const luis = contacts.find((c) => c.name === 'Luis');
    expect(luis).toEqual({
      name: 'Luis',
      title: 'Security',
      phone: null,
      phoneKind: null,
      email: null,
    });
  });

  it('skips placeholder "Title" but keeps real email', () => {
    const nora = contacts.find((c) => c.name === 'Nora McCall');
    expect(nora.title).toBeNull();
    expect(nora.email).toBe('nmccall@memorialcare.org');
  });

  it('skips bullets with no comma (not a person)', () => {
    expect(contacts.find((c) => /care coordination/i.test(c.name))).toBeUndefined();
  });

  it('strips [LAST NAME] from Oliver and keeps long title', () => {
    const oliver = contacts.find((c) => c.name === 'Oliver');
    expect(oliver.title).toBe('Director Acute Care Services');
  });
});

describe('parseTrelloCardContacts — extension number → office', () => {
  it('classifies "x27073" extension as office', () => {
    const desc = `- Joe Smith, Manager | (949)837-4500 x27073 | joe@example.com`;
    const [c] = parseTrelloCardContacts(desc);
    expect(c.phoneKind).toBe('office');
    expect(c.phone).toContain('x27073');
  });

  it('respects explicit (o) suffix', () => {
    const desc = `- Jane Doe, Director | (310)555-1212 (o) | jane@example.com`;
    const [c] = parseTrelloCardContacts(desc);
    expect(c.phoneKind).toBe('office');
    expect(c.phone).toBe('(310)555-1212');
  });
});

describe('parseTrelloCardContacts — defensive handling', () => {
  it('returns [] for empty / null / non-string input', () => {
    expect(parseTrelloCardContacts(null)).toEqual([]);
    expect(parseTrelloCardContacts(undefined)).toEqual([]);
    expect(parseTrelloCardContacts('')).toEqual([]);
    expect(parseTrelloCardContacts(42)).toEqual([]);
  });

  it('returns [] for descriptions with no bullets', () => {
    const desc = 'Free-form notes\nLine two\nLine three';
    expect(parseTrelloCardContacts(desc)).toEqual([]);
  });

  it('dedupes by normalized name within a single card', () => {
    const desc = `- Ashley Kroslin, RSD | (949)854-9500 (c) | a@x.com
- ASHLEY KROSLIN, RSD | (949)999-9999 | other@x.com`;
    const contacts = parseTrelloCardContacts(desc);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].phone).toBe('(949)854-9500');
  });
});

// ──────────────────────────────────────────────────────────────────
// normalizeContactName
// ──────────────────────────────────────────────────────────────────

describe('normalizeContactName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeContactName('  Ashley   Kroslin  ')).toBe('ashley kroslin');
  });

  it('strips [LAST NAME] / [FIRST NAME] / [NAME] placeholders', () => {
    expect(normalizeContactName('Sheila [LAST NAME]')).toBe('sheila');
    expect(normalizeContactName('[FIRST NAME] Doe')).toBe('doe');
    expect(normalizeContactName('[NAME]')).toBe('');
  });

  it('returns empty string for empty/null input', () => {
    expect(normalizeContactName('')).toBe('');
    expect(normalizeContactName(null)).toBe('');
    expect(normalizeContactName(undefined)).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────
// matchContactByName
// ──────────────────────────────────────────────────────────────────

describe('matchContactByName', () => {
  const existing = [
    { id: 'c1', name: 'Ashley Kroslin' },
    { id: 'c2', name: 'Melissa Goldman' },
    { id: 'c3', name: 'Sheila' },
  ];

  it('matches on exact normalized full name', () => {
    expect(matchContactByName('Ashley Kroslin', existing).id).toBe('c1');
    expect(matchContactByName('  ashley   kroslin  ', existing).id).toBe('c1');
  });

  it('falls back to unique first-token match', () => {
    // Existing has just "Sheila"; parsed adds last name → should still match.
    expect(matchContactByName('Sheila Patel', existing).id).toBe('c3');
  });

  it('returns null on ambiguous first-token match', () => {
    const dup = [
      { id: 'a', name: 'Ashley Kroslin' },
      { id: 'b', name: 'Ashley Smith' },
    ];
    expect(matchContactByName('Ashley', dup)).toBeNull();
  });

  it('returns null when no match', () => {
    expect(matchContactByName('Unknown Person', existing)).toBeNull();
    expect(matchContactByName('', existing)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// buildEnrichmentPatch
// ──────────────────────────────────────────────────────────────────

describe('buildEnrichmentPatch', () => {
  it('fills only NULL fields, never overwrites', () => {
    const existing = {
      title: null,
      email: 'manual@edit.com',
      phone_mobile: null,
      phone_office: null,
    };
    const parsed = {
      title: 'RSD',
      email: 'parsed@import.com',
      phone: '(949)854-9500',
      phoneKind: 'mobile',
    };
    expect(buildEnrichmentPatch(existing, parsed)).toEqual({
      title: 'RSD',
      phone_mobile: '(949)854-9500',
    });
  });

  it('routes unspecified phone kind to phone_mobile (per BD agreement)', () => {
    const existing = { title: null, email: null, phone_mobile: null, phone_office: null };
    const parsed = { title: null, email: null, phone: '(310)555-1212', phoneKind: null };
    expect(buildEnrichmentPatch(existing, parsed)).toEqual({
      phone_mobile: '(310)555-1212',
    });
  });

  it('routes office phone to phone_office', () => {
    const existing = { title: null, email: null, phone_mobile: null, phone_office: null };
    const parsed = { title: null, email: null, phone: '(949)837-4500 x27073', phoneKind: 'office' };
    expect(buildEnrichmentPatch(existing, parsed)).toEqual({
      phone_office: '(949)837-4500 x27073',
    });
  });

  it('returns null when nothing would change', () => {
    const existing = {
      title: 'RSD',
      email: 'a@b.com',
      phone_mobile: '(949)854-9500',
      phone_office: null,
    };
    const parsed = {
      title: 'New Title',
      email: 'new@email.com',
      phone: '(310)555-9999',
      phoneKind: 'mobile',
    };
    expect(buildEnrichmentPatch(existing, parsed)).toBeNull();
  });

  it('returns null when parsed has no usable fields', () => {
    const existing = { title: null, email: null, phone_mobile: null, phone_office: null };
    const parsed = { title: null, email: null, phone: null, phoneKind: null };
    expect(buildEnrichmentPatch(existing, parsed)).toBeNull();
  });
});
