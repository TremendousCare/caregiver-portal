// Phase 1.1.A — agent_actions write helper.
//
// `recordAgentAction` is the canonical entry point. It:
//   1. Reads the latest row's row_hash for this org (claimed_prev_hash).
//   2. Computes the chain hash of the new row.
//   3. Signs the hash with the org's Ed25519 signing key.
//   4. Calls record_agent_action_v1 RPC, which verifies the chain
//      link is still valid under a per-org advisory lock and then
//      INSERTs.
//   5. On chain conflict (sqlstate P0001), retries up to 3 times
//      with fresh prev_hash. If still conflicting, gives up and
//      returns an error to the caller — the caller decides whether
//      to surface or swallow (Phase 1.1.B's wiring will swallow with
//      a metric so a hot agent doesn't bring down its own runtime).
//
// The signing key is loaded once per process from
// `AGENT_ACTIONS_ED25519_SEED` env var (32 bytes, hex-encoded).
// Per-org keys land in SaaS Phase C; for now Tremendous Care has
// one key. The constant `KEY_ENV_VAR_NAME` is a sentinel to grep
// for at Phase C cutover.

import {
  ChainInputs,
  computeRowHash,
  importSigningKey,
  signHex,
  hexToBytes,
  postgresTimestampToNanos,
} from './agentActionsCrypto.ts';

export const KEY_ENV_VAR_NAME = 'AGENT_ACTIONS_ED25519_SEED';
const MAX_RETRIES = 3;

export type AgentActionPhase =
  | 'suggested'
  | 'confirmed'
  | 'executed'
  | 'auto_executed'
  | 'rejected'
  | 'expired'
  | 'shadow';

export interface AgentActionInput {
  orgId:        string;
  agentId:      string;
  agentVersion: number;
  actionType:   string;
  phase:        AgentActionPhase;
  entityType:   'caregiver' | 'client' | null;
  entityId:     string | null;
  actor:        string;
  payload:      unknown;
  outcomeId:    string | null;
}

export interface RecordResult {
  success: boolean;
  id?:     string;
  error?:  Error;
  retries?: number;
}

// Load + cache the signing key. The crypto seed comes from env at
// process start; we import it on first use. Tests inject a mock
// signing key via the `signingKeyOverride` parameter to avoid
// touching env.
let cachedSigningKey: CryptoKey | null = null;

async function getSigningKey(
  signingKeyOverride?: CryptoKey,
  envOverride?: string,
): Promise<CryptoKey> {
  if (signingKeyOverride) return signingKeyOverride;
  if (cachedSigningKey) return cachedSigningKey;

  const seedHex = envOverride ?? readEnv(KEY_ENV_VAR_NAME);
  if (!seedHex) {
    throw new Error(`${KEY_ENV_VAR_NAME} env var is not set`);
  }
  const seedBytes = hexToBytes(seedHex);
  cachedSigningKey = await importSigningKey(seedBytes);
  return cachedSigningKey;
}

// Test hook: allow specs to reset the cache between cases.
export function __resetSigningKeyCache() {
  cachedSigningKey = null;
}

// Deno-and-Node-safe env reader. In Deno, Deno.env.get exists.
// In Node (vitest), process.env exists.
function readEnv(name: string): string | undefined {
  // @ts-ignore — Deno is undefined in Node
  if (typeof Deno !== 'undefined' && Deno.env?.get) {
    // @ts-ignore
    return Deno.env.get(name);
  }
  // @ts-ignore — process is undefined in Deno
  if (typeof process !== 'undefined' && process.env) {
    // @ts-ignore
    return process.env[name];
  }
  return undefined;
}

// ─── Public entry point ───

export async function recordAgentAction(
  supabase: any,
  input: AgentActionInput,
  options: {
    signingKeyOverride?: CryptoKey;
    envOverride?: string;
    /** For tests + mocks: override what the function reads as the
     *  current Postgres timestamp. The runtime path uses the value
     *  the RPC writes via DEFAULT now(); we precompute here so the
     *  hash matches what'll land in the row's created_at field. */
    nowIso?: string;
  } = {},
): Promise<RecordResult> {
  let signingKey: CryptoKey;
  try {
    signingKey = await getSigningKey(options.signingKeyOverride, options.envOverride);
  } catch (err) {
    return { success: false, error: err as Error, retries: 0 };
  }
  const nowIso = options.nowIso ?? new Date().toISOString();
  const createdAtNs = postgresTimestampToNanos(nowIso);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 1. Read the latest row's hash for this org.
    //    MUST order by chain_seq DESC to match record_agent_action_v1's
    //    own tip read. chain_seq is the strictly-monotonic IDENTITY
    //    column that defines chain order; created_at is NOT a safe proxy
    //    because two concurrent inserts can land with created_at ordered
    //    opposite to chain_seq (same-millisecond ties). When that
    //    happens, reading by created_at returns a different "tip" than
    //    the RPC validates against, so claimed_prev_hash never matches
    //    actual → every write fails P0001 chain_conflict, permanently,
    //    until a row with a later created_at is appended (which can't
    //    happen because every append is blocked). This exact inversion
    //    froze the chain on 2026-05-12 and went unnoticed for weeks
    //    because the failure is swallowed by callers. Keep this ORDER BY
    //    byte-identical to the RPC's.
    const { data: latestRow, error: readErr } = await supabase
      .from('agent_actions')
      .select('row_hash')
      .eq('org_id', input.orgId)
      .order('chain_seq', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (readErr) {
      return { success: false, error: new Error(`prev_hash read failed: ${readErr.message}`), retries: attempt };
    }
    const claimedPrevHash: string = latestRow?.row_hash ?? '';

    // 2. Compute hash + sign.
    const chainInputs: ChainInputs = {
      prev_hash:     claimedPrevHash,
      agent_id:      input.agentId,
      agent_version: input.agentVersion,
      action_type:   input.actionType,
      phase:         input.phase,
      entity_type:   input.entityType,
      entity_id:     input.entityId,
      actor:         input.actor,
      payload:       input.payload,
      outcome_id:    input.outcomeId,
      created_at_ns: createdAtNs,
    };
    const rowHash = await computeRowHash(chainInputs);
    const signature = await signHex(signingKey, rowHash);

    // 3. Call the RPC. We pass nowIso as p_created_at so the row
    //    stores the EXACT timestamp the hash was computed against
    //    — the verifier (PR 1.1.B) reads stored created_at and
    //    recomputes; the hashes only match if the timestamps are
    //    bit-identical. Codex P1 on the original PR caught that an
    //    earlier draft let DEFAULT now() populate created_at, which
    //    drifted from nowIso by milliseconds and would have failed
    //    every row at verification. The RPC bounds p_created_at to
    //    ±5 minutes from server now() to prevent backdating.
    const { data: insertedId, error: rpcErr } = await supabase.rpc('record_agent_action_v1', {
      p_org_id:            input.orgId,
      p_agent_id:          input.agentId,
      p_agent_version:     input.agentVersion,
      p_action_type:       input.actionType,
      p_phase:             input.phase,
      p_entity_type:       input.entityType,
      p_entity_id:         input.entityId,
      p_actor:             input.actor,
      p_payload:           input.payload ?? {},
      p_outcome_id:        input.outcomeId,
      p_created_at:        nowIso,
      p_claimed_prev_hash: claimedPrevHash,
      p_row_hash:          rowHash,
      p_signature:         signature,
    });

    if (!rpcErr) {
      return { success: true, id: insertedId, retries: attempt };
    }

    lastError = new Error(rpcErr.message || String(rpcErr));
    // Chain conflict → retry. Anything else → bail.
    const conflict = (rpcErr as any).code === 'P0001'
      || /agent_actions_chain_conflict/.test(String(rpcErr.message || ''));
    if (!conflict) {
      return { success: false, error: lastError, retries: attempt };
    }
    // Loop and retry with fresh prev_hash.
  }

  return {
    success: false,
    error: lastError ?? new Error('agent_actions chain conflict — retries exhausted'),
    retries: MAX_RETRIES + 1,
  };
}
