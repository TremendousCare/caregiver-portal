// Phase 1.1.B — agent_actions chain verifier.
//
// Pure logic that walks rows in chain order and checks two things
// per row:
//   1. row_hash matches SHA-256(prev_hash ‖ ...row fields...) — the
//      hash chain is intact. Catches direct DB tampering on any
//      column the hash covers.
//   2. signature is a valid Ed25519 signature of row_hash by the
//      org's signing key. Catches forgery from a service-role
//      caller that wrote a row with arbitrary content but no
//      legitimate signature.
//
// The verifier is org-scoped: each org has its own chain (genesis
// row has prev_hash = ''). For the single-tenant Tremendous Care
// deployment that's fine; multi-org rollout (SaaS Phase B5+) will
// iterate orgs and verify each chain independently.
//
// Output is structured so a caller (the cron handler, or the
// future export endpoint) can either:
//   - Pass it back as JSON for monitoring
//   - Write to events table on any break for paging integration
//   - Aggregate across orgs

import {
  ChainInputs,
  computeRowHash,
  verifyHex,
  postgresTimestampToNanos,
} from './agentActionsCrypto.ts';

// Database row shape (subset of agent_actions columns the verifier reads).
export interface AgentActionRow {
  id:             string;
  org_id:         string;
  agent_id:       string;
  agent_version:  number;
  action_type:    string;
  phase:          string;
  entity_type:    string | null;
  entity_id:      string | null;
  actor:          string;
  payload:        unknown;
  outcome_id:     string | null;
  created_at:     string;
  prev_hash:      string;
  row_hash:       string;
  signature:      string;
}

export interface VerifyReport {
  org_id:        string;
  total_rows:    number;
  verified:      number;
  first_break_at: string | null;        // row id of the first failed row, if any
  first_break_reason: string | null;    // 'hash_mismatch' | 'signature_invalid' | 'broken_chain_link'
  errors:        VerifyError[];          // one per broken row, capped
}

export interface VerifyError {
  row_id:    string;
  row_index: number;       // position in the chain (0 = genesis)
  reason:    'hash_mismatch' | 'signature_invalid' | 'broken_chain_link';
  detail:    string;
}

const MAX_ERRORS = 100;     // cap so a fully-broken chain doesn't OOM the report

// Walk a chain in chronological order (caller passes rows ordered by
// (created_at ASC, id ASC) — the same order writes happen in). For
// each row:
//   1. Recompute the chain hash from stored fields.
//   2. Verify the recomputed hash equals stored row_hash.
//   3. Verify the row's prev_hash equals the previous row's row_hash
//      (or '' for the genesis).
//   4. Verify the signature against the verify key (Ed25519 public
//      counterpart of the same seed used to sign).
//
// `verifyKey` is a CryptoKey for the org's Ed25519 public key. The
// caller imports it once (via importVerifyKey) and passes here.

export async function verifyAgentActionsChain(
  rows: AgentActionRow[],
  verifyKey: CryptoKey,
  orgId: string,
): Promise<VerifyReport> {
  const errors: VerifyError[] = [];
  let firstBreakAt: string | null = null;
  let firstBreakReason: VerifyReport['first_break_reason'] = null;
  let verified = 0;
  let expectedPrev = '';   // chain starts with empty prev_hash

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const breaks: VerifyError[] = [];

    // Check 1: chain link.
    if (row.prev_hash !== expectedPrev) {
      breaks.push({
        row_id: row.id,
        row_index: i,
        reason: 'broken_chain_link',
        detail: `expected prev_hash=${expectedPrev || '(genesis)'} got ${row.prev_hash}`,
      });
    }

    // Check 2: row hash recomputation.
    const inputs: ChainInputs = {
      prev_hash:     row.prev_hash,
      agent_id:      row.agent_id,
      agent_version: row.agent_version,
      action_type:   row.action_type,
      phase:         row.phase,
      entity_type:   row.entity_type,
      entity_id:     row.entity_id,
      actor:         row.actor,
      payload:       row.payload,
      outcome_id:    row.outcome_id,
      created_at_ns: postgresTimestampToNanos(row.created_at),
    };
    const recomputedHash = await computeRowHash(inputs);
    if (recomputedHash !== row.row_hash) {
      breaks.push({
        row_id: row.id,
        row_index: i,
        reason: 'hash_mismatch',
        detail: `recomputed=${recomputedHash} stored=${row.row_hash}`,
      });
    }

    // Check 3: signature verification.
    let sigValid = false;
    try {
      sigValid = await verifyHex(verifyKey, row.row_hash, row.signature);
    } catch (err) {
      sigValid = false;
    }
    if (!sigValid) {
      breaks.push({
        row_id: row.id,
        row_index: i,
        reason: 'signature_invalid',
        detail: `Ed25519 verify failed for row_hash=${row.row_hash}`,
      });
    }

    if (breaks.length === 0) {
      verified++;
    } else if (errors.length < MAX_ERRORS) {
      // Push first error per row (other checks still ran for diagnostics
      // but we keep the report compact).
      errors.push(breaks[0]);
      if (firstBreakAt === null) {
        firstBreakAt = row.id;
        firstBreakReason = breaks[0].reason;
      }
    }

    // Advance the expected prev_hash to this row's row_hash regardless
    // of whether it verified — that lets us continue checking the
    // chain even after a break, which is useful for forensics.
    expectedPrev = row.row_hash;
  }

  return {
    org_id: orgId,
    total_rows: rows.length,
    verified,
    first_break_at: firstBreakAt,
    first_break_reason: firstBreakReason,
    errors,
  };
}

// Convenience: derive an Ed25519 public key from a 32-byte seed by
// importing the seed as a private key, then using crypto.subtle's
// jwk export to extract the matching public key. Web Crypto exposes
// the public component on the privateKey CryptoKey via the jwk
// format on Node 20+ and Deno.
//
// Used by the cron handler to load the same key the writer uses,
// without keeping a separate public-key env var.
export async function deriveVerifyKeyFromSeed(seed: Uint8Array): Promise<CryptoKey> {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  // Reuse the PKCS#8 wrapper from agentActionsCrypto for symmetry,
  // but we want extractable=true so jwk export works.
  const ED25519_PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00,
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'],
  );
  // Export as jwk to get the 'x' field, which is the base64url-
  // encoded 32-byte public key. (Web Crypto fills 'x' even when
  // exporting a private jwk for Ed25519.)
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (!jwk.x) {
    throw new Error('Ed25519 jwk export missing public component (x)');
  }
  // Re-import as a public key.
  return await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
}
