import { describe, it, expect } from 'vitest';
import { buildPaychexWorker, detectRehire } from '../workerMapping';

// Canonical TC-shaped settings; individual tests override fields they
// care about via spread.
const TC_SETTINGS = {
  paychex: {
    display_id: '70125496',
    company_id: '00M9LQF7LUBLSED1THE0',
    default_employment_type: 'FULL_TIME',
    default_exemption_type: 'NON_EXEMPT',
  },
  payroll: {
    default_pending_hire_date_offset_days: 14,
    default_work_state: 'CA',
    timezone: 'America/Los_Angeles',
  },
};

const TC_CAREGIVER = {
  id: 'cg_abc123',
  first_name: 'Jane',
  last_name: 'Doe',
};

describe('buildPaychexWorker — required fields', () => {
  it('maps every TC default field to the Paychex worker shape', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });

    expect(w).toEqual({
      workerCorrelationId: 'cg_abc123',
      workerType: 'EMPLOYEE',
      employmentType: 'FULL_TIME',
      exemptionType: 'NON_EXEMPT',
      name: { givenName: 'Jane', familyName: 'Doe' },
      currentStatus: {
        statusType: 'IN_PROGRESS',
        statusReason: 'PENDING_HIRE',
        effectiveDate: '2026-05-09',
      },
    });
  });

  it('uses caregiver.id as workerCorrelationId verbatim', () => {
    const w = buildPaychexWorker({
      caregiver: { ...TC_CAREGIVER, id: 'caregiver_with_a_long_uuid_id' },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.workerCorrelationId).toBe('caregiver_with_a_long_uuid_id');
  });

  it('always sets workerType to EMPLOYEE (W-2 only at launch)', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.workerType).toBe('EMPLOYEE');
  });

  it('does not include legalId, birthDate, or hireDate', () => {
    const w = buildPaychexWorker({
      caregiver: {
        ...TC_CAREGIVER,
        // Even if a caregiver row somehow contained these, the mapper
        // must drop them — sensitive PII goes through Paychex's
        // hosted onboarding flow, never through our DB.
        legalId: '111-22-3333',
        birthDate: '1990-01-01',
        hire_date: '2026-04-01',
      },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w).not.toHaveProperty('legalId');
    expect(w).not.toHaveProperty('birthDate');
    expect(w).not.toHaveProperty('hireDate');
  });
});

describe('buildPaychexWorker — name handling', () => {
  it('passes given/family names through trimmed', () => {
    const w = buildPaychexWorker({
      caregiver: { ...TC_CAREGIVER, first_name: '  Jane  ', last_name: '  Doe  ' },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name).toEqual({ givenName: 'Jane', familyName: 'Doe' });
  });

  it('omits middleName and preferredName when not present (TC default)', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name).not.toHaveProperty('middleName');
    expect(w.name).not.toHaveProperty('preferredName');
  });

  it('includes middleName when caregiver row carries it (snake_case)', () => {
    const w = buildPaychexWorker({
      caregiver: { ...TC_CAREGIVER, middle_name: 'Marie' },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name.middleName).toBe('Marie');
  });

  it('includes preferredName when caregiver row carries nickname', () => {
    const w = buildPaychexWorker({
      caregiver: { ...TC_CAREGIVER, nickname: 'Janie' },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name.preferredName).toBe('Janie');
  });

  it('treats empty-string and whitespace-only optional names as absent', () => {
    const w = buildPaychexWorker({
      caregiver: { ...TC_CAREGIVER, middle_name: '   ', preferred_name: '' },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name).not.toHaveProperty('middleName');
    expect(w.name).not.toHaveProperty('preferredName');
  });

  it('accepts camelCase aliases (firstName, lastName, middleName, preferredName)', () => {
    const w = buildPaychexWorker({
      caregiver: {
        id: 'cg_xyz',
        firstName: 'Alex',
        lastName: 'Kim',
        middleName: 'J',
        preferredName: 'AJ',
      },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name).toEqual({
      givenName: 'Alex',
      familyName: 'Kim',
      middleName: 'J',
      preferredName: 'AJ',
    });
  });

  it('preserves accented characters and apostrophes in names', () => {
    const w = buildPaychexWorker({
      caregiver: {
        id: 'cg_special',
        first_name: "M'élie",
        last_name: 'O’Connor-García',
      },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name.givenName).toBe("M'élie");
    expect(w.name.familyName).toBe('O’Connor-García');
  });

  it('preserves internal whitespace (e.g., "Mary Jo")', () => {
    const w = buildPaychexWorker({
      caregiver: { id: 'cg_mj', first_name: 'Mary Jo', last_name: 'St. Clair' },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name.givenName).toBe('Mary Jo');
    expect(w.name.familyName).toBe('St. Clair');
  });

  it('passes through the unmistakable "TestCaregiver DoNotPay" record', () => {
    const w = buildPaychexWorker({
      caregiver: {
        id: 'cg_test_donotpay',
        first_name: 'TestCaregiver',
        last_name: 'DoNotPay',
      },
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.name).toEqual({
      givenName: 'TestCaregiver',
      familyName: 'DoNotPay',
    });
  });

  it('throws when first_name is missing', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: { id: 'cg_x', last_name: 'Doe' },
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/first_name or last_name/);
  });

  it('throws when last_name is missing', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: { id: 'cg_x', first_name: 'Jane' },
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/first_name or last_name/);
  });

  it('throws when first_name is null', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: { id: 'cg_x', first_name: null, last_name: 'Doe' },
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/first_name or last_name/);
  });

  it('throws when names are empty strings', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: { id: 'cg_x', first_name: '   ', last_name: 'Doe' },
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/first_name or last_name/);
  });
});

describe('buildPaychexWorker — currentStatus / effectiveDate', () => {
  it('always uses IN_PROGRESS / PENDING_HIRE for new workers', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.currentStatus.statusType).toBe('IN_PROGRESS');
    expect(w.currentStatus.statusReason).toBe('PENDING_HIRE');
  });

  it('computes effectiveDate as referenceDate + 14 days for TC default', () => {
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }).currentStatus.effectiveDate,
    ).toBe('2026-05-09');
  });

  it('crosses month boundaries correctly', () => {
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-01-25',
      }).currentStatus.effectiveDate,
    ).toBe('2026-02-08');
  });

  it('crosses year boundaries correctly', () => {
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-12-25',
      }).currentStatus.effectiveDate,
    ).toBe('2027-01-08');
  });

  it('handles leap-year February correctly', () => {
    // 2028 is a leap year. Feb 20 + 14 = Mar 5 (29-day Feb).
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: '2028-02-20',
      }).currentStatus.effectiveDate,
    ).toBe('2028-03-05');
  });

  it('honors a per-org offset override', () => {
    const settings = {
      ...TC_SETTINGS,
      payroll: { ...TC_SETTINGS.payroll, default_pending_hire_date_offset_days: 30 },
    };
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: settings,
        referenceDate: '2026-04-25',
      }).currentStatus.effectiveDate,
    ).toBe('2026-05-25');
  });

  it('accepts an offset of 0 (today)', () => {
    const settings = {
      ...TC_SETTINGS,
      payroll: { ...TC_SETTINGS.payroll, default_pending_hire_date_offset_days: 0 },
    };
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: settings,
        referenceDate: '2026-04-25',
      }).currentStatus.effectiveDate,
    ).toBe('2026-04-25');
  });

  it('falls back to 14-day offset when org omits the setting', () => {
    const settings = {
      paychex: { default_employment_type: 'FULL_TIME', default_exemption_type: 'NON_EXEMPT' },
      payroll: {},
    };
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: settings,
        referenceDate: '2026-04-25',
      }).currentStatus.effectiveDate,
    ).toBe('2026-05-09');
  });

  it('falls back to 14-day offset when org setting is non-integer (e.g., null, "14", -1)', () => {
    for (const bad of [null, undefined, '14', 14.5, -1, NaN]) {
      const settings = {
        ...TC_SETTINGS,
        payroll: { ...TC_SETTINGS.payroll, default_pending_hire_date_offset_days: bad },
      };
      expect(
        buildPaychexWorker({
          caregiver: TC_CAREGIVER,
          orgSettings: settings,
          referenceDate: '2026-04-25',
        }).currentStatus.effectiveDate,
      ).toBe('2026-05-09');
    }
  });

  it('accepts referenceDate as a Date instance', () => {
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: new Date('2026-04-25T00:00:00.000Z'),
      }).currentStatus.effectiveDate,
    ).toBe('2026-05-09');
  });

  it('accepts referenceDate as a full ISO timestamp', () => {
    expect(
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25T18:30:00.000Z',
      }).currentStatus.effectiveDate,
    ).toBe('2026-05-09');
  });

  it('throws when referenceDate is unparseable', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: 'not a date',
      }),
    ).toThrow(/not a valid date/);
  });
});

describe('buildPaychexWorker — employmentType / exemptionType', () => {
  it('uses TC default FULL_TIME / NON_EXEMPT', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: TC_SETTINGS,
      referenceDate: '2026-04-25',
    });
    expect(w.employmentType).toBe('FULL_TIME');
    expect(w.exemptionType).toBe('NON_EXEMPT');
  });

  it('honors per-org overrides for both types', () => {
    const settings = {
      ...TC_SETTINGS,
      paychex: {
        ...TC_SETTINGS.paychex,
        default_employment_type: 'PART_TIME',
        default_exemption_type: 'EXEMPT',
      },
    };
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: settings,
      referenceDate: '2026-04-25',
    });
    expect(w.employmentType).toBe('PART_TIME');
    expect(w.exemptionType).toBe('EXEMPT');
  });

  it('falls back to TC defaults when paychex settings missing entirely', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: {},
      referenceDate: '2026-04-25',
    });
    expect(w.employmentType).toBe('FULL_TIME');
    expect(w.exemptionType).toBe('NON_EXEMPT');
  });

  it('falls back when orgSettings is undefined', () => {
    const w = buildPaychexWorker({
      caregiver: TC_CAREGIVER,
      orgSettings: undefined,
      referenceDate: '2026-04-25',
    });
    expect(w.employmentType).toBe('FULL_TIME');
    expect(w.exemptionType).toBe('NON_EXEMPT');
  });
});

describe('buildPaychexWorker — argument validation', () => {
  it('throws when caregiver is missing', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: null,
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/caregiver is required/);
  });

  it('throws when caregiver.id is missing', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: { first_name: 'Jane', last_name: 'Doe' },
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/caregiver\.id is required/);
  });

  it('throws when caregiver.id is empty string', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: { id: '   ', first_name: 'Jane', last_name: 'Doe' },
        orgSettings: TC_SETTINGS,
        referenceDate: '2026-04-25',
      }),
    ).toThrow(/caregiver\.id is required/);
  });

  it('throws when referenceDate is missing', () => {
    expect(() =>
      buildPaychexWorker({
        caregiver: TC_CAREGIVER,
        orgSettings: TC_SETTINGS,
        referenceDate: null,
      }),
    ).toThrow(/referenceDate is required/);
  });
});

describe('detectRehire', () => {
  it('returns rehire:false for an active worker', () => {
    expect(
      detectRehire({
        workerId: 'pw_1',
        currentStatus: { statusType: 'ACTIVE', statusReason: 'HIRED', effectiveDate: '2024-06-01' },
      }),
    ).toEqual({ rehire: false });
  });

  it('returns rehire:false for an in-progress worker', () => {
    expect(
      detectRehire({
        currentStatus: { statusType: 'IN_PROGRESS', statusReason: 'PENDING_HIRE', effectiveDate: '2026-05-09' },
      }),
    ).toEqual({ rehire: false });
  });

  it('returns rehire:true with last termination metadata for TERMINATED', () => {
    expect(
      detectRehire({
        workerId: 'pw_99',
        currentStatus: {
          statusType: 'TERMINATED',
          statusReason: 'RESIGNED',
          effectiveDate: '2025-12-15',
        },
      }),
    ).toEqual({
      rehire: true,
      lastTerminationDate: '2025-12-15',
      lastTerminationReason: 'RESIGNED',
    });
  });

  it('returns nulls for last-termination fields when Paychex omits them', () => {
    expect(
      detectRehire({
        currentStatus: { statusType: 'TERMINATED' },
      }),
    ).toEqual({
      rehire: true,
      lastTerminationDate: null,
      lastTerminationReason: null,
    });
  });

  it('handles missing or malformed worker shapes gracefully', () => {
    expect(detectRehire(undefined)).toEqual({ rehire: false });
    expect(detectRehire(null)).toEqual({ rehire: false });
    expect(detectRehire({})).toEqual({ rehire: false });
    expect(detectRehire({ currentStatus: null })).toEqual({ rehire: false });
    expect(detectRehire({ currentStatus: 'TERMINATED' })).toEqual({ rehire: false });
  });
});
