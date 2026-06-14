# demo-repo

This folder represents a **standalone GitHub repository** you push separately to serve as the demo target for BuildBack.

## What to push to GitHub

Create a new GitHub repo (e.g. `buildback-demo`) and push **two commits**:

---

### Commit 1 — PASSING build

File: `Dockerfile`

```dockerfile
# Passing Dockerfile — exits 0, BuildBack marks this as SUCCESS
FROM node:18-alpine

WORKDIR /app

# Write a tiny inline script — no npm install needed
RUN echo 'console.log("BuildBack demo: build PASSED ✓");' > index.js

CMD ["node", "index.js"]
```

Commit message: `feat: initial working implementation`

---

### Commit 2 — FAILING build

Amend the Dockerfile to this (introduces a deliberate failure):

```dockerfile
# Failing Dockerfile — RUN exits 1, BuildBack marks this as FAILED
FROM node:18-alpine

WORKDIR /app

# Simulate a failing test / bad install step
RUN echo "Running tests..." && exit 1

CMD ["node", "-e", "console.log('unreachable')"]
```

Commit message: `fix: attempt config patch (breaks tests)`

---

## Quick setup commands

```bash
mkdir buildback-demo && cd buildback-demo
git init

# --- Commit 1: passing ---
cat > Dockerfile << 'EOF'
FROM node:18-alpine
WORKDIR /app
RUN echo 'console.log("BuildBack demo: build PASSED ✓");' > index.js
CMD ["node", "index.js"]
EOF

git add . && git commit -m "feat: initial working implementation"

# --- Commit 2: failing ---
cat > Dockerfile << 'EOF'
FROM node:18-alpine
WORKDIR /app
RUN echo "Running tests..." && exit 1
CMD ["node", "-e", "console.log('unreachable')"]
EOF

git add . && git commit -m "fix: attempt config patch (breaks tests)"

# Push to GitHub (replace with your actual remote)
git remote add origin https://github.com/YOUR_USERNAME/buildback-demo.git
git push -u origin main
```

Then in BuildBack, paste:
```
https://github.com/YOUR_USERNAME/buildback-demo
```

- **Commit 1** (`feat: initial working…`) → SUCCESS (even hash tail → mock: success)
- **Commit 2** (`fix: attempt config…`)   → FAILED  (odd hash tail → mock: failed, Docker: exit 1)
