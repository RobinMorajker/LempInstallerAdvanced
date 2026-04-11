const path = require("path");
const fs = require("fs");
const { simpleGit } = require("simple-git");
const { v4: uuid } = require("uuid");

const config = require("./config");
const docker = require("./dockerService");
const db = require("./dbService");
const npm = require("./npmService");

// In-memory deployment status store.
// In production you can swap this for Redis or a database table.
const deployments = new Map();

/**
 * Deploy a new app or redeploy an existing one.
 *
 * @param {object} opts
 * @param {string}  opts.repo    - Git repository URL (HTTPS or SSH)
 * @param {string}  opts.domain  - Public domain to route to this app
 * @param {string}  [opts.appName] - Reuse an existing app name to redeploy it
 * @param {boolean} [opts.ssl=true]
 * @param {string}  [opts.email]   - Let's Encrypt contact email
 * @param {string}  [opts.branch="main"] - Branch to clone
 * @returns {Promise<{ deployId, appName, domain, status }>}
 */
async function deploy({ repo, domain, appName, ssl = true, email, branch = "main" }) {
  // Generate a stable, short app name from the domain when not supplied
  const name = appName || "app_" + uuid().slice(0, 8);
  const deployId = uuid();
  const appPath = path.join(config.appsDir, name);

  _setStatus(deployId, { status: "pending", appName: name, domain, repo });

  // Run asynchronously so the HTTP response returns immediately
  _runDeploy({ deployId, name, appPath, repo, domain, ssl, email, branch }).catch(
    (err) => {
      console.error(`[deploy] ${name} failed:`, err.message);
      _setStatus(deployId, { status: "failed", error: err.message });
    }
  );

  return { deployId, appName: name, domain, status: "pending" };
}

/**
 * Core deployment pipeline — runs in the background.
 */
async function _runDeploy({ deployId, name, appPath, repo, domain, ssl, email, branch }) {
  // ── Step 1: Clone / pull ──────────────────────────────────────────────────
  _setStatus(deployId, { status: "cloning" });

  // Ensure the parent apps directory exists (not the app dir itself — git creates that)
  fs.mkdirSync(path.dirname(appPath), { recursive: true });

  const isGitRepo = fs.existsSync(path.join(appPath, ".git"));

  if (isGitRepo) {
    // Valid existing repo — pull latest
    const git = simpleGit(appPath);
    await git.pull("origin", branch);
  } else {
    // Remove any leftover partial directory from a previous failed clone
    if (fs.existsSync(appPath)) {
      fs.rmSync(appPath, { recursive: true, force: true });
    }
    // Let git clone create the directory itself.
    // Try the requested branch first; fall back to repo default if not found.
    const git = simpleGit();
    try {
      await git.clone(repo, appPath, ["--branch", branch, "--depth", "1"]);
    } catch (cloneErr) {
      if (cloneErr.message.includes("Remote branch") && cloneErr.message.includes("not found")) {
        console.warn(`[deploy] Branch '${branch}' not found — retrying with repo default branch`);
        // Clean up partial clone before retry
        if (fs.existsSync(appPath)) fs.rmSync(appPath, { recursive: true, force: true });
        await git.clone(repo, appPath, ["--depth", "1"]);
      } else {
        throw cloneErr;
      }
    }
  }

  // ── Step 2: Provision database ───────────────────────────────────────────
  _setStatus(deployId, { status: "provisioning_db" });
  const { dbName, dbUser, dbPassword } = await db.createDatabase(name);

  // ── Step 3: (Re)create container ─────────────────────────────────────────
  _setStatus(deployId, { status: "building_container" });
  await docker.removeContainer(name);
  await docker.createContainer({
    name,
    hostPath: appPath,
    env: {
      DB_HOST: config.db.host,
      DB_PORT: String(config.db.port),
      DB_NAME: dbName,
      DB_USER: dbUser,
      DB_PASSWORD: dbPassword,
      REDIS_HOST: "lemp_redis",
      REDIS_PORT: "6379",
      APP_ENV: "production"
    }
  });

  // ── Step 4: Configure domain + SSL ───────────────────────────────────────
  _setStatus(deployId, { status: "configuring_proxy" });
  await npm.createProxyHost({ domain, appName: name, ssl, email });

  // ── Step 5: Done ─────────────────────────────────────────────────────────
  _setStatus(deployId, { status: "live" });
  console.log(`[deploy] ${name} → https://${domain} (live)`);
}

/**
 * Tear down an app: remove its container, drop its DB, remove proxy host.
 *
 * @param {string} appName
 * @param {string} domain
 */
async function destroy(appName, domain) {
  await docker.removeContainer(appName);
  await db.dropDatabase(appName);
  await npm.deleteProxyHostByDomain(domain);

  const appPath = path.join(config.appsDir, appName);
  if (fs.existsSync(appPath)) {
    fs.rmSync(appPath, { recursive: true, force: true });
  }
}

/**
 * Return the status object for a given deployId.
 */
function getStatus(deployId) {
  return deployments.get(deployId) || null;
}

/**
 * Return all tracked deployments.
 */
function listDeployments() {
  return Array.from(deployments.values());
}

function _setStatus(deployId, patch) {
  const current = deployments.get(deployId) || {};
  deployments.set(deployId, { ...current, deployId, ...patch, updatedAt: new Date().toISOString() });
}

module.exports = { deploy, destroy, getStatus, listDeployments };
