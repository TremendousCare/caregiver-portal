// src/lib/trelloParser.js
// Trello card parsing utilities for import script.

function parseName(cardTitle) {
  return { firstName: '', lastName: '', annotation: null };
}

function parseDescription(desc) {
  return {};
}

function mapChecklists(checklists, taskMap) {
  return { tasks: {}, unmapped: [] };
}

function convertComments(comments) {
  return [];
}

function normalizePhone(phone) {
  return '';
}

module.exports = { parseName, parseDescription, mapChecklists, convertComments, normalizePhone };
