// Phase 1.1.B — verifier tests.
//
// Builds chains of valid agent_actions rows in-memory, runs the
// verifier, and asserts:
//   - clean chains report verified == total_rows, no errors
//   - tampered rows produce the right error reason at the right
//     row_index
//   - broken chain links (mismatched prev_hash) are caught
//   - signature tampering is caught
//
// All crypto runs against Web Crypto, same as production.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  verifyAgentActionsChain,
  deriveVerifyKeyFromSeed,
} from '../../../supabase/functions/_shared/operations/agentActionsVerify.ts';
import {
  ChainInputs,
  computeRowHash,
  importSigningKey,
  signHex,
  hexToBytes,
} from '../../../supabase/functions/_shared/operations/agentActionsCrypto.ts';

const TEST_SEED_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SEED = hexToBytes(TEST_SEED_HEX);

let signKey;
let verifyKey;

beforeAll(async () => {
  signKey = await importSigningKey(TEST_SEED);
  verifyKey = await deriveVerifyKeyFromSeed(TEST_SEED);
});

// Build a single signed row given the prior row's hash + content.
async function makeRow({
  id, orgId = 'org-1', agentId = 'agent-1', agentVersion = 1,
  actionType = 'agent_flag_toggled', phase = 'executed',
  entityType = null, entityId = null,
  actor = 'system:test', payload = { x: 1 }, outcomeId = null,
  prevHash, createdAt,
}) {
  const inputs = {
    prev_hash:     prevHash,
    agent_id:      agentId,
    agent_version: agentVersion,
    action_type:   actionType,
    phase,
    entity_type:   entityType,
    entity_id:     entityId,
    actor,
    payload,
    outcome_id:    outcomeId,
    created_at_ns: nanos(createdAt),
  };
  const row_hash = await computeRowHash(inputs);
  const signature = await signHex(signKey, row_hash);
  return {
    id,
    org_id: orgId,
    agent_id: agentId,
    agent_version: agentVersion,
    action_type: actionType,
    phase,
    entity_type: entityType,
    entity_id: entityId,
    actor,
    payload,
    outcome_id: outcomeId,
    created_at: createdAt,
    prev_hash: prevHash,
    row_hash,
    signature,
  };
}

function nanos(iso) {
  // Mirror postgresTimestampToNanos for consistent test data.
  const date = new Date(iso);
  const millis = Math.floor(date.getTime());
  const wholeSec = Math.floor(millis / 1000);
  const match = iso.match(/\.(\d+)/);
  const microFrac = match ? Number((match[1] + '000000').slice(0, 6)) : 0;
  return (BigInt(wholeSec) * 1_000_000_000n + BigInt(microFrac) * 1000n).toString();
}

async function buildCleanChain(length) {
  const rows = [];
  let prevHash = '';
  const baseTime = new Date('2026-05-09T20:00:00.000000Z').getTime();
  for (let i = 0; i < length; i++) {
    const ts = new Date(baseTime + i * 60_000).toISOString();
    const row = await makeRow({
      id: `row-${i}`,
      prevHash,
      createdAt: ts,
    });
    rows.push(row);
    prevHash = row.row_hash;
  }
  return rows;
}

describe('verifyAgentActionsChain — clean chains', () => {
  it('empty chain reports 0/0 with no errors', async () => {
    const report = await verifyAgentActionsChain([], verifyKey, 'org-1');
    expect(report.org_id).toBe('org-1');
    expect(report.total_rows).toBe(0);
    expect(report.verified).toBe(0);
    expect(report.first_break_at).toBeNull();
    expect(report.errors).toEqual([]);
  });

  it('single-row chain with empty prev_hash (genesis) verifies', async () => {
    const rows = await buildCleanChain(1);
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.total_rows).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.first_break_at).toBeNull();
  });

  it('long clean chain verifies all rows', async () => {
    const rows = await buildCleanChain(10);
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.total_rows).toBe(10);
    expect(report.verified).toBe(10);
    expect(report.errors).toEqual([]);
  });
});

describe('verifyAgentActionsChain — break detection', () => {
  it('detects hash_mismatch when payload was tampered', async () => {
    const rows = await buildCleanChain(3);
    // Tamper with row[1]'s payload after the fact.
    rows[1].payload = { x: 999, evil: true };
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.first_break_at).toBe('row-1');
    expect(report.first_break_reason).toBe('hash_mismatch');
    expect(report.errors[0].row_index).toBe(1);
  });

  it('detects hash_mismatch when actor was tampered', async () => {
    const rows = await buildCleanChain(3);
    rows[2].actor = 'user:attacker';
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.first_break_at).toBe('row-2');
    expect(report.first_break_reason).toBe('hash_mismatch');
  });

  it('detects broken_chain_link when prev_hash was tampered', async () => {
    const rows = await buildCleanChain(3);
    rows[1].prev_hash = 'a'.repeat(64); // wrong but well-formed
    // Tampering with prev_hash also invalidates the row's row_hash
    // (because row_hash depends on prev_hash). The first error
    // detected is broken_chain_link, since we check chain link
    // before recomputing the hash.
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.first_break_at).toBe('row-1');
    expect(report.first_break_reason).toBe('broken_chain_link');
  });

  it('detects signature_invalid when signature was tampered', async () => {
    const rows = await buildCleanChain(2);
    // Flip a hex char in the signature.
    rows[0].signature = '0' + rows[0].signature.slice(1);
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.first_break_at).toBe('row-0');
    expect(report.first_break_reason).toBe('signature_invalid');
  });

  it('continues checking after first break (forensic mode)', async () => {
    const rows = await buildCleanChain(3);
    rows[0].actor = 'tampered';
    rows[2].actor = 'also tampered';
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    // first_break_at is the first one; errors include both
    expect(report.first_break_at).toBe('row-0');
    expect(report.errors.length).toBeGreaterThanOrEqual(2);
    const errorRowIds = report.errors.map(e => e.row_id).sort();
    expect(errorRowIds).toEqual(['row-0', 'row-2']);
  });

  it('caps errors at 100 when the whole chain is broken', async () => {
    const rows = await buildCleanChain(150);
    // Tamper every row's payload.
    for (const r of rows) r.payload = { evil: true };
    const report = await verifyAgentActionsChain(rows, verifyKey, 'org-1');
    expect(report.errors.length).toBe(100);
    expect(report.verified).toBe(0);
  });

  it('rejects rows signed with a different key', async () => {
    const rows = await buildCleanChain(2);
    // Use a totally different verify key.
    const otherSeed = new Uint8Array(32).fill(0x42);
    const otherVerifyKey = await deriveVerifyKeyFromSeed(otherSeed);
    const report = await verifyAgentActionsChain(rows, otherVerifyKey, 'org-1');
    // Hashes still recompute correctly (verifier doesn't use the
    // signing key for hashing), but every signature fails.
    expect(report.first_break_reason).toBe('signature_invalid');
    expect(report.errors.length).toBe(rows.length);
  });
});

describe('deriveVerifyKeyFromSeed', () => {
  it('produces a verify-only Ed25519 CryptoKey', async () => {
    const k = await deriveVerifyKeyFromSeed(TEST_SEED);
    expect(k.algorithm.name).toBe('Ed25519');
    expect(k.type).toBe('public');
    expect(k.usages).toContain('verify');
  });

  it('rejects non-32-byte seeds', async () => {
    await expect(deriveVerifyKeyFromSeed(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it('roundtrip: signing with seed → verifying with derived key works', async () => {
    const verifyKey2 = await deriveVerifyKeyFromSeed(TEST_SEED);
    // signKey was imported from the same seed. Sign + verify
    // through the helper functions (mirrored production path).
    const msg = await computeRowHash({
      prev_hash: '', agent_id: 'a', agent_version: 1,
      action_type: 't', phase: 'executed',
      entity_type: null, entity_id: null,
      actor: 's', payload: {}, outcome_id: null,
      created_at_ns: '0',
    });
    const sig = await signHex(signKey, msg);
    const ok = await crypto.subtle.verify(
      'Ed25519',
      verifyKey2,
      hexToBytes(sig),
      hexToBytes(msg),
    );
    expect(ok).toBe(true);
  });
});
