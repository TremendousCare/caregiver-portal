import { describe, it, expect } from 'vitest';
import {
  normalizePaychexEmployeeId,
  getPaychexSetupStatus,
} from '../caregiverPayrollSetup.js';

describe('normalizePaychexEmployeeId', () => {
  it('returns null for nullish input', () => {
    expect(normalizePaychexEmployeeId(null)).toBeNull();
    expect(normalizePaychexEmployeeId(undefined)).toBeNull();
  });

  it('returns null for empty / whitespace-only strings', () => {
    expect(normalizePaychexEmployeeId('')).toBeNull();
    expect(normalizePaychexEmployeeId('   ')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePaychexEmployeeId('  54  ')).toBe('54');
  });

  it('coerces numeric input to a string', () => {
    expect(normalizePaychexEmployeeId(54)).toBe('54');
  });

  it('preserves alphanumeric IDs as-is', () => {
    expect(normalizePaychexEmployeeId('A12')).toBe('A12');
  });
});

describe('getPaychexSetupStatus', () => {
  it('is ready when a Paychex employee ID is present', () => {
    const status = getPaychexSetupStatus({ paychexEmployeeId: '54' });
    expect(status.ready).toBe(true);
    expect(status.code).toBe('linked');
    expect(status.employeeId).toBe('54');
    expect(status.label).toContain('54');
  });

  it('trims before deciding readiness', () => {
    const status = getPaychexSetupStatus({ paychexEmployeeId: ' 67 ' });
    expect(status.ready).toBe(true);
    expect(status.employeeId).toBe('67');
  });

  it('is not ready when the ID is missing', () => {
    const status = getPaychexSetupStatus({ paychexEmployeeId: null });
    expect(status.ready).toBe(false);
    expect(status.code).toBe('missing_employee_id');
    expect(status.employeeId).toBeNull();
  });

  it('is not ready when the ID is an empty string', () => {
    expect(getPaychexSetupStatus({ paychexEmployeeId: '' }).ready).toBe(false);
  });

  it('tolerates a missing/undefined caregiver object', () => {
    expect(getPaychexSetupStatus(undefined).ready).toBe(false);
    expect(getPaychexSetupStatus(null).ready).toBe(false);
    expect(getPaychexSetupStatus({}).ready).toBe(false);
  });
});
