// CI guard: fail if any frontend file outside the canonical helper
// module writes a literal role === '<enum>' comparison.
//
// Why: Phase 1 of the Executive module added a third staff-tier role
// ('owner'). Four frontend files still did `data.role === 'admin'`
// literals, which silently flipped to `false` for the two seeded
// owners and locked them out of every admin-gated page. Now that
// src/lib/auth/roles.js exists, any new contributor (or future Claude
// session) who reaches for a literal === comparison gets caught by
// this test instead of by a production incident.
//
// The rule: use isStaffRole / isAdminRole / isOwnerRole from
// src/lib/auth/roles.js. See CLAUDE.md → Role-Check Safety.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// Files where the literal pattern is allowed:
//   - The canonical helper itself (comments explaining why callers
//     shouldn't write it).
//   - This test file (the pattern appears inside the regex string).
const ALLOWLIST = [
  'lib/auth/roles.js',
  'lib/auth/__tests__/noLiteralRoleChecks.test.js',
];

// Matches identifier `role` or `org_role` (with word boundary so
// `userRole` / `noRole` don't trigger) followed by == or === and a
// string literal of any current or known role value.
//
// Why include 'caregiver' / 'member': consistency. Today nothing
// outside roles.js needs a literal === on those either; if a new
// caregiver-only gate shows up, the contributor should route it
// through a helper too.
const FORBIDDEN = /\b(role|org_role)\s*===?\s*['"](admin|owner|member|caregiver)['"]/g;

const JS_EXT = /\.(jsx?|tsx?)$/;

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      out.push(...walkJs(path));
    } else if (JS_EXT.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// Strip line comments so prose like
//   // don't write `role === 'admin'` anymore
// doesn't fail this test. Multi-line /* */ comments are NOT stripped
// — if you write one of those discussing the forbidden pattern, either
// rephrase it or add the file to ALLOWLIST. The conservative default
// errs toward making contributors update the test deliberately.
function stripLineComments(source) {
  return source.replace(/\/\/[^\n]*/g, '');
}

describe('frontend role check enforcement', () => {
  it('no file outside src/lib/auth/roles.js writes a literal role === comparison', () => {
    const files = walkJs(SRC_DIR);
    expect(files.length).toBeGreaterThan(0); // sanity: walked the tree

    const violators = [];
    for (const f of files) {
      const rel = relative(SRC_DIR, f).replaceAll('\\', '/');
      if (ALLOWLIST.includes(rel)) continue;
      const content = readFileSync(f, 'utf-8');
      const stripped = stripLineComments(content);
      // Reset regex state across files (FORBIDDEN has the /g flag).
      FORBIDDEN.lastIndex = 0;
      const matches = stripped.match(FORBIDDEN);
      if (matches) {
        violators.push(`${rel}: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? ` (+${matches.length - 3} more)` : ''}`);
      }
    }

    if (violators.length > 0) {
      // Custom error so the failure message itself teaches the fix.
      throw new Error([
        'Found literal role === comparisons outside src/lib/auth/roles.js.',
        '',
        'Use isStaffRole / isAdminRole / isOwnerRole from src/lib/auth/roles.js',
        'instead. See CLAUDE.md → Role-Check Safety for the rationale.',
        '',
        'Violators:',
        ...violators.map((v) => `  ${v}`),
      ].join('\n'));
    }
    expect(violators).toEqual([]);
  });

  // Companion test: confirms the canonical helper file actually
  // contains the pattern in its prose, so we're sure the allowlist
  // entry isn't dead weight. If someone reformats the helper and
  // drops the explanatory comment, this test points it out.
  it('the canonical helper file still mentions the pattern in prose', () => {
    const helperPath = join(SRC_DIR, 'lib/auth/roles.js');
    const content = readFileSync(helperPath, 'utf-8');
    expect(content).toMatch(/role === '/);
  });
});
