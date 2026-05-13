// ═══════════════════════════════════════════════════════════════
// commonMedications — curated list of frequently-prescribed
// medications for the senior / home-care population we serve.
//
// Used by the AUTOCOMPLETE control on the Health Profile medications
// LIST. The list is NOT exhaustive; the field falls back to free text
// for anything not present here. Generic names are preferred, with
// common brand names parenthesized where useful for findability.
//
// Sourced from the IQVIA / Medicare Part D top-prescribed lists for
// the 65+ population. Keep this list maintainable — additions are fine
// but resist unbounded growth; the value is in a short, recognizable
// menu, not an exhaustive pharmacopoeia.
// ═══════════════════════════════════════════════════════════════

export const COMMON_MEDICATIONS = [
  // ── Cardiovascular ─────────────────────────────────────────
  'Amiodarone',
  'Amlodipine (Norvasc)',
  'Atenolol',
  'Carvedilol (Coreg)',
  'Clonidine',
  'Digoxin',
  'Diltiazem (Cardizem)',
  'Furosemide (Lasix)',
  'Hydrochlorothiazide (HCTZ)',
  'Hydralazine',
  'Isosorbide mononitrate',
  'Lisinopril',
  'Losartan (Cozaar)',
  'Metoprolol succinate (Toprol XL)',
  'Metoprolol tartrate (Lopressor)',
  'Nitroglycerin',
  'Olmesartan (Benicar)',
  'Propranolol',
  'Ramipril (Altace)',
  'Spironolactone',
  'Valsartan (Diovan)',
  'Verapamil',

  // ── Cholesterol ────────────────────────────────────────────
  'Atorvastatin (Lipitor)',
  'Ezetimibe (Zetia)',
  'Fenofibrate',
  'Lovastatin',
  'Pravastatin (Pravachol)',
  'Rosuvastatin (Crestor)',
  'Simvastatin (Zocor)',

  // ── Anticoagulants / antiplatelets ─────────────────────────
  'Apixaban (Eliquis)',
  'Aspirin',
  'Clopidogrel (Plavix)',
  'Dabigatran (Pradaxa)',
  'Enoxaparin (Lovenox)',
  'Rivaroxaban (Xarelto)',
  'Warfarin (Coumadin)',

  // ── Diabetes ───────────────────────────────────────────────
  'Dulaglutide (Trulicity)',
  'Empagliflozin (Jardiance)',
  'Glimepiride',
  'Glipizide',
  'Glyburide',
  'Insulin aspart (Novolog)',
  'Insulin glargine (Lantus)',
  'Insulin lispro (Humalog)',
  'Liraglutide (Victoza)',
  'Metformin',
  'Pioglitazone (Actos)',
  'Semaglutide (Ozempic)',
  'Sitagliptin (Januvia)',

  // ── GI / acid reflux ───────────────────────────────────────
  'Bisacodyl (Dulcolax)',
  'Dicyclomine',
  'Docusate sodium (Colace)',
  'Esomeprazole (Nexium)',
  'Famotidine (Pepcid)',
  'Lactulose',
  'Loperamide (Imodium)',
  'Metoclopramide (Reglan)',
  'Omeprazole (Prilosec)',
  'Ondansetron (Zofran)',
  'Pantoprazole (Protonix)',
  'Polyethylene glycol (Miralax)',
  'Psyllium (Metamucil)',
  'Ranitidine',
  'Senna',
  'Sucralfate (Carafate)',

  // ── Pain / inflammation ────────────────────────────────────
  'Acetaminophen (Tylenol)',
  'Celecoxib (Celebrex)',
  'Diclofenac',
  'Duloxetine (Cymbalta)',
  'Gabapentin (Neurontin)',
  'Hydrocodone-acetaminophen (Norco)',
  'Ibuprofen (Advil / Motrin)',
  'Lidocaine patch',
  'Meloxicam (Mobic)',
  'Morphine',
  'Naproxen (Aleve)',
  'Oxycodone',
  'Oxycodone-acetaminophen (Percocet)',
  'Pregabalin (Lyrica)',
  'Tramadol',

  // ── Cognitive / dementia ───────────────────────────────────
  'Donepezil (Aricept)',
  'Galantamine (Razadyne)',
  'Memantine (Namenda)',
  'Rivastigmine (Exelon)',

  // ── Mental health ──────────────────────────────────────────
  'Alprazolam (Xanax)',
  'Aripiprazole (Abilify)',
  'Bupropion (Wellbutrin)',
  'Buspirone',
  'Citalopram (Celexa)',
  'Clonazepam (Klonopin)',
  'Diazepam (Valium)',
  'Escitalopram (Lexapro)',
  'Fluoxetine (Prozac)',
  'Haloperidol (Haldol)',
  'Lamotrigine',
  'Lorazepam (Ativan)',
  'Mirtazapine (Remeron)',
  'Olanzapine (Zyprexa)',
  'Paroxetine (Paxil)',
  'Quetiapine (Seroquel)',
  'Risperidone (Risperdal)',
  'Sertraline (Zoloft)',
  'Trazodone',
  'Venlafaxine (Effexor)',

  // ── Thyroid / endocrine ────────────────────────────────────
  'Levothyroxine (Synthroid)',
  'Methimazole',
  'Prednisone',

  // ── Respiratory ────────────────────────────────────────────
  'Albuterol (ProAir / Ventolin)',
  'Budesonide-formoterol (Symbicort)',
  'Fluticasone (Flovent)',
  'Fluticasone-salmeterol (Advair)',
  'Ipratropium-albuterol (Combivent / DuoNeb)',
  'Mometasone (Asmanex)',
  'Montelukast (Singulair)',
  'Tiotropium (Spiriva)',

  // ── Antibiotics / antivirals ───────────────────────────────
  'Amoxicillin',
  'Amoxicillin-clavulanate (Augmentin)',
  'Azithromycin (Zithromax / Z-Pak)',
  'Cephalexin (Keflex)',
  'Ciprofloxacin (Cipro)',
  'Doxycycline',
  'Levofloxacin (Levaquin)',
  'Metronidazole (Flagyl)',
  'Nitrofurantoin (Macrobid)',
  'Sulfamethoxazole-trimethoprim (Bactrim)',
  'Valacyclovir (Valtrex)',

  // ── Sleep ──────────────────────────────────────────────────
  'Eszopiclone (Lunesta)',
  'Melatonin',
  'Ramelteon (Rozerem)',
  'Zolpidem (Ambien)',

  // ── Allergy ────────────────────────────────────────────────
  'Cetirizine (Zyrtec)',
  'Diphenhydramine (Benadryl)',
  'Fexofenadine (Allegra)',
  'Loratadine (Claritin)',

  // ── Eye drops ──────────────────────────────────────────────
  'Brimonidine',
  'Dorzolamide-timolol (Cosopt)',
  'Latanoprost (Xalatan)',
  'Timolol',

  // ── Bone / supplements ─────────────────────────────────────
  'Alendronate (Fosamax)',
  'Calcium carbonate (Tums)',
  'Calcium citrate',
  'Cholecalciferol (Vitamin D3)',
  'Cyanocobalamin (Vitamin B12)',
  'Ferrous sulfate (Iron)',
  'Folic acid',
  'Ibandronate (Boniva)',
  'Magnesium oxide',
  'Multivitamin',
  'Potassium chloride',

  // ── Urology ────────────────────────────────────────────────
  'Finasteride',
  'Mirabegron (Myrbetriq)',
  'Oxybutynin (Ditropan)',
  'Tamsulosin (Flomax)',
  'Tolterodine (Detrol)',

  // ── Misc ───────────────────────────────────────────────────
  'Allopurinol',
  'Colchicine',
  'Hydroxychloroquine (Plaquenil)',
  'Meclizine (Antivert)',
  'Methotrexate',
  'Phenytoin (Dilantin)',
  'Topiramate (Topamax)',
];

// Sorted lookup used by the autocomplete dropdown. We sort once at
// module load so the renderer can stay cheap.
const SORTED = [...COMMON_MEDICATIONS].sort((a, b) => a.localeCompare(b));

export function searchCommonMedications(query, limit = 8) {
  if (!query) return [];
  const q = String(query).trim().toLowerCase();
  if (!q) return [];

  const starts = [];
  const contains = [];
  for (const med of SORTED) {
    const lower = med.toLowerCase();
    if (lower.startsWith(q)) starts.push(med);
    else if (lower.includes(q)) contains.push(med);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
