import { describe, it, expect } from 'vitest';
import {
  detectSmsOptOutIntent,
  OPT_OUT_CONFIRMATION_MESSAGE,
  OPT_IN_CONFIRMATION_MESSAGE,
} from '../messaging/smsOptOut';

describe('detectSmsOptOutIntent', () => {
  describe('opt-out keywords', () => {
    it.each([
      'STOP',
      'stop',
      'Stop',
      'STOPALL',
      'UNSUBSCRIBE',
      'unsubscribe',
      'CANCEL',
      'END',
      'QUIT',
    ])('classifies "%s" as opt_out', (msg) => {
      expect(detectSmsOptOutIntent(msg)).toBe('opt_out');
    });

    it('tolerates trailing punctuation', () => {
      expect(detectSmsOptOutIntent('STOP.')).toBe('opt_out');
      expect(detectSmsOptOutIntent('STOP!')).toBe('opt_out');
      expect(detectSmsOptOutIntent('stop?')).toBe('opt_out');
    });

    it('tolerates leading/trailing whitespace', () => {
      expect(detectSmsOptOutIntent('  STOP  ')).toBe('opt_out');
      expect(detectSmsOptOutIntent('\nSTOP\t')).toBe('opt_out');
    });

    it('accepts keyword as first token with extra words after', () => {
      expect(detectSmsOptOutIntent('STOP please')).toBe('opt_out');
      expect(detectSmsOptOutIntent('stop texting me')).toBe('opt_out');
      expect(detectSmsOptOutIntent('UNSUBSCRIBE thanks')).toBe('opt_out');
    });
  });

  describe('opt-in keywords', () => {
    it.each(['START', 'start', 'UNSTOP', 'SUBSCRIBE'])(
      'classifies "%s" as opt_in',
      (msg) => {
        expect(detectSmsOptOutIntent(msg)).toBe('opt_in');
      },
    );
  });

  describe('non-keyword messages', () => {
    it('returns null for ordinary replies', () => {
      expect(detectSmsOptOutIntent('Yes')).toBeNull();
      expect(detectSmsOptOutIntent('Hi, can you call me?')).toBeNull();
      expect(detectSmsOptOutIntent('I can work Tuesday')).toBeNull();
    });

    it('does not match keyword buried inside a sentence', () => {
      // Only the first token is checked — "stop" must start the message.
      expect(
        detectSmsOptOutIntent("please don't stop texting me"),
      ).toBeNull();
      expect(detectSmsOptOutIntent('I cannot work END of week')).toBeNull();
      expect(
        detectSmsOptOutIntent('Will you cancel my shift?'),
      ).toBeNull();
    });

    it('does not match misspellings or substrings', () => {
      expect(detectSmsOptOutIntent('STOPP')).toBeNull();
      expect(detectSmsOptOutIntent('stopped')).toBeNull();
      expect(detectSmsOptOutIntent('stopping')).toBeNull();
      expect(detectSmsOptOutIntent('ending soon')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty / whitespace-only input', () => {
      expect(detectSmsOptOutIntent('')).toBeNull();
      expect(detectSmsOptOutIntent('   ')).toBeNull();
      expect(detectSmsOptOutIntent('\n\t')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(detectSmsOptOutIntent(null)).toBeNull();
      expect(detectSmsOptOutIntent(undefined)).toBeNull();
      expect(detectSmsOptOutIntent(123)).toBeNull();
      expect(detectSmsOptOutIntent({ text: 'STOP' })).toBeNull();
    });
  });
});

describe('confirmation messages', () => {
  it('opt-out confirmation references the brand and how to resubscribe', () => {
    expect(OPT_OUT_CONFIRMATION_MESSAGE).toMatch(/Tremendous Care/);
    expect(OPT_OUT_CONFIRMATION_MESSAGE).toMatch(/START/);
  });

  it('opt-in confirmation references how to opt out again', () => {
    expect(OPT_IN_CONFIRMATION_MESSAGE).toMatch(/Tremendous Care/);
    expect(OPT_IN_CONFIRMATION_MESSAGE).toMatch(/STOP/);
  });
});
