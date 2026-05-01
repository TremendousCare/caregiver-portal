import { describe, it, expect, beforeEach, vi } from 'vitest';

// Regression tests for the bug where Daniela's "Send Interview Link"
// task completion silently disappeared on Wendell Sheldon and
// Gregorio Santos, which dropped them out of the "Pending Interview"
// sidebar filter.
//
// Root cause: saveCaregiver upserts the whole caregiver row, and the
// `tasks` JSONB column was round-tripped from whatever the client had
// in local state. Any other tab/user/edge-function whose local cache
// predated a recent task completion (dropped realtime echo, stale tab,
// post-deploy reload, etc.) would write a stale tasks object back,
// silently deleting the recently-completed task.
//
// Contract:
//   • caregiverToDb does NOT include `tasks` in the serialized row.
//     Initial INSERTs rely on caregivers.tasks DEFAULT '{}'::jsonb;
//     subsequent UPDATEs leave the column untouched.
//   • Task writes go through mergeCaregiverTasks, which calls the
//     merge_caregiver_tasks Postgres RPC. The RPC performs
//     `tasks = tasks || patch` under a row-level lock, so concurrent
//     writers can't clobber each other.

describe('tasks persistence (stale-state protection)', () => {
  describe('caregiverToDb omits tasks', () => {
    it('does not include `tasks` in the serialized row', async () => {
      const { caregiverToDb } = await import('../storage');
      const cg = {
        id: 'cg-tasks-1',
        firstName: 'Test',
        lastName: 'User',
        tasks: { task1: { completed: true, completedAt: 1, completedBy: 'me' } },
        notes: [],
        phaseTimestamps: {},
      };
      const row = caregiverToDb(cg);
      expect(row).not.toHaveProperty('tasks');
    });

    it('stale-state round-trip does NOT erase tasks at the DB level', async () => {
      // Scenario: User A checks "Send Interview Link" on Caregiver X.
      // DB tasks now: {custom_moa6udy4: {completed:true,...}}.
      //
      // User B's browser (tab left open, realtime missed the echo) still
      // has tasks={} in its local state. User B then adds a note, which
      // triggers saveCaregiver(changed) with stale state.
      //
      // Pre-fix: caregiverToDb emitted tasks={}, upsert wiped User A's
      //          completion, applicant fell out of "Pending Interview".
      // Post-fix: caregiverToDb omits tasks entirely, so the upsert
      //           leaves the DB column untouched.
      const { caregiverToDb } = await import('../storage');
      const staleClientState = {
        id: 'cg-tasks-2',
        firstName: 'Test',
        lastName: 'User',
        tasks: {}, // stale — missed the realtime event
        notes: [{ text: 'just added by user B' }],
        phaseTimestamps: {},
      };
      const upsertPayload = caregiverToDb(staleClientState);
      expect(upsertPayload).not.toHaveProperty('tasks');
    });
  });

  describe('mergeCaregiverTasks helper', () => {
    beforeEach(() => {
      vi.resetModules();
      // Default to an unconfigured environment so the helper short-circuits
      // the Supabase call and only updates the localStorage mirror.
      vi.doMock('../supabase', () => ({
        supabase: {
          rpc: vi.fn(async () => ({ error: null })),
        },
        isSupabaseConfigured: () => false,
      }));
      // jsdom provides localStorage; clear between tests.
      if (typeof localStorage !== 'undefined') localStorage.clear();
    });

    it('merges the patch into the local cache without dropping existing keys', async () => {
      const { mergeCaregiverTasks } = await import('../storage');
      // Seed the localStorage cache with a caregiver whose tasks already
      // include one completed task.
      localStorage.setItem(
        'tc-caregivers-v2',
        JSON.stringify([
          {
            id: 'cg-merge-1',
            firstName: 'Test',
            tasks: { existing: { completed: true, completedAt: 1, completedBy: 'a' } },
          },
        ]),
      );

      await mergeCaregiverTasks('cg-merge-1', {
        new_task: { completed: true, completedAt: 2, completedBy: 'b' },
      });

      const all = JSON.parse(localStorage.getItem('tc-caregivers-v2'));
      expect(all[0].tasks).toEqual({
        existing: { completed: true, completedAt: 1, completedBy: 'a' },
        new_task: { completed: true, completedAt: 2, completedBy: 'b' },
      });
    });

    it('overwrites a task at the same key (e.g. recompletion)', async () => {
      const { mergeCaregiverTasks } = await import('../storage');
      localStorage.setItem(
        'tc-caregivers-v2',
        JSON.stringify([
          {
            id: 'cg-merge-2',
            tasks: { t1: { completed: true, completedAt: 1, completedBy: 'a' } },
          },
        ]),
      );

      await mergeCaregiverTasks('cg-merge-2', {
        t1: { completed: true, completedAt: 999, completedBy: 'b' },
      });

      const all = JSON.parse(localStorage.getItem('tc-caregivers-v2'));
      expect(all[0].tasks.t1).toEqual({ completed: true, completedAt: 999, completedBy: 'b' });
    });

    it('preserves `false` (uncompleted) values in the patch', async () => {
      const { mergeCaregiverTasks } = await import('../storage');
      localStorage.setItem(
        'tc-caregivers-v2',
        JSON.stringify([
          {
            id: 'cg-merge-3',
            tasks: { t1: { completed: true, completedAt: 1, completedBy: 'a' } },
          },
        ]),
      );

      await mergeCaregiverTasks('cg-merge-3', { t1: false });

      const all = JSON.parse(localStorage.getItem('tc-caregivers-v2'));
      expect(all[0].tasks.t1).toBe(false);
    });

    it('is a no-op for caregivers not in the local cache (no throw)', async () => {
      const { mergeCaregiverTasks } = await import('../storage');
      localStorage.setItem('tc-caregivers-v2', JSON.stringify([]));
      await expect(
        mergeCaregiverTasks('cg-missing', { t1: { completed: true } }),
      ).resolves.toBeUndefined();
    });

    it('calls the merge_caregiver_tasks RPC when Supabase is configured', async () => {
      const rpc = vi.fn(async () => ({ error: null }));
      vi.resetModules();
      vi.doMock('../supabase', () => ({
        supabase: { rpc },
        isSupabaseConfigured: () => true,
      }));
      const { mergeCaregiverTasks } = await import('../storage');

      await mergeCaregiverTasks('cg-rpc-1', {
        t1: { completed: true, completedAt: 1, completedBy: 'a' },
      });

      expect(rpc).toHaveBeenCalledWith('merge_caregiver_tasks', {
        p_caregiver_id: 'cg-rpc-1',
        p_patch: { t1: { completed: true, completedAt: 1, completedBy: 'a' } },
      });
    });

    it('rejects when the RPC returns an error so callers can surface it', async () => {
      const rpc = vi.fn(async () => ({ error: { message: 'boom' } }));
      vi.resetModules();
      vi.doMock('../supabase', () => ({
        supabase: { rpc },
        isSupabaseConfigured: () => true,
      }));
      const { mergeCaregiverTasks } = await import('../storage');

      await expect(
        mergeCaregiverTasks('cg-rpc-2', { t1: { completed: true } }),
      ).rejects.toMatchObject({ message: 'boom' });
    });
  });
});
