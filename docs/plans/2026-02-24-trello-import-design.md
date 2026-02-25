# Trello Import Design

**Date:** 2026-02-24
**Status:** Approved
**Approach:** Direct database insert script (Approach A)

## Overview

One-time import of caregiver data from a Trello board export (JSON) into the portal's Supabase database. The script runs locally, reads the Trello JSON, parses card data, and inserts caregiver records directly into the `caregivers` table.

## Source Data

- **Trello board:** "Caregiver Roadmap"
- **Total open cards:** 306 (222 rejected, skipped)
- **Import candidates:** 82 caregivers across active lists
- **Test batch (Round 1):** 5 caregivers from the Deployed list

### Trello Board Structure

| Trello List | Cards | Import? | Portal Destination |
|---|---|---|---|
| Phone Interview | 7 | Yes (later) | Pipeline: Intake & Screen |
| Virtual Interview | 1 | Yes (later) | Pipeline: Interview & Offer |
| Offer Out | 3 | Yes (later) | Pipeline: Interview & Offer |
| Onboarding | 3 | Yes (later) | Pipeline: Onboarding Packet |
| I-9 Verification | 5 | Yes (later) | Pipeline: Verification & Handoff |
| Orientation | 4 | Yes (later) | Pipeline: Orientation |
| Ready for Deployment | 15 | Yes (later) | Active Roster: inactive |
| Deployed | 6 | **Round 1 (5 cards)** | Active Roster: active |
| Reserve Pool | 20 | Yes (later) | Active Roster: inactive |
| Rejected | 222 | **No** | Skipped |
| Potential Future Hires | 18 | **No** | Skipped |

### Description Formats (3 patterns)

1. **Structured template (189 cards):** Has `APPLICANT INFORMATION` header with Name, Address, Phone, Email, Pay Rate, HCA info
2. **Simple text (78 cards):** Just a phone number or basic contact info
3. **Empty (37 cards):** Name in card title only

### Trello Data Available

- Card title = caregiver name (sometimes with annotations like "(On Medical Leave)")
- Card description = contact info, address, HCA details (varies by format)
- Checklists = onboarding/orientation task completion
- Comments = interaction history with timestamps and authors
- Labels = status indicators (e.g., "30+ Hours - Secure", "Attrition Risk")
- Card creation date = approximate application date

## Field Mapping

### Identity Fields (parsed from description)

| Trello Source | Portal Field | Parsing Method |
|---|---|---|
| Card title | `first_name`, `last_name` | Split on space, strip parenthetical annotations |
| Description: Phone No. | `phone` | Regex, normalize to 10 digits |
| Description: Email | `email` | Regex, lowercase |
| Description: Full Address | `address`, `city`, `state`, `zip` | Regex with address parsing |
| Description: Pay Rate | (stored in import note) | Regex for dollar amount |
| Description: HCA PER ID | `per_id` | Regex for numeric ID |
| Description: HCA expiry | `hca_expiration` | Regex for date patterns |

### Employment/Roster Fields (set per list config)

| Field | Deployed Value | Ready for Deployment | Reserve Pool |
|---|---|---|---|
| `employment_status` | `active` | `inactive` | `inactive` |
| `board_status` | `deployed` | `ready` | `reserve` |
| `source` | `trello` | `trello` | `trello` |

### Checklist-to-Task Mapping

**Trello "Onboarding" checklist:**

| Trello Item | Portal Task ID | Phase |
|---|---|---|
| HCA Registered | `hca_linked` | verification |
| IRS Form I9 | `i9_form` | onboarding |
| IRS Form W4 | `w4_form` | onboarding |
| Employee Handbook Acknowledgement | `employee_handbook` | onboarding |
| Wage and Employment Notice | `wage_notice` | onboarding |
| Employee Agreement | `employment_agreement` | onboarding |
| Employee Emergency Contact | `emergency_contact` | onboarding |
| Direct Deposit Authorization | `direct_deposit` | onboarding |
| TB Test | `tb_test` | intake |
| Copy of Driver's License | `docs_uploaded` | verification |
| Copy of Automobile Insurance | (no separate mapping, noted in import note) | - |
| Training | `training_assigned` | verification |
| Social Media Check | (no portal equivalent, noted in import note) | - |

**Trello "Orientation" checklist:**

| Trello Item | Portal Task ID | Phase |
|---|---|---|
| IRS Form I9 Identification Validation | `i9_validation` | verification |
| Questionnaire | `questionnaire_done` | orientation |
| Scrub Top Size | `scrubs_distributed` | orientation |

### Notes Conversion

Each Trello comment becomes:
```json
{
  "text": "<comment text>",
  "type": "note",
  "timestamp": <comment date as epoch ms>,
  "author": "<commenter name> (via Trello)"
}
```

Plus one auto-generated import note:
```json
{
  "text": "Imported from Trello board 'Caregiver Roadmap', <list name> list. Original card created <date>.",
  "type": "note",
  "timestamp": <script run time>,
  "author": "Trello Import"
}
```

### Name Parsing

Card titles with annotations are cleaned:
- `Amanda Vega (On Medical Leave until April 2026)` -> name: Amanda Vega, note: "On Medical Leave until April 2026"
- `Aaliyah Navarro-On Call` -> name: Aaliyah Navarro, note: "On Call" (only when dash clearly separates annotation from name)
- `Folasade Famofo-Idowu` -> name: Folasade Famofo-Idowu (hyphenated last name, no stripping)

## Script Design

### Files

- `scripts/trello-import.js` — Main import script
- `scripts/trello-import-config.js` — Configurable mappings (lists, tasks, field parsers)

### Usage

```bash
# Preview what would be imported (safe, no DB writes)
node scripts/trello-import.js --dry-run

# Actually insert into Supabase
node scripts/trello-import.js --execute
```

### Flow

1. Load Trello JSON and config
2. Build lookup maps (lists, checklists by card, comments by card)
3. Filter to target list(s) from config
4. For each card:
   a. Parse name from title
   b. Parse contact/HCA fields from description
   c. Map checklist completion to portal tasks
   d. Convert comments to notes array
   e. Build full caregiver row object
5. Dedup check: query Supabase for existing matches by email (case-insensitive) and phone (normalized)
6. Dry-run: print summary table of all caregivers to be created
7. Execute: insert one at a time, log success/failure per record

### Safety

- Default mode is `--dry-run` (no flag = dry run)
- Inserts are individual, not transactional (one failure doesn't block others)
- Dedup checks email and phone before inserting
- No existing records are modified
- Supabase service role key read from environment variable, never hardcoded
- No changes to production code, components, or Edge Functions

### Dependencies

- `@supabase/supabase-js` (already in project)
- Node.js (already available)

## Batching Strategy

| Round | Lists | Count | Destination |
|---|---|---|---|
| **1 (test)** | Deployed (minus Chris Nash) | 5 | Active Roster: active |
| 2 | Ready for Deployment | 15 | Active Roster: inactive |
| 3 | Reserve Pool | 20 | Active Roster: inactive |
| 4 | Onboarding + I-9 Verification | 8 | Pipeline: onboarding/verification |
| 5 | Orientation | 4 | Pipeline: orientation |
| 6 | Phone Interview + Virtual Interview + Offer Out | 11 | Pipeline: intake/interview |

Each round: run `--dry-run`, verify output, run `--execute`, verify in portal.

## Reconfiguration

All mappings are in `trello-import-config.js`:
- `TARGET_LISTS` — which Trello lists to process
- `LIST_CONFIG` — per-list employment_status and board_status
- `CHECKLIST_TASK_MAP` — Trello item name to portal task ID
- Description parsing regexes

To import a different batch, change `TARGET_LISTS` and re-run.
