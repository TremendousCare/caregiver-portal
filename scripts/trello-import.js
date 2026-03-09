#!/usr/bin/env node
// scripts/trello-import.js
// Main Trello import runner. Parses a Trello board JSON export and
// imports caregiver records into Supabase.
//
// Usage:
//   node scripts/trello-import.js --file <path> [--dry-run | --execute]
//
// --dry-run  (default) Parse and display, no DB writes.
// --execute  Insert into Supabase. Requires SUPABASE_SERVICE_ROLE_KEY env var.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  TARGET_LISTS,
  SKIP_CARDS,
  LIST_CONFIG,
  CHECKLIST_TASK_MAP,
} from './trello-import-config.js';

import https from 'https';

import {
  parseName,
  parseDescription,
  mapChecklists,
  convertComments,
  normalizePhone,
  buildDescriptionNote,
} from '../src/lib/trelloParser.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { mode: 'dry-run', file: null, apiComments: false, outputJson: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') {
      result.mode = 'execute';
    } else if (args[i] === '--dry-run') {
      result.mode = 'dry-run';
    } else if (args[i] === '--output-json' && args[i + 1]) {
      result.mode = 'output-json';
      result.outputJson = args[i + 1];
      i++;
    } else if (args[i] === '--file' && args[i + 1]) {
      result.file = args[i + 1];
      i++; // skip next arg
    } else if (args[i] === '--api-comments') {
      result.apiComments = true;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Trello API client — fetches full comment history per card
// ---------------------------------------------------------------------------
function createTrelloClient() {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!apiKey || !token) {
    console.error('ERROR: TRELLO_API_KEY and TRELLO_TOKEN environment variables are required for --api-comments.');
    console.error('Set them before running: TRELLO_API_KEY=... TRELLO_TOKEN=... node scripts/trello-import.js ...');
    process.exit(1);
  }

  function httpsGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse Trello API response: ${data.substring(0, 200)}`));
          }
        });
      }).on('error', reject);
    });
  }

  return {
    /**
     * Get ALL comments for a specific card (no 1000-action limit).
     * @param {string} cardId - Trello card ID
     * @returns {Promise<Array<{text, date, by}>>}
     */
    async getCardComments(cardId) {
      const allComments = [];
      let before = '';

      while (true) {
        const url =
          `https://api.trello.com/1/cards/${cardId}/actions?filter=commentCard&limit=1000` +
          `&key=${apiKey}&token=${token}` +
          (before ? `&before=${before}` : '');

        const data = await httpsGet(url);
        for (const action of data) {
          allComments.push({
            text: action.data?.text || '',
            date: action.date,
            by: action.memberCreator?.fullName || action.memberCreator?.username || 'Unknown',
          });
        }

        if (data.length < 1000) break;
        before = data[data.length - 1].date;
      }

      return allComments;
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase client (lazy — only created in execute mode)
// ---------------------------------------------------------------------------
function createSupabaseClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is required for --execute mode.');
    process.exit(1);
  }

  const SUPABASE_URL = 'https://zocrnurvazyxdpyqimgj.supabase.co';
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  return {
    /**
     * Select rows from a table with filters.
     * @param {string} table
     * @param {string} select - columns to select
     * @param {Object} filters - { column: value } for eq filters
     * @param {Object} options - { ilike: {col: val}, neq: {col: val}, is: {col: val} }
     * @returns {Promise<{data: Array, error: any}>}
     */
    async select(table, select, filters = {}, options = {}) {
      const params = new URLSearchParams({ select });
      for (const [col, val] of Object.entries(filters)) {
        params.append(col, `eq.${val}`);
      }
      if (options.ilike) {
        for (const [col, val] of Object.entries(options.ilike)) {
          params.append(col, `ilike.${val}`);
        }
      }
      if (options.neq) {
        for (const [col, val] of Object.entries(options.neq)) {
          params.append(col, `neq.${val}`);
        }
      }
      if (options.is) {
        for (const [col, val] of Object.entries(options.is)) {
          params.append(col, `is.${val}`);
        }
      }

      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers });
        if (!resp.ok) {
          const text = await resp.text();
          return { data: null, error: { status: resp.status, message: text } };
        }
        const data = await resp.json();
        return { data, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },

    /**
     * Insert a row into a table.
     * @param {string} table
     * @param {Object} row
     * @returns {Promise<{data: any, error: any}>}
     */
    async insert(table, row) {
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(row),
        });
        if (!resp.ok) {
          const text = await resp.text();
          return { data: null, error: { status: resp.status, message: text } };
        }
        const data = await resp.json();
        return { data, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Card creation date from Trello ID
// ---------------------------------------------------------------------------
function getCardCreationDate(cardId) {
  try {
    const timestamp = parseInt(cardId.substring(0, 8), 16);
    const date = new Date(1000 * timestamp);
    // Sanity check: should be between 2020 and 2030
    if (date.getFullYear() >= 2020 && date.getFullYear() <= 2030) {
      return date.toISOString().split('T')[0]; // YYYY-MM-DD
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build lookup maps from Trello data
// ---------------------------------------------------------------------------
function buildLookups(data) {
  // listMap: list.id -> list.name
  const listMap = {};
  for (const list of data.lists || []) {
    listMap[list.id] = list.name;
  }

  // checklistsByCard: card.id -> [checklists]
  const checklistsByCard = {};
  for (const cl of data.checklists || []) {
    const cardId = cl.idCard;
    if (!checklistsByCard[cardId]) checklistsByCard[cardId] = [];
    checklistsByCard[cardId].push(cl);
  }

  // commentsByCard: card.id -> [{text, date, by}]
  const commentsByCard = {};
  for (const action of data.actions || []) {
    if (action.type !== 'commentCard') continue;
    const cardId = action.data?.card?.id;
    if (!cardId) continue;
    if (!commentsByCard[cardId]) commentsByCard[cardId] = [];
    commentsByCard[cardId].push({
      text: action.data.text || '',
      date: action.date,
      by: action.memberCreator?.fullName || action.memberCreator?.username || 'Unknown',
    });
  }

  return { listMap, checklistsByCard, commentsByCard };
}

// ---------------------------------------------------------------------------
// Filter cards to importable set
// ---------------------------------------------------------------------------
function filterCards(data, listMap) {
  // Build set of target list IDs
  const targetListIds = new Set();
  for (const list of data.lists || []) {
    if (TARGET_LISTS.includes(list.name)) {
      targetListIds.add(list.id);
    }
  }

  return (data.cards || []).filter((card) => {
    // Must be open
    if (card.closed) return false;
    // Must be in a target list
    if (!targetListIds.has(card.idList)) return false;
    // Must not be in skip list
    if (SKIP_CARDS.includes(card.name)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Build a single caregiver record from a Trello card
// ---------------------------------------------------------------------------
function buildCaregiverRecord(card, listName, listConfig, checklists, comments) {
  const today = new Date().toISOString().split('T')[0];

  // Parse name
  const parsed = parseName(card.name);

  // Parse description fields
  const descFields = parseDescription(card.desc);

  // Map checklists to tasks
  const { tasks: mappedTasks, unmapped } = mapChecklists(checklists || [], CHECKLIST_TASK_MAP);

  // Convert comments to notes
  const convertedComments = convertComments(comments || []);

  // Build import note
  const importNote = {
    text: `Imported from Trello board 'Caregiver Roadmap', ${listName} list. Original card created ${getCardCreationDate(card.id) || 'unknown'}.`,
    type: 'system',
    timestamp: Date.now(),
    author: 'trello-import',
  };

  // Build annotation note if present
  const annotationNotes = [];
  if (parsed.annotation) {
    annotationNotes.push({
      text: `Trello card annotation: ${parsed.annotation}`,
      type: 'note',
      timestamp: Date.now(),
      author: 'trello-import',
    });
  }

  // Build description note (captures pay rate, attendance, availability, etc.)
  const descriptionNotes = [];
  const descNoteText = buildDescriptionNote(card.desc);
  if (descNoteText) {
    descriptionNotes.push({
      text: descNoteText,
      type: 'system',
      timestamp: Date.now(),
      author: 'Trello Import',
    });
  }

  // Assemble full row
  const row = {
    id: crypto.randomUUID(),
    first_name: parsed.firstName,
    last_name: parsed.lastName,
    phone: descFields.phone || '',
    email: (descFields.email || '').toLowerCase(),
    address: descFields.address || '',
    city: descFields.city || '',
    state: descFields.state || '',
    zip: descFields.zip || '',
    per_id: descFields.per_id || '',
    hca_expiration: descFields.hca_expiration || null,
    has_hca: descFields.per_id ? 'yes' : '',
    source: 'trello',
    source_detail: `${listName} list - Trello import ${today}`,
    employment_status: listConfig.employment_status,
    employment_status_changed_at: Date.now(),
    employment_status_changed_by: 'trello-import',
    board_status: listConfig.board_status || '',
    phase_override: listConfig.phase_override || null,
    trello_card_id: card.id,
    tasks: mappedTasks,
    notes: [importNote, ...annotationNotes, ...descriptionNotes, ...convertedComments],
    created_at: Date.now(),
    application_date: getCardCreationDate(card.id) || null,
  };

  return { row, unmapped };
}

// ---------------------------------------------------------------------------
// Dedup check (execute mode)
// ---------------------------------------------------------------------------
async function checkDuplicate(supabase, email, phone) {
  // Check by email
  if (email) {
    const { data, error } = await supabase.select(
      'caregivers',
      'id,first_name,last_name',
      {},
      { ilike: { email }, is: { archived: 'false' } }
    );
    if (!error && data && data.length > 0) {
      return { match: data[0], matchedOn: 'email' };
    }
  }

  // Check by phone (normalize both sides)
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone && normalizedPhone.length >= 10) {
    const { data, error } = await supabase.select(
      'caregivers',
      'id,first_name,last_name,phone',
      {},
      { neq: { phone: '' }, is: { archived: 'false' } }
    );
    if (!error && data) {
      for (const existing of data) {
        if (normalizePhone(existing.phone) === normalizedPhone) {
          return { match: existing, matchedOn: 'phone' };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dry-run output
// ---------------------------------------------------------------------------
function printDryRun(caregivers) {
  console.log(`\n=== DRY RUN — ${caregivers.length} caregivers to import ===\n`);

  const allUnmapped = {};

  for (let i = 0; i < caregivers.length; i++) {
    const { row, unmapped } = caregivers[i];
    const completedCount = Object.values(row.tasks).filter((t) => t.completed).length;
    const incompleteCount = Object.values(row.tasks).filter((t) => !t.completed).length;
    const commentCount = row.notes.filter((n) => n.type === 'note' && n.author !== 'trello-import').length;
    const systemNoteCount = row.notes.filter((n) => n.type === 'system').length;
    const hasDescNote = row.notes.some((n) => n.author === 'Trello Import' && n.text.startsWith('Trello Card Details'));
    const unmappedStr = unmapped.length > 0 ? unmapped.join(', ') : '(none)';

    // Track global unmapped
    for (const item of unmapped) {
      allUnmapped[item] = (allUnmapped[item] || 0) + 1;
    }

    console.log(`${i + 1}. ${row.first_name} ${row.last_name}`);
    console.log(`   Phone: ${row.phone || '(none)'} | Email: ${row.email || '(none)'}`);
    console.log(`   Address: ${[row.address, row.city, row.state, row.zip].filter(Boolean).join(', ') || '(none)'}`);
    console.log(`   Employment: ${row.employment_status} | Board: ${row.board_status || '(none)'}`);
    console.log(`   Tasks: ${completedCount} completed, ${incompleteCount} incomplete`);
    console.log(`   Notes: ${commentCount} comments, ${systemNoteCount} system notes${hasDescNote ? ' (includes card details)' : ''}`);
    console.log(`   Unmapped checklist items: ${unmappedStr}`);
    if (row.application_date) {
      console.log(`   Application date: ${row.application_date}`);
    }
    console.log('');
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`Total: ${caregivers.length} caregivers ready to import`);
  const unmappedEntries = Object.entries(allUnmapped);
  if (unmappedEntries.length > 0) {
    const unmappedList = unmappedEntries.map(([name, count]) => `${name} (${count})`).join(', ');
    console.log(`Unmapped items across all cards: ${unmappedList}`);
  } else {
    console.log('Unmapped items across all cards: (none)');
  }
}

// ---------------------------------------------------------------------------
// Execute mode
// ---------------------------------------------------------------------------
async function executeInserts(caregivers, supabase) {
  console.log(`\n=== EXECUTING — Inserting ${caregivers.length} caregivers ===\n`);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < caregivers.length; i++) {
    const { row } = caregivers[i];
    const label = `${row.first_name} ${row.last_name}`;
    process.stdout.write(`${i + 1}. ${label}... `);

    try {
      // Dedup check
      const dup = await checkDuplicate(supabase, row.email, row.phone);
      if (dup) {
        const existingName = `${dup.match.first_name} ${dup.match.last_name}`;
        console.log(`SKIP: duplicate of existing ${existingName} (matched on ${dup.matchedOn}: ${dup.matchedOn === 'email' ? row.email : row.phone})`);
        skipped++;
        continue;
      }

      // Insert
      const { data, error } = await supabase.insert('caregivers', row);
      if (error) {
        console.log(`FAIL: ${error.message || JSON.stringify(error)}`);
        failed++;
      } else {
        const id = (data && data[0]?.id) || row.id;
        console.log(`Inserted (id: ${id})`);
        inserted++;
      }
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      failed++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped (duplicate): ${skipped}`);
  console.log(`Failed: ${failed}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs();

  // Validate --file
  if (!args.file) {
    console.error('Usage: node scripts/trello-import.js --file <path> [--dry-run | --execute] [--api-comments]');
    console.error('');
    console.error('  --file <path>     Path to Trello board JSON export (REQUIRED)');
    console.error('  --dry-run         Parse and display only, no DB writes (default)');
    console.error('  --execute         Insert caregivers into Supabase');
    console.error('  --api-comments    Fetch full comment history from Trello API (requires TRELLO_API_KEY + TRELLO_TOKEN env vars)');
    process.exit(1);
  }

  // Resolve file path
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: File not found: ${filePath}`);
    process.exit(1);
  }

  // Validate execute mode has credentials
  let supabase = null;
  if (args.mode === 'execute') {
    supabase = createSupabaseClient();
  }

  // Validate API comments mode has credentials
  let trello = null;
  if (args.apiComments) {
    trello = createTrelloClient();
    console.log('API comments mode enabled — will fetch full comment history from Trello API.');
  }

  // Load Trello JSON
  let data;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: Failed to load Trello JSON: ${err.message}`);
    process.exit(1);
  }

  console.log(`Loaded Trello board: "${data.name || 'Unknown'}"`);
  console.log(`  Lists: ${(data.lists || []).length}`);
  console.log(`  Cards: ${(data.cards || []).length}`);
  console.log(`  Checklists: ${(data.checklists || []).length}`);
  console.log(`  Actions: ${(data.actions || []).length}`);
  console.log(`  Target lists: ${TARGET_LISTS.join(', ')}`);
  console.log(`  Skip cards: ${SKIP_CARDS.join(', ')}`);

  // Build lookups
  const { listMap, checklistsByCard, commentsByCard } = buildLookups(data);

  // Filter cards
  const cards = filterCards(data, listMap);
  console.log(`\n  Filtered to ${cards.length} importable cards.\n`);

  if (cards.length === 0) {
    console.log('No cards to import. Check TARGET_LISTS and SKIP_CARDS in config.');
    process.exit(0);
  }

  // Build caregiver records
  const caregivers = [];
  for (let ci = 0; ci < cards.length; ci++) {
    const card = cards[ci];
    const listName = listMap[card.idList] || 'Unknown';
    const listConf = LIST_CONFIG[listName];
    if (!listConf) {
      console.warn(`WARNING: No LIST_CONFIG for list "${listName}" — skipping card "${card.name}"`);
      continue;
    }

    // Determine comments source: API (full history) or JSON export (limited)
    let comments = commentsByCard[card.id] || [];
    if (trello) {
      try {
        process.stdout.write(`  Fetching comments for ${card.name} (${ci + 1}/${cards.length})... `);
        comments = await trello.getCardComments(card.id);
        const jsonCount = (commentsByCard[card.id] || []).length;
        console.log(`${comments.length} via API (JSON had ${jsonCount})`);
      } catch (err) {
        console.warn(`API error for ${card.name}, falling back to JSON: ${err.message}`);
        comments = commentsByCard[card.id] || [];
      }
    }

    try {
      const result = buildCaregiverRecord(
        card,
        listName,
        listConf,
        checklistsByCard[card.id] || [],
        comments
      );
      caregivers.push(result);
    } catch (err) {
      console.warn(`WARNING: Failed to parse card "${card.name}": ${err.message}`);
    }
  }

  // Output
  if (args.mode === 'dry-run') {
    printDryRun(caregivers);
  } else if (args.mode === 'output-json') {
    const rows = caregivers.map((c) => c.row);
    fs.writeFileSync(args.outputJson, JSON.stringify(rows, null, 2));
    console.log(`\nWrote ${rows.length} caregiver records to ${args.outputJson}`);
  } else {
    await executeInserts(caregivers, supabase);
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
