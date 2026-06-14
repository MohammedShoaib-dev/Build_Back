// dockerOps.js
// Provides two build strategies:
//   • MOCK_MODE=true  → streams realistic fake log lines (no Docker needed)
//   • MOCK_MODE=false → runs real `docker build` + `docker run -d -p` via child_process

const { spawn, execSync } = require('child_process');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

// Read once at startup — callers can also pass the flag explicitly
const MOCK_MODE = process.env.MOCK_MODE === 'true';

// ── Mock log templates ────────────────────────────────────────────────────────

// Realistic-looking logs for a PASSING build
const MOCK_SUCCESS_LOGS = [
  '[docker] Sending build context to Docker daemon  12.34kB',
  'Step 1/6 : FROM node:18-alpine',
  '18-alpine: Pulling from library/node',
  '  Digest: sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  '  Status: Image is up to date for node:18-alpine',
  ' ---> 3f4e5a6b7c8d',
  'Step 2/6 : WORKDIR /app',
  ' ---> Using cache',
  ' ---> 9d0e1f2a3b4c',
  'Step 3/6 : COPY package*.json ./',
  ' ---> 5c6d7e8f9a0b',
  'Step 4/6 : RUN npm ci --only=production',
  'npm warn deprecated inflight@1.0.6',
  'added 127 packages in 3.418s',
  '26 packages are looking for funding',
  ' ---> 1a2b3c4d5e6f',
  'Step 5/6 : COPY . .',
  ' ---> 7f8a9b0c1d2e',
  'Step 6/6 : CMD ["node", "index.js"]',
  ' ---> Running in 3e4f5a6b7c8d',
  'Removing intermediate container 3e4f5a6b7c8d',
  ' ---> 9b0c1d2e3f4a',
  '',
  'Successfully built 9b0c1d2e3f4a',
  'Successfully tagged buildback-run:latest',
  '',
  '─────────────────────────────────────────',
  '[docker] Starting detached container…',
  '─────────────────────────────────────────',
  '',
  '  App listening on port 3000',
  '  GET /health → 200 OK  (12ms)',
  '  GET /metrics → 200 OK  (8ms)',
  '',
  'Container started successfully ✓',
];

// Realistic-looking logs for a FAILING build (test suite breaks the image)
const MOCK_FAILURE_LOGS = [
  '[docker] Sending build context to Docker daemon  14.78kB',
  'Step 1/5 : FROM node:18-alpine',
  ' ---> 3f4e5a6b7c8d',
  'Step 2/5 : WORKDIR /app',
  ' ---> Using cache',
  'Step 3/5 : COPY package*.json ./',
  ' ---> a1b2c3d4e5f6',
  'Step 4/5 : RUN npm ci && npm test',
  'added 212 packages in 5.831s',
  '',
  '> project@1.0.0 test',
  '> jest --runInBand --coverage',
  '',
  'FAIL  src/__tests__/config.test.js',
  '  ● ConfigParser › should resolve env overrides',
  '',
  '    expect(received).toStrictEqual(expected)',
  '',
  '    - Expected  - 1',
  '    + Received  + 1',
  '',
  '    Object {',
  '  -   "env": "production",',
  '  +   "env": undefined,',
  '    }',
  '',
  '      at Object.<anonymous> (src/__tests__/config.test.js:42:5)',
  '',
  'Test Suites: 1 failed, 2 passed, 3 total',
  'Tests:       1 failed, 8 passed, 9 total',
  'Snapshots:   0 total',
  'Time:        3.417 s',
  '',
  'npm ERR! Test failed. See above for more details.',
  "The command '/bin/sh -c npm ci && npm test' returned a non-zero code: 1",
  '',
  'ERROR: Build failed — Docker exit code 1',
];

// ── Mock streaming ────────────────────────────────────────────────────────────

// Keywords in a commit message that indicate a deliberately broken build.
const FAIL_KEYWORDS = /\b(fix|bug|break|broke|broken|revert|error|fail|failed|bad|crash|hotfix|rollback|patch|debug)\b/i;

/**
 * Predict whether a given commit message will fail in mock mode.
 * @param {string} commitMessage
 * @returns {boolean}
 */
function willMockFail(commitMessage) {
  return FAIL_KEYWORDS.test(commitMessage || '');
}

// ── Port utilities ────────────────────────────────────────────────────────────

/**
 * Return the set of host ports already mapped by running Docker containers.
 * @returns {Set<number>}
 */
function getDockerUsedPorts() {
  const used = new Set();
  try {
    // docker ps --format "{{.Ports}}" outputs lines like:
    //   0.0.0.0:4001->3000/tcp, :::4001->3000/tcp
    const out = execSync('docker ps --format "{{.Ports}}"', { timeout: 5000 }).toString();
    for (const line of out.split('\n')) {
      // Match host-side port: digits before ->
      const matches = [...line.matchAll(/(?:0\.0\.0\.0:|:::)?(\d+)->/g)];
      for (const m of matches) used.add(Number(m[1]));
    }
  } catch (_) {
    // docker not available or no containers — silently continue
  }
  return used;
}

/**
 * Probe whether a TCP port is free on the local machine.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find the lowest free host port starting from `startPort`, skipping any
 * ports already mapped by Docker containers.
 * @param {number} [startPort=4000]
 * @returns {Promise<number>}
 */
async function findFreePort(startPort = 4000) {
  const dockerPorts = getDockerUsedPorts();
  let port = startPort;
  while (true) {
    if (!dockerPorts.has(port) && await isPortFree(port)) return port;
    port++;
    if (port > 65000) throw new Error('No free port found in range 4000–65000');
  }
}

// ── Dockerfile parser ─────────────────────────────────────────────────────────

/**
 * Parse the EXPOSE instruction from a Dockerfile in the given directory.
 * Returns the first numeric port found, or 80 as a default.
 * @param {string} repoPath – absolute path to the checked-out repo
 * @returns {number}
 */
function parseExposedPort(repoPath) {
  const dockerfilePath = path.join(repoPath, 'Dockerfile');
  try {
    const content = fs.readFileSync(dockerfilePath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.trim().match(/^EXPOSE\s+(\d+)/i);
      if (match) {
        const port = Number(match[1]);
        if (port > 0 && port < 65536) return port;
      }
    }
    console.log('[dockerOps] No EXPOSE found in Dockerfile — defaulting to port 80');
  } catch (err) {
    console.log(`[dockerOps] Could not read Dockerfile (${err.message}) — defaulting to port 80`);
  }
  return 80;
}

// ── Mock streaming ────────────────────────────────────────────────────────────

/**
 * Stream mock log lines with random delays to simulate a real build.
 * Pass/fail is determined by the commit MESSAGE (see FAIL_KEYWORDS above).
 *
 * onDone signature: (status, durationMs, fullLog, meta)
 * meta = { containerId, hostPort, containerPort }
 *
 * @param {string}   repoName      – used in mock containerId label
 * @param {string}   commitHash    – used for display / mock containerId
 * @param {string}   commitMessage – drives pass/fail decision
 * @param {string}   buildId       – used to form the mock containerId
 * @param {Function} onLog
 * @param {Function} onDone
 */
async function streamMockBuild(repoName, commitHash, commitMessage, buildId, onLog, onDone) {
  const willFail  = willMockFail(commitMessage);
  const lines     = willFail ? MOCK_FAILURE_LOGS : MOCK_SUCCESS_LOGS;
  const startTime = Date.now();

  for (const line of lines) {
    // Stagger output: 60–160 ms between lines
    await new Promise(r => setTimeout(r, 60 + Math.random() * 100));
    onLog(line);
  }

  const duration = Date.now() - startTime;
  const status   = willFail ? 'failed' : 'success';

  // Synthesise stable mock container metadata
  const mockPort        = await findFreePort(4200);
  const mockContainerId = `mock-${buildId.substring(0, 12)}`;
  const mockContainerPort = 3000;

  onDone(status, duration, lines.join('\n'), {
    containerId:   mockContainerId,
    hostPort:      status === 'success' ? mockPort : null,
    containerPort: mockContainerPort,
  });
}

// ── Real Docker streaming ─────────────────────────────────────────────────────

/**
 * Run `docker build` then `docker run -d -p <freePort>:<containerPort>`.
 * Streams every stdout/stderr line via onLog.
 * Calls onDone(status, durationMs, fullLog, { containerId, hostPort, containerPort }) when done.
 *
 * @param {string}   repoPath    – absolute path to the checked-out repo
 * @param {string}   commitHash  – used to tag the image and name the container
 * @param {Function} onLog
 * @param {Function} onDone
 */
function streamDockerBuild(repoPath, commitHash, onLog, onDone) {
  const startTime     = Date.now();
  let   fullLog       = '';
  const shortHash     = commitHash.substring(0, 7);
  const imageName     = `buildback-${shortHash}`.toLowerCase();
  const containerName = `buildback-cnt-${shortHash}`.toLowerCase();

  /** Append a line to the running log and emit it over SSE. */
  const log = line => { fullLog += line + '\n'; onLog(line); };

  /** Remove the temporary image (best-effort). */
  const cleanupImage = () => spawn('docker', ['rmi', '-f', imageName]);

  // ── Step 1: docker build ──────────────────────────────────────────────────
  log(`[docker] Building image ${imageName} …`);
  const buildProc = spawn('docker', ['build', '-t', imageName, '.'], { cwd: repoPath });

  buildProc.stdout.on('data', d => d.toString().split('\n').forEach(l => l && log(l)));
  buildProc.stderr.on('data', d => d.toString().split('\n').forEach(l => l && log(l)));

  buildProc.on('error', err => {
    log(`[error] Failed to start docker: ${err.message}`);
    log('Is Docker installed and running?');
    onDone('failed', Date.now() - startTime, fullLog, { containerId: null, hostPort: null, containerPort: null });
  });

  buildProc.on('close', async code => {
    if (code !== 0) {
      log(`\n[error] docker build exited with code ${code}`);
      onDone('failed', Date.now() - startTime, fullLog, { containerId: null, hostPort: null, containerPort: null });
      cleanupImage();
      return;
    }

    // ── Step 2: Read EXPOSE from Dockerfile ──────────────────────────────────
    const containerPort = parseExposedPort(repoPath);
    log(`\n[docker] Dockerfile EXPOSE: ${containerPort}`);

    // ── Step 3: Find a free host port ────────────────────────────────────────
    let hostPort;
    try {
      hostPort = await findFreePort(4000);
    } catch (err) {
      log(`[error] ${err.message}`);
      onDone('failed', Date.now() - startTime, fullLog, { containerId: null, hostPort: null, containerPort });
      cleanupImage();
      return;
    }
    log(`[docker] Binding host port ${hostPort} → container port ${containerPort}`);

    // ── Step 4: docker run -d -p <hostPort>:<containerPort> ──────────────────
    log('\n─────────────────────────────────────────');
    log(`[docker] Starting detached container (${containerName})…`);
    log('─────────────────────────────────────────\n');

    // Remove any old container with the same name (idempotent re-runs)
    try { execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' }); } catch (_) {}

    const runProc = spawn('docker', [
      'run', '-d',
      '--name', containerName,
      '-p', `${hostPort}:${containerPort}`,
      imageName,
    ]);

    let containerIdRaw = '';
    runProc.stdout.on('data', d => { containerIdRaw += d.toString(); });
    runProc.stderr.on('data', d => d.toString().split('\n').forEach(l => l && log(l)));

    runProc.on('error', err => {
      log(`[error] docker run failed: ${err.message}`);
      onDone('failed', Date.now() - startTime, fullLog, { containerId: null, hostPort: null, containerPort });
    });

    runProc.on('close', runCode => {
      const containerId = containerIdRaw.trim().substring(0, 12) || containerName;
      if (runCode !== 0) {
        log(`\nContainer failed to start (exit code ${runCode}) ✗`);
        onDone('failed', Date.now() - startTime, fullLog, { containerId: null, hostPort: null, containerPort });
        cleanupImage();
      } else {
        log(`\nContainer started: ${containerId}`);
        log(`Preview → http://localhost:${hostPort} ✓`);
        onDone('success', Date.now() - startTime, fullLog, { containerId, hostPort, containerPort });
      }
    });
  });
}

module.exports = {
  streamMockBuild,
  streamDockerBuild,
  willMockFail,
  MOCK_MODE,
  findFreePort,
  parseExposedPort,
};
