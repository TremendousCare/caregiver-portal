#!/usr/bin/env node
// scripts/trello-backfill-notes.js
// Backfills missing Trello comments and description notes for caregivers
// already imported into Supabase. Uses the Trello API for full comment history.
//
// Usage:
//   TRELLO_API_KEY=... TRELLO_TOKEN=... node scripts/trello-backfill-notes.js \
//     --file <trello-json> [--dry-run | --execute]
//
// Requires: TRELLO_API_KEY, TRELLO_TOKEN env vars
// Execute mode also requires: SUPABASE_SERVICE_ROLE_KEY env var

import fs from 'fs';
import path from 'path';
import https from 'https';

import {
  parseName,
  convertComments,
  normalizePhone,
  buildDescriptionNote,
} from '../src/lib/trelloParser.js';

import {
  TARGET_LISTS,
  SKIP_CARDS,
} from './trello-import-config.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { mode: 'dry-run', file: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') result.mode = 'execute';
    else if (args[i] === '--dry-run') result.mode = 'dry-run';
    else if (args[i] === '--file' && args[i + 1]) {
      result.file = args[i + 1];
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Trello API client
// ---------------------------------------------------------------------------
function createTrelloClient() {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!apiKey || !token) {
    console.error('ERROR: TRELLO_API_KEY and TRELLO_TOKEN env vars required.');
    process.exit(1);
  }

  function httpsGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
        });
      }).on('error', reject);
    });
  }

  return {
    async getCardComments(cardId) {
      const all = [];
      let before = '';
      while (true) {
        const url =
          `https://api.trello.com/1/cards/${cardId}/actions?filter=commentCard&limit=1000` +
          `&key=${apiKey}&token=${token}` +
          (before ? `&before=${before}` : '');
        const data = await httpsGet(url);
        for (const action of data) {
          all.push({
            text: action.data?.text || '',
            date: action.date,
            by: action.memberCreator?.fullName || action.memberCreator?.username || 'Unknown',
          });
        }
        if (data.length < 1000) break;
        before = data[data.length - 1].date;
      }
      return all;
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase client (minimal — just what we need for backfill)
// ---------------------------------------------------------------------------
function createSupabaseClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY required for --execute mode.');
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
    async findCaregiverByName(firstName, lastName) {
      const params = new URLSearchParams({
        select: 'id,first_name,last_name,notes',
        first_name: `eq.${firstName}`,
        last_name: `eq.${lastName}`,
      });
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/caregivers?${params}`, { headers });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.length > 0 ? data[0] : null;
    },

    async updateNotes(caregiverId, notes) {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/caregivers?id=eq.${caregiverId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ notes }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Update failed: ${resp.status} ${text}`);
      }
      return await resp.json();
    },
  };
}

// ---------------------------------------------------------------------------
// Dedup: check if a note already exists by timestamp + author text match
// ---------------------------------------------------------------------------
function isDuplicate(existingNotes, newNote) {
  return existingNotes.some((existing) => {
    // Match by timestamp (exact) and text start (first 50 chars)
    if (existing.timestamp === newNote.timestamp) return true;
    // Also match by text similarity for notes imported with wrong timestamp
    const existText = (existing.text || '').substring(0, 80);
    const newText = (newNote.text || '').substring(0, 80);
    return existText === newText && existing.author === newNote.author;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs();

  if (!args.file) {
    console.error('Usage: TRELLO_API_KEY=... TRELLO_TOKEN=... node scripts/trello-backfill-notes.js --file <path> [--dry-run | --execute]');
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: File not found: ${filePath}`);
    process.exit(1);
  }

  const trello = createTrelloClient();
  let supabase = null;
  if (args.mode === 'execute') {
    supabase = createSupabaseClient();
  }

  // Load Trello JSON
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Build list map
  const listMap = {};
  for (const list of data.lists || []) {
    listMap[list.id] = list.name;
  }

  // Find target cards
  const targetListIds = new Set();
  for (const list of data.lists || []) {
    if (TARGET_LISTS.includes(list.name)) {
      targetListIds.add(list.id);
    }
  }

  const cards = (data.cards || []).filter((card) => {
    if (card.closed) return false;
    if (!targetListIds.has(card.idList)) return false;
    if (SKIP_CARDS.includes(card.name)) return false;
    return true;
  });

  console.log(`Found ${cards.length} cards in [${TARGET_LISTS.join(', ')}] to backfill.\n`);

  let totalAdded = 0;
  let totalSkipped = 0;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const parsed = parseName(card.name);
    const label = `${parsed.firstName} ${parsed.lastName}`;

    console.log(`${i + 1}. ${label}`);

    // Fetch full comments from API
    process.stdout.write('   Fetching API comments... ');
    const apiComments = await trello.getCardComments(card.id);
    console.log(`${apiComments.length} found`);

    // Convert to portal note format
    const apiNotes = convertComments(apiComments);

    // Build description note
    const descNoteText = buildDescriptionNote(card.desc);
    const descNote = descNoteText ? {
      text: descNoteText,
      type: 'system',
      timestamp: Date.now(),
      author: 'Trello Import',
    } : null;

    if (args.mode === 'execute') {
      // Find caregiver in Supabase
      const caregiver = await supabase.findCaregiverByName(parsed.firstName, parsed.lastName);
      if (!caregiver) {
        console.log(`   SKIP: Not found in Supabase (${label})`);
        continue;
      }

      const existingNotes = caregiver.notes || [];
      console.log(`   Existing notes in portal: ${existingNotes.length}`);

      // Dedup: find notes that aren't already present
      const newNotes = apiNotes.filter((n) => !isDuplicate(existingNotes, n));
      const hasDescNote = existingNotes.some((n) =>
        n.author === 'Trello Import' && (n.text || '').startsWith('Trello Card Details')
      );

      if (descNote && !hasDescNote) {
        newNotes.unshift(descNote);
      }

      if (newNotes.length === 0) {
        console.log('   No new notes to add (all already present)');
        totalSkipped++;
        continue;
      }

      console.log(`   Adding ${newNotes.length} new notes (${apiNotes.length - (newNotes.length - (descNote && !hasDescNote ? 1 : 0))} duplicates skipped)`);

      // Merge: existing notes + new notes, sorted by timestamp
      const merged = [...existingNotes, ...newNotes].sort((a, b) => {
        // System notes (import notes, description) first, then by timestamp
        if (a.type === 'system' && b.type !== 'system') return -1;
        if (b.type === 'system' && a.type !== 'system') return 1;
        return (a.timestamp || 0) - (b.timestamp || 0);
      });

      try {
        await supabase.updateNotes(caregiver.id, merged);
        console.log(`   Updated successfully (${merged.length} total notes)`);
        totalAdded += newNotes.length;
      } catch (err) {
        console.log(`   FAIL: ${err.message}`);
      }
    } else {
      // Dry-run: just show what would be added
      console.log(`   API comments: ${apiNotes.length}`);
      console.log(`   Description note: ${descNote ? 'yes' : 'no'}`);
      if (descNote) {
        // Show first 200 chars of description note
        console.log(`   Description preview: ${descNoteText.substring(0, 200)}...`);
      }
      console.log('');
    }
  }

  if (args.mode === 'execute') {
    console.log(`\n=== Backfill Complete ===`);
    console.log(`Notes added: ${totalAdded}`);
    console.log(`Caregivers skipped (all notes present): ${totalSkipped}`);
  } else {
    console.log('=== DRY RUN complete — use --execute to write to Supabase ===');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
