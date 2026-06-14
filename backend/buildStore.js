// buildStore.js
// Handles reading and writing the persistent builds.json file.
// All build records are stored as a flat JSON array (newest first).

const fs   = require('fs');
const path = require('path');

const BUILDS_FILE = path.join(__dirname, 'builds.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create builds.json with an empty array if it doesn't exist yet. */
function initStore() {
  if (!fs.existsSync(BUILDS_FILE)) {
    fs.writeFileSync(BUILDS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return all build records (array, newest first). */
function getBuilds() {
  initStore();
  try {
    return JSON.parse(fs.readFileSync(BUILDS_FILE, 'utf8'));
  } catch (err) {
    console.error('[buildStore] Error reading builds.json:', err.message);
    return [];
  }
}

/**
 * Persist a new build record.
 * @param {Object} record – full build object (id, repoName, commitHash, …)
 * @returns {Object} the saved record
 */
function saveBuild(record) {
  const builds = getBuilds();
  builds.unshift(record); // newest first
  fs.writeFileSync(BUILDS_FILE, JSON.stringify(builds, null, 2), 'utf8');
  return record;
}

/**
 * Patch an existing build by id (e.g. update status/log after streaming).
 * @param {string} id
 * @param {Object} updates – partial fields to merge
 * @returns {Object|null}
 */
function updateBuild(id, updates) {
  const builds = getBuilds();
  const idx = builds.findIndex(b => b.id === id);
  if (idx === -1) return null;
  builds[idx] = { ...builds[idx], ...updates };
  fs.writeFileSync(BUILDS_FILE, JSON.stringify(builds, null, 2), 'utf8');
  return builds[idx];
}

/** Find a single build by id. Returns null if not found. */
function getBuildById(id) {
  return getBuilds().find(b => b.id === id) || null;
}

module.exports = { getBuilds, saveBuild, updateBuild, getBuildById, initStore };
