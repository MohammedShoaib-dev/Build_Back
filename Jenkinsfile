// Jenkinsfile — BuildBack CI Pipeline
// ─────────────────────────────────────────────────────────────────────────────
// Stages:
//   1. Checkout        — pull this repo from SCM, capture commit metadata
//   2. Install Deps    — npm ci (skipped if node_modules already fresh)
//   3. Docker Build    — build the Docker image from the checked-out commit
//   4. Docker Run      — smoke-test: start container, wait, check it's alive
//   5. Notify Backend  — POST result to BuildBack /api/record endpoint
//
// Prerequisites on the Jenkins agent:
//   • Docker available on PATH
//   • curl available on PATH
//   • Node.js 18+ available on PATH
//   • BuildBack backend running at BUILDBACK_URL (default: http://localhost:3000)
//
// Usage:
//   1. Create a new Jenkins Pipeline job.
//   2. Set "Pipeline script from SCM" → point to this repo.
//   3. Optionally set BUILDBACK_URL in Jenkins → Manage Jenkins →
//      Configure System → Global properties → Environment variables.
//   4. Run the job — each build is recorded in the BuildBack dashboard.
// ─────────────────────────────────────────────────────────────────────────────

pipeline {
  agent any

  // ── Options ──────────────────────────────────────────────────────────────
  options {
    timeout(time: 15, unit: 'MINUTES')
    disableConcurrentBuilds()
    timestamps()
  }

  stages {

    // ── Stage 1: Checkout ─────────────────────────────────────────────────
    stage('Checkout') {
      steps {
        script {
          echo '==> Checking out source code…'
          checkout scm

          // Capture commit metadata — stored as env vars for later stages
          env.COMMIT_HASH   = sh(script: 'git rev-parse HEAD',          returnStdout: true).trim()
          env.COMMIT_MSG    = sh(script: 'git log -1 --pretty=%s',      returnStdout: true).trim()
          env.REPO_NAME     = sh(script: 'basename $(git rev-parse --show-toplevel)', returnStdout: true).trim()
          env.IMAGE_NAME    = "buildback-jenkins-${env.BUILD_NUMBER}".toLowerCase()
          env.CONTAINER_NAME = "buildback-cnt-jenkins-${env.BUILD_NUMBER}".toLowerCase()

          // Default status — overridden by each stage's post block
          env.BUILD_STATUS  = 'failed'
          env.BUILD_LOG     = ''

          // Resolve BUILDBACK_URL with a safe fallback
          env.BUILDBACK_URL = env.BUILDBACK_URL ?: 'http://localhost:3000'

          echo "Repo      : ${env.REPO_NAME}"
          echo "Commit    : ${env.COMMIT_HASH.take(7)} — ${env.COMMIT_MSG}"
          echo "Image     : ${env.IMAGE_NAME}"
          echo "BuildBack : ${env.BUILDBACK_URL}"
        }
      }
    }

    // ── Stage 2: Install Dependencies ────────────────────────────────────
    stage('Install Dependencies') {
      steps {
        script {
          echo '==> Installing Node.js dependencies…'
          sh 'npm ci --prefer-offline 2>&1 || npm install 2>&1'
        }
      }
    }

    // ── Stage 3: Docker Build ─────────────────────────────────────────────
    stage('Docker Build') {
      steps {
        script {
          echo "==> Building Docker image: ${env.IMAGE_NAME}"
          // returnStatus: true lets us capture the exit code without failing
          // the step immediately — we handle failure ourselves for better logs
          def buildLog = ''
          def exitCode = sh(
            script: "docker build -t ${env.IMAGE_NAME} . 2>&1",
            returnStdout: true,
            returnStatus: false   // let Jenkins mark stage failed on non-zero
          )
          env.BUILD_LOG = exitCode
          echo env.BUILD_LOG
        }
      }
      post {
        success {
          script {
            env.BUILD_STATUS = 'success'
            echo 'Docker build SUCCEEDED.'
          }
        }
        failure {
          script {
            env.BUILD_STATUS = 'failed'
            echo 'Docker build FAILED.'
          }
        }
      }
    }

    // ── Stage 4: Docker Run (smoke test) ─────────────────────────────────
    // Starts the container detached, waits a few seconds, checks it's still
    // running, then stops it.  This avoids blocking the pipeline forever.
    stage('Docker Run') {
      when {
        expression { return env.BUILD_STATUS == 'success' }
      }
      steps {
        script {
          echo "==> Smoke-testing container: ${env.IMAGE_NAME}"

          // Clean up any leftover container from a previous run
          sh "docker rm -f ${env.CONTAINER_NAME} 2>/dev/null || true"

          // Start detached
          sh "docker run -d --name ${env.CONTAINER_NAME} ${env.IMAGE_NAME}"

          // Give the app a moment to boot
          sleep(time: 5, unit: 'SECONDS')

          // Check the container is still running (exit code 0 = running)
          def isRunning = sh(
            script: "docker inspect -f '{{.State.Running}}' ${env.CONTAINER_NAME} 2>&1",
            returnStdout: true
          ).trim()

          def runLog = sh(
            script: "docker logs ${env.CONTAINER_NAME} 2>&1",
            returnStdout: true
          ).trim()

          env.BUILD_LOG = env.BUILD_LOG + "\n--- docker run ---\n" + runLog

          if (isRunning != 'true') {
            error("Container exited prematurely. Logs:\n${runLog}")
          }

          echo "Container is running. Logs:\n${runLog}"
        }
      }
      post {
        always {
          script {
            // Always stop and remove the smoke-test container
            sh "docker stop ${env.CONTAINER_NAME} 2>/dev/null || true"
            sh "docker rm   ${env.CONTAINER_NAME} 2>/dev/null || true"
          }
        }
        failure {
          script {
            env.BUILD_STATUS = 'failed'
            echo 'Docker run smoke-test FAILED.'
          }
        }
      }
    }

    // ── Stage 5: Notify BuildBack ─────────────────────────────────────────
    stage('Notify Backend') {
      steps {
        script {
          echo "==> Posting result to BuildBack at ${env.BUILDBACK_URL}/api/record"

          // Write the payload to a temp file to avoid shell quoting nightmares
          // with special characters in commit messages or logs.
          def safeMsg = (env.COMMIT_MSG  ?: '').replaceAll('"', '\\"').replaceAll('\n', ' ')
          def safeLog = (env.BUILD_LOG   ?: '').replaceAll('\\\\', '\\\\\\\\')
                                                .replaceAll('"',    '\\\\"')
                                                .replaceAll('\n',   '\\\\n')
                                                .replaceAll('\r',   '')

          def payload = """{
  "repoName":      "${env.REPO_NAME}",
  "commitHash":    "${env.COMMIT_HASH}",
  "commitMessage": "${safeMsg}",
  "status":        "${env.BUILD_STATUS}",
  "log":           "${safeLog}",
  "duration":      0
}"""

          // Write to a temp file so curl reads it cleanly
          writeFile file: 'buildback_payload.json', text: payload

          sh """
            curl -sf -X POST "${env.BUILDBACK_URL}/api/record" \\
              -H "Content-Type: application/json" \\
              --data @buildback_payload.json \\
              && echo "BuildBack notified successfully." \\
              || echo "WARNING: BuildBack notification failed (server may be offline)."
          """

          // Clean up temp file
          sh 'rm -f buildback_payload.json'
        }
      }
    }

  } // end stages

  // ── Post-pipeline cleanup ─────────────────────────────────────────────────
  post {
    always {
      script {
        echo "==> Pipeline complete. Final status: ${env.BUILD_STATUS ?: 'unknown'}"
        // Remove the Docker image to keep the agent clean
        sh "docker rmi -f ${env.IMAGE_NAME} 2>/dev/null || true"
      }
    }
    success {
      echo '✓ BuildBack Jenkins pipeline completed successfully.'
    }
    failure {
      echo '✗ BuildBack Jenkins pipeline failed — check stage logs above.'
    }
  }
}
