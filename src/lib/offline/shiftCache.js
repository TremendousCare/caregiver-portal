// ─── Shift data offline cache ───
// Caches the caregiver's shift, client, and clock-event data so the shift
// list and detail screens render in the field with no connectivity. We
// deliberately do NOT cache Supabase responses at the service-worker
// layer (those must always hit the network when online); this is an
// explicit app-level cache written on every successful online load.
//
// Records are stored by id. Clock events for a shift are stored as a
// single { id: shiftId, events: [...] } record.

import { makeIdbStore, STORES } from './idb';

export function createShiftCache({
  shiftStore = makeIdbStore(STORES.shiftCache),
  clientStore = makeIdbStore(STORES.clientCache),
  eventsStore = makeIdbStore(STORES.clockEventsCache),
} = {}) {
  return {
    async putShift(shift) {
      if (!shift?.id) return;
      await shiftStore.put({ ...shift, cachedAt: Date.now() });
    },
    async putShifts(shifts = []) {
      await Promise.all(shifts.map((sh) => this.putShift(sh)));
    },
    async getShift(id) {
      return shiftStore.get(id);
    },
    async getShifts() {
      const all = await shiftStore.getAll();
      return all.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    },

    async putClient(client) {
      if (!client?.id) return;
      await clientStore.put({ ...client, cachedAt: Date.now() });
    },
    async putClients(clients = []) {
      await Promise.all(clients.map((c) => this.putClient(c)));
    },
    async getClient(id) {
      return clientStore.get(id);
    },

    async putClockEvents(shiftId, events = []) {
      if (!shiftId) return;
      await eventsStore.put({ id: shiftId, events, cachedAt: Date.now() });
    },
    async getClockEvents(shiftId) {
      const rec = await eventsStore.get(shiftId);
      return rec?.events || [];
    },
  };
}
