/**
 * Deployment status store — persisted to .deployments.json so records
 * survive server restarts.  In-memory Map is the hot path; disk is written
 * on every change and read once at startup.
 */
const fs   = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", ".deployments.json");

// ── Persistence helpers ───────────────────────────────────────────────────────

function _load() {
  try {
    if (!fs.existsSync(FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function _save(map) {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("[deployStore] Failed to persist:", e.message);
  }
}

// ── In-memory store (loaded from disk at startup) ─────────────────────────────

const deployments = _load();

// ── Public API ────────────────────────────────────────────────────────────────

function setStatus(deployId, patch) {
  const current = deployments.get(deployId) || {};
  deployments.set(deployId, {
    ...current,
    deployId,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  _save(deployments);
}

function getStatus(deployId) {
  return deployments.get(deployId) || null;
}

function listDeployments() {
  return Array.from(deployments.values())
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/**
 * Remove all deployment records for a given appName (+ optional domain).
 * Called after a successful destroy so the entry disappears from the list.
 */
function removeByApp(appName, domain) {
  for (const [id, dep] of deployments) {
    if (dep.appName === appName && (!domain || dep.domain === domain)) {
      deployments.delete(id);
    }
  }
  _save(deployments);
}

module.exports = { setStatus, getStatus, listDeployments, removeByApp };
