import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the South OC seed migration. The 14
// strategic UUIDs were verified against production data on 2026-05-13;
// these specs catch accidental edits that drop a row or change a UUID
// before the next deploy.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260513140100_bd_seed_amy_south_oc_territory.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260513140100_bd_seed_amy_south_oc_territory_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

const STRATEGIC_UUIDS = [
  // Hoag (8)
  '2a3c0d15-35e5-4a08-8d18-d91dd13cf6a6',
  '47cbb432-6bfd-4f29-87e4-d52bbcd61378',
  'b2b1d7b9-ed8d-42c2-a5df-f8ddd56974f0',
  '7712de8a-60f9-453a-8ceb-798d650fbd0d',
  'c8284df0-91cb-44bf-8ef0-dc2e1decb646',
  'e49cc776-c5e1-4bd2-8680-b44840c6f579',
  '6740b351-9910-4104-9bd7-525cf86471c7',
  '8b197574-558c-4387-802d-7507bf973cf0',
  // Mission Hospital
  '0fa94736-cb17-4614-8df1-4a6bc422a702',
  // UCI Hospital Orange
  'bd5fa780-fd05-4521-b3f7-cf574d2300ff',
  // Providence + St Joe's (4)
  'ecf5654a-3398-4fd6-b6dc-fe3fdf3a2b1d',
  '95eb3fd0-861b-4d04-9290-7b99bcf3f899',
  '07c68cae-9233-461c-89f5-c8683ccc3d19',
  'c57c4189-08b7-4906-ad93-338f2db792ae',
];

const EXPECTED_CITIES = [
  'Aliso Viejo',
  'Costa Mesa',
  'Dana Point',
  'El Toro',
  'Foothill Ranch',
  'Irvine',
  'Ladera Ranch',
  'Laguna Beach',
  'Laguna Hills',
  'Laguna Niguel',
  'Laguna Woods',
  'Lake Forest',
  'Mission Viejo',
  'Newport Beach',
  'Newport Coast',
  'Rancho Mission Viejo',
  'RMV',
  'Rancho Santa Margarita',
  'RSM',
  'San Clemente',
  'San Juan Capistrano',
  'Trabuco Canyon',
  'Trabuco Hills',
];

describe('South OC seed migration', () => {
  describe('territory + membership', () => {
    it("references Amy Dutton's auth.uid", () => {
      expect(sql).toContain('9228e867-30ca-4294-985b-871a994cc5fc');
    });

    it('creates a "South OC" territory in default_org_id() if not already present', () => {
      expect(sql).toMatch(/lower\(name\) = 'south oc'/);
      expect(sql).toMatch(/INSERT INTO bd_territories \(org_id, name, cities\)/);
      expect(sql).toMatch(/public\.default_org_id\(\)/);
    });

    it('refreshes cities on re-run so the canonical list can be amended', () => {
      // Migration test is intentionally permissive about formatting,
      // but the "ELSE ... UPDATE bd_territories SET cities = ..." branch
      // must exist or re-deployment won't pick up city-list edits.
      expect(sql).toMatch(/ELSE[\s\S]*?UPDATE bd_territories[\s\S]*?SET cities = v_cities/);
    });

    it('guards the membership insert behind an auth.users existence check (so fresh dev DBs do not hard-fail)', () => {
      expect(sql).toMatch(
        /IF EXISTS \(SELECT 1 FROM auth\.users WHERE id = v_user_id\)[\s\S]*?INSERT INTO bd_territory_members/
      );
    });

    it('uses ON CONFLICT DO NOTHING so re-runs are no-ops for an existing member row', () => {
      expect(sql).toMatch(/INSERT INTO bd_territory_members[\s\S]*?ON CONFLICT \(territory_id, user_id\) DO NOTHING/);
    });

    it('includes every canonical South OC city plus the shorthand variants', () => {
      for (const city of EXPECTED_CITIES) {
        expect(sql, `cities array missing "${city}"`).toContain(`'${city}'`);
      }
    });
  });

  describe('strategic-shared flag', () => {
    it('sets is_strategic_shared = true', () => {
      expect(sql).toMatch(/UPDATE bd_accounts\s+SET is_strategic_shared = true/);
    });

    it('targets all 14 strategic UUIDs', () => {
      for (const id of STRATEGIC_UUIDS) {
        expect(sql, `strategic UUID list missing ${id}`).toContain(id);
      }
    });

    it('only updates strategic accounts (single UPDATE statement against bd_accounts)', () => {
      const updates = sql.match(/UPDATE bd_accounts/g) ?? [];
      expect(updates.length).toBe(1);
    });
  });

  describe('safety', () => {
    it('does not contain destructive SQL statements (DROP TABLE / DELETE FROM / TRUNCATE)', () => {
      // Strip line comments before checking so "No DELETE, no DROP"
      // in the header docstring doesn't trip the regex.
      const stripped = sql.replace(/--[^\n]*/g, '');
      expect(stripped).not.toMatch(/\bDROP TABLE\b/);
      expect(stripped).not.toMatch(/\bDELETE FROM\b/);
      expect(stripped).not.toMatch(/\bTRUNCATE\b/);
    });
  });
});

describe('South OC seed rollback', () => {
  it('clears the strategic flag on every UUID the seed sets', () => {
    expect(rollback).toMatch(/UPDATE bd_accounts\s+SET is_strategic_shared = false/);
    for (const id of STRATEGIC_UUIDS) {
      expect(rollback, `rollback strategic UUID list missing ${id}`).toContain(id);
    }
  });

  it('removes the South OC territory row (cascading the member row)', () => {
    expect(rollback).toMatch(/DELETE FROM bd_territories WHERE id = v_territory_id/);
    expect(rollback).toMatch(/lower\(name\) = 'south oc'/);
  });
});
