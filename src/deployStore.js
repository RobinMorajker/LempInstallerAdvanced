/**
 * Shared in-memory deployment status store.
 * Used by both localDeployService and remoteDeployService so that
 * GET /deployments and GET /deploy/:id reflect all deployments regardless
 * of where they ran.
 */
const deployments = new Map();

function setStatus(deployId, patch) {
  const current = deployments.get(deployId) || {};
  deployments.set(deployId, {
    ...current,
    deployId,
    ...patch,
    updatedAt: new Date().toISOString()
  });
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
}

module.exports = { setStatus, getStatus, listDeployments, removeByApp };
