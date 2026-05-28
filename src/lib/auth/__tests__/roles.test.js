import { describe, it, expect } from 'vitest';
import { isAdminRole, isOwnerRole, isStaffRole } from '../roles';

describe('isStaffRole', () => {
  it('true for admin/member/owner', () => {
    expect(isStaffRole('admin')).toBe(true);
    expect(isStaffRole('member')).toBe(true);
    expect(isStaffRole('owner')).toBe(true);
  });
  it('false for caregiver/null/junk', () => {
    expect(isStaffRole('caregiver')).toBe(false);
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
    expect(isStaffRole('')).toBe(false);
    expect(isStaffRole('Admin')).toBe(false); // case-sensitive — matches DB convention
  });
});

describe('isAdminRole', () => {
  it('true for admin and owner (hierarchy: owner IS admin)', () => {
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('owner')).toBe(true);
  });
  it('false for member/caregiver/null', () => {
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('caregiver')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe('isOwnerRole', () => {
  it('true only for owner', () => {
    expect(isOwnerRole('owner')).toBe(true);
  });
  it('false for admin/member/caregiver/null', () => {
    expect(isOwnerRole('admin')).toBe(false);
    expect(isOwnerRole('member')).toBe(false);
    expect(isOwnerRole('caregiver')).toBe(false);
    expect(isOwnerRole(null)).toBe(false);
  });
});

describe('hierarchy contract (mirrors DB-side helpers)', () => {
  // Postgres equivalent: public.is_admin() matches role IN ('admin','owner');
  // public.is_staff() matches role IN ('admin','member','owner').
  // These tests would catch a drift where the frontend and DB disagree.
  it('every owner is staff and admin', () => {
    expect(isStaffRole('owner')).toBe(true);
    expect(isAdminRole('owner')).toBe(true);
  });
  it('every admin is staff', () => {
    expect(isStaffRole('admin')).toBe(true);
  });
  it('members are staff but not admin', () => {
    expect(isStaffRole('member')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
  });
});
