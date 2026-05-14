// ═══════════════════════════════════════════════════════════════
// commonAllergens — curated list of frequently-encountered allergens
// for the home-care population.
//
// Used by the AUTOCOMPLETE control on the Health Profile allergies
// LIST. The list is NOT exhaustive — every allergy has long-tail
// edge cases (specific brands, niche foods, regional plants) — so
// the field falls back to free text for anything not present here.
// The value is in a short, recognizable menu, not an encyclopedic
// pharmacopoeia.
//
// Categories cover the buckets that show up most in intake forms:
//   • Drug allergies (the highest-stakes category)
//   • Food allergies (the most common category by population)
//   • Environmental / inhalant
//   • Insect / animal
//   • Material / chemical
//
// When adding entries, prefer the form a caregiver would actually
// type ("Penicillin" not "Penicillin G sodium"; "Peanuts" not
// "Arachis hypogaea"). Resist unbounded growth.
// ═══════════════════════════════════════════════════════════════

export const COMMON_ALLERGENS = [
  // ── Drug allergies ────────────────────────────────────────
  'Penicillin',
  'Amoxicillin',
  'Cephalosporins',
  'Sulfa drugs',
  'NSAIDs',
  'Aspirin',
  'Ibuprofen',
  'Naproxen',
  'Acetaminophen',
  'Codeine',
  'Morphine',
  'Hydrocodone',
  'Oxycodone',
  'Tramadol',
  'Erythromycin',
  'Azithromycin',
  'Clindamycin',
  'Vancomycin',
  'Tetracycline',
  'Ciprofloxacin',
  'Levofloxacin',
  'Statins',
  'ACE inhibitors',
  'Lisinopril',
  'Metformin',
  'Insulin',
  'Heparin',
  'Warfarin',
  'Lithium',
  'Phenytoin',
  'Carbamazepine',
  'Lamotrigine',
  'Local anesthetics (lidocaine)',
  'Iodine contrast (IV dye)',
  'Gadolinium contrast',
  'Anesthesia (general)',

  // ── Food allergies ────────────────────────────────────────
  'Peanuts',
  'Tree nuts',
  'Almonds',
  'Cashews',
  'Walnuts',
  'Pecans',
  'Pistachios',
  'Brazil nuts',
  'Hazelnuts',
  'Macadamia nuts',
  'Shellfish',
  'Shrimp',
  'Lobster',
  'Crab',
  'Fish',
  'Salmon',
  'Tuna',
  'Cod',
  'Eggs',
  'Milk',
  'Dairy',
  'Lactose intolerance',
  'Soy',
  'Wheat',
  'Gluten',
  'Sesame',
  'Mustard',
  'Corn',
  'Strawberries',
  'Tomatoes',
  'Citrus',
  'Avocado',
  'Banana',
  'Kiwi',
  'Pineapple',
  'Chocolate',
  'MSG',
  'Sulfites',
  'Red dye',
  'Yeast',

  // ── Environmental / inhalant ──────────────────────────────
  'Pollen',
  'Tree pollen',
  'Grass pollen',
  'Ragweed',
  'Dust mites',
  'Mold',
  'Pet dander',
  'Cat dander',
  'Dog dander',
  'Smoke',
  'Perfume / fragrance',
  'Cleaning products',
  'Bleach',
  'Ammonia',

  // ── Insect / animal ───────────────────────────────────────
  'Bee stings',
  'Wasp stings',
  'Hornet stings',
  'Fire ants',
  'Mosquito bites',
  'Spider bites',

  // ── Materials / chemical ──────────────────────────────────
  'Latex',
  'Nickel',
  'Adhesive tape',
  'Bandage adhesive',
  'Iodine (topical)',
  'Chlorhexidine',
  'Hand sanitizer (alcohol)',
  'Soap dyes',
  'Wool',
];

// Sorted lookup used by the autocomplete dropdown. We sort once at
// module load so the renderer can stay cheap.
const SORTED = [...COMMON_ALLERGENS].sort((a, b) => a.localeCompare(b));

/**
 * Filter COMMON_ALLERGENS by query, prefix-matches first then
 * contains-matches. Matches `searchCommonMedications` in shape so the
 * AutocompleteControl can stay polymorphic.
 *
 * @param {string} query
 * @param {number} [limit=8]
 * @returns {string[]}
 */
export function searchCommonAllergens(query, limit = 8) {
  if (!query) return [];
  const q = String(query).trim().toLowerCase();
  if (!q) return [];

  const starts = [];
  const contains = [];
  for (const item of SORTED) {
    const lower = item.toLowerCase();
    if (lower.startsWith(q)) starts.push(item);
    else if (lower.includes(q)) contains.push(item);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
