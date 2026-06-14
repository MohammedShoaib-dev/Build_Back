// server.js — BuildBack Express API Server
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const { cloneRepo, getCommits, checkoutCommit } = require('./gitOps');
const { streamMockBuild, streamDockerBuild, willMockFail, MOCK_MODE } = require('./dockerOps');
const { getBuilds, saveBuild, updateBuild, getBuildById } = require('./buildStore');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── POST /api/clone ───────────────────────────────────────────────────────────
app.post('/api/clone', async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });
  try {
    const result = await cloneRepo(repoUrl);
    res.json({ success: true, repoName: result.repoName, alreadyExisted: result.alreadyExisted });
  } catch (err) {
    res.status(500).json({ error: `Clone failed: ${err.message}` });
  }
});

// ── GET /api/commits ──────────────────────────────────────────────────────────
app.get('/api/commits', async (req, res) => {
  const { repoName } = req.query;
  if (!repoName) return res.status(400).json({ error: 'repoName is required' });
  try {
    const commits = await getCommits(repoName);
    res.json({ success: true, commits });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch commits: ${err.message}` });
  }
});

// ── GET /api/build/stream (SSE) ───────────────────────────────────────────────
app.get('/api/build/stream', async (req, res) => {
  const {
    repoName, commitHash,
    commitMessage  = 'Unknown commit',
    commitAuthor   = 'Unknown',
    commitDate     = '',
  } = req.query;

  if (!repoName || !commitHash)
    return res.status(400).json({ error: 'repoName and commitHash are required' });

  const buildId = uuidv4();
  saveBuild({
    id: buildId, repoName, commitHash, commitMessage,
    commitAuthor, commitDate,
    status: 'running', log: '', duration: 0,
    timestamp: new Date().toISOString(),
    mockMode: MOCK_MODE, containerId: null, hostPort: null, containerPort: null,
  });

  res.writeHead(200, {
    'Content-Type':                'text/event-stream',
    'Cache-Control':               'no-cache',
    'Connection':                  'keep-alive',
    'X-Accel-Buffering':           'no',
    'Access-Control-Allow-Origin': '*',
  });

  const emit = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  emit('init', { buildId, mockMode: MOCK_MODE });

  const onLog  = line => emit('log', { line });
  const onDone = (status, duration, fullLog, meta = {}) => {
    const { containerId = null, hostPort = null, containerPort = null } = meta;
    updateBuild(buildId, { status, duration, log: fullLog, containerId, hostPort, containerPort });
    emit('done', { buildId, status, duration, containerId, hostPort, containerPort });
    res.end();
  };

  try {
    if (MOCK_MODE) {
      emit('log', { line: `[mock] MOCK_MODE enabled — skipping real Docker build` });
      emit('log', { line: `[mock] Simulating build for commit ${commitHash.substring(0, 7)}…\n` });
      await streamMockBuild(repoName, commitHash, commitMessage, buildId, onLog, onDone);
    } else {
      emit('log', { line: `Checking out commit ${commitHash.substring(0, 7)}…` });
      const repoPath = await checkoutCommit(repoName, commitHash);
      emit('log', { line: `Checkout complete.\n` });
      streamDockerBuild(repoPath, commitHash, onLog, onDone);
    }
  } catch (err) {
    emit('log', { line: `\nFATAL: ${err.message}` });
    updateBuild(buildId, { status: 'failed', log: err.message, duration: 0 });
    emit('done', { buildId, status: 'failed', duration: 0 });
    res.end();
  }

  req.on('close', () => {
    const build = getBuildById(buildId);
    if (build && build.status === 'running')
      updateBuild(buildId, { status: 'failed', log: 'Client disconnected.' });
  });
});

// ── GET /api/builds ───────────────────────────────────────────────────────────
app.get('/api/builds', (req, res) => {
  try { res.json({ success: true, builds: getBuilds() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/preview ─────────────────────────────────────────────────────────
app.get('/api/preview', (req, res) => {
  const { buildId } = req.query;
  const build = buildId ? getBuildById(buildId) : null;

  const repoName    = build?.repoName      || 'unknown-repo';
  const shortHash   = (build?.commitHash   || '0000000').substring(0, 7);
  const commitMsg   = (build?.commitMessage || 'latest commit').substring(0, 72);
  const authorStr   = build?.commitAuthor  || 'unknown';
  const dateStr     = build?.commitDate    ? new Date(build.commitDate).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
  const duration    = build?.duration      || 0;
  const isMock      = build?.mockMode      ?? true;
  const hostPort    = build?.hostPort      || null;
  const containerPort = build?.containerPort || 3000;
  const builtAgo    = build?.timestamp     ? (() => {
    const s = Math.floor((Date.now() - new Date(build.timestamp)) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    return `${Math.floor(s/3600)}h ago`;
  })() : '—';

  // Extract meaningful stdout lines from the full build log
  const fullLog = build?.log || '';
  const logLines = fullLog.split('\n')
    .filter(l => l.trim() && !l.startsWith('[docker]') && !l.startsWith('─') && !l.startsWith('[mock]'))
    .slice(-14)
    .join('\n') || '  App listening on port 3000\n  GET /health → 200 OK  (12ms)\n  GET /metrics → 200 OK  (8ms)';

  const escHtml = s => String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const liveContainerBtn = hostPort
    ? `<a class="live-btn" href="http://localhost:${hostPort}" target="_blank">↗ Open Live Container :${hostPort}</a>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${escHtml(repoName)} @ ${shortHash} — BuildBack</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:#070b11;color:#e6edf3;font-family:'Inter',sans-serif;font-size:13px;display:flex;flex-direction:column;min-height:100vh}
  .mono{font-family:'JetBrains Mono',monospace}

  /* ── Top nav ── */
  nav{display:flex;align-items:center;gap:10px;padding:10px 20px;background:#0d1117;border-bottom:1px solid #21262d;flex-shrink:0;flex-wrap:wrap}
  .nav-logo{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:#e6edf3}
  .nav-logo span{color:#00ff88;filter:drop-shadow(0 0 5px #00ff88)}
  .nav-sep{color:#484f58}
  .nav-repo{font-family:'JetBrains Mono',monospace;font-size:13px;color:#58a6ff}
  .nav-hash{font-family:'JetBrains Mono',monospace;font-size:12px;color:#bc8cff;background:#bc8cff15;padding:2px 7px;border-radius:4px;border:1px solid #bc8cff40}
  .nav-right{margin-left:auto;display:flex;gap:8px;align-items:center}
  .badge{padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:.5px;border:1px solid transparent}
  .badge-live{background:#00ff8820;border-color:#00ff88;color:#39d353}
  .badge-mock{background:#f0c04a18;border-color:#f0c04a;color:#f0c04a}
  .badge-run{background:#58a6ff18;border-color:#58a6ff;color:#58a6ff;display:flex;align-items:center;gap:5px}
  .pulse{width:7px;height:7px;border-radius:50%;background:currentColor;animation:pr 1.2s ease-in-out infinite}
  @keyframes pr{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:.6}}

  /* ── Commit banner ── */
  .commit-banner{padding:20px;background:linear-gradient(135deg,#0d1117 0%,#131923 100%);border-bottom:1px solid #21262d}
  .commit-hash-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .commit-hash-big{font-family:'JetBrains Mono',monospace;font-size:24px;font-weight:700;color:#bc8cff;letter-spacing:1px;filter:drop-shadow(0 0 8px #bc8cff60)}
  .commit-msg-text{font-size:15px;font-weight:600;color:#e6edf3;margin-bottom:8px;line-height:1.4}
  .commit-meta-row{display:flex;gap:16px;flex-wrap:wrap}
  .commit-meta-item{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b949e;display:flex;align-items:center;gap:5px}
  .commit-meta-item .val{color:#c9d1d9}

  /* ── Metrics grid ── */
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:16px 20px;background:#0d1117;border-bottom:1px solid #21262d}
  @media(max-width:600px){.metrics{grid-template-columns:repeat(2,1fr)}}
  .metric{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;transition:border-color .2s}
  .metric:hover{border-color:#30363d}
  .metric-label{font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
  .metric-value{font-family:'JetBrains Mono',monospace;font-size:17px;font-weight:700;color:#e6edf3}
  .metric-value.green{color:#39d353}.metric-value.blue{color:#58a6ff}.metric-value.purple{color:#bc8cff}

  /* ── Panels ── */
  .body-grid{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:0;overflow:hidden}
  @media(max-width:700px){.body-grid{grid-template-columns:1fr}}
  .panel{border-right:1px solid #21262d;display:flex;flex-direction:column;overflow:hidden}
  .panel:last-child{border-right:none}
  .panel-hdr{padding:8px 16px;background:#161b22;border-bottom:1px solid #21262d;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:#8b949e;flex-shrink:0}
  .stdout-box{flex:1;padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.7;color:#8b949e;overflow-y:auto;white-space:pre-wrap;background:#070b11}
  .stdout-box .ok{color:#39d353}.stdout-box .warn{color:#f0c04a}.stdout-box .err{color:#ff4d6d}
  .cursor{display:inline-block;width:7px;height:13px;background:#00ff88;vertical-align:middle;animation:blink .9s step-end infinite;margin-left:2px}
  @keyframes blink{50%{opacity:0}}

  /* Endpoint table */
  .ep-table{width:100%;border-collapse:collapse}
  .ep-table td{padding:9px 16px;border-bottom:1px solid #21262d;font-family:'JetBrains Mono',monospace;font-size:12px}
  .ep-table tr:last-child td{border-bottom:none}
  .ep-table .method{color:#bc8cff;width:45px}.ep-table .ep-path{color:#e6edf3}
  .ep-table .ep-status{color:#39d353;text-align:right}.ep-table .latency{color:#8b949e;text-align:right;width:60px}

  /* Gauge */
  .gauge-section{padding:14px 16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}
  .gauge-label{font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b949e;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
  .gauge-bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden}
  .gauge-fill{height:100%;border-radius:3px;transition:width 1s ease}
  .gauge-val{font-family:'JetBrains Mono',monospace;font-size:11px;color:#e6edf3;margin-top:4px}

  /* ── Footer ── */
  footer{padding:10px 20px;border-top:1px solid #21262d;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;background:#0d1117;flex-shrink:0}
  .footer-meta{font-family:'JetBrains Mono',monospace;font-size:10px;color:#484f58}
  .live-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:#00ff8818;border:1px solid #00ff88;color:#39d353;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;text-decoration:none;transition:all .2s}
  .live-btn:hover{background:#00ff8830;box-shadow:0 0 12px #00ff8840}
</style>
</head>
<body>

<nav>
  <span class="nav-logo">◈ Build<span>Back</span></span>
  <span class="nav-sep">›</span>
  <span class="nav-repo">${escHtml(repoName)}</span>
  <span class="nav-sep">@</span>
  <code class="nav-hash">${shortHash}</code>
  <div class="nav-right">
    <span class="badge ${isMock ? 'badge-mock' : 'badge-live'}">${isMock ? '⚡ MOCK' : '🐳 LIVE DOCKER'}</span>
    <span class="badge badge-run"><span class="pulse"></span> RUNNING</span>
  </div>
</nav>

<div class="commit-banner">
  <div class="commit-hash-row">
    <div class="commit-hash-big mono">${shortHash}</div>
  </div>
  <div class="commit-msg-text">"${escHtml(commitMsg)}"</div>
  <div class="commit-meta-row">
    <div class="commit-meta-item">👤 <span class="val">${escHtml(authorStr)}</span></div>
    <div class="commit-meta-item">🗓 <span class="val">${dateStr}</span></div>
    <div class="commit-meta-item">⏱ built in <span class="val">${(duration/1000).toFixed(1)}s</span></div>
    <div class="commit-meta-item">🕐 <span class="val">${builtAgo}</span></div>
    ${hostPort ? `<div class="commit-meta-item">🔌 port <span class="val">:${hostPort}</span></div>` : ''}
  </div>
</div>

<div class="metrics">
  <div class="metric">
    <div class="metric-label">Status</div>
    <div class="metric-value green">RUNNING</div>
  </div>
  <div class="metric">
    <div class="metric-label">Uptime</div>
    <div class="metric-value mono" id="uptime">00:00:00</div>
  </div>
  <div class="metric">
    <div class="metric-label">CPU</div>
    <div class="metric-value blue mono" id="cpu-val">2.3%</div>
  </div>
  <div class="metric">
    <div class="metric-label">Memory</div>
    <div class="metric-value purple mono">48.2 MB</div>
  </div>
</div>

<div class="body-grid">
  <div class="panel">
    <div class="panel-hdr">stdout — container output</div>
    <div class="stdout-box" id="stdout-box">${escHtml(logLines)}<span class="cursor"></span></div>
  </div>
  <div class="panel" style="border-right:none;display:flex;flex-direction:column">
    <div class="panel-hdr">health endpoints</div>
    <table class="ep-table">
      <tr><td class="method">GET</td><td class="ep-path">/health</td><td class="ep-status">200 OK</td><td class="latency">12ms</td></tr>
      <tr><td class="method">GET</td><td class="ep-path">/metrics</td><td class="ep-status">200 OK</td><td class="latency">8ms</td></tr>
      <tr><td class="method">GET</td><td class="ep-path">/</td><td class="ep-status">200 OK</td><td class="latency">24ms</td></tr>
      <tr><td class="method">POST</td><td class="ep-path">/api/data</td><td class="ep-status">201 Created</td><td class="latency">37ms</td></tr>
    </table>
    <div class="panel-hdr" style="margin-top:auto">resource usage</div>
    <div class="gauge-section">
      <div>
        <div class="gauge-label">CPU</div>
        <div class="gauge-bar"><div class="gauge-fill" id="cpu-bar" style="width:2.3%;background:#58a6ff"></div></div>
        <div class="gauge-val" id="cpu-txt">2.3%</div>
      </div>
      <div>
        <div class="gauge-label">Memory</div>
        <div class="gauge-bar"><div class="gauge-fill" style="width:18.8%;background:#bc8cff"></div></div>
        <div class="gauge-val">48.2 MB / 256 MB</div>
      </div>
      <div>
        <div class="gauge-label">Network I/O</div>
        <div class="gauge-bar"><div class="gauge-fill" style="width:5%;background:#39d353"></div></div>
        <div class="gauge-val">1.2 MB/s</div>
      </div>
    </div>
  </div>
</div>

<footer>
  <span class="footer-meta">BuildBack snapshot · ${escHtml(repoName)} @ ${shortHash} · ${isMock ? 'mock container' : `container :${containerPort}`} · built ${builtAgo}</span>
  ${liveContainerBtn}
</footer>

<script>
  let secs = 0;
  setInterval(() => {
    secs++;
    const h = String(Math.floor(secs/3600)).padStart(2,'0');
    const m = String(Math.floor((secs%3600)/60)).padStart(2,'0');
    const s = String(secs%60).padStart(2,'0');
    document.getElementById('uptime').textContent = h+':'+m+':'+s;
  }, 1000);

  setInterval(() => {
    const v = (1.5 + Math.random() * 3.2).toFixed(1);
    document.getElementById('cpu-val').textContent = v+'%';
    document.getElementById('cpu-bar').style.width = v+'%';
    document.getElementById('cpu-txt').textContent = v+'%';
  }, 2200);

  // Typewriter effect for new stdout lines
  const box = document.getElementById('stdout-box');
  const extras = [
    '  GET /api/data → 201 Created  (37ms)',
    '  GET /health → 200 OK  (9ms)',
    '  POST /api/auth → 200 OK  (54ms)',
    '  GET /metrics → 200 OK  (7ms)',
  ];
  let ei = 0;
  setInterval(() => {
    const cursor = box.querySelector('.cursor');
    const line = document.createElement('span');
    line.className = 'ok';
    line.textContent = '\\n' + extras[ei % extras.length];
    box.insertBefore(line, cursor);
    box.scrollTop = box.scrollHeight;
    ei++;
  }, 4000);
</script>
</body>
</html>`;

  res.send(html);
});

// ── GET /api/container/logs ───────────────────────────────────────────────────
app.get('/api/container/logs', (req, res) => {
  const { buildId } = req.query;
  if (!buildId) return res.status(400).json({ error: 'buildId is required' });

  const build = getBuildById(buildId);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const { containerId, mockMode } = build;

  // Mock or no real container — return last lines from stored log
  if (mockMode || !containerId || containerId.startsWith('mock-')) {
    const lines = (build.log || '').split('\n').slice(-20).join('\n');
    return res.json({ success: true, logs: lines, source: 'stored' });
  }

  try {
    const out = execSync(`docker logs --tail 30 ${containerId}`, {
      timeout: 5000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
    });
    res.json({ success: true, logs: out, source: 'docker' });
  } catch (err) {
    const out = err.stdout || err.stderr || err.message;
    res.json({ success: true, logs: out, source: 'docker-error' });
  }
});

// ── GET /api/mock-predict ─────────────────────────────────────────────────────
app.get('/api/mock-predict', (req, res) => {
  const { commitMessage = '' } = req.query;
  res.json({ mockMode: MOCK_MODE, willFail: willMockFail(commitMessage) });
});

// ── POST /api/container/stop ──────────────────────────────────────────────────
app.post('/api/container/stop', (req, res) => {
  const { buildId } = req.body;
  if (!buildId) return res.status(400).json({ error: 'buildId is required' });

  const build = getBuildById(buildId);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const { containerId, mockMode } = build;

  if (mockMode || !containerId || containerId.startsWith('mock-')) {
    updateBuild(buildId, { status: 'stopped' });
    return res.json({ success: true, buildId, containerId, mock: true });
  }

  const stopProc = require('child_process').spawn('docker', ['stop', containerId]);
  let stderr = '';
  stopProc.stderr.on('data', d => { stderr += d.toString(); });
  stopProc.on('close', () => {
    updateBuild(buildId, { status: 'stopped' });
    res.json({ success: true, buildId, containerId });
  });
  stopProc.on('error', err => {
    updateBuild(buildId, { status: 'stopped' });
    res.json({ success: true, buildId, containerId, warning: err.message });
  });
});

// ── POST /api/rerun ───────────────────────────────────────────────────────────
app.post('/api/rerun', (req, res) => {
  const { buildId } = req.body;
  if (!buildId) return res.status(400).json({ error: 'buildId is required' });

  const build = getBuildById(buildId);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  res.json({
    success:       true,
    repoName:      build.repoName,
    commitHash:    build.commitHash,
    commitMessage: build.commitMessage,
    commitAuthor:  build.commitAuthor || '',
    commitDate:    build.commitDate   || '',
  });
});

// ── POST /api/record (Jenkins) ────────────────────────────────────────────────
app.post('/api/record', (req, res) => {
  const { repoName, commitHash, commitMessage, status, log, duration } = req.body;
  if (!repoName || !commitHash || !status)
    return res.status(400).json({ error: 'repoName, commitHash, and status are required' });

  const record = saveBuild({
    id: uuidv4(), repoName, commitHash,
    commitMessage: commitMessage || 'Jenkins build',
    status: status || 'unknown', log: log || '', duration: duration || 0,
    timestamp: new Date().toISOString(), mockMode: false, source: 'jenkins',
  });
  res.json({ success: true, build: record });
});

// ── Catch-all SPA ─────────────────────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'))
);

app.use((err, req, res, _next) => {
  console.error('[UNHANDLED]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🚀  BuildBack is live!               ║');
  console.log(`║   http://localhost:${PORT}               ║`);
  console.log(`║   MOCK_MODE : ${MOCK_MODE ? 'ON  (no Docker needed)' : 'OFF (Docker required)'}   ║`);
  console.log('╚════════════════════════════════════════╝\n');
});
