# BuildBack — Time Travel Debugger for GitHub Repos

> Clone any GitHub repository, step through its commit history, and trigger a Docker build against any snapshot — with real-time streaming logs, a persistent build history dashboard, and an immersive live Docker preview.

---

## 🚀 Key Features

*   **Universal Repo Support**: Paste *any* public GitHub URL, and BuildBack will clone it and extract its commit history.
*   **Time Travel Debugging**: Pick any commit from the history and hit "Build" to see exactly how the code behaved at that point in time.
*   **Live SSE Logs**: Watch build logs stream in real-time from the backend to the frontend using Server-Sent Events.
*   **Immersive Live Preview**: Once a build succeeds, BuildBack spawns an inline (and new tab) live preview. In `MOCK_MODE`, you get a beautifully simulated dashboard. In live Docker mode, you see your actual running container.
*   **Mock Mode**: Perfect for demos. Run the entire app without Docker installed. Mock mode intelligently simulates build successes/failures based on keywords (e.g., "fix", "bug", "crash") in the commit message.

---

## 📂 Folder Structure

```text
BuildBack/
├── backend/
│   ├── server.js        # Express API + SSE endpoint + Live Preview logic
│   ├── gitOps.js        # simple-git: clone / log / checkout
│   ├── dockerOps.js     # docker build + run (real & mock) + port allocation
│   ├── buildStore.js    # builds.json persistent storage logic
│   ├── builds.json      # auto-created on first run to store history
│   └── repos/           # cloned GitHub repositories land here
├── frontend/
│   ├── index.html       # single-page shell + dynamic UI
│   ├── style.css        # dark terminal aesthetic, responsive grids
│   └── app.js           # vanilla JS — UI logic, SSE handling, dynamic previews
├── demo-repo/
│   └── README.md        # instructions to create a demo GitHub repo
├── Jenkinsfile          # Jenkins pipeline definition
├── .env                 # PORT + MOCK_MODE toggle
├── package.json         # Node dependencies
└── README.md            ← you are here
```

---

## 🛠️ Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js     | ≥ 18    | `node --version` |
| npm         | ≥ 9     | bundled with Node |
| Git         | any     | must be on PATH |
| Docker      | any     | only if `MOCK_MODE=false` |

---

## 🚦 Step-by-Step Setup

### 1 — Clone this project and install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/BuildBack.git
cd BuildBack
npm install
```

### 2 — Configure the environment

Open `.env` and configure your instance:

```dotenv
PORT=3000

# true  → fake logs, simulated preview, no Docker required (great for demos)
# false → real docker build + docker run, exposes live container port
MOCK_MODE=true
```

### 3 — Start the server

```bash
npm start
# or, for auto-reload during development:
npm run dev
```

You should see:

```text
╔════════════════════════════════════════╗
║   🚀  BuildBack is live!               ║
║   http://localhost:3000                ║
║   MOCK_MODE : ON  (no Docker needed)   ║
╚════════════════════════════════════════╝
```

### 4 — Open the UI

Visit **http://localhost:3000** in your browser.

---

## 🌍 How to Get It to Work for ANY Repo

BuildBack is designed to work dynamically with any public repository.

1.  **Clone via UI**: Paste any valid GitHub HTTPS URL into the input box (e.g., `https://github.com/expressjs/express`).
2.  **Fetch Commits**: BuildBack automatically clones the repo into `backend/repos/<repo-name>` and extracts the last 50 commits.
3.  **Build**: Click **▶ Build** on any commit. BuildBack checks out that exact commit hash in the local clone and attempts to run a Docker build.
4.  **Auto-Preview**: On success, BuildBack will open a live preview.

*Tip: You can use the "cycle demo repos ↺" button in the UI to quickly test with popular open-source projects.*

---

## 🐳 How to Set Up the `Dockerfile`

For BuildBack to successfully build and run your repository in live mode (`MOCK_MODE=false`), the target repository **must contain a `Dockerfile` at its root**.

BuildBack dynamically inspects your `Dockerfile` to figure out which port to expose.

### Requirements for your target repo's `Dockerfile`:
1.  **Root Level**: The `Dockerfile` must be located at the root of the cloned repository.
2.  **EXPOSE Instruction**: You **must** include an `EXPOSE <port>` instruction. BuildBack parses this instruction to know which port your app uses inside the container, and maps it to a dynamically allocated free port on the host machine.
    *   *If no `EXPOSE` is found, BuildBack defaults to port `80`.*
3.  **Self-Contained**: The Dockerfile should install dependencies, build the app, and specify the `CMD` or `ENTRYPOINT` to start the server.

### Example `Dockerfile` for a Node.js App:

```dockerfile
# Use an official runtime as a parent image
FROM node:18-alpine

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# IMPORTANT: Tell BuildBack which port this container listens on!
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]
```

When you hit "Build", BuildBack runs:
1. `docker build -t buildback-<shortHash> .`
2. Finds a free host port (e.g., `4001`)
3. Reads `EXPOSE 3000` from your `Dockerfile`
4. `docker run -d -p 4001:3000 buildback-<shortHash>`

---

## 🤖 Jenkins Integration

1. Install Jenkins and the **Pipeline** + **Git** plugins.
2. Create a new **Pipeline** job.
3. Under *Pipeline* → set **Pipeline script from SCM** → **Git** → point to this repo.
4. Add a global environment variable `BUILDBACK_URL=http://localhost:3000` via:
   *Manage Jenkins → Configure System → Global properties → Environment variables*
5. Run the job — each build is automatically POSTed to `/api/record` and appears in the dashboard.

---

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/clone` | Clone or update a GitHub repo |
| GET | `/api/commits` | Return last 50 commits for `?repoName=` |
| GET | `/api/build/stream` | SSE build stream. Requires `repoName` and `commitHash` |
| GET | `/api/builds` | Return full build history from `builds.json` |
| GET | `/api/preview` | Renders the dynamic, commit-specific preview page |
| GET | `/api/container/logs` | Fetches real `docker logs` for a specific `?buildId=` |
| POST | `/api/container/stop` | Stops the running Docker container for a `buildId` |
| POST | `/api/rerun` | Look up a past build by ID for re-triggering |
| POST | `/api/record` | Record an external build result (called by Jenkins) |

---

## ⚠️ Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Invalid GitHub URL | Clone returns a clear error message in the UI |
| Repo already cloned | Pulls latest instead of re-cloning |
| Docker not installed | Error logged to SSE stream; build marked **FAILED** |
| `docker build` exits non-zero | Build marked **FAILED**; full stderr captured |
| `docker run` exits non-zero | Build marked **FAILED**; exit code logged |
| Client disconnects mid-stream | Build record updated to **FAILED** |
| `builds.json` missing | Auto-created as `[]` on first access |

---

## 💻 Tech Stack

- **Backend**: Node.js 18, Express 4, simple-git, uuid, dotenv
- **Frontend**: HTML5, Vanilla CSS, Vanilla JS (no frameworks, no bundlers)
- **Persistence**: Local `builds.json` flat file
- **Streaming**: Server-Sent Events (SSE)
- **CI**: Jenkinsfile (declarative pipeline)
- **Containerisation**: Docker (real mode) / mock logs & UI (demo mode)
