// gitOps.js
// Wraps simple-git to provide clone, commit-log, and checkout helpers.
// Cloned repos land in backend/repos/<repo-name>/.

const simpleGit = require('simple-git');
const path      = require('path');
const fs        = require('fs');

// Directory where all cloned repos are stored
const REPOS_DIR = path.join(__dirname, 'repos');

// Ensure the repos directory exists on startup
if (!fs.existsSync(REPOS_DIR)) {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract a filesystem-safe repo name from a GitHub URL. */
function getRepoName(repoUrl) {
  // Strip trailing .git and grab the last path segment
  return repoUrl.replace(/\.git$/, '').split('/').pop();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Clone a repo into repos/<name>/.
 * If the directory already exists, pull the latest changes instead.
 *
 * @param {string} repoUrl – full GitHub HTTPS URL
 * @returns {{ repoName, repoPath, alreadyExisted }}
 */
async function cloneRepo(repoUrl) {
  const repoName = getRepoName(repoUrl);
  const repoPath = path.join(REPOS_DIR, repoName);

  if (fs.existsSync(repoPath)) {
    // Repo already cloned — just pull latest
    console.log(`[git] ${repoName} already cloned — pulling latest…`);
    const git = simpleGit(repoPath);
    // Reset any checkout-to-past-commit state before pulling
    await git.checkout('HEAD');          // detach-safe reset
    await git.pull('origin', 'HEAD', ['--rebase=false']).catch(() => {}); // best-effort
    return { repoName, repoPath, alreadyExisted: true };
  }

  // Fresh clone
  console.log(`[git] Cloning ${repoUrl} → ${repoPath}`);
  await simpleGit().clone(repoUrl, repoPath);
  return { repoName, repoPath, alreadyExisted: false };
}

/**
 * Return the last 50 commits for a cloned repo.
 *
 * @param {string} repoName
 * @returns {Array<{ hash, shortHash, message, author, date }>}
 */
async function getCommits(repoName) {
  const repoPath = path.join(REPOS_DIR, repoName);
  const git = simpleGit(repoPath);

  const log = await git.log({ maxCount: 50 });
  return log.all.map(c => ({
    hash:      c.hash,
    shortHash: c.hash.substring(0, 7),
    message:   c.message,
    author:    c.author_name,
    date:      c.date,
  }));
}

/**
 * Checkout a specific commit so docker build runs against that snapshot.
 *
 * @param {string} repoName
 * @param {string} commitHash – full or short SHA
 * @returns {string} absolute path to the repo (for docker build cwd)
 */
async function checkoutCommit(repoName, commitHash) {
  const repoPath = path.join(REPOS_DIR, repoName);
  const git = simpleGit(repoPath);
  await git.checkout(commitHash);
  console.log(`[git] Checked out ${commitHash.substring(0, 7)} in ${repoName}`);
  return repoPath;
}

module.exports = { cloneRepo, getCommits, checkoutCommit, getRepoName, REPOS_DIR };
