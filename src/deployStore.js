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

module.exports = { setStatus, getStatus, listDeployments };
