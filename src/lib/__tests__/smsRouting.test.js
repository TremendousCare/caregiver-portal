import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMS_CATEGORY,
  resolveSmsCategory,
} from '../../../supabase/functions/_shared/helpers/smsRouting.ts';

describe('smsRouting', () => {
  describe('resolveSmsCategory', () => {
    it('returns the explicit category when set on action_config', () => {
      expect(resolveSmsCategory({ category: 'onboarding' })).toBe('onboarding');
      expect(resolveSmsCategory({ category: 'scheduling' })).toBe('scheduling');
      expect(resolveSmsCategory({ category: 'general' })).toBe('general');
    });

    it('preserves custom (future) categories without validation', () => {
      // Forward-compatible: routing layer is data-driven, so any string
      // that matches a row in communication_routes will work at runtime.
      expect(resolveSmsCategory({ category: 'retention' })).toBe('retention');
    });

    it('falls back to the default when action_config is null', () => {
      expect(resolveSmsCategory(null)).toBe(DEFAULT_SMS_CATEGORY);
      expect(resolveSmsCategory(null)).toBe('general');
    });

    it('falls back to the default when action_config is undefined', () => {
      expect(resolveSmsCategory(undefined)).toBe(DEFAULT_SMS_CATEGORY);
    });

    it('falls back to the default when category field is missing', () => {
      expect(resolveSmsCategory({})).toBe(DEFAULT_SMS_CATEGORY);
      expect(resolveSmsCategory({ subject: 'Hi' })).toBe(DEFAULT_SMS_CATEGORY);
    });

    it('falls back to the default when category is an empty string', () => {
      expect(resolveSmsCategory({ category: '' })).toBe(DEFAULT_SMS_CATEGORY);
    });

    it('falls back to the default when category is a non-string value', () => {
      expect(resolveSmsCategory({ category: 42 })).toBe(DEFAULT_SMS_CATEGORY);
      expect(resolveSmsCategory({ category: true })).toBe(DEFAULT_SMS_CATEGORY);
      expect(resolveSmsCategory({ category: { nested: 'onboarding' } })).toBe(DEFAULT_SMS_CATEGORY);
      expect(resolveSmsCategory({ category: null })).toBe(DEFAULT_SMS_CATEGORY);
    });

    it('honors a custom fallback when provided', () => {
      expect(resolveSmsCategory(null, 'onboarding')).toBe('onboarding');
      expect(resolveSmsCategory({}, 'scheduling')).toBe('scheduling');
      // Explicit category still wins over custom fallback.
      expect(resolveSmsCategory({ category: 'general' }, 'onboarding')).toBe('general');
    });

    it('exposes DEFAULT_SMS_CATEGORY as "general"', () => {
      expect(DEFAULT_SMS_CATEGORY).toBe('general');
    });
  });
});
