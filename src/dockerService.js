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
 * Create and start the PHP-FPM app container.
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
 * Nginx config that serves static files and proxies PHP to the FPM container.
 * @param {string} fpmHost  - Hostname of the PHP-FPM container
 * @param {string} webRoot  - Document root inside the container (default: /var/www/html)
 */
function _nginxConf(fpmHost, webRoot = "/var/www/html") {
  return `
server {
  listen 80;
  root ${webRoot};
  index index.php index.html;

  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }

  location ~ \\.php$ {
    fastcgi_pass ${fpmHost}:9000;
    fastcgi_index index.php;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param PATH_INFO $fastcgi_path_info;
  }

  location ~ /\\.ht {
    deny all;
  }
}
`.trim();
}

/**
 * Create a per-app Nginx sidecar container.
 * It serves HTTP on port 80, proxying PHP requests to the FPM container.
 * NPM should forward traffic to this container (not directly to PHP-FPM).
 *
 * @param {string} appName   - PHP-FPM container name (used as FPM hostname)
 * @param {string} hostPath  - Absolute host path to the app directory (for static files)
 * @param {string} [webRoot] - Subdirectory to use as document root (e.g. "public"). Defaults to repo root.
 * @returns {Promise<Container>}
 */
async function createNginxSidecar(appName, hostPath, webRoot) {
  await ensureNetwork();
  await pullImageIfMissing("nginx:alpine");

  const nginxName = `nginx_${appName}`;
  const containerWebRoot = webRoot
    ? `/var/www/html/${webRoot.replace(/^\/+|\/+$/g, "")}`
    : "/var/www/html";

  // Write the Nginx config into a temp volume via a one-shot container
  const conf = _nginxConf(appName, containerWebRoot);

  // Encode config as base64 so we can pass it through a shell command
  const confB64 = Buffer.from(conf).toString("base64");

  // Use a minimal alpine image to write the config file, then start Nginx
  const container = await docker.createContainer({
    Image: "nginx:alpine",
    name: nginxName,
    Hostname: nginxName,
    Cmd: [
      "sh", "-c",
      `echo "${confB64}" | base64 -d > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'`
    ],
    HostConfig: {
      Binds: [`${hostPath}:/var/www/html:ro`],
      NetworkMode: config.dockerNetwork,
      RestartPolicy: { Name: "always" },
      Memory: 64 * 1024 * 1024,   // 64 MB — Nginx is tiny
      NanoCPUs: 250000000          // 0.25 CPU
    },
    Labels: {
      "deploy-engine": "true",
      "deploy-engine.app": appName,
      "deploy-engine.role": "nginx"
    }
  });

  await container.start();
  return container;
}

/**
 * Remove both the PHP-FPM container and its Nginx sidecar for an app.
 */
async function removeAppContainers(appName) {
  await removeContainer(`nginx_${appName}`);
  await removeContainer(appName);
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
  createNginxSidecar,
  removeContainer,
  removeAppContainers,
  listAppContainers,
  inspectContainer,
  pullImageIfMissing
};
