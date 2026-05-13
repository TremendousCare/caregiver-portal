// ═══════════════════════════════════════════════════════════════
// carePlanMigrations — pure functions that reshape legacy data
// from older care plan versions into the shapes the current editor
// expects.
//
// Migrations are applied at editor-load time only — we never write
// back unless the user actively edits the section. This means older
// published versions stay byte-identical in the database while still
// rendering correctly in the new editor.
// ═══════════════════════════════════════════════════════════════

// ─── Bathing methods ────────────────────────────────────────────
// Old shape:
//   bathing_method:    ['Shower', 'Bed bath']     (array of strings)
//   bathing_assistLevel: 'Partial assist'         (single LEVEL_PICK value)
//
// New shape:
//   bathing_method:    [{ method: 'Shower', level: 'Partial assist' },
//                       { method: 'Bed bath', level: 'Partial assist' }]
//
// We use the old single-level value to seed the per-method level on
// every migrated row. The user can then refine each row independently.

export function migrateLegacyBathingMethod(sectionValues) {
  if (!sectionValues || typeof sectionValues !== 'object') return sectionValues;

  const methods = sectionValues.bathing_method;
  if (!Array.isArray(methods) || methods.length === 0) return sectionValues;

  // Already migrated? (every entry is an object with a `method` key)
  const allObjects = methods.every(
    (m) => m && typeof m === 'object' && !Array.isArray(m) && 'method' in m,
  );
  if (allObjects) return sectionValues;

  // Mixed shapes shouldn't occur in practice, but if they do, only
  // migrate the string entries and leave existing object rows alone.
  const seedLevel = sectionValues.bathing_assistLevel || null;
  const migrated = methods.map((m) => {
    if (typeof m === 'string') return { method: m, level: seedLevel };
    if (m && typeof m === 'object' && !Array.isArray(m)) return m;
    return null;
  }).filter((row) => row != null);

  return { ...sectionValues, bathing_method: migrated };
}


// ─── Dispatcher ─────────────────────────────────────────────────
// Applies all relevant migrations for a given section's data.
// Sections with no migrations pass through unchanged. The dispatcher
// is exported so the SectionEditor can call it without knowing
// which specific migrations apply to which sections.

const MIGRATIONS_BY_SECTION = {
  dailyLiving: [migrateLegacyBathingMethod],
};

export function migrateSectionData(sectionId, sectionValues) {
  const migrations = MIGRATIONS_BY_SECTION[sectionId];
  if (!migrations || !sectionValues) return sectionValues || {};
  return migrations.reduce((values, fn) => fn(values), sectionValues);
}
