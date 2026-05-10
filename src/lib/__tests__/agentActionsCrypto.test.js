// Phase 1.1.A — pure-crypto helper tests.
//
// Web Crypto's Ed25519 is supported in Node 20+ via crypto.subtle
// — same surface as Deno. These tests run in jsdom which inherits
// Node's crypto.subtle, so they exercise the exact code paths the
// production runtime hits.
//
// One caveat the test suite navigates: Web Crypto's Ed25519 doesn't
// support deriving the public key from a seed-imported private key.
// For round-trip verify tests we use `crypto.subtle.generateKey()`
// which returns a {privateKey, publicKey} pair — both are valid
// Ed25519 keys we can sign and verify with. The production path
// imports a 32-byte seed; that import is verified by the
// `importSigningKey` rejection tests + a successful sign call.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  canonicalJson,
  chainHashInput,
  sha256Hex,
  computeRowHash,
  importSigningKey,
  importVerifyKey,
  signHex,
  verifyHex,
  bytesToHex,
  hexToBytes,
  postgresTimestampToNanos,
} from '../../../supabase/functions/_shared/operations/agentActionsCrypto.ts';

// A deterministic 32-byte test seed. NOT for production use.
const TEST_SEED_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SEED = hexToBytes(TEST_SEED_HEX);

describe('canonicalJson', () => {
  it('returns "null" for null/undefined', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('JSON-encodes primitives', () => {
    expect(canonicalJson('a')).toBe('"a"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
  });

  it('sorts object keys at every nesting level', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts deeply nested keys', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: { f: 3, e: 4 } }))
      .toBe('{"a":{"e":4,"f":3},"b":{"c":2,"d":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('canonicalizes objects inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('produces identical output for equivalent inputs', () => {
    const a = canonicalJson({ x: 1, y: { b: 2, a: 3 } });
    const b = canonicalJson({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });
});

describe('chainHashInput', () => {
  const baseInputs = {
    prev_hash:     '',
    agent_id:      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agent_version: 1,
    action_type:   'agent_flag_toggled',
    phase:         'executed',
    entity_type:   null,
    entity_id:     null,
    actor:         'user:test@example.com',
    payload:       { flag: 'kill_switch', new_value: true },
    outcome_id:    null,
    created_at_ns: '1715292000000000000',
  };

  it('joins fields with the unit separator (ASCII 0x1f)', () => {
    expect(chainHashInput(baseInputs)).toContain('\x1f');
  });

  it('represents nulls as empty strings (verifiable from row)', () => {
    // entity_type=null, entity_id=null: two consecutive empties
    // separated only by separators.
    expect(chainHashInput(baseInputs)).toContain('\x1f\x1f');
  });

  it('different prev_hash → different output', () => {
    const a = chainHashInput(baseInputs);
    const b = chainHashInput({ ...baseInputs, prev_hash: 'aaaa' });
    expect(a).not.toBe(b);
  });

  it('different payload → different output', () => {
    const a = chainHashInput({ ...baseInputs, payload: { x: 1 } });
    const b = chainHashInput({ ...baseInputs, payload: { x: 2 } });
    expect(a).not.toBe(b);
  });

  it('canonicalizes payload (key order does not matter)', () => {
    const a = chainHashInput({ ...baseInputs, payload: { a: 1, b: 2 } });
    const b = chainHashInput({ ...baseInputs, payload: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });
});

describe('sha256Hex / computeRowHash', () => {
  it('produces 64 hex chars (256 bits)', async () => {
    const out = await sha256Hex('hello');
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the well-known SHA-256("abc")', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('computeRowHash is deterministic for the same inputs', async () => {
    const inputs = {
      prev_hash: '', agent_id: 'a', agent_version: 1,
      action_type: 't', phase: 'executed',
      entity_type: null, entity_id: null,
      actor: 'system', payload: { x: 1 },
      outcome_id: null, created_at_ns: '1',
    };
    expect(await computeRowHash(inputs)).toBe(await computeRowHash(inputs));
  });

  it('any field change flips the hash', async () => {
    const base = {
      prev_hash: '', agent_id: 'a', agent_version: 1,
      action_type: 't', phase: 'executed',
      entity_type: null, entity_id: null,
      actor: 'system', payload: { x: 1 },
      outcome_id: null, created_at_ns: '1',
    };
    const baseHash = await computeRowHash(base);
    for (const key of ['prev_hash', 'agent_id', 'action_type', 'phase', 'actor', 'created_at_ns']) {
      const tampered = { ...base, [key]: 'TAMPERED' };
      expect(await computeRowHash(tampered)).not.toBe(baseHash);
    }
    expect(await computeRowHash({ ...base, agent_version: 2 })).not.toBe(baseHash);
    expect(await computeRowHash({ ...base, payload: { x: 2 } })).not.toBe(baseHash);
  });
});

describe('Ed25519 — seed import (production path)', () => {
  it('imports a valid 32-byte seed', async () => {
    const key = await importSigningKey(TEST_SEED);
    expect(key).toBeDefined();
    expect(key.algorithm.name).toBe('Ed25519');
    expect(key.type).toBe('private');
  });

  it('rejects seeds that are not exactly 32 bytes', async () => {
    await expect(importSigningKey(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    await expect(importSigningKey(new Uint8Array(33))).rejects.toThrow(/32 bytes/);
  });

  it('rejects public keys that are not exactly 32 bytes', async () => {
    await expect(importVerifyKey(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it('imported seed-key produces deterministic signatures', async () => {
    // Web Crypto's Ed25519 sign is deterministic per RFC 8032; the
    // same seed signing the same message always produces the same
    // signature. This is what makes verification possible at all.
    const key = await importSigningKey(TEST_SEED);
    const msg = await sha256Hex('hello');
    const sig1 = await signHex(key, msg);
    const sig2 = await signHex(key, msg);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{128}$/); // 64 bytes = 128 hex
  });
});

describe('Ed25519 — sign + verify round-trip (using generateKey)', () => {
  // Web Crypto can't derive the public component of a seed-imported
  // Ed25519 private key in a portable way. For round-trip tests we
  // generate a fresh keypair per spec; both keys are valid Ed25519
  // primitives and sign/verify identically to the seed-import path.
  let signKey, verifyKey;

  beforeEach(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    );
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
  });

  it('verifies a valid signature', async () => {
    const msg = await sha256Hex('hello world');
    const sig = await signHex(signKey, msg);
    expect(await verifyHex(verifyKey, msg, sig)).toBe(true);
  });

  it('rejects when the message is tampered', async () => {
    const msg = await sha256Hex('hello world');
    const sig = await signHex(signKey, msg);
    const tampered = await sha256Hex('hello WORLD');
    expect(await verifyHex(verifyKey, tampered, sig)).toBe(false);
  });

  it('rejects when the signature is tampered', async () => {
    const msg = await sha256Hex('hello world');
    const sig = await signHex(signKey, msg);
    const sigBytes = hexToBytes(sig);
    sigBytes[0] ^= 0x01;
    const tamperedSig = bytesToHex(sigBytes);
    expect(await verifyHex(verifyKey, msg, tamperedSig)).toBe(false);
  });

  it('rejects against an unrelated public key', async () => {
    const msg = await sha256Hex('hello');
    const sig = await signHex(signKey, msg);
    const otherPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    expect(await verifyHex(otherPair.publicKey, msg, sig)).toBe(false);
  });
});

describe('hex helpers', () => {
  it('round-trips bytes ↔ hex', () => {
    const bytes = new Uint8Array([0, 1, 0xfe, 0xff, 0x42]);
    expect(bytesToHex(bytes)).toBe('0001feff42');
    expect(hexToBytes('0001feff42')).toEqual(bytes);
  });

  it('strips 0x prefix', () => {
    expect(hexToBytes('0xab')).toEqual(new Uint8Array([0xab]));
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd length/);
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBytes('zz')).toThrow(/non-hex/);
  });
});

describe('postgresTimestampToNanos', () => {
  it('parses microsecond-precision timestamp to nanos', () => {
    const ns = postgresTimestampToNanos('2026-05-09 21:33:42.123456+00');
    expect(ns).toMatch(/^\d+$/);
    expect(BigInt(ns) > 0n).toBe(true);
  });

  it('handles ISO format', () => {
    expect(postgresTimestampToNanos('2026-05-09T21:33:42.123456Z')).toMatch(/^\d+$/);
  });

  it('handles timestamps without microseconds', () => {
    expect(postgresTimestampToNanos('2026-05-09T21:33:42Z')).toMatch(/^\d+000000000$/);
  });

  it('rejects unparseable input', () => {
    expect(() => postgresTimestampToNanos('not-a-date')).toThrow(/unparseable/);
  });

  it('different micros produce different nanos', () => {
    const a = postgresTimestampToNanos('2026-05-09T21:33:42.000001Z');
    const b = postgresTimestampToNanos('2026-05-09T21:33:42.000002Z');
    expect(a).not.toBe(b);
  });
});
