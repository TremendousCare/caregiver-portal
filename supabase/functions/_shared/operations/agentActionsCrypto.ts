// Phase 1.1.A — pure cryptographic primitives for the agent_actions
// hash chain.
//
// All functions are pure (no Postgres, no env reads). They live in
// this isolated file so:
//   * Vitest can test them in Node without faking Deno globals.
//   * The verifier edge function (PR 1.1.B) can re-import the same
//     functions and produce byte-equal hashes/signatures, which is
//     exactly what we want for chain verification.
//
// Crypto choices:
//   - SHA-256 for the chain hash (Web Crypto API, available in both
//     Deno and Node 20+ via the same `crypto.subtle` interface).
//   - Ed25519 for the signature (also Web Crypto). Per the locked
//     plan, key material is a 32-byte seed loaded from env until
//     SaaS Phase C lands per-org Vault keys.
//
// Hash content (extending the locked spec — see
// docs/AGENT_PLATFORM.md → Phase 1.1):
//   row_hash = SHA-256(prev_hash
//                      || agent_id
//                      || agent_version
//                      || action_type
//                      || phase
//                      || entity_type
//                      || entity_id
//                      || actor
//                      || canonical(payload)
//                      || outcome_id
//                      || created_at_ns)
// Each component is separated by a '\x1f' (ASCII unit separator)
// byte so a clever attacker can't construct a different field
// combination that hashes to the same string. Empty/NULL fields are
// represented as the empty string between separators — verifiable
// from the row at audit time.

// ─── Canonical JSON ───
//
// Deterministic JSON serialization: sort keys at every nesting
// level, no whitespace, JSON.stringify's default escaping. Matches
// what Postgres' jsonb storage round-trips through to_jsonb (modulo
// numeric precision, which we accept as a known limitation: if the
// runtime ever round-trips through float64 the chain hashes can
// drift; document and revisit at Phase 1.5 grading).

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]));
  }
  return '{' + parts.join(',') + '}';
}

// ─── Chain hash ───
//
// All inputs are coerced to strings and joined with a 0x1f
// separator. This produces a unique byte string per row, which is
// then hashed with SHA-256. The verifier in PR 1.1.B reads the same
// fields from the agent_actions row and recomputes the hash; any
// change to any field (or to the prev_hash linkage) breaks the
// chain.

export interface ChainInputs {
  prev_hash:       string;            // '' for genesis row
  agent_id:        string;            // uuid
  agent_version:   number;
  action_type:     string;
  phase:           string;            // suggested|confirmed|...
  entity_type:     string | null;
  entity_id:       string | null;     // uuid or null
  actor:           string;
  payload:         unknown;           // any jsonb-shaped value
  outcome_id:      string | null;     // uuid or null
  created_at_ns:   string;            // nanosecond-precision timestamp
}

const SEP = '\x1f'; // ASCII unit separator

export function chainHashInput(inputs: ChainInputs): string {
  const parts = [
    inputs.prev_hash,
    inputs.agent_id,
    String(inputs.agent_version),
    inputs.action_type,
    inputs.phase,
    inputs.entity_type ?? '',
    inputs.entity_id ?? '',
    inputs.actor,
    canonicalJson(inputs.payload ?? {}),
    inputs.outcome_id ?? '',
    inputs.created_at_ns,
  ];
  return parts.join(SEP);
}

// SHA-256 → hex. Uses Web Crypto, available in Deno and Node 20+
// without imports. Async because crypto.subtle is async.
export async function sha256Hex(message: string): Promise<string> {
  const encoded = new TextEncoder().encode(message);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(buf));
}

export async function computeRowHash(inputs: ChainInputs): Promise<string> {
  return sha256Hex(chainHashInput(inputs));
}

// ─── Ed25519 signing / verification ───
//
// The signing key is a 32-byte seed. Web Crypto's Ed25519 import
// expects raw private key bytes (the 32-byte seed) for 'pkcs8' or
// 'raw'. We use 'raw' which is the simplest — both Deno and Node 20+
// support this for Ed25519.
//
// Public key derivation: importing the seed as a private key and
// then exporting 'raw' returns the public key. Cached per-call by
// the caller to avoid re-importing on every signature.

export async function importSigningKey(seed: Uint8Array): Promise<CryptoKey> {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  // Web Crypto Ed25519 expects PKCS#8 for private import. Wrap the
  // raw 32-byte seed in the minimal PKCS#8 envelope.
  const pkcs8 = wrapEd25519SeedAsPkcs8(seed);
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,            // extractable so we can derive public key
    ['sign'],
  );
}

export async function importVerifyKey(publicKeyRaw: Uint8Array): Promise<CryptoKey> {
  if (publicKeyRaw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKeyRaw.length}`);
  }
  return await crypto.subtle.importKey(
    'raw',
    publicKeyRaw,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
}

export async function signHex(privateKey: CryptoKey, hexMessage: string): Promise<string> {
  const messageBytes = hexToBytes(hexMessage);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, messageBytes);
  return bytesToHex(new Uint8Array(sig));
}

export async function verifyHex(
  publicKey: CryptoKey,
  hexMessage: string,
  hexSignature: string,
): Promise<boolean> {
  const messageBytes = hexToBytes(hexMessage);
  const sigBytes = hexToBytes(hexSignature);
  return await crypto.subtle.verify('Ed25519', publicKey, sigBytes, messageBytes);
}

// ─── Hex helpers ───

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new Error('hex must be a string');
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hex contains non-hex character at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

// ─── Nanosecond timestamp ───
//
// Postgres' now() has microsecond precision; we widen to nanoseconds
// to make the hash input slightly more collision-resistant. The
// last three digits are always 000 for now() readings; they're
// included so we can later swap in true nanosecond clocks (e.g. for
// throughput-bursty agents) without breaking the chain hash format.

export function postgresTimestampToNanos(pgTimestamp: string): string {
  // Accepts forms like '2026-05-09 21:33:42.123456+00' or
  // '2026-05-09T21:33:42.123456Z'. Returns the timestamp's nanos
  // since unix epoch as a decimal string.
  const date = new Date(pgTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`unparseable pg timestamp: ${pgTimestamp}`);
  }
  // Microsecond fraction: parse from the original string if present.
  // Date#getTime() only gives us millis; we extract the trailing
  // microseconds from the source.
  const match = String(pgTimestamp).match(/\.(\d+)/);
  let microFrac = 0;
  if (match) {
    const padded = (match[1] + '000000').slice(0, 6);
    microFrac = Number(padded); // 0..999999
  }
  // millis * 1_000_000 + micros * 1000 = nanoseconds
  const millisSinceEpoch = Math.floor(date.getTime());
  const wholeSeconds = Math.floor(millisSinceEpoch / 1000);
  // Subtract the millisecond portion that's already represented in
  // microFrac (Date parses .123 into millis=123; we want nanos =
  // micros * 1000, derived purely from the source fraction).
  const nanos = BigInt(wholeSeconds) * 1_000_000_000n + BigInt(microFrac) * 1000n;
  return nanos.toString();
}

// ─── PKCS#8 envelope for raw Ed25519 seed ───
//
// Web Crypto's importKey with format='pkcs8' for Ed25519 requires the
// private key wrapped in this fixed ASN.1 prefix. The prefix is
// constant for Ed25519 (RFC 8410), so we hard-code the 16 bytes
// rather than building an ASN.1 encoder.
//
// PKCS#8 envelope:
//   30 2e 02 01 00          -- SEQUENCE, version=0
//   30 05 06 03 2b 65 70    -- AlgorithmIdentifier(id-Ed25519)
//   04 22 04 20 <32-byte seed>
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00,
  0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function wrapEd25519SeedAsPkcs8(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(seed, ED25519_PKCS8_PREFIX.length);
  return out;
}
