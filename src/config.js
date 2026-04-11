require("dotenv").config({ override: true });
const path = require("path");

module.exports = {
  // Where cloned app repos are stored on the host.
  // On Windows: if APPS_DIR is a Linux absolute path (starts with /), ignore it
  //             and fall back to the project-relative default instead.
  // On Linux:   any absolute path is used as-is; relative paths are anchored to
  //             the project root so they don't depend on CWD.
  appsDir: (() => {
    const raw = process.env.APPS_DIR;
    const projectApps = path.join(__dirname, "..", "apps");
    if (!raw) return projectApps;
    // On Windows a Linux-style absolute path is invalid — skip it
    if (process.platform === "win32" && raw.startsWith("/")) return projectApps;
    return path.isAbsolute(raw) ? raw : path.join(__dirname, "..", raw);
  })(),

  // Docker network shared by all services (matches docker-compose project name)
  dockerNetwork: process.env.DOCKER_NETWORK || "lemp_default",

  // PHP image used for every deployed app container
  phpImage: process.env.PHP_IMAGE || "lemp-php-custom",

  // MariaDB connection (root access needed to create per-app DBs)
  db: {
    host: process.env.DB_HOST || "lemp_db",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    rootPassword: process.env.DB_ROOT_PASSWORD || "rootpassword",
    appPassword: process.env.DB_APP_PASSWORD || "apppassword"
  },

  // Nginx Proxy Manager API
  npm: {
    url: process.env.NPM_URL || "http://localhost:81/api",
    email: process.env.NPM_EMAIL || "admin@example.com",
    password: process.env.NPM_PASSWORD || "changeme"
  },

  // Per-container resource limits
  resources: {
    memoryBytes: parseInt(process.env.CONTAINER_MEMORY || String(512 * 1024 * 1024), 10), // 512 MB
    nanoCPUs: parseInt(process.env.CONTAINER_NANOCPUS || "500000000", 10)                 // 0.5 CPU
  },

  // GitHub OAuth
  github: {
    clientId:     process.env.GITHUB_CLIENT_ID     || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    callbackUrl:  process.env.GITHUB_CALLBACK_URL  || "http://localhost:3000/auth/github/callback"
  },

  // Session secret (change in production)
  sessionSecret: process.env.SESSION_SECRET || "change-me-in-production",

  // Deploy API port
  port: parseInt(process.env.PORT || "3000", 10)
};
