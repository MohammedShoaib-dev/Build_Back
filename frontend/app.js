// app.js
// BuildBack — Frontend Application Logic
// Vanilla JS only: no frameworks, no bundler.
// Handles clone, commit display, SSE build streaming, and history dashboard.

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
// Popular public repos offered as demo suggestions
const DEMO_REPOS = [
  'https://github.com/octocat/Hello-World',
  'https://github.com/expressjs/express',
  'https://github.com/axios/axios',
  'https://github.com/sindresorhus/got',
];

// ── State ─────────────────────────────────────────────────────────────────────
let currentRepoName       = null;   // name of the currently loaded repo
let activeEventSource     = null;   // current SSE connection (if any)
let activeBuildId         = null;   // buildId of the running build
let activeBuildHostPort   = null;   // host port for the active build's container
let activeBuildMockMode   = false;  // whether the active build is in mock mode
let activeBuildCommitAuthor = '';   // author of the commit being built
let activeBuildCommitDate   = '';   // date of the commit being built

// ── DOM references ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const repoUrlInput      = $('repo-url-input');
const cloneBtn          = $('clone-btn');
const cloneBtnText      = $('clone-btn-text');
const cloneSpinner      = $('clone-spinner');
const cloneStatus       = $('clone-status');
const commitsSection    = $('commits-section');
const repoNameChip      = $('repo-name-chip');
const commitCountChip   = $('commit-count-chip');
const commitsTbody      = $('commits-tbody');
const logsSection       = $('logs-section');
const activeStatusBadge = $('active-status-badge');
const buildMeta         = $('build-meta');
const metaCommit        = $('meta-commit');
const metaDuration      = $('meta-duration');
const metaMock          = $('meta-mock');
const terminalTitle     = $('terminal-title');
const logOutput         = $('log-output');
const historyContent    = $('history-content');
const refreshHistoryBtn = $('refresh-history-btn');
const modeBadge         = $('mode-badge');
const modeLabel         = $('mode-label');
const demoFillBtn       = $('demo-fill-btn');

// Preview panel refs
const previewSection    = $('preview-section');
const previewIframe     = $('preview-iframe');
const previewUrlText    = $('preview-url-text');
const previewOpenBtn    = $('preview-open-btn');
const previewCloseBtn   = $('preview-close-btn');
const previewReloadBtn  = $('preview-reload-btn');

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadBuildHistory();
  // Detect mock mode on startup even before any builds exist
  fetch('/api/mock-predict?commitMessage=')
    .then(r => r.json())
    .then(d => setModeBadge(d.mockMode))
    .catch(() => {});
});

// Cycle through demo repos on click
let _demoIdx = 0;
demoFillBtn.addEventListener('click', () => {
  repoUrlInput.value = DEMO_REPOS[_demoIdx % DEMO_REPOS.length];
  _demoIdx++;
  repoUrlInput.focus();
});

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Show a status message below the clone input. */
function setCloneStatus(type, message) {
  cloneStatus.textContent = message;
  cloneStatus.className   = `status-message ${type}`;
}

/** Format milliseconds into a human-readable duration string. */
function formatDuration(ms) {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** Relative time (e.g. "3 minutes ago"). */
function timeAgo(isoString) {
  const secs = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Apply basic colourisation to a raw log line (returns HTML string). */
function coloriseLine(line) {
  const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  if (/error|failed|fail|ERR!|non-zero/i.test(esc))  return `<span style="color:var(--red)">${esc}</span>`;
  if (/success|successfully|✓/i.test(esc))            return `<span style="color:var(--green-text)">${esc}</span>`;
  if (/warn|warning|deprecated/i.test(esc))           return `<span style="color:var(--yellow)">${esc}</span>`;
  if (/step \d+/i.test(esc))                          return `<span style="color:var(--blue)">${esc}</span>`;
  if (/^\s*-{3,}/.test(esc))                          return `<span style="color:var(--text-muted)">${esc}</span>`;
  if (/\[mock\]/i.test(esc))                          return `<span style="color:var(--purple)">${esc}</span>`;

  return esc;
}

/** Append a colourised line to the log viewer and auto-scroll. */
function appendLogLine(line) {
  if (!line && logOutput.innerHTML.endsWith('\n\n')) return; // collapse blanks
  logOutput.innerHTML += coloriseLine(line) + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
}

/** Update the mode badge in the header. */
function setModeBadge(isMock) {
  modeLabel.textContent = isMock ? 'MOCK MODE' : 'LIVE MODE';
  modeBadge.className   = `mode-badge ${isMock ? 'mock' : 'live'}`;
}

// ── Preview panel helpers ─────────────────────────────────────────────────────

/**
 * Load the deployed preview into the iframe and reveal the preview section.
 *
 * In live mode: points the iframe directly at http://localhost:<hostPort>
 * In mock mode: uses /api/preview?buildId=... (the simulated preview page)
 *
 * @param {string}  buildId  – the completed build's UUID
 * @param {number|null} hostPort  – the host port the container is bound to
 * @param {boolean} mockMode – whether this was a mock build
 */
function showPreview(buildId, hostPort, mockMode) {
  let previewUrl;
  if (mockMode || !hostPort) {
    // Mock mode or no port: use the simulated preview page
    previewUrl = `/api/preview?buildId=${encodeURIComponent(buildId)}`;
    previewUrlText.textContent = `localhost:3000/api/preview · ${buildId.substring(0, 8)}`;
  } else {
    // Live mode: point directly at the running container
    previewUrl = `http://localhost:${hostPort}`;
    previewUrlText.textContent = `localhost:${hostPort} · ${buildId.substring(0, 8)}`;
  }

  previewIframe.src = previewUrl;
  previewSection.classList.remove('hidden');

  // Store the current build's port on the close button for later
  previewCloseBtn.dataset.buildId = buildId;

  setTimeout(() => {
    previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 400);
}

/** Hide and reset the preview panel. */
function hidePreview() {
  previewSection.classList.add('hidden');
  previewIframe.src = 'about:blank';
  previewCloseBtn.dataset.buildId = '';
}

// Preview panel button listeners
previewCloseBtn.addEventListener('click', async () => {
  const buildId = previewCloseBtn.dataset.buildId;
  // Stop the container for this specific build
  if (buildId) {
    try {
      await fetch('/api/container/stop', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ buildId }),
      });
    } catch (_) { /* best-effort */ }
  }
  hidePreview();
  loadBuildHistory(); // refresh history so card shows 'stopped'
});

previewReloadBtn.addEventListener('click', () => {
  // Force iframe reload by toggling src
  const src = previewIframe.src;
  previewIframe.src = 'about:blank';
  requestAnimationFrame(() => { previewIframe.src = src; });
});
previewOpenBtn.addEventListener('click', () => {
  window.open(previewIframe.src, '_blank');
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CLONE
// ══════════════════════════════════════════════════════════════════════════════

cloneBtn.addEventListener('click', handleClone);
repoUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleClone(); });

async function handleClone() {
  const repoUrl = repoUrlInput.value.trim();
  if (!repoUrl) {
    setCloneStatus('error', '✗ Please enter a GitHub repo URL.');
    return;
  }

  // UI: loading state
  cloneBtn.disabled      = true;
  cloneBtnText.textContent = 'Cloning…';
  cloneSpinner.classList.remove('hidden');
  setCloneStatus('info', 'Connecting to GitHub and cloning repo…');

  try {
    const res  = await fetch('/api/clone', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ repoUrl }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Clone failed.');

    currentRepoName = data.repoName;
    setCloneStatus('success', `✓ ${data.alreadyExisted ? 'Updated' : 'Cloned'} "${data.repoName}" successfully.`);

    // Load and display commit history
    await loadCommits(data.repoName);

  } catch (err) {
    setCloneStatus('error', `✗ ${err.message}`);
  } finally {
    cloneBtn.disabled        = false;
    cloneBtnText.textContent = 'Clone';
    cloneSpinner.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — COMMIT HISTORY
// ══════════════════════════════════════════════════════════════════════════════

async function loadCommits(repoName) {
  try {
    const res  = await fetch(`/api/commits?repoName=${encodeURIComponent(repoName)}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    renderCommitsTable(data.commits);

    // Show and scroll to section
    commitsSection.classList.remove('hidden');
    commitsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    setCloneStatus('error', `✗ Failed to load commits: ${err.message}`);
  }
}

async function renderCommitsTable(commits) {
  repoNameChip.textContent    = currentRepoName;
  commitCountChip.textContent = `${commits.length} commits`;
  commitsTbody.innerHTML      = '';

  // Fetch mock predictions for all commits in parallel (fire-and-forget friendly)
  let predictions = {};
  try {
    const results = await Promise.all(
      commits.map(c =>
        fetch(`/api/mock-predict?commitMessage=${encodeURIComponent(c.message)}`)
          .then(r => r.json())
          .then(d => ({ hash: c.hash, willFail: d.willFail, mockMode: d.mockMode }))
      )
    );
    results.forEach(r => { predictions[r.hash] = r; });
  } catch (_) { /* predictions unavailable — degrade gracefully */ }

  commits.forEach(commit => {
    const tr = document.createElement('tr');
    const pred = predictions[commit.hash];

    // Build outcome preview chip (only show in mock mode)
    let predChip = '';
    if (pred && pred.mockMode) {
      predChip = pred.willFail
        ? `<span class="pred-chip pred-fail" title="Mock: commit message matches fail keywords">✗ will FAIL</span>`
        : `<span class="pred-chip pred-pass" title="Mock: no fail keywords in commit message">✓ will PASS</span>`;
    }

    tr.innerHTML = `
      <td class="hash-cell">${commit.shortHash}</td>
      <td class="msg-cell" title="${escHtml(commit.message)}">${escHtml(commit.message)}</td>
      <td class="author-cell">${escHtml(commit.author)}</td>
      <td class="date-cell">${formatDate(commit.date)}</td>
      <td class="action-cell">
        ${predChip}
        <button
          class="btn-build"
          id="build-btn-${commit.shortHash}"
          data-hash="${commit.hash}"
          data-short="${commit.shortHash}"
          data-msg="${escAttr(commit.message)}"
          data-author="${escAttr(commit.author)}"
          data-date="${escAttr(commit.date)}"
          aria-label="Build commit ${commit.shortHash}"
        >▶ Build</button>
      </td>
    `;

    commitsTbody.appendChild(tr);
  });

  // Add mock mode legend below the table
  const existingLegend = document.getElementById('mock-legend');
  if (existingLegend) existingLegend.remove();

  const firstPred = Object.values(predictions)[0];
  if (firstPred && firstPred.mockMode) {
    const legend = document.createElement('p');
    legend.id        = 'mock-legend';
    legend.className = 'mock-legend';
    legend.innerHTML = `
      <span class="legend-icon">ℹ</span>
      <strong>Mock mode:</strong> builds with <em>fix, bug, break, revert, error, crash, hotfix</em>
      or similar in the commit message will simulate a <span style="color:var(--red)">FAILED</span> build.
      All others will <span style="color:var(--green-text)">PASS</span>.
    `;
    document.getElementById('commits-section').appendChild(legend);
  }

  // Delegate click on any build button
  commitsTbody.addEventListener('click', e => {
    const btn = e.target.closest('.btn-build');
    if (btn) triggerBuild(btn.dataset.hash, btn.dataset.short, btn.dataset.msg, btn.dataset.author || '', btn.dataset.date || '');
  });
}

/** Escape HTML for safe innerHTML insertion. */
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(str) { return escHtml(str).replace(/\n/g,' '); }

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleString('en-GB', {
      day:'2-digit', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit',
    });
  } catch { return dateStr; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — LIVE BUILD (SSE)
// ══════════════════════════════════════════════════════════════════════════════

function triggerBuild(commitHash, shortHash, commitMessage, commitAuthor = '', commitDate = '') {
  // Abort any in-flight build
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  // Disable all build buttons while running
  document.querySelectorAll('.btn-build').forEach(b => { b.disabled = true; });

  // Prepare the logs panel
  logOutput.innerHTML         = '';
  terminalTitle.textContent   = `build · ${shortHash}`;
  metaCommit.innerHTML        = `Commit: <span>${shortHash}</span> — ${escHtml(commitMessage).substring(0, 60)}`;
  metaDuration.innerHTML      = `Duration: <span>running…</span>`;
  metaMock.innerHTML          = '';

  activeStatusBadge.className = 'status-badge status-running';
  activeStatusBadge.innerHTML = '<span class="pulse-dot"></span> RUNNING';

  logsSection.classList.remove('hidden');
  logsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Store author/date for preview
  activeBuildCommitAuthor = commitAuthor;
  activeBuildCommitDate   = commitDate;

  // Open SSE stream
  const params = new URLSearchParams({
    repoName:      currentRepoName,
    commitHash,
    commitMessage: commitMessage || '',
    commitAuthor:  commitAuthor  || '',
    commitDate:    commitDate    || '',
  });

  const url = `/api/build/stream?${params}`;
  const es  = new EventSource(url);
  activeEventSource = es;

  // ── init event: server sends buildId ──────────────────────────────────────
  es.addEventListener('init', e => {
    const { buildId, mockMode } = JSON.parse(e.data);
    activeBuildId       = buildId;
    activeBuildMockMode = mockMode;
    setModeBadge(mockMode);
    metaMock.innerHTML = `Mode: <span>${mockMode ? 'Mock' : 'Live Docker'}</span>`;
  });

  // ── log event: one line of output ─────────────────────────────────────────
  es.addEventListener('log', e => {
    const { line } = JSON.parse(e.data);
    appendLogLine(line);
  });

  // ── done event: build finished ────────────────────────────────────────────
  es.addEventListener('done', e => {
    const { status, duration, hostPort, containerPort } = JSON.parse(e.data);

    es.close();
    activeEventSource = null;

    // Track host port for this build's preview
    activeBuildHostPort = hostPort || null;

    // Re-enable build buttons
    document.querySelectorAll('.btn-build').forEach(b => { b.disabled = false; });

    // Update status badge
    if (status === 'success') {
      activeStatusBadge.className = 'status-badge status-success';
      activeStatusBadge.innerHTML = '✓ SUCCESS';
    } else {
      activeStatusBadge.className = 'status-badge status-failed';
      activeStatusBadge.innerHTML = '✗ FAILED';
    }

    metaDuration.innerHTML = `Duration: <span>${formatDuration(duration)}</span>`;

    // Show port info in meta bar if a real container was started
    if (hostPort && containerPort) {
      if (!buildMeta.querySelector('.port-meta')) {
        const portSpan = document.createElement('span');
        portSpan.className = 'port-meta';
        portSpan.innerHTML = ` &nbsp;·&nbsp; Port: <span>:${hostPort}</span>`;
        buildMeta.appendChild(portSpan);
      }
    }

    appendLogLine(`\n── Build ${status.toUpperCase()} in ${formatDuration(duration)} ──`);

    // Show preview on success; hide it on failure
    if (status === 'success' && activeBuildId) {
      const previewUrl = (activeBuildMockMode || !activeBuildHostPort)
        ? `/api/preview?buildId=${encodeURIComponent(activeBuildId)}`
        : `http://localhost:${activeBuildHostPort}`;

      // Show inline iframe preview
      showPreview(activeBuildId, activeBuildHostPort, activeBuildMockMode);

      // Append a clickable "open in new tab" notice in the log (browsers block
      // window.open called from async SSE callbacks — user must click instead)
      const notice = document.createElement('a');
      notice.href   = previewUrl;
      notice.target = '_blank';
      notice.rel    = 'noopener noreferrer';
      notice.style.cssText = 'color:var(--green);text-decoration:underline;cursor:pointer;';
      notice.textContent   = `\n↗ Open preview in new tab → ${previewUrl}`;
      logOutput.appendChild(notice);
      logOutput.scrollTop = logOutput.scrollHeight;
    } else {
      hidePreview();
    }

    // Refresh the dashboard
    loadBuildHistory();
  });

  // ── SSE connection error ──────────────────────────────────────────────────
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return; // normal close
    appendLogLine('\n[error] Lost connection to server.');
    es.close();
    activeEventSource = null;
    activeStatusBadge.className = 'status-badge status-failed';
    activeStatusBadge.innerHTML = '✗ CONNECTION ERROR';
    document.querySelectorAll('.btn-build').forEach(b => { b.disabled = false; });
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — BUILD HISTORY DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

refreshHistoryBtn.addEventListener('click', loadBuildHistory);

async function loadBuildHistory() {
  try {
    const res  = await fetch('/api/builds');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderBuildHistory(data.builds);

    // Auto-detect mode from latest build
    if (data.builds.length > 0) {
      setModeBadge(data.builds[0].mockMode);
    }
  } catch (err) {
    historyContent.innerHTML = `<p class="empty-state">Could not load build history: ${escHtml(err.message)}</p>`;
  }
}

function renderBuildHistory(builds) {
  if (builds.length === 0) {
    historyContent.innerHTML = '<p class="empty-state">No builds yet — clone a repo and trigger your first build.</p>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'builds-grid';

  builds.forEach(build => {
    const card = document.createElement('div');
    card.className = `build-card card-${build.status}`;
    card.dataset.buildId = build.id;

    const badgeClass = `status-${build.status}`;
    const badgeText  = build.status === 'running'
      ? '<span class="pulse-dot"></span> RUNNING'
      : build.status === 'success' ? '✓ SUCCESS'
      : build.status === 'stopped' ? '⏹ STOPPED'
      : '✗ FAILED';

    const source = build.source === 'jenkins' ? ' · jenkins' : '';
    const mock   = build.mockMode ? ' · mock' : '';
    const portInfo = (build.hostPort && build.status !== 'stopped')
      ? ` · :${build.hostPort}`
      : '';

    // Preview button — shown for successful builds that have a port stored
    const canPreview = build.status === 'success' && build.hostPort;
    const previewBtnHtml = canPreview
      ? `<button class="btn-preview" data-build-id="${build.id}" data-host-port="${build.hostPort}" data-mock="${build.mockMode}" aria-label="Open preview">▶ Preview</button>`
      : '';

    card.innerHTML = `
      <div class="build-card-status">
        <span class="status-badge ${badgeClass}">${badgeText}</span>
      </div>

      <div class="build-card-info">
        <div class="build-card-repo">${escHtml(build.repoName)}${source}</div>
        <div class="build-card-msg" title="${escAttr(build.commitMessage)}">
          ${escHtml(build.commitMessage).substring(0, 80)}
        </div>
        <div class="build-card-meta">
          ${build.commitHash.substring(0,7)}
          · ${formatDuration(build.duration || 0)}
          · ${timeAgo(build.timestamp)}${mock}${portInfo}
        </div>
      </div>

      <div class="build-card-actions">
        ${build.log ? `<button class="btn-log-toggle" data-build-id="${build.id}" aria-label="Toggle log">Logs</button>` : ''}
        ${previewBtnHtml}
        <button class="btn-rerun" data-build-id="${build.id}" aria-label="Re-run build">↻ Re-run</button>
      </div>
    `;

    grid.appendChild(card);
  });

  historyContent.innerHTML = '';
  historyContent.appendChild(grid);

  // ── Event delegation for card buttons ────────────────────────────────────
  grid.addEventListener('click', async e => {

    // Log toggle
    const logBtn = e.target.closest('.btn-log-toggle');
    if (logBtn) {
      const bid  = logBtn.dataset.buildId;
      const card = logBtn.closest('.build-card');
      let   exp  = card.querySelector('.build-log-expander');

      if (exp) {
        exp.remove();
      } else {
        const build = builds.find(b => b.id === bid);
        if (build && build.log) {
          exp = document.createElement('pre');
          exp.className = 'build-log-expander';
          exp.textContent = build.log;
          card.appendChild(exp);
          exp.scrollTop = exp.scrollHeight;
        }
      }
      return;
    }

    // Preview button — open the specific build's container port in the iframe
    const previewBtn = e.target.closest('.btn-preview');
    if (previewBtn) {
      const bid      = previewBtn.dataset.buildId;
      const hostPort = Number(previewBtn.dataset.hostPort) || null;
      const mockMode = previewBtn.dataset.mock === 'true';
      activeBuildId       = bid;
      activeBuildHostPort = hostPort;
      activeBuildMockMode = mockMode;
      showPreview(bid, hostPort, mockMode);
      return;
    }

    // Re-run
    const rerunBtn = e.target.closest('.btn-rerun');
    if (rerunBtn) {
      rerunBtn.disabled    = true;
      rerunBtn.textContent = '…';

      try {
        const res  = await fetch('/api/rerun', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ buildId: rerunBtn.dataset.buildId }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Re-run failed.');

        // Set currentRepoName from the build record so triggerBuild works
        currentRepoName = data.repoName;

        triggerBuild(data.commitHash, data.commitHash.substring(0, 7), data.commitMessage, data.commitAuthor || '', data.commitDate || '');

      } catch (err) {
        alert(`Re-run failed: ${err.message}`);
      } finally {
        rerunBtn.disabled    = false;
        rerunBtn.textContent = '↻ Re-run';
      }
    }
  });
}
