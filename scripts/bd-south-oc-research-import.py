#!/usr/bin/env python3
"""Generate the South OC research-import seed migration from Amy Dutton's
Word doc.

Why this script exists
----------------------
Amy's territory research lives in a Word document with ~145 referral
sources across 12 South OC cities. We want it in `bd_accounts` so she can
work it from the BD portal, but ~30 of those rows already exist in the
database from the earlier Trello import (Hoag, Atria, Crestavilla, etc.)
under different name variants. Hand-writing the dedupe inside a SQL
migration would be tedious to review.

This script:
  1. Parses the docx into structured rows (name, city, account_type,
     subtype, address, phone).
  2. Joins each row against a snapshot of the current `bd_accounts`
     rows in production using a curated alias table (DOC_ALIAS_OF_EXISTING)
     plus a normalized-name match.
  3. Emits a single idempotent SQL migration that:
       - For aliased rows: UPDATEs the existing account, filling in
         address/phone only when currently NULL. Does NOT touch the
         existing row's `source` column (it stays 'manual' or
         'trello_import') so we don't lose provenance.
       - For new rows: INSERTs with source='research_import',
         ON CONFLICT against a partial unique index so re-runs are no-ops.
       - Adds the 5 named Hoag contacts (Amy/Arnetta Robinson, Brittany
         Carrillo, Jenna Gailani, Madeline Conrado) into
         `bd_account_contacts`, also ON CONFLICT-safe.

Re-running the script
---------------------
If Amy updates the Word doc, drop the new copy at the path in
SOURCE_DOC_PATH below and re-run:

    python3 scripts/bd-south-oc-research-import.py \\
      --doc /path/to/new_referral_list.docx \\
      --out supabase/migrations/<timestamp>_bd_seed_south_oc_research_import.sql

The script does NOT touch the DB directly. It only writes the SQL file —
which still has to land in a PR and go through the migrations workflow.

Caveats
-------
* The alias table is hand-maintained. If the doc gains new entries that
  collide with existing accounts, add a new entry to DOC_ALIAS_OF_EXISTING.
* The phone-normalizer is loose (`(949) 230-1155` → `+19492301155`) and
  does not validate the number.
* The script trusts the doc's category headers. If a row is mis-categorized
  in the doc (e.g. a hospice listed under SNF), it will land in the wrong
  subtype in the DB.
"""
from __future__ import annotations
import argparse
import html
import re
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ─────────────────────────────────────────────────────────────────────
# 1. Doc → structured rows
# ─────────────────────────────────────────────────────────────────────

# City headers in the doc. Some cover multiple cities; we pick the
# correct one per row by scanning the row's address text for one of the
# candidates.
CITY_HEADERS = {
    "Newport Beach": ["Newport Beach"],
    "Irvine": ["Irvine"],
    "Lake Forest / Foothill Ranch": ["Foothill Ranch", "Lake Forest"],
    "Laguna Beach": ["Laguna Beach"],
    "Laguna Hills  ·  Laguna Niguel  ·  Laguna Woods": [
        "Laguna Hills", "Laguna Niguel", "Laguna Woods",
    ],
    "Aliso Viejo": ["Aliso Viejo"],
    "Mission Viejo": ["Mission Viejo", "Rancho Mission Viejo"],
    "Rancho Santa Margarita": ["Rancho Santa Margarita"],
    "Ladera Ranch": ["Ladera Ranch"],
    "San Juan Capistrano": ["San Juan Capistrano"],
    "Dana Point  (92629 / 92624)": ["Dana Point"],
    "San Clemente": ["San Clemente"],
}

# Category header text (after stripping the leading emoji glyph) → DB
# (account_type, default_subtype) tuple. Memory-care entries are
# reclassified later when their NAME contains "memory care".
CATEGORY_MAP = {
    "hospital":                                      ("facility", "hospital"),
    "hospitals":                                     ("facility", "hospital"),
    "urgent care / outpatient":                      ("facility", "other"),
    "urgent care":                                   ("facility", "other"),
    "skilled nursing facilities":                    ("facility", "snf"),
    "assisted living & memory care":                 ("facility", "alf"),
    "elder law attorneys":                           ("professional", "attorney"),
    "financial & wealth management":                 ("professional", "financial_planner"),
    "geriatric care managers":                       ("professional", "gcm"),
    "geriatricians / senior-focused physicians":     ("professional", "physician"),
    "concierge doctors":                             ("professional", "physician"),
    "concierge / direct primary care":               ("professional", "physician"),
}

# Lines that look like contact / metadata for the previous account
# rather than a new account entry. Used to skip the Hoag block's
# "Hoag Hospice Liaisons: ...", "Palliative: ...", "Departments: ..."
# lines, and the Saddleback block's "Adjacent outpatient campuses: ...".
CONTACT_OR_METADATA_PREFIXES = (
    "hoag hospice liaisons", "palliative:", "departments:", "fudge family",
    "adjacent outpatient", "neurology:",
)


@dataclass
class DocRow:
    name: str
    city: str | None
    account_type: str           # 'facility' | 'professional'
    subtype: str                # one of the CHECK values
    address: str | None
    phone: str | None
    notes: str | None
    section_city: str           # the city block this row was under


def _extract_doc_text(docx_path: Path) -> str:
    with zipfile.ZipFile(docx_path) as z:
        with z.open("word/document.xml") as f:
            xml = f.read().decode("utf-8", errors="replace")
    text = re.sub(r"</w:p>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text)


PHONE_RE = re.compile(r"\(?\d{3}[\)\s.-]?\s?\d{3}[\s.-]?\d{4}")
ADDRESS_SPLIT_RE = re.compile(r"^(.*?)\s+(\d{1,5}\s+\S.*)$")
# Fallback when the entry has no street number, e.g. "Pelican Ridge
# Post-Acute Flagship Rd". Splits the last "<word> <street-suffix>"
# pair off the end of the name and treats it as the address.
STREET_SUFFIX_FALLBACK_RE = re.compile(
    r"^(.*?)\s+([A-Z][\w'.&-]*\s+(?:Rd|Dr|Ave|St|Blvd|Pkwy|Way|Ln|Pl|Ct|Hwy)\.?)$"
)
# Trailing footnote / generic-area lines we want to skip entirely
# (they describe coverage rather than a single account).
SKIP_LINE_PATTERNS = (
    re.compile(r"throughout all of south oc", re.IGNORECASE),
)


def _normalize_phone(s: str) -> str | None:
    if not s:
        return None
    digits = re.sub(r"\D", "", s)
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return None


def _strip_category_emoji(line: str) -> str | None:
    """If the line starts with a category emoji, return the trailing text
    lowercased; else None."""
    stripped = line.lstrip()
    # Match anything that starts with a non-ASCII char then a space.
    m = re.match(r"^[^\w\s]+\s+(.+)$", stripped)
    if not m:
        return None
    text = m.group(1).strip().lower()
    # Some categories have parenthetical hints like "(no acute hospital in city)".
    text = re.sub(r"\s*\(.*?\)\s*$", "", text).strip()
    return text


def _line_is_contact_metadata(line: str) -> bool:
    lo = line.lower().strip()
    return any(lo.startswith(p) for p in CONTACT_OR_METADATA_PREFIXES)


def _pick_city(section_city: str, address: str | None) -> str:
    candidates = CITY_HEADERS[section_city]
    if len(candidates) == 1:
        return candidates[0]
    if address:
        addr_lo = address.lower()
        for c in candidates:
            if c.lower() in addr_lo:
                return c
    return candidates[0]


def parse_doc(docx_path: Path) -> list[DocRow]:
    text = _extract_doc_text(docx_path)
    lines = [l.strip() for l in text.split("\n")]

    section_city: str | None = None
    current_cat: tuple[str, str] | None = None
    rows: list[DocRow] = []

    # Pre-build a set of section headers for fast detection.
    header_set = set(CITY_HEADERS.keys())

    for raw in lines:
        if not raw:
            continue
        if raw in header_set:
            section_city = raw
            current_cat = None
            continue
        cat = _strip_category_emoji(raw)
        if cat is not None:
            mapped = CATEGORY_MAP.get(cat)
            if mapped is None:
                # Try to match a prefix (e.g. "concierge doctors  (some hint)")
                for key, val in CATEGORY_MAP.items():
                    if cat.startswith(key):
                        mapped = val
                        break
            if mapped is None:
                sys.stderr.write(f"WARN: unknown category {cat!r}\n")
                current_cat = None
                continue
            current_cat = mapped
            continue
        if section_city is None or current_cat is None:
            # Skip preamble lines like "South Orange County" / "Elder Care…"
            continue
        if _line_is_contact_metadata(raw):
            continue
        if any(p.search(raw) for p in SKIP_LINE_PATTERNS):
            continue

        # Strip trailing 5-digit ZIP runs from the line so the address
        # split doesn't get confused; we don't currently store ZIP separately
        # for research_import rows (city is the matching key).
        line = raw

        # Split on the visually-distinct "  |  " separator first.
        segments = re.split(r"\s+\|\s+", line)
        first = segments[0]
        rest = segments[1:]

        # Phone: search all segments, pick the first match.
        phone = None
        for seg in segments:
            m = PHONE_RE.search(seg)
            if m:
                phone = _normalize_phone(m.group(0))
                if phone:
                    break

        # Address: split first segment at the first run of digits that's
        # followed by a space and another word.
        am = ADDRESS_SPLIT_RE.match(first)
        if am:
            name_part = am.group(1).strip()
            addr_part = am.group(2).strip()
            # Strip any trailing phone match from address.
            addr_part = PHONE_RE.sub("", addr_part).strip().strip(",|").strip()
            # Trim trailing notes like "Internist specializing in ..."
            # that appear after the address proper. Heuristic: stop at
            # the first sentence-ending period followed by a capital
            # letter, or before known free-text markers.
            addr_part = re.sub(r"\s+(?:Internist|Long-established|Board-certified|Geriatrician|Serves|10-year|Dedicated|7 days|Full continuing).*$", "", addr_part)
            addr_part = addr_part.strip().strip(",")
        else:
            # Try the no-digit fallback for entries like
            # "Pelican Ridge Post-Acute Flagship Rd".
            sm = STREET_SUFFIX_FALLBACK_RE.match(first)
            if sm:
                name_part = sm.group(1).strip()
                addr_part = sm.group(2).strip()
            else:
                name_part = first.strip()
                addr_part = None

        # Canonicalize OC House Calls variants — the doc has 3 different
        # phrasings of the same Dr. Khaneki house-call service across
        # Aliso Viejo, Laguna Hills, and a trailing free-text footnote.
        # Collapse them so intra-doc dedupe sees a single (name, city).
        if re.match(r"^(?:orange county|oc)\s+house\s+calls", name_part, re.IGNORECASE):
            name_part = "OC House Calls – Dr. Khaneki"
            addr_part = None  # service-area, not a pin-able address

        # Strip a trailing 5-digit ZIP if it leaked into the name.
        name_part = re.sub(r"\s+\d{5}(\s+\d{5})?$", "", name_part).rstrip()
        # Note: we deliberately do NOT strip a trailing city suffix.
        # Many doc entries use the city as a disambiguator — e.g.
        # "Hoag Hospital Irvine" vs "Hoag Hospital" (Newport Beach) —
        # and the alias table relies on those full names. Operator can
        # tidy cosmetic stragglers like "Meyer Estate Law, P.C. – Jan
        # Meyer Dana Point" in the UI post-import.

        # Free-text notes: anything trailing the phone in any segment.
        notes_parts = []
        for seg in rest:
            if PHONE_RE.search(seg):
                trailer = PHONE_RE.sub("", seg).strip().strip("|").strip()
                if trailer:
                    notes_parts.append(trailer)
            elif seg and "@" not in seg:
                notes_parts.append(seg.strip())
        notes = " ".join(notes_parts).strip() or None

        # Clean name.
        name = name_part.rstrip(",:").strip()
        if not name:
            continue

        # Reclassify ALF→memory_care if the name contains "memory care".
        account_type, subtype = current_cat
        if subtype == "alf" and "memory care" in name.lower():
            subtype = "memory_care"

        city = _pick_city(section_city, addr_part) if section_city else None

        rows.append(DocRow(
            name=name,
            city=city,
            account_type=account_type,
            subtype=subtype,
            address=addr_part if addr_part else None,
            phone=phone,
            notes=notes,
            section_city=section_city or "",
        ))
    # Intra-doc dedupe by (lowercase name, lowercase city). Keep the
    # first occurrence so the city of OC House Calls (and any other
    # multi-city footnotes) lands on the first section it appears in.
    seen: set[tuple[str, str]] = set()
    deduped: list[DocRow] = []
    for r in rows:
        key = (r.name.lower(), (r.city or "").lower())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped


# ─────────────────────────────────────────────────────────────────────
# 2. Dedupe alias table
# ─────────────────────────────────────────────────────────────────────
#
# Maps a normalized doc-row identity (lowercase_name, lowercase_city) to
# the existing bd_accounts.id it should merge into. Built from the
# 2026-05-15 snapshot of production bd_accounts via the Supabase MCP
# SQL editor. When the script encounters a doc row whose (name, city)
# pair is in this table, it emits an UPDATE that fills in
# address/phone on the existing row (only where currently NULL) instead
# of inserting a duplicate.
#
# Re-running the script with an updated doc may surface new collisions;
# add them here in the same shape.

DOC_ALIAS_OF_EXISTING: dict[tuple[str, str], str] = {
    # ─── Strategic-shared (must never duplicate) ─────────────────────
    # Newport Beach: doc "Hoag Hospital" → existing "HOAG" (Newport
    # Beach has two HOAG rows; pick the first by uuid).
    ("hoag hospital",                             "newport beach"): "47cbb432-6bfd-4f29-87e4-d52bbcd61378",
    ("hoag hospital irvine",                      "irvine"):        "2a3c0d15-35e5-4a08-8d18-d91dd13cf6a6",
    ("hoag concierge medicine – aliso viejo",     "aliso viejo"):   "7712de8a-60f9-453a-8ceb-798d650fbd0d",
    # Doc says "Providence Mission Hospital Laguna Beach"; production
    # has it under the simpler "Providence Hospital".
    ("providence mission hospital laguna beach",  "laguna beach"):  "95eb3fd0-861b-4d04-9290-7b99bcf3f899",

    # ─── Newport Beach non-strategic ─────────────────────────────────
    ("atria newport beach",      "newport beach"): "dfde6580-7254-434f-99da-5df9c5d6d9ff",
    ("newport beach memory care","newport beach"): "bf18c6a7-ab5d-48fb-a572-6c2ca76e2297",
    # Existing "Vivante Newport Beach" merges with doc "Vivante Newport Center".
    ("vivante newport center",   "newport beach"): "1645ebe9-e1a7-4623-a234-d986d2266601",
    # Existing "Clearwater Living" merges with doc "Clearwater Newport Beach".
    ("clearwater newport beach", "newport beach"): "3a58d9b7-e7f8-47c6-825f-4254b1abaa76",
    # "Crystal Cove" (existing, city null) → doc "Crystal Cove Care Center".
    ("crystal cove care center", "newport beach"): "792b7c2d-6e6f-4a2c-9cae-e7b4f450ff20",
    # "Pelican Ridge" (existing, city null) → doc "Pelican Ridge Post-Acute".
    ("pelican ridge post-acute", "newport beach"): "168a5e17-ef07-4f11-b13e-b1ce9d0b5331",

    # ─── Irvine ──────────────────────────────────────────────────────
    ("atria golden creek",        "irvine"): "052b574b-06bb-4b5a-8746-dc864ac80ee5",
    ("regents point (ccrc)",      "irvine"): "cd92e7b6-403d-46ac-961f-ae5c3459083f",
    ("woodbridge terrace of irvine", "irvine"): "69d46477-df54-4274-a980-947c01505aab",
    # "Windcrest SNF" (existing, city null) → doc "Windcrest at Regents Point".
    ("windcrest at regents point","irvine"): "8fdefc8d-13d6-4812-ac5d-f5f3d08882e1",

    # ─── Aliso Viejo ─────────────────────────────────────────────────
    ("belmont village senior living aliso viejo", "aliso viejo"): "7f68fd6a-eec9-4adb-bf81-181231dd3f24",

    # ─── Laguna Hills / Niguel / Woods ───────────────────────────────
    ("memorialcare saddleback medical center",    "laguna hills"): "b8871833-0396-46e4-a26d-ace0cd357882",
    ("activcare laguna hills",                    "laguna hills"): "c4e5cca5-9b0a-4074-9d3e-1c8eb13c9e17",
    ("meridian at laguna hills",                  "laguna hills"): "81f5d5be-30fd-4987-a8a5-4cc49dbc9ddf",
    ("laguna hills health & rehabilitation",      "laguna hills"): "c2884c89-9e7a-47e5-8eef-bcd64c02eda4",
    # "Villa Valencia SNF" (existing, city null) → doc "Villa Valencia Healthcare Center".
    ("villa valencia healthcare center",          "laguna hills"): "57fde526-e604-4489-8ad6-cb74799fecbc",
    # "Palm Terrace" (existing, city null) → doc "Palm Terrace Healthcare & Rehab".
    ("palm terrace healthcare & rehab",           "laguna hills"): "bb702366-f5e0-4553-90ef-fed9aa388c5a",
    ("aegis living laguna niguel",                "laguna niguel"): "2c35ad90-576f-440e-8f60-14d967183047",
    ("crestavilla",                               "laguna niguel"): "d726eaef-e357-4c2f-a677-8cd29cdb21eb",
    # "Watermark" (existing, city null) → doc "Watermark Laguna Niguel".
    ("watermark laguna niguel",                   "laguna niguel"): "570d72ee-dff7-4b59-ade1-fa46b829e70c",
    # "The Ivy Wellington" (existing, city null) → doc "Ivy Park of Wellington" (Laguna Woods).
    ("ivy park of wellington",                    "laguna woods"): "bbe5e119-d990-45df-9edc-6d4e27eba0fc",

    # ─── Mission Viejo / RMV ─────────────────────────────────────────
    # "Heritage Point" → doc "Heritage Pointe".
    ("heritage pointe",                "mission viejo"): "7fa154dd-7bf4-4143-b35b-31012279078e",
    # "Sunrise" → doc "Sunrise of Mission Viejo". Existing "Sunrise Senior Living"
    # is a separate ALF row; we alias the IL row and let the second one survive.
    ("sunrise of mission viejo",       "mission viejo"): "e8395783-f11c-4450-98f6-35e348c62518",
    # "Reata Glen" (existing in RMV) → doc "Reata Glen (CCRC)" listed under Mission Viejo.
    # Address resolves to Rancho Mission Viejo, so we use the existing RMV row's city.
    ("reata glen (ccrc)",              "rancho mission viejo"): "1cfdb1c0-6fb8-4c4d-9770-db66b31fd2c9",
    # "The Orchards" (existing, city=RMV) → doc "The Orchards Health Center" listed
    # under Mission Viejo. Address 1 Amistad Dr resolves to Mission Viejo proper, but
    # the doc + existing match the same facility — alias.
    ("the orchards health center",     "mission viejo"): "7d1c6c42-9ab5-4bc8-ae16-d4938526cb0a",

    # ─── RSM ─────────────────────────────────────────────────────────
    # "Park Terrace RSM" (existing) → doc "Park Terrace".
    ("park terrace",                   "rancho santa margarita"): "4c4b5d8a-5080-49a3-b222-3f673eeaeb5c",

    # ─── San Juan Capistrano / Dana Point ────────────────────────────
    ("atria san juan",                 "san juan capistrano"): "87696222-9ada-4411-8e72-653feaa8d292",
    ("capistrano senior living",       "san juan capistrano"): "bd99c52d-80e2-40e6-8766-29bf7f68ec78",
    ("san juan hills healthcare center","san juan capistrano"): "258d79f0-fa02-455f-a3aa-7cbd9f15651f",
    # "Capistrano Beach Care Center" (existing in SJC) → doc places it in Dana Point.
    # Both rows describe the same Del Rey facility; alias and trust the existing city.
    ("capistrano beach care center",   "dana point"): "85d9159e-40e6-4e37-be18-fabc3f983e63",
    # "Sea Bluffs" (existing) → doc "Sea Bluffs, Ivy Signature Living".
    ("sea bluffs, ivy signature living","dana point"): "956ca760-55a4-48bb-bb40-08930dc03de9",

    # ─── San Clemente / Trabuco Hills (existing under city=null) ─────
    ("san clemente villas",            "san clemente"): "e580d9da-5c92-4da3-9212-a6c8107a5763",
    # "Rayas Paradise" (existing, city=null) → doc "Raya's Paradise".
    ("raya's paradise",                "san clemente"): "7f8c9961-caa8-44d6-a2d5-b8ea37ab2341",
    # "Trabuco Hills Post Acute" (existing, Trabuco Hills) → doc "Trabuco Hills Post-Acute" (Lake Forest section).
    ("trabuco hills post-acute",       "lake forest"):  "f5cff168-5ff9-4ced-b365-96834d079536",

    # ─── Lake Forest ─────────────────────────────────────────────────
    ("freedom village retirement community", "lake forest"): "34b13857-a8e6-4d9e-a6f6-8b02c2c3d4bd",
}


def alias_key(name: str, city: str | None) -> tuple[str, str]:
    return (name.strip().lower(), (city or "").strip().lower())


# ─────────────────────────────────────────────────────────────────────
# 3. SQL emitter
# ─────────────────────────────────────────────────────────────────────

HOAG_CONTACTS = [
    # (account_name_in_doc, contact_name, role, email, phone, notes)
    # All five live under the Newport Beach Hoag account.
    ("Hoag Hospital", "Amy Robinson", "social_worker",
     None, None, "Hoag Hospice Liaison."),
    ("Hoag Hospital", "Arnetta Robinson", "social_worker",
     "arnetta.robinson@hoag.org", "+19492301155", "Hoag Hospice Liaison."),
    ("Hoag Hospital", "Brittany Carrillo", "social_worker",
     None, None, "Palliative Care."),
    ("Hoag Hospital", "Jenna Gailani, LCSW", "social_worker",
     None, None, "Fudge Family Acute Rehab."),
    ("Hoag Hospital", "Madeline Conrado, LCSW", "social_worker",
     None, None, "Neurology."),
]


def sql_str(s: str | None) -> str:
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def emit_migration(rows: list[DocRow], out_path: Path) -> None:
    new_rows: list[DocRow] = []
    alias_rows: list[tuple[DocRow, str]] = []  # (row, existing_uuid)
    for r in rows:
        target = DOC_ALIAS_OF_EXISTING.get(alias_key(r.name, r.city))
        if target:
            alias_rows.append((r, target))
        else:
            new_rows.append(r)

    lines = []
    lines.append("-- BD Module — South OC research-import seed")
    lines.append("--")
    lines.append("-- Imports Amy Dutton's South Orange County referral-source list")
    lines.append("-- (Word doc dated 2026-05-15) into bd_accounts. Generated by")
    lines.append("-- scripts/bd-south-oc-research-import.py — do not edit by hand;")
    lines.append("-- re-run the script with the updated doc instead.")
    lines.append("--")
    lines.append("-- Behavior:")
    lines.append("--   * For each doc row whose (name, city) matches an existing")
    lines.append("--     bd_accounts row via the alias table baked into the script,")
    lines.append("--     we UPDATE the existing row to fill in address / phone")
    lines.append("--     where currently NULL. The existing row's source stays as")
    lines.append("--     'manual' or 'trello_import' — we don't overwrite provenance.")
    lines.append("--   * For each doc row with no alias match, we INSERT a new")
    lines.append("--     bd_accounts row with source='research_import' so the")
    lines.append("--     'Prospect' badge surfaces it in the BD portal until Amy")
    lines.append("--     logs her first activity against it.")
    lines.append("--   * Re-runs are no-ops: the INSERT uses a partial unique index")
    lines.append("--     on (org_id, lower(name), lower(coalesce(city,''))) WHERE")
    lines.append("--     source='research_import', created in the same migration.")
    lines.append("--     The UPDATE statements are idempotent by construction")
    lines.append("--     (COALESCE preserves any value already present).")
    lines.append("--")
    lines.append("-- Production safety: pure additive. No DELETE, no DROP, no")
    lines.append("-- destructive change to non-NULL columns on existing rows.")
    lines.append("-- Tenant isolation: every INSERT carries org_id = default_org_id()")
    lines.append("-- per Phase B locked decisions.")
    lines.append("-- Rollback:")
    lines.append("--   _rollback/<this-filename>_down.sql clears source='research_import'")
    lines.append("--   rows it created, and unsets the address/phone overrides on the")
    lines.append("--   aliased rows where the value matches what the up-migration set.")
    lines.append("")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("-- 1. Idempotency index")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("")
    lines.append("CREATE UNIQUE INDEX IF NOT EXISTS idx_bd_accounts_research_import_unique")
    lines.append("  ON bd_accounts (org_id, lower(name), lower(coalesce(city, '')))")
    lines.append("  WHERE source = 'research_import';")
    lines.append("")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("-- 2. Backfill address/phone on aliased existing rows")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("--")
    lines.append(f"-- {len(alias_rows)} rows from the doc map to existing accounts via the")
    lines.append("-- alias table in scripts/bd-south-oc-research-import.py.")
    lines.append("")
    for (r, uuid) in alias_rows:
        sets = []
        if r.address:
            sets.append(f"address = COALESCE(address, {sql_str(r.address)})")
        if r.phone:
            sets.append(f"phone   = COALESCE(phone,   {sql_str(r.phone)})")
        if not sets:
            lines.append(f"-- {r.name}  →  existing id {uuid}  (no address/phone in doc; nothing to update)")
            lines.append("")
            continue
        lines.append(f"-- {r.name}  →  existing id {uuid}")
        lines.append("UPDATE bd_accounts")
        lines.append("   SET " + ",\n       ".join(sets))
        lines.append(f" WHERE id = '{uuid}'::uuid;")
        lines.append("")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("-- 3. Insert new prospect accounts")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("--")
    lines.append(f"-- {len(new_rows)} new accounts from the doc.")
    lines.append("--")
    lines.append("-- ON CONFLICT DO NOTHING against the partial unique index above")
    lines.append("-- so re-running this migration after the first apply is a no-op.")
    lines.append("")
    lines.append("INSERT INTO bd_accounts (")
    lines.append("  org_id, name, account_type, facility_subtype, professional_subtype,")
    lines.append("  city, address, phone, source")
    lines.append(")")
    lines.append("VALUES")
    value_rows = []
    for r in new_rows:
        facility_subtype = sql_str(r.subtype) if r.account_type == "facility" else "NULL"
        professional_subtype = sql_str(r.subtype) if r.account_type == "professional" else "NULL"
        value_rows.append(
            "  (public.default_org_id(), "
            f"{sql_str(r.name)}, {sql_str(r.account_type)}, "
            f"{facility_subtype}, {professional_subtype}, "
            f"{sql_str(r.city)}, {sql_str(r.address)}, {sql_str(r.phone)}, "
            "'research_import')"
        )
    lines.append(",\n".join(value_rows))
    lines.append("ON CONFLICT (org_id, lower(name), lower(coalesce(city, '')))")
    lines.append("  WHERE source = 'research_import'")
    lines.append("DO NOTHING;")
    lines.append("")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("-- 4. Hoag named contacts")
    lines.append("-- ─────────────────────────────────────────────────────────────")
    lines.append("--")
    lines.append("-- Five named Hoag contacts from the doc. All land under the")
    lines.append("-- Newport Beach Hoag account. The DO block does an exists-check")
    lines.append("-- per contact (case-insensitive name) so re-runs do not create")
    lines.append("-- duplicates and we do not need to add a unique constraint on")
    lines.append("-- bd_account_contacts (which may have legitimate same-name rows")
    lines.append("-- across different accounts).")
    lines.append("")
    lines.append("DO $$")
    lines.append("DECLARE")
    lines.append("  v_org_id      uuid := public.default_org_id();")
    lines.append("  v_account_id  uuid;")
    lines.append("BEGIN")
    lines.append("  -- Resolve the Newport Beach Hoag account by uuid; this is the")
    lines.append("  -- strategic-shared row seeded in 20260513140100. Bail silently")
    lines.append("  -- if it doesn't exist (e.g. fresh dev DB without the seed).")
    lines.append("  SELECT id INTO v_account_id FROM bd_accounts")
    lines.append("    WHERE id = '47cbb432-6bfd-4f29-87e4-d52bbcd61378'::uuid")
    lines.append("    LIMIT 1;")
    lines.append("  IF v_account_id IS NULL THEN")
    lines.append("    RAISE NOTICE 'Newport Beach Hoag account not found; skipping contact seed.';")
    lines.append("    RETURN;")
    lines.append("  END IF;")
    lines.append("")
    for (_acct, contact_name, role, email, phone, notes) in HOAG_CONTACTS:
        lines.append(f"  IF NOT EXISTS (SELECT 1 FROM bd_account_contacts")
        lines.append(f"                  WHERE account_id = v_account_id")
        lines.append(f"                    AND lower(name) = lower({sql_str(contact_name)})) THEN")
        lines.append("    INSERT INTO bd_account_contacts (")
        lines.append("      org_id, account_id, name, role, email, phone_office, notes")
        lines.append("    ) VALUES (")
        lines.append(f"      v_org_id, v_account_id, {sql_str(contact_name)}, {sql_str(role)},")
        lines.append(f"      {sql_str(email)}, {sql_str(phone)}, {sql_str(notes)}")
        lines.append("    );")
        lines.append("  END IF;")
        lines.append("")
    lines.append("END $$;")
    lines.append("")
    out_path.write_text("\n".join(lines))


def emit_rollback(rows: list[DocRow], out_path: Path, up_filename: str) -> None:
    new_rows: list[DocRow] = []
    alias_rows: list[tuple[DocRow, str]] = []
    for r in rows:
        target = DOC_ALIAS_OF_EXISTING.get(alias_key(r.name, r.city))
        if target:
            alias_rows.append((r, target))
        else:
            new_rows.append(r)

    lines = []
    lines.append(f"-- Rollback for {up_filename}")
    lines.append("--")
    lines.append("-- Reverses the South OC research-import seed:")
    lines.append("--   1. Deletes every bd_accounts row with source='research_import'")
    lines.append("--      AND no activities/referrals (to avoid clobbering accounts")
    lines.append("--      that have since been worked).")
    lines.append("--   2. Clears the address/phone overrides on aliased existing")
    lines.append("--      rows IFF the current value still equals what the up-migration")
    lines.append("--      set (so we don't undo later edits the rep made).")
    lines.append("--   3. Deletes the 5 Hoag named contacts inserted by the up.")
    lines.append("--   4. Drops the idempotency indexes.")
    lines.append("")
    lines.append("DELETE FROM bd_accounts a")
    lines.append(" WHERE a.source = 'research_import'")
    lines.append("   AND NOT EXISTS (SELECT 1 FROM bd_activities x WHERE x.account_id = a.id)")
    lines.append("   AND NOT EXISTS (SELECT 1 FROM bd_referrals  x WHERE x.account_id = a.id)")
    lines.append("   AND NOT EXISTS (SELECT 1 FROM bd_account_contacts x WHERE x.account_id = a.id);")
    lines.append("")
    for (r, uuid) in alias_rows:
        if r.address:
            lines.append(f"UPDATE bd_accounts SET address = NULL WHERE id = '{uuid}'::uuid AND address = {sql_str(r.address)};")
        if r.phone:
            lines.append(f"UPDATE bd_accounts SET phone   = NULL WHERE id = '{uuid}'::uuid AND phone   = {sql_str(r.phone)};")
    lines.append("")
    lines.append("DELETE FROM bd_account_contacts")
    lines.append(" WHERE account_id = '47cbb432-6bfd-4f29-87e4-d52bbcd61378'::uuid")
    lines.append("   AND name IN (")
    contact_names = [sql_str(c[1]) for c in HOAG_CONTACTS]
    lines.append("     " + ", ".join(contact_names))
    lines.append("   );")
    lines.append("")
    lines.append("DROP INDEX IF EXISTS idx_bd_accounts_research_import_unique;")
    lines.append("")
    out_path.write_text("\n".join(lines))


# ─────────────────────────────────────────────────────────────────────
# 4. CLI
# ─────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Build South OC research-import seed migration")
    parser.add_argument("--doc", required=True, help="Path to the .docx file")
    parser.add_argument("--out", required=True, help="Output .sql migration path")
    parser.add_argument("--rollback", help="Output rollback .sql path (optional)")
    parser.add_argument("--print-stats", action="store_true", help="Print a parse summary to stderr")
    args = parser.parse_args()

    rows = parse_doc(Path(args.doc))
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    emit_migration(rows, out_path)

    if args.rollback:
        rollback_path = Path(args.rollback)
        rollback_path.parent.mkdir(parents=True, exist_ok=True)
        emit_rollback(rows, rollback_path, out_path.name)

    if args.print_stats:
        new_rows = [r for r in rows if alias_key(r.name, r.city) not in DOC_ALIAS_OF_EXISTING]
        alias_rows = [r for r in rows if alias_key(r.name, r.city) in DOC_ALIAS_OF_EXISTING]
        sys.stderr.write(f"Parsed {len(rows)} doc rows\n")
        sys.stderr.write(f"  Aliases to existing: {len(alias_rows)}\n")
        sys.stderr.write(f"  New inserts:         {len(new_rows)}\n")
        by_type: dict[str, int] = {}
        for r in new_rows:
            by_type[f"{r.account_type}/{r.subtype}"] = by_type.get(f"{r.account_type}/{r.subtype}", 0) + 1
        for k, v in sorted(by_type.items()):
            sys.stderr.write(f"    {k}: {v}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
