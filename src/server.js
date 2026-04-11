const path = require("path");
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const { deploy, destroy, getStatus, listDeployments } = require("./deployService");
const { listAppContainers, inspectContainer } = require("./dockerService");
const authRouter = require("./routes/auth");
const config = require("./config");

const app = express();

// SQLite-backed sessions — cross-platform, survives restarts, no Windows rename issues
app.use(session({
  store: new SQLiteStore({
    db:  "sessions.db",
    dir: path.join(__dirname, "..", ".sessions"),
    ttl: 8 * 60 * 60   // 8 hours in seconds
  }),
  secret:            config.sessionSecret,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge:   8 * 60 * 60 * 1000   // 8 hours in ms
  }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(authRouter);

// ── Input validation helpers ──────────────────────────────────────────────────

function isValidGitUrl(url) {
  return /^(https?:\/\/|git@)\S+\.git$/.test(url);
}

function isValidDomain(domain) {
  return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(domain);
}

function isValidAppName(name) {
  return /^[a-zA-Z0-9_-]{1,48}$/.test(name);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /deploy
 * Start a new deployment.
 *
 * Body:
 *   repo     {string}  required  - Git HTTPS URL ending in .git
 *   domain   {string}  required  - Public domain (e.g. myapp.example.com)
 *   appName  {string}  optional  - Custom name; auto-generated if omitted
 *   ssl      {boolean} optional  - Default true
 *   email    {string}  optional  - Let's Encrypt contact email
 *   branch   {string}  optional  - Default "main"
 */
app.post("/deploy", async (req, res) => {
  const { repo, domain, appName, ssl, email, branch } = req.body;

  if (!repo || !isValidGitUrl(repo)) {
    return res.status(400).json({ error: "Invalid or missing repo URL (must end in .git)" });
  }
  if (!domain || !isValidDomain(domain)) {
    return res.status(400).json({ error: "Invalid or missing domain" });
  }
  if (appName && !isValidAppName(appName)) {
    return res.status(400).json({ error: "appName must be alphanumeric/dash/underscore, max 48 chars" });
  }

  try {
    const result = await deploy({ repo, domain, appName, ssl, email, branch });
    res.status(202).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /deploy/:deployId
 * Poll deployment status.
 */
app.get("/deploy/:deployId", (req, res) => {
  const status = getStatus(req.params.deployId);
  if (!status) return res.status(404).json({ error: "Deployment not found" });
  res.json(status);
});

/**
 * GET /deployments
 * List all tracked deployments.
 */
app.get("/deployments", (_req, res) => {
  res.json(listDeployments());
});

/**
 * DELETE /deploy/:appName
 * Destroy an app completely (container + DB + proxy host).
 *
 * Query param: domain  (required to remove the proxy host)
 */
app.delete("/deploy/:appName", async (req, res) => {
  const { appName } = req.params;
  const { domain } = req.query;

  if (!isValidAppName(appName)) {
    return res.status(400).json({ error: "Invalid appName" });
  }
  if (!domain || !isValidDomain(domain)) {
    return res.status(400).json({ error: "Invalid or missing domain query param" });
  }

  try {
    await destroy(appName, domain);
    res.json({ success: true, appName, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /containers
 * List all running app containers.
 */
app.get("/containers", async (_req, res) => {
  try {
    const containers = await listAppContainers();
    res.json(containers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /containers/:name
 * Inspect a single app container.
 */
app.get("/containers/:name", async (req, res) => {
  try {
    const info = await inspectContainer(req.params.name);
    res.json(info);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: "Container not found" });
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /health
 * Liveness probe.
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`Deploy Engine running on port ${config.port}`);
});
