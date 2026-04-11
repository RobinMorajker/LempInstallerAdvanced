const Docker = require("dockerode");
const config = require("./config");

const docker = new Docker(
  process.platform === "win32"
    ? { socketPath: "//./pipe/docker_engine" }
    : { socketPath: "/var/run/docker.sock" }
);

/**
 * Ensure the shared Docker network exists.
 * Creates it if missing (idempotent).
 */
async function ensureNetwork() {
  const networks = await docker.listNetworks({
    filters: { name: [config.dockerNetwork] }
  });

  if (networks.length === 0) {
    await docker.createNetwork({
      Name: config.dockerNetwork,
      Driver: "bridge"
    });
  }
}

/**
 * Pull an image only if it is not already present locally.
 */
async function pullImageIfMissing(imageName) {
  const images = await docker.listImages({
    filters: { reference: [imageName] }
  });

  if (images.length > 0) return;

  await new Promise((resolve, reject) => {
    docker.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) =>
        err2 ? reject(err2) : resolve()
      );
    });
  });
}

/**
 * Stop and remove a container by name.
 * Safe to call even when the container does not exist.
 */
async function removeContainer(name) {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();

    if (info.State.Running) {
      await container.stop({ t: 10 });
    }
    await container.remove({ force: true });
  } catch (err) {
    // 404 = container not found — nothing to do
    if (err.statusCode !== 404) throw err;
  }
}

/**
 * Create and start an app container.
 *
 * @param {object} opts
 * @param {string} opts.name       - Unique container / hostname for the app
 * @param {string} opts.hostPath   - Absolute host path to the app directory
 * @param {object} opts.env        - Key/value pairs injected as environment variables
 */
async function createContainer({ name, hostPath, env = {} }) {
  await ensureNetwork();

  const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    Image: config.phpImage,
    name,
    Hostname: name,
    Env: envArray,
    HostConfig: {
      Binds: [`${hostPath}:/var/www/html:rw`],
      NetworkMode: config.dockerNetwork,
      RestartPolicy: { Name: "always" },
      Memory: config.resources.memoryBytes,
      NanoCPUs: config.resources.nanoCPUs
    },
    Labels: {
      "deploy-engine": "true",
      "deploy-engine.app": name
    }
  });

  await container.start();
  return container;
}

/**
 * Return basic info for all containers managed by this engine.
 */
async function listAppContainers() {
  return docker.listContainers({
    all: true,
    filters: { label: ["deploy-engine=true"] }
  });
}

/**
 * Return inspect data for a single app container.
 */
async function inspectContainer(name) {
  return docker.getContainer(name).inspect();
}

module.exports = {
  createContainer,
  removeContainer,
  listAppContainers,
  inspectContainer,
  pullImageIfMissing
};
