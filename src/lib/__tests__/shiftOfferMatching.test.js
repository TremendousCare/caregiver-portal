/**
 * Tests for the shift-offer matcher.
 *
 * Covers:
 *   - Phone-based caregiver lookup (duplicate caregiver records sharing
 *     a phone). Regression test for the bug where the inbound got tagged
 *     to one record but the offer was created against another.
 *   - Shift-start-aware match window (offer stays actionable until the
 *     shift starts, capped at 48h since send).
 *   - Auto-assign happy path: shift flag on, response 'yes', shift open.
 *   - Auto-assign skipped when the shift was claimed by a peer (race).
 *   - Backward-compat for the legacy positional signature.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  matchInboundShiftOfferResponse,
  OFFER_MATCH_MAX_AGE_HOURS,
} from '../../../supabase/functions/_shared/operations/shiftOfferMatching.ts';

// ─── In-memory mock Supabase client ──────────────────────────────
//
// Tracks reads / writes against three tables: caregivers, shift_offers,
// and shifts. Builder methods chain fluently and resolve at await time.
// Only models the surface area the matcher actually uses.

function makeMock({
  caregivers = [],
  offers = [],
  shifts = [],
  invokeImpl = async () => ({ data: null, error: null }),
} = {}) {
  const state = { caregivers, offers, shifts };
  const updates = { offers: [], shifts: [] };
  const invokeCalls = [];

  function caregiverQuery() {
    const filters = { ids: null, phones: null, archived: null };
    const builder = {
      select() {
        return builder;
      },
      in(col, vals) {
        if (col === 'phone') filters.phones = vals;
        if (col === 'id') filters.ids = vals;
        return builder;
      },
      eq(col, val) {
        if (col === 'archived') filters.archived = val;
        return builder;
      },
      then(resolve) {
        let rows = state.caregivers;
        if (filters.phones) rows = rows.filter((c) => filters.phones.includes(c.phone));
        if (filters.ids) rows = rows.filter((c) => filters.ids.includes(c.id));
        if (filters.archived === false) rows = rows.filter((c) => !c.archived);
        resolve({ data: rows.map((c) => ({ id: c.id })), error: null });
      },
    };
    return builder;
  }

  function shiftOffersQuery() {
    let mode = 'select';
    const filters = {
      caregiverIds: null,
      status: null,
      sentAtGte: null,
      shiftId: null,
      offerId: null,
      neqOfferId: null,
      statusIn: null,
    };
    let pendingUpdate = null;

    const builder = {
      select() {
        return builder;
      },
      update(patch) {
        mode = 'update';
        pendingUpdate = patch;
        return builder;
      },
      in(col, vals) {
        if (col === 'caregiver_id') filters.caregiverIds = vals;
        if (col === 'status') filters.statusIn = vals;
        return builder;
      },
      eq(col, val) {
        if (col === 'status') filters.status = val;
        if (col === 'shift_id') filters.shiftId = val;
        if (col === 'id') filters.offerId = val;
        return builder;
      },
      neq(col, val) {
        if (col === 'id') filters.neqOfferId = val;
        return builder;
      },
      gte(col, val) {
        if (col === 'sent_at') filters.sentAtGte = val;
        return builder;
      },
      order() {
        return builder;
      },
      then(resolve) {
        if (mode === 'update') {
          const matched = state.offers.filter((o) => {
            if (filters.offerId && o.id !== filters.offerId) return false;
            if (filters.shiftId && o.shift_id !== filters.shiftId) return false;
            if (filters.neqOfferId && o.id === filters.neqOfferId) return false;
            if (filters.statusIn && !filters.statusIn.includes(o.status)) return false;
            return true;
          });
          for (const offer of matched) {
            updates.offers.push({ id: offer.id, patch: pendingUpdate });
            Object.assign(offer, pendingUpdate);
          }
          resolve({ data: matched, error: null });
          return;
        }
        let rows = state.offers;
        if (filters.caregiverIds) rows = rows.filter((o) => filters.caregiverIds.includes(o.caregiver_id));
        if (filters.status) rows = rows.filter((o) => o.status === filters.status);
        if (filters.sentAtGte) {
          rows = rows.filter((o) => new Date(o.sent_at).getTime() >= new Date(filters.sentAtGte).getTime());
        }
        // Embed the shift if select includes the join. We always embed for tests.
        const enriched = rows.map((o) => ({
          ...o,
          shift: state.shifts.find((s) => s.id === o.shift_id) || null,
        }));
        enriched.sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
        resolve({ data: enriched, error: null });
      },
    };
    return builder;
  }

  function shiftsQuery() {
    let pendingUpdate = null;
    const filters = { id: null, assignedNull: false, statusIn: null };
    let mode = 'select';

    const builder = {
      select() {
        return builder;
      },
      update(patch) {
        mode = 'update';
        pendingUpdate = patch;
        return builder;
      },
      eq(col, val) {
        if (col === 'id') filters.id = val;
        return builder;
      },
      is(col, val) {
        if (col === 'assigned_caregiver_id' && val === null) filters.assignedNull = true;
        return builder;
      },
      in(col, vals) {
        if (col === 'status') filters.statusIn = vals;
        return builder;
      },
      maybeSingle() {
        if (mode === 'update') {
          const row = state.shifts.find((s) => {
            if (s.id !== filters.id) return false;
            if (filters.assignedNull && s.assigned_caregiver_id != null) return false;
            if (filters.statusIn && !filters.statusIn.includes(s.status)) return false;
            return true;
          });
          if (row) {
            updates.shifts.push({ id: row.id, patch: pendingUpdate });
            Object.assign(row, pendingUpdate);
            return Promise.resolve({ data: row, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        const row = state.shifts.find((s) => s.id === filters.id);
        return Promise.resolve({ data: row || null, error: null });
      },
      then(resolve) {
        if (mode === 'update') {
          const row = state.shifts.find((s) => {
            if (s.id !== filters.id) return false;
            if (filters.assignedNull && s.assigned_caregiver_id != null) return false;
            if (filters.statusIn && !filters.statusIn.includes(s.status)) return false;
            return true;
          });
          if (row) {
            updates.shifts.push({ id: row.id, patch: pendingUpdate });
            Object.assign(row, pendingUpdate);
            resolve({ data: row, error: null });
          } else {
            resolve({ data: null, error: null });
          }
          return;
        }
        const row = state.shifts.find((s) => s.id === filters.id);
        resolve({ data: row || null, error: null });
      },
    };
    return builder;
  }

  function clientsQuery() {
    const filters = { id: null };
    return {
      select() {
        return this;
      },
      eq(col, val) {
        if (col === 'id') filters.id = val;
        return this;
      },
      maybeSingle() {
        return Promise.resolve({
          data: { id: filters.id, first_name: 'Alice', last_name: 'Johnson', address: '123 Main', city: 'Bellevue', state: 'WA' },
          error: null,
        });
      },
    };
  }

  return {
    state,
    updates,
    invokeCalls,
    from(table) {
      if (table === 'caregivers') {
        // Distinguish the candidate-id phone lookup from the conf SMS
        // caregiver fetch by inspecting whether the caller chains in() vs eq().
        return makeCaregiverDualBuilder(state, caregiverQuery);
      }
      if (table === 'shift_offers') return shiftOffersQuery();
      if (table === 'shifts') return shiftsQuery();
      if (table === 'clients') return clientsQuery();
      throw new Error(`Unexpected table: ${table}`);
    },
    functions: {
      invoke: vi.fn(async (name, args) => {
        invokeCalls.push({ name, args });
        return invokeImpl(name, args);
      }),
    },
  };
}

// The caregivers table is queried in two shapes:
//   1) candidate lookup: select('id').in('phone', [...]).eq('archived', false)
//   2) confirmation sms : select('id, first_name, ...').eq('id', X).maybeSingle()
// Build a single dual-mode builder that supports both call shapes.
function makeCaregiverDualBuilder(state, candidateBuilderFactory) {
  const filters = { id: null };
  let mode = 'unknown';
  const candidate = candidateBuilderFactory();
  const builder = {
    select(cols) {
      mode = (cols || '').includes('first_name') ? 'single' : 'candidate';
      return mode === 'single' ? builder : candidate.select();
    },
    in(...args) {
      return candidate.in(...args);
    },
    eq(col, val) {
      if (mode === 'single') {
        if (col === 'id') filters.id = val;
        return builder;
      }
      return candidate.eq(col, val);
    },
    maybeSingle() {
      const row = state.caregivers.find((c) => c.id === filters.id);
      return Promise.resolve({
        data: row
          ? { id: row.id, first_name: row.first_name, last_name: row.last_name, phone: row.phone }
          : null,
        error: null,
      });
    },
    then(resolve) {
      // Candidate path
      candidate.then(resolve);
    },
  };
  return builder;
}

// ─── Fixtures ────────────────────────────────────────────────────

const NOW = new Date('2026-05-04T22:00:00Z').toISOString();
const SHIFT_START_TOMORROW = '2026-05-05T18:00:00Z';
const SHIFT_START_FUTURE_LATER = '2026-05-06T18:00:00Z';

function baseShift(overrides = {}) {
  return {
    id: 'shift-A',
    client_id: 'client-1',
    assigned_caregiver_id: null,
    start_time: SHIFT_START_TOMORROW,
    end_time: '2026-05-05T22:00:00Z',
    status: 'offered',
    auto_assign_on_first_yes: false,
    ...overrides,
  };
}

function baseOffer(overrides = {}) {
  return {
    id: 'offer-A',
    shift_id: 'shift-A',
    caregiver_id: 'cg-1',
    status: 'sent',
    sent_at: '2026-05-04T21:30:00Z',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('matchInboundShiftOfferResponse — phone-based fallback', () => {
  it('matches an offer when the inbound got tagged to a duplicate caregiver record sharing the phone', async () => {
    // Two caregiver rows share the same phone. The shift_offer was sent
    // to caregiver A; the inbound got matched to caregiver B. Without the
    // phone fallback the lookup misses the offer.
    const supabase = makeMock({
      caregivers: [
        { id: 'cg-A', first_name: 'Kevin', last_name: 'A', phone: '5868720673', archived: false },
        { id: 'cg-B', first_name: 'KevSteve', last_name: 'B', phone: '5868720673', archived: false },
      ],
      offers: [baseOffer({ id: 'offer-1', caregiver_id: 'cg-A' })],
      shifts: [baseShift()],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-B',
      senderPhone: '+15868720673',
      messageText: 'Yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.offerId).toBe('offer-1');
    expect(result.newStatus).toBe('accepted');
    expect(result.response).toBe('yes');
  });

  it('falls back to caregiverId only when no phone is provided', async () => {
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: '5868720673', archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift()],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'Yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe('accepted');
  });

  it('returns unmatched when there is no caregiverId and no phone', async () => {
    const supabase = makeMock({ offers: [baseOffer()], shifts: [baseShift()] });
    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: null,
      senderPhone: null,
      messageText: 'Yes',
      messageReceivedAt: NOW,
    });
    expect(result.matched).toBe(false);
  });
});

describe('matchInboundShiftOfferResponse — match window', () => {
  it('skips offers whose shift has already started', async () => {
    const pastStart = '2026-05-04T20:00:00Z'; // before NOW
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift({ start_time: pastStart })],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'Yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(false);
  });

  it('matches offers whose shift starts later today or tomorrow', async () => {
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift({ start_time: SHIFT_START_FUTURE_LATER })],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'Yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe('accepted');
  });

  it(`is bounded by OFFER_MATCH_MAX_AGE_HOURS (${OFFER_MATCH_MAX_AGE_HOURS}h)`, async () => {
    // Set the offer sent_at to 2x the cap ago.
    const tooOld = new Date(Date.parse(NOW) - (OFFER_MATCH_MAX_AGE_HOURS + 1) * 3600 * 1000).toISOString();
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer({ sent_at: tooOld })],
      shifts: [baseShift()],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'Yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(false);
  });
});

describe('matchInboundShiftOfferResponse — auto-assign on first yes', () => {
  it('auto-assigns the shift, expires peer offers, and invokes the bulk-sms confirmation when the shift is opted in', async () => {
    const supabase = makeMock({
      caregivers: [
        { id: 'cg-1', first_name: 'Maria', last_name: 'G', phone: '+15555550001', archived: false },
        { id: 'cg-2', first_name: 'Jose', last_name: 'P', phone: '+15555550002', archived: false },
      ],
      offers: [
        baseOffer({ id: 'offer-1', caregiver_id: 'cg-1' }),
        baseOffer({ id: 'offer-2', caregiver_id: 'cg-2' }),
      ],
      shifts: [baseShift({ auto_assign_on_first_yes: true })],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'YES',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.autoAssigned).toBe(true);

    // The shift was claimed
    const claimed = supabase.updates.shifts.find((u) => u.id === 'shift-A');
    expect(claimed?.patch.assigned_caregiver_id).toBe('cg-1');
    expect(claimed?.patch.status).toBe('assigned');

    // The winning offer is now 'assigned'
    const winningUpdate = supabase.updates.offers.find(
      (u) => u.id === 'offer-1' && u.patch.status === 'assigned',
    );
    expect(winningUpdate).toBeDefined();

    // The peer offer was expired
    const peerUpdate = supabase.updates.offers.find(
      (u) => u.patch.status === 'expired',
    );
    expect(peerUpdate).toBeDefined();

    // Confirmation SMS sent via bulk-sms
    expect(supabase.functions.invoke).toHaveBeenCalledWith('bulk-sms', expect.objectContaining({
      body: expect.objectContaining({
        caregiver_ids: ['cg-1'],
        category: 'scheduling',
      }),
    }));
  });

  it('does NOT auto-assign when the shift flag is off, even on a yes', async () => {
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift({ auto_assign_on_first_yes: false })],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe('accepted');
    expect(result.autoAssigned).toBe(false);
    expect(supabase.updates.shifts).toHaveLength(0);
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('does NOT auto-assign when another caregiver already won the race (shift assigned)', async () => {
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift({
        auto_assign_on_first_yes: true,
        assigned_caregiver_id: 'cg-other',
        status: 'assigned',
      })],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'yes',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe('accepted');
    expect(result.autoAssigned).toBe(false);
    // No assignment write
    expect(supabase.updates.shifts).toHaveLength(0);
  });

  it('records "no" replies as declined without auto-assigning', async () => {
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift({ auto_assign_on_first_yes: true })],
    });

    const result = await matchInboundShiftOfferResponse(supabase, {
      caregiverId: 'cg-1',
      messageText: 'no, busy',
      messageReceivedAt: NOW,
    });

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe('declined');
    expect(result.autoAssigned).toBe(false);
  });
});

describe('matchInboundShiftOfferResponse — backward compat', () => {
  it('still accepts the legacy positional signature (caregiverId, messageText, receivedAt)', async () => {
    const supabase = makeMock({
      caregivers: [{ id: 'cg-1', phone: null, archived: false }],
      offers: [baseOffer()],
      shifts: [baseShift()],
    });

    const result = await matchInboundShiftOfferResponse(supabase, 'cg-1', 'yes', NOW);
    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe('accepted');
  });
});
